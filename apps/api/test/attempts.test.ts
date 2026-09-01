/**
 * ONE LOGICAL USER REQUEST IS ONE USER ATTEMPT — migration 033, plan §33/§34/§35.
 *
 * The rule: a user asks for a device once. When the emulator goes unhealthy, adb drops, or a handset
 * falls off the end of its cable, MFARM recovers and carries on — and that recovery is the FARM's
 * cost. It is recorded, it is attributable to a device, and it never becomes a second user attempt.
 *
 * ---------------------------------------------------------------- how these tests avoid agreeing with themselves
 *
 * **The invariant is tested against the DATABASE, not against the counter that reports it.** The
 * decisive test here inserts a second `origin = 'user'` row directly and requires it to be REFUSED.
 * A test that only asserted `counts().userAttempts === 1` would pass just as happily against an
 * implementation that never wrote a second row for a different reason, and would keep passing after
 * somebody added a caller that did.
 *
 * **Rows are counted two ways.** `counts()` runs on the tenant pool under RLS; the assertions below
 * also read the raw table on the system pool. A bug in the RLS policy would make one of those
 * disagree with the other, which is exactly the failure a single reader cannot see.
 *
 * **Nothing here asserts on `usage()` by re-deriving it.** The metering assertions use literal
 * device-seconds ingested by this file, so "an infra retry did not change what the user consumed"
 * is a comparison against a number the farm did not compute.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey } from '../src/auth.ts';
import { allocate, release, reap } from '../src/allocator.ts';
import { ingest, usage } from '../src/metering.ts';
import { counts, deviceReliability, openUserAttempt, recordInfraRetry, closeAttempt } from '../src/attempts.ts';

const REGION = `attempts-${randomUUID().slice(0, 8)}`;

let app: FastifyInstance;
let orgId: string;
let apiKey: string;
let hostId: string;
let workerToken: string;

const auth = (k: string) => ({ authorization: `Bearer ${k}` });
const WINDOW = () => [new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000)] as const;

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

/** Wipe this file's sessions and attempts, so each test counts only its own. */
async function reset(): Promise<void> {
  await withSystem(async (c) => {
    await c.query('DELETE FROM metering_events WHERE org_id = $1', [orgId]);
    // session_attempts cascades from sessions, which is itself worth relying on rather than
    // deleting by hand — a stale attempt outliving its session would be a real bug.
    await c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
  });
  await seedDevice();
}

/** The raw rows, on the system pool — the second, independent reading. */
async function rawAttempts(sessionId?: string) {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT a.session_id, a.attempt, a.origin, a.device_id, a.outcome, a.reason,
              a.started_at, a.ended_at
         FROM session_attempts a
         JOIN sessions s ON s.id = a.session_id
        WHERE s.org_id = $1 AND ($2::uuid IS NULL OR a.session_id = $2)
        ORDER BY a.started_at, a.attempt`,
      [orgId, sessionId ?? null],
    );
    return rows as {
      session_id: string; attempt: number; origin: string; device_id: string | null;
      outcome: string | null; reason: string | null; started_at: Date; ended_at: Date | null;
    }[];
  });
}

/** A device incident from the worker, exactly as the agent sends one. */
async function reportIncident(
  deviceId: string, sessionId: string | null, reason: string, eventId = randomUUID(),
) {
  // `/workers/events`, not `/workers/heartbeat`. The agent batches incidents onto the events
  // endpoint precisely because they are buffered and re-sent on reconnect — an incident is most
  // worth having in the window where the connection was bad.
  const r = await app.inject({
    method: 'POST', url: '/v1/workers/events', headers: auth(workerToken),
    payload: {
      incidents: [{
        eventId, deviceId, reason,
        ...(sessionId ? { sessionId } : {}),
        occurredAt: new Date().toISOString(),
      }],
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().incidents;
}

before(async () => {
  app = await buildServer({ logger: false, rateLimitMax: 10_000 });
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code, name) VALUES ($1, 'Attempts')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ($1, 'Attempts', 50) RETURNING id`,
      [`attempts-${randomUUID().slice(0, 8)}`],
    )).rows[0].id;
  });
  apiKey = (await createApiKey(orgId)).plaintext;

  const r = await app.inject({
    method: 'POST', url: '/v1/workers/register',
    headers: { 'x-worker-registration-token': 'test-registration-secret' },
    payload: {
      protocolVersion: 1, hostname: `attempts-host-${randomUUID().slice(0, 8)}`, region: REGION,
      endpoint: 'wss://worker-attempts.example:8443', cores: 64, memoryMb: 262144,
      capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
      devices: [],
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  workerToken = r.json().workerToken;
  hostId = r.json().hostId;
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM metering_events WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
    await c.query('DELETE FROM api_keys WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

describe('one user request', () => {
  test('increments the user attempt exactly once, and names the device that served it', async () => {
    await reset();
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id: sessionId, deviceId } = created.json().session;

    const rows = await rawAttempts(sessionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, 'user');
    assert.equal(rows[0].attempt, 1);
    assert.equal(rows[0].device_id, deviceId, 'an attempt with no device answers no §2 question');
    assert.equal(rows[0].outcome, null, 'still running is a real state, not missing data');

    // The second, independent reading — through RLS on the tenant pool.
    assert.deepEqual(await counts(orgId, ...WINDOW()), {
      userAttempts: 1, infraRetries: 0, deviceFailures: 0, successfulAttempts: 0,
    });
  });

  test('a SECOND user attempt on one session is refused by the database, not merely uncounted', async () => {
    await reset();
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    const sessionId = created.json().session.id;

    // THE DECISIVE TEST. `counts()` returning 1 would also be true of an implementation that simply
    // never wrote a second row; this requires the invariant to be structural, so a future caller
    // that would have charged a user twice fails loudly at the moment it is written.
    await assert.rejects(
      () => openUserAttempt(sessionId),
      /duplicate key|session_attempts_one_user_idx/,
      'the partial unique index is what makes "one user attempt" true',
    );
    assert.equal((await counts(orgId, ...WINDOW())).userAttempts, 1);
  });

  test('a QUEUED session opens no attempt — nothing was attempted', async () => {
    await reset();
    // No devices at all, so the session queues rather than allocating.
    await withSystem((c) => c.query('DELETE FROM devices WHERE host_id = $1', [hostId]));
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    assert.equal(created.statusCode, 202, 'no capacity means queued, which is a success');
    assert.deepEqual(await rawAttempts(created.json().session.id), [],
      'a request waiting for capacity has not attempted anything on a device yet');
  });
});

describe('an infrastructure retry', () => {
  test('is recorded, and does NOT increment the user attempt', async () => {
    await reset();
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    const { id: sessionId, deviceId } = created.json().session;

    // adb dropped mid-session. The agent recovers; the user asked once and is still asking once.
    const results = await reportIncident(deviceId, sessionId, 'adb-failure');
    assert.equal(results[0].accepted, true);

    const rows = await rawAttempts(sessionId);
    assert.equal(rows.length, 2, 'the failed attempt and the retry that followed it');
    assert.deepEqual(rows.map((r) => r.origin), ['user', 'infra-retry']);
    assert.deepEqual(rows.map((r) => r.attempt), [1, 2]);

    // The failed one is CLOSED and says why, against the device that caused it.
    assert.equal(rows[0].outcome, 'infrastructure-failure');
    assert.equal(rows[0].reason, 'adb-failure');
    assert.equal(rows[0].device_id, deviceId);
    assert.ok(rows[0].ended_at, 'a closed attempt has an end time');
    // The retry is open — the farm is still trying.
    assert.equal(rows[1].outcome, null);

    const c = await counts(orgId, ...WINDOW());
    assert.equal(c.userAttempts, 1, 'THE RULE: the farm absorbed its own recovery');
    assert.equal(c.infraRetries, 1, 'and it is visible, not hidden');
  });

  test('a device-health incident is a DEVICE failure, distinguishable from the rest', async () => {
    await reset();
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    const { id: sessionId, deviceId } = created.json().session;

    await reportIncident(deviceId, sessionId, 'device-unresponsive');

    const rows = await rawAttempts(sessionId);
    assert.equal(rows[0].outcome, 'device-failure',
      'the DEVICE went bad, which is 024\'s device-health class and a different fact from the farm around it');

    const c = await counts(orgId, ...WINDOW());
    assert.equal(c.deviceFailures, 1);
    assert.equal(c.userAttempts, 1);

    // And it is attributable, which is what makes "how often does this device fail" answerable.
    const rel = await deviceReliability(orgId, ...WINDOW());
    const row = rel.find((d) => d.deviceId === deviceId);
    assert.ok(row, 'the device that failed must appear in the reliability read');
    assert.equal(row.failures, 1);
  });

  test('a re-sent incident does not open a second retry', async () => {
    await reset();
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    const { id: sessionId, deviceId } = created.json().session;

    // The agent buffers incidents and flushes on reconnect, so one pulled cable arriving many times
    // is the DESIGNED case. Thirty retries recorded for it would make the farm look far worse than
    // it is — and would be a number nobody could ever reconcile against reality.
    const eventId = randomUUID();
    for (let i = 0; i < 5; i++) await reportIncident(deviceId, sessionId, 'usb-failure', eventId);

    assert.equal((await rawAttempts(sessionId)).length, 2, 'one failure, one retry, five deliveries');
    assert.equal((await counts(orgId, ...WINDOW())).infraRetries, 1);
  });

  test('an incident with NO session retries nothing — it disrupted no request', async () => {
    await reset();
    const deviceId = await withSystem(async (c) =>
      (await c.query('SELECT id FROM devices WHERE host_id = $1 LIMIT 1', [hostId])).rows[0].id);

    await reportIncident(deviceId, null, 'low-battery');
    assert.deepEqual(await rawAttempts(), [],
      'a device that fell over while idle cost no user anything');
  });

  test('a retry is refused for anything that is not an infrastructure failure', async () => {
    await reset();
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    const sessionId = created.json().session.id;

    // §34: only infrastructure failures may trigger automatic recovery. Retrying a failed test
    // manufactures a false green, so the function refuses rather than trusting its callers.
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => recordInfraRetry(sessionId, 'succeeded' as any, 'nope'),
      /not an infrastructure failure/,
    );
  });
});

describe('a successful retry', () => {
  test('is still ONE user attempt, and the session ends as one request', async () => {
    await reset();
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    const { id: sessionId, deviceId } = created.json().session;

    // Fail twice, recover twice, then finish.
    await reportIncident(deviceId, sessionId, 'adb-failure');
    await reportIncident(deviceId, sessionId, 'appium-failure');
    await release(orgId, sessionId, 'client_request');
    await reap();   // the sweep closes whatever the session left open

    const rows = await rawAttempts(sessionId);
    assert.equal(rows.length, 3, 'two failures and the attempt that finished the job');
    assert.deepEqual(rows.map((r) => r.origin), ['user', 'infra-retry', 'infra-retry']);
    assert.equal(rows[2].outcome, 'succeeded');
    assert.ok(rows.every((r) => r.outcome !== null), 'the sweep leaves nothing open on an ended session');

    const c = await counts(orgId, ...WINDOW());
    assert.equal(c.userAttempts, 1, 'THE RULE, after two recoveries: still one request');
    assert.equal(c.infraRetries, 2);
    assert.equal(c.successfulAttempts, 1);
  });

  test('the sweep closes an attempt whatever ended the session, including a TTL expiry', async () => {
    await reset();
    const a = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
    await openUserAttempt(a.sessionId);
    // Expire it the way the reaper's own clock would, rather than by calling the release path —
    // this is the end path that has no application-code close, which is why the sweep exists.
    await withSystem((c) => c.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.sessionId]));
    await reap();

    const rows = await rawAttempts(a.sessionId);
    assert.equal(rows[0].outcome, 'succeeded',
      'a lease that ran out is the product working — the farm delivered a device');
    assert.equal(rows[0].reason, 'timeout');
  });
});

describe('what must not have changed', () => {
  test('metered usage is untouched by a retry — the user consumed what the user consumed', async () => {
    await reset();
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    const { id: sessionId, deviceId } = created.json().session;

    // A literal quantity, so the assertion below compares against a number this file chose rather
    // than against anything the farm derived.
    await ingest(hostId, [{
      eventId: randomUUID(), sessionId, deviceId, kind: 'device_seconds',
      quantity: 42, occurredAt: new Date(),
    }]);
    await reportIncident(deviceId, sessionId, 'adb-failure');

    assert.equal((await usage(orgId, ...WINDOW())).device_seconds, 42,
      'attempts are not billing: an infra retry must not move a metered quantity in either direction');
    assert.equal((await counts(orgId, ...WINDOW())).infraRetries, 1, 'and the retry did happen');
  });

  test('a test failure is the suite\'s word and never appears here', async () => {
    await reset();
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    const sessionId = created.json().session.id;

    // The farm cannot see an assertion fail (spec §13), so there is no outcome for one. The CHECK
    // is what guarantees this table can never start claiming otherwise.
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => closeAttempt(sessionId, 'test-failure' as any),
      /session_attempts_outcome_check|violates check constraint/,
    );
  });

  test('the usage endpoint reports both numbers, kept apart', async () => {
    await reset();
    const created = await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });
    const { id: sessionId, deviceId } = created.json().session;
    await ingest(hostId, [{
      eventId: randomUUID(), sessionId, deviceId, kind: 'device_seconds',
      quantity: 7, occurredAt: new Date(),
    }]);
    await reportIncident(deviceId, sessionId, 'adb-failure');

    const res = await app.inject({ method: 'GET', url: '/v1/account/usage', headers: auth(apiKey) });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.usage.device_seconds, 7);
    assert.equal(body.attempts.userAttempts, 1);
    assert.equal(body.attempts.infraRetries, 1);
    assert.ok(body.deviceReliability.some((d: { deviceId: string }) => d.deviceId === deviceId));
  });

  test('another org sees none of it', async () => {
    await reset();
    await app.inject({
      method: 'POST', url: '/v1/sessions', headers: auth(apiKey),
      payload: { region: REGION, platform: 'android' },
    });

    const other = await withSystem(async (c) =>
      (await c.query(`INSERT INTO orgs (slug, name) VALUES ($1,'Other') RETURNING id`,
                     [`attempts-other-${randomUUID().slice(0, 8)}`])).rows[0].id as string);
    try {
      // RLS, read through the tenant pool. `session_attempts` carries an org_id precisely so this
      // is a policy decision rather than a WHERE clause somebody could forget.
      assert.deepEqual(await counts(other, ...WINDOW()), {
        userAttempts: 0, infraRetries: 0, deviceFailures: 0, successfulAttempts: 0,
      });
    } finally {
      await withSystem((c) => c.query('DELETE FROM orgs WHERE id = $1', [other]));
    }
  });

  test('get-or-create and allocation still work exactly as before', async () => {
    await reset();
    const a = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
    assert.ok(a.deviceId);
    assert.equal(a.state, 'ALLOCATING');
    assert.equal(await release(orgId, a.sessionId, 'client_request'), true);
    // Allocating directly through the allocator opens no attempt — the HTTP handler is what
    // represents a user request. Asserted so the boundary is deliberate rather than incidental.
    assert.deepEqual(await rawAttempts(a.sessionId), []);
  });
});
