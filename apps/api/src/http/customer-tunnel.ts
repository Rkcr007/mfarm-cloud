import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  CUSTOMER_TUNNEL_PATH, TUNNEL_MAX_FRAME_BYTES,
  isValidTunnelName, isProxyFrame,
  type ProxyFrame, type TunnelAllowRule, type TunnelControlFrame, type TunnelHello,
} from '@mfarm/protocol';
import { authenticate } from '../auth.ts';
import { withTenant } from '../db.ts';

/**
 * The control plane's end of the CUSTOMER tunnel (migration 052).
 *
 * THE PROBLEM. An app under test talks to `staging.acme.internal`, which is on the customer's
 * network and has no route from this farm. So the most common thing a team wants to test is the one
 * thing the product cannot do.
 *
 * THE SHAPE IS THE AGENT TUNNEL, POINTED THE OTHER WAY. The side with the private network dials
 * out, because a customer cannot open a port for us any more than a laptop behind NAT can — and
 * asking them to is asking them to do the thing their security team exists to prevent. One socket
 * per tunnel, multiplexed, re-dialled with backoff.
 *
 * WHAT THIS IS NOT, and the distinction is the same one `tunnel.ts` makes about `/dp/*`: it is not
 * an authorization boundary for what gets fetched. This class authenticates the TUNNEL — an API key
 * for one org, and a name unique within it — and then copies bytes. **What may be reached is
 * decided by the customer's own client**, which runs inside their network and is the only party
 * that can refuse from a position of knowledge. A rule enforced here would be a rule the customer
 * had to take our word for, and a second authorization check that will eventually disagree with the
 * first.
 *
 * ROUTING IS BY ORG AND NAME, and never by anything in a request. A device's proxy channel arrives
 * carrying the org its session belongs to — derived from the session row, not from the device and
 * not from the request — which is architecture rule 4 in the one place it would be most expensive
 * to get wrong: a device that could name its own org could reach another tenant's network.
 */

/**
 * How long a client has to say hello before it is dropped.
 *
 * A socket that authenticated and then said nothing is either a broken client or somebody holding
 * connections open, and both are cheap to hold for five seconds and expensive to hold forever. The
 * agent tunnel's data-plane channels use the same five, for the same reason.
 */
const HELLO_TIMEOUT_MS = 5_000;

/**
 * Cap on in-flight proxied requests per tunnel.
 *
 * A device makes a lot of requests, and a page load is dozens. This is a backstop against a leak in
 * this file rather than a scheduling limit — a customer whose staging environment is genuinely
 * serving 256 concurrent requests from one farm device has a different problem.
 */
const MAX_CHANNELS_PER_TUNNEL = 256;

/**
 * How often the control plane pings a customer's client.
 *
 * The symmetric half of the client's own keepalive, and it exists for the failure TCP does not
 * report: a laptop that closes its lid leaves a socket here that looks open for minutes. Until it
 * is reaped `has()` answers true, and a session that asked for the tunnel starts and then cannot
 * reach anything — which reads to the person running it as "the farm is broken", the single worst
 * way to fail.
 */
function pingIntervalMs(): number {
  return Number(process.env.TUNNEL_PING_INTERVAL_MS ?? 30_000);
}

/** Where a proxied request's frames go. The near end is the device's channel, in this process. */
export interface ProxySink {
  onFrame(f: ProxyFrame): void;
  onClose(reason: string): void;
}

interface LiveTunnel {
  orgId: string;
  name: string;
  allow: TunnelAllowRule[];
  client: string | null;
  socket: WebSocket;
  channels: Map<number, ProxySink>;
  nextCh: number;
  connectedAt: number;
  requests: number;
}

/** A request this process holds open across the tunnel. */
export interface ProxyChannel {
  send(f: ProxyFrame): void;
  close(): void;
}

/** `org:name`, lowercased. One key so a tunnel cannot be reached from the wrong org by any spelling. */
const keyOf = (orgId: string, name: string) => `${orgId}:${name.toLowerCase()}`;

export class CustomerTunnelRegistry {
  private readonly live = new Map<string, LiveTunnel>();

  /** Is this org's named tunnel currently connected? */
  has(orgId: string, name: string): boolean {
    const t = this.live.get(keyOf(orgId, name));
    return t?.socket.readyState === WebSocket.OPEN;
  }

  get size(): number {
    return this.live.size;
  }

  /** What this org has connected right now, for the console. Never another org's. */
  listFor(orgId: string): Array<{ name: string; allow: TunnelAllowRule[]; client: string | null; connectedAt: number; requests: number }> {
    return [...this.live.values()]
      .filter((t) => t.orgId === orgId && t.socket.readyState === WebSocket.OPEN)
      .map((t) => ({ name: t.name, allow: t.allow, client: t.client, connectedAt: t.connectedAt, requests: t.requests }));
  }

  /**
   * A client arrived and said hello.
   *
   * A SECOND CONNECTION FOR THE SAME org+name REPLACES THE FIRST, exactly as an agent tunnel does.
   * A developer who restarts the client, or whose laptop woke on a different network, leaves a
   * socket the far side has forgotten; TCP will not say so for minutes, and the newest
   * authenticated connection is the truthful one.
   */
  attach(t: Omit<LiveTunnel, 'channels' | 'nextCh' | 'connectedAt' | 'requests'>, log?: FastifyInstance['log']): void {
    const key = keyOf(t.orgId, t.name);
    if (this.live.has(key)) {
      log?.warn({ tunnel: t.name }, 'customer tunnel replaced by a newer connection');
      this.drop(key, 'replaced by a newer connection');
    }

    const entry: LiveTunnel = {
      ...t, channels: new Map(), nextCh: 1, connectedAt: Date.now(), requests: 0,
    };
    this.live.set(key, entry);

    t.socket.on('message', (raw) => this.onClientFrame(entry, raw.toString()));
    t.socket.on('close', () => {
      // Only if it is still the current one: a replaced socket's close must not evict its successor.
      if (this.live.get(key) === entry) this.drop(key, 'client disconnected');
    });
    t.socket.on('error', () => { /* close follows; recovery lives there so it runs once */ });
  }

  /**
   * Open a proxy request across one org's named tunnel.
   *
   * `undefined` when there is no such live tunnel, which the caller turns into a `no_tunnel` error
   * the device sees as a 502 with a sentence naming the tunnel. Silence here reads to a person as
   * "staging is down", which sends them to debug the wrong machine.
   */
  open(orgId: string, name: string, sink: ProxySink): ProxyChannel | undefined {
    const t = this.live.get(keyOf(orgId, name));
    if (!t || t.socket.readyState !== WebSocket.OPEN) return undefined;
    if (t.channels.size >= MAX_CHANNELS_PER_TUNNEL) return undefined;

    // Monotonic and never reused for the life of the socket, so a late frame from a closed channel
    // cannot land on its replacement. Single-writer here: the control plane is the only side that
    // opens a channel on a CUSTOMER tunnel, which is what the agent tunnel's parity split exists to
    // restore on the other socket.
    const ch = t.nextCh++;
    t.channels.set(ch, sink);
    t.requests += 1;
    this.send(t, { ch, t: 'open' });

    return {
      send: (f) => this.send(t, { ch, t: 'data', d: JSON.stringify(f) }),
      close: () => { if (t.channels.delete(ch)) this.send(t, { ch, t: 'close' }); },
    };
  }

  /**
   * Drop one org's named tunnel now, rather than at its next reconnect.
   *
   * Used when the record is removed: a tunnel whose row is gone while its socket keeps carrying
   * traffic is the worst of both readings, because the console then shows nothing routing and the
   * traffic routes anyway.
   */
  disconnect(orgId: string, name: string, reason: string): boolean {
    const key = keyOf(orgId, name);
    if (!this.live.has(key)) return false;
    /**
     * CLOSED 1008, NOT 1001, AND THE CODE IS THE WHOLE POINT.
     *
     * The client reconnects with backoff — that is what it is for, since the thing it replaces is
     * an SSH forward that dies with a laptop's wifi. So a "going away" close means it comes
     * straight back: forgetting a tunnel in the console dropped it and the client re-registered
     * one second later, which made the control look broken while working exactly as written.
     *
     * Seen in a browser against a real client, not in a test: the page said "No tunnels yet" and
     * the API said one was connected, because between the two the client had dialled again.
     *
     * 1008 is the code the client already treats as a REFUSAL rather than a fault — it prints the
     * reason and stops — so this reuses that path rather than inventing a second one.
     */
    this.drop(key, reason, 1008);
    return true;
  }

  /** Everything this process is holding, for shutdown and for tests. */
  closeAll(reason = 'shutting down'): void {
    for (const key of [...this.live.keys()]) this.drop(key, reason);
  }

  // ---------------------------------------------------------------- internals

  private onClientFrame(t: LiveTunnel, raw: string): void {
    if (raw.length > TUNNEL_MAX_FRAME_BYTES) { t.socket.close(1009, 'frame too large'); return; }
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    const f = frame as { ch?: unknown; t?: unknown; d?: unknown };

    // A late `bye` or a stray control frame is ignored rather than fatal: the client is a program
    // a customer runs, and a control plane that dropped a working tunnel over an unrecognised
    // message would be one version skew away from an outage on their side.
    if (typeof f.ch !== 'number') return;

    const sink = t.channels.get(f.ch);
    if (!sink) return;

    if (f.t === 'close') {
      t.channels.delete(f.ch);
      sink.onClose('the client closed this request');
      return;
    }
    if (f.t !== 'data' || typeof f.d !== 'string') return;

    let inner: unknown;
    try { inner = JSON.parse(f.d); } catch { return; }
    /**
     * PARSED AND VALIDATED HERE, unlike the agent tunnel's data plane which relays opaque strings.
     *
     * That is a deliberate difference, not an inconsistency. A `/dp/*` frame is addressed to a
     * BROWSER, which is the thing that understands it, and a control plane that parsed those would
     * be one refactor away from editing somebody's input events. A proxy frame is addressed to THIS
     * PROCESS — the device's channel is held here — so there is no far end to relay to and nothing
     * to preserve verbatim. Validating it is what keeps a malformed client from reaching the code
     * that builds an HTTP response.
     */
    if (!isProxyFrame(inner)) return;
    sink.onFrame(inner);
  }

  private send(t: LiveTunnel, frame: { ch: number; t: string; d?: string }): void {
    if (t.socket.readyState !== WebSocket.OPEN) return;
    try { t.socket.send(JSON.stringify(frame)); } catch { /* close handler cleans up */ }
  }

  /**
   * `code` decides whether the client comes back. 1001 ("going away") is a fault it should retry —
   * a replaced socket, a shutdown — and 1008 is a refusal it should not. See `disconnect`.
   */
  private drop(key: string, reason: string, code = 1001): void {
    const t = this.live.get(key);
    if (!t) return;
    this.live.delete(key);
    // Every in-flight request is told, rather than left to time out. A device waiting on a socket
    // that will never answer is a test that fails in four minutes with no explanation.
    for (const sink of t.channels.values()) sink.onClose(reason);
    t.channels.clear();
    try { t.socket.close(code, reason); } catch { /* already gone */ }
  }
}

/**
 * Mount the customer tunnel endpoint.
 *
 * AUTHENTICATED WITH A TENANT API KEY, and this is the one tunnel in the repo that takes a
 * credential at the socket. The agent tunnel does too (`mwk_`), and `/dp/*` deliberately does not —
 * that one carries a per-connection Ed25519 grant the agent verifies offline. Here there is no such
 * grant to carry: the client is a program a customer starts, holding their key, and the key is what
 * says which org's devices may route through it.
 */
export function mountCustomerTunnel(
  app: FastifyInstance,
  registry: CustomerTunnelRegistry,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<boolean> {
  const wss = new WebSocketServer({ noServer: true });

  /**
   * Sockets that have connected and not yet authenticated.
   *
   * A CAP, because this path does not go through Fastify's rate limiter — an upgrade is handled
   * from the raw `upgrade` event, before routing, so the per-org limiter never sees it. Without
   * this, anyone who can reach the host can hold sockets open five seconds at a time, indefinitely,
   * for free. The number is far above any real client count and is a backstop, not a quota.
   */
  let pending = 0;
  const MAX_PENDING = 64;

  return async (req, socket, head) => {
    const url = req.url?.split('?')[0];
    if (url !== CUSTOMER_TUNNEL_PATH) return false;

    if (pending >= MAX_PENDING) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      pending += 1;
      let settled = false;
      const settle = () => { if (!settled) { settled = true; pending -= 1; } };
      ws.on('close', settle);
      /**
       * The hello has to arrive before anything is registered, because the NAME is in it — there is
       * nothing to register until the client says what it is called. A socket that never sends one
       * is closed rather than held.
       */
      const timer = setTimeout(() => {
        settle();
        try { ws.close(1002, 'no hello'); } catch { /* already gone */ }
      }, HELLO_TIMEOUT_MS);

      ws.once('message', async (raw) => {
        clearTimeout(timer);
        settle();
        let hello: TunnelHello | undefined;
        try { hello = JSON.parse(raw.toString()) as TunnelHello; } catch { /* handled below */ }

        if (!hello || hello.t !== 'hello' || !isValidTunnelName(hello.name)) {
          // The reason is in the close frame, because the client prints it. "Closed (1002)" sends
          // somebody to read our source; "tunnel name must be lowercase…" does not.
          try { ws.close(1002, 'hello must name a valid tunnel: lowercase, digits and dashes'); } catch { /* gone */ }
          return;
        }

        /**
         * THE KEY DECIDES THE ORG, and the client never names one. Architecture rule 4 on the path
         * where breaking it would be worst: a client that could say which org it served would be a
         * client that could route another tenant's devices into its own network.
         *
         * A `Bearer` prefix is added rather than required, so a hello may carry the bare key —
         * which is what a person pastes out of the console.
         */
        const principal = await authenticate(
          typeof hello.key === 'string' ? `Bearer ${hello.key.trim()}` : undefined,
        );
        if (!principal || principal.kind !== 'tenant') {
          // Says WHAT was wrong without saying whether the key was real — the same reasoning
          // `authenticate()` uses for an expired key. A client that retries forever against a
          // revoked credential is a client nobody can debug.
          try { ws.close(1008, 'that API key was not accepted'); } catch { /* gone */ }
          return;
        }
        const orgId = principal.orgId;

        const allow = normaliseAllow(hello.allow);
        const client = typeof hello.client === 'string' ? hello.client.slice(0, 200) : null;

        /**
         * THE ROW IS UPSERTED BEFORE THE SOCKET IS REGISTERED, so a tunnel that is live is always a
         * tunnel the console can see. The other order leaves a window in which a device can route
         * through something no page will show, which is the shape of every "where is this traffic
         * going" incident.
         */
        try {
          await withTenant(orgId, (c) => c.query(
            `INSERT INTO tunnels (org_id, name, allow, client, last_seen_at)
             VALUES ($1, $2, $3::jsonb, $4, now())
             ON CONFLICT (org_id, lower(name)) DO UPDATE
               SET allow = EXCLUDED.allow, client = EXCLUDED.client, last_seen_at = now()`,
            [orgId, hello.name, JSON.stringify(allow), client],
          ));
        } catch (err) {
          app.log.error({ err, tunnel: hello.name }, 'could not record a customer tunnel');
          try { ws.close(1011, 'the farm could not record this tunnel'); } catch { /* gone */ }
          return;
        }

        registry.attach({ orgId, name: hello.name, allow, client, socket: ws }, app.log);

        const ready: TunnelControlFrame = { t: 'ready', name: hello.name, allow };
        try { ws.send(JSON.stringify(ready)); } catch { /* close handler cleans up */ }
        app.log.info({ tunnel: hello.name, allow: allow.length, client }, 'customer tunnel connected');
      });

      /** The symmetric keepalive — see `pingIntervalMs`. */
      let alive = true;
      ws.on('pong', () => { alive = true; });
      const ping = setInterval(() => {
        if (!alive) { try { ws.terminate(); } catch { /* gone */ } return; }
        alive = false;
        try { ws.ping(); } catch { /* close follows */ }
      }, pingIntervalMs());
      ws.on('close', () => clearInterval(ping));
    });

    return true;
  };
}

/**
 * Bound and tidy what a client declared.
 *
 * NOT A VALIDATION OF INTENT — a customer may legitimately allow `*`, and refusing that would be
 * this file deciding what their network is worth. What it does is stop a malformed or unbounded
 * declaration from being stored and rendered: a rule list is shown in the console and echoed back,
 * and both want a shape rather than whatever JSON arrived.
 */
export function normaliseAllow(raw: unknown): TunnelAllowRule[] {
  if (!Array.isArray(raw)) return [];
  const out: TunnelAllowRule[] = [];
  for (const r of raw.slice(0, 64)) {
    if (!r || typeof r !== 'object') continue;
    const host = (r as { host?: unknown }).host;
    const port = (r as { port?: unknown }).port;
    if (typeof host !== 'string' || !host || host.length > 253) continue;
    const rule: TunnelAllowRule = { host: host.toLowerCase() };
    if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535) rule.port = port;
    out.push(rule);
  }
  return out;
}
