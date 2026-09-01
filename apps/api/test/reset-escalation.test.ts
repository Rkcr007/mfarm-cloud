/**
 * A reset that will never succeed has to STOP being retried — migration 032, plan §11.
 *
 * WHAT WAS WRONG. The heartbeat re-offers every `CLEANING` device on every beat, which is what makes
 * a missed reset self-healing and is also an unbounded retry loop: a device whose reset always
 * throws is offered again ten seconds later, forever, silently out of the pool. §11 asks every
 * recovery mechanism for a retry count, a timeout, a backoff and a terminal state; this one had none.
 *
 * ---------------------------------------------------------------- what these tests are careful about
 *
 * **An attempt is not a heartbeat, and the first test is the one that proves it.** Counting an
 * attempt per offer would make the budget a function of beat frequency — six beats a minute burns a
 * three-attempt budget in thirty seconds — so `a fresh reset is not an attempt` asserts that a
 * device which entered CLEANING a moment ago survives a reap with its budget untouched. If that
 * test ever passes for the wrong reason the rest of this file is measuring nothing.
 *
 * **Every count is read back independently.** The expected values here are LITERALS (0, 1, 2, 3),
 * never a second read of the column under test, and the ledger in `device_reset_attempts` is
 * counted separately from the counter on `devices` — so a bug that updated one and not the other
 * fails rather than agreeing with itself.
 *
 * **Time is moved by backdating, not by sleeping.** The timeout stays realistic (60s) so it is
 * genuinely load-bearing; the clock is advanced by writing older timestamps. A test that set the
 * timeout to zero would pass while proving the timeout does nothing.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';
// Stated rather than inherited. These are the defaults, and naming them here means a change to the
// default is a visible decision instead of a silent re-scoping of every assertion below.
process.env.MAX_RESET_ATTEMPTS = '3';
process.env.RESET_ATTEMPT_TIMEOUT_MS = '60000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue, CSRF_HEADER } from '../src/users.ts';
import { allocate, release, reap, resetComplete, clearResetEscalation } from '../src/allocator.ts';

const REGION = `reset-esc-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'correct horse battery staple';
const ADMIN = `esc-admin-${randomUUID()}@example.test`;
const MEMBER = `esc-member-${randomUUID()}@example.test`;

let app: FastifyInstance;
let orgId: string;
let hostId: string;
let workerToken: string;

const auth = (k: string) => ({ authorization: `Bearer ${k}` });

interface Session { cookie: string; csrf: string }

async function signIn(email: string): Promise<Session> {
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, `sign-in for ${email} failed: ${res.body}`);
  const raw = Array.isArray(res.headers['set-cookie'])
    ? res.headers['set-cookie'][0] : String(res.headers['set-cookie']);
  return {
    cookie: `mfarm_session=${cookieValue(raw.replace(/; /g, '; '), 'mfarm_session')}`,
    csrf: res.json().csrfToken as string,
  };
}

function as(
  s: Session, method: string, url: string, payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: s.cookie, [CSRF_HEADER]: s.csrf },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** A device this file owns, in READY. Scoped to this file's own host and region. */
async function seedDevice(): Promise<string> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO devices (host_id, org_id, region, platform, tier, model, os_version, state, capabilities)
       VALUES ($1, NULL, $2, 'android', 'cuttlefish', 'cf_x86_64', '15', 'READY',
               '["screen-stream","input-datachannel","snapshot-reset"]'::jsonb)
       RETURNING id`,
      [hostId, REGION],
    );
    return rows[0].id as string;
  });
}

/** Allocate then release, which is the only honest way to reach CLEANING with a real fence. */
async function intoCleaning(): Promise<{ deviceId: string; fence: number }> {
  const a = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
  assert.ok(a.deviceId, 'the fixture device should have been allocatable');
  await release(orgId, a.sessionId, 'test');
  return { deviceId: a.deviceId!, fence: a.fence! };
}

/**
 * Move this device's clock back, so the next reap sees a reset that has been outstanding too long.
 *
 * Both columns, because `count_stalled_resets` measures from `last_reset_attempt_at` once an attempt
 * exists and from `updated_at` before that — backdating only one would work for the first attempt
 * and silently stop working for the second.
 */
async function ageBy(deviceId: string, seconds: number): Promise<void> {
  await withSystem((c) => c.query(
    `UPDATE devices
        SET updated_at = updated_at - make_interval(secs => $2),
            last_reset_attempt_at = last_reset_attempt_at - make_interval(secs => $2)
      WHERE id = $1`,
    [deviceId, seconds],
  ));
}

/** The counter on the device row. */
async function budget(deviceId: string) {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT state::text AS state, reset_attempts, reset_escalated_at, reset_escalation_reason
         FROM devices WHERE id = $1`,
      [deviceId],
    );
    return {
      state: rows[0].state as string,
      attempts: Number(rows[0].reset_attempts),
      escalated: rows[0].reset_escalated_at !== null,
      reason: rows[0].reset_escalation_reason as string | null,
    };
  });
}

/**
 * The LEDGER, counted independently of the counter above.
 *
 * This is the second observation the file's header promises: `reset_attempts` and the rows in
 * `device_reset_attempts` are written by the same statement but are different facts, and a bug that
 * bumped the counter without recording the attempt would otherwise pass every assertion here.
 */
async function ledger(deviceId: string) {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT attempt, outcome, detail, occurred_at
         FROM device_reset_attempts WHERE device_id = $1
        ORDER BY occurred_at, attempt`,
      [deviceId],
    );
    return rows as { attempt: number; outcome: string; detail: string | null; occurred_at: Date }[];
  });
}

/** One reaper tick, aged so the outstanding reset is over its timeout. */
async function tickAfterTimeout(deviceId: string): Promise<void> {
  await ageBy(deviceId, 61);
  await reap();
}

before(async () => {
  app = await buildServer({ logger: false, rateLimitMax: 10_000, loginRateLimitMax: 10_000 });
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code, name) VALUES ($1, 'Reset Escalation')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ($1, 'Reset Escalation', 50) RETURNING id`,
      [`reset-esc-${randomUUID().slice(0, 8)}`],
    )).rows[0].id;
  });
  await upsertUser(ADMIN, PASSWORD, orgId, 'admin');
  await upsertUser(MEMBER, PASSWORD, orgId, 'member');

  const r = await app.inject({
    method: 'POST', url: '/v1/workers/register',
    headers: { 'x-worker-registration-token': 'test-registration-secret' },
    payload: {
      protocolVersion: 1, hostname: `reset-esc-host-${randomUUID().slice(0, 8)}`, region: REGION,
      endpoint: 'wss://worker-esc.example:8443', cores: 64, memoryMb: 262144,
      capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
      devices: [],
    },
  });
  // 201: registration CREATES a host. Asserted exactly rather than as `< 300`, because a
  // registration that started answering 200 would mean it had stopped creating one.
  assert.equal(r.statusCode, 201, `worker registration failed: ${r.body}`);
  workerToken = r.json().workerToken;
  hostId = r.json().hostId;
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
    // BY REGION, not by id. A run that died before `hostId` was assigned still left a host behind,
    // and the region delete below then fails its foreign key — which reports as a cleanup error
    // that buries whatever actually went wrong. The region is unique to this file, so this is
    // still scoped: node:test runs files against one shared database.
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

/** Each test gets its own device, so no test inherits another's budget. */
async function freshCleaningDevice(): Promise<{ deviceId: string; fence: number }> {
  await withSystem((c) => c.query('DELETE FROM devices WHERE host_id = $1', [hostId]));
  await seedDevice();
  return intoCleaning();
}

describe('the reset budget', () => {
  test('a fresh reset is not an attempt — a heartbeat is not permission to retry', async () => {
    const { deviceId } = await freshCleaningDevice();

    // No ageing: the device entered CLEANING a moment ago. Reap several times, which is what a
    // heartbeat-driven counter would have counted as several attempts.
    await reap();
    await reap();
    await reap();

    const b = await budget(deviceId);
    assert.equal(b.state, 'CLEANING');
    assert.equal(b.attempts, 0,
      'three ticks inside the timeout must count nothing — otherwise the budget is a function of tick rate');
    assert.equal(b.escalated, false);
    assert.deepEqual(await ledger(deviceId), [], 'and nothing should have been recorded either');
  });

  test('a reset that stays outstanding too long is counted, once per timeout', async () => {
    const { deviceId } = await freshCleaningDevice();

    await tickAfterTimeout(deviceId);
    assert.equal((await budget(deviceId)).attempts, 1);

    // The SECOND tick happens immediately, with no ageing. This is §11's backoff: the timeout has
    // to elapse AGAIN, measured from the attempt just counted, so a device cannot burn its whole
    // budget in three consecutive ticks a few milliseconds apart.
    await reap();
    assert.equal((await budget(deviceId)).attempts, 1,
      'a tick straight after an attempt must not count a second one');

    await tickAfterTimeout(deviceId);
    assert.equal((await budget(deviceId)).attempts, 2);

    const rows = await ledger(deviceId);
    assert.equal(rows.length, 2, 'the ledger and the counter must agree, having been read separately');
    assert.deepEqual(rows.map((r) => r.attempt), [1, 2]);
    assert.deepEqual(rows.map((r) => r.outcome), ['timed-out', 'timed-out']);
  });

  test('the count never exceeds the budget, and exhausting it escalates', async () => {
    const { deviceId } = await freshCleaningDevice();

    for (let i = 0; i < 3; i++) await tickAfterTimeout(deviceId);

    const b = await budget(deviceId);
    assert.equal(b.attempts, 3, 'exactly the budget, not one more');
    assert.equal(b.escalated, true);
    assert.match(b.reason ?? '', /3 attempts/,
      'the escalation has to say why, or the console can only report that something is wrong');

    // STILL CLEANING, deliberately. Escalated is a CONDITION, not a state: the device is dirty and
    // must stay unallocatable, and QUARANTINED would also stop the resets that could still fix it.
    assert.equal(b.state, 'CLEANING');
  });

  test('reaps after exhaustion create no further attempts — escalated is terminal, not a slower loop', async () => {
    const { deviceId } = await freshCleaningDevice();
    for (let i = 0; i < 3; i++) await tickAfterTimeout(deviceId);
    const atEscalation = await ledger(deviceId);

    // Ten more ticks, each aged well past the timeout. Under the old behaviour this is exactly the
    // shape that retried forever.
    for (let i = 0; i < 10; i++) await tickAfterTimeout(deviceId);

    const b = await budget(deviceId);
    assert.equal(b.attempts, 3, 'the budget must not keep climbing after it is spent');
    const rows = await ledger(deviceId);
    assert.equal(rows.length, atEscalation.length,
      'and no further rows: an escalated device is not being retried more slowly, it is not being retried');
  });

  test('every attempt is recorded with its own timestamp, and the last one says it escalated', async () => {
    const { deviceId } = await freshCleaningDevice();
    const before = new Date();
    for (let i = 0; i < 3; i++) await tickAfterTimeout(deviceId);

    const rows = await ledger(deviceId);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.attempt), [1, 2, 3]);
    assert.deepEqual(rows.map((r) => r.outcome), ['timed-out', 'timed-out', 'escalated']);
    for (const r of rows) {
      assert.ok(r.occurred_at instanceof Date, 'an attempt with no time answers none of §11');
      assert.ok(r.occurred_at >= before, 'and the time has to be this run, not a default');
      assert.ok(r.detail, 'each row says what happened in words, not only as a status');
    }
    // Distinct times, so the history is an ordering rather than three rows stamped identically.
    assert.equal(new Set(rows.map((r) => r.occurred_at.getTime())).size, 3);
  });
});

describe('the heartbeat and an escalated device', () => {
  test('an escalated device is no longer offered a reset', async () => {
    const { deviceId } = await freshCleaningDevice();

    // While budget remains it IS offered — the self-healing that made re-offering worth having.
    const before = await app.inject({
      method: 'POST', url: '/v1/workers/heartbeat', headers: auth(workerToken),
    });
    assert.equal(before.statusCode, 200);
    assert.ok(
      (before.json().resets ?? []).some((r: { deviceId: string }) => r.deviceId === deviceId),
      'a CLEANING device with budget left must still be offered a reset',
    );

    for (let i = 0; i < 3; i++) await tickAfterTimeout(deviceId);

    // Ten beats after exhaustion. The offer is what an agent turns into a reset attempt, so this is
    // the assertion that the loop is actually broken rather than merely counted.
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: 'POST', url: '/v1/workers/heartbeat', headers: auth(workerToken),
      });
      assert.equal(r.statusCode, 200);
      assert.ok(
        !(r.json().resets ?? []).some((x: { deviceId: string }) => x.deviceId === deviceId),
        'an escalated device must never appear in a reset offer',
      );
    }

    assert.equal((await budget(deviceId)).attempts, 3, 'and the beats did not count attempts either');
  });
});

describe('resuming recovery', () => {
  test('clearing an escalation restores the budget and the offers', async () => {
    const { deviceId } = await freshCleaningDevice();
    for (let i = 0; i < 3; i++) await tickAfterTimeout(deviceId);
    assert.equal((await budget(deviceId)).escalated, true);

    assert.equal(await clearResetEscalation(deviceId), true);

    const b = await budget(deviceId);
    assert.equal(b.escalated, false);
    assert.equal(b.attempts, 0, 'a cleared device starts its recovery over, not one attempt from the end');
    assert.equal(b.state, 'CLEANING', 'clearing resumes recovery; it does not pretend the device is clean');

    const beat = await app.inject({
      method: 'POST', url: '/v1/workers/heartbeat', headers: auth(workerToken),
    });
    assert.ok(
      (beat.json().resets ?? []).some((r: { deviceId: string }) => r.deviceId === deviceId),
      'the whole point of clearing is that the device is offered a reset again',
    );
  });

  test('clearing a device that was not escalated reports that, rather than reassuring', async () => {
    const { deviceId } = await freshCleaningDevice();
    assert.equal(await clearResetEscalation(deviceId), false);
  });

  test('a reset that finally succeeds clears the budget by itself', async () => {
    const { deviceId, fence } = await freshCleaningDevice();
    await tickAfterTimeout(deviceId);
    await tickAfterTimeout(deviceId);
    assert.equal((await budget(deviceId)).attempts, 2);

    assert.equal(await resetComplete(hostId, deviceId, fence), true);

    const b = await budget(deviceId);
    assert.equal(b.state, 'READY');
    // THE BUDGET IS PER RECOVERY, NOT PER LIFETIME. Carrying two failed attempts into the device's
    // next session would retire a healthy device after three bad days spread over a month.
    assert.equal(b.attempts, 0);
    assert.equal(b.escalated, false);

    const rows = await ledger(deviceId);
    assert.equal(rows.at(-1)?.outcome, 'succeeded',
      'the recovery that worked belongs in the history too, or the device looks permanently troubled');
  });
});

describe('the console can see it', () => {
  test('the escalated condition is on the device, with its reason and its attempt history', async () => {
    const { deviceId } = await freshCleaningDevice();
    for (let i = 0; i < 3; i++) await tickAfterTimeout(deviceId);

    const s = await signIn(ADMIN);

    const detail = await as(s, 'GET', `/v1/devices/${deviceId}`);
    assert.equal(detail.statusCode, 200);
    const d = detail.json().device;
    assert.equal(d.resetAttempts, 3);
    assert.ok(d.resetEscalation, 'a device needing a human must say so on its own record');
    assert.equal(d.resetEscalation.attempts, 3);
    assert.match(d.resetEscalation.reason, /3 attempts/);

    const history = await as(s, 'GET', `/v1/devices/${deviceId}/reset-attempts`);
    assert.equal(history.statusCode, 200);
    const attempts = history.json().attempts;
    assert.equal(attempts.length, 3);
    assert.equal(attempts[0].outcome, 'escalated', 'most recent first');
    for (const a of attempts) assert.ok(a.occurredAt, 'every attempt carries its timestamp');
  });

  test('a healthy device carries no escalation field at all', async () => {
    await withSystem((c) => c.query('DELETE FROM devices WHERE host_id = $1', [hostId]));
    const deviceId = await seedDevice();
    const s = await signIn(ADMIN);

    const list = await as(s, 'GET', `/v1/devices?region=${REGION}`);
    assert.equal(list.statusCode, 200);
    const row = list.json().devices.find((x: { id: string }) => x.id === deviceId);
    assert.ok(row, 'the fixture device should be listed');
    assert.equal('resetEscalation' in row, false,
      'a healthy fleet\'s payload is unchanged, so no existing reader gains a shape to handle');
  });

  test('an admin can resume recovery through the console, and a member cannot', async () => {
    const { deviceId } = await freshCleaningDevice();
    for (let i = 0; i < 3; i++) await tickAfterTimeout(deviceId);

    const member = await signIn(MEMBER);
    const refused = await as(member, 'POST', `/v1/devices/${deviceId}/clear-reset-escalation`);
    assert.equal(refused.statusCode, 403);
    assert.equal((await budget(deviceId)).escalated, true,
      'the refusal has to be real, not just a status code');

    const admin = await signIn(ADMIN);
    const ok = await as(admin, 'POST', `/v1/devices/${deviceId}/clear-reset-escalation`);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().cleared, true);
    assert.equal((await budget(deviceId)).escalated, false);

    // Clicking twice says so rather than reporting another success.
    const again = await as(admin, 'POST', `/v1/devices/${deviceId}/clear-reset-escalation`);
    assert.equal(again.json().cleared, false);
  });

  test('a worker token cannot clear an escalation it caused', async () => {
    const { deviceId } = await freshCleaningDevice();
    for (let i = 0; i < 3; i++) await tickAfterTimeout(deviceId);

    // The heartbeat is what exhausted the budget. Letting that principal clear it would rebuild the
    // unbounded loop one indirection further away, where nobody would find it.
    const r = await app.inject({
      method: 'POST', url: `/v1/devices/${deviceId}/clear-reset-escalation`, headers: auth(workerToken),
    });
    assert.equal(r.statusCode, 403);
    assert.equal((await budget(deviceId)).escalated, true);
  });
});

describe('what must not have changed', () => {
  test('get-or-create still hands out a device, and a released one still reaches CLEANING', async () => {
    await withSystem((c) => c.query('DELETE FROM devices WHERE host_id = $1', [hostId]));
    await seedDevice();

    const a = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
    assert.ok(a.deviceId, 'allocation is the load-bearing path everything else in the suite sits on');
    assert.equal(a.state, 'ALLOCATING');

    assert.equal(await release(orgId, a.sessionId, 'test'), true);
    assert.equal((await budget(a.deviceId!)).state, 'CLEANING');
    assert.equal((await budget(a.deviceId!)).attempts, 0, 'a fresh CLEANING device owes nothing');
  });

  test('an escalated device is not allocatable, and does not stop a healthy one being allocated', async () => {
    await withSystem((c) => c.query('DELETE FROM devices WHERE host_id = $1', [hostId]));
    const sick = await seedDevice();
    const healthy = await seedDevice();

    // Drive `sick` into escalation via a real allocate/release, then confirm the OTHER device is
    // still handed out. Capacity loss to one bad device must not read as a farm outage.
    const a = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
    await release(orgId, a.sessionId, 'test');
    const stuck = a.deviceId!;
    for (let i = 0; i < 3; i++) await tickAfterTimeout(stuck);
    assert.equal((await budget(stuck)).escalated, true);

    const b = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
    assert.ok(b.deviceId, 'the healthy device must still be allocatable');
    assert.notEqual(b.deviceId, stuck, 'an escalated device must never be handed to a tenant');
    assert.ok([sick, healthy].includes(b.deviceId!));
    await release(orgId, b.sessionId, 'test');
  });
});
