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
