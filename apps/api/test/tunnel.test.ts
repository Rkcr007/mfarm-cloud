/**
 * The control plane's end of the data-plane tunnel.
 *
 * EVERY TEST HERE BINDS A REAL PORT, and that is the point of the file rather than an incidental
 * detail. `app.inject()` cannot upgrade a connection, cannot close one, and cannot tell you that a
 * relay dropped a frame — this repo has already shipped 410 lines of green tests over a feature
 * that worked 0% of the time in production because of exactly that blind spot. Sockets are the
 * behaviour under test, so sockets are what get opened.
 *
 * The claim the tunnel makes is EQUIVALENCE: a browser must not be able to tell whether it reached
 * the agent through the ingress' old direct proxy or through a relay the agent dialled out. Most of
 * what follows is that claim, stated in the places it could quietly stop being true.
 */
process.env.RATE_LIMIT_MAX = '10000';
process.env.WORKER_REGISTRATION_TOKEN = 'test-registration-secret';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { withSystem, closePools } from '../src/db.ts';
import { generateWorkerToken } from '../src/auth.ts';
import { TUNNEL_PATH } from '@mfarm/protocol';

const REGION = 'tunnel-test';
let app: FastifyInstance;
let hostId: string;
let workerToken: string;
let base: string;

/** The ws:// origin of the running server, so a test can dial it the way a browser would. */
const wsBase = () => base.replace(/^http/, 'ws');

before(async () => {
  await withSystem(async (c) => {
    await c.query(`INSERT INTO regions (code,name) VALUES ($1,'Tunnel Test')
                   ON CONFLICT (code) DO NOTHING`, [REGION]);
    const wt = generateWorkerToken();
    workerToken = wt.plaintext;
    hostId = (await c.query(
      `INSERT INTO hosts (region,hostname,state,protocol_version,cores,memory_mb,endpoint,
                          token_prefix,token_hash,last_heartbeat_at)
       VALUES ($1,'tunnel-test-host','UP',1,8,16384,'wss://tunnel-worker.example:8443',$2,$3, now())
       RETURNING id`,
      [REGION, wt.prefix, wt.hash])).rows[0].id;
  });
  app = await buildServer({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await app.close();
  await withSystem(async (c) => {
    await c.query('DELETE FROM hosts WHERE id = $1', [hostId]);
    await c.query('DELETE FROM regions WHERE code = $1', [REGION]);
  });
  await closePools();
});

// ---------------------------------------------------------------- helpers

/** Opens an agent tunnel and resolves once it is actually connected. */
function dialAgent(token = workerToken): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase()}${TUNNEL_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Collects frames an agent receives, so a test can await the Nth one rather than sleeping. */
function collect(ws: WebSocket): { frames: unknown[]; next: () => Promise<any> } {
  const frames: unknown[] = [];
  const waiters: Array<(f: unknown) => void> = [];
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString());
    const w = waiters.shift();
    if (w) w(f); else frames.push(f);
  });
  return {
    frames,
    next: () => new Promise((resolve) => {
      const queued = frames.shift();
      if (queued) return resolve(queued);
      waiters.push(resolve as (f: unknown) => void);
    }),
  };
}

const closeQuietly = (ws?: WebSocket) => { try { ws?.close(); } catch { /* already gone */ } };

// ---------------------------------------------------------------- the probe

/**
 * `deploy/verify-live.sh` probes `/dp/probe` with a PLAIN GET and requires 426, which used to come
 * from the worker's own listener because the ingress proxied `/dp/*` straight to it. Moving that
 * route to the control plane moves who has to answer.
 */
describe('a plain GET of /dp', () => {
  test('answers 426, exactly as the worker listener does', async () => {
    const res = await fetch(`${base}/dp/probe`);
    // Not 404. A 404 here is what the M0 gate would have reported as "the live view has no route to
    // the worker" over a live view that was working perfectly — and a gate that fails on a healthy
    // farm is a gate that gets muted.
    assert.equal(res.status, 426);
    assert.equal((await res.text()).trim(), 'websocket only');
  });

  test('says the same thing for a host that exists and one that does not', async () => {
    // `/dp/*` carries no credential, so a status that varied with a real host id would hand an
    // unauthenticated caller a fleet enumerator.
    const real = await fetch(`${base}/dp/${hostId}`);
    const fake = await fetch(`${base}/dp/${'0'.repeat(8)}-not-a-host`);
    assert.equal(real.status, 426);
    assert.equal(fake.status, real.status);
    assert.equal(await fake.text(), await real.text());
  });

  test('answers 426 for a host with a live tunnel too', async () => {
    // The probe is about the PROTOCOL, not about reachability. If it started reporting tunnel
    // state, the same request would mean two different things on the two transports.
    const agent = await dialAgent();
    try {
      const res = await fetch(`${base}/dp/${hostId}`);
      assert.equal(res.status, 426);
    } finally {
      closeQuietly(agent);
    }
  });
});

// ---------------------------------------------------------------- the agent socket

describe('the agent tunnel', () => {
  test('refuses a connection with no credential', async () => {
    const ws = new WebSocket(`${wsBase()}${TUNNEL_PATH}`);
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    assert.match(err.message, /401/);
  });

  test('refuses a tenant API key — only a worker principal may open one', async () => {
    const ws = new WebSocket(`${wsBase()}${TUNNEL_PATH}`, {
      headers: { authorization: 'Bearer mfa_not_a_worker_token' },
    });
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    assert.match(err.message, /401/);
  });

  test('destroys an upgrade to a path that is neither', async () => {
    const ws = new WebSocket(`${wsBase()}/v1/nothing-here`);
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    assert.match(err.message, /404|socket hang up/);
  });

  test('a valid worker token connects and is registered', async () => {
    const agent = await dialAgent();
    try {
      assert.equal(app.tunnels.has(hostId), true);
    } finally {
      closeQuietly(agent);
    }
  });
});

// ---------------------------------------------------------------- relaying

describe('relaying a viewer', () => {
  test('a browser with no agent behind it is told so, not left waiting', async () => {
    const browser = new WebSocket(`${wsBase()}/dp/${hostId}`);
    const [code, reason] = await new Promise<[number, string]>((resolve) => {
      browser.once('close', (c, r) => resolve([c, r.toString()]));
    });
    // 1013 "try again later" — distinguishable by a viewer from a network fault of its own, which
    // a bare close is not.
    assert.equal(code, 1013);
    assert.match(reason, /no agent/i);
  });

  test('frames cross in both directions, byte for byte', async () => {
    const agent = await dialAgent();
    const rx = collect(agent);
    let browser: WebSocket | undefined;
    try {
      browser = new WebSocket(`${wsBase()}/dp/${hostId}`);
      await new Promise((r) => browser!.once('open', r));

      const open = await rx.next();
      assert.equal(open.t, 'open');
      const ch = open.ch;

      // Browser -> agent. A grant-shaped payload, because the thing that must NOT happen is the
      // control plane developing an opinion about these.
      const hello = JSON.stringify({ t: 'hello', grant: 'ey.signed.token', seq: 1 });
      browser.send(hello);
      const data = await rx.next();
      assert.equal(data.t, 'data');
      assert.equal(data.ch, ch);
      assert.equal(data.d, hello, 'the payload must arrive exactly as it was sent');

      // Agent -> browser.
      const back = JSON.stringify({ t: 'ready', media: null });
      const arrived = new Promise<string>((r) => browser!.once('message', (m) => r(m.toString())));
      agent.send(JSON.stringify({ ch, t: 'data', d: back }));
      assert.equal(await arrived, back);
    } finally {
      closeQuietly(browser);
      closeQuietly(agent);
    }
  });

  test('a browser hanging up closes its channel on the agent', async () => {
    const agent = await dialAgent();
    const rx = collect(agent);
    try {
      const browser = new WebSocket(`${wsBase()}/dp/${hostId}`);
      await new Promise((r) => browser.once('open', r));
      const open = await rx.next();
      browser.close();

      const closed = await rx.next();
      // Without this the agent keeps an `adb logcat` child and a signalling socket running against
      // a device that is about to be handed to somebody else.
      assert.equal(closed.t, 'close');
      assert.equal(closed.ch, open.ch);
    } finally {
      closeQuietly(agent);
    }
  });

  test('a reconnecting agent replaces the old tunnel and takes its viewers down', async () => {
    // A laptop that closed its lid and woke on another network leaves a socket the far side has
    // forgotten about, and TCP will not say so for minutes. The newest authenticated one is true.
    const first = await dialAgent();
    const rx = collect(first);
    let browser: WebSocket | undefined;
    let second: WebSocket | undefined;
    try {
      browser = new WebSocket(`${wsBase()}/dp/${hostId}`);
      await new Promise((r) => browser!.once('open', r));
      await rx.next();

      const viewerClosed = new Promise<number>((r) => browser!.once('close', (c) => r(c)));
      const firstClosed = new Promise<void>((r) => first.once('close', () => r()));

      second = await dialAgent();
      await firstClosed;
      assert.equal(await viewerClosed, 1011);
      assert.equal(app.tunnels.has(hostId), true, 'the successor must still be registered');
    } finally {
      closeQuietly(browser);
      closeQuietly(second);
      closeQuietly(first);
    }
  });

  test('an agent going away closes the viewers riding it', async () => {
    const agent = await dialAgent();
    const rx = collect(agent);
    let browser: WebSocket | undefined;
    try {
      browser = new WebSocket(`${wsBase()}/dp/${hostId}`);
      await new Promise((r) => browser!.once('open', r));
      await rx.next();

      const viewerClosed = new Promise<number>((r) => browser!.once('close', (c) => r(c)));
      agent.close();
      // Telling them is what turns a frozen picture into a reconnect.
      assert.equal(await viewerClosed, 1011);
      // Polled: the close handler runs after the socket event.
      for (let i = 0; i < 50 && app.tunnels.has(hostId); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(app.tunnels.has(hostId), false);
    } finally {
      closeQuietly(browser);
    }
  });
});
