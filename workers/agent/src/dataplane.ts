import { WebSocketServer, type WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { verifySessionToken, type SessionClaims } from '@mfarm/protocol';
import type { Agent } from './agent.ts';
import type { DeviceBackend } from './device.ts';

/**
 * The data plane — what the browser actually connects to (v2 decision 2).
 *
 * The control plane already authorised this session and is now out of the loop entirely. This server
 * verifies the token OFFLINE against the public key it was given at registration, so nothing on the
 * input path makes a network call back to the API. That is what keeps p99 tap latency independent of
 * the control plane's availability, its garbage collector, and its distance from the user.
 *
 * Media is NOT proxied through here. For Cuttlefish the browser negotiates WebRTC directly with
 * Cuttlefish's own server; this connection carries control and input only.
 */

type ClientMessage =
  | { t: 'hello'; token: string }
  | { t: 'tap'; x: number; y: number; seq: number }
  | { t: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number; seq: number }
  | { t: 'key'; name: 'home' | 'back' | 'recents' | 'power' | 'enter' | 'backspace'; seq: number }
  | { t: 'text'; value: string; seq: number };

interface Conn {
  claims?: SessionClaims;
  backend?: DeviceBackend;
  lastSeq: number;
  inFlight: boolean;
  /** Discrete events waiting behind an in-flight one. See the note on coalescing below. */
  queue: ClientMessage[];
}

/**
 * Positional input is COALESCED; discrete input is QUEUED.
 *
 * A tap or swipe that arrives while another is in flight describes a position the user has already
 * moved on from — replaying it makes the device act on stale coordinates, so dropping it is correct
 * and keeps the stream live under load.
 *
 * A keypress or a character is not positional. Each one carries distinct meaning, and dropping it
 * is data loss the user sees instantly: type "hello" quickly and get "hlo". These must queue.
 */
const POSITIONAL = new Set(['tap', 'swipe']);

/** Bounds the queue so a wedged device cannot grow it without limit. */
const MAX_QUEUED_DISCRETE = 64;

export interface DataPlaneOptions {
  agent: Agent;
  /** localId -> backend. The session token names a control-plane uuid, resolved via resolveDevice. */
  backends: Map<string, DeviceBackend>;
  /** Maps the token's device uuid to a local backend. */
  resolveDevice: (deviceUuid: string) => DeviceBackend | undefined;
  port?: number;
  /**
   * Which interface to bind. Undefined means all of them — Node's default, and what this did before
   * the option existed. A browser reaches this socket over the tailnet, so on a box with a public
   * NIC set it to the Tailscale address (`tailscale ip -4`) rather than relying on the token check
   * alone to be the only thing between a stranger and a live device.
   */
  host?: string;
}

export class DataPlane {
  private wss?: WebSocketServer;
  private http?: Server;
  private readonly conns = new Map<WebSocket, Conn>();

  private readonly opts: DataPlaneOptions;

  constructor(opts: DataPlaneOptions) {
    this.opts = opts;
  }

  /** Returns the bound port. Pass 0 (the test default) to let the OS choose a free one. */
  async listen(port = this.opts.port ?? 0, host = this.opts.host): Promise<number> {
    this.http = createServer((_req, res) => { res.writeHead(426); res.end('websocket only'); });
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    // `listen(port, undefined, cb)` puts undefined in the host slot rather than falling back to the
    // two-argument overload, so the two cases are branched rather than passed through.
    await new Promise<void>((resolve) => {
      if (host) this.http!.listen(port, host, resolve);
      else this.http!.listen(port, resolve);
    });
    const addr = this.http.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  private onConnection(ws: WebSocket): void {
    this.conns.set(ws, { lastSeq: -1, inFlight: false, queue: [] });

    // An unauthenticated socket is a resource an anonymous client can hold open. Close it if no
    // valid hello arrives promptly.
    const authTimer = setTimeout(() => {
      if (!this.conns.get(ws)?.claims) this.reject(ws, 'auth_timeout', 'No hello within 5s.');
    }, 5_000);

    ws.on('message', (raw) => { void this.onMessage(ws, raw.toString()); });
    ws.on('close', () => { clearTimeout(authTimer); this.conns.delete(ws); });
    ws.on('error', () => { clearTimeout(authTimer); this.conns.delete(ws); });
  }

  private reject(ws: WebSocket, code: string, message: string): void {
    try { ws.send(JSON.stringify({ t: 'error', code, message })); } catch { /* already gone */ }
    ws.close();
    this.conns.delete(ws);
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    const conn = this.conns.get(ws);
    if (!conn) return;

    let msg: ClientMessage;
    try { msg = JSON.parse(raw); } catch { return this.reject(ws, 'malformed', 'Message is not JSON.'); }

    if (msg.t === 'hello') {
      // One socket, one session. A second hello would re-enter beginSession and reset the metering
      // clock — the customer stops being billed for the seconds already elapsed — and would let a
      // client swap to a different device mid-connection without the fence ever being re-checked
      // against the first one. Neither is a shape a real client produces.
      if (conn.claims) return this.reject(ws, 'already_authenticated', 'This connection already has a session.');
      return this.onHello(ws, conn, msg.token);
    }
    // Nothing but hello is accepted before authentication — not even a no-op.
    if (!conn.claims || !conn.backend) return this.reject(ws, 'unauthenticated', 'Send hello first.');

    // Sequence gate. Input is fire-and-forget from the browser's side, so late-arriving events out
    // of order would replay stale positions on the device.
    if (typeof (msg as { seq?: number }).seq === 'number') {
      if (msg.seq <= conn.lastSeq) return;
      conn.lastSeq = msg.seq;
    }

    if (conn.inFlight) {
      // Positional: drop it, the next one supersedes it anyway.
      if (POSITIONAL.has(msg.t)) return;
      // Discrete: queue it, because each event is distinct and losing one is visible to the user.
      if (conn.queue.length >= MAX_QUEUED_DISCRETE) {
        try { ws.send(JSON.stringify({ t: 'error', code: 'input_overrun', message: 'Input queue full; the device is not keeping up.' })); } catch { /* gone */ }
        return;
      }
      conn.queue.push(msg);
      return;
    }

    conn.inFlight = true;
    try {
      await this.dispatch(conn.backend, msg);
      // Drain anything that queued while this one was running, in arrival order.
      while (conn.queue.length > 0) {
        const next = conn.queue.shift()!;
        await this.dispatch(conn.backend, next);
      }
    } catch (e) {
      try { ws.send(JSON.stringify({ t: 'error', code: 'device_error', message: (e as Error).message })); } catch { /* gone */ }
    } finally {
      conn.inFlight = false;
    }
  }

  private async onHello(ws: WebSocket, conn: Conn, token: string): Promise<void> {
    const publicKey = this.opts.agent.sessionPublicKey;
    const hostId = this.opts.agent.hostId;
    if (!publicKey || !hostId) return this.reject(ws, 'not_registered', 'Worker has not registered yet.');

    // Audience-bound: a token minted for another host is useless here even though the signature is
    // perfectly valid.
    const v = verifySessionToken(token, publicKey, hostId);
    if (!v.ok) return this.reject(ws, v.reason, 'Session token rejected.');

    const backend = this.opts.resolveDevice(v.claims.did);
    if (!backend) return this.reject(ws, 'unknown_device', 'This host does not own that device.');

    // The fence is the defence against a client that was partitioned and reconnected: its token
    // carries an older allocation, and the device has since been reset for someone else.
    if (!this.opts.agent.acceptFence(v.claims.did, v.claims.fence)) {
      return this.reject(ws, 'stale_fence', 'This session has been superseded. Start a new one.');
    }

    conn.claims = v.claims;
    conn.backend = backend;
    this.opts.agent.beginSession(v.claims.sid, v.claims.did, v.claims.org);

    const media = await backend.media.endpoint();
    ws.send(JSON.stringify({
      t: 'ready',
      sessionId: v.claims.sid,
      device: { screen: backend.control.info.screen, capabilities: backend.control.info.capabilities },
      // null means this tier genuinely cannot stream. Reported plainly rather than papered over with
      // a screenshot loop, which would set a false performance baseline and survive into production.
      media,
    }));

    ws.on('close', () => this.opts.agent.endSession(v.claims.sid));
  }

  private async dispatch(backend: DeviceBackend, msg: ClientMessage): Promise<void> {
    const c = backend.control;
    switch (msg.t) {
      case 'tap':   return c.tap(msg.x, msg.y);
      case 'swipe': return c.swipe(msg.x1, msg.y1, msg.x2, msg.y2, msg.durationMs);
      case 'key':   return c.key(msg.name);
      case 'text':  return c.text(msg.value);
      default:      return;
    }
  }

  async close(): Promise<void> {
    for (const ws of this.conns.keys()) ws.close();
    this.conns.clear();
    await new Promise<void>((r) => this.wss ? this.wss.close(() => r()) : r());
    await new Promise<void>((r) => this.http ? this.http.close(() => r()) : r());
  }
}
