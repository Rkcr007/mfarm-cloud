/**
 * What an operator can do to this farm from the console, and what happens when they do it twice.
 *
 * THE BRIEF'S §9 IS THE SPINE OF THIS FILE. "Starting an already-running VM should show 'already
 * running', not fail" is not a nicety: somebody who is unsure whether their click landed WILL click
 * again, and a farm that answers the second click with a red error teaches them to distrust the
 * first. So every operation below is pressed twice, and the second press is asserted to be a calm
 * `noop` that changed nothing — including that it did not rewrite the reason and the timestamp of
 * the first.
 *
 * THE OTHER HALF IS THE REFUSALS. A host the reaper quarantined must not be drainable, and a host
 * nobody drained must not be resumable, and both have to say WHY in a sentence somebody can act on.
 * A refusal that reads "forbidden" sends a person to SSH, which is the thing this work exists to
 * stop.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.HOST_HOURLY_COST = '65';
process.env.COST_CURRENCY = '₹';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue } from '../src/users.ts';

let app: FastifyInstance;
let orgId: string;
let operatorCookie: string, adminCookie: string, operatorCsrf: string, adminCsrf: string;

const REGION = `ops-${randomUUID().slice(0, 8)}`;
const OPERATOR = `op-${randomUUID()}@example.test`;
const ADMIN = `admin-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';

async function signIn(email: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `sign-in failed: ${res.body}`);
  const raw = String(res.headers['set-cookie']);
  return {
    cookie: `mfarm_session=${cookieValue(raw.replace(/; /g, '; '), 'mfarm_session')}`,
    csrf: res.json().csrfToken as string,
  };
}

/**
 * A POST as the operator, with the CSRF token the session was minted with.
 *
 * `payload` is typed as a record rather than `unknown`, because `inject`'s overloads resolve to its
 * CHAINING form when the argument type is not narrow enough — and then `res.statusCode` does not
 * exist and the error points at the assertion rather than at the helper.
 */
const post = (url: string, payload: Record<string, unknown> = {}, who = 'operator') =>
  app.inject({
    method: 'POST', url, payload,
    headers: {
      cookie: who === 'operator' ? operatorCookie : adminCookie,
      'x-mfarm-csrf': who === 'operator' ? operatorCsrf : adminCsrf,
    },
  });

const q = <T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string, params: unknown[] = [],
) => withSystem(async (c) => (await c.query<T>(sql, params)).rows);

async function seedHost(name: string, opts: { beatSecondsAgo?: number } = {}) {
  const beat = new Date(Date.now() - (opts.beatSecondsAgo ?? 3) * 1000);
  const rows = await q<{ id: string }>(
    `INSERT INTO hosts (region, hostname, state, protocol_version, up_since, last_heartbeat_at,
                        cores, memory_mb)
     VALUES ($1,$2,'UP',2, now() - interval '2 hours', $3, 8, 32768) RETURNING id`,
    [REGION, `${name}-${randomUUID().slice(0, 6)}`, beat]);
  return rows[0].id;
}

const seedDevice = (host: string, state: string) => q<{ id: string }>(
  `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id)
   VALUES ($1,$2,'android','cuttlefish','Pixel Test','14',$3,'[]'::jsonb,$4) RETURNING id`,
  [host, REGION, state, `cf-${randomUUID().slice(0, 6)}`]).then((r) => r[0].id);

const hostRow = (id: string) => q<{ state: string; quarantine_source: string | null;
                                    quarantine_reason: string | null; quarantined_at: Date | null }>(
  `SELECT state::text AS state, quarantine_source, quarantine_reason, quarantined_at
     FROM hosts WHERE id = $1`, [id]).then((r) => r[0]);

const opsFor = (hostId: string) => q<{ action: string; result: string; detail: string | null;
                                       actor_email: string; params: Record<string, unknown> }>(
  `SELECT action, result, detail, actor_email, params FROM infra_operations
    WHERE target_id = $1 ORDER BY requested_at`, [hostId]);

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Ops Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Ops',50) RETURNING id`,
      [`ops-${randomUUID()}`])).rows[0].id;
  });
  await upsertUser(OPERATOR, PASSWORD, orgId, 'admin');
  await upsertUser(ADMIN, PASSWORD, orgId, 'admin');
  await withSystem((c) =>
    c.query('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]));
  ({ cookie: operatorCookie, csrf: operatorCsrf } = await signIn(OPERATOR));
  ({ cookie: adminCookie, csrf: adminCsrf } = await signIn(ADMIN));
});

after(async () => {
  await withSystem(async (c) => {
    await c.query('ALTER TABLE infra_operations DISABLE TRIGGER infra_operations_append_only');
    await c.query(`DELETE FROM infra_operations WHERE target_id IN
                     (SELECT id::text FROM hosts WHERE region = $1)`, [REGION]);
    await c.query('ALTER TABLE infra_operations ENABLE TRIGGER infra_operations_append_only');
    // Sessions first: `sessions.region` references `regions`, and one of the retire tests creates a
    // session to prove a tenant cannot be retired out from under. Deleting the region before them
    // fails the whole file's teardown on a foreign key.
    await c.query('DELETE FROM sessions WHERE region = $1', [REGION]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await app.close();
  await closePools();
});

describe('who may operate', () => {
  test('an org admin who is not a fleet operator cannot drain anything', async () => {
    const host = await seedHost('rbac');
    const res = await post(`/v1/infra/hosts/${host}/drain`, {}, 'admin');
    assert.equal(res.statusCode, 403, res.body);
    assert.equal((await hostRow(host)).state, 'UP', 'the host moved anyway');
    assert.equal((await opsFor(host)).length, 0,
      'a refused request wrote an audit row, which would make the log unreadable');
  });

  test('a request with no CSRF token is refused before it reaches the operation', async () => {
    const host = await seedHost('csrf');
    const res = await app.inject({
      method: 'POST', url: `/v1/infra/hosts/${host}/drain`, payload: {},
      headers: { cookie: operatorCookie },
    });
    assert.ok(res.statusCode === 403 || res.statusCode === 401, `expected a refusal, got ${res.statusCode}`);
    assert.equal((await hostRow(host)).state, 'UP');
  });
});

describe('draining a host', () => {
  test('it withdraws idle devices and leaves a tenant mid-session alone', async () => {
    const host = await seedHost('drain');
    const ready = await seedDevice(host, 'READY');
    const busy = await seedDevice(host, 'SESSION_ACTIVE');

    const res = await post(`/v1/infra/hosts/${host}/drain`, { reason: 'kernel upgrade' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.result, 'succeeded');
    assert.equal(body.changed.devicesWithdrawn, 1);
    // The sentence has to say the expensive part out loud.
    assert.match(body.message, /still powered on and still costing money/);

    const states = Object.fromEntries((await q<{ id: string; state: string }>(
      'SELECT id, state::text AS state FROM devices WHERE host_id = $1', [host]))
      .map((d) => [d.id, d.state]));
    assert.equal(states[ready], 'QUARANTINED');
    assert.equal(states[busy], 'SESSION_ACTIVE', 'a tenant mid-session was evicted');

    const row = await hostRow(host);
    assert.equal(row.quarantine_source, 'operator');
    assert.equal(row.quarantine_reason, 'kernel upgrade');
  });

  test('DRAINING TWICE IS A NOOP, and does not rewrite why or when', async () => {
    const host = await seedHost('twice');
    await seedDevice(host, 'READY');
    await post(`/v1/infra/hosts/${host}/drain`, { reason: 'the first reason' });
    const first = await hostRow(host);

    const res = await post(`/v1/infra/hosts/${host}/drain`, { reason: 'a different reason' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().result, 'noop');
    assert.match(res.json().message, /already drained/);

    const second = await hostRow(host);
    assert.equal(second.quarantine_reason, 'the first reason',
      'the second press overwrote why the host was taken out of service');
    assert.equal(second.quarantined_at?.getTime(), first.quarantined_at?.getTime(),
      'the second press overwrote when it was taken out of service');
  });

  test('a host the reaper quarantined is REFUSED, with the reason spelled out', async () => {
    const host = await seedHost('silent');
    await q('SELECT quarantine_host($1, $2, $3)', [host, 'no heartbeat for 90s', 'reaper']);

    const res = await post(`/v1/infra/hosts/${host}/drain`, {});
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().result, 'failed');
    assert.match(res.json().message, /lifts itself on the next heartbeat/);

    // And the quarantine is still the self-healing kind.
    assert.equal((await hostRow(host)).quarantine_source, 'reaper');
  });

  test('an unknown host is a 404 and not an audit row', async () => {
    const res = await post(`/v1/infra/hosts/${randomUUID()}/drain`, {});
    assert.equal(res.statusCode, 404, res.body);
  });

  test('a malformed id is refused by the schema, not by the database', async () => {
    const res = await post('/v1/infra/hosts/not-a-uuid/drain', {});
    assert.equal(res.statusCode, 400, res.body);
  });

  test('a body with an unexpected field is refused rather than silently ignored', async () => {
    const host = await seedHost('extra');
    const res = await post(`/v1/infra/hosts/${host}/drain`, { reason: 'ok', force: true });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((await hostRow(host)).state, 'UP');
  });

  test('a reason with newlines in it is flattened, not stored as typed', async () => {
    const host = await seedHost('multiline');
    await post(`/v1/infra/hosts/${host}/drain`, { reason: 'line one\n\nline two   spaced' });
    assert.equal((await hostRow(host)).quarantine_reason, 'line one line two spaced');
  });
});

describe('resuming a host', () => {
  test('it restores exactly what the drain withdrew', async () => {
    const host = await seedHost('resume');
    const ready = await seedDevice(host, 'READY');
    const sick = await seedDevice(host, 'QUARANTINED');
    await post(`/v1/infra/hosts/${host}/drain`, {});

    const res = await post(`/v1/infra/hosts/${host}/resume`, {});
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().result, 'succeeded');
    assert.equal(res.json().changed.devicesRestored, 1);

    const states = Object.fromEntries((await q<{ id: string; state: string }>(
      'SELECT id, state::text AS state FROM devices WHERE host_id = $1', [host]))
      .map((d) => [d.id, d.state]));
    assert.equal(states[ready], 'READY');
    assert.equal(states[sick], 'QUARANTINED',
      'resuming a host laundered a device that was sick in its own right back into the pool');
    assert.equal((await hostRow(host)).state, 'UP');
  });

  test('RESUMING TWICE IS A NOOP', async () => {
    const host = await seedHost('resume-twice');
    await post(`/v1/infra/hosts/${host}/drain`, {});
    await post(`/v1/infra/hosts/${host}/resume`, {});
    const res = await post(`/v1/infra/hosts/${host}/resume`, {});
    assert.equal(res.json().result, 'noop');
    assert.match(res.json().message, /already in service/);
  });

  test('a host the reaper quarantined cannot be declared healthy from here', async () => {
    const host = await seedHost('resume-silent');
    await q('SELECT quarantine_host($1, $2, $3)', [host, 'no heartbeat for 90s', 'reaper']);
    const res = await post(`/v1/infra/hosts/${host}/resume`, {});
    assert.equal(res.json().result, 'failed');
    assert.match(res.json().message, /would not make one arrive/);
    assert.equal((await hostRow(host)).state, 'QUARANTINED');
  });
});

describe('retiring a host', () => {
  /**
   * THE CASE THIS EXISTS FOR. A laptop ran an agent once on 2026-08-29 and has not beaten since. A
   * fortnight later it was still a CRITICAL alert, still the reason the health rollup could never
   * read healthy, and still counted in "1 of 2 hosts powered on".
   *
   * A rollup that is always amber is one people stop reading, which is the one thing the health
   * board must not become.
   */
  const silentHost = async (name: string, minutesAgo: number) => {
    const id = await seedHost(name, { beatSecondsAgo: minutesAgo * 60 });
    return id;
  };

  test('a machine that has gone quiet leaves the fleet, and its devices go with it', async () => {
    const host = await silentHost('gone', 60);
    const ready = await seedDevice(host, 'READY');

    const res = await post(`/v1/infra/hosts/${host}/retire`, { reason: 'was a test laptop' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().result, 'succeeded');
    assert.match(res.json().message, /no longer part of the fleet/);

    const [row] = await q<{ retired_at: Date | null; retired_reason: string | null }>(
      'SELECT retired_at, retired_reason FROM hosts WHERE id = $1', [host]);
    assert.ok(row.retired_at);
    assert.equal(row.retired_reason, 'was a test laptop');

    const [device] = await q<{ state: string }>(
      'SELECT state::text AS state FROM devices WHERE id = $1', [ready]);
    assert.equal(device.state, 'QUARANTINED', 'a retired host left allocatable devices behind');
  });

  test('IT DISAPPEARS FROM THE FLEET, which is the whole point', async () => {
    const host = await silentHost('vanishing', 60);
    const before = await app.inject({ method: 'GET', url: '/v1/infra/overview', headers: { cookie: operatorCookie } });
    assert.ok(before.json().hosts.some((h: { id: string }) => h.id === host));

    await post(`/v1/infra/hosts/${host}/retire`, {});

    const after = await app.inject({ method: 'GET', url: '/v1/infra/overview', headers: { cookie: operatorCookie } });
    assert.ok(!after.json().hosts.some((h: { id: string }) => h.id === host),
      'a retired machine is still being counted, alerted on and shown');
  });

  test('NOTHING IS DELETED — the record survives', async () => {
    const host = await silentHost('remembered', 60);
    await post(`/v1/infra/hosts/${host}/retire`, {});

    // The row, its power history and the operation against it all still resolve. That is the whole
    // reason this is a timestamp and not a DELETE.
    const [row] = await q<{ hostname: string }>('SELECT hostname FROM hosts WHERE id = $1', [host]);
    assert.ok(row, 'the host row was deleted, taking its cost history with it');
    const ops = await opsFor(host);
    assert.ok(ops.length >= 1);
    assert.equal(ops.at(-1)!.action, 'retire-host');
  });

  test('a machine that is still reporting is REFUSED, and told to drain instead', async () => {
    const host = await seedHost('still-here', { beatSecondsAgo: 5 });
    const res = await post(`/v1/infra/hosts/${host}/retire`, {});
    assert.equal(res.json().result, 'failed');
    assert.match(res.json().message, /still reporting/);
    assert.match(res.json().message, /drain it/,
      'a refusal that does not say what to do instead sends somebody to SSH');

    const [row] = await q<{ retired_at: Date | null }>(
      'SELECT retired_at FROM hosts WHERE id = $1', [host]);
    assert.equal(row.retired_at, null);
  });

  test('a machine with a tenant on it is REFUSED', async () => {
    const host = await silentHost('busy-but-quiet', 60);
    const device = await seedDevice(host, 'SESSION_ACTIVE');
    await q(
      `INSERT INTO sessions (org_id, device_id, state, requested, constraints, region)
       VALUES ($1, $2, 'ACTIVE', '{}'::jsonb, '{}'::jsonb, $3)`, [orgId, device, REGION]);

    const res = await post(`/v1/infra/hosts/${host}/retire`, {});
    assert.equal(res.json().result, 'failed');
    assert.match(res.json().message, /must not be a way to take a device out from under somebody/);
  });

  test('RETIRING TWICE IS A NOOP', async () => {
    const host = await silentHost('twice-retired', 60);
    await post(`/v1/infra/hosts/${host}/retire`, {});
    const res = await post(`/v1/infra/hosts/${host}/retire`, {});
    assert.equal(res.json().result, 'noop');
    assert.match(res.json().message, /already retired/);
  });
});

describe('every operation is written down', () => {
  test('who, what, against what, and how it went', async () => {
    const host = await seedHost('audit');
    await seedDevice(host, 'READY');
    await post(`/v1/infra/hosts/${host}/drain`, { reason: 'for the log' });
    await post(`/v1/infra/hosts/${host}/resume`, {});

    const rows = await opsFor(host);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.action, r.result]),
      [['drain-host', 'succeeded'], ['resume-host', 'succeeded']]);
    // The EMAIL, not just the id — an audit trail that becomes unreadable when an account is deleted
    // is not an audit trail.
    assert.equal(rows[0].actor_email, OPERATOR);
    assert.equal(rows[0].params.reason, 'for the log');
    assert.match(rows[0].detail ?? '', /1 device\(s\) withdrawn/);
  });

  test('a REFUSED operation is logged too, and as `failed` rather than not at all', async () => {
    const host = await seedHost('audit-refused');
    await q('SELECT quarantine_host($1, $2, $3)', [host, 'silence', 'reaper']);
    await post(`/v1/infra/hosts/${host}/drain`, {});

    const rows = await opsFor(host);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, 'failed');
    assert.match(rows[0].detail ?? '', /already quarantined for silence/);
  });

  test('a noop is logged as a noop, so the log answers "did anything change"', async () => {
    const host = await seedHost('audit-noop');
    await post(`/v1/infra/hosts/${host}/drain`, {});
    await post(`/v1/infra/hosts/${host}/drain`, {});
    assert.deepEqual((await opsFor(host)).map((r) => r.result), ['succeeded', 'noop']);
  });

  test('the history filters narrow to one host, one action and one outcome', async () => {
    const host = await seedHost('filters');
    await post(`/v1/infra/hosts/${host}/drain`, {});
    await post(`/v1/infra/hosts/${host}/drain`, {});

    const read = async (qs: string) => (await app.inject({
      method: 'GET', url: `/v1/infra/operations?${qs}`, headers: { cookie: operatorCookie },
    })).json().operations as Array<{ action: string; result: string; target: { id: string } }>;

    const mine = await read(`targetKind=host&target=${host}`);
    assert.equal(mine.length, 2);
    assert.ok(mine.every((o) => o.target.id === host));

    const ok = await read(`targetKind=host&target=${host}&outcome=ok`);
    assert.equal(ok.length, 2, 'a noop counts as success — nothing went wrong');

    const bad = await read(`targetKind=host&target=${host}&outcome=bad`);
    assert.equal(bad.length, 0);

    const byAction = await read(`targetKind=host&target=${host}&action=resume-host`);
    assert.equal(byAction.length, 0);
  });

  test('the facets offer only what this farm has actually done', async () => {
    const host = await seedHost('facets');
    await post(`/v1/infra/hosts/${host}/drain`, {});
    const res = await app.inject({
      method: 'GET', url: '/v1/infra/operations/facets', headers: { cookie: operatorCookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    const { actions, actors } = res.json();
    assert.ok(actions.includes('drain-host'));
    assert.ok(actors.some((a: { email: string }) => a.email === OPERATOR));
  });
});

describe('the page reports what it can do', () => {
  test('draining is declared available now that a route exists behind it', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/infra/overview', headers: { cookie: operatorCookie },
    });
    const { capabilities } = res.json();
    assert.equal(capabilities.drain, true);
    // And the two that still have no route stay false, so the console draws no button for them.
    assert.equal(capabilities.power, false);
    assert.equal(capabilities.services, false);
  });

  test('a host carries the session count a confirmation dialog has to name', async () => {
    const host = await seedHost('impact');
    await seedDevice(host, 'READY');
    const res = await app.inject({
      method: 'GET', url: '/v1/infra/overview', headers: { cookie: operatorCookie },
    });
    const h = res.json().hosts.find((x: { id: string }) => x.id === host);
    assert.ok(h, 'the seeded host is missing from the overview');
    assert.equal(typeof h.sessions.active, 'number');
  });
});
