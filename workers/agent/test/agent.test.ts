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
import { Agent, deterministicUuid } from '../src/agent.ts';
import { DataPlane } from '../src/dataplane.ts';
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

function fakeBackend(localId = 'fake-1'): DeviceBackend & { control: FakeDevice } {
  const control = new FakeDevice(localId);
  return { control, media: { async endpoint() { return { url: 'https://cf.example/?d=1', kind: 'webrtc' as const }; } } };
}

const makeAgent = (backends: DeviceBackend[], hostname: string) =>
  new Agent({
    controlPlaneUrl: baseUrl,
    registrationToken: 'agent-test-registration-secret',
    hostname, region: REGION,
    endpoint: 'wss://agent-test.example:8080',
    devices: backends,
    statePath: join(stateDir, `${hostname}.json`),
    cores: 8, memoryMb: 16384,
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
    await withSystem((c) => c.query(
      `INSERT INTO sessions (id, org_id, state, region) VALUES ($1,$2,'ACTIVE',$3)`, [sessionId, orgId, REGION]));

    const event = {
      eventId: deterministicUuid(`${sessionId}:0`), orgId, sessionId, deviceId: null,
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
    await agent.start();

    const deviceId = await withSystem(async (c) => {
      const host = (await c.query(`SELECT id FROM hosts WHERE region = $1 LIMIT 1`, [REGION])).rows[0].id;
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
    await agent.start();

    const deviceId = await withSystem(async (c) => {
      const host = (await c.query(`SELECT id FROM hosts WHERE region = $1 LIMIT 1`, [REGION])).rows[0].id;
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
});
