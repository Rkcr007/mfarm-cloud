/**
 * A retired machine that comes back, and a device that arrives on a quarantined one — D59.
 *
 * Found on the farm 2026-10-03 with a OnePlus on the MacBook that migration 056 was written about.
 * The retire screen said "running the agent on it again brings it back". Registration did clear
 * `retired_at` — and left the operator quarantine retiring had applied, so the laptop was back in the
 * fleet list as QUARANTINED, reason "retired: …", for good. The phone it registered was a NEW device,
 * INSERTed as READY onto that quarantined host, and the allocator — which does not look at the host —
 * handed it out while the agent's log said "not accepting sessions".
 *
 * Everything here goes through the real routes: an operator retires, drains and resumes from the
 * console's endpoints, and the worker registers and beats on its own. A test that set the states by
 * hand would be testing the SQL somebody imagined the routes run.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'retired-host-test-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { upsertUser, cookieValue } from '../src/users.ts';

let app: FastifyInstance;
let cookie: string, csrf: string;

const REGION = `retired-${randomUUID().slice(0, 8)}`;
const OPERATOR = `op-${randomUUID()}@example.test`;
const PASSWORD = 'correct horse battery staple';

/** What KB2001 declared on the farm — schedulable, so it registers READY on a host that is UP. */
const PHONE_CAPS = ['input-datachannel', 'install-reset', 'app-install', 'logcat', 'screenshot', 'ui-hierarchy'];
const phone = (localId: string) => ({
  localId, platform: 'android', tier: 'physical', model: 'KB2001', osVersion: '14', capabilities: PHONE_CAPS,
});

const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  withSystem(async (c) => (await c.query<T>(sql, params)).rows);

const register = async (hostname: string, localIds: string[]) => {
  const res = await app.inject({
    method: 'POST', url: '/v1/workers/register',
    headers: { 'x-worker-registration-token': 'retired-host-test-secret' },
    payload: {
      protocolVersion: 2, hostname, region: REGION, endpoint: 'mfarm+tunnel:/dp',
      cores: 8, memoryMb: 16384, capabilities: PHONE_CAPS, devices: localIds.map(phone),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { hostId: string; workerToken: string };
};

const operator = (url: string, payload: Record<string, unknown> = {}) => app.inject({
  method: 'POST', url, payload, headers: { cookie, 'x-mfarm-csrf': csrf },
});

const host = (id: string) => q<{ state: string; quarantine_source: string | null; quarantine_reason: string | null;
                                 quarantined_at: Date | null; retired_at: Date | null }>(
  `SELECT state::text AS state, quarantine_source, quarantine_reason, quarantined_at, retired_at
     FROM hosts WHERE id = $1`, [id]).then((r) => r[0]);

const device = (hostId: string, localId: string) => q<{ state: string }>(
  'SELECT state::text AS state FROM devices WHERE host_id = $1 AND local_id = $2', [hostId, localId])
  .then((r) => r[0]?.state);

/** Retire refuses a machine heard from in the last ten minutes, as it should. */
const goQuiet = (hostId: string) =>
  q(`UPDATE hosts SET last_heartbeat_at = now() - interval '2 hours' WHERE id = $1`, [hostId]);

before(async () => {
  app = await buildServer({ logger: false, loginRateLimitMax: 10_000 });
  const orgId = await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Retired Test') ON CONFLICT (code) DO NOTHING`, [REGION]);
    return (await c.query(`INSERT INTO orgs (slug,name,max_concurrent) VALUES ($1,'Retired',50) RETURNING id`,
      [`retired-${randomUUID()}`])).rows[0].id as string;
  });
  await upsertUser(OPERATOR, PASSWORD, orgId, 'admin');
  await withSystem((c) => c.query('UPDATE users SET operator = true WHERE lower(email) = lower($1)', [OPERATOR]));
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: OPERATOR, password: PASSWORD } });
  assert.equal(res.statusCode, 200, res.body);
  cookie = `mfarm_session=${cookieValue(String(res.headers['set-cookie']), 'mfarm_session')}`;
  csrf = res.json().csrfToken;
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

describe('a retired machine that registers again', () => {
  test('is back in service — the host, and the device it already had', async () => {
    const name = `laptop-${randomUUID().slice(0, 6)}`;
    const { hostId } = await register(name, ['phone-old']);
    await goQuiet(hostId);
    const retired = await operator(`/v1/infra/hosts/${hostId}/retire`, { reason: 'a developer laptop' });
    assert.equal(retired.json().result, 'succeeded', retired.body);
    assert.match(retired.json().message, /Running the agent on it again brings it back/,
      'the promise this test holds the farm to');

    await register(name, ['phone-old']);

    const h = await host(hostId);
    assert.equal(h.retired_at, null);
    assert.equal(h.state, 'UP', `still ${h.state} (${h.quarantine_reason}) — the retire's own quarantine was never lifted`);
    assert.equal(h.quarantine_source, null);
    assert.equal(await device(hostId, 'phone-old'), 'READY');
  });

  test('and a phone it never had before comes in with it, READY', async () => {
    const name = `laptop-${randomUUID().slice(0, 6)}`;
    const { hostId } = await register(name, ['phone-old']);
    await goQuiet(hostId);
    await operator(`/v1/infra/hosts/${hostId}/retire`, {});

    await register(name, ['phone-old', 'phone-new']);
    assert.equal((await host(hostId)).state, 'UP');
    assert.equal(await device(hostId, 'phone-new'), 'READY');
  });
});

describe('a device that arrives on a host an operator has drained', () => {
  /**
   * THE ALLOCATOR HALF. A drained host that registers stays drained — registration has no standing
   * against an operator — and so must a phone it registers for the first time.
   */
  test('is held with the host, not handed out', async () => {
    const name = `drained-${randomUUID().slice(0, 6)}`;
    const { hostId } = await register(name, ['phone-old']);
    const drained = await operator(`/v1/infra/hosts/${hostId}/drain`, { reason: 'maintenance' });
    assert.equal(drained.json().result, 'succeeded', drained.body);
    const since = (await host(hostId)).quarantined_at;

    await register(name, ['phone-old', 'phone-new']);

    const h = await host(hostId);
    assert.equal(h.state, 'QUARANTINED', 'registration overruled an operator');
    assert.equal(await device(hostId, 'phone-new'), 'QUARANTINED',
      'a phone new to a drained host was READY, and the allocator does not look at the host');
    assert.equal(await device(hostId, 'phone-old'), 'QUARANTINED');
    assert.equal(h.quarantined_at?.toISOString(), since?.toISOString(),
      'holding the new device restarted the clock on how long the host has been out');
  });

  test('and Resume gives back both — the new one too', async () => {
    const name = `drained-${randomUUID().slice(0, 6)}`;
    const { hostId } = await register(name, ['phone-old']);
    await operator(`/v1/infra/hosts/${hostId}/drain`, {});
    await register(name, ['phone-old', 'phone-new']);

    const resumed = await operator(`/v1/infra/hosts/${hostId}/resume`, {});
    assert.equal(resumed.json().result, 'succeeded', resumed.body);
    assert.equal(await device(hostId, 'phone-old'), 'READY');
    assert.equal(await device(hostId, 'phone-new'), 'READY', 'held without remembering what it was doing');
  });

  test('a host that is UP registers a new device READY, as it always did', async () => {
    const name = `ordinary-${randomUUID().slice(0, 6)}`;
    const { hostId } = await register(name, ['phone-old']);
    await register(name, ['phone-old', 'phone-new']);
    assert.equal(await device(hostId, 'phone-new'), 'READY');
  });
});

describe('the heartbeat says when a machine is retired', () => {
  const beat = (token: string) => app.inject({
    method: 'POST', url: '/v1/workers/heartbeat',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { protocolVersion: 2, capabilities: PHONE_CAPS, devices: {} },
  });

  test('a retired machine is told so, because a beat will not bring it back', async () => {
    const { hostId, workerToken } = await register(`told-${randomUUID().slice(0, 6)}`, ['phone-old']);
    await goQuiet(hostId);
    await operator(`/v1/infra/hosts/${hostId}/retire`, {});
    const res = await beat(workerToken);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().retired, true);
    assert.equal((await host(hostId)).state, 'QUARANTINED', 'a beat alone brought a retired host back (056)');
  });

  test('and one that is not, is not', async () => {
    const { workerToken } = await register(`not-told-${randomUUID().slice(0, 6)}`, ['phone-old']);
    assert.equal((await beat(workerToken)).json().retired, false);
  });
});
