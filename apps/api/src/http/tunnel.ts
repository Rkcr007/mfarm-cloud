import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  TUNNEL_PATH, TUNNEL_MAX_FRAME_BYTES, isTunnelFrame,
  type TunnelChannelKind, type TunnelFrame,
} from '@mfarm/protocol';
import { authenticate } from '../auth.ts';

/**
 * The control plane's end of the data-plane tunnel.
 *
 * THE PROBLEM IT SOLVES. `/dp/<hostId>` used to be proxied by the ingress straight to a worker, at
 * ONE address written into the Caddyfile. That is two limits wearing one coat: only a single device
 * host can ever serve a live view, and that host has to be dialable. A phone arrives on a laptop
 * behind NAT, where neither holds.
 *
 * WHAT THIS IS NOT. It is not an authorization boundary, and it must never become one. The browser
 * arriving at `/dp/<hostId>` is NOT authenticated here — its credential is the Ed25519 grant inside
 * its own `hello` frame, which only the agent can verify and only the agent does verify, offline,
 * against a public key it holds and a fence it maintains. This class allocates a channel and copies
 * bytes. Every frame is relayed as the opaque string it arrived as, deliberately: a control plane
 * that parsed these would be one refactor away from editing them, and the property worth keeping is
 * that it cannot.
 *
 * That is also why this does not reopen ADR-0004. A VPN was refused there because it authenticates
 * the network rather than the request; this authenticates neither, and leaves the request check
 * exactly where that ADR put it.
 */

/**
 * Cap on live viewers per host.
 *
 * `/dp/*` takes no credential, so without a cap anyone who knows a host id can open sockets until
 * the process runs out of them. A channel that never sends a valid hello is closed by the AGENT
 * after five seconds, which bounds the damage on its own — this bounds it here too, because a limit
 * that depends on the other end being healthy is not a limit.
 */
const MAX_CHANNELS_PER_HOST = 32;

/**
 * Cap on in-flight automation commands per host, counted SEPARATELY from viewers.
 *
 * Sharing one budget looked tidy and is wrong in both directions. `/dp/*` takes no credential, so
 * the viewer cap is a defence against strangers; an automation channel is opened by the hub itself,
 * for a device it has already allocated to a paying session, and is bounded by the host's device
 * count as a result. Counting them together would let anyone who knows a host id open 32 sockets
 * and stop that host serving WebDriver — a denial of service on the paid path, mounted from the
 * unauthenticated one.
 *
 * 64 rather than a device count because a host's device count is not known here, and because the
 * number is a backstop against a leak in this file rather than a scheduling limit. A host with more
 * than 64 WebDriver commands genuinely in flight has more devices than any farm this has run on.
 */
const MAX_AUTOMATION_CHANNELS_PER_HOST = 64;

/**
 * How often the control plane pings each agent tunnel, and so how fast a dead one is reclaimed.
 *
 * THE SYMMETRIC HALF of the agent's own keepalive (`workers/agent/src/tunnel.ts`), and it is needed
 * for the opposite failure: a device host that loses power or drops off its network leaves a socket
 * here that TCP will not report for minutes, and until it is reaped `has(hostId)` answers true and
 * `openChannel` hands viewers a channel whose frames go nowhere. `attach` already replaces a stale
 * socket when the SAME agent redials — this covers the one that never comes back.
 *
 * A missed pong on the next tick terminates the socket, so detection takes one to two intervals.
 */
function tunnelPingIntervalMs(): number {
  return Number(process.env.TUNNEL_PING_INTERVAL_MS ?? 30_000);
}

/**
 * Where a channel's inbound frames go, and how it is torn down.
 *
 * An indirection over `WebSocket` so that a channel does not have to be a browser. ADR-0011 adds
 * one that is not: an automation channel's far end is the hub, in this process. The registry still
 * only copies bytes — this is the seam that lets something other than a socket be on the near end
 * of the copy, and nothing more.
 */
interface ChannelSink {
  /** Which budget this channel is counted against. See the two caps above. */
  kind: TunnelChannelKind;
  deliver(d: string): void;
  drop(reason: string): void;
}

interface HostTunnel {
  agent: WebSocket;
  channels: Map<number, ChannelSink>;
  nextCh: number;
}

/** A channel this process holds itself, rather than one that terminates in a browser. */
export interface ControlChannel {
  send(d: string): void;
  close(): void;
}

export class TunnelRegistry {
  private readonly hosts = new Map<string, HostTunnel>();

  /**
   * Whether a host can currently be reached.
   *
   * NOT YET READ BY THE CONSOLE, which is where it belongs: a device card that says READY while its
   * host has no tunnel is telling a viewer the opposite of what they are about to experience. Until
   * then the fleet-wide count is exported as `mfarm_tunnel_hosts_connected` and alerted on, so the
   * condition is at least visible to an operator, if not to the person clicking the device.
   */
  has(hostId: string): boolean {
    return this.hosts.get(hostId)?.agent.readyState === WebSocket.OPEN;
  }

  get size(): number {
    return this.hosts.size;
  }

  /**
   * A worker's tunnel arrived.
   *
   * A second connection for the same host REPLACES the first. An agent that restarted — or a
   * laptop that closed its lid and woke up on a different network — leaves a socket the far side
   * has forgotten about, and TCP will not tell us for minutes. The newest authenticated connection
   * is the truthful one; the old one and everything riding it is closed rather than left to race.
   */
  attach(hostId: string, agent: WebSocket, log?: FastifyInstance['log']): void {
    const existing = this.hosts.get(hostId);
    if (existing) {
      log?.warn({ hostId }, 'worker tunnel replaced by a newer connection');
      this.dropHost(hostId, 'replaced by a newer tunnel');
    }

    const tunnel: HostTunnel = { agent, channels: new Map(), nextCh: 1 };
    this.hosts.set(hostId, tunnel);

    agent.on('message', (raw) => this.onAgentFrame(tunnel, raw.toString()));
    agent.on('close', () => {
      // Only if it is still the current one: a replaced socket's close must not evict its successor.
      if (this.hosts.get(hostId) === tunnel) this.dropHost(hostId, 'worker tunnel closed');
    });
    agent.on('error', () => { /* close follows; recovery lives there so it runs once */ });
  }

  /**
   * A browser wants to look at a device on `hostId`.
   *
   * Returns false when there is nowhere to send it, which the caller turns into a closed socket
   * with a reason a person can act on. Silence here reads to a viewer exactly like a broken device.
   */
  openChannel(hostId: string, browser: WebSocket): boolean {
    const tunnel = this.hosts.get(hostId);
    if (!tunnel || tunnel.agent.readyState !== WebSocket.OPEN) return false;
    if (this.countOf(tunnel, 'dp') >= MAX_CHANNELS_PER_HOST) return false;

    // Monotonic and never reused for the life of the tunnel, so a late frame from a channel that
    // has closed cannot land on its replacement.
    const ch = tunnel.nextCh++;
    tunnel.channels.set(ch, {
      kind: 'dp',
      deliver: (d) => { try { browser.send(d); } catch { /* the close handler cleans up */ } },
      drop: (reason) => { try { browser.close(1011, reason); } catch { /* already gone */ } },
    });
    // `kind` is stated rather than left to default so that reading this line answers what the
    // channel carries. An agent built before ADR-0011 ignores the field and gets what it expects.
    this.sendToAgent(tunnel, { ch, t: 'open', kind: 'dp' });

    browser.on('message', (raw) => {
      const d = raw.toString();
      // Frames are relayed, never inspected. The size check is the one exception and it is about
      // memory, not meaning.
      if (d.length > TUNNEL_MAX_FRAME_BYTES) { browser.close(); return; }
      this.sendToAgent(tunnel, { ch, t: 'data', d });
    });

    const closeChannel = () => {
      if (tunnel.channels.delete(ch)) this.sendToAgent(tunnel, { ch, t: 'close' });
    };
    browser.on('close', closeChannel);
    browser.on('error', closeChannel);
    return true;
  }

  /**
   * Open a channel this process holds itself — ADR-0011, the hub's automation path.
   *
   * Same allocation, same relay, same cap as a browser's channel. The ONLY differences are that
   * the near end is a callback rather than a socket, and that the open frame names its kind so the
   * agent routes it to its gateway instead of to the data plane.
   *
   * `undefined` when the host has no tunnel, which the hub turns into `automation_unreachable` —
   * the same error a dead direct endpoint produces, because to a suite it is the same fact.
   *
   * This does not make the registry an authorization boundary any more than `openChannel` does. It
   * still copies opaque strings; the grant inside them is minted by the hub and checked by the
   * agent, and this class remains unable to read either.
   */
  openControlChannel(
    hostId: string,
    handlers: { onData: (d: string) => void; onClose: (reason: string) => void },
  ): ControlChannel | undefined {
    const tunnel = this.hosts.get(hostId);
    if (!tunnel || tunnel.agent.readyState !== WebSocket.OPEN) return undefined;
    if (this.countOf(tunnel, 'automation') >= MAX_AUTOMATION_CHANNELS_PER_HOST) return undefined;

    const ch = tunnel.nextCh++;
    tunnel.channels.set(ch, {
      kind: 'automation',
      deliver: (d) => handlers.onData(d),
      drop: (reason) => handlers.onClose(reason),
    });
    this.sendToAgent(tunnel, { ch, t: 'open', kind: 'automation' });

    return {
      send: (d) => {
        // Only while it is still ours. A channel the agent closed has been deleted from the map
        // already, and writing to its id would land on whatever the agent reuses it for — which is
        // nothing, because ids are monotonic, but the check is what makes that true here too.
        if (tunnel.channels.has(ch)) this.sendToAgent(tunnel, { ch, t: 'data', d });
      },
      close: () => {
        if (tunnel.channels.delete(ch)) this.sendToAgent(tunnel, { ch, t: 'close' });
      },
    };
  }

  /** Close every tunnel. Called on server shutdown. */
  closeAll(): void {
    for (const hostId of [...this.hosts.keys()]) this.dropHost(hostId, 'control plane shutting down');
  }

  private dropHost(hostId: string, reason: string): void {
    const tunnel = this.hosts.get(hostId);
    if (!tunnel) return;
    this.hosts.delete(hostId);
    // Every viewer on this tunnel loses its device with it. Telling them is what turns a frozen
    // picture into a reconnect — and, for an automation channel, a WebDriver error instead of a
    // command that hangs until the hub's own timeout.
    for (const sink of tunnel.channels.values()) sink.drop(reason);
    tunnel.channels.clear();
    try { tunnel.agent.close(); } catch { /* already gone */ }
  }

  /** How many of one kind this host currently has open. Both maps are tens of entries at most. */
  private countOf(tunnel: HostTunnel, kind: TunnelChannelKind): number {
    let n = 0;
    for (const sink of tunnel.channels.values()) if (sink.kind === kind) n++;
    return n;
  }

  private sendToAgent(tunnel: HostTunnel, frame: TunnelFrame): void {
    if (tunnel.agent.readyState !== WebSocket.OPEN) return;
    try { tunnel.agent.send(JSON.stringify(frame)); } catch { /* close handler cleans up */ }
  }

  private onAgentFrame(tunnel: HostTunnel, raw: string): void {
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!isTunnelFrame(frame)) return;

    const sink = tunnel.channels.get(frame.ch);
    if (!sink) return;

    if (frame.t === 'data') {
      sink.deliver(frame.d);
      return;
    }
    // 'open' from an agent is not a thing — the control plane is the only side that opens — so it
    // falls through to the same teardown as 'close' rather than being given a meaning.
    tunnel.channels.delete(frame.ch);
    sink.drop(frame.t === 'close' ? (frame.reason ?? 'the agent closed this channel') : 'protocol error');
  }
}

/**
 * Hook the two WebSocket paths onto Fastify's own HTTP server.
 *
 * Fastify has no WebSocket of its own here and none is added: this takes the raw `upgrade` event,
 * which is the whole of the integration. Anything that is not one of the two paths has its socket
 * destroyed rather than being left to time out.
 */
export function attachTunnel(app: FastifyInstance, registry: TunnelRegistry): void {
  const agentWss = new WebSocketServer({ noServer: true, maxPayload: TUNNEL_MAX_FRAME_BYTES });
  const browserWss = new WebSocketServer({ noServer: true, maxPayload: TUNNEL_MAX_FRAME_BYTES });

  /**
   * Which agent sockets have answered a ping since the last tick.
   *
   * A `WeakSet` rather than a property bolted onto the socket: `ws.WebSocket` has no field for this
   * and adding one means either an `any` or a declaration-merge, both of which put a liveness detail
   * into the type of every socket in the process. Membership here means "answered"; the sweep
   * removes it before each ping, so a socket that misses one is not in the set on the next tick.
   */
  const answered = new WeakSet<WebSocket>();

  /**
   * Ping every agent tunnel; terminate the ones that stopped answering.
   *
   * `terminate()` rather than `close()`, for the reason the agent's own keepalive gives: a graceful
   * close is a handshake and the premise is that the far end is not answering. Terminating
   * synthesises the `close` event that `attach()` already listens for, so `dropHost` runs and every
   * viewer riding that tunnel is told — rather than being left on a channel relaying into nothing.
   */
  const keepalive = setInterval(() => {
    for (const ws of agentWss.clients) {
      if (!answered.has(ws)) { ws.terminate(); continue; }
      answered.delete(ws);
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }, tunnelPingIntervalMs());
  // Never the reason the process cannot exit — a live interval would hang every test in this file.
  keepalive.unref?.();

  /**
   * A PLAIN GET of `/dp/<anything>` answers 426, exactly as the worker's own listener does
   * (`workers/agent/src/dataplane.ts`).
   *
   * This is not decoration. Moving `/dp/*` from the worker to here changes what a non-upgrade
   * request meets: the upgrade handler below never fires for one, so without this route Fastify
   * answers 404 and `deploy/verify-live.sh` — which probes `/dp/probe` and requires 426 — reports
   * "the live view has no route to the worker" over a live view that is working perfectly. A gate
   * that fails on a healthy farm gets muted, and a muted gate is not a gate.
   *
   * Byte-identical to the worker's answer ON PURPOSE. The claim this whole tunnel makes is that
   * the two transports are indistinguishable to everything above them; a probe that can tell them
   * apart is that claim being false in the one place anybody checks it.
   *
   * It says nothing about whether the host exists. `/dp/*` takes no credential, so a status code
   * that varied with a real host id would hand an unauthenticated caller a fleet enumerator — the
   * upgrade path is equally uniform, and closes with 1013 only after the socket is established.
   *
   * UNLIMITED, like `/health`, and for the same reason rather than by copying it: this handler
   * touches no database, allocates nothing, and returns a constant shorter than the request that
   * asked for it, so there is no amplification to rate limit. Stated explicitly instead of left to
   * the plugin, because whether a globally-registered limiter reaches a route declared before it is
   * a question about Fastify's boot order — and a probe that 429s is a farm reported broken.
   */
  app.all('/dp/*', { config: { rateLimit: false } }, async (_req, reply) =>
    reply.code(426).header('connection', 'close').type('text/plain').send('websocket only'),
  );

  const refuse = (socket: Duplex, status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];

    if (path === TUNNEL_PATH) {
      // The ONE authenticated socket in this file. A worker token names a host, and a host may only
      // ever open its own tunnel — there is no parameter here that could name another.
      void authenticate(req.headers.authorization).then((principal) => {
        if (principal?.kind !== 'worker') return refuse(socket, '401 Unauthorized');
        agentWss.handleUpgrade(req, socket, head, (ws) => {
          app.log.info({ hostId: principal.hostId }, 'worker tunnel connected');
          // Seeded as answered, so a socket that arrives just after a sweep is not terminated
          // before it has been asked anything.
          answered.add(ws);
          ws.on('pong', () => answered.add(ws));
          registry.attach(principal.hostId, ws, app.log);
        });
      }).catch(() => refuse(socket, '500 Internal Server Error'));
      return;
    }

    if (path.startsWith('/dp/')) {
      const hostId = decodeURIComponent(path.slice(4));
      if (!hostId) return refuse(socket, '404 Not Found');
      browserWss.handleUpgrade(req, socket, head, (ws) => {
        if (registry.openChannel(hostId, ws)) return;
        // 1013 is "try again later", which is what this is: the host is not reachable right now.
        // Distinguished from a closed socket with no reason, which a viewer cannot tell from a
        // network fault of its own.
        ws.close(1013, 'No agent is connected for this host.');
      });
      return;
    }

    refuse(socket, '404 Not Found');
  });

  app.addHook('onClose', async () => {
    clearInterval(keepalive);
    registry.closeAll();
    agentWss.close();
    browserWss.close();
  });
}
