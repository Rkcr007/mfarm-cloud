/**
 * Runs — the grouping that makes a hundred sessions legible (docs/EXECUTION_MODEL.md §4.2).
 *
 * The thing under test is not really the table; it is the claim that a suite can join a run with
 * one line and no coordination. So these tests drive the hub the way a suite does — a real
 * `POST /session` against a real upstream — and then ask the API the question the feature exists to
 * answer: what happened on this run, and which build was it.
 *
 * Two of them are here because the failure they guard is silent rather than loud. Run names are
 * chosen by the client and every CI system on earth numbers builds from 1, so two tenants using
 * "412" is the ordinary case; if that collided, each would read the other's session list with no
 * policy violated. And a run whose sessions touched several builds must not have one of them
 * reported as THE build, because a number that is quietly wrong is worse than one that is absent.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey, generateWorkerToken } from '../src/auth.ts';
import { parseCapabilities } from '../src/http/webdriver/capabilities.ts';

let app: FastifyInstance;
let orgA: string, orgB: string, hostId: string;
let keyA: string, keyB: string;
const REGION = 'run-test';

const auth = (k: string) => ({ authorization: `Bearer ${k}` });
const androidCaps = (extra: Record<string, unknown> = {}) => ({
  capabilities: {
    alwaysMatch: { platformName: 'android', 'mfarm:region': REGION, ...extra },
    firstMatch: [{}],
  },
});

// ---------------------------------------------------------------- stub automation server

let upstream: Server;
let upstreamUrl: string;
/** Incremented per session so two concurrent sessions do not share an upstream id. */
let upstreamSeq = 0;

function startUpstream(): Promise<string> {
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && req.url === '/session') {
        return json(200, {
          value: {
            sessionId: `upstream-${++upstreamSeq}`,
            capabilities: { platformName: 'android', 'appium:automationName': 'UiAutomator2' },
          },
        });
      }
      if (req.method === 'DELETE' && req.url?.startsWith('/session/upstream-')) {
        return json(200, { value: null });
      }
      return json(404, { value: { error: 'unknown command', message: req.url, stacktrace: '' } });
    });
  });
  return new Promise((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      const addr = upstream.address();
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
    });
  });
}

// ---------------------------------------------------------------- fixtures

async function seedDevices(n: number) {
  const caps = ['screen-stream', 'webdriver', 'app-install'];
  return withSystem(async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { rows } = await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities,
                              local_id, adb_serial, system_port, mjpeg_server_port)
         VALUES ($1,$2,'android','cuttlefish','cf_x86_64','15','READY',$3::jsonb,$4,$5,$6,$7)
         RETURNING id`,
        [hostId, REGION, JSON.stringify(caps), `run-${randomUUID()}`,
         `0.0.0.0:${6620 + i}`, 8300 + i, 7910 + i],
      );
      ids.push(rows[0].id);
    }
    return ids;
  });
}

async function seedBuild(orgId: string, packageName: string, versionName: string): Promise<string> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO app_builds (org_id, platform, package_name, version_name, version_code,
                               sha256, size_bytes, filename)
       VALUES ($1,'android',$2,$3,1,$4,4096,$5) RETURNING id`,
      [orgId, packageName, versionName, randomBytes(32).toString('hex'), `${packageName}.apk`],
    );
    return rows[0].id;
  });
}

const clearFleet = () => withSystem(async (c) => {
  await c.query('DELETE FROM app_actions WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM webdriver_sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM metering_events WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM runs WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
});

/** A WebDriver session, opened the way a suite opens one. Returns the mfarm session id. */
async function openSession(key: string, extra: Record<string, unknown> = {}): Promise<string> {
  const reply = await app.inject({
    method: 'POST', url: '/wd/hub/session', headers: auth(key), payload: androidCaps(extra),
  });
  assert.equal(reply.statusCode, 200, reply.body);
  return reply.json().value.sessionId as string;
}

const quit = (key: string, sessionId: string) =>
  app.inject({ method: 'DELETE', url: `/wd/hub/session/${sessionId}`, headers: auth(key) });

before(async () => {
  upstreamUrl = await startUpstream();
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Run Test')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgA = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                           VALUES ('run-a','A',50) RETURNING id`)).rows[0].id;
    orgB = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                           VALUES ('run-b','B',50) RETURNING id`)).rows[0].id;
    const wt = generateWorkerToken();
    hostId = (await c.query(
      `INSERT INTO hosts (region,hostname,state,protocol_version,cores,memory_mb,endpoint,
                          automation_endpoint,token_prefix,token_hash,last_heartbeat_at)
       VALUES ($1,'run-test-host','UP',1,64,262144,'wss://run-worker.example:8443',$2,$3,$4, now())
       RETURNING id`,
      [REGION, upstreamUrl, wt.prefix, wt.hash])).rows[0].id;
  });
  keyA = (await createApiKey(orgA)).plaintext;
  keyB = (await createApiKey(orgB)).plaintext;
  app = await buildServer({ logger: false });
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM app_actions WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM webdriver_sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM metering_events WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM runs WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM app_builds WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
    await c.query('DELETE FROM api_keys WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM hosts WHERE id = $1', [hostId]);
    await c.query('DELETE FROM orgs WHERE id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await new Promise<void>((r) => upstream.close(() => r()));
  await closePools();
});

// ---------------------------------------------------------------- the capability

describe('mfarm:runId as a capability', () => {
  const opts = { defaultRegion: undefined };
  const withRunId = (id: unknown, extra: Record<string, unknown> = {}) => parseCapabilities({
    capabilities: {
      alwaysMatch: { platformName: 'android', 'mfarm:region': 'eu-1', 'mfarm:runId': id, ...extra },
      firstMatch: [{}],
    },
  }, opts);

  test('any string a CI system already has is a valid run id', () => {
    assert.equal(withRunId('4471').runId, '4471');
    assert.equal(withRunId('nightly-2026-08-23').runId, 'nightly-2026-08-23');
    assert.equal(withRunId('  padded  ').runId, 'padded', 'trimmed, like every other string cap');
  });

  test('it never reaches the automation server', () => {
    const p = withRunId('4471');
    assert.ok(!Object.keys(p.upstream).some((k) => k.startsWith('mfarm:')));
  });

  test('an empty or over-long run id is refused rather than ignored', () => {
    assert.throws(() => withRunId(''), /non-empty/);
    assert.throws(() => withRunId('x'.repeat(201)), /200 characters/);
  });

  test('a run id containing a control character is refused', () => {
    // A newline here would split every log line the id appears in and render as two rows in the
    // console. Refusing at session creation puts the error in front of the person who can fix it.
    assert.throws(() => withRunId(`4471${String.fromCharCode(10)}injected`), /control characters/);
    assert.throws(() => withRunId(`a${String.fromCharCode(27)}[31mb`), /control characters/);
  });

  test('a misspelled run capability is refused, like every other unknown mfarm key', () => {
    assert.throws(
      () => parseCapabilities({
        capabilities: { alwaysMatch: { platformName: 'android', 'mfarm:region': 'eu-1', 'mfarm:runid': '4471' } },
      }, opts),
      /`mfarm:runid` is not a capability/,
      'silently dropping it would file every session of the run under no run at all',
    );
  });

  test('it is allowed beside mfarm:sessionId, unlike the allocator capabilities', () => {
    // The distinction is real rather than an oversight: tier and ttl are instructions to an
    // allocator that has already run, so they are refused. A run id is a LABEL — it changes nothing
    // about which device was chosen — so `mfarm run` and an explicit run id compose.
    const p = parseCapabilities({
      capabilities: {
        alwaysMatch: {
          platformName: 'android',
          'mfarm:sessionId': '11111111-2222-3333-4444-555555555555',
          'mfarm:runId': '4471',
        },
      },
    }, opts);
    assert.equal(p.runId, '4471');
    assert.equal(p.bindSessionId, '11111111-2222-3333-4444-555555555555');

    assert.throws(() => parseCapabilities({
      capabilities: {
        alwaysMatch: {
          platformName: 'android',
          'mfarm:sessionId': '11111111-2222-3333-4444-555555555555',
          'mfarm:tier': 'cuttlefish',
        },
      },
    }, opts), /cannot be combined/);
  });
});

// ---------------------------------------------------------------- joining a run

describe('joining a run', () => {
  test('sessions sharing a run id are one run, and it is echoed back', async () => {
    await clearFleet();
    await seedDevices(3);

    const first = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:runId': '4471' }),
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().value.capabilities['mfarm:runId'], '4471',
      'seeing it come back is how a suite author confirms the capability did something');

    const s1 = first.json().value.sessionId;
    const s2 = await openSession(keyA, { 'mfarm:runId': '4471' });
    const s3 = await openSession(keyA, { 'mfarm:runId': '4471' });

    const rows = await withSystem(async (c) => (await c.query(
      'SELECT DISTINCT run_id FROM sessions WHERE id = ANY($1)', [[s1, s2, s3]],
    )).rows);
    assert.equal(rows.length, 1, 'three tests in one CI job are one run, not three');
    assert.ok(rows[0].run_id);

    const runs = await withSystem(async (c) => (await c.query(
      'SELECT count(*)::int AS n FROM runs WHERE org_id = $1', [orgA],
    )).rows[0].n);
    assert.equal(runs, 1, 'the run is created once and joined, not re-created per session');
  });

  test('a session with no run id belongs to no run', async () => {
    await clearFleet();
    await seedDevices(1);
    const s = await openSession(keyA);
    const runId = await withSystem(async (c) => (await c.query(
      'SELECT run_id FROM sessions WHERE id = $1', [s],
    )).rows[0].run_id);
    assert.equal(runId, null, 'the capability is opt-in; nothing is invented for a suite that omits it');
  });

  test('two orgs using the same run name get two different runs', async () => {
    await clearFleet();
    await seedDevices(2);

    const a = await openSession(keyA, { 'mfarm:runId': '412' });
    const b = await openSession(keyB, { 'mfarm:runId': '412' });

    const [runA, runB] = await withSystem(async (c) => {
      const q = async (s: string) => (await c.query(
        'SELECT run_id FROM sessions WHERE id = $1', [s])).rows[0].run_id;
      return [await q(a), await q(b)];
    });
    assert.ok(runA && runB);
    assert.notEqual(runA, runB,
      'every CI system numbers builds from 1, so a shared name is the ordinary case — if these ' +
      'merged, each org would read the other\'s sessions with no policy violated');

    // And the boundary holds through the API, not merely in the table.
    const listA = await app.inject({ method: 'GET', url: '/v1/runs', headers: auth(keyA) });
    assert.equal(listA.json().runs.length, 1);
    assert.equal(listA.json().runs[0].id, runA);

    const cross = await app.inject({ method: 'GET', url: `/v1/runs/${runB}`, headers: auth(keyA) });
    assert.equal(cross.statusCode, 404,
      'another org\'s run must be indistinguishable from one that does not exist');
  });

  test('the run is recorded even when no device was ever allocated', async () => {
    await clearFleet();
    // No devices at all, and no willingness to wait: allocation fails outright.
    const reply = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:runId': 'all-failed' }),
    });
    assert.equal(reply.statusCode, 500, reply.body);

    const list = await app.inject({ method: 'GET', url: '/v1/runs', headers: auth(keyA) });
    const run = list.json().runs.find((r: { runId: string }) => r.runId === 'all-failed');
    assert.ok(run, 'a CI job whose every test failed to allocate is exactly what someone comes looking for');
    assert.equal(run.sessions.total, 0);
  });

  test('a session already in one run is refused a second, different one', async () => {
    await clearFleet();
    await seedDevices(1);

    // The bind path: the caller allocates the session and drives it, which is what `mfarm run` does.
    // It is the only way one session can be handed two run ids, and the two are not reconcilable —
    // the lease, its artifacts and its cost belong to one run or the other, and picking either
    // files them under a run that did not incur them.
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(keyA),
      payload: { region: REGION, platform: 'android', requireCapabilities: ['webdriver'] },
    });
    assert.equal(created.statusCode, 201, created.body);
    const sessionId = created.json().session.id;

    const first = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:sessionId': sessionId, 'mfarm:runId': 'run-one' }),
    });
    assert.equal(first.statusCode, 200, first.body);
    await quit(keyA, sessionId);

    const second = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:sessionId': sessionId, 'mfarm:runId': 'run-two' }),
    });
    assert.equal(second.statusCode, 500, second.body);
    assert.match(second.json().value.message, /already part of run "run-one"/);
    assert.match(second.json().value.message, /run-two/,
      'both ids, because the caller is the only party who knows which one is stale');
  });

  test('the same run id twice on one session is ordinary, not a conflict', async () => {
    await clearFleet();
    await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(keyA),
      payload: { region: REGION, platform: 'android', requireCapabilities: ['webdriver'] },
    });
    const sessionId = created.json().session.id;

    for (const _ of [1, 2]) {
      const reply = await app.inject({
        method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
        payload: androidCaps({ 'mfarm:sessionId': sessionId, 'mfarm:runId': 'same' }),
      });
      assert.equal(reply.statusCode, 200, reply.body);
      await quit(keyA, sessionId);
    }
  });
});

// ---------------------------------------------------------------- what the run reports

describe('GET /v1/runs', () => {
  test('counts sessions, and how many are still live', async () => {
    await clearFleet();
    await seedDevices(3);

    const s1 = await openSession(keyA, { 'mfarm:runId': 'counts' });
    await openSession(keyA, { 'mfarm:runId': 'counts' });
    await openSession(keyA, { 'mfarm:runId': 'counts' });
    await quit(keyA, s1);

    const list = await app.inject({ method: 'GET', url: '/v1/runs', headers: auth(keyA) });
    assert.equal(list.statusCode, 200);
    const run = list.json().runs[0];
    assert.equal(run.runId, 'counts');
    assert.equal(run.sessions.total, 3);
    assert.equal(run.sessions.ended, 1);
    assert.equal(run.sessions.live, 2,
      'the only honest "still going" signal there is — a run has no end of its own');
    assert.ok(run.firstSessionAt);
    assert.ok(run.lastActivityAt);
  });

  test('names the build when every session ran the same one, and counts them when they did not', async () => {
    await clearFleet();
    await seedDevices(3);
    const shop = await seedBuild(orgA, 'com.acme.shop', '1.4.2');
    const other = await seedBuild(orgA, 'com.acme.admin', '0.9.0');

    // The install is queued on the heartbeat and awaited, so the sessions are opened with a worker
    // reporting success beside them. Two builds in one run is legitimate — an upgrade test — which
    // is exactly why the run must not pick one of them and call it THE build.
    await openWithBuild('one-build', shop);
    let list = await app.inject({ method: 'GET', url: '/v1/runs', headers: auth(keyA) });
    let run = list.json().runs.find((r: { runId: string }) => r.runId === 'one-build');
    assert.equal(run.buildCount, 1);
    assert.equal(run.build.id, shop);
    assert.equal(run.build.packageName, 'com.acme.shop');
    assert.equal(run.build.versionName, '1.4.2');

    await openWithBuild('two-builds', shop);
    await openWithBuild('two-builds', other);
    list = await app.inject({ method: 'GET', url: '/v1/runs', headers: auth(keyA) });
    run = list.json().runs.find((r: { runId: string }) => r.runId === 'two-builds');
    assert.equal(run.buildCount, 2);
    assert.equal(run.build, null,
      'reporting one of two builds would be the same lie the schema refuses to store');
  });

  test('a session that named no build leaves the run with no build, not a wrong one', async () => {
    await clearFleet();
    await seedDevices(1);
    await openSession(keyA, { 'mfarm:runId': 'no-build' });

    const list = await app.inject({ method: 'GET', url: '/v1/runs', headers: auth(keyA) });
    const run = list.json().runs.find((r: { runId: string }) => r.runId === 'no-build');
    assert.equal(run.buildCount, 0);
    assert.equal(run.build, null);
  });

  /** A session with `mfarm:appId`, with a worker playing the install beside it. */
  async function openWithBuild(runId: string, appId: string): Promise<string> {
    const pending = app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:runId': runId, 'mfarm:appId': appId }),
    });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    for (let i = 0; i < 400 && !settled; i++) {
      await beatOnce();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(settled, 'the hub never answered — it is still waiting on the install');
    const reply = await pending;
    assert.equal(reply.statusCode, 200, reply.body);
    return reply.json().value.sessionId;
  }

  /**
   * One heartbeat, and a success report for anything it was offered.
   *
   * The worker token is minted here rather than kept from `before`, because the plaintext is
   * discarded at registration and only the hash is stored — the same property that makes it a
   * credential rather than a name.
   */
  let beatToken: string | null = null;
  async function beatOnce(): Promise<void> {
    if (!beatToken) {
      const wt = generateWorkerToken();
      await withSystem((c) => c.query(
        'UPDATE hosts SET token_prefix = $2, token_hash = $3 WHERE id = $1',
        [hostId, wt.prefix, wt.hash]));
      beatToken = wt.plaintext;
    }
    const beat = await app.inject({
      method: 'POST', url: '/v1/workers/heartbeat', headers: auth(beatToken),
    });
    if (beat.statusCode !== 200) return;
    const offered = beat.json().actions as Array<{ actionId: string }>;
    if (offered.length === 0) return;
    await app.inject({
      method: 'POST', url: '/v1/workers/events', headers: auth(beatToken),
      payload: { actions: offered.map((a) => ({ actionId: a.actionId, ok: true })) },
    });
  }
});

describe('GET /v1/runs/:id', () => {
  test('resolves by the name the caller gave it, as well as by uuid', async () => {
    await clearFleet();
    await seedDevices(2);
    const s1 = await openSession(keyA, { 'mfarm:runId': '4471' });
    const s2 = await openSession(keyA, { 'mfarm:runId': '4471' });

    // The name is the id a CI job actually has. Needing to look up a uuid first would defeat it.
    const byName = await app.inject({ method: 'GET', url: '/v1/runs/4471', headers: auth(keyA) });
    assert.equal(byName.statusCode, 200, byName.body);
    const body = byName.json();
    assert.equal(body.run.runId, '4471');
    assert.equal(body.sessions.length, 2);
    assert.deepEqual(body.sessions.map((s: { id: string }) => s.id).sort(), [s1, s2].sort());

    const byId = await app.inject({
      method: 'GET', url: `/v1/runs/${body.run.id}`, headers: auth(keyA),
    });
    assert.equal(byId.statusCode, 200);
    assert.equal(byId.json().run.id, body.run.id);
  });

  test('a run that does not exist is a 404, not an empty run', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/runs/never-ran', headers: auth(keyA) });
    assert.equal(missing.statusCode, 404);
    const missingUuid = await app.inject({
      method: 'GET', url: `/v1/runs/${randomUUID()}`, headers: auth(keyA),
    });
    assert.equal(missingUuid.statusCode, 404);
  });
});

describe('sessions link back to their run', () => {
  test('the session list and detail both name the run', async () => {
    await clearFleet();
    await seedDevices(1);
    const s = await openSession(keyA, { 'mfarm:runId': 'linked' });

    const list = await app.inject({ method: 'GET', url: '/v1/sessions', headers: auth(keyA) });
    const listed = list.json().sessions.find((r: { id: string }) => r.id === s);
    assert.equal(listed.run.runId, 'linked');

    const detail = await app.inject({ method: 'GET', url: `/v1/sessions/${s}`, headers: auth(keyA) });
    assert.equal(detail.json().session.run.runId, 'linked');
    assert.equal(detail.json().session.run.id, listed.run.id);
  });
});
