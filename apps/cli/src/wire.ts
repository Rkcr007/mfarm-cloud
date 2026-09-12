/**
 * GENERATED — DO NOT EDIT. Run `node apps/cli/scripts/vendor-wire.mjs` and commit the result.
 *
 * The tunnel wire definitions, copied verbatim out of `packages/protocol/src/protocol.ts` between
 * its VENDORED REGION markers. `apps/cli/test/wire.test.ts` re-runs the generator in memory and
 * fails when this file drifts from that one.
 *
 * WHY IT IS A COPY rather than an import: `@mfarm/cli` is published and `@mfarm/protocol` is not —
 * it is `private: true` and exports raw TypeScript, so a tarball importing it cannot resolve. The
 * CLI also ships zero runtime dependencies on purpose, because it is a program a customer runs
 * inside their own network. The generator's header says the rest.
 *
 * THE SOURCE OF TRUTH IS `packages/protocol`. Change it there.
 */

/** Where a customer's tunnel client dials. One socket per tunnel, re-dialled with backoff. */
export const CUSTOMER_TUNNEL_PATH = '/v1/tunnel';

/**
 * What a tunnel is called, and the rules are tighter than they look because this is a ROUTING KEY.
 *
 * A suite names it in a capability (`mfarm:tunnel`), a person reads it in the console, and two
 * tunnels in one org must never be ambiguous. Lowercase with dashes is the same shape as an org
 * slug and a region code, which is what the rest of this system already uses for a name a human
 * types into a config file.
 */
export const TUNNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export function isValidTunnelName(v: unknown): v is string {
  return typeof v === 'string' && TUNNEL_NAME_RE.test(v);
}

/**
 * What the client will fetch on the customer's behalf.
 *
 * DEFAULT-DENY, AND THE CLIENT ENFORCES IT — not the control plane. The control plane is a switch;
 * it cannot know that `10.0.0.7` is a database and `staging.acme.internal` is the thing under test,
 * and a rule it enforced would be a rule the customer had to trust us about. The client runs inside
 * their network, was started by them, and is the only party that can refuse from a position of
 * knowledge.
 *
 * A host pattern, optionally a port. `*.acme.internal` matches one label or many, because a staging
 * environment that spreads across `api.`, `web.` and `cdn.` subdomains is the ordinary case and a
 * customer forced to list them will pass `*` instead — a rule people route around is worse than a
 * rule that fits.
 */
export interface TunnelAllowRule {
  /** `staging.acme.internal`, `*.acme.internal`, `localhost`, or `*` for everything. */
  host: string;
  /** Absent means any port. */
  port?: number;
}

/**
 * Whether a rule set permits one host:port.
 *
 * EXPORTED FROM THE PROTOCOL so the client, the console's explanation of what a tunnel can reach,
 * and the tests all agree by construction. An allow-list that is implemented twice is an allow-list
 * that will eventually disagree with itself, and the half that is wrong is the half that lets
 * something through.
 */
export function tunnelAllows(rules: TunnelAllowRule[], host: string, port: number): boolean {
  const h = host.toLowerCase();
  return rules.some((r) => {
    if (r.port !== undefined && r.port !== port) return false;
    const pattern = r.host.toLowerCase();
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".acme.internal"
      /**
       * `*.acme.internal` matches `api.acme.internal` AND `acme.internal` itself. A customer who
       * writes the wildcard means "this environment"; making them write the bare domain as a second
       * rule is the kind of papercut that ends with somebody writing `*`.
       */
      return h.endsWith(suffix) || h === suffix.slice(1);
    }
    return h === pattern;
  });
}

/**
 * One message on a `proxy` channel.
 *
 * DELIBERATELY THE SAME SHAPE AS `AutomationFrame` — head, chunks, end — because it is the same
 * problem: an HTTP exchange streamed over a frame-capped socket. Reusing the shape means one
 * chunking bug to find rather than two, and a reader who understands one understands the other.
 *
 * `req` carries an ABSOLUTE url rather than a path, which is the one real difference. An automation
 * request is replayed against a gateway the agent already knows the address of; a proxy request has
 * no such default — the destination IS the message, and it is what the client checks against its
 * allow rules before it dials anything.
 */
export type ProxyFrame =
  | { k: 'req'; method: string; url: string; headers: Record<string, string> }
  | { k: 'res'; status: number; headers: Record<string, string> }
  | { k: 'd'; b: string }
  | { k: 'end' }
  | { k: 'err'; message: string; code?: ProxyErrorCode };

/**
 * Why a proxied request did not happen, as a value rather than as prose.
 *
 * The device gets an HTTP status and a short body, and a person reading "502" learns nothing. These
 * separate the four cases that need different actions: fix your allow rules, start your tunnel,
 * check the host is up, or look at the size of what you sent.
 */
export type ProxyErrorCode = 'not_allowed' | 'no_tunnel' | 'unreachable' | 'too_large';

export function isProxyFrame(v: unknown): v is ProxyFrame {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  switch (f.k) {
    case 'req':
      return typeof f.method === 'string' && typeof f.url === 'string'
        && typeof f.headers === 'object' && f.headers !== null;
    case 'res':
      return typeof f.status === 'number' && Number.isInteger(f.status)
        && typeof f.headers === 'object' && f.headers !== null;
    case 'd':
      return typeof f.b === 'string';
    case 'end':
      return true;
    case 'err':
      return typeof f.message === 'string';
    default:
      return false;
  }
}

/**
 * What the client says when it arrives, and what it is told back.
 *
 * The client names the tunnel and declares what it will reach; the control plane answers with what
 * it recorded. It ECHOES THE RULES rather than acknowledging silently, so the console and the
 * person who started the client are looking at the same list — a tunnel whose owner believes it is
 * narrower than it is, is the failure this exists to prevent.
 */
export interface TunnelHello {
  t: 'hello';
  /**
   * THE CREDENTIAL IS IN THE HELLO, not in an `Authorization` header, and that is forced rather
   * than chosen: Node's built-in `WebSocket` cannot set request headers, and the client is a
   * zero-dependency program a customer runs on their own machine. Putting it in the query string
   * was the other option and is worse — a URL is logged by every proxy between here and there.
   *
   * It is also the idiom this repo already uses. `/dp/*` authenticates in its `hello` frame for the
   * same reason (ADR-0008), so a socket that has connected but not yet said who it is, is an
   * existing state with an existing bound: a five-second timeout and nothing allocated until it
   * speaks.
   *
   * A tenant API key (`mfk_`). The org it belongs to is the org whose devices may route here, and
   * the client never names an org itself — architecture rule 4, on the path where getting it wrong
   * would let one tenant reach another's network.
   */
  key: string;
  name: string;
  allow: TunnelAllowRule[];
  /** For the console, so a person can tell two machines apart. Free text, never a credential. */
  client?: string;
}

export interface TunnelReady {
  t: 'ready';
  name: string;
  allow: TunnelAllowRule[];
}

/** The client's keepalive is the socket's own ping; this is the one message it may send unbidden. */
export interface TunnelBye {
  t: 'bye';
  reason?: string;
}

export type TunnelControlFrame = TunnelHello | TunnelReady | TunnelBye;
