/**
 * What `GET /v1/devices` tells the Health page about each device — D1 — and the claim underneath D2.
 *
 * ---------------------------------------------------------------- D1, and the join that was wrong
 *
 * Document 05 §06 draws a per-device line: "check passed 4m ago", "check failed 2d ago". The list
 * projection carried neither an outcome nor a time, so every row could say only what its state pill
 * already said.
 *
 * `docs/DEFECTS.md` proposed a lateral join onto `device_reset_attempts`, AND THAT WOULD HAVE BEEN
 * WRONG. Migration 032 writes to that table only when a reset has been outstanding too long or has
 * been escalated — its outcomes are `timed-out | succeeded | escalated`, and a device that has
 * never had a problem has no rows in it at all. A join would have reported "nothing recorded" for
 * precisely the healthy devices. `last_reset_at` is the column that means what the design is asking
 * for, and the first test here is the one that would have caught the join.
 *
 * ---------------------------------------------------------------- D2, which was not a code defect
 *
 * D2 said "the worker registers no `screen` for real devices". It does. `discovery.ts` reads the
 * panel with `wm size` / `wm density`, `physical.ts` falls back to a real geometry when that read
 * fails so the field can never be empty, and `agent.ts` sends `info.screen` for every tier. The
 * farm's handset shows no geometry because its row has not been written since its host last beat on
 * 2026-08-29 — eight days before the defect was recorded — not because the path drops it.
 *
 * The last test is the guard that was genuinely missing: `physical.test.ts` proves the BACKEND
 * reports a screen, and nothing proved the value survives registration and comes back out of the
 * list. It does now, and if that ever stops being true this file says so instead of a handset.
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

const REGION = `dev-health-${randomUUID().slice(0, 8)}`;

let app: FastifyInstance;
let orgId: string;
let hostId: string;
let key: string;

const auth = (k: string) => ({ authorization: `Bearer ${k}` });

/** Every device this file's host owns, as the tenant list returns them. */
async function list(): Promise<Array<Record<string, unknown>>> {
  const r = await app.inject({ method: 'GET', url: `/v1/devices?region=${REGION}`, headers: auth(key) });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().devices as Array<Record<string, unknown>>;
}

async function seedDevice(localId: string): Promise<string> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO devices (host_id, org_id, region, platform, tier, model, os_version, state,
                            capabilities, local_id)
       VALUES ($1, NULL, $2, 'android', 'cuttlefish', 'cf_x86_64', '15', 'READY',
               '["screen-stream","snapshot-reset"]'::jsonb, $3)
       RETURNING id`,
      [hostId, REGION, localId],
    );
    return rows[0].id as string;
  });
}

before(async () => {
  app = await buildServer({ logger: false, rateLimitMax: 10_000 });
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code, name) VALUES ($1, 'Device Health Fields')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    orgId = (await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ($1, 'Device Health Fields', 50) RETURNING id`,
      [`dev-health-${randomUUID().slice(0, 8)}`],
    )).rows[0].id;
  });
  key = (await createApiKey(orgId)).plaintext;

  const r = await app.inject({
    method: 'POST', url: '/v1/workers/register',
    headers: { 'x-worker-registration-token': 'test-registration-secret' },
    payload: {
      protocolVersion: 1, hostname: `dev-health-host-${randomUUID().slice(0, 8)}`, region: REGION,
      endpoint: 'wss://worker-dh.example:8443', cores: 8, memoryMb: 16384,
      capabilities: ['screen-stream', 'snapshot-reset'],
      devices: [],
    },
  });
  assert.equal(r.statusCode, 201, `worker registration failed: ${r.body}`);
  hostId = r.json().hostId;
});

after(async () => {
  await withSystem((c) => c.query('DELETE FROM devices WHERE host_id = $1', [hostId]));
  await app?.close();
  await closePools();
});

describe('the device list carries what Health needs per device (D1)', () => {
  test('lastResetAt comes back when the farm has confirmed the device', async () => {
    const id = await seedDevice(`ok-${randomUUID()}`);
    const at = new Date(Date.now() - 4 * 60_000).toISOString();
    await withSystem((c) => c.query('UPDATE devices SET last_reset_at = $2 WHERE id = $1', [id, at]));

    const d = (await list()).find((x) => x.id === id);
    assert.ok(d, 'the seeded device is missing from the list');
    assert.ok(d.lastResetAt, 'the list carries no last-reset time, so Health can only repeat the state pill');
    assert.equal(new Date(d.lastResetAt as string).toISOString(), at);
  });

  /**
   * THE TEST THAT WOULD HAVE CAUGHT THE PROPOSED JOIN. A healthy device has no
   * `device_reset_attempts` rows, so a projection sourced from that table reports nothing here —
   * and "nothing recorded" for a device the farm confirmed four minutes ago is the inverse of the
   * truth, on the majority of the fleet.
   */
  test('a device with a confirmed reset has no reset-attempt rows at all', async () => {
    const id = await seedDevice(`clean-${randomUUID()}`);
    await withSystem((c) => c.query('UPDATE devices SET last_reset_at = now() WHERE id = $1', [id]));

    const attempts = await withSystem(async (c) => {
      const { rows } = await c.query(
        'SELECT count(*)::int AS n FROM device_reset_attempts WHERE device_id = $1', [id],
      );
      return rows[0].n as number;
    });
    assert.equal(attempts, 0, 'a healthy device has no attempt ledger to join to');

    const d = (await list()).find((x) => x.id === id);
    assert.ok(d?.lastResetAt, 'and the column still answers, which is the whole point');
  });

  /**
   * Omitted rather than null, like every other optional field in this projection (ADR-0016). A
   * device registered and never reset is a real state — the console says "no check recorded" — and
   * an explicit null would be one more shape every reader handles to reach the same place.
   */
  test('a device the farm has never confirmed omits the field entirely', async () => {
    const id = await seedDevice(`never-${randomUUID()}`);
    const d = (await list()).find((x) => x.id === id);
    assert.ok(d, 'the seeded device is missing from the list');
    assert.ok(!('lastResetAt' in d), 'absent is the answer, not null');
  });
});

describe('the list says how old its own answer is (D2)', () => {
  /**
   * A blank geometry and a silent host are opposite problems — plug the machine back in, or go and
   * look at the device — and the list could not tell them apart. The farm's handset read "not
   * reported" for nine days while its host had been gone the whole time.
   */
  test('a device whose host has not beaten carries the last time it was heard from', async () => {
    const id = await seedDevice(`stale-${randomUUID()}`);
    const when = new Date(Date.now() - 9 * 86_400_000).toISOString();
    await withSystem((c) => c.query(
      'UPDATE hosts SET last_heartbeat_at = $2 WHERE id = $1', [hostId, when]));

    const d = (await list()).find((x) => x.id === id);
    assert.ok(d?.hostLastSeenAt, 'without this the console cannot say why a field is blank');
    assert.equal(new Date(d.hostLastSeenAt as string).toISOString(), when);
  });

  /** A beating host still answers, so "not reported" there really is about the device. */
  test('it is present for a healthy host too, so the console never has to guess', async () => {
    await withSystem((c) => c.query('UPDATE hosts SET last_heartbeat_at = now() WHERE id = $1', [hostId]));
    const id = await seedDevice(`fresh-${randomUUID()}`);
    const d = (await list()).find((x) => x.id === id);
    assert.ok(d?.hostLastSeenAt);
    assert.ok(Date.now() - new Date(d.hostLastSeenAt as string).getTime() < 60_000);
  });
});

describe('a physical device registers its panel (the claim under D2)', () => {
  /**
   * END TO END, through the real registration route: agent payload -> upsert -> tenant list.
   * `physical.test.ts` proves the backend puts a screen in `info`; this proves the value survives
   * the trip and comes back out, which is the hop nothing covered.
   */
  test('the geometry an agent sends for a handset comes back out of the list', async () => {
    const localId = `phone-${randomUUID().slice(0, 8)}`;
    const r = await app.inject({
      method: 'POST', url: '/v1/workers/register',
      headers: { 'x-worker-registration-token': 'test-registration-secret' },
      payload: {
        protocolVersion: 1, hostname: `dev-health-host-phys-${randomUUID().slice(0, 8)}`,
        region: REGION, endpoint: 'wss://worker-phys.example:8443', cores: 8, memoryMb: 16384,
        capabilities: ['app-install'],
        devices: [{
          localId,
          platform: 'android',
          tier: 'physical',
          model: 'SM-S918B',
          osVersion: '16',
          capabilities: ['app-install', 'logcat', 'screenshot', 'ui-hierarchy', 'install-reset'],
          // What `discovery.ts` reads off a real handset with `wm size` / `wm density`.
          screen: { width: 1440, height: 3088, density: 500 },
        }],
      },
    });
    assert.equal(r.statusCode, 201, `physical registration failed: ${r.body}`);

    const d = (await list()).find((x) => x.model === 'SM-S918B');
    assert.ok(d, 'the handset did not reach the tenant list');
    assert.deepEqual(d.screen, { width: 1440, height: 3088, density: 500 },
      'a handset that registers a panel and comes back without one is D2 as it was written');

    await withSystem((c) => c.query('DELETE FROM devices WHERE local_id = $1', [localId]));
  });
});
