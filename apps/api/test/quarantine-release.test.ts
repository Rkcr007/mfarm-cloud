/**
 * Releasing a quarantine authorises a recovery ATTEMPT — migration 035, ADR-0024, plan §30.
 *
 * WHAT THIS FILE IS DEFENDING. §30 asks for a `[Recover Device]` action, and the obvious
 * implementation of it is one statement:
 *
 *     UPDATE devices SET state = 'READY' WHERE id = $1;
 *
 * That is a button which puts a broken handset back into the allocation pool on an operator's
 * optimism. The device failed its health checks; a human deciding to look at it is not evidence
 * that anything about it has changed. So the first test in this file is the one the rest exist to
 * protect: **release does not make a device available.** If that ever passes for the wrong reason,
 * nothing else here is measuring anything.
 *
 * ---------------------------------------------------------------- what these tests are careful about
 *
 * **The verdict is asserted from the device row, never from the response body.** A route that
 * returned `{ released: true, state: 'PREPARING' }` while writing READY would satisfy every
 * assertion made against its own JSON. Every state claim below is read back out of Postgres.
 *
 * **A failed recovery is checked for the NEW reason, not merely for being quarantined again.**
 * Preserving the reason a device went away the first time and losing the reason it could not come
 * back is exactly backwards, and it is the failure a person triaging the device would actually hit.
 *
 * **Time is moved by backdating, not by sleeping** — the same rule `reset-escalation.test.ts` set.
 * The recovery timeout stays realistic (60s here) so it is genuinely load-bearing.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';
// Stated rather than inherited, so a change to the default is a visible decision instead of a
// silent re-scoping of the timeout assertions below.
process.env.RECOVERY_TIMEOUT_MS = '60000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue, CSRF_HEADER } from '../src/users.ts';
import { allocate, reap, quarantineDevice, releaseDeviceQuarantine } from '../src/allocator.ts';

const REGION = `quar-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'correct horse battery staple';
const ADMIN = `quar-admin-${randomUUID()}@example.test`;
const MEMBER = `quar-member-${randomUUID()}@example.test`;

let app: FastifyInstance;
let orgId: string;
let hostId: string;
let workerToken: string;
let hostname: string;
let adminId: string;

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

/** A device this file owns, READY and allocatable. One per test — see `freshDevice`. */
async function seedDevice(localId = 'cf-1'): Promise<string> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO devices (host_id, org_id, region, platform, tier, model, os_version, state,
                            capabilities, local_id)
       VALUES ($1, NULL, $2, 'android', 'cuttlefish', 'cf_x86_64', '15', 'READY',
               '["screen-stream","input-datachannel","snapshot-reset"]'::jsonb, $3)
       RETURNING id`,
      [hostId, REGION, localId],
    );
    return rows[0].id as string;
  });
}

async function freshDevice(): Promise<string> {
  await withSystem((c) => c.query('DELETE FROM devices WHERE host_id = $1', [hostId]));
  return seedDevice();
}

/** The device row, read back independently of whatever a route said it did. */
async function row(deviceId: string) {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT state::text AS state, fence, quarantined_at, quarantine_reason, quarantine_source,
              recovery_started_at, recovery_released_by, recovery_from_reason, quarantined_from
         FROM devices WHERE id = $1`,
      [deviceId],
    );
    return {
      state: rows[0].state as string,
      fence: Number(rows[0].fence),
      quarantinedAt: rows[0].quarantined_at as Date | null,
      reason: rows[0].quarantine_reason as string | null,
      source: rows[0].quarantine_source as string | null,
      recovering: rows[0].recovery_started_at !== null,
      releasedBy: rows[0].recovery_released_by as string | null,
      fromReason: rows[0].recovery_from_reason as string | null,
      quarantinedFrom: rows[0].quarantined_from as string | null,
    };
  });
}

/**
 * The AUDIT, read separately from the device row.
 *
 * The same second-observation rule `reset-escalation.test.ts` follows for its ledger: the row and
 * the log are written by the same function but are different facts, and a bug that moved the device
 * without recording why would otherwise agree with itself.
 */
async function log(deviceId: string) {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT event, source, reason, actor_id, actor_email, from_reason, detail, fence
         FROM device_quarantine_log WHERE device_id = $1
        -- By append order. occurred_at alone is not one: two rows written in a single
        -- transaction share it to the microsecond, and a uuid tiebreaker orders them differently
        -- on different reads — which is how this file first failed, intermittently, claiming a
        -- device had been released before it was quarantined.
        ORDER BY seq`,
      [deviceId],
    );
    return rows as Array<{
      event: string; source: string | null; reason: string | null; actor_id: string | null;
      actor_email: string | null; from_reason: string | null;
      detail: Record<string, unknown> | null; fence: string | null;
    }>;
  });
}

const beat = () => app.inject({
  method: 'POST', url: '/v1/workers/heartbeat',
  headers: { authorization: `Bearer ${workerToken}` },
  payload: { protocolVersion: 2 },
});

/**
 * The host comes back and re-asserts its fleet.
 *
 * Its OWN worker token on the registration header, under its OWN hostname — the two conditions
 * `resolveCredential` checks for a re-registration (migration 023). A fleet secret would also work
 * and would test something weaker: the path an agent actually takes when its capability
 * fingerprint changes is this one.
 */
async function reregister(devices: unknown[]): Promise<LightMyRequestResponse> {
  const res = await app.inject({
    method: 'POST', url: '/v1/workers/register',
    headers: { 'x-worker-registration-token': workerToken },
    payload: {
      protocolVersion: 1, hostname, region: REGION,
      endpoint: 'wss://worker-quar.example:8443', cores: 64, memoryMb: 262144,
      capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'], devices,
    },
  });
  // EVERY REGISTRATION ISSUES A NEW TOKEN and retires the last one. Missing this is not a small
  // bookkeeping slip in a test: it turns every later `beat()` into a 401, which reads as "the
  // quarantine did not clear" — a failure in the code under test rather than in the fixture.
  if (res.statusCode === 201) workerToken = res.json().workerToken;
  return res;
}

const events = (payload: Record<string, unknown>, token = workerToken) => app.inject({
  method: 'POST', url: '/v1/workers/events',
  headers: { authorization: `Bearer ${token}` },
  payload,
});

before(async () => {
  app = await buildServer({ logger: false, rateLimitMax: 10_000, loginRateLimitMax: 10_000 });
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code, name) VALUES ($1, 'Quarantine Release')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ($1, 'Quarantine Release', 50) RETURNING id`,
      [`quar-${randomUUID().slice(0, 8)}`],
    )).rows[0].id;
  });
  await upsertUser(ADMIN, PASSWORD, orgId, 'admin');
  await upsertUser(MEMBER, PASSWORD, orgId, 'member');
  adminId = await withSystem(async (c) =>
    (await c.query('SELECT id FROM users WHERE lower(email) = lower($1)', [ADMIN])).rows[0].id);

  hostname = `quar-host-${randomUUID().slice(0, 8)}`;
  const r = await app.inject({
    method: 'POST', url: '/v1/workers/register',
    headers: { 'x-worker-registration-token': 'test-registration-secret' },
    payload: {
      protocolVersion: 1, hostname, region: REGION,
      endpoint: 'wss://worker-quar.example:8443', cores: 64, memoryMb: 262144,
      capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
      devices: [],
    },
  });
  assert.equal(r.statusCode, 201, `worker registration failed: ${r.body}`);
  workerToken = r.json().workerToken;
  hostId = r.json().hostId;
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM devices WHERE host_id = $1', [hostId]);
    // By region rather than by id: a run that died before `hostId` was assigned still left a host
    // behind, and the region delete then fails its foreign key.
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

describe('release is not "make available"', () => {
  test('a released device is PREPARING, and nothing can allocate it', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'adb keeps dropping mid-session', 'health');

    assert.equal((await row(id)).state, 'QUARANTINED');

    const released = await releaseDeviceQuarantine(id, adminId);
    assert.equal(released, true);

    const after = await row(id);
    // THE ASSERTION THIS FILE EXISTS FOR. Read from the row, not from the route's own JSON.
    assert.equal(after.state, 'PREPARING',
      'releasing a quarantine must authorise an attempt, never mark the device available');
    assert.equal(after.recovering, true);
    assert.equal(after.releasedBy, adminId, 'the audit needs to know who authorised it');
    assert.equal(after.fromReason, 'adb keeps dropping mid-session',
      'the recovery has to remember what it is recovering from');
    // The quarantine stamp is gone, because the device is no longer quarantined — it is trying.
    assert.equal(after.reason, null);
    assert.equal(after.source, null);

    // And the allocator will not touch it. This is the property the state exists to have.
    const a = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
    assert.equal(a.deviceId, null, 'a PREPARING device must not be allocatable');
    assert.equal(a.state, 'QUEUED');
  });

  test('the fence moves, so a worker that was mid-allocation cannot confirm its way in', async () => {
    const id = await freshDevice();
    const before = (await row(id)).fence;
    await quarantineDevice(id, 'frozen', 'health');
    await releaseDeviceQuarantine(id, adminId);
    assert.equal((await row(id)).fence, before + 1,
      'a recovery is a new claim on the device; a stale confirmation must not satisfy it');
  });

  test('releasing a device that is not quarantined changes nothing, and says so', async () => {
    const id = await freshDevice();
    assert.equal(await releaseDeviceQuarantine(id, adminId), false);
    assert.equal((await row(id)).state, 'READY');
  });
});

describe('the preparation flow is the one that already exists', () => {
  test('the heartbeat offers the reset, flagged as a recovery', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'usb dropped', 'health');
    await releaseDeviceQuarantine(id, adminId);

    const res = await beat();
    assert.equal(res.statusCode, 200);
    const offer = (res.json().resets ?? []).find((r: { deviceId: string }) => r.deviceId === id);
    assert.ok(offer, 'a PREPARING device must be offered a reset — the offer IS the preparation');
    assert.equal(offer.recovery, true, 'and it must be flagged, or the agent reports no health check');
    assert.equal(offer.fence, (await row(id)).fence);
    assert.equal(offer.sessionId, undefined,
      'a recovery has no session behind it — the fence bump is what guarantees that');
  });

  test('an ordinary CLEANING reset is NOT flagged, so nothing about that path changed', async () => {
    const id = await freshDevice();
    await withSystem((c) => c.query(`UPDATE devices SET state = 'CLEANING' WHERE id = $1`, [id]));
    const offer = ((await beat()).json().resets ?? [])
      .find((r: { deviceId: string }) => r.deviceId === id);
    assert.ok(offer);
    assert.equal(offer.recovery, undefined,
      'absent, not false — an older agent must read the payload it always read');
  });
});

describe('only a passing health check earns AVAILABLE', () => {
  test('a passing check makes it READY, and the audit records the whole story', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'battery at 4%', 'health');
    await releaseDeviceQuarantine(id, adminId);
    const { fence } = await row(id);

    const res = await events({
      recoveries: [{
        deviceId: id, fence, ok: true,
        health: { status: 'healthy', inputLatencyMs: 31 },
      }],
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().recoveries, [{ deviceId: id, accepted: true, state: 'READY' }]);

    const after = await row(id);
    assert.equal(after.state, 'READY');
    assert.equal(after.recovering, false, 'the recovery is over and must not still read as running');
    assert.equal(after.reason, null);

    const events_ = await log(id);
    assert.deepEqual(events_.map((e) => e.event), ['quarantined', 'released', 'recovered']);
    assert.equal(events_[0].reason, 'battery at 4%');
    assert.equal(events_[1].actor_email, ADMIN, 'who released it is the point of the audit');
    assert.equal(events_[1].from_reason, 'battery at 4%');
    assert.deepEqual(events_[2].detail, { status: 'healthy', inputLatencyMs: 31 },
      'the health result the host reported is the evidence — it has to be kept');
  });

  test('a failing check returns it to quarantine carrying the NEW reason', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'adb keeps dropping mid-session', 'health');
    await releaseDeviceQuarantine(id, adminId);
    const { fence } = await row(id);

    const res = await events({
      recoveries: [{
        deviceId: id, fence, ok: false,
        reason: 'the device reset but its health check reports offline: device-disconnected',
        health: { status: 'offline', reasonCode: 'device-disconnected' },
      }],
    });
    assert.deepEqual(res.json().recoveries, [{ deviceId: id, accepted: true, state: 'QUARANTINED' }]);

    const after = await row(id);
    assert.equal(after.state, 'QUARANTINED');
    assert.equal(after.source, 'health');
    assert.equal(after.reason,
      'the device reset but its health check reports offline: device-disconnected',
      'the new failure, not the old one — the old one is what the operator already looked at');
    assert.equal(after.recovering, false);

    const events_ = await log(id);
    assert.deepEqual(events_.map((e) => e.event), ['quarantined', 'released', 'recovery-failed']);
    assert.equal(events_[2].from_reason, 'adb keeps dropping mid-session',
      'and the audit still carries what it was trying to recover from');
  });

  test('a bare reset confirmation fails the recovery closed, naming the agent', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'frozen', 'health');
    await releaseDeviceQuarantine(id, adminId);
    const { fence } = await row(id);

    // Exactly what an agent older than the recovery gate sends: it performed the reset it was
    // offered and has no health result to report.
    const res = await events({ resets: [{ deviceId: id, fence }] });
    assert.deepEqual(res.json().resets, [{ deviceId: id, accepted: false }]);

    const after = await row(id);
    assert.equal(after.state, 'QUARANTINED',
      'a completed reset is not evidence a device is fit — that is the whole claim of the gate');
    assert.match(String(after.reason), /predates the recovery gate/,
      'and the reason must say what to do about it rather than blaming the device');
  });

  test('another host cannot finish someone else’s recovery', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'frozen', 'health');
    await releaseDeviceQuarantine(id, adminId);
    const { fence } = await row(id);

    const other = await app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { 'x-worker-registration-token': 'test-registration-secret' },
      payload: {
        protocolVersion: 1, hostname: `quar-other-${randomUUID().slice(0, 8)}`, region: REGION,
        endpoint: 'wss://worker-other.example:8443', cores: 8, memoryMb: 16384,
        capabilities: ['screen-stream'], devices: [],
      },
    });
    const res = await events(
      { recoveries: [{ deviceId: id, fence, ok: true, health: { status: 'healthy' } }] },
      other.json().workerToken,
    );
    assert.deepEqual(res.json().recoveries, [{ deviceId: id, accepted: false }]);
    assert.equal((await row(id)).state, 'PREPARING',
      'a worker naming another host’s device must change nothing (migration 008)');

    await withSystem((c) => c.query('DELETE FROM hosts WHERE id = $1', [other.json().hostId]));
  });

  test('a stale fence is refused', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'frozen', 'health');
    await releaseDeviceQuarantine(id, adminId);
    const { fence } = await row(id);
    const res = await events({
      recoveries: [{ deviceId: id, fence: fence - 1, ok: true, health: { status: 'healthy' } }],
    });
    assert.deepEqual(res.json().recoveries, [{ deviceId: id, accepted: false }]);
    assert.equal((await row(id)).state, 'PREPARING');
  });
});

describe('a recovery nobody finishes', () => {
  test('expires back into quarantine rather than sitting in PREPARING for ever', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'usb dropped', 'health');
    await releaseDeviceQuarantine(id, adminId);

    // Inside the window: the reaper must NOT give up on a recovery that is still running.
    const { recoveriesExpired } = await reap();
    assert.equal(recoveriesExpired, 0);
    assert.equal((await row(id)).state, 'PREPARING');

    await withSystem((c) => c.query(
      `UPDATE devices SET recovery_started_at = recovery_started_at - interval '61 seconds'
        WHERE id = $1`, [id]));
    const out = await reap();
    assert.equal(out.recoveriesExpired, 1);

    const after = await row(id);
    assert.equal(after.state, 'QUARANTINED');
    assert.equal(after.source, 'health');
    assert.match(String(after.reason), /did not confirm a recovery/);
    assert.deepEqual((await log(id)).map((e) => e.event),
      ['quarantined', 'released', 'recovery-failed']);
  });
});

describe('who may do this', () => {
  test('a member can neither quarantine nor release', async () => {
    const id = await freshDevice();
    const member = await signIn(MEMBER);

    const q = await as(member, 'POST', `/v1/devices/${id}/quarantine`, { reason: 'because' });
    assert.equal(q.statusCode, 403);
    assert.equal((await row(id)).state, 'READY');

    await quarantineDevice(id, 'frozen', 'health');
    const r = await as(member, 'POST', `/v1/devices/${id}/release-quarantine`);
    assert.equal(r.statusCode, 403);
    assert.equal((await row(id)).state, 'QUARANTINED');
  });

  test('an admin can, through the routes, and the response never claims availability', async () => {
    const id = await freshDevice();
    const admin = await signIn(ADMIN);

    const q = await as(admin, 'POST', `/v1/devices/${id}/quarantine`,
      { reason: 'screen does not wake' });
    assert.equal(q.statusCode, 200);
    assert.equal(q.json().quarantined, true);
    assert.equal((await row(id)).source, 'operator');

    const r = await as(admin, 'POST', `/v1/devices/${id}/release-quarantine`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().released, true);
    assert.equal(r.json().state, 'PREPARING',
      'the route names the state, because "released" on its own invites the wrong assumption');
    assert.equal((await row(id)).state, 'PREPARING');
  });

  test('a quarantine with no reason is refused', async () => {
    const id = await freshDevice();
    const admin = await signIn(ADMIN);
    const res = await as(admin, 'POST', `/v1/devices/${id}/quarantine`, { reason: '' });
    assert.equal(res.statusCode, 400,
      'a quarantine nobody can triage is worse than no quarantine');
  });

  test('the log reads back through the API, with the actor', async () => {
    const id = await freshDevice();
    const admin = await signIn(ADMIN);
    await as(admin, 'POST', `/v1/devices/${id}/quarantine`, { reason: 'screen does not wake' });
    await as(admin, 'POST', `/v1/devices/${id}/release-quarantine`);

    const res = await as(admin, 'GET', `/v1/devices/${id}/quarantine-log`);
    assert.equal(res.statusCode, 200);
    const [released, quarantined] = res.json().events;
    assert.equal(released.event, 'released');
    assert.equal(released.actor, ADMIN);
    assert.equal(released.fromReason, 'screen does not wake');
    assert.equal(quarantined.event, 'quarantined');
    assert.equal(quarantined.source, 'operator');
  });

  test('the device read carries why it is out of the pool', async () => {
    const id = await freshDevice();
    const admin = await signIn(ADMIN);
    await as(admin, 'POST', `/v1/devices/${id}/quarantine`, { reason: 'screen does not wake' });

    const one = (await as(admin, 'GET', `/v1/devices/${id}`)).json().device;
    assert.equal(one.state, 'QUARANTINED');
    assert.deepEqual(
      { reason: one.quarantine.reason, source: one.quarantine.source },
      { reason: 'screen does not wake', source: 'operator' },
    );

    const list = (await as(admin, 'GET', '/v1/devices')).json();
    const listed = list.devices.find((d: { id: string }) => d.id === id);
    assert.equal(listed.quarantine.reason, 'screen does not wake');
    assert.equal(list.devices.filter((d: { id: string }) => d.id === id).length, 1);
  });
});

describe('a quarantine a person made is not the farm’s to undo', () => {
  test('quarantining a device ends the session on it', async () => {
    const id = await freshDevice();
    const a = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
    assert.equal(a.deviceId, id);

    await quarantineDevice(id, 'the handset locked up mid-test', 'health');

    const session = await withSystem(async (c) => (await c.query(
      'SELECT state::text AS state, end_reason FROM sessions WHERE id = $1', [a.sessionId])).rows[0]);
    assert.equal(session.state, 'ENDED');
    assert.equal(session.end_reason, 'device_quarantined',
      'removing it from allocation is not enough while somebody is still driving it');
    assert.equal((await row(id)).state, 'QUARANTINED');
  });

  test('re-registering the host does not lift an operator quarantine', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'the screen is cracked', 'operator', adminId);

    // The whole host comes back and re-asserts its fleet, which is exactly what promotes a device
    // out of OFFLINE and out of a SILENCE quarantine.
    const r = await reregister([{
      localId: 'cf-1', platform: 'android', tier: 'cuttlefish', model: 'cf_x86_64',
      osVersion: '15', capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
    }]);
    assert.equal(r.statusCode, 201, r.body);

    const after = await row(id);
    assert.equal(after.state, 'QUARANTINED',
      'a registration is evidence the agent can SEE the device, not that the screen is mended');
    assert.equal(after.reason, 'the screen is cracked');
  });

  test('a device missing from a registration keeps its operator quarantine rather than going OFFLINE',
    async () => {
      const id = await freshDevice();
      await quarantineDevice(id, 'the screen is cracked', 'operator', adminId);

      // The phone is unplugged: the host re-registers with no devices at all.
      const r = await reregister([]);
      assert.equal(r.statusCode, 201, r.body);

      const after = await row(id);
      // OFFLINE would be honest about the cable and would also launder the quarantine: the next
      // good registration promotes OFFLINE straight back to READY.
      assert.equal(after.state, 'QUARANTINED');
      assert.equal(after.reason, 'the screen is cracked');
    });
});

describe('the host cascade still works, and now says why', () => {
  test('a silence quarantine stamps a reason and still clears on a beat', async () => {
    const id = await freshDevice();

    await withSystem((c) => c.query(
      `SELECT quarantine_host($1, 'no heartbeat for 90s', 'reaper')`, [hostId]));

    const quarantined = await row(id);
    assert.equal(quarantined.state, 'QUARANTINED');
    assert.equal(quarantined.source, 'host');
    assert.match(String(quarantined.reason), /its host was quarantined/,
      'a quarantined handset must say which problem it is — the host’s or its own');
    assert.equal(quarantined.quarantinedFrom, 'READY');
    assert.deepEqual((await log(id)).map((e) => e.event), ['quarantined']);

    // The beat is the disproof of the only thing a silence quarantine ever asserted (migration 016).
    const res = await beat();
    assert.equal(res.json().hostState, 'UP');

    const back = await row(id);
    assert.equal(back.state, 'READY', 'the 016 recovery must survive this migration');
    assert.equal(back.reason, null, 'and the stamp has to be cleared with it');
    assert.equal(back.source, null);
  });

  test('a host coming back does not lift an operator quarantine on one of its handsets', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'the screen is cracked', 'operator', adminId);
    await withSystem((c) => c.query(
      `SELECT quarantine_host($1, 'no heartbeat for 90s', 'reaper')`, [hostId]));
    await beat();

    const after = await row(id);
    assert.equal(after.state, 'QUARANTINED',
      'the cascade never touched it, so the cascade’s recovery must not either');
    assert.equal(after.source, 'operator');
    assert.equal(after.reason, 'the screen is cracked');
  });

  test('a recovery interrupted by a host quarantine resumes with a fresh clock', async () => {
    const id = await freshDevice();
    await quarantineDevice(id, 'usb dropped', 'health');
    await releaseDeviceQuarantine(id, adminId);
    assert.equal((await row(id)).state, 'PREPARING');

    await withSystem((c) => c.query(
      `SELECT quarantine_host($1, 'no heartbeat for 90s', 'reaper')`, [hostId]));
    assert.equal((await row(id)).quarantinedFrom, 'PREPARING');

    await beat();
    const back = await row(id);
    assert.equal(back.state, 'PREPARING', 'the recovery resumes rather than being lost');
    assert.equal(back.fromReason, 'usb dropped');
    // The window measures how long this host has been asked; it was gone for part of it, and
    // expiring the attempt for that would fail it for the one reason that is not about the device.
    assert.equal((await reap()).recoveriesExpired, 0);
  });
});
