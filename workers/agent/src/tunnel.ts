import { WebSocket } from 'ws';
import { TUNNEL_PATH, TUNNEL_MAX_FRAME_BYTES, isTunnelFrame, type TunnelFrame } from '@mfarm/protocol';
import type { Agent } from './agent.ts';
import type { DataPlane, DataPlaneSocket } from './dataplane.ts';
import { AutomationChannel } from './automation-tunnel.ts';

/**
 * The agent's end of the data-plane tunnel.
 *
 * One outbound WebSocket to the control plane, held open, carrying every browser that wants to look
 * at a device on this host. The control plane opens a channel per viewer; each channel is handed to
 * the existing `DataPlane` as an ordinary socket, so the hello, the offline grant verification, the
 * fence check, the sequence gate and the input coalescing are the SAME CODE on both transports.
 * That equivalence is the design: an authorization check that exists twice is a check that will
 * eventually disagree with itself.
 *
 * Nothing here reads a frame's contents. `d` goes to the data plane as it arrived and comes back
 * the same way.
 */

export interface TunnelOptions {
  controlPlaneUrl: string;
  agent: Agent;
  dataPlane: DataPlane;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Backoff bounds. Defaults are 1s doubling to 30s, the same shape the Appium supervisor uses. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Where this agent's own automation gateway listens, for `automation` channels (ADR-0011).
   *
   * Absent means this host does not serve WebDriver over the tunnel, and an `automation` channel is
   * refused rather than opened. That is the honest answer for an agent with no Appium: the
   * alternative is a channel that accepts a request and then cannot answer it.
   */
  automationTarget?: { host: string; port: number };
}

/**
 * One browser, as the data plane sees it.
 *
 * Implements exactly `DataPlaneSocket` and nothing more, which is what keeps the data plane unable
 * to tell the two transports apart.
 */
class TunnelChannel implements DataPlaneSocket {
  private readonly onMessage: Array<(raw: { toString(): string }) => void> = [];
  private readonly onClose: Array<() => void> = [];
  private closed = false;

  private readonly ch: number;
  private readonly out: (f: TunnelFrame) => void;

  constructor(ch: number, out: (f: TunnelFrame) => void) {
    this.ch = ch;
    this.out = out;
  }

  send(data: string): void {
    if (this.closed) return;
    this.out({ ch: this.ch, t: 'data', d: data });
  }

  close(): void {
    if (this.closed) return;
    // Tell the far side before tearing down locally, so the browser is closed rather than left
    // waiting on a socket nothing will ever answer.
    this.out({ ch: this.ch, t: 'close' });
    this.remoteClose();
  }

  on(event: 'message', cb: (raw: { toString(): string }) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: () => void): void;
  on(event: 'message' | 'close' | 'error', cb: (...args: never[]) => void): void {
    if (event === 'message') this.onMessage.push(cb as unknown as (raw: { toString(): string }) => void);
    // A channel has no error condition of its own: the tunnel either delivers or is gone, and gone
    // is a close. Accepting the handler and never firing it keeps the interface honest.
    else if (event === 'close') this.onClose.push(cb as () => void);
  }

  deliver(data: string): void {
    if (this.closed) return;
    for (const cb of this.onMessage) cb(data);
  }

  /** The far side hung up, or the tunnel did. Idempotent — teardown runs once. */
  remoteClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.onClose) cb();
  }
}

export class AgentTunnel {
  private ws?: WebSocket;
  private readonly channels = new Map<number, TunnelChannel>();
  /**
   * Automation channels, kept in their own map (ADR-0011).
   *
   * Separate rather than a union in one map because they have different lifetimes and different
   * teardown: a data-plane channel is a viewer that lasts as long as somebody is looking, and an
   * automation channel is ONE WebDriver command. Keeping `channelCount` — which the heartbeat
   * reports as live viewers — counting only the first is the reason this is not one map.
   */
  private readonly automation = new Map<number, AutomationChannel>();
  private stopped = false;
  private backoff: number;
  private timer?: NodeJS.Timeout;
  private readonly opts: TunnelOptions;

  constructor(opts: TunnelOptions) {
    this.opts = opts;
    this.backoff = opts.minBackoffMs ?? 1_000;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Number of live viewers. Exposed for the heartbeat and for tests. */
  get channelCount(): number {
    return this.channels.size;
  }

  start(): void {
    this.stopped = false;
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.dropAllChannels('agent shutting down');
    this.ws?.close();
    this.ws = undefined;
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    this.opts.log?.(msg, meta);
  }

  private dial(): void {
    if (this.stopped) return;

    // Registration issues the credential, so there is nothing to dial with until it has run. This
    // is not an error: the agent registers first and the tunnel simply waits for it.
    const token = this.opts.agent.workerToken;
    if (!token) {
      this.retry('not registered yet');
      return;
    }

    const url = this.opts.controlPlaneUrl.replace(/^http/, 'ws') + TUNNEL_PATH;
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
      maxPayload: TUNNEL_MAX_FRAME_BYTES,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = this.opts.minBackoffMs ?? 1_000;
      this.log('data-plane tunnel connected', { url });
    });

    ws.on('message', (raw) => this.onFrame(raw.toString()));

    ws.on('close', (code) => {
      if (ws !== this.ws) return;
      // Every viewer on this tunnel is gone with it. Closing them explicitly is what stops a
      // dropped tunnel from leaving an `adb logcat` child and a signalling socket running against
      // a device that is about to be handed to somebody else.
      this.dropAllChannels(`tunnel closed (${code})`);
      this.retry(`closed with ${code}`);
    });

    // A failed dial emits error THEN close, so recovery lives in the close handler only — retrying
    // in both would halve the backoff on every failure and turn it into a hot loop.
    ws.on('error', (err) => this.log('data-plane tunnel error', { error: (err as Error).message }));
  }

  private retry(why: string): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 30_000);
    this.log('data-plane tunnel retrying', { why, delayMs: delay });
    this.timer = setTimeout(() => this.dial(), delay);
    // A reconnect timer must never be the reason a draining agent cannot exit.
    this.timer.unref?.();
  }

  private dropAllChannels(reason: string): void {
    for (const ch of this.channels.values()) ch.remoteClose();
    this.channels.clear();
    // An in-flight WebDriver command whose tunnel just died has nowhere to send its answer, and the
    // request it is holding open keeps that device's Appium busy. Aborting is what frees it.
    for (const ch of this.automation.values()) ch.abort();
    this.automation.clear();
    if (reason) this.log('data-plane channels dropped', { reason });
  }

  private sendFrame(f: TunnelFrame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(f)); } catch { /* the close handler cleans up */ }
  }

  private onFrame(raw: string): void {
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!isTunnelFrame(frame)) return;

    if (frame.t === 'open') {
      // A repeated open for a live channel would orphan the first one's logcat child and its
      // signalling socket. The control plane allocates ids and does not reuse them, so this is a
      // bug or a forgery either way; refusing is the safe reading of both. Checked across BOTH
      // maps: the id space is shared, so a collision is a collision whatever the channel carries.
      if (this.channels.has(frame.ch) || this.automation.has(frame.ch)) {
        this.sendFrame({ ch: frame.ch, t: 'close', reason: 'channel already open' });
        return;
      }
      if (frame.kind === 'automation') return this.openAutomation(frame.ch);
      const channel = new TunnelChannel(frame.ch, (f) => this.sendFrame(f));
      this.channels.set(frame.ch, channel);
      this.opts.dataPlane.accept(channel);
      return;
    }

    const automation = this.automation.get(frame.ch);
    if (automation) {
      if (frame.t === 'data') return automation.deliver(frame.d);
      this.automation.delete(frame.ch);
      automation.abort();
      return;
    }

    const channel = this.channels.get(frame.ch);
    if (!channel) return;

    if (frame.t === 'data') return channel.deliver(frame.d);

    this.channels.delete(frame.ch);
    channel.remoteClose();
  }

  /**
   * Accept one tunnelled WebDriver command (ADR-0011).
   *
   * Refused outright on a host with no automation gateway. The control plane only sends this when
   * the device advertised a `mfarm+tunnel:` endpoint, so reaching here without a target means the
   * agent's view of itself and the control plane's have diverged — which is worth saying as a
   * closed channel with a reason, not worth papering over.
   */
  private openAutomation(ch: number): void {
    const target = this.opts.automationTarget;
    if (!target) {
      this.sendFrame({ ch, t: 'close', reason: 'this host serves no automation' });
      return;
    }
    const channel = new AutomationChannel({
      target,
      send: (f) => this.sendFrame({ ch, t: 'data', d: JSON.stringify(f) }),
      close: () => {
        // Deleted BEFORE the close frame so the terminal `end`/`err` this follows cannot be raced
        // by a late data frame arriving on an id we have already finished with.
        this.automation.delete(ch);
        this.sendFrame({ ch, t: 'close' });
      },
      log: (msg, meta) => this.log(msg, { ch, ...meta }),
    });
    this.automation.set(ch, channel);
  }
}
