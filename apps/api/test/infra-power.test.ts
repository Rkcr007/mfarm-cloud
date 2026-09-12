/**
 * Powering a machine from the console — the safety model first, the happy path second.
 *
 * ---------------------------------------------------------------- what this file is really about
 *
 * There is one way this feature becomes a catastrophe and it is not a cloud API error. It is this:
 * **`hosts.hostname` is a string a WORKER chooses for itself at registration.** A driver that
 * resolved a host name to an instance name would let an agent that registered as `mfarm-cp` put a
 * Stop button for the CONTROL PLANE on somebody's console — and a misconfigured agent would do it
 * by accident, with no attacker involved.
 *
 * So the first suite below registers a host calling itself the control plane and asserts that
 * nothing happens. Everything else in this file is ordinary.
 *
 * ---------------------------------------------------------------- how the provider is faked
 *
 * `globalThis.fetch` is replaced, and the replacement asserts on the URL it is given. That is the
 * seam that matters: the test can then check WHICH instance in WHICH zone and project was acted on,
 * which is the fact the allow-list exists to control. Nothing here reaches Google.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.GCP_PROJECT = 'mfarm-test';
/**
 * THE ALLOW-LIST UNDER TEST. `lab-a` is powerable, `lab-b` is not, and the control plane's own name
 * is deliberately absent — the tests below register hosts by all three names.
 */
process.env.MFARM_POWER_INSTANCES = 'lab-a:asia-south1-c';
/**
 * The settle window, wound in from twenty-five seconds to two.
 *
 * It is how long an operation watches a machine before answering, and the production value is right
 * for a GCE start. Leaving it here would make one test take half a minute to assert a string.
 */
process.env.INFRA_POWER_SETTLE_MS = '2000';

import { test, before, after, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue } from '../src/users.ts';
import { resetCloudCache } from '../src/infra/cloud.ts';
import { reconcileOperations } from '../src/infra/reconcile.ts';

let app: FastifyInstance;
let cookie: string, csrf: string;
let labA: string, labB: string, cpHost: string;

const REGION = `pwr-${randomUUID().slice(0, 8)}`;
const OPERATOR = `op-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';

const realFetch = globalThis.fetch;

/** Every provider request this test saw, so an assertion can name the instance that was touched. */
let calls: Array<{ method: string; url: string }> = [];

/**
 * A fake GCE. `status` is what the instance reports; `fail` makes the provider answer or vanish.
 *
 * THE TWO FAILURE MODES ARE SEPARATE ON PURPOSE. "The provider said no" and "the provider never
 * spoke" produce different outcomes in the audit log — `failed` and `unknown` — and collapsing them
 * is how somebody presses Stop a second time on a machine that is already stopping.
 */
function fakeCloud(opts: {
  status?: string;
  statusAfter?: string;
  refuse?: number;
  vanish?: 'always' | 'action' | 'never';
  metadataName?: string | null;
} = {}) {
  let status = opts.status ?? 'RUNNING';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });

    if (url.includes('/computeMetadata/v1/instance/name')) {
      if (opts.metadataName === null) throw new Error('no metadata server');
      return new Response(opts.metadataName ?? 'mfarm-cp-test', { status: 200 });
    }
    if (url.includes('/service-accounts/default/token')) {
      return new Response(JSON.stringify({ access_token: 'fake', expires_in: 3600 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (opts.vanish === 'always') throw new Error('network gone');

    const isAction = /\/(start|stop|reset)$/.test(url);
    if (isAction) {
      if (opts.vanish === 'action') throw new Error('network gone');
      if (opts.refuse) return new Response('refused', { status: opts.refuse });
      // The machine moves, as the provider would move it.
      status = opts.statusAfter
        ?? (url.endsWith('/stop') ? 'TERMINATED' : 'RUNNING');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (opts.refuse) return new Response('refused', { status: opts.refuse });
    return new Response(JSON.stringify({ status }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const post = (url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url, payload, headers: { cookie, 'x-mfarm-csrf': csrf } });

const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string, params: unknown[] = [],
) => withSystem(async (c) => (await c.query<T>(sql, params)).rows);

const seedHost = (hostname: string) => q<{ id: string }>(
  `INSERT INTO hosts (region, hostname, state, protocol_version, up_since, last_heartbeat_at,
                      cores, memory_mb)
   VALUES ($1,$2,'UP',2, now() - interval '1 hour', now(), 8, 32768) RETURNING id`,
  [REGION, hostname]).then((r) => r[0].id);

const opsFor = (hostId: string) => q<{ action: string; result: string; detail: string | null;
                                       params: Record<string, unknown> }>(
  `SELECT action, result, detail, params FROM infra_operations
    WHERE target_id = $1 ORDER BY requested_at`, [hostId]);

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  let orgId = '';
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Power Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Power',50) RETURNING id`,
      [`pwr-${randomUUID()}`])).rows[0].id;
  });
  await upsertUser(OPERATOR, PASSWORD, orgId, 'admin');
  await withSystem((c) =>
    c.query('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]));
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login',
    payload: { email: OPERATOR, password: PASSWORD } });
  cookie = `mfarm_session=${cookieValue(String(res.headers['set-cookie']).replace(/; /g, '; '), 'mfarm_session')}`;
  csrf = res.json().csrfToken;

  labA = await seedHost('lab-a');
  labB = await seedHost('lab-b');
  // A host that has registered itself under the control plane's own instance name. This is the
  // scenario the allow-list exists for.
  cpHost = await seedHost('mfarm-cp-test');
});

beforeEach(() => {
  calls = [];
  /**
   * THE CACHES ARE DROPPED BETWEEN TESTS, and forgetting that cost a full run of red.
   *
   * `cloud.ts` caches the token and the instance's own name for the life of the process, correctly
   * — neither changes for the life of a VM. In one file that runs a dozen scenarios it means the
   * first test to point the fake metadata server somewhere decides where it points forever, and
   * every later test fails with a refusal about the control plane stopping itself.
   */
  resetCloudCache();
});
afterEach(() => { globalThis.fetch = realFetch; });

after(async () => {
  globalThis.fetch = realFetch;
  await withSystem(async (c) => {
    await c.query('ALTER TABLE infra_operations DISABLE TRIGGER infra_operations_append_only');
    await c.query(`DELETE FROM infra_operations WHERE target_id IN
                     (SELECT id::text FROM hosts WHERE region = $1)`, [REGION]);
    await c.query('ALTER TABLE infra_operations ENABLE TRIGGER infra_operations_append_only');
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await app.close();
  await closePools();
});

describe('what a browser is NOT allowed to switch off', () => {
  test('A HOST THAT IS NOT ON THE ALLOW-LIST CANNOT BE STOPPED, whatever it calls itself', async () => {
    fakeCloud();
    const res = await post(`/v1/infra/hosts/${labB}/stop`);
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.json().error.message, /power allow-list/);
    assert.match(res.json().error.message, /not derived from the host name a worker registers with/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0,
      'the cloud API was called for a host that is not on the list');
    assert.equal((await opsFor(labB)).length, 0);
  });

  test('A WORKER THAT REGISTERS AS THE CONTROL PLANE GETS NOTHING', async () => {
    fakeCloud();
    const res = await post(`/v1/infra/hosts/${cpHost}/stop`);
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });

  test('...and even if it were on the list, the control plane refuses to stop itself', async () => {
    // The allow-list already makes this unreachable; this asserts the SECOND lock, by pointing the
    // fake metadata server at the instance `lab-a` maps to.
    fakeCloud({ metadataName: 'lab-a' });
    const res = await post(`/v1/infra/hosts/${labA}/stop`);
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.json().error.message, /nothing would be left to start it again/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });

  test('an org admin who is not an operator reaches none of it', async () => {
    fakeCloud();
    const other = `plain-${randomUUID()}@example.test`;
    const orgId = (await q<{ org_id: string }>(
      'SELECT org_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE lower(u.email) = lower($1)',
      [OPERATOR]))[0].org_id;
    await upsertUser(other, PASSWORD, orgId as string, 'admin');
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login',
      payload: { email: other, password: PASSWORD } });
    const theirs = `mfarm_session=${cookieValue(String(login.headers['set-cookie']).replace(/; /g, '; '), 'mfarm_session')}`;
    const res = await app.inject({
      method: 'POST', url: `/v1/infra/hosts/${labA}/stop`, payload: {},
      headers: { cookie: theirs, 'x-mfarm-csrf': login.json().csrfToken },
    });
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });
});

describe('the allow-list decides which machine is touched', () => {
  test('the instance, zone and project come from configuration, not from the request', async () => {
    fakeCloud({ status: 'TERMINATED' });
    const res = await post(`/v1/infra/hosts/${labA}/start`);
    assert.equal(res.statusCode, 200, res.body);
    const action = calls.find((c) => c.method === 'POST' && c.url.endsWith('/start'));
    assert.ok(action, 'no start was issued');
    assert.match(action.url, /\/projects\/mfarm-test\/zones\/asia-south1-c\/instances\/lab-a\/start$/);
  });

  test('the audit row names the instance, so the log is unambiguous across projects', async () => {
    fakeCloud({ status: 'TERMINATED' });
    await post(`/v1/infra/hosts/${labA}/start`, { reason: 'morning' });
    const row = (await opsFor(labA)).at(-1)!;
    assert.equal(row.params.instance, 'lab-a');
    assert.equal(row.params.zone, 'asia-south1-c');
    assert.equal(row.params.reason, 'morning');
  });
});

describe('§9 — the three answers', () => {
  test('STARTING AN ALREADY-RUNNING MACHINE IS `noop`, not a failure', async () => {
    fakeCloud({ status: 'RUNNING' });
    const res = await post(`/v1/infra/hosts/${labA}/start`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().result, 'noop');
    assert.match(res.json().message, /already running/);
    assert.equal(calls.filter((c) => c.url.endsWith('/start')).length, 0,
      'the provider was asked to start a machine that was already running');
    assert.equal((await opsFor(labA)).at(-1)!.result, 'noop');
  });

  test('STOPPING AN ALREADY-STOPPED MACHINE IS `noop`', async () => {
    fakeCloud({ status: 'TERMINATED' });
    const res = await post(`/v1/infra/hosts/${labA}/stop`);
    assert.equal(res.json().result, 'noop');
    assert.match(res.json().message, /already stopped/);
  });

  test('a machine already on its way is not asked again', async () => {
    fakeCloud({ status: 'STOPPING' });
    const res = await post(`/v1/infra/hosts/${labA}/stop`);
    assert.equal(res.json().result, 'noop');
    assert.match(res.json().message, /already stopping/);
  });

  test('A PROVIDER THAT NEVER ANSWERS IS `unknown`, NOT `failed`', async () => {
    fakeCloud({ status: 'RUNNING', vanish: 'action' });
    const res = await post(`/v1/infra/hosts/${labA}/stop`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().result, 'unknown',
      'an operation whose answer was lost was reported as failed — this is how somebody presses '
      + 'Stop twice on a machine that is already stopping');
    assert.match(res.json().message, /may have been carried out/);
    assert.equal((await opsFor(labA)).at(-1)!.result, 'unknown');
  });

  test('a provider that REFUSES is `failed`, and says what to fix', async () => {
    fakeCloud({ status: 'RUNNING', refuse: 403 });
    const res = await post(`/v1/infra/hosts/${labA}/stop`);
    assert.equal(res.json().result, 'failed');
    // The 403 that will actually happen on this farm is the OAuth scope one, and the message has to
    // name it or somebody spends an afternoon on IAM.
    assert.match(res.json().message, /scopes cap IAM/);
    assert.match(res.json().message, /RUNBOOK/);
  });

  test('a machine the provider has never heard of is a failure with a plain reason', async () => {
    fakeCloud({ status: 'RUNNING', refuse: 404 });
    const res = await post(`/v1/infra/hosts/${labA}/stop`);
    assert.equal(res.json().result, 'failed');
    assert.match(res.json().message, /no such instance/);
  });
});

describe('the happy paths', () => {
  test('a stop that settles reports the thing an operator actually wants to hear', async () => {
    fakeCloud({ status: 'RUNNING' });
    const res = await post(`/v1/infra/hosts/${labA}/stop`);
    assert.equal(res.json().result, 'succeeded');
    assert.match(res.json().message, /costs nothing until it is started again/);
    assert.equal((await opsFor(labA)).at(-1)!.result, 'succeeded');
  });

  /**
   * THE OTHER HALF OF THE ROUND TRIP, and the reason the real lab could not be restarted from the
   * console after being stopped from it.
   *
   * Nothing else writes `hosts.state = 'DOWN'` — the reaper writes QUARANTINED for silence, which
   * is right for a host that went quiet on its own and wrong for one we just switched off and
   * watched the provider agree about. Without this the card reads `unknown` forever.
   */
  test('A CONFIRMED STOP MARKS THE HOST DOWN, so the page can say `stopped`', async () => {
    fakeCloud({ status: 'RUNNING' });
    const res = await post(`/v1/infra/hosts/${labA}/stop`);
    assert.equal(res.json().result, 'succeeded');

    const [row] = await q<{ state: string }>(
      'SELECT state::text AS state FROM hosts WHERE id = $1', [labA]);
    assert.equal(row.state, 'DOWN',
      'the one moment the control plane KNOWS a machine is off, and it threw the knowledge away');

    const overview = await app.inject({ method: 'GET', url: '/v1/infra/overview', headers: { cookie } });
    const h = overview.json().hosts.find((x: { id: string }) => x.id === labA);
    assert.equal(h.power, 'stopped', 'the card would offer no way back');

    // Put it back, so the tests after this one see a host that has not been switched off.
    await q(`UPDATE hosts SET state = 'UP', last_heartbeat_at = now() WHERE id = $1`, [labA]);
  });

  /**
   * THE BRANCH THE REAL FARM ACTUALLY TAKES, and the reason the test above is not enough.
   *
   * Measured 2026-09-13, twice: a GCE stop takes longer than the settle window, so both
   * console-initiated stops came back `accepted` with "last seen STOPPING" and the `succeeded`
   * branch never ran. The card kept reading `running` for a machine on its way off.
   *
   * STOPPING is one-way — there is no path back to RUNNING without a start — so DOWN is a record
   * rather than a prediction, and a heartbeat lifts it if it somehow were.
   */
  test('A STOP THAT IS STILL STOPPING ALSO MARKS IT DOWN', async () => {
    fakeCloud({ status: 'RUNNING', statusAfter: 'STOPPING' });
    const res = await post(`/v1/infra/hosts/${labA}/stop`);
    assert.equal(res.json().result, 'accepted');

    const [row] = await q<{ state: string }>(
      'SELECT state::text AS state FROM hosts WHERE id = $1', [labA]);
    assert.equal(row.state, 'DOWN',
      'the card would read `running` for a machine the provider says is stopping');

    await q(`UPDATE hosts SET state = 'UP', last_heartbeat_at = now() WHERE id = $1`, [labA]);
  });

  test('a STARTING machine is NOT marked down — that is the other direction', async () => {
    fakeCloud({ status: 'TERMINATED', statusAfter: 'STAGING' });
    const res = await post(`/v1/infra/hosts/${labA}/start`);
    assert.equal(res.json().result, 'accepted');
    const [row] = await q<{ state: string }>(
      'SELECT state::text AS state FROM hosts WHERE id = $1', [labA]);
    assert.notEqual(row.state, 'DOWN', 'a machine that is booting was recorded as stopped');
  });

  test('a start that settles warns that the devices are not ready yet', async () => {
    fakeCloud({ status: 'TERMINATED' });
    const res = await post(`/v1/infra/hosts/${labA}/start`);
    assert.equal(res.json().result, 'succeeded');
    assert.match(res.json().message, /cold boot/);
  });

  test('A START THAT IS STILL BOOTING STAYS `accepted`, and the row is left open', async () => {
    // The provider takes the request and the machine stays STAGING — which is what a real GCE start
    // looks like for the first minute or two.
    fakeCloud({ status: 'TERMINATED', statusAfter: 'STAGING' });
    const res = await post(`/v1/infra/hosts/${labA}/start`);
    assert.equal(res.json().result, 'accepted',
      'a machine that is still starting was reported as finished');
    assert.match(res.json().message, /This page follows it from here/);

    const row = (await opsFor(labA)).at(-1)!;
    assert.equal(row.result, 'accepted', 'the log claimed an outcome nobody had');
    assert.match(row.detail ?? '', /Accepted; last seen STAGING/);
  });

  test('restarting a stopped machine is refused rather than silently started', async () => {
    fakeCloud({ status: 'TERMINATED' });
    const res = await post(`/v1/infra/hosts/${labA}/restart`);
    assert.equal(res.json().result, 'failed');
    assert.match(res.json().message, /Start it instead/);
    assert.equal(calls.filter((c) => c.url.endsWith('/reset')).length, 0);
  });

  test('a restart reaches the provider as `reset`', async () => {
    fakeCloud({ status: 'RUNNING' });
    await post(`/v1/infra/hosts/${labA}/restart`);
    assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/reset')),
      'restart did not map onto the provider verb');
  });
});

describe('operations that outlive their own request', () => {
  /**
   * THE GAP THE REAL FARM LEFT. A GCE stop takes longer than the settle window, so both
   * console-initiated stops on 2026-09-13 came back `accepted` — honest, and open. Nothing closed
   * them. An audit log full of operations that never finished stops answering the one question it
   * exists for: did anything actually change?
   *
   * The reconciler ASKS and WRITES DOWN. It never re-issues: two things issuing stops is how a farm
   * ends up stopped twice and started once.
   */
  const openOps = () => q<{ id: string; result: string; detail: string | null }>(
    `SELECT id, result, detail FROM infra_operations
      WHERE target_id = $1 ORDER BY requested_at DESC LIMIT 1`, [labA]);

  /**
   * THE RECONCILER IS FLEET-WIDE, so every test in this file that produced an `accepted` row is one
   * of its inputs. Settling them first is what makes the counts below mean what they say — without
   * it the assertions are about whatever the tests above happened to leave lying around, which is
   * the same class of defect as a fixture that seeds the state it is testing.
   */
  beforeEach(async () => {
    await q(`UPDATE infra_operations SET result = 'noop', finished_at = now(),
                    detail = 'closed by the test fixture'
              WHERE result = 'accepted'`);
  });

  test('a stop that finished after we stopped watching is settled as succeeded', async () => {
    // Accepted while STOPPING...
    fakeCloud({ status: 'RUNNING', statusAfter: 'STOPPING' });
    assert.equal((await post(`/v1/infra/hosts/${labA}/stop`)).json().result, 'accepted');
    assert.equal((await openOps())[0].result, 'accepted');

    // ...and by the time anybody looks again, the machine is off.
    resetCloudCache();
    fakeCloud({ status: 'TERMINATED' });
    const out = await reconcileOperations();
    assert.equal(out.settled, 1, `nothing was settled (checked ${out.checked})`);

    const [row] = await openOps();
    assert.equal(row.result, 'succeeded');
    assert.match(row.detail ?? '', /is stopped/);

    await q(`UPDATE hosts SET state = 'UP', last_heartbeat_at = now() WHERE id = $1`, [labA]);
  });

  test('one that is STILL going is left alone, not guessed at', async () => {
    fakeCloud({ status: 'RUNNING', statusAfter: 'STOPPING' });
    await post(`/v1/infra/hosts/${labA}/stop`);

    resetCloudCache();
    fakeCloud({ status: 'STOPPING' });
    const out = await reconcileOperations();
    assert.equal(out.settled, 0);
    assert.equal(out.gaveUp, 0, 'an operation in flight was settled on its first check');
    assert.equal((await openOps())[0].result, 'accepted');

    await q(`UPDATE hosts SET state = 'UP', last_heartbeat_at = now() WHERE id = $1`, [labA]);
  });

  test('one that has been open too long settles as `unknown`, never as failed', async () => {
    fakeCloud({ status: 'RUNNING', statusAfter: 'STOPPING' });
    await post(`/v1/infra/hosts/${labA}/stop`);
    /**
     * WOUND THE HORIZON IN rather than backdating the row. `requested_at` is immutable and 053's
     * trigger refuses the UPDATE — which is the trigger working, and the reason this knob exists.
     */
    process.env.INFRA_OPERATION_GIVE_UP_MS = '0';
    resetCloudCache();
    fakeCloud({ status: 'RUNNING' });   // it never got there
    const out = await reconcileOperations();
    assert.equal(out.gaveUp, 1);

    const [after] = await openOps();
    assert.equal(after.result, 'unknown',
      'an operation whose outcome nobody established was recorded as a failure');
    assert.match(after.detail ?? '', /which is not the stopped it asked for/);

    delete process.env.INFRA_OPERATION_GIVE_UP_MS;
    await q(`UPDATE hosts SET state = 'UP', last_heartbeat_at = now() WHERE id = $1`, [labA]);
  });

  test('an unreachable provider leaves a recent operation open rather than condemning it', async () => {
    fakeCloud({ status: 'RUNNING', statusAfter: 'STOPPING' });
    await post(`/v1/infra/hosts/${labA}/stop`);

    resetCloudCache();
    fakeCloud({ vanish: 'always' });
    const out = await reconcileOperations();
    assert.equal(out.settled, 0);
    assert.equal(out.gaveUp, 0);
    assert.equal((await openOps())[0].result, 'accepted');

    await q(`UPDATE hosts SET state = 'UP', last_heartbeat_at = now() WHERE id = $1`, [labA]);
  });

  test('a DRAIN is never reconciled — it finished inside its own request', async () => {
    fakeCloud();
    await post(`/v1/infra/hosts/${labA}/drain`, { reason: 'not a power op' });
    const out = await reconcileOperations();
    assert.equal(out.checked, 0, 'the reconciler is looking at operations that need no reconciling');
    await post(`/v1/infra/hosts/${labA}/resume`);
  });
});

describe('what the console is told', () => {
  test('power is declared available, and only the listed host is powerable', async () => {
    fakeCloud();
    const res = await app.inject({ method: 'GET', url: '/v1/infra/overview', headers: { cookie } });
    const body = res.json();
    assert.equal(body.capabilities.power, true);
    const byName = Object.fromEntries(
      body.hosts.map((h: { hostname: string; powerable: boolean }) => [h.hostname, h.powerable]));
    assert.equal(byName['lab-a'], true);
    assert.equal(byName['lab-b'], false,
      'a host that is not on the allow-list was advertised as powerable');
    assert.equal(byName['mfarm-cp-test'], false);
  });
});
