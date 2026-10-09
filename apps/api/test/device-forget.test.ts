/**
 * Forgetting a device that is gone — migration 069, ADR-0052.
 *
 * WHAT THIS FILE IS TRYING HARD TO CATCH, in order of how bad it would be:
 *
 *   A HIDDEN DEVICE THAT CAN STILL BE ALLOCATED. The rule every read uses is not `retired_at IS
 *   NULL`; a device is hidden only while it is also in a state the allocator never hands out. The
 *   last block below moves a forgotten device to READY behind the feature's back and asserts it is
 *   on the list again.
 *
 *   A REMOVAL BY SOMEBODY WHOSE DEVICE IT IS NOT. A shared device is the fleet's, so forgetting it
 *   takes the fleet operator; a dedicated one takes its own org's admin. Each is tried by the other.
 *
 *   A DEVICE THAT STAYS FORGOTTEN AFTER IT CAME BACK. Its agent seeing it again is the evidence that
 *   "gone" was wrong — through the real registration and heartbeat routes, not through a fixture
 *   that sets the column.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'device-forget-test-secret';
process.env.HOST_HOURLY_COST = '65';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue } from '../src/users.ts';
import { fleetSnapshot, hostSnapshots } from '../src/infra/snapshot.ts';

let app: FastifyInstance;
let orgA: string, orgB: string;
let ownHost: string, sharedHost: string;

const REGION = `forget-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'correct horse battery staple';
const OPERATOR = `op-${randomUUID()}@example.test`;
const ADMIN_A = `admin-a-${randomUUID()}@example.test`;
const MEMBER_A = `member-a-${randomUUID()}@example.test`;
const ADMIN_B = `admin-b-${randomUUID()}@example.test`;

type Who = { cookie: string; csrf: string };
const who: Record<string, Who> = {};

const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  withSystem(async (c) => (await c.query<T>(sql, params)).rows);

async function signIn(email: string): Promise<Who> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, `sign-in failed: ${res.body}`);
  return {
    cookie: `mfarm_session=${cookieValue(String(res.headers['set-cookie']), 'mfarm_session')}`,
    csrf: res.json().csrfToken as string,
  };
}

const post = (as: string, url: string, payload: Record<string, unknown> = {}) => app.inject({
  method: 'POST', url, payload, headers: { cookie: who[as].cookie, 'x-mfarm-csrf': who[as].csrf },
});
const get = (as: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: who[as].cookie } });

/** A device, shared or dedicated to org A, in a chosen state. */
async function seedDevice(host: string, state: string, opts: { dedicated?: boolean; source?: string } = {}) {
  const [row] = await q<{ id: string }>(
    `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id,
                          org_id, quarantine_source, quarantine_reason, quarantined_at)
     VALUES ($1,$2,'android','physical','Phone Test','14',$3,'[]'::jsonb,$4,$5,$6,
             CASE WHEN $6::text IS NULL THEN NULL ELSE 'adb keeps dropping' END,
             CASE WHEN $6::text IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [host, REGION, state, `d-${randomUUID().slice(0, 8)}`, opts.dedicated ? orgA : null, opts.source ?? null]);
  return row.id;
}

const row = async (id: string) => (await q<{ state: string; retired_at: Date | null; retired_reason: string | null;
                                              quarantine_source: string | null }>(
  'SELECT state::text AS state, retired_at, retired_reason, quarantine_source FROM devices WHERE id = $1', [id]))[0];

/** What one caller's fleet list says about one device: in it, forgotten, or neither. */
async function listed(as: string, id: string): Promise<'fleet' | 'forgotten' | 'absent'> {
  const res = await get(as, '/v1/devices');
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { devices: Array<{ id: string }>; forgotten: Array<{ id: string }> };
  if (body.devices.some((d) => d.id === id)) return 'fleet';
  return body.forgotten.some((d) => d.id === id) ? 'forgotten' : 'absent';
}

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  await q(`INSERT INTO regions (code,name) VALUES ($1,'Forget Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
  const org = async (name: string) => (await q<{ id: string }>(
    `INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,$2,50) RETURNING id`,
    [`forget-${randomUUID()}`, name]))[0].id;
  orgA = await org('Forget A');
  orgB = await org('Forget B');

  await upsertUser(OPERATOR, PASSWORD, orgA, 'admin');
  await upsertUser(ADMIN_A, PASSWORD, orgA, 'admin');
  await upsertUser(MEMBER_A, PASSWORD, orgA, 'member');
  await upsertUser(ADMIN_B, PASSWORD, orgB, 'admin');
  await q('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]);
  who.operator = await signIn(OPERATOR);
  who.adminA = await signIn(ADMIN_A);
  who.memberA = await signIn(MEMBER_A);
  who.adminB = await signIn(ADMIN_B);

  const host = async (name: string, org: string | null) => (await q<{ id: string }>(
    `INSERT INTO hosts (region, hostname, state, protocol_version, org_id, last_heartbeat_at, cores, memory_mb)
     VALUES ($1,$2,'UP',2,$3, now(), 8, 16384) RETURNING id`, [REGION, `${name}-${REGION}`, org]))[0].id;
  ownHost = await host('own', orgA);
  sharedHost = await host('shared', null);
});

after(async () => {
  await q('DELETE FROM sessions WHERE region = $1', [REGION]);
  await q('DELETE FROM hosts WHERE region = $1', [REGION]);
  for (const org of [orgA, orgB]) {
    await q('DELETE FROM user_sessions WHERE org_id = $1', [org]);
    await q('DELETE FROM memberships WHERE org_id = $1', [org]);
    await q('DELETE FROM orgs WHERE id = $1', [org]);
  }
  await q('DELETE FROM regions WHERE code = $1', [REGION]);
  await app.close();
  await closePools();
});

describe('forgetting a device that is gone', () => {
  test('it leaves the fleet list, is listed as forgotten, and its page still answers', async () => {
    const id = await seedDevice(ownHost, 'OFFLINE', { dedicated: true });
    assert.equal(await listed('adminA', id), 'fleet');

    const res = await post('adminA', `/v1/devices/${id}/forget`, { reason: '  sold\n it ' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().forgotten, true);
    assert.match(res.json().detail, /comes back by itself if its agent ever sees it again/);

    assert.equal(await listed('adminA', id), 'forgotten');
    const gone = (await get('adminA', '/v1/devices')).json().forgotten.find((d: { id: string }) => d.id === id);
    assert.equal(gone.reason, 'sold it', 'the reason is stored as one line');
    // What the console names a device from. Without these the list reads "Unprofiled device" for
    // every row, which was the first thing its own test said.
    assert.equal(gone.tier, 'physical');
    assert.equal(gone.model, 'Phone Test');
    assert.equal(gone.dedicated, true);
    assert.ok(Date.now() - Date.parse(gone.forgottenAt) < 60_000);

    // Not deleted: a session that ran on it links here, and this is where it is restored from.
    const detail = await get('adminA', `/v1/devices/${id}`);
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().device.forgotten.reason, 'sold it');
    assert.equal(detail.json().device.dedicated, true);
  });

  test('a device a health check withdrew can be forgotten too', async () => {
    const id = await seedDevice(ownHost, 'QUARANTINED', { dedicated: true, source: 'health' });
    assert.equal((await post('adminA', `/v1/devices/${id}/forget`)).json().forgotten, true);
    assert.equal((await row(id)).state, 'QUARANTINED', 'forgetting must not touch the state');
  });

  test('each device that is NOT gone is refused, with its own reason', async () => {
    const cases: Array<[string, string | undefined, RegExp]> = [
      ['READY', undefined, /Its agent can see this device right now/],
      ['SESSION_ACTIVE', undefined, /Somebody is using this device/],
      ['RESERVED', undefined, /Somebody is using this device/],
      // Out because its HOST is away. It returns when the host does, so "gone" is not known yet.
      ['QUARANTINED', 'host', /returns when the host\s+does/],
      ['CLEANING', undefined, /in the middle of resetting or recovering/],
    ];
    for (const [state, source, sentence] of cases) {
      const id = await seedDevice(ownHost, state, { dedicated: true, source });
      const res = await post('adminA', `/v1/devices/${id}/forget`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().forgotten, false, `a ${state} device was forgotten`);
      assert.match(res.json().detail, sentence, `${state}: ${res.json().detail}`);
      assert.equal((await row(id)).retired_at, null, `${state}: refused, and marked anyway`);
      assert.equal(await listed('adminA', id), 'fleet');
    }
  });

  test('forgetting twice changes nothing the second time', async () => {
    const id = await seedDevice(ownHost, 'OFFLINE', { dedicated: true });
    await post('adminA', `/v1/devices/${id}/forget`, { reason: 'first' });
    const again = await post('adminA', `/v1/devices/${id}/forget`, { reason: 'second' });
    assert.equal(again.json().forgotten, false);
    assert.match(again.json().detail, /already forgotten/);
    assert.equal((await row(id)).retired_reason, 'first', 'a second click rewrote why it was forgotten');
  });
});

describe('whose device it is decides who may forget it', () => {
  test('a member of the org cannot; an admin of ANOTHER org cannot even see it', async () => {
    const id = await seedDevice(ownHost, 'OFFLINE', { dedicated: true });
    assert.equal((await post('memberA', `/v1/devices/${id}/forget`)).statusCode, 403);
    assert.equal((await post('adminB', `/v1/devices/${id}/forget`)).statusCode, 404,
      'another tenant learned that this dedicated device exists');
    assert.equal((await row(id)).retired_at, null);
  });

  test('a SHARED device is the fleet\'s: an org admin cannot forget it, a fleet operator can', async () => {
    const id = await seedDevice(sharedHost, 'OFFLINE');
    const refused = await post('adminA', `/v1/devices/${id}/forget`);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.match(refused.json().error.message, /fleet operator/i);
    assert.equal(await listed('adminB', id), 'fleet', 'one tenant removed a device from every other tenant\'s fleet');

    const res = await post('operator', `/v1/devices/${id}/forget`);
    assert.equal(res.json().forgotten, true, res.body);
    // Every tenant sees the same thing about a shared device, including that it was forgotten.
    assert.equal(await listed('adminB', id), 'forgotten');
  });

  test('restoring follows the same rule', async () => {
    const id = await seedDevice(sharedHost, 'OFFLINE');
    await post('operator', `/v1/devices/${id}/forget`);
    assert.equal((await post('adminA', `/v1/devices/${id}/restore`)).statusCode, 403);
    assert.ok((await row(id)).retired_at, 'a 403 that restored it anyway');
  });
});

describe('a forgotten device comes back', () => {
  test('when a person restores it — in the state it was in, not a guessed one', async () => {
    const id = await seedDevice(ownHost, 'QUARANTINED', { dedicated: true, source: 'operator' });
    await post('adminA', `/v1/devices/${id}/forget`);

    const res = await post('adminA', `/v1/devices/${id}/restore`);
    assert.equal(res.json().restored, true, res.body);
    assert.match(res.json().detail, /does not make\s+it available/);
    assert.equal(await listed('adminA', id), 'fleet');
    const after = await row(id);
    assert.equal(after.state, 'QUARANTINED', 'restoring laundered a quarantine into availability');
    assert.equal(after.quarantine_source, 'operator');

    const again = await post('adminA', `/v1/devices/${id}/restore`);
    assert.equal(again.json().restored, false);
  });

  const PHONE_CAPS = ['input-datachannel', 'install-reset', 'app-install', 'logcat', 'screenshot', 'ui-hierarchy'];
  const register = async (hostname: string, localIds: string[]) => {
    const res = await app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { 'x-worker-registration-token': 'device-forget-test-secret' },
      payload: {
        protocolVersion: 2, hostname, region: REGION, endpoint: 'mfarm+tunnel:/dp',
        cores: 8, memoryMb: 16384, capabilities: PHONE_CAPS,
        devices: localIds.map((localId) => ({
          localId, platform: 'android', tier: 'physical', model: 'KB2001', osVersion: '14', capabilities: PHONE_CAPS,
        })),
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { hostId: string; workerToken: string; deviceIds: Record<string, string> };
  };
  const beat = (token: string, away: Record<string, string>) => app.inject({
    method: 'POST', url: '/v1/workers/heartbeat',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { protocolVersion: 2, capabilities: PHONE_CAPS, devices: {}, away },
  });

  test('when its agent sees it again on a heartbeat', async () => {
    const reg = await register(`beat-${randomUUID().slice(0, 6)}`, ['p1']);
    const id = reg.deviceIds.p1;
    // Unplugged: the agent still knows the phone and says it cannot see it.
    assert.equal((await beat(reg.workerToken, { p1: 'it is not on USB' })).statusCode, 200);
    assert.equal((await row(id)).state, 'OFFLINE', 'the fixture never went away, so nothing below is a return');

    assert.equal((await post('operator', `/v1/devices/${id}/forget`)).json().forgotten, true);
    // Still unplugged, another beat: nothing about it has changed, so it stays forgotten.
    await beat(reg.workerToken, { p1: 'it is not on USB' });
    assert.equal(await listed('operator', id), 'forgotten');

    // Plugged back in.
    await beat(reg.workerToken, {});
    const back = await row(id);
    assert.equal(back.state, 'READY');
    assert.equal(back.retired_at, null, 'it is available again and still marked as forgotten');
    assert.equal(await listed('operator', id), 'fleet');
  });

  test('when a registration lists it as present — and not when it lists everything but', async () => {
    const hostname = `reg-${randomUUID().slice(0, 6)}`;
    const id = (await register(hostname, ['p1'])).deviceIds.p1;
    // The agent restarts without the phone: the registration no longer has it.
    await register(hostname, []);
    assert.equal((await row(id)).state, 'OFFLINE');
    await post('operator', `/v1/devices/${id}/forget`);

    await register(hostname, ['some-other-phone']);
    assert.ok((await row(id)).retired_at, 'a registration that did not mention it un-forgot it');
    assert.equal(await listed('operator', id), 'forgotten');

    await register(hostname, ['p1', 'some-other-phone']);
    assert.equal((await row(id)).retired_at, null);
    assert.equal(await listed('operator', id), 'fleet');
  });

  test('a broken phone that is plugged back in returns still quarantined', async () => {
    const hostname = `broken-${randomUUID().slice(0, 6)}`;
    const id = (await register(hostname, ['p1'])).deviceIds.p1;
    await q(`UPDATE devices SET state = 'QUARANTINED', quarantine_source = 'health',
                    quarantine_reason = 'adb keeps dropping', quarantined_at = now() WHERE id = $1`, [id]);
    await post('operator', `/v1/devices/${id}/forget`);

    await register(hostname, ['p1']);
    const back = await row(id);
    assert.equal(back.retired_at, null, 'its agent can see it, and it is still hidden');
    assert.equal(back.state, 'QUARANTINED', 'forget, unplug, replug: a health quarantine laundered into READY');
  });
});

describe('hidden is never allocatable', () => {
  test('a forgotten device that becomes READY by ANY path is on the list again', async () => {
    const id = await seedDevice(ownHost, 'OFFLINE', { dedicated: true });
    await post('adminA', `/v1/devices/${id}/forget`);
    assert.equal(await listed('adminA', id), 'forgotten');

    // Behind the feature's back, the way a path nobody thought of would do it: the state moves and
    // `retired_at` is left exactly as it was.
    await q(`UPDATE devices SET state = 'READY' WHERE id = $1`, [id]);
    assert.ok((await row(id)).retired_at, 'the fixture cleared the mark, so the next line proves nothing');
    assert.equal(await listed('adminA', id), 'fleet',
      'a device the allocator can hand out is hidden from the fleet list');
    assert.equal((await get('adminA', `/v1/devices/${id}`)).json().device.forgotten, undefined);
  });

  test('a recovery is refused on a forgotten device, and allowed once it is restored', async () => {
    const id = await seedDevice(ownHost, 'QUARANTINED', { dedicated: true, source: 'operator' });
    await post('adminA', `/v1/devices/${id}/forget`);

    const refused = await post('adminA', `/v1/devices/${id}/release-quarantine`);
    assert.equal(refused.json().released, false);
    assert.match(refused.json().detail, /was forgotten/);
    assert.equal((await row(id)).state, 'QUARANTINED', 'a reset was authorised on a device somebody said was gone');

    await post('adminA', `/v1/devices/${id}/restore`);
    const released = await post('adminA', `/v1/devices/${id}/release-quarantine`);
    assert.equal(released.json().released, true, released.body);
  });
});

describe('a forgotten device is in none of the counts', () => {
  test('the fleet\'s totals, its host\'s, and the tenant\'s view of the host', async () => {
    const id = await seedDevice(sharedHost, 'OFFLINE');
    const hostDevices = async () =>
      (await hostSnapshots(() => false)).find((h) => h.id === sharedHost)!.devices;
    const tenantHostTotal = async () =>
      (await get('operator', '/v1/hosts')).json().hosts.find((h: { id: string }) => h.id === sharedHost).devices.total;

    const fleet0 = await fleetSnapshot();
    const host0 = await hostDevices();
    const tenant0 = await tenantHostTotal();

    await post('operator', `/v1/devices/${id}/forget`);

    const fleet1 = await fleetSnapshot();
    assert.equal(fleet1.devices.total, fleet0.devices.total - 1);
    assert.equal(fleet1.devices.offline, fleet0.devices.offline - 1);
    const host1 = await hostDevices();
    assert.equal(host1.total, host0.total - 1);
    assert.equal(host1.offline, host0.offline - 1);
    assert.equal(await tenantHostTotal(), tenant0 - 1);

    await post('operator', `/v1/devices/${id}/restore`);
    assert.deepEqual((await fleetSnapshot()).devices, fleet0.devices);
  });
});
