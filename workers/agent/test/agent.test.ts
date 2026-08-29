/**
 * Worker agent integration tests.
 *
 * Runs against the REAL control plane bound to a real port — not a stub. The agent talks to it with
 * fetch(), so a stub would test the stub's idea of the protocol rather than the protocol. The whole
 * point of these tests is that the two halves agree.
 */
process.env.WORKER_REGISTRATION_TOKEN = 'agent-test-registration-secret';
process.env.RATE_LIMIT_MAX = '10000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '@mfarm/api/server';
import { withSystem, closePools } from '@mfarm/api/db';
import { createApiKey } from '@mfarm/api/auth';
import { TOKEN_ALG } from '@mfarm/protocol';
import { Agent, deterministicUuid } from '../src/agent.ts';
import { DataPlane } from '../src/dataplane.ts';
import { AgentTunnel } from '../src/tunnel.ts';
import type { DeviceBackend, DeviceControl, DeviceHealth, DeviceInfo } from '../src/device.ts';

const REGION = 'agent-test';

let app: FastifyInstance;
let baseUrl: string;
let orgId: string;
let tenantKey: string;
let stateDir: string;

/**
 * In-memory device. Records what it was asked to do so tests can assert on ordering — particularly
 * that a reset actually completes before the device is reported free.
 */
class FakeDevice implements DeviceControl {
  readonly info: DeviceInfo;
  readonly calls: string[] = [];
  resetDurationMs = 0;
  failNextReset = false;

  constructor(localId = 'fake-1') {
    this.info = {
      localId, platform: 'android', tier: 'cuttlefish', model: 'fake', osVersion: '15',
      capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset'],
      screen: { width: 720, height: 1280, density: 320 },
      // Deliberately unlike the local id — B3 is precisely the two being confused.
      adbSerial: `0.0.0.0:adb-${localId}`,
    };
  }
  async start() { this.calls.push('start'); }
  async stop() { this.calls.push('stop'); }
  async resetToSnapshot() {
    if (this.failNextReset) { this.failNextReset = false; this.calls.push('reset:failed'); throw new Error('snapshot restore failed'); }
    if (this.resetDurationMs) await new Promise((r) => setTimeout(r, this.resetDurationMs));
    this.calls.push('reset');
  }
  async tap(x: number, y: number) { this.calls.push(`tap:${x},${y}`); }
  async swipe(x1: number, y1: number, x2: number, y2: number, d: number) { this.calls.push(`swipe:${x1},${y1},${x2},${y2},${d}`); }
  async key(name: string) { this.calls.push(`key:${name}`); }
  async text(v: string) { this.calls.push(`text:${v}`); }
  async health(): Promise<DeviceHealth> { return { status: 'healthy', inputLatencyMs: 1 }; }
}

/**
 * A device that can do the viewer things, and a signalling server that answers like the operator.
 *
 * Separate from FakeDevice because the honest default is a device that CANNOT: most of this suite
 * asserts on a plain Cuttlefish-shaped stub, and giving every one of them a live view would hide the
 * refusal paths that matter most here.
 */
class ViewableDevice extends FakeDevice {
  logcatRunning = 0;
  screenshotFails = false;
  dumpFails = false;
  dumpText = '01-01 00:00:00.000  1  1 I Boot: hello\n';
  private emit?: (line: string) => void;

  async dumpLogcat() {
    this.calls.push('dumpLogcat');
    if (this.dumpFails) throw new Error('adb: device offline');
    return this.dumpText;
  }

  async captureLogcat(onLine: (line: string) => void) {
    this.logcatRunning += 1;
    this.emit = onLine;
    return { stop: () => { this.logcatRunning -= 1; this.emit = undefined; } };
  }
  say(line: string) { this.emit?.(line); }
  async screenshot() {
    // Recorded like every other verb: without this the call log cannot show that the capture
    // happened BEFORE the reset, which is the property the artifact tests exist to pin.
    this.calls.push('screenshot');
    if (this.screenshotFails) throw new Error('screencap did not return a PNG');
    return { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' };
  }
}

class FakeSignalServer {
  opened = 0;
  closed = 0;
  refuse?: string;
  readonly sent: unknown[] = [];
  private onPayload?: (p: unknown) => void;

  channel = async (h: { onPayload: (p: unknown) => void; onClose: (r: string) => void }) => {
    if (this.refuse) throw new Error(this.refuse);
    this.opened += 1;
    this.onPayload = h.onPayload;
    return {
      deviceInfo: { hardware: { cpus: 8 } },
      iceServers: [{ urls: 'stun:operator.local:3478' }],
      send: (p: unknown) => { this.sent.push(p); },
      close: () => { this.closed += 1; },
    };
  };
  /** Play the device's half of the negotiation. */
  fromDevice(payload: unknown) { this.onPayload?.(payload); }
}

function viewableBackend(localId = 'view-1') {
  const control = new ViewableDevice(localId);
  control.info.capabilities = [...control.info.capabilities, 'logcat', 'screenshot'];
  const signals = new FakeSignalServer();
  return {
    control,
    signals,
    media: {
      async endpoint() { return { url: 'https://cf.example/?d=1', kind: 'webrtc' as const }; },
      signal: signals.channel,
    },
  };
}

function fakeBackend(localId = 'fake-1'): DeviceBackend & { control: FakeDevice } {
  const control = new FakeDevice(localId);
  return { control, media: { async endpoint() { return { url: 'https://cf.example/?d=1', kind: 'webrtc' as const }; } } };
}

const makeAgent = (
  backends: DeviceBackend[],
  hostname: string,
  extra: {
    automationEndpoint?: string;
    automationEndpoints?: Record<string, string>;
    endpoint?: string;
  } = {},
) =>
  new Agent({
    controlPlaneUrl: baseUrl,
    registrationToken: 'agent-test-registration-secret',
    hostname, region: REGION,
    endpoint: 'wss://agent-test.example:8080',
    devices: backends,
    statePath: join(stateDir, `${hostname}.json`),
    cores: 8, memoryMb: 16384,
    ...extra,
  });

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'mfarm-agent-'));
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Agent Test') ON CONFLICT DO NOTHING`, [REGION]);
    orgId = (await c.query(`INSERT INTO orgs (slug,name,max_concurrent)
                            VALUES ('agent-org','Agent',50) RETURNING id`)).rows[0].id;
  });
  tenantKey = (await createApiKey(orgId)).plaintext;
  app = await buildServer({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM artifacts WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM metering_events WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM sessions WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM devices WHERE region = $1', [REGION]);
    await c.query('DELETE FROM api_keys WHERE org_id = $1', [orgId]);
    await c.query('DELETE FROM hosts WHERE region = $1', [REGION]);
    await c.query('DELETE FROM orgs WHERE id = $1', [orgId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
  await rm(stateDir, { recursive: true, force: true });
});

describe('registration', () => {
  test('registers, receives a credential, and persists it', async () => {
    const agent = makeAgent([fakeBackend()], `reg-${randomUUID().slice(0, 8)}`);
    const state = await agent.start();
    assert.ok(state.hostId, 'host id assigned');
    assert.ok(state.workerToken.startsWith('mwk_'), 'worker credential issued');
    assert.ok(state.sessionPublicKey.includes('PUBLIC KEY'), 'public key for offline verification');
    // The private half must never leave the control plane.
    assert.ok(!state.sessionPublicKey.includes('PRIVATE'), 'worker must never receive the signing key');
    await agent.shutdown();
  });

  test('reuses a persisted credential across a restart', async () => {
    const host = `restart-${randomUUID().slice(0, 8)}`;
    const first = makeAgent([fakeBackend()], host);
    const s1 = await first.start();
    await first.shutdown();

    const second = makeAgent([fakeBackend()], host);
    const s2 = await second.start();
    assert.equal(s2.workerToken, s1.workerToken, 'a restart must not churn credentials');
    assert.equal(s2.hostId, s1.hostId);
    await second.shutdown();
  });

  test('re-registers when the stored credential is rejected', async () => {
    const host = `revoked-${randomUUID().slice(0, 8)}`;
    const agent = makeAgent([fakeBackend()], host);
    const s1 = await agent.start();
    await agent.shutdown();

    // Simulate the host being rebuilt or its token rotated elsewhere.
    await withSystem((c) => c.query(`UPDATE hosts SET token_hash = 'invalidated' WHERE id = $1`, [s1.hostId]));

    const revived = makeAgent([fakeBackend()], host);
    const s2 = await revived.start();
    assert.notEqual(s2.workerToken, s1.workerToken, 'must obtain a fresh credential, not sit offline');
    await revived.shutdown();
  });

  test('a device missing snapshot-reset is registered but withheld from scheduling', async () => {
    const b = fakeBackend('no-reset');
    b.control.info.capabilities = ['screen-stream', 'input-datachannel'];
    const agent = makeAgent([b], `nores-${randomUUID().slice(0, 8)}`);
    await agent.start();
    const state = await withSystem(async (c) =>
      (await c.query('SELECT state FROM devices WHERE local_id = $1', ['no-reset'])).rows[0]?.state);
    assert.equal(state, 'OFFLINE', 'never allocatable — it would leak the previous tenant');
    await agent.shutdown();
  });
});

describe('heartbeat', () => {
  test('reports host state so a quarantined host learns to drain', async () => {
    const agent = makeAgent([fakeBackend()], `hb-${randomUUID().slice(0, 8)}`);
    const state = await agent.start();
    assert.equal((await agent.heartbeat()).hostState, 'UP');

    await withSystem((c) => c.query(`SELECT quarantine_host($1,'test')`, [state.hostId]));
    assert.equal((await agent.heartbeat()).hostState, 'QUARANTINED',
      'the agent must be told, not left serving a drained host');
    await agent.shutdown();
  });
});

describe('metering', () => {
  test('event ids are deterministic, so a crash cannot double-bill', () => {
    // The property that matters: same session + same tick => same id, always.
    assert.equal(deterministicUuid('sess-1:0'), deterministicUuid('sess-1:0'));
    assert.notEqual(deterministicUuid('sess-1:0'), deterministicUuid('sess-1:1'));
    assert.match(deterministicUuid('x'), /^[0-9a-f-]{36}$/);
  });

  test('device-seconds accumulate and flush', async () => {
    const agent = makeAgent([fakeBackend()], `meter-${randomUUID().slice(0, 8)}`);
    const state = await agent.start();
    const sessionId = randomUUID();

    // A real device row: metering_events.device_id is a foreign key, so a synthetic uuid would fail
    // the insert and mask what this test is actually checking.
    const deviceId = await withSystem(async (c) => {
      const d = await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, local_id)
         VALUES ($1,$2,'android','cuttlefish','fake','15','READY',$3) RETURNING id`,
        [state.hostId, REGION, `meter-dev-${randomUUID().slice(0, 8)}`]);
      await c.query(
        `INSERT INTO sessions (id, org_id, state, region, device_id) VALUES ($1,$2,'ACTIVE',$3,$4)`,
        [sessionId, orgId, REGION, d.rows[0].id]);
      return d.rows[0].id as string;
    });

    agent.beginSession(sessionId, deviceId, orgId);
    await new Promise((r) => setTimeout(r, 250));
    agent.endSession(sessionId);
    assert.ok(agent.bufferedEventCount > 0, 'usage buffered');

    const { ok } = await agent.flush();
    assert.equal(ok, true);
    assert.equal(agent.bufferedEventCount, 0, 'buffer clears only on a confirmed flush');

    const total = await withSystem(async (c) =>
      (await c.query(`SELECT coalesce(sum(quantity),0)::float8 AS t FROM metering_events WHERE session_id = $1`,
        [sessionId])).rows[0].t);
    assert.ok(total > 0, `recorded ${total} device-seconds`);
    await agent.shutdown();
  });

  test('a failed flush retains events for the next attempt', async () => {
    const agent = new Agent({
      controlPlaneUrl: 'http://127.0.0.1:1',   // nothing listening
      registrationToken: 'x', hostname: 'unreachable', region: REGION,
      endpoint: 'wss://x', devices: [fakeBackend()],
      statePath: join(stateDir, 'unreachable.json'),
    });
    agent.beginSession(randomUUID(), randomUUID(), orgId);
    await new Promise((r) => setTimeout(r, 120));
    const { ok } = await agent.flush();
    assert.equal(ok, false, 'flush fails when the control plane is unreachable');
    assert.ok(agent.bufferedEventCount > 0, 'usage must survive to be billed later, not be dropped');
  });

  test('a replayed batch does not double-count', async () => {
    const agent = makeAgent([fakeBackend()], `dup-${randomUUID().slice(0, 8)}`);
    const state = await agent.start();
    const sessionId = randomUUID();
    // The session has to sit on a device of THIS host: since migration 008 the control plane bills
    // by joining the event's session to a device and checking whose hardware it is, so a session
    // floating free of any device is refused rather than charged to whoever asked.
    const deviceId = await withSystem(async (c) => {
      const d = await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, local_id)
         VALUES ($1,$2,'android','cuttlefish','fake','15','SESSION_ACTIVE',$3) RETURNING id`,
        [state.hostId, REGION, `dup-dev-${randomUUID().slice(0, 8)}`]);
      await c.query(
        `INSERT INTO sessions (id, org_id, state, region, device_id) VALUES ($1,$2,'ACTIVE',$3,$4)`,
        [sessionId, orgId, REGION, d.rows[0].id]);
      return d.rows[0].id as string;
    });

    const event = {
      eventId: deterministicUuid(`${sessionId}:0`), orgId, sessionId, deviceId,
      kind: 'device_seconds', quantity: 30, occurredAt: new Date().toISOString(),
    };
    const post = () => fetch(`${baseUrl}/v1/workers/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ metering: [event] }),
    }).then((r) => r.json() as Promise<{ meteringRecorded: number }>);

    assert.equal((await post()).meteringRecorded, 1);
    assert.equal((await post()).meteringRecorded, 0, 'the retry is absorbed, not billed again');
    await agent.shutdown();
  });
});

describe('reset and release', () => {
  test('the device is reported free only after the restore completes', async () => {
    const b = fakeBackend();
    b.control.resetDurationMs = 120;
    const agent = makeAgent([b], `reset-${randomUUID().slice(0, 8)}`);
    const registered = await agent.start();

    // This host's own device. A worker can only confirm a restore for hardware it owns (migration
    // 008), and picking whichever host in the region answered first used to work by accident.
    const deviceId = await withSystem(async (c) => {
      const host = registered.hostId;
      return (await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, fence, local_id)
         VALUES ($1,$2,'android','cuttlefish','fake','15','CLEANING',1,$3) RETURNING id`,
        [host, REGION, `reset-dev-${randomUUID().slice(0, 8)}`])).rows[0].id;
    });

    await agent.resetAndRelease(b, deviceId, 1);

    assert.deepEqual(b.control.calls, ['reset'], 'restore ran');
    const state = await withSystem(async (c) =>
      (await c.query('SELECT state FROM devices WHERE id = $1', [deviceId])).rows[0].state);
    assert.equal(state, 'READY', 'returned to the pool only after a completed restore');
    await agent.shutdown();
  });

  test('a failed restore does not return the device to the pool', async () => {
    const b = fakeBackend();
    b.control.failNextReset = true;
    const agent = makeAgent([b], `resetfail-${randomUUID().slice(0, 8)}`);
    const registered = await agent.start();

    const deviceId = await withSystem(async (c) => {
      const host = registered.hostId;
      return (await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, fence, local_id)
         VALUES ($1,$2,'android','cuttlefish','fake','15','CLEANING',1,$3) RETURNING id`,
        [host, REGION, `fail-dev-${randomUUID().slice(0, 8)}`])).rows[0].id;
    });

    await assert.rejects(() => agent.resetAndRelease(b, deviceId, 1), /snapshot restore failed/);
    const state = await withSystem(async (c) =>
      (await c.query('SELECT state FROM devices WHERE id = $1', [deviceId])).rows[0].state);
    assert.equal(state, 'CLEANING', 'a device that could not be wiped must stay out of the pool');
    await agent.shutdown();
  });

  /**
   * The gap B8 found: everything above called `resetAndRelease` directly, and NOTHING IN THE WORKER
   * DID. The control plane parked a released device in CLEANING and waited for a confirmation no
   * code path produced, so a farm served one session per device and then answered `no_capacity`
   * for good (HANDOFF.md issue 16). These two tests are the ones that would have caught it.
   */
  test('a heartbeat carries the reset request, and the agent acts on it', async () => {
    const b = fakeBackend(`hb-${randomUUID().slice(0, 8)}`);
    const agent = makeAgent([b], `hbreset-${randomUUID().slice(0, 8)}`);
    const registered = await agent.start();
    const deviceId = registered.deviceIds[b.control.info.localId];
    assert.ok(deviceId, 'registration must return the device uuid, or nothing can be matched to a backend');

    // Exactly what releasing a session does: CLEANING, with the fence the allocation carried.
    await withSystem(async (c) =>
      c.query(`UPDATE devices SET state = 'CLEANING', fence = 1 WHERE id = $1`, [deviceId]));

    assert.equal((await agent.heartbeat()).ok, true);

    // The reset is deliberately not awaited inside the beat — a slow restore must not make a live
    // host look dead — so poll the OUTCOME rather than the call log. The device is only back in the
    // pool once the confirmation has been flushed, which is a step later than the restore itself.
    let state = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && state !== 'READY') {
      state = await withSystem(async (c) =>
        (await c.query('SELECT state FROM devices WHERE id = $1', [deviceId])).rows[0].state);
      if (state !== 'READY') await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(b.control.calls.includes('reset'), 'the heartbeat request never reached the device');
    assert.equal(state, 'READY', 'the restore was confirmed and the device went back into the pool');
    await agent.shutdown();
  });

  /**
   * Artifacts (migration 019). A device entering CLEANING is the only "a session ended" signal a
   * worker gets for a WebDriver run, so it is where evidence has to be collected — and it has to be
   * collected BEFORE the reset, because the reset is what destroys it.
   */
  test('the agent captures a screenshot and a logcat before resetting', async () => {
    const b = viewableBackend(`art-${randomUUID().slice(0, 8)}`);
    const agent = makeAgent([b as unknown as DeviceBackend], `hbart-${randomUUID().slice(0, 8)}`);
    const registered = await agent.start();
    const deviceId = registered.deviceIds[b.control.info.localId];

    const sessionId = await withSystem(async (c) => {
      const ses = (await c.query(
        `INSERT INTO sessions (org_id, device_id, state, region, fence, started_at, ended_at)
         VALUES ($1,$2,'ENDED',$3,1, now(), now()) RETURNING id`,
        [orgId, deviceId, REGION])).rows[0].id;
      await c.query(`UPDATE devices SET state = 'CLEANING', fence = 1 WHERE id = $1`, [deviceId]);
      return ses as string;
    });

    await agent.heartbeat();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !b.control.calls.includes('reset')) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const shotAt = b.control.calls.indexOf('screenshot');
    const dumpAt = b.control.calls.indexOf('dumpLogcat');
    const resetAt = b.control.calls.indexOf('reset');
    assert.ok(shotAt >= 0 && dumpAt >= 0, `nothing was captured: ${b.control.calls.join(',')}`);
    assert.ok(shotAt < resetAt, 'the screenshot must be taken before the device is wiped');
    assert.ok(dumpAt < resetAt, 'the log must be dumped before the device is wiped');

    const rows = await withSystem(async (c) => (await c.query<{ kind: string }>(
      'SELECT kind FROM artifacts WHERE session_id = $1 ORDER BY kind', [sessionId])).rows);
    assert.deepEqual(rows.map((r) => r.kind), ['logcat', 'screenshot']);
    await agent.shutdown();
  });

  test('a capture that fails does not stop the device being reset', async () => {
    // THE INVARIANT. On a two-device farm, a device stuck in CLEANING over a missing screenshot is
    // half the fleet — so every failure in the capture path is swallowed, and the reset proceeds.
    const b = viewableBackend(`artfail-${randomUUID().slice(0, 8)}`);
    b.control.screenshotFails = true;
    b.control.dumpFails = true;
    const agent = makeAgent([b as unknown as DeviceBackend], `hbartfail-${randomUUID().slice(0, 8)}`);
    const registered = await agent.start();
    const deviceId = registered.deviceIds[b.control.info.localId];

    await withSystem(async (c) => {
      await c.query(
        `INSERT INTO sessions (org_id, device_id, state, region, fence, started_at, ended_at)
         VALUES ($1,$2,'ENDED',$3,1, now(), now())`, [orgId, deviceId, REGION]);
      await c.query(`UPDATE devices SET state = 'CLEANING', fence = 1 WHERE id = $1`, [deviceId]);
    });

    await agent.heartbeat();

    let state = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && state !== 'READY') {
      state = await withSystem(async (c) =>
        (await c.query('SELECT state FROM devices WHERE id = $1', [deviceId])).rows[0].state);
      if (state !== 'READY') await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(state, 'READY', 'a failed capture must never strand a device in CLEANING');
    await agent.shutdown();
  });

  test('a reset with no session attached captures nothing and still resets', async () => {
    // An operator-initiated reset has no run behind it. Inventing a session to file evidence
    // against would attach it to whichever one happened to be nearby.
    const b = viewableBackend(`artnone-${randomUUID().slice(0, 8)}`);
    const agent = makeAgent([b as unknown as DeviceBackend], `hbartnone-${randomUUID().slice(0, 8)}`);
    const registered = await agent.start();
    const deviceId = registered.deviceIds[b.control.info.localId];
    await withSystem(async (c) =>
      c.query(`UPDATE devices SET state = 'CLEANING', fence = 1 WHERE id = $1`, [deviceId]));

    await agent.heartbeat();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !b.control.calls.includes('reset')) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(b.control.calls.includes('reset'));
    assert.ok(!b.control.calls.includes('dumpLogcat'), 'nothing to attach evidence to');
    await agent.shutdown();
  });

  test('a re-sent request does not start a second restore on a device already being restored', async () => {
    const b = fakeBackend(`hb2-${randomUUID().slice(0, 8)}`);
    // Longer than the gap between the two beats below, which is the situation the guard exists for:
    // the control plane re-sends every beat until the state changes, and a restore outlives a beat.
    b.control.resetDurationMs = 300;
    const agent = makeAgent([b], `hbdupe-${randomUUID().slice(0, 8)}`);
    const registered = await agent.start();
    const deviceId = registered.deviceIds[b.control.info.localId];
    await withSystem(async (c) =>
      c.query(`UPDATE devices SET state = 'CLEANING', fence = 1 WHERE id = $1`, [deviceId]));

    await agent.heartbeat();
    await new Promise((r) => setTimeout(r, 50));
    await agent.heartbeat();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !b.control.calls.includes('reset')) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(
      b.control.calls.filter((c) => c === 'reset'),
      ['reset'],
      'a second cvd stop on a device that is mid-restore',
    );
    await agent.shutdown();
  });
});

describe('fencing', () => {
  test('rejects a stale fence and accepts a newer one', () => {
    const agent = makeAgent([fakeBackend()], 'fence-only');
    const dev = randomUUID();
    assert.equal(agent.acceptFence(dev, 5), true);
    assert.equal(agent.acceptFence(dev, 4), false, 'a partitioned client must not drive a reallocated device');
    assert.equal(agent.acceptFence(dev, 5), true, 'a reconnect at the same fence is legitimate');
    assert.equal(agent.acceptFence(dev, 9), true);
    assert.equal(agent.highWater(dev), 9);
  });

  test('high-water marks are per device', () => {
    const agent = makeAgent([fakeBackend()], 'fence-multi');
    const a = randomUUID(), b = randomUUID();
    agent.acceptFence(a, 10);
    assert.equal(agent.acceptFence(b, 1), true, 'one busy device must not gate another');
  });
});

describe('data plane', () => {
  let agent: Agent, dp: DataPlane, port: number, backend: ReturnType<typeof fakeBackend>;

  before(async () => {
    backend = fakeBackend();
    agent = makeAgent([backend], `dp-${randomUUID().slice(0, 8)}`);
    await agent.start();
    dp = new DataPlane({
      agent,
      backends: new Map([[backend.control.info.localId, backend]]),
      resolveDevice: () => backend,
    });
    port = await dp.listen(0);
  });

  after(async () => { await dp.close(); await agent.shutdown(); });

  const connect = () => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

  const nextMessage = (ws: WebSocket) => new Promise<Record<string, unknown>>((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
  });

  /**
   * Mint a real token through the control plane, exactly as a browser would receive one.
   *
   * Earlier tests leave READY devices on other hosts in this region, and the allocator is free to
   * pick any of them — which would mint a token whose audience is a different host and make these
   * tests fail for a reason unrelated to what they check. So: park everything else, leave exactly
   * one allocatable device, and it must be on this host.
   */
  async function realSessionToken() {
    const deviceId = await withSystem(async (c) => {
      await c.query(`UPDATE devices SET state = 'OFFLINE' WHERE region = $1 AND state = 'READY'`, [REGION]);
      await c.query(`UPDATE hosts SET endpoint = 'wss://dp.example' WHERE id = $1`, [agent.hostId]);
      const d = await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id)
         VALUES ($1,$2,'android','cuttlefish','fake','15','READY',
                 '["screen-stream","input-datachannel","snapshot-reset"]'::jsonb, $3)
         RETURNING id`,
        [agent.hostId, REGION, `dp-dev-${randomUUID().slice(0, 8)}`]);
      return d.rows[0].id as string;
    });

    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tenantKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ region: REGION, platform: 'android' }),
    });
    const body = await res.json() as {
      session: { id: string; fence: number; deviceId: string };
      dataPlane: { token: string };
    };
    assert.equal(res.status, 201, `expected an allocation, got ${JSON.stringify(body)}`);
    assert.equal(body.session.deviceId, deviceId, 'must allocate the device on this host');
    return body;
  }

  test('a token minted by the control plane is accepted offline', async () => {
    const created = await realSessionToken();
    const ws = await connect();
    ws.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    const ready = await nextMessage(ws);
    assert.equal(ready.t, 'ready', 'worker verified the signature without calling the API');
    assert.equal(ready.sessionId, created.session.id);
    assert.ok((ready.media as { url: string }).url, 'media endpoint reported');
    ws.close();
  });

  test('a forged token is rejected', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ t: 'hello', token: 'v1.eyJzaWQiOiJmYWtlIn0.AAAA' }));
    const msg = await nextMessage(ws);
    assert.equal(msg.t, 'error');
    assert.equal(msg.code, 'bad_signature');
    ws.close();
  });

  test('input before authentication is refused', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ t: 'tap', x: 1, y: 1, seq: 1 }));
    const msg = await nextMessage(ws);
    assert.equal(msg.code, 'unauthenticated', 'no device action may precede a verified token');
    ws.close();
  });

  test('input reaches the device after authentication', async () => {
    const created = await realSessionToken();
    const ws = await connect();
    ws.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    await nextMessage(ws);

    backend.control.calls.length = 0;
    ws.send(JSON.stringify({ t: 'tap', x: 100, y: 200, seq: 1 }));
    ws.send(JSON.stringify({ t: 'key', name: 'home', seq: 2 }));
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(backend.control.calls, ['tap:100,200', 'key:home']);
    ws.close();
  });

  test('typed characters are never dropped, even sent faster than the device drains', async () => {
    // The regression this guards: with a single in-flight slot and no queue, typing "hello" quickly
    // arrives as "hlo". Discrete input must queue; only positional input may be coalesced.
    const created = await realSessionToken();
    const ws = await connect();
    ws.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    await nextMessage(ws);

    backend.control.calls.length = 0;
    for (const [i, ch] of [...'hello'].entries()) {
      ws.send(JSON.stringify({ t: 'text', value: ch, seq: i + 1 }));
    }
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(backend.control.calls, ['text:h', 'text:e', 'text:l', 'text:l', 'text:o'],
      'every character must arrive, in order');
    ws.close();
  });

  test('positional input is coalesced rather than queued', async () => {
    const created = await realSessionToken();
    const ws = await connect();
    ws.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    await nextMessage(ws);

    backend.control.calls.length = 0;
    // A burst mid-drag. Stale coordinates are worthless, so fewer than all should land.
    for (let i = 1; i <= 20; i++) ws.send(JSON.stringify({ t: 'tap', x: i, y: i, seq: i }));
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(backend.control.calls.length < 20,
      `expected coalescing, got all ${backend.control.calls.length} taps`);
    assert.ok(backend.control.calls.length >= 1, 'at least the first tap must land');
    ws.close();
  });

  test('out-of-order input is dropped, not replayed', async () => {
    const created = await realSessionToken();
    const ws = await connect();
    ws.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    await nextMessage(ws);

    backend.control.calls.length = 0;
    ws.send(JSON.stringify({ t: 'tap', x: 1, y: 1, seq: 5 }));
    await new Promise((r) => setTimeout(r, 60));
    ws.send(JSON.stringify({ t: 'tap', x: 2, y: 2, seq: 3 }));   // late arrival
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(backend.control.calls, ['tap:1,1'], 'a stale coordinate must not be replayed');
    ws.close();
  });

  test('a second hello on one socket is refused', async () => {
    // Re-entering the handshake would restart the metering clock for this session — the customer
    // stops being billed for the seconds already elapsed — and would rebind the socket to whatever
    // device the new token names, without the first one's fence being consulted again.
    const created = await realSessionToken();
    const ws = await connect();
    ws.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    assert.equal((await nextMessage(ws)).t, 'ready');

    ws.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    const msg = await nextMessage(ws);
    assert.equal(msg.t, 'error');
    assert.equal(msg.code, 'already_authenticated');
    ws.close();
  });

  test('a superseded session is rejected on reconnect', async () => {
    const created = await realSessionToken();
    const ws1 = await connect();
    ws1.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    assert.equal((await nextMessage(ws1)).t, 'ready');
    ws1.close();

    // The device is reset and reallocated to someone else while this client is partitioned. The
    // fence moves past the one baked into their token.
    agent.acceptFence(created.session.deviceId, created.session.fence + 1);

    const ws2 = await connect();
    ws2.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    const msg = await nextMessage(ws2);
    assert.equal(msg.code, 'stale_fence', 'the old client must not drive a device given to someone else');
    ws2.close();
  });

  /**
   * A HOSTILE HELLO MUST COST THE SENDER ITS SOCKET AND NOTHING ELSE.
   *
   * This endpoint takes NO credential — deliberately, because the credential is the Ed25519 grant
   * inside the hello, which only the agent can verify. So "whoever sends this" is anyone who can
   * reach the port, and on a published farm that is the internet.
   *
   * `ClientMessage` declares `token: string`. It comes out of JSON.parse. When the field was
   * missing, `verifySessionToken(undefined)` threw inside an async handler, the throw became an
   * unhandledRejection, and index.ts answered the way it answers a broken invariant: drain and
   * exit. One frame took down two Cuttlefish devices, two Appium servers, the automation gateway
   * and the tunnel — and with StartLimitBurst=5 five frames in five minutes stop the service until
   * a human intervenes. Found on live hardware, by sending one.
   *
   * Each case asserts the same two things, and the SECOND is the one that matters: the sender is
   * rejected, and the agent is still serving afterwards.
   */
  for (const [name, hello] of [
    ['no token field at all', { t: 'hello' }],
    ['a null token', { t: 'hello', token: null }],
    ['a number where the token goes', { t: 'hello', token: 12345 }],
    ['an object where the token goes', { t: 'hello', token: { nested: 'thing' } }],
    ['an array where the token goes', { t: 'hello', token: ['a', 'b'] }],
  ] as const) {
    test(`survives ${name}`, async () => {
      const hostile = await connect();
      hostile.send(JSON.stringify(hello));
      const reply = await nextMessage(hostile);
      assert.equal(reply.t, 'error', 'the sender is told no');
      // `malformed` AND NOT `auth_timeout` is the whole assertion. On the unfixed code the handler
      // threw before it could answer, so the only thing that ever arrived on this socket was the
      // 5s no-hello timeout — a reply that says "you never spoke" to a client that did. Asserting
      // the code, rather than merely that something arrived, is what makes this test able to fail:
      // the test runner catches unhandledRejection, so the crash that ends the agent in production
      // is invisible in here. The symptom that IS visible is being answered by a timer instead of
      // by the verifier.
      assert.equal(reply.code, 'malformed', 'answered by the verifier, not by the auth timeout');
      hostile.close();

      // THE REAL ASSERTION. If the frame above killed the process, nothing here can connect — and
      // on the old code nothing could, because there was no process left to connect to.
      const after = await connect();
      after.send(JSON.stringify({ t: 'hello', token: 'still.here.though' }));
      const stillServing = await nextMessage(after);
      assert.equal(stillServing.t, 'error');
      assert.equal(stillServing.code, 'malformed', 'the agent is still verifying tokens, not dead');
      after.close();
    });
  }

  test('a hello whose token is a well-formed lie is rejected on its signature', async () => {
    // The boundary either side of the crash: a string token gets as far as the CRYPTO, which is
    // where a bad one is supposed to be caught. Rejecting shapes must not have moved that line.
    const ws = await connect();
    ws.send(JSON.stringify({ t: 'hello', token: `${TOKEN_ALG}.eyJzaWQiOiJ4In0.bm90YXNpZw` }));
    const msg = await nextMessage(ws);
    assert.equal(msg.t, 'error');
    assert.equal(msg.code, 'bad_signature', 'a syntactically valid token must reach the verifier');
    ws.close();
  });
});

/**
 * ADR-0003 B2 / ADR-0004 point 4 — the automation endpoint belongs to the DEVICE.
 *
 * Before protocol v2 a host carried exactly one `automationEndpoint` and `agent.ts` stamped
 * `webdriver` onto every device once it was set. On a two-device host that meant the second device
 * advertised a capability whose server the hub could never reach, and every session allocated to it
 * failed at the proxy hop — so `index.ts` refused to start Appium at all rather than lie.
 *
 * These run against the real control plane, so they cover the worker half and the control-plane half
 * agreeing rather than each side's idea of the other.
 */
describe('per-device automation endpoints', () => {
  test('only the devices with an endpoint advertise `webdriver`', async () => {
    const served = fakeBackend('cf-1');
    const bare = fakeBackend('cf-2');
    const agent = makeAgent([served, bare], `b2-partial-${randomUUID().slice(0, 8)}`, {
      automationEndpoints: { 'cf-1': 'https://worker.example:8443/automation/cf-1' },
    });
    await agent.start();

    const rows = await withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT local_id, capabilities, automation_endpoint
           FROM devices WHERE host_id = $1 ORDER BY local_id`,
        [agent.hostId],
      );
      return rows as Array<{ local_id: string; capabilities: string[]; automation_endpoint: string | null }>;
    });

    assert.equal(rows.length, 2);
    assert.ok(rows[0].capabilities.includes('webdriver'), 'cf-1 has a server behind it');
    assert.equal(rows[0].automation_endpoint, 'https://worker.example:8443/automation/cf-1');

    assert.ok(!rows[1].capabilities.includes('webdriver'),
      'cf-2 has no server — before v2 it inherited cf-1\'s and absorbed sessions it could not run');
    assert.equal(rows[1].automation_endpoint, null);
  });

  test('registration returns a control-plane uuid for every device', async () => {
    // The gateway authorizes `claims.did` (a uuid) against a path segment (a local id). Without this
    // mapping it cannot make that comparison and must refuse every request.
    const agent = makeAgent([fakeBackend('cf-1'), fakeBackend('cf-2')], `b2-ids-${randomUUID().slice(0, 8)}`);
    await agent.start();

    const expected = await withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT local_id, id FROM devices WHERE host_id = $1 ORDER BY local_id`, [agent.hostId],
      );
      return rows as Array<{ local_id: string; id: string }>;
    });

    assert.equal(agent.deviceIdFor('cf-1'), expected[0].id);
    assert.equal(agent.deviceIdFor('cf-2'), expected[1].id);
    assert.equal(agent.deviceIdFor('cf-9'), undefined, 'a device this host does not have');
  });

  test('a host-level endpoint still covers every device — the v1 shape and the AUTOMATION_ENDPOINT hatch', async () => {
    const agent = makeAgent([fakeBackend('cf-1'), fakeBackend('cf-2')], `b2-hostwide-${randomUUID().slice(0, 8)}`, {
      automationEndpoint: 'http://10.0.3.14:4723',
    });
    await agent.start();

    assert.equal(agent.automationEndpoint, 'http://10.0.3.14:4723',
      'one url covering both devices is reportable at host level');

    const rows = await withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT local_id, capabilities, automation_endpoint
           FROM devices WHERE host_id = $1 ORDER BY local_id`, [agent.hostId],
      );
      return rows as Array<{ local_id: string; capabilities: string[]; automation_endpoint: string }>;
    });
    for (const r of rows) {
      assert.ok(r.capabilities.includes('webdriver'), `${r.local_id} is genuinely fronted by that server`);
      assert.equal(r.automation_endpoint, 'http://10.0.3.14:4723');
    }
  });

  test('two distinct endpoints withhold the host-level field rather than naming one of them', async () => {
    // A v1 control plane stores one string per host. Reporting either would tell it that BOTH
    // devices are served by a server that can only reach one — the exact defect B2 describes.
    // Answering nothing degrades that host to "no webdriver", which is true.
    const agent = makeAgent([fakeBackend('cf-1'), fakeBackend('cf-2')], `b2-distinct-${randomUUID().slice(0, 8)}`, {
      automationEndpoints: {
        'cf-1': 'https://worker.example:8443/automation/cf-1',
        'cf-2': 'https://worker.example:8443/automation/cf-2',
      },
    });
    await agent.start();

    assert.equal(agent.automationEndpoint, undefined, 'no single url describes this host');
    assert.equal(agent.automationEndpointFor('cf-2'), 'https://worker.example:8443/automation/cf-2');

    const rows = await withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT d.local_id, d.automation_endpoint AS dev, h.automation_endpoint AS host
           FROM devices d JOIN hosts h ON h.id = d.host_id
          WHERE d.host_id = $1 ORDER BY d.local_id`, [agent.hostId],
      );
      return rows as Array<{ local_id: string; dev: string; host: string | null }>;
    });
    assert.equal(rows[0].host, null, 'the legacy host column stays empty');
    assert.equal(rows[0].dev, 'https://worker.example:8443/automation/cf-1');
    assert.equal(rows[1].dev, 'https://worker.example:8443/automation/cf-2');
  });

  test('a changed data-plane endpoint re-registers, instead of resuming onto a stale address', async () => {
    /**
     * `hosts.endpoint` is written at registration and nowhere else, so if a change to it does not
     * move the capability fingerprint, the agent resumes, heartbeats, and the control plane keeps
     * handing out the address the host gave the FIRST time it ever started.
     *
     * Found on hardware: removing PUBLIC_ENDPOINT so the agent would advertise its tunnel changed
     * what it sent and changed nothing in the database. It is the laptop case exactly — a machine
     * that registers a direct address on one network and is behind NAT on the next.
     */
    const hostname = `dp-endpoint-${randomUUID().slice(0, 8)}`;
    const first = makeAgent([fakeBackend('cf-1')], hostname, { endpoint: 'ws://10.0.0.5:8080' });
    await first.start();

    const second = makeAgent([fakeBackend('cf-1')], hostname, { endpoint: 'mfarm+tunnel:/dp' });
    await second.start();

    const row = await withSystem(async (c) => {
      const { rows } = await c.query(`SELECT endpoint FROM hosts WHERE id = $1`, [second.hostId]);
      return rows[0] as { endpoint: string };
    });
    assert.equal(row.endpoint, 'mfarm+tunnel:/dp',
      'the host resumed on its old address instead of re-registering the new one');
  });

  test('an unchanged endpoint still resumes rather than re-registering every restart', async () => {
    // The other half: adding a field to the fingerprint must not make every restart a registration.
    const hostname = `dp-stable-${randomUUID().slice(0, 8)}`;
    const first = makeAgent([fakeBackend('cf-1')], hostname, { endpoint: 'ws://10.0.0.5:8080' });
    const firstState = await first.start();
    const second = makeAgent([fakeBackend('cf-1')], hostname, { endpoint: 'ws://10.0.0.5:8080' });
    const secondState = await second.start();
    assert.equal(secondState.hostId, firstState.hostId);
    assert.equal(secondState.workerToken, firstState.workerToken,
      're-registration would have minted a new worker token');
  });

  test('a rebuilt device re-registers its new panel instead of resuming onto the old one', async () => {
    /**
     * `devices.screen`, `model`, `profile` and `abis` are written at registration and nowhere else,
     * so a change that does not move the fingerprint can never reach the control plane.
     *
     * Found on hardware 2026-08-29 (ADR-0016): cf-3 was rebuilt at 1080x2340 @450, the guest agreed,
     * the agent had the right value in memory, the worker was restarted — and the console kept
     * showing 1440x3120 @600, because the capabilities had not changed. A device whose reported
     * panel disagrees with the one it draws is worse than one that reports nothing: the console
     * divides by it to place a tap.
     */
    const hostname = `panel-${randomUUID().slice(0, 8)}`;
    const before = fakeBackend('cf-1');
    before.control.info.screen = { width: 1440, height: 3120, density: 600 };
    await makeAgent([before], hostname).start();

    const after = fakeBackend('cf-1');
    after.control.info.screen = { width: 1080, height: 2340, density: 450 };
    const second = makeAgent([after], hostname);
    await second.start();

    assert.equal(second.registeredThisStart, true, 'a changed panel has to be re-registered');
    const row = await withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT screen FROM devices WHERE host_id = $1 AND local_id = 'cf-1'`, [second.hostId]);
      return rows[0] as { screen: { width: number; height: number; density: number } };
    });
    assert.deepEqual(row.screen, { width: 1080, height: 2340, density: 450 });
  });

  test('a device whose shape did not change still resumes', async () => {
    // The other half, again: four new fields in the fingerprint must not make every restart a
    // registration and mint a fresh worker token each time.
    const hostname = `panel-stable-${randomUUID().slice(0, 8)}`;
    const mk = () => {
      const b = fakeBackend('cf-1');
      b.control.info.screen = { width: 1080, height: 2340, density: 450 };
      b.control.info.model = 'MFARM X1 Pro';
      b.control.info.profile = 'mfarm-x1-pro';
      b.control.info.abis = ['x86_64', 'arm64-v8a'];
      return b;
    };
    const firstState = await makeAgent([mk()], hostname).start();
    const second = makeAgent([mk()], hostname);
    const secondState = await second.start();
    assert.equal(second.registeredThisStart, false);
    assert.equal(secondState.workerToken, firstState.workerToken);
  });

  test('the agent says which of the two things it did', async () => {
    /**
     * `registeredThisStart` exists because the log line lied. `index.ts` printed "registered as
     * host X" on both paths, so a run that only heartbeated was indistinguishable from one that had
     * just told the control plane its device list — and registration is the ONLY thing that writes
     * that list. It cost real time on a deployed farm diagnosing a fix that worked and had simply
     * never been reached.
     */
    const hostname = `said-what-${randomUUID().slice(0, 8)}`;
    const first = makeAgent([fakeBackend('cf-1')], hostname);
    await first.start();
    assert.equal(first.registeredThisStart, true, 'a first start registers');

    const resumed = makeAgent([fakeBackend('cf-1')], hostname);
    await resumed.start();
    assert.equal(resumed.registeredThisStart, false,
      'an unchanged fingerprint resumes; nothing was written to the device list');

    // A device set that changed is exactly what plugging or unplugging a phone does.
    const changed = makeAgent([fakeBackend('cf-1'), fakeBackend('cf-2')], hostname);
    await changed.start();
    assert.equal(changed.registeredThisStart, true, 'a changed device set re-registers');
  });

  test('re-registering without a server WITHDRAWS the stored endpoint', async () => {
    // A stale url left behind would keep the hub dialling a server that is gone (ADR-0003 d3).
    const hostname = `b2-withdraw-${randomUUID().slice(0, 8)}`;
    const first = makeAgent([fakeBackend('cf-1')], hostname, {
      automationEndpoints: { 'cf-1': 'https://worker.example:8443/automation/cf-1' },
    });
    await first.start();

    const second = makeAgent([fakeBackend('cf-1')], hostname); // Appium did not come back
    await second.start();

    const row = await withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT capabilities, automation_endpoint FROM devices WHERE host_id = $1`, [second.hostId],
      );
      return rows[0] as { capabilities: string[]; automation_endpoint: string | null };
    });
    assert.equal(row.automation_endpoint, null);
    assert.ok(!row.capabilities.includes('webdriver'));
  });
});

/**
 * ADR-0003 B3 — the device's identity as the DRIVER knows it, not as we do.
 *
 * The hub sent `appium:udid = local_id` (`cf-1`), and UiAutomator2 matches `udid` against the adb
 * serial. Both worker backends already computed the correct serial and kept it private, so the value
 * existed the whole time and simply never left the class.
 */
describe('device automation identity', () => {
  test('the adb serial reaches the control plane, and is not the local id', async () => {
    const agent = makeAgent([fakeBackend('cf-1')], `b3-serial-${randomUUID().slice(0, 8)}`, {
      automationEndpoints: { 'cf-1': 'https://worker.example:8443/automation/cf-1' },
    });
    await agent.start();

    const row = await withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT local_id, adb_serial, system_port, mjpeg_server_port
           FROM devices WHERE host_id = $1`, [agent.hostId],
      );
      return rows[0] as { local_id: string; adb_serial: string; system_port: number; mjpeg_server_port: number };
    });

    assert.equal(row.adb_serial, '0.0.0.0:adb-cf-1');
    assert.notEqual(row.adb_serial, row.local_id, 'our name for the device is not the driver\'s');
    assert.ok(row.system_port >= 8200 && row.system_port < 8300, 'derived clear of the Appium range');
    assert.ok(row.mjpeg_server_port >= 7810 && row.mjpeg_server_port < 7910);
  });

  test('two devices on one host get distinct driver ports', async () => {
    // The whole reason these fields exist: UiAutomator2 defaults every session to 8200/7810, so the
    // second concurrent session on a host fails to start. Unreachable until migration 010 let one
    // host serve WebDriver on more than one device.
    const agent = makeAgent([fakeBackend('cf-1'), fakeBackend('cf-2')], `b3-ports-${randomUUID().slice(0, 8)}`, {
      automationEndpoints: {
        'cf-1': 'https://worker.example:8443/automation/cf-1',
        'cf-2': 'https://worker.example:8443/automation/cf-2',
      },
    });
    await agent.start();

    const rows = await withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT local_id, system_port, mjpeg_server_port FROM devices WHERE host_id = $1 ORDER BY local_id`,
        [agent.hostId],
      );
      return rows as Array<{ local_id: string; system_port: number; mjpeg_server_port: number }>;
    });

    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].system_port, rows[1].system_port);
    assert.notEqual(rows[0].mjpeg_server_port, rows[1].mjpeg_server_port);
    // Stable across a restart, like the Appium port — firewall rules and tunnels are written
    // against fixed numbers, and a random free port would invalidate them silently.
    const again = makeAgent([fakeBackend('cf-1')], `b3-stable-${randomUUID().slice(0, 8)}`, {
      automationEndpoints: { 'cf-1': 'https://worker.example:8443/automation/cf-1' },
    });
    await again.start();
    const stable = await withSystem(async (c) =>
      (await c.query('SELECT system_port FROM devices WHERE host_id = $1', [again.hostId])).rows[0]);
    assert.equal(stable.system_port, rows[0].system_port);
  });

  test('a device with no automation server reports no driver ports', async () => {
    // They are only meaningful alongside a server, and a port reserved for nothing is a port an
    // operator will spend time explaining.
    const agent = makeAgent([fakeBackend('cf-1')], `b3-noports-${randomUUID().slice(0, 8)}`);
    await agent.start();
    const row = await withSystem(async (c) =>
      (await c.query('SELECT adb_serial, system_port FROM devices WHERE host_id = $1', [agent.hostId])).rows[0]);
    assert.equal(row.system_port, null);
    assert.equal(row.adb_serial, '0.0.0.0:adb-cf-1', 'identity is reported regardless — it is a fact about the device');
  });
});

/**
 * The viewer half of the data plane — signalling, logcat and screenshots (ADR-0007).
 *
 * The thing these protect is not "does a message round trip". It is that a live view **cannot
 * become a second way in**: every viewer verb sits behind the same `hello` that input does, so a
 * socket that never authenticated, or whose fence has moved on, gets nothing new here. And that a
 * viewer who walks away does not leave an `adb logcat` and an operator socket running against a
 * device the next tenant is about to be handed.
 */
describe('data plane — viewer', () => {
  let agent: Agent, dp: DataPlane, port: number, backend: ReturnType<typeof viewableBackend>;

  before(async () => {
    backend = viewableBackend();
    agent = makeAgent([backend], `view-${randomUUID().slice(0, 8)}`);
    await agent.start();
    dp = new DataPlane({
      agent,
      backends: new Map([[backend.control.info.localId, backend]]),
      resolveDevice: () => backend,
    });
    port = await dp.listen(0);
  });

  after(async () => { await dp.close(); await agent.shutdown(); });

  const connect = () => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

  const nextMessage = (ws: WebSocket) => new Promise<Record<string, unknown>>((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
  });

  /** Wait for a specific frame type, ignoring anything the device volunteers in the meantime. */
  const until = (ws: WebSocket, t: string) => new Promise<Record<string, unknown>>((resolve) => {
    const on = (d: Buffer): void => {
      const msg = JSON.parse(d.toString());
      if (msg.t !== t) return;
      ws.off('message', on);
      resolve(msg);
    };
    ws.on('message', on);
  });

  async function tokenFor() {
    const deviceId = await withSystem(async (c) => {
      await c.query(`UPDATE devices SET state = 'OFFLINE' WHERE region = $1 AND state = 'READY'`, [REGION]);
      await c.query(`UPDATE hosts SET endpoint = 'wss://dp.example' WHERE id = $1`, [agent.hostId]);
      const d = await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id)
         VALUES ($1,$2,'android','cuttlefish','fake','15','READY',
                 '["screen-stream","input-datachannel","snapshot-reset","logcat","screenshot"]'::jsonb, $3)
         RETURNING id`,
        [agent.hostId, REGION, `view-dev-${randomUUID().slice(0, 8)}`]);
      return d.rows[0].id as string;
    });
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tenantKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ region: REGION, platform: 'android' }),
    });
    const body = await res.json() as {
      session: { id: string; fence: number; deviceId: string };
      dataPlane: { token: string };
    };
    assert.equal(res.status, 201, `expected an allocation, got ${JSON.stringify(body)}`);
    assert.equal(body.session.deviceId, deviceId);
    return body;
  }

  /** A socket that has said hello and had it accepted. */
  async function authed() {
    const created = await tokenFor();
    const ws = await connect();
    ws.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    assert.equal((await nextMessage(ws)).t, 'ready');
    return ws;
  }

  test('every viewer verb is refused before hello', async () => {
    // The point of the whole file, in one test. A live view must not be a second door: it inherits
    // the grant check rather than adding one of its own, so an unauthenticated socket asking for a
    // screen gets the same treatment as one asking for a tap.
    for (const msg of [{ t: 'signal-open' }, { t: 'logcat', action: 'start' }, { t: 'screenshot' }]) {
      const ws = await connect();
      ws.send(JSON.stringify(msg));
      const err = await nextMessage(ws);
      assert.equal(err.code, 'unauthenticated', `${msg.t} must not work without a session`);
      ws.close();
    }
  });

  test('signal-open reports the device info and the operator ice servers', async () => {
    const ws = await authed();
    ws.send(JSON.stringify({ t: 'signal-open' }));
    const ready = await until(ws, 'signal-ready');
    assert.deepEqual(ready.deviceInfo, { hardware: { cpus: 8 } });
    assert.deepEqual(ready.iceServers, [{ urls: 'stun:operator.local:3478' }]);
    ws.close();
  });

  test('signalling passes both ways without being understood', async () => {
    const ws = await authed();
    ws.send(JSON.stringify({ t: 'signal-open' }));
    await until(ws, 'signal-ready');

    // Outbound. A field this worker has never heard of must survive the trip: the relay is opaque
    // so that a Cuttlefish release adding one is not a worker release.
    const offerRequest = { type: 'request-offer', ice_servers: [], some_future_field: 7 };
    ws.send(JSON.stringify({ t: 'signal', payload: offerRequest }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(backend.signals.sent.at(-1), offerRequest);

    // Inbound.
    backend.signals.fromDevice({ type: 'offer', sdp: 'v=0...' });
    const framed = await until(ws, 'signal');
    assert.deepEqual(framed.payload, { type: 'offer', sdp: 'v=0...' });
    ws.close();
  });

  test('a second signal-open on one socket is refused', async () => {
    const ws = await authed();
    ws.send(JSON.stringify({ t: 'signal-open' }));
    await until(ws, 'signal-ready');
    ws.send(JSON.stringify({ t: 'signal-open' }));
    const err = await until(ws, 'signal-error');
    assert.match(String(err.message), /already has a signalling channel/);
    ws.close();
  });

  test('signalling before signal-open is an error, not a silent drop', async () => {
    const ws = await authed();
    ws.send(JSON.stringify({ t: 'signal', payload: { type: 'answer' } }));
    const err = await until(ws, 'signal-error');
    assert.match(String(err.message), /signal-open/);
    ws.close();
  });

  test('logcat batches lines rather than sending one frame each', async () => {
    const ws = await authed();
    ws.send(JSON.stringify({ t: 'logcat', action: 'start' }));
    await until(ws, 'logcat-started');
    const batch = until(ws, 'logcat');
    for (let i = 0; i < 5; i++) backend.control.say(`08-19 13:43:2${i}.000  1245  1245 I Tag: line ${i}`);
    const got = await batch;
    assert.equal((got.lines as string[]).length, 5, 'five lines arrived as one frame');
    ws.send(JSON.stringify({ t: 'logcat', action: 'stop' }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(backend.control.logcatRunning, 0);
    ws.close();
  });

  test('closing the socket stops logcat and the signalling channel', async () => {
    // The leak this prevents is not a resource leak in the abstract: an adb child and an operator
    // socket left running belong to a device that is about to be snapshot-restored for the next
    // tenant, and the next tenant is who they would then be following.
    const opened = backend.signals.closed;
    const ws = await authed();
    ws.send(JSON.stringify({ t: 'signal-open' }));
    await until(ws, 'signal-ready');
    ws.send(JSON.stringify({ t: 'logcat', action: 'start' }));
    await until(ws, 'logcat-started');
    assert.equal(backend.control.logcatRunning, 1);

    ws.close();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(backend.control.logcatRunning, 0, 'the adb child was killed with the socket');
    assert.equal(backend.signals.closed, opened + 1, 'the operator socket was closed with it');
  });

  test('a screenshot comes back base64 with its content type', async () => {
    const ws = await authed();
    ws.send(JSON.stringify({ t: 'screenshot', id: 'shot-1' }));
    const shot = await until(ws, 'screenshot');
    assert.equal(shot.id, 'shot-1', 'correlated, so a slow capture cannot answer the wrong request');
    assert.equal(shot.contentType, 'image/png');
    assert.equal(Buffer.from(String(shot.data), 'base64').subarray(0, 4).toString('hex'), '89504e47');
    ws.close();
  });

  test('a failed screenshot reports the device’s own words', async () => {
    const ws = await authed();
    backend.control.screenshotFails = true;
    ws.send(JSON.stringify({ t: 'screenshot', id: 'shot-2' }));
    const err = await until(ws, 'screenshot-error');
    assert.equal(err.id, 'shot-2');
    assert.match(String(err.message), /did not return a PNG/);
    backend.control.screenshotFails = false;
    ws.close();
  });

  test('an unknown verb is answered rather than ignored', async () => {
    // A client speaking a newer protocol than this worker must find out, not wait forever for a
    // reply that is never coming.
    const ws = await authed();
    ws.send(JSON.stringify({ t: 'record', action: 'start' }));
    const err = await until(ws, 'error');
    assert.equal(err.code, 'unknown_message');
    ws.close();
  });
});

/**
 * The data-plane tunnel.
 *
 * THE POINT OF THESE, and the reason none of them uses `inject()`: the tunnel is entirely socket
 * lifecycle. Who dialled whom, what happens when one end goes away, whether a viewer is told or
 * simply frozen. `app.inject()` cannot see any of it — a 410-line suite once passed against a
 * feature that worked zero percent of the time in production for exactly this reason — so every
 * test here binds a real port and speaks a real WebSocket.
 *
 * The load-bearing property is that inverting the transport changed no authorization. A browser
 * arriving at the CONTROL PLANE still presents the same Ed25519 grant, and the AGENT still verifies
 * it offline against a public key and a fence. The control plane relays and decides nothing.
 */
describe('the data-plane tunnel', () => {
  let agent: Agent, dp: DataPlane, tunnel: AgentTunnel, backend: ReturnType<typeof fakeBackend>;

  const wsBase = () => baseUrl.replace(/^http/, 'ws');

  const waitFor = async (pred: () => boolean, what: string, ms = 3_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  before(async () => {
    backend = fakeBackend(`tun-${randomUUID().slice(0, 8)}`);
    agent = makeAgent([backend], `tunnel-${randomUUID().slice(0, 8)}`);
    await agent.start();
    dp = new DataPlane({
      agent,
      backends: new Map([[backend.control.info.localId, backend]]),
      resolveDevice: () => backend,
    });
    // Deliberately NOT listening. A laptop behind NAT has no inbound path at all, so if any of
    // these passed because something dialled the worker directly, the test would be a lie.
    tunnel = new AgentTunnel({ controlPlaneUrl: baseUrl, agent, dataPlane: dp, minBackoffMs: 20 });
    tunnel.start();
    await waitFor(() => tunnel.connected, 'the agent tunnel to connect');
  });

  after(async () => { tunnel.stop(); await dp.close(); await agent.shutdown(); });

  const dial = (url: string) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

  const nextMessage = (ws: WebSocket) => new Promise<Record<string, unknown>>((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
  });

  const nextClose = (ws: WebSocket) => new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  /** A real session on THIS host's device, so the grant's audience and fence are the real ones. */
  async function realSession() {
    await withSystem(async (c) => {
      await c.query(`UPDATE devices SET state = 'OFFLINE' WHERE region = $1 AND state = 'READY'`, [REGION]);
      await c.query(`UPDATE hosts SET endpoint = 'wss://dp.example' WHERE id = $1`, [agent.hostId]);
      await c.query(
        `INSERT INTO devices (host_id, region, platform, tier, model, os_version, state, capabilities, local_id)
         VALUES ($1,$2,'android','cuttlefish','fake','15','READY',
                 '["screen-stream","input-datachannel","snapshot-reset"]'::jsonb, $3)`,
        [agent.hostId, REGION, `tun-dev-${randomUUID().slice(0, 8)}`]);
    });
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tenantKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ region: REGION, platform: 'android' }),
    });
    const body = await res.json() as { session: { id: string }; dataPlane: { token: string } };
    assert.equal(res.status, 201, `expected an allocation, got ${JSON.stringify(body)}`);
    return body;
  }

  test('a browser drives a device through the control plane, on a worker that is not listening', async () => {
    const created = await realSession();
    const ws = await dial(`${wsBase()}/dp/${agent.hostId}`);

    ws.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    const ready = await nextMessage(ws);
    assert.equal(ready.t, 'ready', 'the AGENT verified the grant offline, at the far end of a relay');
    assert.equal(ready.sessionId, created.session.id);

    // And input reaches the device, which is the half that proves the relay is bidirectional
    // rather than just an accepted handshake.
    const before = backend.control.calls.length;
    ws.send(JSON.stringify({ t: 'tap', x: 10, y: 20, seq: 1 }));
    await waitFor(() => backend.control.calls.length > before, 'the tap to reach the device');
    assert.ok(backend.control.calls.at(-1)?.startsWith('tap'), 'the device was tapped, not something else');
    ws.close();
  });

  test('a forged grant is refused at the agent, not by the relay', async () => {
    // The control plane opens the channel without looking at the payload — that is the design, and
    // this is what makes it safe. The refusal has to come from the far end.
    const ws = await dial(`${wsBase()}/dp/${agent.hostId}`);
    ws.send(JSON.stringify({ t: 'hello', token: 'v1.eyJzaWQiOiJmYWtlIn0.AAAA' }));
    const msg = await nextMessage(ws);
    assert.equal(msg.t, 'error');
    assert.equal(msg.code, 'bad_signature',
      'not a generic refusal: the agent ran the signature check itself, at the far end of the relay');
    ws.close();
  });

  test('a host with no agent connected says so, instead of hanging', async () => {
    const ws = new WebSocket(`${wsBase()}/dp/${randomUUID()}`);
    const closed = await nextClose(ws);
    assert.equal(closed.code, 1013);
    assert.match(closed.reason, /No agent is connected/,
      'silence here reads to a viewer exactly like a broken device');
  });

  test('an unauthenticated tunnel dial is refused', async () => {
    await assert.rejects(dial(`${wsBase()}/v1/workers/tunnel`), /401|Unexpected server response/);
  });

  test('a tenant key cannot open a tunnel', async () => {
    // Principal separation: a tunnel is a WORKER's socket, and a tenant key must never become one.
    await assert.rejects(
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`${wsBase()}/v1/workers/tunnel`, {
          headers: { authorization: `Bearer ${tenantKey}` },
        });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
      }),
      /401|Unexpected server response/,
    );
  });

  test('when the tunnel drops, viewers are told rather than frozen', async () => {
    const created = await realSession();
    const ws = await dial(`${wsBase()}/dp/${agent.hostId}`);
    ws.send(JSON.stringify({ t: 'hello', token: created.dataPlane.token }));
    assert.equal((await nextMessage(ws)).t, 'ready');

    const closed = nextClose(ws);
    tunnel.stop();
    const { code } = await closed;
    assert.equal(code, 1011, 'a dropped agent must close its viewers, not leave a still picture');

    // And it comes back on its own, which is the whole reason a laptop closing its lid is survivable.
    tunnel.start();
    await waitFor(() => tunnel.connected, 'the tunnel to reconnect');
  });
});

/**
 * Re-registering a host that enrolled with a SINGLE-USE token (ADR-0008).
 *
 * `POST /workers/register` has accepted three credential kinds since migration 023, and the `mwk_`
 * branch — the host's own worker token — was unreachable in practice, because the agent only ever
 * presented the value it was configured with. On an operator-owned Cuttlefish box that value is the
 * fleet secret and nothing was wrong. On the laptop enrollment was built for, it is an `mae_` token
 * that is spent the moment the first registration succeeds.
 *
 * The agent re-registers whenever its capability fingerprint changes — which is precisely what
 * plugging in a second phone does. So without this, every enrolled host could be started exactly
 * once, and adding a phone or restarting the agent would need a freshly minted enrollment token.
 */
describe('re-registration presents the host\'s own credential', () => {
  /** Mint a real single-use enrollment token for the test org. */
  async function enrollmentToken(): Promise<string> {
    const { createEnrollment } = await import('@mfarm/api/enrollment');
    const { plaintext } = await createEnrollment(orgId, null, 'agent-test laptop', 24);
    return plaintext;
  }

  test('a spent enrollment token does not strand the host it enrolled', async () => {
    const host = `enrolled-${randomUUID().slice(0, 8)}`;
    const token = await enrollmentToken();
    const statePath = join(stateDir, `${host}.json`);

    const first = new Agent({
      controlPlaneUrl: baseUrl,
      registrationToken: token,
      hostname: host, region: REGION,
      endpoint: 'wss://agent-test.example:8080',
      devices: [fakeBackend()],
      statePath, cores: 8, memoryMb: 16384,
    });
    const s1 = await first.start();
    assert.ok(s1.workerToken.startsWith('mwk_'), 'enrolling yields a worker token of its own');
    await first.shutdown();

    // The fingerprint changes — a second phone, in the shape this test can express. The agent must
    // re-register, and the enrollment token in its environment is now spent.
    const b2 = fakeBackend('second-device');
    const second = new Agent({
      controlPlaneUrl: baseUrl,
      registrationToken: token, // the SAME spent token, exactly as it would still be in the env
      hostname: host, region: REGION,
      endpoint: 'wss://agent-test.example:8080',
      devices: [fakeBackend(), b2],
      statePath, cores: 8, memoryMb: 16384,
    });

    const s2 = await second.start();
    assert.equal(s2.hostId, s1.hostId, 'the same host, not a second one');
    assert.ok(s2.workerToken.startsWith('mwk_'));
    await second.shutdown();

    // And the device it could only have registered by re-registering successfully is really there.
    const found = await withSystem(async (c) =>
      (await c.query('SELECT local_id FROM devices WHERE host_id = $1 ORDER BY local_id', [s1.hostId])).rows);
    assert.deepEqual(found.map((r) => r.local_id), ['fake-1', 'second-device']);
  });

  /**
   * The fallback. A stored worker token can be genuinely dead — host row deleted, database restored
   * from before this host existed — and `start()` reaches re-registration exactly when a heartbeat
   * has just failed, which is one of the ways that happens. Refusing the stored credential must not
   * end the attempt.
   */
  test('a dead worker token falls back to the configured credential', async () => {
    const host = `stale-${randomUUID().slice(0, 8)}`;
    const statePath = join(stateDir, `${host}.json`);

    const first = makeAgent([fakeBackend()], host);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (first as any).opts.statePath = statePath;
    const s1 = await first.start();
    await first.shutdown();

    // The host disappears from under the agent, taking its token's validity with it.
    await withSystem((c) => c.query('DELETE FROM hosts WHERE id = $1', [s1.hostId]));

    const revived = makeAgent([fakeBackend()], host);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (revived as any).opts.statePath = statePath;
    const s2 = await revived.start();
    assert.notEqual(s2.hostId, s1.hostId, 'a new host row, reached via the fleet secret');
    await revived.shutdown();
  });
});
