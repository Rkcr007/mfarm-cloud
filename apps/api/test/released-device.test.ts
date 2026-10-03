/**
 * A device back in service carries no quarantine — D63, migration 068.
 *
 * Verifying D59 on the farm, the OnePlus read AVAILABLE on the Fleet with "its host was quarantined:
 * no heartbeat for 90s" in its holder column. `release_host_quarantine` — the console's Resume, and
 * since D59 a retired host registering — restored each device's state and left its quarantine
 * columns, where the farm's two other release paths clear them.
 *
 * Through the real drain and resume routes and the tenant's own device read.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'released-device-test-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue } from '../src/users.ts';
import { createApiKey } from '../src/auth.ts';

let app: FastifyInstance;
let cookie: string, csrf: string, key: string;
const REGION = `released-${randomUUID().slice(0, 8)}`;
const OPERATOR = `op-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';
const CAPS = ['input-datachannel', 'install-reset', 'app-install', 'logcat', 'screenshot', 'ui-hierarchy'];

const register = async (localIds: string[]) => {
  const res = await app.inject({
    method: 'POST', url: '/v1/workers/register',
    headers: { 'x-worker-registration-token': 'released-device-test-secret' },
    payload: {
      protocolVersion: 2, hostname: `rel-${randomUUID().slice(0, 8)}`, region: REGION,
      endpoint: 'mfarm+tunnel:/dp', cores: 8, memoryMb: 16384, capabilities: CAPS,
      devices: localIds.map((localId) => ({
        localId, platform: 'android', tier: 'physical', model: 'KB2001', osVersion: '14', capabilities: CAPS,
      })),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { hostId: string; deviceIds: Record<string, string> };
};

const operator = (url: string, payload: Record<string, unknown> = {}) => app.inject({
  method: 'POST', url, payload, headers: { cookie, 'x-mfarm-csrf': csrf },
});

const row = (id: string) => withSystem(async (c) => (await c.query<{
  state: string; quarantined_at: Date | null; quarantine_reason: string | null; quarantine_source: string | null;
  recovery_started_at: Date | null }>(
  `SELECT state::text AS state, quarantined_at, quarantine_reason, quarantine_source, recovery_started_at
     FROM devices WHERE id = $1`, [id])).rows[0]);

const served = async (id: string) => {
  const res = await app.inject({ method: 'GET', url: `/v1/devices/${id}`, headers: { authorization: `Bearer ${key}` } });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json().device ?? res.json()) as Record<string, unknown>;
};

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  const orgId = await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Released Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
    return (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Released',50) RETURNING id`,
      [`released-${randomUUID()}`])).rows[0].id as string;
  });
  await upsertUser(OPERATOR, PASSWORD, orgId, 'admin');
  await withSystem((c) => c.query('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]));
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: OPERATOR, password: PASSWORD } });
  cookie = `mfarm_session=${cookieValue(String(res.headers['set-cookie']), 'mfarm_session')}`;
  csrf = res.json().csrfToken;
  key = (await createApiKey(orgId, 'test fixture — released-device', { scope: 'full' })).plaintext;
});

after(async () => {
  await withSystem(async (c) => {
    await c.query('ALTER TABLE infra_operations DISABLE TRIGGER infra_operations_append_only');
    await c.query(`DELETE FROM infra_operations WHERE target_id IN (SELECT id::text FROM hosts WHERE region = $1)`, [REGION]);
    await c.query('ALTER TABLE infra_operations ENABLE TRIGGER infra_operations_append_only');
    await c.query('DELETE FROM device_quarantine_log WHERE device_id IN (SELECT id FROM devices WHERE region = $1)', [REGION]);
    await c.query('DELETE FROM devices WHERE region = $1', [REGION]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await app.close();
  await closePools();
});

describe('Resume gives a device back clean', () => {
  test('a resumed device is AVAILABLE with nothing left of the quarantine', async () => {
    const { hostId, deviceIds } = await register(['phone']);
    assert.equal((await operator(`/v1/infra/hosts/${hostId}/drain`, { reason: 'maintenance' })).json().result, 'succeeded');
    assert.equal((await row(deviceIds.phone)).state, 'QUARANTINED', 'fixture: the drain held the device');

    assert.equal((await operator(`/v1/infra/hosts/${hostId}/resume`)).json().result, 'succeeded');
    const r = await row(deviceIds.phone);
    assert.equal(r.state, 'READY');
    assert.equal(r.quarantine_reason, null, 'the device kept "its host was quarantined" after it came back');
    assert.equal(r.quarantined_at, null);
    assert.equal(r.quarantine_source, null);
    assert.equal((await served(deviceIds.phone)).quarantine, undefined);
  });

  /** A recovery that resumes must get its full time, not the time left before the host went out. */
  test('a device that was recovering resumes recovering, on a fresh clock', async () => {
    const { hostId, deviceIds } = await register(['phone']);
    const long = new Date(Date.now() - 6 * 3600_000);
    await withSystem((c) => c.query(
      `UPDATE devices SET state = 'PREPARING', recovery_started_at = $2 WHERE id = $1`, [deviceIds.phone, long]));
    await operator(`/v1/infra/hosts/${hostId}/drain`, {});
    await operator(`/v1/infra/hosts/${hostId}/resume`);
    const r = await row(deviceIds.phone);
    assert.equal(r.state, 'PREPARING');
    assert.ok(r.recovery_started_at && r.recovery_started_at.getTime() > Date.now() - 60_000,
      'the recovery clock still read six hours old, so it could time out the moment it resumed');
  });

  /** One level down from 016: a person's quarantine of one handset is not lifted by resuming its host. */
  test('a device a person quarantined on its own stays quarantined', async () => {
    const { hostId, deviceIds } = await register(['phone']);
    await withSystem((c) => c.query(`SELECT quarantine_device($1, 'cracked screen', 'operator')`, [deviceIds.phone]));
    await operator(`/v1/infra/hosts/${hostId}/drain`, {});
    await operator(`/v1/infra/hosts/${hostId}/resume`);
    const r = await row(deviceIds.phone);
    assert.equal(r.state, 'QUARANTINED');
    assert.equal(r.quarantine_reason, 'cracked screen');
    assert.equal(((await served(deviceIds.phone)).quarantine as { reason: string }).reason, 'cracked screen');
  });
});

describe('a stale quarantine never reaches a screen', () => {
  /** Whatever path leaves one behind — 068 cleans the rows, and the read refuses to repeat them. */
  test('the device read does not serve a quarantine beside a state that is not one', async () => {
    const { deviceIds } = await register(['phone']);
    await withSystem((c) => c.query(
      `UPDATE devices SET quarantined_at = now(), quarantine_reason = 'its host was quarantined: no heartbeat for 90s',
                          quarantine_source = 'host' WHERE id = $1`, [deviceIds.phone]));
    assert.equal((await row(deviceIds.phone)).state, 'READY', 'fixture');
    assert.equal((await served(deviceIds.phone)).quarantine, undefined);
    const list = await app.inject({ method: 'GET', url: '/v1/devices', headers: { authorization: `Bearer ${key}` } });
    const d = (list.json().devices as Array<Record<string, unknown>>).find((x) => x.id === deviceIds.phone);
    assert.equal(d?.quarantine, undefined);
  });
});
