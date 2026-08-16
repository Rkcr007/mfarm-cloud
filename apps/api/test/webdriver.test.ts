/**
 * The W3C WebDriver hub.
 *
 * What is actually at stake here is the migration promise: an existing Appium suite points at a new
 * URL and keeps working. So these tests are written from the client's side of the wire — the shapes
 * a WebDriver client parses, the errors it can act on, and the two ways a device gets leaked
 * (Appium refuses the session, or the client quits) that would quietly eat the fleet.
 *
 * The upstream automation server is a real HTTP server on a real port, not a mock. The proxy's whole
 * job is path rewriting and passthrough, and a mock would be asserting on the thing under test.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey } from '../src/auth.ts';
import { parseCapabilities } from '../src/http/webdriver/capabilities.ts';
import { verifySessionToken } from '../src/tokens.ts';

let app: FastifyInstance;
let orgA: string, orgB: string, hostId: string;
let keyA: string, keyB: string;
const REGION = 'wd-test';

const auth = (k: string) => ({ authorization: `Bearer ${k}` });
const androidCaps = (extra: Record<string, unknown> = {}) => ({
  capabilities: {
    alwaysMatch: { platformName: 'android', 'mfarm:region': REGION, ...extra },
    firstMatch: [{}],
  },
});

// ---------------------------------------------------------------- stub automation server

interface Recorded { method: string; url: string; body: unknown; auth?: string }

let upstream: Server;
let upstreamUrl: string;
let recorded: Recorded[] = [];
/** Flipped by the tests that need the automation server to misbehave. */
let upstreamMode: 'ok' | 'reject' = 'ok';

function startUpstream(): Promise<string> {
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      recorded.push({
        method: req.method!, url: req.url!,
        body: raw ? JSON.parse(raw) : undefined,
        // ADR-0004: the automation hop carries a signed grant. A real Appium ignores it; the
        // worker-side gateway that will terminate this hop does not.
        auth: req.headers.authorization,
      });
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      };

      if (req.method === 'POST' && req.url === '/session') {
        if (upstreamMode === 'reject') {
          return json(500, {
            value: { error: 'session not created', message: 'no devices matched the given udid', stacktrace: '' },
          });
        }
        return json(200, {
          value: {
            sessionId: 'upstream-session-1',
            capabilities: { platformName: 'android', 'appium:automationName': 'UiAutomator2' },
          },
        });
      }
      if (req.url?.startsWith('/session/upstream-session-1')) {
        if (req.method === 'DELETE') return json(200, { value: null });
        if (req.url.endsWith('/screenshot')) return json(200, { value: 'iVBORw0KGgo=' });
        if (req.url.endsWith('/element')) {
          return json(200, { value: { 'element-6066-11e4-a52e-4f735466cecf': 'element-42' } });
        }
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

/** `webdriver: false` seeds a device that is otherwise perfect but has no automation server. */
async function seedDevices(n: number, opts: { webdriver?: boolean; platform?: string } = {}) {
  const caps = ['screen-stream', 'input-datachannel', 'snapshot-reset'];
  if (opts.webdriver !== false) caps.push('webdriver');
  return withSystem(async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { rows } = await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id)
         VALUES ($1,$2,$3,'cuttlefish','cf_x86_64','15','READY',$4::jsonb,$5)
         RETURNING id`,
        [hostId, REGION, opts.platform ?? 'android', JSON.stringify(caps), `wd-${randomUUID()}`],
      );
      ids.push(rows[0].id);
    }
    return ids;
  });
}

const clearFleet = () => withSystem(async (c) => {
  await c.query('DELETE FROM webdriver_sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM metering_events WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
  await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
  recorded = [];
  upstreamMode = 'ok';
});

const deviceState = (id: string) => withSystem(async (c) =>
  (await c.query('SELECT state FROM devices WHERE id = $1', [id])).rows[0]?.state);
const sessionState = (id: string) => withSystem(async (c) =>
  (await c.query('SELECT state FROM sessions WHERE id = $1', [id])).rows[0]?.state);

before(async () => {
  upstreamUrl = await startUpstream();
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'WebDriver Test')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgA = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                           VALUES ('wd-a','A',50) RETURNING id`)).rows[0].id;
    orgB = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                           VALUES ('wd-b','B',50) RETURNING id`)).rows[0].id;
    hostId = (await c.query(
      `INSERT INTO hosts (region,hostname,state,protocol_version,cores,memory_mb,endpoint,automation_endpoint)
       VALUES ($1,'wd-test-host','UP',1,64,262144,'wss://wd-worker.example:8443',$2) RETURNING id`,
      [REGION, upstreamUrl])).rows[0].id;
  });
  keyA = (await createApiKey(orgA)).plaintext;
  keyB = (await createApiKey(orgB)).plaintext;
  app = await buildServer({ logger: false });
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM webdriver_sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM metering_events WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
    await c.query('DELETE FROM api_keys WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM hosts WHERE id = $1', [hostId]);
    await c.query('DELETE FROM orgs WHERE id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await new Promise<void>((r) => upstream.close(() => r()));
  await closePools();
});

// ---------------------------------------------------------------- capabilities

describe('capability negotiation', () => {
  const opts = { defaultRegion: undefined };

  test('alwaysMatch and firstMatch are merged', () => {
    const p = parseCapabilities({
      capabilities: {
        alwaysMatch: { platformName: 'Android' },
        firstMatch: [{ 'mfarm:region': 'eu-1', 'appium:automationName': 'UiAutomator2' }],
      },
    }, opts);
    assert.equal(p.platform, 'android', 'platformName is case-insensitive in practice');
    assert.equal(p.region, 'eu-1');
    assert.equal(p.upstream['appium:automationName'], 'UiAutomator2');
  });

  test('a key in both alwaysMatch and firstMatch is rejected, not silently resolved', () => {
    assert.throws(() => parseCapabilities({
      capabilities: {
        alwaysMatch: { platformName: 'android', 'mfarm:region': 'eu-1' },
        firstMatch: [{ platformName: 'ios' }],
      },
    }, opts), /both alwaysMatch and firstMatch/);
  });

  test('firstMatch falls through to an entry that can be satisfied', () => {
    const p = parseCapabilities({
      capabilities: {
        alwaysMatch: { 'mfarm:region': 'eu-1' },
        firstMatch: [{ platformName: 'windows-phone' }, { platformName: 'android' }],
      },
    }, opts);
    assert.equal(p.platform, 'android');
  });

  test('an unprefixed non-standard capability names itself in the error', () => {
    assert.throws(
      () => parseCapabilities({ capabilities: { alwaysMatch: { platformName: 'android', deviceName: 'Pixel' } } }, opts),
      /`deviceName`.*appium:deviceName/s,
      'the message has to say what to change — this is the first error a migrating team hits',
    );
  });

  test('legacy desiredCapabilities are accepted and prefixed for the upstream', () => {
    const p = parseCapabilities({
      desiredCapabilities: { platformName: 'android', 'mfarm:region': 'eu-1', deviceName: 'Pixel', app: 'https://x/a.apk' },
    }, opts);
    assert.equal(p.protocol, 'jsonwp', 'the response dialect has to match what was asked');
    assert.equal(p.upstream['appium:deviceName'], 'Pixel');
    assert.equal(p.upstream['appium:app'], 'https://x/a.apk');
  });

  test('mfarm: capabilities never reach the automation server', () => {
    const p = parseCapabilities({
      capabilities: { alwaysMatch: { platformName: 'android', 'mfarm:region': 'eu-1', 'mfarm:ttlMinutes': 15 } },
    }, opts);
    assert.equal(p.ttlMinutes, 15);
    assert.ok(!Object.keys(p.upstream).some((k) => k.startsWith('mfarm:')));
  });

  test('a missing region is a usable error rather than a default region', () => {
    assert.throws(() => parseCapabilities({ capabilities: { alwaysMatch: { platformName: 'android' } } }, opts),
      /mfarm:region/);
  });
});

// ---------------------------------------------------------------- hub

describe('hub status', () => {
  test('status needs no credentials, at both mount points', async () => {
    for (const url of ['/wd/hub/status', '/status']) {
      const r = await app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, url);
      assert.equal(r.json().value.ready, true);
    }
  });
});

describe('new session', () => {
  test('allocates a device and returns the W3C session shape', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'appium:app': 'https://example.test/app.apk' }),
    });

    assert.equal(r.statusCode, 200);
    const value = r.json().value;
    assert.match(value.sessionId, /^[0-9a-f-]{36}$/, 'the WebDriver session id IS the mfarm session id');
    assert.equal(value.capabilities['appium:automationName'], 'UiAutomator2', 'granted caps come from upstream');

    assert.equal(await sessionState(value.sessionId), 'ACTIVE');
    assert.equal(await deviceState(dev), 'SESSION_ACTIVE');

    const created = recorded.find((x) => x.url === '/session')!;
    const sent = (created.body as { capabilities: { alwaysMatch: Record<string, unknown> } }).capabilities.alwaysMatch;
    assert.equal(sent['appium:app'], 'https://example.test/app.apk', 'client caps are forwarded');
    assert.ok(!('mfarm:region' in sent), 'our vendor caps are stripped');
  });

  test('the udid is chosen by the allocator, never by the client', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const local = await withSystem(async (c) =>
      (await c.query('SELECT local_id FROM devices WHERE id = $1', [dev])).rows[0].local_id);

    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      // A client asking for someone else's device by udid must not get it.
      payload: androidCaps({ 'appium:udid': 'emulator-9999' }),
    });

    const sent = (recorded.find((x) => x.url === '/session')!.body as
      { capabilities: { alwaysMatch: Record<string, unknown> } }).capabilities.alwaysMatch;
    assert.equal(sent['appium:udid'], local, 'the hub overrides the requested udid');
  });

  test('a rejected upstream session gives the device back', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    upstreamMode = 'reject';

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });

    assert.equal(r.statusCode, 500);
    assert.equal(r.json().value.error, 'session not created');
    assert.match(r.json().value.message, /no devices matched/, 'the upstream reason has to survive');
    // The failure that would silently eat the fleet: a device stuck RESERVED against a session that
    // never existed.
    assert.equal(await deviceState(dev), 'CLEANING', 'released, not left reserved');
  });

  test('an unreachable automation server gives the device back', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    await withSystem((c) => c.query(
      `UPDATE hosts SET automation_endpoint = 'http://127.0.0.1:1' WHERE id = $1`, [hostId]));

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });

    await withSystem((c) => c.query('UPDATE hosts SET automation_endpoint = $2 WHERE id = $1', [hostId, upstreamUrl]));

    assert.equal(r.json().value.error, 'session not created');
    assert.equal(r.json().value['mfarm:code'], 'automation_unreachable');
    assert.equal(await deviceState(dev), 'CLEANING');
  });

  test('a device with no automation server is not allocated for WebDriver', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1, { webdriver: false });

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });

    assert.equal(r.json().value['mfarm:code'], 'no_capacity');
    assert.equal(await deviceState(dev), 'READY', 'it was never touched, so it stays allocatable');
  });

  test('no capacity is an error a test author can act on', async () => {
    await clearFleet();
    await seedDevices(1);
    await app.inject({ method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps() });

    const second = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyB), payload: androidCaps(),
    });
    assert.equal(second.statusCode, 500);
    assert.equal(second.json().value.error, 'session not created');
    assert.match(second.json().value.message, /queueTimeoutSeconds/, 'tell them how to wait instead');
  });

  test('a legacy JSONWP client gets a JSONWP response', async () => {
    await clearFleet();
    await seedDevices(1);
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: { desiredCapabilities: { platformName: 'android', 'mfarm:region': REGION, deviceName: 'Pixel' } },
    });
    assert.equal(r.statusCode, 200);
    assert.match(r.json().sessionId, /^[0-9a-f-]{36}$/, 'JSONWP reads the id from the top level');
    assert.equal(r.json().status, 0);
  });

  test('Appium 2 clients reach the same hub at the root path', async () => {
    await clearFleet();
    await seedDevices(1);
    const r = await app.inject({
      method: 'POST', url: '/session', headers: auth(keyA), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200);

    // The proxy reconstructs the upstream path by stripping its own mount prefix, so the root mount
    // is the case where an off-by-one leading slash would send every command to the wrong URL.
    const sid = r.json().value.sessionId;
    const cmd = await app.inject({
      method: 'POST', url: `/session/${sid}/element`, headers: auth(keyA),
      payload: { using: 'id', value: 'login' },
    });
    assert.equal(cmd.statusCode, 200);
    assert.equal(recorded.at(-1)!.url, '/session/upstream-session-1/element');
  });
});

describe('command proxy', () => {
  async function open(key = keyA): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(key), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().value.sessionId;
  }

  test('commands are rewritten onto the upstream session id and passed through verbatim', async () => {
    await clearFleet();
    await seedDevices(1);
    const sid = await open();

    const r = await app.inject({
      method: 'POST', url: `/wd/hub/session/${sid}/element`, headers: auth(keyA),
      payload: { using: 'id', value: 'login' },
    });

    assert.equal(r.statusCode, 200);
    assert.equal(r.json().value['element-6066-11e4-a52e-4f735466cecf'], 'element-42');

    const seen = recorded.at(-1)!;
    assert.equal(seen.url, '/session/upstream-session-1/element');
    assert.deepEqual(seen.body, { using: 'id', value: 'login' });
  });

  test('GET commands proxy without a body', async () => {
    await clearFleet();
    await seedDevices(1);
    const sid = await open();
    const r = await app.inject({ method: 'GET', url: `/wd/hub/session/${sid}/screenshot`, headers: auth(keyA) });
    assert.equal(r.json().value, 'iVBORw0KGgo=');
    assert.equal(recorded.at(-1)!.body, undefined);
  });

  test('an upstream error status is not rewritten into a success', async () => {
    await clearFleet();
    await seedDevices(1);
    const sid = await open();
    const r = await app.inject({ method: 'GET', url: `/wd/hub/session/${sid}/nonsense`, headers: auth(keyA) });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().value.error, 'unknown command');
  });

  test("another org's session id is 'invalid session id', not a 403", async () => {
    await clearFleet();
    await seedDevices(1);
    const sid = await open(keyA);

    const r = await app.inject({
      method: 'POST', url: `/wd/hub/session/${sid}/element`, headers: auth(keyB),
      payload: { using: 'id', value: 'login' },
    });
    // A 403 would confirm the id exists, and the id is the only thing an attacker needs to guess.
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().value.error, 'invalid session id');
    assert.equal(recorded.filter((x) => x.url.includes('/element')).length, 0, 'nothing reached the device');
  });

  test('a malformed session id is a client error, not a 500', async () => {
    // The second one is 36 characters of uuid-legal punctuation: a length-and-charset check passes
    // it through to Postgres, which raises on the cast and turns a client typo into a 500.
    for (const id of ['not-a-uuid', '-'.repeat(36)]) {
      const r = await app.inject({ method: 'GET', url: `/wd/hub/session/${id}/screenshot`, headers: auth(keyA) });
      assert.equal(r.statusCode, 404, id);
      assert.equal(r.json().value.error, 'invalid session id', id);
    }
  });
});

describe('quit', () => {
  test('quitting tells the upstream, ends the session and releases the device', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const sid = created.json().value.sessionId;

    const r = await app.inject({ method: 'DELETE', url: `/wd/hub/session/${sid}`, headers: auth(keyA) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().value, null);

    assert.ok(recorded.some((x) => x.method === 'DELETE' && x.url === '/session/upstream-session-1'));
    assert.equal(await sessionState(sid), 'ENDED');
    // CLEANING, never READY: the next tenant must not get the previous one's accounts and caches.
    assert.equal(await deviceState(dev), 'CLEANING');
  });

  test('commands after quit are rejected', async () => {
    await clearFleet();
    await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const sid = created.json().value.sessionId;
    await app.inject({ method: 'DELETE', url: `/wd/hub/session/${sid}`, headers: auth(keyA) });

    const r = await app.inject({ method: 'GET', url: `/wd/hub/session/${sid}/screenshot`, headers: auth(keyA) });
    assert.equal(r.json().value.error, 'invalid session id');
  });

  test('an unreachable upstream still releases the device', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const sid = created.json().value.sessionId;

    await withSystem((c) => c.query(
      `UPDATE hosts SET automation_endpoint = 'http://127.0.0.1:1' WHERE id = $1`, [hostId]));
    const r = await app.inject({ method: 'DELETE', url: `/wd/hub/session/${sid}`, headers: auth(keyA) });
    await withSystem((c) => c.query('UPDATE hosts SET automation_endpoint = $2 WHERE id = $1', [hostId, upstreamUrl]));

    assert.equal(r.statusCode, 200, 'quit must not fail because the host is gone');
    assert.equal(await deviceState(dev), 'CLEANING', 'giving the device back is the part that matters');
  });

  test('the session list shows live sessions and drops ended ones', async () => {
    await clearFleet();
    await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const sid = created.json().value.sessionId;

    const listed = await app.inject({ method: 'GET', url: '/wd/hub/sessions', headers: auth(keyA) });
    assert.deepEqual(listed.json().value.map((s: { id: string }) => s.id), [sid]);

    const otherOrg = await app.inject({ method: 'GET', url: '/wd/hub/sessions', headers: auth(keyB) });
    assert.deepEqual(otherOrg.json().value, [], 'RLS, not a WHERE clause someone can forget');

    await app.inject({ method: 'DELETE', url: `/wd/hub/session/${sid}`, headers: auth(keyA) });
    const after = await app.inject({ method: 'GET', url: '/wd/hub/sessions', headers: auth(keyA) });
    assert.deepEqual(after.json().value, []);
  });
});

describe('credentials', () => {
  test('a missing credential comes back in the W3C envelope, not the REST one', async () => {
    const r = await app.inject({ method: 'POST', url: '/wd/hub/session', payload: androidCaps() });
    assert.equal(r.statusCode, 401);
    const body = r.json();
    // Not `{error:{...}}`: a WebDriver client cannot read that, and the user sees "unknown
    // server-side error" instead of "your key is wrong".
    assert.equal(body.error, undefined);
    assert.equal(body.value['mfarm:code'], 'unauthorized');
    assert.match(body.value.message, /Bearer/);
  });

  test('the key can travel in the URL as Basic credentials', async () => {
    await clearFleet();
    await seedDevices(1);
    // https://<key>@hub.mfarm.dev/wd/hub — this is what makes the migration one URL rather than one
    // URL plus a client-library change to inject a header.
    const basic = Buffer.from(`${keyA}:`).toString('base64');
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session',
      headers: { authorization: `Basic ${basic}` }, payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200, r.body);
  });

  test('the key is also accepted as the Basic password', async () => {
    await clearFleet();
    await seedDevices(1);
    const basic = Buffer.from(`ignored-username:${keyA}`).toString('base64');
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session',
      headers: { authorization: `Basic ${basic}` }, payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200, r.body);
  });

  test('a bad capability body is a 400 the client can read', async () => {
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: { capabilities: { alwaysMatch: { platformName: 'android', 'mfarm:region': REGION, browser: 'x' } } },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().value.error, 'invalid argument');
  });
});

describe('waiting for capacity', () => {
  test('a queued session is promoted onto a freed device while the client waits', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    // The wait depends on something running promote_queued. In production that is the reaper; here
    // it is the same reaper, on a short interval.
    const reaping = await buildServer({ logger: false, reaperIntervalMs: 200 });

    const first = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const firstId = first.json().value.sessionId;

    const waiting = reaping.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyB),
      payload: androidCaps({ 'mfarm:queueTimeoutSeconds': 20 }),
    });

    // Free the device the way the fleet really does: release, then a worker confirms the restore.
    await new Promise((r) => setTimeout(r, 600));
    await app.inject({ method: 'DELETE', url: `/wd/hub/session/${firstId}`, headers: auth(keyA) });
    await withSystem((c) => c.query(
      `SELECT device_reset_complete((SELECT host_id FROM devices WHERE id = $1),
                                    $1, (SELECT fence FROM devices WHERE id = $1))`, [dev]));

    const r = await waiting;
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(await sessionState(r.json().value.sessionId), 'ACTIVE');
    await reaping.close();
  });

  test('promotion honours the capabilities the session was queued with', async () => {
    await clearFleet();
    // One device that cannot serve WebDriver, so the queued session must stay queued no matter how
    // many times promotion runs. Before constraints were recorded, promote_queued matched on region
    // alone and would have handed this over.
    const [plain] = await seedDevices(1, { webdriver: false });
    const queued = await withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT o_session_id AS id FROM allocate_device($1,NULL,$2,'android',NULL,'30 minutes','{}'::jsonb,'["webdriver"]'::jsonb)`,
        [orgA, REGION]);
      return rows[0].id;
    });
    assert.equal(await sessionState(queued), 'QUEUED');

    const promoted = await withSystem(async (c) =>
      (await c.query('SELECT promote_queued(20) AS n')).rows[0].n);
    assert.equal(Number(promoted), 0);
    assert.equal(await sessionState(queued), 'QUEUED');
    assert.equal(await deviceState(plain), 'READY');
  });
});

// ---------------------------------------------------------------- binding (ADR-0002 D1)

/**
 * The double-billing defect, and the fix.
 *
 * `mfarm run` allocates a session and hands the child a hub URL. Before binding existed the hub had
 * no way to be told about that session, so it allocated a second device from the client's
 * capabilities: the suite held two devices, paid for two, and never touched the CLI's. Nothing
 * failed — it overcharged, which is the kind of bug a customer finds on an invoice.
 *
 * These tests are written around the property that matters, which is a COUNT: one `mfarm run`, one
 * session, one device, however many times the suite calls `driver.quit()`.
 */
describe('binding to a session the caller already owns', () => {
  /** How `mfarm run` presents itself: the key as the Basic username, the session as the password. */
  const hubUrlAuth = (key: string, sessionId?: string) => ({
    authorization: `Basic ${Buffer.from(`${key}:${sessionId ?? ''}`).toString('base64')}`,
  });

  const liveSessions = (orgId: string) => withSystem(async (c) =>
    Number((await c.query(
      `SELECT count(*)::int AS n FROM sessions
        WHERE org_id = $1 AND state IN ('QUEUED','ALLOCATING','ACTIVE')`, [orgId])).rows[0].n));

  /** Allocate the way the CLI does, through the REST API. */
  async function cliAllocate(key: string) {
    const r = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(key),
      payload: { region: REGION, platform: 'android', requireCapabilities: ['webdriver'] },
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().session as { id: string; deviceId: string };
  }

  test('a suite under `mfarm run` holds one device, not two', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const cli = await cliAllocate(keyA);

    // The suite is unchanged: no mfarm capabilities at all, not even a region. All it got was a URL.
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id),
      payload: { capabilities: { alwaysMatch: { platformName: 'android' }, firstMatch: [{}] } },
    });

    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().value.sessionId, cli.id, 'the hub drives the session the CLI allocated');
    assert.equal(await liveSessions(orgA), 1, 'ONE session — this count is the whole defect');
    assert.equal(await deviceState(dev), 'SESSION_ACTIVE');
    assert.equal(await sessionState(cli.id), 'ACTIVE');
  });

  test('without a binding the hub still allocates its own session', async () => {
    // The unbound path is unchanged, and this test exists to keep the contrast visible: the same
    // request without the session id in the URL is what used to happen under `mfarm run`.
    await clearFleet();
    await seedDevices(2);
    const cli = await cliAllocate(keyA);

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.notEqual(r.json().value.sessionId, cli.id);
    assert.equal(await liveSessions(orgA), 2, 'two sessions, two devices, two bills');
  });

  test('the `mfarm:sessionId` capability binds the same way the URL does', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:sessionId': cli.id }),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().value.sessionId, cli.id);
    assert.equal(await liveSessions(orgA), 1);
  });

  test('the binding never reaches the automation server', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);
    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA),
      payload: androidCaps({ 'mfarm:sessionId': cli.id }),
    });
    const sent = recorded.find((r) => r.url === '/session')!.body as
      { capabilities: { alwaysMatch: Record<string, unknown> } };
    assert.equal(sent.capabilities.alwaysMatch['mfarm:sessionId'], undefined);
  });

  test('quit ends the WebDriver session but not the run', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const cli = await cliAllocate(keyA);
    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id), payload: androidCaps(),
    });

    const q = await app.inject({
      method: 'DELETE', url: `/wd/hub/session/${cli.id}`, headers: hubUrlAuth(keyA, cli.id),
    });
    assert.equal(q.statusCode, 200);

    // The device is still ours. `mfarm run` releases it when the child exits, and only then.
    assert.equal(await sessionState(cli.id), 'ACTIVE', 'quit must not end a session it does not own');
    assert.equal(await deviceState(dev), 'SESSION_ACTIVE');

    // And a suite that quits between tests re-binds instead of buying another device.
    const second = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id), payload: androidCaps(),
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().value.sessionId, cli.id);
    assert.equal(await liveSessions(orgA), 1, 'N tests, one device');
  });

  test('quit still releases a session the hub allocated itself', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const id = created.json().value.sessionId;
    await app.inject({ method: 'DELETE', url: `/wd/hub/session/${id}`, headers: auth(keyA) });
    assert.equal(await sessionState(id), 'ENDED');
    assert.equal(await deviceState(dev), 'CLEANING');
  });

  test('a failed upstream leaves a bound session for its owner to release', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const cli = await cliAllocate(keyA);
    upstreamMode = 'reject';

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 500);
    // The unbound path gives the device back here. The bound path must not: `mfarm run` is still
    // running, still believes it holds this device, and will release it on its own way out.
    assert.notEqual(await sessionState(cli.id), 'ENDED');
    assert.notEqual(await deviceState(dev), 'CLEANING');
  });

  test("another org's session id is not bindable", async () => {
    await clearFleet();
    await seedDevices(2);
    const mine = await cliAllocate(keyB);

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, mine.id), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 500);
    assert.match(r.json().value.message, /No session .* in this organisation/);
    assert.equal(await sessionState(mine.id), 'ALLOCATING', "orgB's session is untouched");
  });

  test('a session already driving a WebDriver session cannot be bound twice', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);
    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id), payload: androidCaps(),
    });

    const again = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id), payload: androidCaps(),
    });
    assert.equal(again.statusCode, 500);
    assert.match(again.json().value.message, /already has a WebDriver session/);
    assert.equal(await liveSessions(orgA), 1);
  });

  test('binding to a device that cannot run Appium fails before the proxy hop', async () => {
    await clearFleet();
    await seedDevices(1, { webdriver: false });
    // Allocated without demanding `webdriver`, the way `mfarm run` does for a non-WebDriver suite.
    const s = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(keyA),
      payload: { region: REGION, platform: 'android' },
    });
    const id = s.json().session.id;

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, id), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 500);
    assert.match(r.json().value.message, /no automation server/);
  });

  test('a queued session says so rather than looking like a fleet failure', async () => {
    await clearFleet();
    const queued = await withSystem(async (c) =>
      (await c.query(
        `SELECT o_session_id AS id FROM allocate_device($1,NULL,$2,'android',NULL,'30 minutes','{}'::jsonb,'[]'::jsonb)`,
        [orgA, REGION])).rows[0].id);
    assert.equal(await sessionState(queued), 'QUEUED');

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, queued), payload: androidCaps(),
    });
    assert.match(r.json().value.message, /still queued/);
  });

  test('a URL binding and a capability that disagree are refused, not resolved', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);

    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id),
      payload: androidCaps({ 'mfarm:sessionId': randomUUID() }),
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().value.message, /does not match the session in the hub URL/);
  });

  test('allocation capabilities cannot be combined with a binding', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);

    for (const extra of [{ 'mfarm:tier': 'cuttlefish' }, { 'mfarm:ttlMinutes': 60 },
                         { 'mfarm:queueTimeoutSeconds': 30 }]) {
      const r = await app.inject({
        method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id),
        payload: androidCaps(extra),
      });
      assert.equal(r.statusCode, 400, JSON.stringify(extra));
      assert.match(r.json().value.message, /cannot be combined with `mfarm:sessionId`/);
    }
  });

  test('a region that disagrees with the session is refused', async () => {
    await clearFleet();
    await seedDevices(1);
    const cli = await cliAllocate(keyA);
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id),
      payload: {
        capabilities: {
          alwaysMatch: { platformName: 'android', 'mfarm:region': 'somewhere-else' },
          firstMatch: [{}],
        },
      },
    });
    assert.equal(r.statusCode, 500);
    assert.match(r.json().value.message, /is in wd-test/);
  });

  test('a platformName that disagrees with the session is refused', async () => {
    await clearFleet();
    await seedDevices(1);           // android
    const cli = await cliAllocate(keyA);
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, cli.id),
      payload: { capabilities: { alwaysMatch: { platformName: 'iOS' }, firstMatch: [{}] } },
    });
    assert.equal(r.statusCode, 500);
    assert.match(r.json().value.message, /holds a android device/);
  });

  test('a non-uuid in the password half is ignored, not an error', async () => {
    // Plenty of clients put a placeholder there. Failing their first request over it would be a
    // poor welcome, and the key alone is still a complete credential.
    await clearFleet();
    await seedDevices(1);
    const r = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: hubUrlAuth(keyA, 'x'), payload: androidCaps(),
    });
    assert.equal(r.statusCode, 200, r.body);
  });
});

// ---------------------------------------------------------------- automation transport (ADR-0004)

/**
 * Appium binds loopback, so the hop from the hub to it has to terminate on the worker — and the
 * thing that terminates it has to be able to tell an authorised request from a stranger's, because
 * on the other side of it is unauthenticated device control.
 *
 * The answer is the token the system already has: an Ed25519 grant the worker verifies offline with
 * the public key it was handed at registration. These tests assert the control-plane half. The
 * gateway that consumes it does not exist yet (ADR-0004, "what is not implemented"), which is
 * exactly why the wire format is pinned down here rather than discovered later on a bare-metal box.
 */
describe('the automation grant', () => {
  const grantOn = (r: Recorded): string => {
    const header = r.auth ?? '';
    assert.ok(header.startsWith('Bearer '), `no grant on ${r.method} ${r.url}`);
    return header.slice(7);
  };

  test('every upstream request carries a grant the worker can verify', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const created = await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const id = created.json().value.sessionId;
    await app.inject({ method: 'GET', url: `/wd/hub/session/${id}/screenshot`, headers: auth(keyA) });
    await app.inject({ method: 'DELETE', url: `/wd/hub/session/${id}`, headers: auth(keyA) });

    assert.ok(recorded.length >= 3, 'new session, one command, and the quit');
    for (const r of recorded) {
      const v = verifySessionToken(grantOn(r), app.signingKey.publicKeyPem, hostId);
      assert.equal(v.ok, true, `grant on ${r.method} ${r.url} did not verify`);
      assert.equal(v.ok && v.claims.sid, id, 'names the session it is for');
      assert.equal(v.ok && v.claims.did, dev, 'and the device — a leaked grant drives nothing else');
      assert.equal(v.ok && v.claims.org, orgA);
    }
  });

  test('a grant is useless at another host', async () => {
    await clearFleet();
    await seedDevices(1);
    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const v = verifySessionToken(
      grantOn(recorded[0]), app.signingKey.publicKeyPem, randomUUID(),
    );
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, 'wrong_audience');
  });

  test('the grant carries the fence, so a replayed command is refusable', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    await app.inject({
      method: 'POST', url: '/wd/hub/session', headers: auth(keyA), payload: androidCaps(),
    });
    const fence = await withSystem(async (c) =>
      Number((await c.query('SELECT fence FROM devices WHERE id = $1', [dev])).rows[0].fence));
    const v = verifySessionToken(grantOn(recorded[0]), app.signingKey.publicKeyPem, hostId);
    assert.equal(v.ok && v.claims.fence, fence,
                 'a partitioned hub replaying an old command presents an old fence');
  });

  test('a bound session grants against the device its owner allocated', async () => {
    await clearFleet();
    const [dev] = await seedDevices(1);
    const s = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(keyA),
      payload: { region: REGION, platform: 'android', requireCapabilities: ['webdriver'] },
    });
    const cli = s.json().session;

    await app.inject({
      method: 'POST', url: '/wd/hub/session',
      headers: { authorization: `Basic ${Buffer.from(`${keyA}:${cli.id}`).toString('base64')}` },
      payload: androidCaps(),
    });

    const v = verifySessionToken(grantOn(recorded[0]), app.signingKey.publicKeyPem, hostId);
    assert.equal(v.ok && v.claims.sid, cli.id);
    assert.equal(v.ok && v.claims.did, dev);
  });
});
