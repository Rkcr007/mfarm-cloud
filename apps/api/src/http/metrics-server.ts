/**
 * The metrics listener: a second HTTP server, on its own port, serving exactly one path.
 *
 * WHY NOT A ROUTE ON THE MAIN SERVER. `HOST` defaults to `0.0.0.0` and the WebDriver hub has to be
 * reachable on that listener — that is the whole point of the hub. Every gauge in `metrics.ts` is
 * fleet-wide and collected on the OWNER pool, so it crosses every tenant boundary the rest of the
 * codebase exists to defend. Putting it on the same listener means one forgotten entry in
 * PUBLIC_PATHS, or one auth hook reordered, discloses the whole fleet. A separate port bound to
 * loopback cannot be reached by a mistake of that kind; it can only be reached by changing the bind
 * address, which is a deliberate act with a comment attached.
 *
 * WHY NOT FASTIFY. This server must answer while the database is down and while the main server is
 * refusing traffic, and it must never inherit a hook, a plugin or a 404 handler from the API. A
 * `node:http` server with a hand-written router has no surface for either to leak through.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { scrape } from '../metrics.ts';

/** The exposition format's own content type. Prometheus accepts `text/plain` without it, but the
 *  version parameter is what tells a scraper it is not being handed a human-readable page. */
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Both operands are 32 fixed bytes, so `timingSafeEqual` cannot throw on a length mismatch and no
 *  length is leaked by the comparison. */
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

export interface MetricsServerOptions {
  host: string;
  port: number;
  /** Required when `host` is not loopback; see `parseConfig`. */
  token?: string;
  path?: string;
  /** Where a serve failure goes. Defaults to stderr rather than the API logger, because this server
   *  has to work when the API's logger is the thing that is broken. */
  onError?: (err: Error) => void;
}

export interface MetricsServer {
  /** `host:port` as actually bound. Port 0 means the kernel chose, which is how tests avoid
   *  fighting over a number. */
  readonly address: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startMetricsServer(opts: MetricsServerOptions): Promise<MetricsServer> {
  const path = opts.path ?? '/metrics';
  const onError = opts.onError ?? ((err) => console.error('[metrics]', err.stack ?? err.message));

  const server: Server = createHttpServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0];

      // Answered before the token check and before any collection: a liveness probe on this port
      // must not need a credential, and must not cost a database query.
      if (url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(req.method === 'HEAD' ? undefined : 'ok\n');
      }

      if (url !== path) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('not found\n');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        return res.end('method not allowed\n');
      }

      if (opts.token) {
        const header = req.headers.authorization ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
        // No detail in the body and no `WWW-Authenticate` challenge: this endpoint is not for
        // humans, and a challenge is an invitation to guess.
        if (!presented || !tokenMatches(presented, opts.token)) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('unauthorized\n');
        }
      }

      const body = await scrape();
      res.writeHead(200, { 'content-type': CONTENT_TYPE, 'content-length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    })().catch((err: Error) => {
      onError(err);
      // `scrape()` swallows a fleet-query failure by design and still returns a body, so reaching
      // here means the registry itself threw — a bug, not a database blip.
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('metrics collection failed\n');
      } else {
        res.destroy();
      }
    });
  });

  // A scraper that opens a connection and stalls must not hold a socket forever. Prometheus'
  // default scrape timeout is 10s; this is comfortably past it and still bounded.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  return {
    address: `${opts.host}:${addr.port}`,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        // closeAllConnections, not just close(): a keep-alive scrape connection would otherwise hold
        // the shutdown open for the length of the scrape interval.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
