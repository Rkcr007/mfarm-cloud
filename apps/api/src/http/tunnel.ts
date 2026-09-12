import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  TUNNEL_PATH, CUSTOMER_TUNNEL_PATH, TUNNEL_MAX_FRAME_BYTES, isTunnelFrame,
  TUNNEL_CH_CONTROL_PLANE_BASE, TUNNEL_CH_STEP,
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

/**
 * What the control plane does with a proxy channel an agent opened (migration 052).
 *
 * A CALLBACK RATHER THAN A METHOD, because routing it needs the database — the device row, its live
 * session, that session's org and the tunnel it named — and this class has never touched a database
 * and must not start. `server.ts` supplies the handler; this file supplies the bytes.
 */
export interface ProxyOpen {
  hostId: string;
  /** The device's `local_id`, as the agent named it. The ONLY thing the agent gets to say. */
  localId: string;
  send(d: string): void;
  close(reason: string): void;
  onInbound(fn: (d: string) => void): void;
  onClosed(fn: (reason: string) => void): void;
}

export class TunnelRegistry {
  private readonly hosts = new Map<string, HostTunnel>();

  /** Set by `attachTunnel` when a proxy router is supplied. Absent means proxy channels are refused. */
  private onProxyOpen: ((o: ProxyOpen) => void | Promise<void>) | undefined;

  /** Per-channel close callbacks for the router, kept off `ChannelSink` so its shape stays one
   *  thing. The inbound handler is a closure per channel — see the buffer in `acceptProxy`. */
  private readonly proxyClose = new Map<number, (reason: string) => void>();

  /** Install the router. Called once, by `attachTunnel`. */
  setProxyRouter(fn: (o: ProxyOpen) => void | Promise<void>): void {
    this.onProxyOpen = fn;
  }

  /**
   * Whether a host can currently be reached.
   *
   * READ BY THE INFRASTRUCTURE PAGE since 2026-09-12 (`infra/snapshot.ts`), which is what this
   * comment spent months asking for: a host that beats over plain HTTPS while its tunnel is down
   * reads as perfectly healthy on a farm where every live view and every automation command fails.
   * It is now the difference between `live` and `stale` there, and it raises `tunnel-down` on the
   * host card.
   *
   * Still NOT read on the DEVICE card, which is the other half and a separate change: a device that
   * says READY while its host has no tunnel is telling a viewer the opposite of what they are about
   * to experience. The fleet-wide count remains exported as `mfarm_tunnel_hosts_connected`.
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

    const tunnel: HostTunnel = { agent, channels: new Map(), nextCh: TUNNEL_CH_CONTROL_PLANE_BASE };
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
    // has closed cannot land on its replacement. EVEN, because the agent now allocates odd ones for
    // the proxy channels a device opens — see `TunnelFrame` in the protocol.
    const ch = tunnel.nextCh;
    tunnel.nextCh += TUNNEL_CH_STEP;
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

    // Even, from the same counter as `openChannel` — one allocator per side is the whole point of
    // the parity split, so this must NOT get a counter of its own.
    const ch = tunnel.nextCh;
    tunnel.nextCh += TUNNEL_CH_STEP;
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

    /**
     * `open` FROM AN AGENT IS NOW A THING, and it is exactly one thing: a `proxy` channel, because
     * a device wants to reach the customer's network (migration 052). Everything else an agent
     * might open is still refused.
     *
     * This is the change that made the channel id space need a parity split — see `TunnelFrame` in
     * the protocol. Before it, the control plane was the only allocator and an agent-sent `open`
     * could only be a bug or a forgery.
     */
    if (frame.t === 'open') {
      if (frame.kind !== 'proxy' || !this.onProxyOpen) {
        this.sendToAgent(tunnel, { ch: frame.ch, t: 'close', reason: 'this channel kind cannot be opened by an agent' });
        return;
      }
      // A repeated open on a live id would orphan the first request. Ids are allocated by one side
      // and never reused, so this is a bug or a forgery either way.
      if (tunnel.channels.has(frame.ch)) {
        this.sendToAgent(tunnel, { ch: frame.ch, t: 'close', reason: 'channel already open' });
        return;
      }
      this.acceptProxy(tunnel, frame.ch, frame.ref ?? '');
      return;
    }

    const sink = tunnel.channels.get(frame.ch);
    if (!sink) return;

    if (frame.t === 'data') {
      sink.deliver(frame.d);
      return;
    }
    tunnel.channels.delete(frame.ch);
    sink.drop(frame.reason ?? 'the agent closed this channel');
  }

  /**
   * Hand an agent-opened proxy channel to whoever knows how to route it.
   *
   * THE REGISTRY STILL DECIDES NOTHING. It allocates a sink, copies bytes and tears down — exactly
   * as it does for a browser. Which org this device belongs to, which tunnel its session named and
   * whether either exists are questions about ROWS, and they are answered by the handler this
   * class is given rather than by this class, for the same reason every other decision in this file
   * lives somewhere else.
   */
  private acceptProxy(tunnel: HostTunnel, ch: number, localId: string): void {
    const send = (d: string) => this.sendToAgent(tunnel, { ch, t: 'data', d });
    const close = (reason: string) => {
      if (tunnel.channels.delete(ch)) this.sendToAgent(tunnel, { ch, t: 'close', reason });
    };

    /**
     * FRAMES ARE BUFFERED UNTIL THE ROUTER HAS SAID WHERE THEY GO, and this is not defensive
     * padding — without it the feature does not work at all.
     *
     * The agent sends `open` and then the request head IMMEDIATELY; there is nothing for it to wait
     * for, and making it wait would add a round trip to every request a device makes. The router,
     * meanwhile, has to ask the database which session this device is holding before it knows which
     * tunnel to open. So the head reliably arrives before there is anywhere to put it, and dropping
     * it produces a request that is routed correctly and then never answered — a 60-second timeout
     * on the device with nothing wrong anywhere in the logs.
     *
     * Found by the end-to-end test on its first run, and the signature was diagnostic: every
     * REFUSAL passed (those are decided before any data is needed) and every SUCCESS timed out.
     */
    const pending: string[] = [];
    let deliver: ((d: string) => void) | undefined;

    tunnel.channels.set(ch, {
      kind: 'proxy',
      deliver: (d) => { if (deliver) deliver(d); else pending.push(d); },
      drop: (reason) => { this.proxyClose.get(ch)?.(reason); this.proxyClose.delete(ch); },
    });

    void this.onProxyOpen?.({
      hostId: this.hostIdOf(tunnel) ?? '',
      localId,
      send,
      close: (reason) => { deliver = undefined; this.proxyClose.delete(ch); close(reason); },
      onInbound: (fn) => {
        deliver = fn;
        // Drained in arrival order, which is the order the head and its body chunks were sent in.
        // Anything else would hand an HTTP parser a body before its request line.
        for (const d of pending.splice(0)) fn(d);
      },
      onClosed: (fn) => this.proxyClose.set(ch, fn),
    });
  }

  private hostIdOf(tunnel: HostTunnel): string | undefined {
    for (const [id, t] of this.hosts) if (t === tunnel) return id;
    return undefined;
  }
}

/**
 * Hook the two WebSocket paths onto Fastify's own HTTP server.
 *
 * Fastify has no WebSocket of its own here and none is added: this takes the raw `upgrade` event,
 * which is the whole of the integration. Anything that is not one of the two paths has its socket
 * destroyed rather than being left to time out.
 */
export function attachTunnel(
  app: FastifyInstance,
  registry: TunnelRegistry,
  /**
   * The customer tunnel's upgrade handler (migration 052), if one is mounted.
   *
   * Passed IN rather than constructed here so this file keeps knowing nothing about the customer
   * tunnel beyond "there may be another claimant for an upgrade". The two are different directions
   * with different credentials and only one thing in common — Fastify's `upgrade` event, of which
   * there is exactly one.
   */
  customerUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<boolean>,
  /** Where an agent-opened `proxy` channel goes. Absent means proxy channels are refused, which is
   *  the honest answer for a control plane with no customer tunnels mounted. */
  proxyRouter?: (o: ProxyOpen) => void | Promise<void>,
): void {
  if (proxyRouter) registry.setProxyRouter(proxyRouter);
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

    /**
     * The CUSTOMER tunnel (migration 052) — a customer's client dialling in so a device can reach
     * their private network. Delegated rather than handled here: it is the other direction and its
     * own authentication story, and `customer-tunnel.ts` says why.
     *
     * It returns whether it took the socket, so this chain stays the single place that decides what
     * an unrecognised upgrade path gets — which is a 404 and not a hung connection.
     */
    if (customerUpgrade) {
      void customerUpgrade(req, socket, head).then((taken) => {
        if (taken) return;
        if (!path.startsWith('/dp/')) refuse(socket, '404 Not Found');
      }).catch(() => refuse(socket, '500 Internal Server Error'));
      if (path === CUSTOMER_TUNNEL_PATH) return;
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
