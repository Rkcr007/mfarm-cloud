import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseAutomationPath, verifySessionToken, type SessionClaims } from '@mfarm/protocol';

/**
 * The automation gateway — ADR-0004, worker half.
 *
 * Appium is bound to `127.0.0.1` and must stay there: an internet-facing Appium port is
 * unauthenticated device control, and Appium itself has no concept of a tenant. This listener is the
 * only thing on the host that can reach it, and unlike Appium it is code we own.
 *
 * Every request must carry an Ed25519 grant minted by the control plane naming the session, device,
 * org, fence and THIS host. The grant is verified offline against the public key handed over at
 * registration, so the input path never calls home and a partitioned control plane cannot wedge a
 * running suite.
 *
 * THIS FILE IS A SECURITY BOUNDARY. The ADR is explicit that it is the highest-value component in
 * the worker to review, and the reason is that every failure mode here is silent:
 *
 *   - a path that escapes `/automation/<localId>` reaches an arbitrary loopback port;
 *   - a missing check anywhere below turns the host into an open Appium on the internet;
 *   - forwarding the grant upstream leaks a credential to a process that has no use for it;
 *   - "temporarily" skipping verification to debug something is the whole exposure, restored.
 *
 * There is deliberately no unauthenticated path through `handle()`. Not one that is disabled by
 * default, not one behind a flag — none, so that no configuration mistake can produce one.
 */

/**
 * Everything the gateway is allowed to know about the agent.
 *
 * Narrowed to four members on purpose. This is the authorization surface of an internet-facing
 * listener, and a reviewer should be able to see its whole input set at once — not have to rule out
 * the rest of `Agent` (metering, credentials, the registration token) by reading the file. `Agent`
 * satisfies it structurally, so nothing is wired up specially.
 */
export interface GrantAuthority {
  readonly hostId: string | undefined;
  readonly sessionPublicKey: string | undefined;
  deviceIdFor(localId: string): string | undefined;
  acceptFence(deviceId: string, fence: number): boolean;
}

export interface GatewayOptions {
  agent: GrantAuthority;
  /** localId -> the loopback port of that device's Appium. A device absent here is not served. */
  targets: Map<string, number>;
  port?: number;
  /**
   * Which interface to bind.
   *
   * Undefined means all of them, which is Node's default and is what this did before the option
   * existed. That is correct when the box has no public interface and wrong the moment it does: on
   * a rented VM, an all-interfaces bind puts the gateway on the internet, and the only thing between
   * a stranger and a device is the grant check. The grant check is good, but "nothing is listening"
   * is better. Set this to the Tailscale address (`tailscale ip -4`) on a box with a public NIC.
   */
  host?: string;
  /**
   * Where Appium actually listens. Loopback, always, in any real deployment — it is a parameter so
   * tests can point at a fake on the same interface, not so operators can widen it.
   */
  upstreamHost?: string;
  /** Matches the hub's `MFARM_WD_BODY_LIMIT`. `pushFile`/`setClipboard` carry base64 payloads. */
  maxBodyBytes?: number;
  /**
   * Upstream response deadline. Must be >= the hub's new-session timeout (300s), or the gateway
   * severs sessions the hub is still legitimately waiting for — a new Appium session on a cold
   * device is genuinely slow.
   */
  upstreamTimeoutMs?: number;
}

const DEFAULT_MAX_BODY = 16 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 300_000;

/**
 * Headers that describe THIS hop and must not be copied to the next one (RFC 9110 §7.6.1).
 *
 * `authorization` is in the list for a reason of our own: it carries the grant, which authenticates
 * the hub to *us*. Appium has no use for it, would not check it, and forwarding a bearer token to a
 * process that logs its requests is how credentials end up in a log file.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'authorization', 'host',
]);

type Denial = { status: number; error: string; message: string };

/** W3C-shaped so a WebDriver client that somehow reaches this directly gets something it parses. */
function deny(res: ServerResponse, d: Denial): void {
  const body = JSON.stringify({ value: { error: d.error, message: d.message, stacktrace: '' } });
  res.writeHead(d.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export class AutomationGateway {
  private readonly opts: GatewayOptions;
  private server?: Server;
  private _port?: number;

  constructor(opts: GatewayOptions) {
    this.opts = opts;
  }

  get port(): number | undefined { return this._port; }

  async listen(port = this.opts.port ?? 8090, host = this.opts.host): Promise<number> {
    const server = createServer((req, res) => { void this.handle(req, res); });
    // A socket that connects and says nothing costs a file descriptor until it does. The gateway is
    // internet-facing, so it gets a header deadline rather than Node's default of none.
    server.headersTimeout = 30_000;
    server.requestTimeout = 0; // body streaming is bounded by maxBodyBytes, not by a clock
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // `listen(port)` and `listen(port, host)` are different overloads and `listen(port, undefined)`
      // is not the former — it resolves to the callback position. Branch rather than pass through.
      const done = () => { server.removeListener('error', reject); resolve(); };
      if (host) server.listen(port, host, done);
      else server.listen(port, done);
    });
    this.server = server;
    const addr = server.address();
    this._port = typeof addr === 'object' && addr ? addr.port : port;
    return this._port;
  }

  async close(): Promise<void> {
    const s = this.server;
    if (!s) return;
    this.server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /**
   * Authorize, then proxy. In that order, with no path that reaches the proxy without passing every
   * check above it.
   */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authorized = this.authorize(req, res);
    if (!authorized) return; // authorize() has already answered
    this.proxy(req, res, authorized.port, authorized.rest);
  }

  private authorize(
    req: IncomingMessage,
    res: ServerResponse,
  ): { port: number; rest: string; claims: SessionClaims } | undefined {
    // `req.url` is origin-form. Parsed against a dummy base purely to split path from query without
    // hand-rolling it — `decodeURIComponent` on a hand-split string is how path traversal gets in.
    let pathname: string;
    let search: string;
    try {
      const u = new URL(req.url ?? '/', 'http://gateway.invalid');
      pathname = u.pathname;
      search = u.search;
    } catch {
      deny(res, { status: 400, error: 'invalid argument', message: 'Unparseable request target.' });
      return undefined;
    }

    const parsed = parseAutomationPath(pathname);
    if (!parsed) {
      deny(res, { status: 404, error: 'unknown command', message: 'Not an automation path.' });
      return undefined;
    }

    const port = this.opts.targets.get(parsed.localId);
    if (port === undefined) {
      // Same answer as an unknown path, deliberately: distinguishing them would let an unauthenticated
      // caller enumerate which devices this host has.
      deny(res, { status: 404, error: 'unknown command', message: 'Not an automation path.' });
      return undefined;
    }

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) {
      deny(res, { status: 401, error: 'invalid session id', message: 'An automation grant is required.' });
      return undefined;
    }

    const publicKey = this.opts.agent.sessionPublicKey;
    const hostId = this.opts.agent.hostId;
    if (!publicKey || !hostId) {
      // Not yet registered, so there is no key to verify against and no audience to demand. Fail
      // closed and say it is temporary — this is the one denial that is our fault, not the caller's.
      deny(res, { status: 503, error: 'unknown error', message: 'This host is not registered yet.' });
      return undefined;
    }

    // Audience is checked inside: a grant minted for another host is useless here, which is what
    // stops a compromised worker from replaying grants at its neighbours.
    const verified = verifySessionToken(token, publicKey, hostId);
    if (!verified.ok) {
      deny(res, {
        status: verified.reason === 'expired' ? 401 : 403,
        error: 'invalid session id',
        message: `Automation grant rejected: ${verified.reason}.`,
      });
      return undefined;
    }
    const claims = verified.claims;

    // The grant names a control-plane uuid; the path names a local id. Only the control plane knows
    // both, which is why registration now returns the mapping (protocol v2). Without it there is no
    // safe answer — an agent that cannot check this refuses rather than trusting the path.
    const expectedDeviceId = this.opts.agent.deviceIdFor(parsed.localId);
    if (!expectedDeviceId) {
      deny(res, {
        status: 503,
        error: 'unknown error',
        message: `No control-plane id known for device ${parsed.localId}; cannot authorize.`,
      });
      return undefined;
    }
    if (claims.did !== expectedDeviceId) {
      // A valid grant for a DIFFERENT device on this same host. Nothing about the signature is
      // wrong; the authorization is. This is the check no network transport could make.
      deny(res, {
        status: 403,
        error: 'invalid session id',
        message: 'This grant is not for the device named in the path.',
      });
      return undefined;
    }

    // Monotonic per-device gate. A hub that was partitioned and is replaying an old command carries
    // a stale fence, and the device has since been reset and handed to someone else.
    if (!this.opts.agent.acceptFence(claims.did, claims.fence)) {
      deny(res, {
        status: 409,
        error: 'invalid session id',
        message: 'Stale fence: this device has been reallocated.',
      });
      return undefined;
    }

    // Path-transparent: whatever followed the device segment is what Appium receives, query string
    // included. `rest` is '' for a request to the bare base, and Appium wants '/' there.
    return { port, rest: (parsed.rest || '/') + search, claims };
  }

  private proxy(req: IncomingMessage, res: ServerResponse, port: number, path: string): void {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }

    const upstream = httpRequest(
      {
        host: this.opts.upstreamHost ?? '127.0.0.1',
        port,
        method: req.method,
        path,
        headers,
      },
      (up) => {
        // Status and headers verbatim. Notably NOT following redirects: `http.request` does not,
        // and it must not start — a 302 from a compromised Appium would otherwise become a request
        // this gateway makes on its behalf, with its network position.
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined) continue;
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          out[k] = v;
        }
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );

    upstream.setTimeout(this.opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error('upstream timeout'));
    });

    upstream.on('error', (e: Error) => {
      if (res.headersSent) { res.destroy(); return; }
      deny(res, {
        status: 502,
        error: 'unknown error',
        message: `Automation server unreachable: ${e.message}`,
      });
    });

    // Bound the request body as it streams. Buffering first to measure it would make the limit
    // itself the memory exhaustion it exists to prevent.
    const limit = this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
    let seen = 0;
    let tripped = false;
    req.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > limit && !tripped) {
        tripped = true;
        upstream.destroy();
        if (!res.headersSent) {
          deny(res, { status: 413, error: 'unknown error', message: `Body exceeds ${limit} bytes.` });
        }
        req.destroy();
      }
    });

    // A client that hangs up mid-command must not leave the upstream request open holding the
    // device's Appium busy.
    res.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });

    req.pipe(upstream);
  }
}
