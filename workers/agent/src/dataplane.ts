import { WebSocketServer, type WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { verifySessionToken, type SessionClaims } from '@mfarm/protocol';
import type { Agent } from './agent.ts';
import type { DeviceBackend, KeyName, LogcatHandle, SignalChannel } from './device.ts';

/**
 * The data plane — what the browser actually connects to (v2 decision 2).
 *
 * The control plane already authorised this session and is now out of the loop entirely. This server
 * verifies the token OFFLINE against the public key it was given at registration, so nothing on the
 * input path makes a network call back to the API. That is what keeps p99 tap latency independent of
 * the control plane's availability, its garbage collector, and its distance from the user.
 *
 * Media is NOT proxied through here. For Cuttlefish the browser negotiates WebRTC directly with
 * Cuttlefish's own server; this connection carries control, input, SIGNALLING and log lines only.
 *
 * Signalling was added by ADR-0007 and is the narrowest thing that could make a live view work: the
 * browser needs a few JSON frames exchanged with the device's WebRTC stack before any media exists,
 * and this socket is the only one it holds that has already proved who it is. The frames pass
 * through opaque. No frame of video does.
 */

type ClientMessage =
  | { t: 'hello'; token: string }
  | { t: 'tap'; x: number; y: number; seq: number }
  | { t: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number; seq: number }
  | { t: 'key'; name: KeyName; seq: number }
  | { t: 'text'; value: string; seq: number }
  | { t: 'rotate'; dir: 'left' | 'right'; seq: number }
  | { t: 'signal-open' }
  | { t: 'signal'; payload: unknown }
  | { t: 'logcat'; action: 'start' | 'stop' }
  | { t: 'screenshot'; id?: string }
  | { t: 'ui-dump'; id?: string };

/** Input verbs, and the only messages the coalesce/queue machinery below applies to. */
const INPUT = new Set(['tap', 'swipe', 'key', 'text', 'rotate']);

interface Conn {
  claims?: SessionClaims;
  backend?: DeviceBackend;
  lastSeq: number;
  inFlight: boolean;
  /** Discrete events waiting behind an in-flight one. See the note on coalescing below. */
  queue: ClientMessage[];
  /** One viewer, one signalling channel. Closed with the socket, never outliving it. */
  signal?: SignalChannel;
  /** Guards against a client that sends `signal-open` twice while the first is still connecting. */
  signalOpening?: boolean;
  logcat?: LogcatHandle;
  /** Lines waiting to be flushed as one frame. See LOG_FLUSH_MS. */
  logBuffer: string[];
  logTimer?: NodeJS.Timeout;
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

/**
 * How long log lines accumulate before they are sent as one frame.
 *
 * A booting Android device emits thousands of lines a second, and one WebSocket frame per line
 * turns a log pane into a denial of service against the viewer's own main thread. Batching at 200ms
 * is under the threshold where a person perceives the log as lagging behind the screen, and it caps
 * the frame rate of this channel at 5/s regardless of how loud the device is.
 */
const LOG_FLUSH_MS = 200;

/**
 * Lines held between flushes. Beyond this the OLDEST are dropped, and the client is told how many.
 *
 * Dropping the oldest rather than the newest is the opposite of the input rule two comments up, and
 * for the opposite reason: stale input describes a position the user has left, while a log is read
 * for what just happened. A silent drop would be the worst of both — the console renders the count.
 */
const MAX_LOG_BUFFER = 2_000;

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
    this.conns.set(ws, { lastSeq: -1, inFlight: false, queue: [], logBuffer: [] });

    // An unauthenticated socket is a resource an anonymous client can hold open. Close it if no
    // valid hello arrives promptly.
    const authTimer = setTimeout(() => {
      if (!this.conns.get(ws)?.claims) this.reject(ws, 'auth_timeout', 'No hello within 5s.');
    }, 5_000);

    ws.on('message', (raw) => { void this.onMessage(ws, raw.toString()); });
    // Both paths go through teardown. Forgetting the connection is not enough: a dropped viewer
    // would otherwise leave an `adb logcat` child and an operator socket running against a device
    // that is about to be snapshot-restored for somebody else.
    ws.on('close', () => { clearTimeout(authTimer); this.teardown(ws); });
    ws.on('error', () => { clearTimeout(authTimer); this.teardown(ws); });
  }

  private teardown(ws: WebSocket): void {
    const conn = this.conns.get(ws);
    if (conn) {
      conn.logcat?.stop();
      if (conn.logTimer) clearTimeout(conn.logTimer);
      conn.signal?.close();
    }
    this.conns.delete(ws);
  }

  private reject(ws: WebSocket, code: string, message: string): void {
    try { ws.send(JSON.stringify({ t: 'error', code, message })); } catch { /* already gone */ }
    ws.close();
    this.teardown(ws);
  }

  private send(ws: WebSocket, msg: unknown): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* the socket is gone; the close handler cleans up */ }
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

    // The viewer verbs, handled before the input machinery below because none of them is input.
    // Putting a screenshot through the coalescing queue would let one slow `adb exec-out` stall
    // every tap behind it, and a signalling frame dropped as "stale" would wedge the negotiation.
    switch (msg.t) {
      case 'signal-open': return this.onSignalOpen(ws, conn);
      case 'signal':      return this.onSignal(ws, conn, msg.payload);
      case 'logcat':      return this.onLogcat(ws, conn, msg.action);
      case 'screenshot':  return this.onScreenshot(ws, conn, msg.id);
      case 'ui-dump':     return this.onUiDump(ws, conn, msg.id);
      default: break;
    }
    // An unknown verb is a client speaking a newer protocol than this worker. Answering rather than
    // ignoring is what lets the console degrade honestly instead of waiting forever for a reply.
    if (!INPUT.has(msg.t)) {
      return this.send(ws, { t: 'error', code: 'unknown_message', message: `This worker does not understand '${msg.t}'.` });
    }

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
    // The fence goes with it: the control plane will only activate a session whose fence still
    // matches, which is what stops a reconnecting client from re-activating a session whose device
    // has since been reset for someone else.
    this.opts.agent.beginSession(v.claims.sid, v.claims.did, v.claims.org, v.claims.fence);

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

  /**
   * Open the signalling channel for this viewer (ADR-0007).
   *
   * Split from `hello` on purpose. A WebDriver client, the CLI and `mfarm run` all hold this socket
   * and none of them wants a live view; opening an operator connection for every one of them would
   * put a WebRTC negotiation in the path of a headless test. The viewer asks, and only the viewer
   * pays.
   */
  private async onSignalOpen(ws: WebSocket, conn: Conn): Promise<void> {
    if (conn.signal || conn.signalOpening) {
      return this.send(ws, { t: 'signal-error', message: 'This connection already has a signalling channel.' });
    }
    const media = conn.backend!.media;
    if (!media.signal) {
      // Not an error — this tier genuinely cannot stream, which the capability list already says.
      // Reported as a refusal with a reason so the console can print the reason rather than a spinner.
      return this.send(ws, {
        t: 'signal-error',
        message: 'This device tier has no live view: nothing on this host negotiates a media stream for it.',
      });
    }

    conn.signalOpening = true;
    try {
      const channel = await media.signal({
        onPayload: (payload) => this.send(ws, { t: 'signal', payload }),
        onClose: (reason) => this.send(ws, { t: 'signal-error', message: reason }),
      });
      // The socket may have closed while the operator was being dialled. Without this check the
      // channel leaks: nothing else will ever close it, because teardown already ran.
      if (!this.conns.has(ws)) { channel.close(); return; }
      conn.signal = channel;
      this.send(ws, { t: 'signal-ready', deviceInfo: channel.deviceInfo, iceServers: channel.iceServers });
    } catch (e) {
      this.send(ws, { t: 'signal-error', message: (e as Error).message });
    } finally {
      conn.signalOpening = false;
    }
  }

  /** One frame of the browser's WebRTC negotiation, forwarded to the device without inspection. */
  private onSignal(ws: WebSocket, conn: Conn, payload: unknown): void {
    if (!conn.signal) {
      return this.send(ws, { t: 'signal-error', message: 'No signalling channel is open. Send signal-open first.' });
    }
    conn.signal.send(payload);
  }

  private async onLogcat(ws: WebSocket, conn: Conn, action: 'start' | 'stop'): Promise<void> {
    if (action === 'stop') {
      conn.logcat?.stop();
      conn.logcat = undefined;
      this.flushLog(ws, conn);
      return;
    }
    if (conn.logcat) return; // already following; a second start is a no-op, not an error
    const control = conn.backend!.control;
    if (!control.captureLogcat) {
      return this.send(ws, { t: 'logcat-error', message: 'This device does not declare the logcat capability.' });
    }
    try {
      // Claimed BEFORE the await so two starts racing on one socket cannot both spawn adb. The
      // placeholder is replaced by the real handle below; if the start throws it is cleared again.
      conn.logcat = { stop: () => {} };
      const handle = await control.captureLogcat((line) => this.onLogLine(ws, conn, line));
      if (!this.conns.has(ws)) { handle.stop(); return; }
      conn.logcat = handle;
      this.send(ws, { t: 'logcat-started' });
    } catch (e) {
      conn.logcat = undefined;
      this.send(ws, { t: 'logcat-error', message: (e as Error).message });
    }
  }

  private onLogLine(ws: WebSocket, conn: Conn, line: string): void {
    conn.logBuffer.push(line);
    if (conn.logBuffer.length > MAX_LOG_BUFFER) {
      const dropped = conn.logBuffer.length - MAX_LOG_BUFFER;
      conn.logBuffer.splice(0, dropped);
      this.send(ws, { t: 'logcat-dropped', lines: dropped });
    }
    if (conn.logTimer) return;
    conn.logTimer = setTimeout(() => this.flushLog(ws, conn), LOG_FLUSH_MS);
    conn.logTimer.unref?.();
  }

  private flushLog(ws: WebSocket, conn: Conn): void {
    if (conn.logTimer) { clearTimeout(conn.logTimer); conn.logTimer = undefined; }
    if (conn.logBuffer.length === 0) return;
    const lines = conn.logBuffer;
    conn.logBuffer = [];
    this.send(ws, { t: 'logcat', lines });
  }

  /**
   * One frame, on demand.
   *
   * Base64 over the same socket rather than a binary frame, because the console's whole protocol
   * here is JSON and a mixed text/binary socket means the client has to demultiplex by frame type
   * to find out which request an anonymous blob answered. The cost is 33% on an image that is
   * already only sent when a person asks for one.
   */
  private async onScreenshot(ws: WebSocket, conn: Conn, id?: string): Promise<void> {
    const control = conn.backend!.control;
    if (!control.screenshot) {
      return this.send(ws, { t: 'screenshot-error', id, message: 'This device does not declare the screenshot capability.' });
    }
    try {
      const shot = await control.screenshot();
      this.send(ws, {
        t: 'screenshot',
        id,
        contentType: shot.contentType,
        data: shot.bytes.toString('base64'),
        takenAt: new Date().toISOString(),
      });
    } catch (e) {
      this.send(ws, { t: 'screenshot-error', id, message: (e as Error).message });
    }
  }

  /**
   * The view tree on screen, on demand.
   *
   * Out of the coalescing queue for the same reason a screenshot is: it costs an adb round trip,
   * and putting it behind the input queue would let one slow dump stall every tap behind it.
   *
   * The XML travels as-is. It is a few tens of kilobytes on a busy screen, it is text on a socket
   * that is already JSON, and parsing it in the worker would put a second copy of Android's layout
   * format somewhere it has to be kept in step.
   */
  private async onUiDump(ws: WebSocket, conn: Conn, id?: string): Promise<void> {
    const control = conn.backend!.control;
    if (!control.uiHierarchy) {
      return this.send(ws, { t: 'ui-dump-error', id, message: 'This device does not declare the ui-hierarchy capability.' });
    }
    try {
      this.send(ws, { t: 'ui-dump', id, xml: await control.uiHierarchy(), takenAt: new Date().toISOString() });
    } catch (e) {
      this.send(ws, { t: 'ui-dump-error', id, message: (e as Error).message });
    }
  }

  private async dispatch(backend: DeviceBackend, msg: ClientMessage): Promise<void> {
    const c = backend.control;
    switch (msg.t) {
      case 'tap':   return c.tap(msg.x, msg.y);
      case 'swipe': return c.swipe(msg.x1, msg.y1, msg.x2, msg.y2, msg.durationMs);
      case 'key':   return c.key(msg.name);
      case 'text':  return c.text(msg.value);
      case 'rotate':
        // Discrete and slow: a sensor injection, not a display flip. Queued behind whatever is in
        // flight rather than coalesced, because two rotations are two distinct intentions.
        if (!c.rotate) throw new Error('This device cannot be rotated: it exposes no sensor injection.');
        return c.rotate(msg.dir);
      default:      return;
    }
  }

  async close(): Promise<void> {
    for (const ws of [...this.conns.keys()]) { this.teardown(ws); ws.close(); }
    this.conns.clear();
    await new Promise<void>((r) => this.wss ? this.wss.close(() => r()) : r());
    await new Promise<void>((r) => this.http ? this.http.close(() => r()) : r());
  }
}
