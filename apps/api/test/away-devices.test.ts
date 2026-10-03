/**
 * A device its own agent cannot see is not available — D62, migration 067.
 *
 * Rebooting the OnePlus on the farm, the Fleet said AVAILABLE with a Start button and the headline
 * counted it ready, while the agent had already withdrawn `webdriver` for it. Device state reached the
 * control plane only at registration and through leases; the agent's health checks filed incidents
 * and changed nothing a scheduler reads. So a session started by hand from the console was handed a
 * phone that was not on its cable.
 *
 * Through the real register and heartbeat routes, and the tenant's own device list — the read the
 * console makes.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'away-devices-test-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { createApiKey } from '../src/auth.ts';

let app: FastifyInstance;
let key: string;
const REGION = `away-${randomUUID().slice(0, 8)}`;
const CAPS = ['input-datachannel', 'install-reset', 'app-install', 'logcat', 'screenshot', 'ui-hierarchy'];

const register = async (hostname: string, localIds: string[], away?: Record<string, string>, caps = CAPS) => {
  const res = await app.inject({
    method: 'POST', url: '/v1/workers/register',
    headers: { 'x-worker-registration-token': 'away-devices-test-secret' },
    payload: {
      protocolVersion: 2, hostname, region: REGION, endpoint: 'mfarm+tunnel:/dp', cores: 8, memoryMb: 16384,
      capabilities: caps, ...(away ? { away } : {}),
      devices: localIds.map((localId) => ({
        localId, platform: 'android', tier: 'physical', model: 'KB2001', osVersion: '14', capabilities: caps,
      })),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { hostId: string; workerToken: string };
};

const beat = async (token: string, body: Record<string, unknown>) => {
  const res = await app.inject({
    method: 'POST', url: '/v1/workers/heartbeat',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { protocolVersion: 2, capabilities: CAPS, devices: {}, ...body },
  });
  assert.equal(res.statusCode, 200, res.body);
};

const row = (hostId: string, localId: string) => withSystem(async (c) => (await c.query<{
  id: string; state: string; away_since: Date | null; away_reason: string | null }>(
  `SELECT id, state::text AS state, away_since, away_reason FROM devices WHERE host_id = $1 AND local_id = $2`,
  [hostId, localId])).rows[0]);

const listed = async (id: string) => {
  const res = await app.inject({ method: 'GET', url: '/v1/devices', headers: { authorization: `Bearer ${key}` } });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json().devices as Array<Record<string, unknown>>).find((d) => d.id === id);
};

before(async () => {
  app = await buildServer({ logger: false });
  const orgId = await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Away Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
    return (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Away',50) RETURNING id`,
      [`away-${randomUUID()}`])).rows[0].id as string;
  });
  key = (await createApiKey(orgId, 'test fixture — away-devices', { scope: 'full' })).plaintext;
});

after(async () => {
  await withSystem(async (c) => {
    await c.query('DELETE FROM device_quarantine_log WHERE device_id IN (SELECT id FROM devices WHERE region = $1)', [REGION]);
    await c.query('DELETE FROM devices WHERE region = $1', [REGION]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await app.close();
  await closePools();
});

describe('the agent says a phone is away', () => {
  test('it leaves the pool on the next beat, and the list says why', async () => {
    const { hostId, workerToken } = await register(`away-${randomUUID().slice(0, 6)}`, ['phone']);
    assert.equal((await row(hostId, 'phone')).state, 'READY');

    await beat(workerToken, { away: { phone: 'it is not on USB' } });
    const r = await row(hostId, 'phone');
    assert.equal(r.state, 'OFFLINE', 'a phone its agent cannot see was still AVAILABLE');
    assert.equal(r.away_reason, 'it is not on USB');

    const d = await listed(r.id);
    assert.equal(d?.state, 'OFFLINE');
    assert.deepEqual((d?.away as { reason: string })?.reason, 'it is not on USB', 'the console has nothing to say why');
  });

  test('and it comes back on the beat that stops naming it', async () => {
    const { hostId, workerToken } = await register(`back-${randomUUID().slice(0, 6)}`, ['phone']);
    await beat(workerToken, { away: { phone: 'it is not answering' } });
    await beat(workerToken, { away: {} });
    const r = await row(hostId, 'phone');
    assert.equal(r.state, 'READY');
    assert.equal(r.away_since, null);
    assert.equal((await listed(r.id))?.away, undefined);
  });

  /** An agent from before 067 sends no `away` at all. That must change nothing, in either direction. */
  test('a beat without the field changes nothing', async () => {
    const { hostId, workerToken } = await register(`old-${randomUUID().slice(0, 6)}`, ['phone']);
    await beat(workerToken, { away: { phone: 'it is not on USB' } });
    await beat(workerToken, {});
    assert.equal((await row(hostId, 'phone')).state, 'OFFLINE', 'silence is not "it is back"');
  });
});

describe('only what the beat took, it gives back', () => {
  /**
   * OFFLINE has other meanings. A device that lacks a capability the scheduler requires registers
   * OFFLINE, and "all mine are here" must not promote it into the pool.
   */
  test('a device offline for another reason is not promoted by "all here"', async () => {
    const { hostId, workerToken } = await register(`unsched-${randomUUID().slice(0, 6)}`, ['phone'], undefined,
      ['app-install', 'logcat']);
    assert.equal((await row(hostId, 'phone')).state, 'OFFLINE', 'fixture: an unschedulable device');
    await beat(workerToken, { away: {} });
    assert.equal((await row(hostId, 'phone')).state, 'OFFLINE');
  });

  test('a device in a session is left to the session', async () => {
    const { hostId, workerToken } = await register(`leased-${randomUUID().slice(0, 6)}`, ['phone']);
    await withSystem((c) => c.query(
      `UPDATE devices SET state = 'SESSION_ACTIVE' WHERE host_id = $1 AND local_id = 'phone'`, [hostId]));
    await beat(workerToken, { away: { phone: 'it is not on USB' } });
    const r = await row(hostId, 'phone');
    assert.equal(r.state, 'SESSION_ACTIVE', 'the beat yanked a device out of a lease');
    assert.equal(r.away_since, null);
  });

  test('a device on a quarantined host keeps the mark, and is given back after the release', async () => {
    const { hostId, workerToken } = await register(`held-${randomUUID().slice(0, 6)}`, ['phone']);
    await beat(workerToken, { away: { phone: 'it is not on USB' } });
    await withSystem((c) => c.query(`SELECT quarantine_host($1, 'maintenance', 'operator')`, [hostId]));
    await withSystem((c) => c.query('SELECT release_host_quarantine($1)', [hostId]));
    assert.equal((await row(hostId, 'phone')).state, 'OFFLINE', 'the release restores what it took');
    await beat(workerToken, { away: {} });
    assert.equal((await row(hostId, 'phone')).state, 'READY', 'and the beat gives back what it took');
  });
});

describe('registration carries the same word', () => {
  /**
   * The agent re-registers in place when `webdriver` moves — which is exactly when a phone leaves.
   * Without the map on registration that re-registration put an absent phone back to READY until
   * the next beat.
   */
  test('a phone away at registration registers OFFLINE', async () => {
    const name = `reg-away-${randomUUID().slice(0, 6)}`;
    const { hostId } = await register(name, ['phone']);
    await register(name, ['phone'], { phone: 'it is not on USB' });
    const r = await row(hostId, 'phone');
    assert.equal(r.state, 'OFFLINE');
    assert.equal(r.away_reason, 'it is not on USB');
  });

  test('and one it can see again sheds the mark', async () => {
    const name = `reg-back-${randomUUID().slice(0, 6)}`;
    const { hostId } = await register(name, ['phone'], { phone: 'it is not on USB' });
    await register(name, ['phone'], {});
    const r = await row(hostId, 'phone');
    assert.equal(r.state, 'READY');
    assert.equal(r.away_since, null);
  });
});

describe('a malformed map is not trusted', () => {
  test('entries that are not strings are dropped, and the beat still succeeds', async () => {
    const { hostId, workerToken } = await register(`junk-${randomUUID().slice(0, 6)}`, ['phone']);
    await beat(workerToken, { away: { phone: 42, other: { nested: true } } });
    assert.equal((await row(hostId, 'phone')).state, 'READY');
  });

  test('an array is not a map', async () => {
    const { hostId, workerToken } = await register(`array-${randomUUID().slice(0, 6)}`, ['phone']);
    await beat(workerToken, { away: ['phone'] });
    assert.equal((await row(hostId, 'phone')).state, 'READY');
  });
});
