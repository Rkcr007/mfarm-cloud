import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { TUNNEL_PATH } from '@mfarm/protocol';
import { AgentTunnel } from '../src/tunnel.ts';
import type { Agent } from '../src/agent.ts';
import type { DataPlane } from '../src/dataplane.ts';

/**
 * The tunnel notices when the control plane stops answering — over real sockets.
 *
 * ---------------------------------------------------------------- the bug this file pins
 *
 * Every recovery in `AgentTunnel` hangs off `ws.on('close')`: the retry with its backoff, and
 * `dropAllChannels`. None of it runs if `close` never fires — and `close` does not fire when the far
 * end vanishes without a TCP FIN reaching us.
 *
 * `deploy/mfarm-deploy.sh` does exactly that on every deploy: it recreates the API container. On the
 * lab farm, 2026-09-02, the agent logged `data-plane tunnel connected` at 21:02 and then went
 * COMPLETELY SILENT across both a control-plane reset and a container recreate — no retry, no error
 * — while `farm-check.sh` correctly reported no agent tunnel. The fleet looked perfect the whole
 * time, because the heartbeat is plain HTTPS and every device stayed READY. Only the live view was
 * gone, and only until somebody restarted the worker by hand.
 *
 * ---------------------------------------------------------------- how the dead peer is simulated
 *
 * `req.socket.pause()` on the control-plane side. The connection stays ESTABLISHED and is never
 * closed, but the server stops reading, so the agent's ping is never seen and never ponged. That is
 * the production condition — a peer that is gone without saying so — and it is the one condition
 * under which the old code did nothing at all.
 *
 * ---------------------------------------------------------------- what is asserted
 *
 * THE SERVER'S CONNECTION COUNT, not the agent's opinion of itself. `tunnel.connected` is derived
 * from the same socket the fix manipulates, so asserting on it would be the test agreeing with the
 * code under test. A second `connection` event at a control plane that never closed the first one is
 * an observation the agent cannot fake.
 */

const flag = { deadAir: false };

let cpServer: Server;
let wss: WebSocketServer;
let cpUrl: string;
let tunnel: AgentTunnel | undefined;

/** Every socket the control plane has accepted, in order. */
let accepted: WebSocket[] = [];
/** Resolvers waiting for the Nth connection. */
let onConnection: Array<() => void> = [];
/** Pings this control plane has actually received. */
let pings = 0;

function makeTunnel(over: Partial<{ pingIntervalMs: number; minBackoffMs: number }> = {}): AgentTunnel {
  return new AgentTunnel({
    controlPlaneUrl: cpUrl,
    // Only `workerToken` is read on this path; the rest of Agent is not part of the transport.
    agent: { workerToken: 'mwk_test' } as unknown as Agent,
    // No data-plane channel is opened in this file, so a throwing accept() is the strongest
    // available assertion that keepalive traffic never reaches the data plane.
    dataPlane: { accept: () => { throw new Error('keepalive reached the data plane'); } } as unknown as DataPlane,
    pingIntervalMs: 40,
    minBackoffMs: 5,
    maxBackoffMs: 20,
    ...over,
  });
}

/** Resolves when the control plane has accepted at least `n` connections. */
function nthConnection(n: number): Promise<void> {
  if (accepted.length >= n) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const check = () => { if (accepted.length >= n) resolve(); };
    onConnection.push(check);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  cpServer = createServer((_req, res) => { res.writeHead(426); res.end(); });
  wss = new WebSocketServer({ noServer: true });

  cpServer.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== TUNNEL_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      accepted.push(ws);
      ws.on('ping', () => { pings += 1; });
      /**
       * DEAD AIR: stop reading without closing.
       *
       * The socket stays ESTABLISHED, so the agent sees no `close` and no `error` — it simply stops
       * getting pongs. Pausing the underlying `net.Socket` is the whole simulation; `ws` answers
       * pings inside its receiver, and a receiver that is never fed never answers.
       */
      if (flag.deadAir) req.socket.pause();
      for (const fn of onConnection) fn();
    });
  });

  await new Promise<void>((r) => cpServer.listen(0, '127.0.0.1', () => r()));
  cpUrl = `http://127.0.0.1:${(cpServer.address() as { port: number }).port}`;
});

after(async () => {
  tunnel?.stop();
  await new Promise<void>((r) => { wss.close(() => r()); });
  await new Promise<void>((r) => { cpServer.close(() => r()); });
});

afterEach(() => {
  tunnel?.stop();
  tunnel = undefined;
  flag.deadAir = false;
  for (const ws of accepted) { try { ws.terminate(); } catch { /* already gone */ } }
  accepted = [];
  onConnection = [];
  pings = 0;
});

describe('a healthy tunnel', () => {
  test('is pinged, and is NOT torn down while the far end answers', { timeout: 10_000 }, async () => {
    tunnel = makeTunnel();
    tunnel.start();
    await nthConnection(1);

    // Several intervals. `ws` pongs automatically, so a correct implementation asks repeatedly and
    // terminates nothing.
    await sleep(300);

    assert.ok(pings >= 2, `the agent should ping repeatedly; saw ${pings}`);
    assert.equal(accepted.length, 1,
      'a tunnel whose pongs arrive must not be reconnected — that would be a reconnect loop, not a keepalive');
    assert.equal(tunnel.connected, true);
  });
});

describe('a control plane that stops answering without closing', () => {
  /**
   * TIMEOUTS ON PURPOSE. Without the keepalive this test does not fail, it HANGS — `nthConnection`
   * waits for a redial that the old code never performs, which is precisely the production symptom.
   * An explicit timeout turns that into a named failure rather than a CI job that runs until the
   * runner kills it and reports nothing useful.
   */
  test('is detected, and the agent redials', { timeout: 10_000 }, async () => {
    // THE REGRESSION. Before the keepalive existed this hung forever: no close event, so no retry,
    // so the live view stayed dead until somebody restarted the worker.
    flag.deadAir = true;
    tunnel = makeTunnel();
    tunnel.start();
    await nthConnection(1);
    assert.equal(accepted.length, 1);

    // The first socket is never closed by the server. The only way a second connection can appear
    // is the agent deciding, by itself, that the first one is dead.
    await nthConnection(2);
    assert.ok(accepted.length >= 2,
      'the agent must terminate an unresponsive tunnel and dial again');

    // And the first socket really was left open by the far end — this is a half-open recovery, not
    // the server having hung up and the ordinary close path doing the work.
    assert.notEqual(accepted[0].readyState, WebSocket.CLOSED,
      'the control plane never closed the first socket; the agent is what noticed');
  });

  test('keeps redialling rather than giving up after one attempt', { timeout: 10_000 }, async () => {
    flag.deadAir = true;
    tunnel = makeTunnel();
    tunnel.start();
    await nthConnection(3);
    assert.ok(accepted.length >= 3, 'recovery is a loop with backoff, not a single retry');
  });
});

describe('the keepalive does not outlive what it watches', () => {
  test('stop() ends the pinging', async () => {
    tunnel = makeTunnel();
    tunnel.start();
    await nthConnection(1);
    await sleep(120);
    assert.ok(pings >= 1, 'pinging should have started');

    tunnel.stop();
    const after = pings;
    await sleep(200);
    assert.equal(pings, after,
      'a stopped agent must not keep pinging — a timer that outlives its socket is the leak this replaces');
  });

  test('a drained agent is not held alive by the keepalive timer', async () => {
    // `unref()` is what makes this true, and it is not observable from inside the process. The
    // proxy is that stop() clears the interval outright, asserted above; this test states the
    // requirement so it is not silently dropped.
    tunnel = makeTunnel();
    tunnel.start();
    await nthConnection(1);
    tunnel.stop();
    assert.equal(tunnel.connected, false);
  });
});
