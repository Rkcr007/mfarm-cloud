/**
 * The tests that matter in Phase 1.
 *
 * Everything here targets one failure: two tenants on one device. That bug is invisible in
 * development (single user, no contention), invisible in staging (same), and catastrophic in
 * production. So it gets tested under real concurrency against a real Postgres, not mocked.
 *
 *   docker compose up -d && npm run migrate && npm test
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, withSystem, withAppUnscoped, closePools } from '../src/db.ts';
import { allocate, activate, release, resetComplete, reap } from '../src/allocator.ts';
import { ingest, usage } from '../src/metering.ts';
import { negotiate, acceptFence, type WorkerRegistration } from '@mfarm/protocol';

let orgA: string, orgB: string, host: string;
const REGION = 'test-eu';

async function seedDevices(n: number, orgId: string | null = null) {
  return withSystem(async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { rows } = await c.query(
        `INSERT INTO devices (host_id, org_id, region, platform, tier, model, os_version, state, capabilities)
         VALUES ($1, $2, $3, 'android', 'cuttlefish', 'cf_x86_64', '15', 'READY',
                 '["screen-stream","input-datachannel","snapshot-reset"]'::jsonb)
         RETURNING id`,
        [host, orgId, REGION],
      );
      ids.push(rows[0].id);
    }
    return ids;
  });
}

async function resetFleet() {
  // Scoped to this file's own org/host: node:test runs test FILES in parallel against one database,
  // so an unscoped DELETE here would silently wipe the HTTP suite's fixtures mid-run.
  await withSystem(async (c) => {
    await c.query('DELETE FROM metering_events WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM devices WHERE host_id = $1', [host]);
  });
}

before(async () => {
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code, name) VALUES ($1, 'Test EU')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    const a = await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ('org-a','A',100) RETURNING id`);
    const b = await c.query(
      `INSERT INTO orgs (slug, name, max_concurrent) VALUES ('org-b','B',100) RETURNING id`);
    const h = await c.query(
      `INSERT INTO hosts (region, hostname, state, protocol_version, cores, memory_mb)
       VALUES ($1, 'test-host-1', 'UP', 1, 64, 262144) RETURNING id`, [REGION]);
    orgA = a.rows[0].id; orgB = b.rows[0].id; host = h.rows[0].id;
  });
});

after(async () => {
  await withSystem(async (c) => {
    await c.query('DELETE FROM metering_events WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM sessions WHERE org_id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM devices WHERE host_id = $1', [host]);
    await c.query('DELETE FROM hosts WHERE id = $1', [host]);
    await c.query('DELETE FROM orgs WHERE id = ANY($1)', [[orgA, orgB]]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

describe('allocator under concurrency', () => {
  test('50 concurrent requests against 10 devices allocate each device at most once', async () => {
    await resetFleet();
    const devices = await seedDevices(10);

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' })),
    );

    const allocated = results.filter((r) => r.deviceId !== null);
    const queued = results.filter((r) => r.deviceId === null);

    assert.equal(allocated.length, 10, 'exactly the 10 available devices should be handed out');
    assert.equal(queued.length, 40, 'the rest must queue, not fail');

    // The invariant. If this ever fails, two tenants are sharing a device.
    const ids = allocated.map((r) => r.deviceId);
    assert.equal(new Set(ids).size, 10, 'no device allocated twice');
    assert.deepEqual([...new Set(ids)].sort(), [...devices].sort());

    // Every allocation got a distinct fence, and each is the device's first (0 -> 1)
    assert.ok(allocated.every((r) => r.fence === 1), 'first allocation of each device fences to 1');
  });

  test('the database refuses a second live session on one device even if the allocator regresses', async () => {
    await resetFleet();
    const [dev] = await seedDevices(1);
    const first = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    assert.equal(first.deviceId, dev);

    // Bypass the allocator entirely and force the bad row in. The partial unique index is the
    // last line of defence, and it should hold regardless of application logic.
    await assert.rejects(
      () => withSystem((c) =>
        c.query(`INSERT INTO sessions (org_id, device_id, state, region, fence)
                 VALUES ($1, $2, 'ACTIVE', $3, 99)`, [orgB, dev, REGION])),
      /sessions_one_live_per_device/,
      'partial unique index must reject a concurrent live session',
    );
  });

  test('fences increase monotonically across the reuse cycle', async () => {
    await resetFleet();
    const [dev] = await seedDevices(1);
    const seen: number[] = [];

    for (let i = 0; i < 5; i++) {
      const a = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
      assert.equal(a.deviceId, dev, 'same device should come back around');
      seen.push(a.fence!);
      await release(orgA, a.sessionId, 'test');
      await resetComplete(dev, a.fence!);   // worker confirms snapshot restore
    }

    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    assert.ok(seen.every((v, i) => i === 0 || v > seen[i - 1]), 'strictly increasing');
  });

  test('a released device is not allocatable until reset is confirmed', async () => {
    await resetFleet();
    const [dev] = await seedDevices(1);
    const a = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    await release(orgA, a.sessionId, 'test');

    // device is CLEANING — reset not yet reported
    const b = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });
    assert.equal(b.deviceId, null, 'must queue: an unreset device still holds the last tenant state');
    assert.equal(b.state, 'QUEUED');

    await resetComplete(dev, a.fence!);
    const c = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });
    assert.equal(c.deviceId, dev, 'allocatable once the snapshot restore is confirmed');
  });

  test('a stale fence cannot free a device that has been reallocated', async () => {
    await resetFleet();
    const [dev] = await seedDevices(1);
    const first = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    await release(orgA, first.sessionId, 'test');
    await resetComplete(dev, first.fence!);

    const second = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });
    await release(orgB, second.sessionId, 'test');

    // A worker partitioned during the first allocation finally reports in with the old fence.
    const stale = await resetComplete(dev, first.fence!);
    assert.equal(stale, false, 'stale fence must be rejected');

    const still = await withSystem(async (c) =>
      (await c.query('SELECT state FROM devices WHERE id = $1', [dev])).rows[0].state);
    assert.equal(still, 'CLEANING', 'device must stay unavailable, not be resurrected by a stale worker');
  });

  test('per-org concurrency cap holds under parallel requests', async () => {
    await resetFleet();
    await seedDevices(20);
    await withSystem((c) => c.query('UPDATE orgs SET max_concurrent = 3 WHERE id = $1', [orgA]));

    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' })),
    );
    const live = results.filter((r) => r.deviceId !== null);
    assert.equal(live.length, 3, 'cap must be exact under concurrency, not approximate');

    await withSystem((c) => c.query('UPDATE orgs SET max_concurrent = 100 WHERE id = $1', [orgA]));
  });
});

describe('tenant isolation', () => {
  test('RLS hides another org\'s sessions', async () => {
    await resetFleet();
    await seedDevices(2);
    const a = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });

    const visibleToB = await withTenant(orgB, async (c) =>
      (await c.query('SELECT id FROM sessions WHERE id = $1', [a.sessionId])).rowCount);
    assert.equal(visibleToB, 0, 'org B must not see org A\'s session');

    const visibleToA = await withTenant(orgA, async (c) =>
      (await c.query('SELECT id FROM sessions WHERE id = $1', [a.sessionId])).rowCount);
    assert.equal(visibleToA, 1, 'org A must see its own');
  });

  test('an unscoped query returns nothing rather than everything', async () => {
    await resetFleet();
    await seedDevices(1);
    await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });

    // No set_config — the "forgot to scope it" case, on the RLS-bound app role.
    const leaked = await withAppUnscoped(async (c) =>
      (await c.query('SELECT id FROM sessions')).rowCount);
    assert.equal(leaked, 0, 'unset tenant must match zero rows, not bypass the policy');
  });

  test('dedicated devices are invisible to other orgs', async () => {
    await resetFleet();
    await seedDevices(1, orgA);              // dedicated to A
    const b = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });
    assert.equal(b.deviceId, null, 'org B must not be allocated org A\'s dedicated device');
  });
});

describe('reaper', () => {
  test('an expired session frees its device and promotes a queued one', async () => {
    await resetFleet();
    const [dev] = await seedDevices(1);
    const a = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    const b = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });
    assert.equal(b.state, 'QUEUED', 'no device left, so B queues');

    await withSystem((c) =>
      c.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.sessionId]));

    const { expired } = await reap();
    assert.ok(expired >= 1, 'timed-out session must be collected');

    const st = await withSystem(async (c) =>
      (await c.query('SELECT state FROM sessions WHERE id = $1', [a.sessionId])).rows[0].state);
    assert.equal(st, 'ENDED');

    // still CLEANING until the worker confirms, so promotion should not have taken it yet
    await resetComplete(dev, a.fence!);
    const { promoted } = await reap();
    assert.equal(promoted, 1, 'queued session should now get the freed device');
  });
});

describe('metering', () => {
  test('ingest is idempotent under worker retries', async () => {
    await resetFleet();
    await seedDevices(1);
    const a = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    const eventId = crypto.randomUUID();
    const ev = {
      eventId, orgId: orgA, sessionId: a.sessionId, deviceId: a.deviceId,
      kind: 'device_seconds' as const, quantity: 42.5, occurredAt: new Date(),
    };

    assert.equal(await ingest([ev]), 1, 'first delivery recorded');
    assert.equal(await ingest([ev]), 0, 'retry must not double-count');
    assert.equal(await ingest([ev, { ...ev, eventId: crypto.randomUUID() }]), 1, 'only the new one');

    const u = await usage(orgA, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
    assert.equal(u.device_seconds, 85, 'two distinct events of 42.5');
  });
});

describe('worker protocol negotiation', () => {
  const base: WorkerRegistration = {
    protocolVersion: 1, hostname: 'h1', region: REGION, cores: 64, memoryMb: 262144,
    capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
    devices: [{
      localId: 'cf-1', platform: 'android', tier: 'cuttlefish', model: 'cf', osVersion: '15',
      capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
    }],
  };

  test('a newer worker is accepted and downgraded, not rejected', () => {
    const r = negotiate({ ...base, protocolVersion: 99, capabilities: [...base.capabilities, 'time-travel' as never] });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.version, 1, 'speak our version; workers upgrade first during a rollout');
  });

  test('a device that cannot snapshot-reset registers but is not schedulable', () => {
    const r = negotiate({
      ...base,
      devices: [{ ...base.devices[0], capabilities: ['screen-stream', 'input-datachannel'] }],
    });
    assert.equal(r.ok, true, 'still visible and monitorable');
    assert.deepEqual(r.ok && r.schedulable, [], 'but never handed to a tenant — it leaks prior state');
  });

  test('a retired protocol version is refused', () => {
    const r = negotiate({ ...base, protocolVersion: 0 });
    assert.equal(r.ok, false);
  });

  test('fence high-water mark rejects stale commands', () => {
    assert.equal(acceptFence(5, 5), true);
    assert.equal(acceptFence(5, 6), true);
    assert.equal(acceptFence(5, 4), false, 'a partitioned client must not drive a reallocated device');
  });
});
