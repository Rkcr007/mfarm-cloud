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
import { randomUUID } from 'node:crypto';
import { withTenant, withSystem, withAppUnscoped, closePools } from '../src/db.ts';
import { allocate, activate, release, resetComplete, reap, queueStanding } from '../src/allocator.ts';
import { ingest, usage } from '../src/metering.ts';
import { negotiate, acceptFence, PROTOCOL_VERSION, type WorkerRegistration } from '@mfarm/protocol';

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

/**
 * Devices of a named class, in one region, all otherwise identical.
 *
 * `profile` NULL is a real class — this farm's unprofiled devices — so it is seeded deliberately
 * rather than left off, and the tests below depend on being able to ask for exactly it.
 */
async function seedProfiled(profile: string | null, n = 1) {
  return withSystem(async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { rows } = await c.query(
        `INSERT INTO devices (host_id, org_id, region, platform, tier, model, os_version, state,
                              capabilities, profile, screen)
         VALUES ($1, NULL, $2, 'android', 'cuttlefish', $3, '17', 'READY',
                 '["screen-stream","app-install"]'::jsonb, $4, $5::jsonb)
         RETURNING id`,
        [host, REGION, profile ?? 'cf_x86_64', profile,
          JSON.stringify(profile ? { width: 1080, height: 2340, density: 450 } : { width: 720, height: 1280, density: 320 })],
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
      // `last_heartbeat_at` is set because a REAL host always has one — registration writes it —
      // and because the reaper now quarantines a host that has gone silent. A fixture that skips it
      // is a host the fleet has never heard from, and the sweep is right to take its devices out of
      // the pool; leaving it NULL made this suite's devices vanish mid-test.
      `INSERT INTO hosts (region, hostname, state, protocol_version, cores, memory_mb, last_heartbeat_at)
       VALUES ($1, 'test-host-1', 'UP', 1, 64, 262144, now()) RETURNING id`, [REGION]);
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
      await resetComplete(host, dev, a.fence!);   // worker confirms snapshot restore
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

    await resetComplete(host, dev, a.fence!);
    const c = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });
    assert.equal(c.deviceId, dev, 'allocatable once the snapshot restore is confirmed');
  });

  test('a stale fence cannot free a device that has been reallocated', async () => {
    await resetFleet();
    const [dev] = await seedDevices(1);
    const first = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    await release(orgA, first.sessionId, 'test');
    await resetComplete(host, dev, first.fence!);

    const second = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });
    await release(orgB, second.sessionId, 'test');

    // A worker partitioned during the first allocation finally reports in with the old fence.
    const stale = await resetComplete(host, dev, first.fence!);
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

/**
 * Section 20 of the spec, which asks by name that "ten users submit tests" must not let one of them
 * monopolise the farm.
 *
 * THE BUG THIS FIXES was not a slow queue, it was a stopped one. `promote_queued` read the twenty
 * oldest QUEUED sessions GLOBALLY, ordered by `created_at`, and skipped each one whose org sat at
 * its concurrency cap. An org holding twenty or more queued sessions at its cap therefore filled
 * the entire candidate window with rows that all `CONTINUE` — and a second org's session was never
 * looked at, with devices sitting READY. The sweep repeated the same window every ten seconds and
 * promoted nothing.
 *
 * Invisible on a one-org farm, which is why it survived to migration 038. It surfaces on the first
 * day of the second team.
 */
describe('queue fairness across orgs', () => {
  test('a large org at its cap cannot starve a small one behind it', async () => {
    await resetFleet();
    /**
     * THE SHAPE THIS TEST HAS TO HAVE, and the one an earlier version of it got wrong.
     *
     * Org A must still be AT ITS CAP at the moment a device frees. If A releases the device that
     * frees, A drops under its cap and is legitimately first in line for it — round-robin gives A
     * that device and is right to. There is no starvation in that story and a test built on it
     * fails against a correct fix.
     *
     * So: two devices. A holds one and stays holding it. B holds the other and releases it. A
     * spends the whole test pinned at cap 1 with a long backlog, which is exactly the production
     * situation — one team's CI queues a hundred jobs and every other team stops.
     */
    await seedDevices(2);
    await withSystem((c) => c.query('UPDATE orgs SET max_concurrent = 1 WHERE id = $1', [orgA]));

    const pinned = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    assert.ok(pinned.deviceId, 'org A should hold one device for the duration');
    const bHeld = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });
    assert.ok(bHeld.deviceId, 'org B should hold the other');

    // A's backlog is deliberately larger than promote_queued's window of 20. That is the whole
    // mechanism: a window one org can fill by itself is a window no other org appears in.
    for (let i = 0; i < 25; i++) {
      await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    }
    // B's second session arrives LAST, so strict `created_at` ordering puts it behind all 25.
    const b = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });
    assert.equal(b.deviceId, null, 'both devices are busy, so B queues — that part was always right');

    // B hands its own device back. One device is now READY and A is still at cap, so A cannot use
    // it. The only session in the fleet that can is B's.
    await release(orgB, bHeld.sessionId, 'test');
    await resetComplete(host, bHeld.deviceId!, (await withSystem(async (c) =>
      Number((await c.query('SELECT fence FROM devices WHERE id = $1', [bHeld.deviceId])).rows[0].fence))));

    await reap();

    const bState = await withSystem(async (c) =>
      (await c.query('SELECT state FROM sessions WHERE id = $1', [b.sessionId])).rows[0].state);

    /**
     * Asserted on WHOSE session moved, not on how many. A count would also pass if the window had
     * simply been made bigger, which is not the fix — the property is "every org's oldest is
     * considered before any org's second", and only B's own id can say that held.
     */
    assert.notEqual(bState, 'QUEUED',
      'org B waited behind 25 of org A\'s queued sessions and was never considered, with a device READY '
      + '— one org can starve another out of the queue');
    assert.equal(bState, 'ALLOCATING', 'B\'s session should have been promoted onto the freed device');

    await withSystem((c) => c.query('UPDATE orgs SET max_concurrent = 100 WHERE id = $1', [orgA]));
  });

  test('within one org the queue is still strictly first-in-first-out', async () => {
    await resetFleet();
    await seedDevices(1);
    await withSystem((c) => c.query('UPDATE orgs SET max_concurrent = 1 WHERE id = $1', [orgA]));

    const held = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    // Sequential, not Promise.all: this test is about ORDER, and concurrent inserts have no order
    // to be about. `created_at` is `now()`, which inside one transaction is a constant.
    const first = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    const second = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    assert.equal(first.deviceId, null);
    assert.equal(second.deviceId, null);

    await release(orgA, held.sessionId, 'test');
    await resetComplete(host, held.deviceId!, (await withSystem(async (c) =>
      Number((await c.query('SELECT fence FROM devices WHERE id = $1', [held.deviceId])).rows[0].fence))));

    await reap();

    const states = await withSystem(async (c) => (await c.query(
      'SELECT id, state FROM sessions WHERE id = ANY($1)', [[first.sessionId, second.sessionId]])).rows);
    const stateOf = (id: string) => states.find((r) => r.id === id)?.state;

    // Fairness across orgs must not have cost ordering within one. The older session goes first.
    assert.equal(stateOf(first.sessionId), 'ALLOCATING', 'the older of the two must be promoted');
    assert.equal(stateOf(second.sessionId), 'QUEUED', 'the newer must wait its turn');

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
    await resetComplete(host, dev, a.fence!);
    const { promoted } = await reap();
    assert.equal(promoted, 1, 'queued session should now get the freed device');
  });

  test('expiry counts sessions, not the devices that happen to still exist', async () => {
    await resetFleet();
    const [dev] = await seedDevices(1);
    const a = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });

    // The device leaves the fleet while the session is live. `sessions.device_id` is
    // ON DELETE SET NULL, so the session now expires while updating zero device rows — and the
    // reaper used to report that as "nothing expired".
    await withSystem((c) => c.query('DELETE FROM devices WHERE id = $1', [dev]));
    await withSystem((c) =>
      c.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.sessionId]));

    const { expired } = await reap();
    assert.ok(expired >= 1, 'the session expired, so the count must say so');
    const st = await withSystem(async (c) =>
      (await c.query('SELECT state FROM sessions WHERE id = $1', [a.sessionId])).rows[0].state);
    assert.equal(st, 'ENDED');
  });

  test('the reaper purges idempotency keys past their retention window', async () => {
    // Nothing else deletes them, and the table sits on the hot path of every session creation.
    await withSystem((c) => c.query(
      `INSERT INTO idempotency_keys (org_id, key, request_hash, status_code, response, created_at)
       VALUES ($1, 'stale-key', 'x', 201, '{}'::jsonb, now() - interval '2 days')
       ON CONFLICT (org_id, key) DO NOTHING`, [orgA]));

    await reap();

    const left = await withSystem(async (c) =>
      (await c.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE org_id = $1 AND key = $2',
                     [orgA, 'stale-key'])).rows[0].n);
    assert.equal(left, 0);
  });
});

describe('metering', () => {
  test('ingest is idempotent under worker retries', async () => {
    await resetFleet();
    await seedDevices(1);
    const a = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    const eventId = crypto.randomUUID();
    const ev = {
      eventId, sessionId: a.sessionId, deviceId: a.deviceId,
      kind: 'device_seconds' as const, quantity: 42.5, occurredAt: new Date(),
    };

    assert.deepEqual(await ingest(host, [ev]), { recorded: 1, duplicates: 0, rejected: 0 });
    assert.deepEqual(await ingest(host, [ev]), { recorded: 0, duplicates: 1, rejected: 0 },
                     'retry must not double-count');
    assert.deepEqual(await ingest(host, [ev, { ...ev, eventId: crypto.randomUUID() }]),
                     { recorded: 1, duplicates: 1, rejected: 0 }, 'only the new one');

    const u = await usage(orgA, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
    assert.equal(u.device_seconds, 85, 'two distinct events of 42.5');
  });

  // --- migration 008: a worker may bill only for work its own hardware did -------------------

  test('a host cannot bill for a session that is not on it', async () => {
    await resetFleet();
    await seedDevices(1);
    const a = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });

    const other = await withSystem(async (c) =>
      (await c.query(
        `INSERT INTO hosts (region, hostname, state, protocol_version, last_heartbeat_at)
         VALUES ($1, $2, 'UP', 1, now()) RETURNING id`,
        [REGION, `impostor-${crypto.randomUUID().slice(0, 8)}`])).rows[0].id as string);

    try {
      const r = await ingest(other, [{
        eventId: crypto.randomUUID(), sessionId: a.sessionId, deviceId: a.deviceId,
        kind: 'device_seconds', quantity: 9_999, occurredAt: new Date(),
      }]);
      assert.deepEqual(r, { recorded: 0, duplicates: 0, rejected: 1 },
                       'a host billing another host\'s session must be refused, and counted as such');

      const u = await usage(orgA, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
      assert.equal(u.device_seconds, undefined, 'nothing was charged to the org');
    } finally {
      await withSystem((c) => c.query('DELETE FROM hosts WHERE id = $1', [other]));
    }
  });

  test('the paying org comes from the session, not from the worker', async () => {
    await resetFleet();
    await seedDevices(1);
    // orgB's session. A worker cannot ask for the charge to land on orgA, because it is not asked.
    const b = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });

    await ingest(host, [{
      eventId: crypto.randomUUID(), sessionId: b.sessionId, deviceId: b.deviceId,
      kind: 'device_seconds', quantity: 12, occurredAt: new Date(),
    }]);

    const window = [new Date(Date.now() - 60_000), new Date(Date.now() + 60_000)] as const;
    assert.equal((await usage(orgB, ...window)).device_seconds, 12);
    assert.equal((await usage(orgA, ...window)).device_seconds, undefined);
  });

  test('an unknown session is rejected rather than silently absorbed as a duplicate', async () => {
    await resetFleet();
    const r = await ingest(host, [{
      eventId: crypto.randomUUID(), sessionId: crypto.randomUUID(), deviceId: null,
      kind: 'device_seconds', quantity: 5, occurredAt: new Date(),
    }]);
    assert.deepEqual(r, { recorded: 0, duplicates: 0, rejected: 1 });
  });
});

describe('device reset scoping', () => {
  test('a host cannot confirm a reset for another host\'s device', async () => {
    await resetFleet();
    const [dev] = await seedDevices(1);
    const a = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    await release(orgA, a.sessionId, 'test');   // device is now CLEANING

    const other = await withSystem(async (c) =>
      (await c.query(
        `INSERT INTO hosts (region, hostname, state, protocol_version, last_heartbeat_at)
         VALUES ($1, $2, 'UP', 1, now()) RETURNING id`,
        [REGION, `impostor-${crypto.randomUUID().slice(0, 8)}`])).rows[0].id as string);

    try {
      // The fence is not secret and not hard to guess — the host scope is what has to stop this.
      assert.equal(await resetComplete(other, dev, a.fence!), false);

      const state = await withSystem(async (c) =>
        (await c.query('SELECT state FROM devices WHERE id = $1', [dev])).rows[0].state);
      assert.equal(state, 'CLEANING',
                   'a device must not go READY mid-restore on a stranger\'s say-so');

      // And the real owner still can.
      assert.equal(await resetComplete(host, dev, a.fence!), true);
    } finally {
      await withSystem((c) => c.query('DELETE FROM hosts WHERE id = $1', [other]));
    }
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
    // Against the constant, not a literal: this assertion is about the DOWNGRADE rule, and pinning
    // it to a number meant every protocol bump failed a test that had not stopped being true.
    assert.equal(r.ok && r.version, PROTOCOL_VERSION, 'speak our version; workers upgrade first during a rollout');
  });

  test('a device that can reset by NEITHER mechanism registers but is not schedulable', () => {
    const r = negotiate({
      ...base,
      devices: [{ ...base.devices[0], capabilities: ['screen-stream', 'input-datachannel'] }],
    });
    assert.equal(r.ok, true, 'still visible and monitorable');
    assert.deepEqual(r.ok && r.schedulable, [], 'but never handed to a tenant — it leaks prior state');
  });

  /**
   * ADR-0008. A handset cannot restore an image, and the gate used to demand `snapshot-reset`
   * literally — so a phone registered, appeared in the console, and was never scheduled, with
   * nothing anywhere saying why. This is the test that would have caught that, and the one that
   * fails if anyone flattens REQUIRED_FOR_TENANT_USE back into a plain `.every()`.
   */
  test('a physical device resets by session-reset and IS schedulable', () => {
    const r = negotiate({
      ...base,
      devices: [{
        localId: 'phone-1', platform: 'android', tier: 'physical', model: 'Pixel 9', osVersion: '16',
        capabilities: ['input-datachannel', 'session-reset', 'app-install', 'screenshot'],
      }],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.schedulable, ['phone-1'],
      'session-reset satisfies the reset requirement; org-pinning is what keeps it honest');
  });

  /** The weaker reset is an ALTERNATIVE to snapshot-reset, never a substitute for persistent input. */
  test('session-reset does not excuse a device from the input requirement', () => {
    const r = negotiate({
      ...base,
      devices: [{ ...base.devices[0], capabilities: ['session-reset', 'app-install'] }],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.schedulable, [], 'every group must be satisfied, not just one');
  });

  test('a retired protocol version is refused', () => {
    const r = negotiate({ ...base, protocolVersion: 0 });
    assert.equal(r.ok, false);
  });

  test('a malformed registration is refused, not crashed on', () => {
    // Registration bodies come from machines we do not control and have no schema on the route.
    // Reading through a missing array throws, and a TypeError here reaches the worker as a 500 —
    // "the control plane is broken" — for a request it could have fixed itself.
    for (const bad of [
      { ...base, capabilities: undefined },
      { ...base, devices: undefined },
      { ...base, devices: [{ ...base.devices[0], capabilities: undefined }] },
    ] as unknown as WorkerRegistration[]) {
      const r = negotiate(bad);
      assert.equal(r.ok, false);
      assert.match(r.ok === false ? r.reason : '', /array/);
    }
  });

  test('fence high-water mark rejects stale commands', () => {
    assert.equal(acceptFence(5, 5), true);
    assert.equal(acceptFence(5, 6), true);
    assert.equal(acceptFence(5, 4), false, 'a partitioned client must not drive a reallocated device');
  });
});

/**
 * The idle sweep (migration 029).
 *
 * A WebDriver client that is killed sends no `deleteSession`, and WebDriver is stateless HTTP, so
 * the farm has no connection whose loss it could notice. Before 029 the ONLY thing that took the
 * device back was the 30-minute lease TTL — reproduced on hardware by
 * `deploy/verify-failure.mjs --only=abandon`.
 *
 * The negative cases below are the ones worth having. A sweep that ends too much is far worse than
 * the gap it closes: it would kill live suites mid-run, and it would do it most often to the slowest
 * command in the slowest test, which is exactly the one someone is trying to debug.
 */
describe('idle WebDriver sweep', () => {
  /** Put a session's last command in the past, as a client that stopped driving would leave it. */
  const backdate = (sessionId: string, seconds: number) => withSystem(async (c) => {
    await c.query(
      `UPDATE webdriver_sessions SET last_command_at = now() - make_interval(secs => $2)
        WHERE session_id = $1`, [sessionId, seconds]);
  });

  /** A session with a webdriver_sessions row, which is what makes it sweepable at all. */
  async function webdriverSession(orgId: string) {
    const [dev] = await seedDevices(1);
    const a = await allocate({ orgId, userId: null, region: REGION, platform: 'android' });
    assert.ok(a.deviceId, 'fixture needs a device');
    await activate(orgId, a.sessionId, a.fence!);
    await withSystem(async (c) => {
      await c.query(
        `INSERT INTO webdriver_sessions (session_id, org_id, device_id, upstream_session_id, upstream_base_url)
         VALUES ($1, $2, $3, 'upstream-1', 'http://127.0.0.1:4723')`,
        [a.sessionId, orgId, a.deviceId]);
    });
    return { ...a, seededDevice: dev };
  }

  const stateOf = (sessionId: string) => withSystem(async (c) =>
    (await c.query('SELECT state, end_reason FROM sessions WHERE id = $1', [sessionId])).rows[0]);
  const deviceState = (deviceId: string) => withSystem(async (c) =>
    (await c.query('SELECT state FROM devices WHERE id = $1', [deviceId])).rows[0].state);

  test('a session whose client stopped driving is ended, and its device goes to CLEANING', async () => {
    await resetFleet();
    const s = await webdriverSession(orgA);
    await backdate(s.sessionId, 3600);

    const r = await reap();
    assert.equal(r.idleEnded, 1, 'the idle session should have been counted');

    const row = await stateOf(s.sessionId);
    assert.equal(row.state, 'ENDED');
    // NOT 'timeout'. The lease running out and the client vanishing are different events with
    // different fixes, and a support question that cannot tell them apart gets a guess.
    assert.equal(row.end_reason, 'idle_timeout');

    // CLEANING, never READY: this path exists for sessions that ended badly, which are precisely
    // the ones most likely to have left something on the device.
    assert.equal(await deviceState(s.deviceId!), 'CLEANING');
  });

  test('a session that issued a command recently is LEFT ALONE', async () => {
    await resetFleet();
    const s = await webdriverSession(orgA);
    // Well inside the default 600s window — a suite between two commands, or mid-command.
    await backdate(s.sessionId, 30);

    const r = await reap();
    assert.equal(r.idleEnded, 0, 'a live suite must never be swept');
    assert.equal((await stateOf(s.sessionId)).state, 'ACTIVE');
    assert.equal(await deviceState(s.deviceId!), 'SESSION_ACTIVE');
  });

  test('a session with no webdriver_sessions row is never swept, however old', async () => {
    await resetFleet();
    const [dev] = await seedDevices(1);
    const a = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    await activate(orgA, a.sessionId, a.fence!);
    assert.equal(dev, a.deviceId);

    // `mfarm run --no-webdriver` allocates a device for something speaking the raw data plane. It
    // produces no WebDriver commands at all, so a sweep keyed on command activity would see every
    // such session as permanently idle and end it instantly. Its lifecycle belongs to the CLI.
    const r = await reap();
    assert.equal(r.idleEnded, 0);
    assert.equal((await stateOf(a.sessionId)).state, 'ACTIVE', 'a raw data-plane lease is not idle');
  });

  test('the threshold is configurable, and the knob is read per sweep', async () => {
    await resetFleet();
    const s = await webdriverSession(orgA);
    await backdate(s.sessionId, 60);

    // 60s idle is not enough at the default 600s...
    assert.equal((await reap()).idleEnded, 0);

    // ...and is enough at 30s. Read INSIDE the sweep rather than at module scope, which is the trap
    // `hostSilenceMs` documents: ES imports are hoisted, so a module-scope read has already happened
    // before a test can set the variable.
    const prev = process.env.WEBDRIVER_IDLE_TIMEOUT_MS;
    process.env.WEBDRIVER_IDLE_TIMEOUT_MS = '30000';
    try {
      assert.equal((await reap()).idleEnded, 1);
    } finally {
      if (prev === undefined) delete process.env.WEBDRIVER_IDLE_TIMEOUT_MS;
      else process.env.WEBDRIVER_IDLE_TIMEOUT_MS = prev;
    }
  });

  test('the app pool cannot execute the sweep', async () => {
    // Invariant 4: fleet-wide definer mutations must be unreachable from the tenant pool, and
    // Postgres grants EXECUTE to PUBLIC by default — never having granted it is not the same as it
    // being unreachable.
    await assert.rejects(
      () => withAppUnscoped(async (c) =>
        c.query("SELECT expire_idle_webdriver_sessions(make_interval(secs => 1))")),
      /permission denied/i,
    );
  });
});


/**
 * ALLOCATION BY CLASS — migration 037.
 *
 * The console's primary action reads "Start MFARM X1 Pro". Until 037 the allocator matched on
 * region, platform, tier and capabilities and had never matched on profile, so on a farm whose
 * devices share a tier that button could hand you a different device entirely and say nothing.
 * These tests are the promise, on both paths that can keep it or break it.
 */
describe('allocating a device class', () => {
  test('a named class allocates only that class', async () => {
    await resetFleet();
    const [pro] = await seedProfiled('mfarm-x1-pro');
    await seedProfiled('mfarm-x1');
    await seedProfiled(null);

    const a = await allocate({
      orgId: orgA, userId: null, region: REGION, platform: 'android', tier: 'cuttlefish',
      profile: 'mfarm-x1-pro', matchProfile: true,
    });
    assert.equal(a.deviceId, pro, 'asked for an X1 Pro and must get the X1 Pro');
  });

  /**
   * THE CASE THAT LOOKS HARDEST TO NOTICE, and the reason `matchProfile` is a second field.
   *
   * "No profile" is a class somebody can genuinely ask for — this farm has unprofiled devices and
   * the picker offers them. With a single nullable parameter that request is indistinguishable
   * from "any device at all", so pressing "Start Unprofiled device" would allocate an X1 Pro: a
   * nicer device than was asked for, still not the one the button named, and the kind of wrong
   * that never generates a complaint.
   */
  test('the unprofiled devices are themselves a class you can ask for', async () => {
    await resetFleet();
    await seedProfiled('mfarm-x1-pro');
    const [plain] = await seedProfiled(null);

    const a = await allocate({
      orgId: orgA, userId: null, region: REGION, platform: 'android', tier: 'cuttlefish',
      profile: null, matchProfile: true,
    });
    assert.equal(a.deviceId, plain, 'null profile with matchProfile means the unprofiled class');
  });

  /**
   * QUEUED RATHER THAN SUBSTITUTED, which is the whole behaviour the copy promises: "The farm picks
   * a free MFARM X1 Pro. If none is free when you press this, you will be queued."
   */
  test('no free device of that class queues instead of handing over another', async () => {
    await resetFleet();
    await seedProfiled('mfarm-x1');      // free, and the wrong class
    await seedProfiled(null);            // free, and also the wrong class

    const a = await allocate({
      orgId: orgA, userId: null, region: REGION, platform: 'android', tier: 'cuttlefish',
      profile: 'mfarm-x1-pro', matchProfile: true,
    });
    assert.equal(a.state, 'QUEUED');
    assert.equal(a.deviceId, null, 'two devices were free and neither was the one asked for');
  });

  /**
   * THE SLOWER PATH IS THE ONE SOMEBODY IS ACTUALLY WAITING ON.
   *
   * `promote_queued` re-runs the decision minutes later off `sessions.constraints`. A constraint
   * honoured at allocate time and dropped at promotion time is worse than no constraint: it holds
   * only while you are watching, and breaks precisely when you have gone to make coffee.
   */
  test('promotion off the queue honours the class too', async () => {
    await resetFleet();
    await seedProfiled('mfarm-x1');
    const queued = await allocate({
      orgId: orgA, userId: null, region: REGION, platform: 'android', tier: 'cuttlefish',
      profile: 'mfarm-x1-pro', matchProfile: true,
    });
    assert.equal(queued.state, 'QUEUED');

    // A device of the WRONG class turns up free. Nothing should move.
    await seedProfiled('mfarm-x1');
    assert.equal((await reap()).promoted, 0, 'a free X1 must not satisfy a request for an X1 Pro');

    // The right one turns up.
    const [pro] = await seedProfiled('mfarm-x1-pro');
    assert.equal((await reap()).promoted, 1);

    const row = await withTenant(orgA, async (c) =>
      (await c.query('SELECT device_id FROM sessions WHERE id = $1', [queued.sessionId])).rows[0]);
    assert.equal(row.device_id, pro, 'promoted onto the class it queued for');
  });

  /**
   * EVERY EXISTING CALLER IS UNCHANGED, which is what makes this migration safe to deploy ahead of
   * the console that uses it. The CLI and the WebDriver hub want any device they can drive and pass
   * neither field; `matchProfile` is false and the predicate collapses.
   */
  test('a caller that says nothing about class still gets any device', async () => {
    await resetFleet();
    await seedProfiled('mfarm-x1-pro');
    const a = await allocate({
      orgId: orgA, userId: null, region: REGION, platform: 'android', tier: 'cuttlefish',
    });
    assert.ok(a.deviceId, 'the hub and the CLI allocate exactly what they allocated before');
  });

  /**
   * THE EIGHT-ARGUMENT SIGNATURE STILL EXISTS, and this is the test for the deploy window rather
   * than for a feature.
   *
   * `mfarm-deploy.sh` applies migrations and THEN restarts the API, so for a few seconds the OLD
   * code serves against the NEW schema — and it calls `allocate_device` with eight arguments. The
   * same shape is what a rollback looks like, permanently: the deploy script promises "rollback is
   * this same command with an older sha" and states that migrations do not roll back, so a dropped
   * signature turns a rollback into a farm that cannot allocate at all.
   *
   * Called as raw SQL rather than through `allocate()`, because `allocate()` passes ten arguments
   * by construction and therefore cannot exercise the path this is about.
   */
  test('the previous eight-argument signature still allocates — the deploy window and rollback', async () => {
    await resetFleet();
    const [pro] = await seedProfiled('mfarm-x1-pro');

    const row = await withTenant(orgA, async (c) => {
      const { rows } = await c.query(
        `SELECT o_device_id AS device_id, o_state AS state
           FROM allocate_device($1, NULL, $2, 'android', 'cuttlefish',
                                make_interval(mins => 30), '{}'::jsonb, '[]'::jsonb)`,
        [orgA, REGION],
      );
      return rows[0];
    });

    assert.equal(row.state, 'ALLOCATING');
    assert.equal(row.device_id, pro, 'the old signature still hands over a device');
  });
});

/**
 * Migration 043: a queued caller is told where they stand.
 *
 * `POST /v1/sessions` used to answer "No device is free right now" and nothing else, and `mfarm
 * run` then printed "waiting up to 300s". Over fifteen minutes of a CI log that is
 * indistinguishable from a hang, and a person who cannot tell the difference kills the job.
 *
 * THE PROPERTY THAT MATTERS is not that a number is returned — it is that the number matches how
 * the queue actually drains. ADR-0028 made promotion round-robin across orgs, so a position derived
 * from a global `created_at` rank would be the obvious implementation and would now disagree with
 * the scheduler. A queue position that does not match the queue is worse than none, because a
 * person plans around it.
 */
describe('a queued caller is told where they stand', () => {
  test('position counts the way the queue drains, not by arrival time', async () => {
    await resetFleet();
    await seedDevices(1);
    await withSystem((c) => c.query('UPDATE orgs SET max_concurrent = 1 WHERE id = $1', [orgA]));

    const held = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    assert.ok(held.deviceId);

    // A queues three, sequentially so they have a defined order. B queues one, LAST.
    const a1 = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    const a2 = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    const a3 = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    const b1 = await allocate({ orgId: orgB, userId: null, region: REGION, platform: 'android' });
    for (const r of [a1, a2, a3, b1]) assert.equal(r.deviceId, null, 'all four should queue');

    const posA1 = await queueStanding(orgA, a1.sessionId);
    const posA2 = await queueStanding(orgA, a2.sessionId);
    const posA3 = await queueStanding(orgA, a3.sessionId);
    const posB1 = await queueStanding(orgB, b1.sessionId);

    /**
     * B ARRIVED FOURTH AND IS SECOND. That is the whole assertion.
     *
     * Under ADR-0028 the promotion order is (rank 1: A's first, B's first), then (rank 2: A's
     * second), then (rank 3: A's third). A position by arrival time would say B is 4th — a number
     * that would have been right before ADR-0028 and is now a lie the scheduler contradicts.
     */
    assert.equal(posA1?.position, 1, "A's oldest is next");
    assert.equal(posB1?.position, 2, 'B arrived last and is second — its own first lap');
    assert.equal(posA2?.position, 3);
    assert.equal(posA3?.position, 4);

    // `ahead` is `position - 1`, said plainly so a caller need not do the arithmetic.
    assert.equal(posB1?.ahead, 1);

    await withSystem((c) => c.query('UPDATE orgs SET max_concurrent = 100 WHERE id = $1', [orgA]));
  });

  test('a caller cannot ask about a session that is not theirs', async () => {
    await resetFleet();
    await seedDevices(1);
    await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    const queued = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    assert.equal(queued.deviceId, null);

    /**
     * `queue_standing` is SECURITY DEFINER and `mfarm_definer` has BYPASSRLS, so RLS does not scope
     * it — the function has to. Same rule migration 041 shipped a cross-tenant write by missing,
     * checked here rather than assumed for the same reason.
     */
    assert.equal(await queueStanding(orgB, queued.sessionId), null,
      "another org must not learn even that a session exists, let alone where it stands");
    assert.ok(await queueStanding(orgA, queued.sessionId), 'the owner gets an answer');
  });

  test('a session that is no longer queued has no standing, and that is not an error', async () => {
    await resetFleet();
    await seedDevices(1);
    const live = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    assert.ok(live.deviceId);

    // A session promoted between a caller's poll and this call is the ORDINARY case, not a fault —
    // it is what happens every time the wait ends successfully.
    assert.equal(await queueStanding(orgA, live.sessionId), null);
    assert.equal(await queueStanding(orgA, randomUUID()), null, 'and neither is a session that never was');
  });

  test('the estimate is null rather than guessed when no lease can be read', async () => {
    await resetFleet();
    await seedDevices(1);
    const held = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    const queued = await allocate({ orgId: orgA, userId: null, region: REGION, platform: 'android' });
    assert.equal(queued.deviceId, null);

    // With a lease on the device ahead, an estimate can be proved.
    const withLease = await queueStanding(orgA, queued.sessionId);
    assert.ok(withLease?.estimatedStartAt instanceof Date, 'a readable lease gives an estimate');

    // Without one, nothing can be. **A confident wrong number is what makes people stop trusting a
    // queue**, so this reports null and the API omits the field entirely.
    await withSystem((c) => c.query(
      'UPDATE sessions SET expires_at = NULL WHERE id = $1', [held.sessionId]));
    assert.equal((await queueStanding(orgA, queued.sessionId))?.estimatedStartAt, null,
      'unknown is reported as unknown, never as a guess');
  });

  test('the estimate reads a device of the class asked for, not any device at all', async () => {
    await resetFleet();
    // Two classes — `avd` is a real tier in this schema and `emulator` is not, which the CHECK on
    // `devices.tier` said plainly the first time this test was run. The tier the caller did NOT ask
    // for is held under a lease expiring far sooner, so a class-blind estimate would quote it and
    // be confidently early — the exact failure mode that makes people stop trusting a queue.
    const [other] = await withSystem(async (c) => (await c.query(
      `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities)
       VALUES ($1,$2,'android','avd','sdk_gphone','15','READY','[]'::jsonb) RETURNING id`,
      [host, REGION])).rows.map((r) => r.id));
    await seedDevices(1);

    const cuttlefish = await allocate({
      orgId: orgA, userId: null, region: REGION, platform: 'android', tier: 'cuttlefish' });
    assert.ok(cuttlefish.deviceId, 'the cuttlefish is held');
    const avd = await allocate({
      orgId: orgA, userId: null, region: REGION, platform: 'android', tier: 'avd' });
    assert.equal(avd.deviceId, other, 'and so is the avd');

    // The avd frees far sooner. A class-blind estimate would quote it.
    await withSystem((c) => c.query(
      "UPDATE sessions SET expires_at = now() + interval '1 minute' WHERE id = $1", [avd.sessionId]));
    await withSystem((c) => c.query(
      "UPDATE sessions SET expires_at = now() + interval '30 minutes' WHERE id = $1", [cuttlefish.sessionId]));

    const queued = await allocate({
      orgId: orgA, userId: null, region: REGION, platform: 'android', tier: 'cuttlefish' });
    assert.equal(queued.deviceId, null);

    const standing = await queueStanding(orgA, queued.sessionId);
    const minutes = (standing!.estimatedStartAt!.getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 20,
      `a device that could not serve this session is not a device whose lease counts (got ${minutes.toFixed(1)}m)`);
  });
});
