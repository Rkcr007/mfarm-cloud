import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { TUNNEL_PATH, TUNNEL_MAX_FRAME_BYTES, isTunnelFrame, type TunnelFrame } from '@mfarm/protocol';
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

interface HostTunnel {
  agent: WebSocket;
  channels: Map<number, WebSocket>;
  nextCh: number;
}

export class TunnelRegistry {
  private readonly hosts = new Map<string, HostTunnel>();

  /** Whether a host can currently be reached. The console reads this to explain a dead live view. */
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
    if (tunnel.channels.size >= MAX_CHANNELS_PER_HOST) return false;

    // Monotonic and never reused for the life of the tunnel, so a late frame from a channel that
    // has closed cannot land on its replacement.
    const ch = tunnel.nextCh++;
    tunnel.channels.set(ch, browser);
    this.sendToAgent(tunnel, { ch, t: 'open' });

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

  /** Close every tunnel. Called on server shutdown. */
  closeAll(): void {
    for (const hostId of [...this.hosts.keys()]) this.dropHost(hostId, 'control plane shutting down');
  }

  private dropHost(hostId: string, reason: string): void {
    const tunnel = this.hosts.get(hostId);
    if (!tunnel) return;
    this.hosts.delete(hostId);
    // Every viewer on this tunnel loses its device with it. Telling them is what turns a frozen
    // picture into a reconnect.
    for (const browser of tunnel.channels.values()) {
      try { browser.close(1011, reason); } catch { /* already gone */ }
    }
    tunnel.channels.clear();
    try { tunnel.agent.close(); } catch { /* already gone */ }
  }

  private sendToAgent(tunnel: HostTunnel, frame: TunnelFrame): void {
    if (tunnel.agent.readyState !== WebSocket.OPEN) return;
    try { tunnel.agent.send(JSON.stringify(frame)); } catch { /* close handler cleans up */ }
  }

  private onAgentFrame(tunnel: HostTunnel, raw: string): void {
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!isTunnelFrame(frame)) return;

    const browser = tunnel.channels.get(frame.ch);
    if (!browser) return;

    if (frame.t === 'data') {
      try { browser.send(frame.d); } catch { /* the close handler cleans up */ }
      return;
    }
    // 'open' from an agent is not a thing — the control plane is the only side that opens — so it
    // falls through to the same teardown as 'close' rather than being given a meaning.
    tunnel.channels.delete(frame.ch);
    try { browser.close(); } catch { /* already gone */ }
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
    registry.closeAll();
    agentWss.close();
    browserWss.close();
  });
}
