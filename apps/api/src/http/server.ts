import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { authenticate, type Principal } from '../auth.ts';
import { loadSigningKey, type Keypair } from '../tokens.ts';
import { ApiError, unauthorized, forbidden } from './errors.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { deviceRoutes } from './routes/devices.ts';
import { workerRoutes } from './routes/workers.ts';
import { webdriverRoutes } from './routes/webdriver.ts';
import { reap } from '../allocator.ts';
import { appPool, systemPool } from '../db.ts';
import type { Pool } from 'pg';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
  interface FastifyInstance {
    signingKey: Keypair;
  }
}

/** Routes reachable without credentials. Everything else is authenticated by default — the safe
 *  direction for the failure mode where someone forgets to add a guard.
 *
 *  The two WebDriver status paths are here because a client probes them before it has done anything
 *  at all, and they disclose nothing tenant-specific. Both spellings exist because Appium 2 serves
 *  at `/` and Selenium Grid and Appium 1 at `/wd/hub`. */
const PUBLIC_PATHS = new Set(['/health', '/ready', '/v1/workers/register', '/status', '/wd/hub/status']);

/** Stable `code` values for the client errors the framework raises on our behalf. */
const CLIENT_ERROR_CODES: Record<number, string> = {
  405: 'method_not_allowed',
  408: 'request_timeout',
  413: 'payload_too_large',
  414: 'uri_too_long',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

/** Cheapest possible round trip: proves the pool can hand out a connection AND that the connection
 *  can reach the server, which a `totalCount` check would not. */
async function probePool(pool: Pool): Promise<Error | null> {
  try {
    await pool.query('SELECT 1');
    return null;
  } catch (err) {
    return err as Error;
  }
}

export function requireTenant(req: FastifyRequest): { orgId: string } {
  if (!req.principal) throw unauthorized();
  if (req.principal.kind !== 'tenant') {
    throw forbidden('This endpoint requires a tenant API key, not a worker token.');
  }
  return { orgId: req.principal.orgId };
}

export function requireWorker(req: FastifyRequest): { hostId: string; region: string } {
  if (!req.principal) throw unauthorized();
  if (req.principal.kind !== 'worker') {
    throw forbidden('This endpoint requires a worker token, not a tenant API key.');
  }
  return { hostId: req.principal.hostId, region: req.principal.region };
}

/** How long a readiness result is reused. Long enough that a probe storm costs one query pair,
 *  short enough that a load balancer still pulls the instance out within one probe interval. */
const DEFAULT_READY_CACHE_MS = 1_000;

/** Per IP per minute, on top of the cache. Far above any real probe rate (a kubelet asks every few
 *  seconds), and low enough that `/ready` cannot be used as an amplifier. */
const DEFAULT_READY_RATE_LIMIT_MAX = 60;

interface Readiness {
  app: Error | null;
  system: Error | null;
}

/**
 * Readiness, computed at most once per `ttlMs` and at most once concurrently.
 *
 * `/ready` is public and does I/O on both pools, so without this it is an unauthenticated,
 * unmetered handle on 25 connections: a few hundred concurrent GETs exhaust appPool (20) and
 * systemPool (5), and every tenant request and every reaper query queues behind them. No credential
 * needed and nothing spent by the caller.
 *
 * Coalescing the in-flight probe matters as much as the TTL — N simultaneous requests arriving on a
 * cold cache would otherwise be N query pairs, which is precisely the burst being defended against.
 */
function createReadinessProbe(ttlMs: number): () => Promise<Readiness> {
  let cached: Readiness | undefined;
  let cachedAt = 0;
  let inflight: Promise<Readiness> | undefined;

  return () => {
    if (cached && Date.now() - cachedAt < ttlMs) return Promise.resolve(cached);
    inflight ??= Promise.all([probePool(appPool), probePool(systemPool)])
      .then(([app, system]) => {
        cached = { app, system };
        cachedAt = Date.now();
        return cached;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

export interface ServerOptions {
  logger?: boolean;
  /**
   * Requests per minute per rate-limit key. Passed explicitly by `start()` so the running limit is
   * the one config parsed; falls back to `RATE_LIMIT_MAX` for callers that do not.
   */
  rateLimitMax?: number;
  /** Readiness cache window. 0 disables caching, which only a test wants. */
  readyCacheMs?: number;
  /** Per-IP requests per minute for `/ready`. */
  readyRateLimitMax?: number;
  /**
   * Run `reap()` on this interval. 0 (the default) leaves it off, which is right for tests — the
   * reaper is fleet-wide, so a suite that shares a database with another one would collect its
   * sessions.
   *
   * A deployment must set this. Without it `expire_sessions()` never runs (a crashed client holds
   * its device until someone notices) and `promote_queued()` never runs, so a QUEUED session stays
   * queued forever and the WebDriver hub's capacity wait can only time out.
   */
  reaperIntervalMs?: number;
}

export async function buildServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: process.env.LOG_LEVEL ?? 'info',
      // Credentials must never reach a log line, an error report, or a support ticket.
      redact: ['req.headers.authorization', 'req.headers["x-worker-registration-token"]'],
    },
    genReqId: () => randomUUID(),
    // Fastify's AJV defaults to removeAdditional:true, which STRIPS unknown fields instead of
    // rejecting them — so `additionalProperties: false` in a schema silently does nothing. A client
    // that misspells `ttlMinutes` would get the default and never be told. Reject instead.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true, useDefaults: true } },
    // Reject oversized bodies before parsing. App uploads go to object storage directly, never here.
    bodyLimit: 1_048_576,
  });

  app.decorate('signingKey', loadSigningKey());

  // Fastify's default JSON parser throws on an empty body when content-type is application/json,
  // which surfaces as a 500. Bodyless POSTs (heartbeat) are a normal shape, and a 500 on routine
  // traffic is an alert nobody should be woken for. Treat empty as {}.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = (body as string).trim();
    if (raw.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(new ApiError(400, 'bad_request', 'Request body is not valid JSON.'), undefined);
    }
  });

  // --- auth ------------------------------------------------------------------------------------
  //
  // Split in two, either side of the rate limiter, because the obvious single hook leaves the most
  // attackable traffic on the API unlimited.
  //
  // Rejecting an unknown credential in `onRequest` aborts the request before the limiter ever
  // counts it — @fastify/rate-limit attaches per route, and route hooks run after every
  // instance-level onRequest hook. Unauthenticated requests are exactly the ones worth limiting:
  // key guessing against /v1/*, and registration-token guessing against the one route that hands
  // out fleet credentials. Each attempt also costs a database round trip, so an unlimited stream of
  // them is a cheap way to saturate the pool.
  //
  // So: resolve without judging in `onRequest`, let the limiter count, then fail closed in
  // `preParsing` — the first phase that runs after route hooks, and still before a body is read, so
  // an anonymous caller cannot make us parse a megabyte. The rejection stays GLOBAL rather than a
  // per-route guard, which keeps the property that a route added without an explicit check is not
  // reachable anonymously.
  const isPublic = (req: FastifyRequest) => PUBLIC_PATHS.has(req.url.split('?')[0]);

  app.addHook('onRequest', async (req) => {
    if (isPublic(req)) return;
    req.principal = (await authenticate(req.headers.authorization)) ?? undefined;
  });

  // --- rate limiting ---------------------------------------------------------------------------
  // Per-org, not per-IP: a CI fleet behind one NAT is one customer, and an agent workload is many
  // short bursts from many addresses.
  //
  // NOTE: this store is in-memory, so limits are per API instance. Correct for Phase 1 (single
  // instance); moving to Redis is required before running more than one.
  await app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax ?? Number(process.env.RATE_LIMIT_MAX ?? 120),
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const p = (req as FastifyRequest).principal;
      if (p?.kind === 'tenant') return `org:${p.orgId}`;
      if (p?.kind === 'worker') return `host:${p.hostId}`;
      return `ip:${req.ip}`;
    },
    // Must return an ERROR, not a response body: the plugin `throw`s whatever this returns, so a
    // plain object arrives at the error handler as an unrecognised throwable and comes back as a
    // 500. That is not theoretical — it is what this endpoint did until a test asked for a 429 and
    // got "Internal error" instead, on the one path that is supposed to protect the service.
    errorResponseBuilder: (_req, ctx) =>
      new ApiError(
        ctx.statusCode,
        ctx.ban ? 'banned' : 'rate_limited',
        `Rate limit exceeded. Retry after ${Math.ceil(ctx.ttl / 1000)}s.`,
      ),
  });

  // The second half of auth: everything non-public needs a principal, and by now the limiter has
  // already counted the attempt.
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (!isPublic(req) && !req.principal) throw unauthorized();
    return payload;
  });

  // --- errors ----------------------------------------------------------------------------------
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, requestId: req.id, ...(err.details ?? {}) },
      });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: err.message, requestId: req.id },
      });
    }
    // Fastify and its plugins report client errors by throwing something that carries a status:
    // 413 when a body exceeds bodyLimit, 415 for an unknown content-type, 429 from the limiter.
    // Without this they are all indistinguishable from a crash — the caller is told to report an
    // internal error for a mistake only they can fix, and the log fills with false alarms.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: { code: CLIENT_ERROR_CODES[status] ?? 'bad_request', message: err.message, requestId: req.id },
      });
    }
    // Unexpected: log the detail, return none. Stack traces are a disclosure vector.
    req.log.error({ err, reqId: req.id }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal', message: 'Internal error. Quote the requestId when reporting it.', requestId: req.id },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: { code: 'not_found', message: `No route for ${req.method} ${req.url}.`, requestId: req.id },
    }),
  );

  // --- probes ----------------------------------------------------------------------------------
  //
  // Liveness and readiness are two endpoints because they answer two questions with opposite
  // remedies, and only one of them may touch the database.
  //
  // /health is "is this process alive", answered from memory, no I/O, and it cannot fail while the
  // process can serve at all. A liveness probe that queries Postgres converts a ten-second database
  // blip into a rolling restart of every replica — which removes the capacity that would have
  // absorbed the blip, discards every warm pool, and stampedes the recovering database with
  // reconnects. The outage gets longer because of the check.
  //
  // /ready is "should this instance be sent traffic", and that is where I/O belongs. Failing it
  // pulls the instance out of the load balancer and puts it back when the dependency returns, with
  // no process death in between and nothing to crash-loop.
  //
  // /health is exempt from the limiter entirely: a 429 on a liveness probe is indistinguishable
  // from a dead pod to a kubelet, so leaving it in the global bucket lets one noisy IP restart the
  // fleet. It costs nothing to serve, so exemption costs nothing either.
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  // /ready does NOT get that exemption, and the argument for /health does not transfer to it: this
  // endpoint does I/O. HOST defaults to 0.0.0.0 and the WebDriver hub has to be internet-facing on
  // the same listener, so /ready is reachable from the internet by anyone. Two defences, because
  // either alone leaves the hole open: the cache means N probes cost one query pair, and the per-IP
  // limit means one source cannot spin the cache or occupy the accept queue. The limit is generous
  // enough that a real probe interval never reaches it.
  //
  // Both pools are checked, not one. They are separate roles, separate grants and separate limits:
  // appPool can be exhausted or mfarm_app's password rotated out from under us while the owner
  // connection is perfectly healthy, and appPool is the one every request handler goes through.
  // Checking only the owner would report ready while nothing tenant-facing works.
  const readiness = createReadinessProbe(opts.readyCacheMs ?? DEFAULT_READY_CACHE_MS);
  const readyOpts = {
    config: {
      rateLimit: {
        max: opts.readyRateLimitMax ?? DEFAULT_READY_RATE_LIMIT_MAX,
        timeWindow: '1 minute',
        // Per IP, not per principal: /ready is public, so there is never a principal to key on.
        keyGenerator: (req: FastifyRequest) => `ready:${req.ip}`,
      },
    },
  };

  app.get('/ready', readyOpts, async (req, reply) => {
    const { app: appErr, system: systemErr } = await readiness();
    if (!appErr && !systemErr) return { status: 'ready' };

    // The reason is logged, not returned. /ready is unauthenticated, and a pg error message carries
    // the host, port, database and role it failed to reach.
    req.log.error({ appErr, systemErr }, 'readiness probe failed');
    return reply.code(503).send({
      error: {
        code: 'not_ready',
        message: 'Database is not reachable. This instance should not receive traffic.',
        requestId: req.id,
        pools: { app: appErr ? 'down' : 'up', system: systemErr ? 'down' : 'up' },
      },
    });
  });

  // --- routes ----------------------------------------------------------------------------------
  await app.register(sessionRoutes, { prefix: '/v1' });
  await app.register(deviceRoutes, { prefix: '/v1' });
  await app.register(workerRoutes, { prefix: '/v1' });

  // The WebDriver hub, mounted at both spellings the world uses: Appium 2 clients default to `/`,
  // Selenium Grid and Appium 1.x clients to `/wd/hub`. Serving both means the migration is one URL
  // change whichever client the team is on, which is the entire promise of the endpoint.
  await app.register(webdriverRoutes, { prefix: '/wd/hub' });
  await app.register(webdriverRoutes);

  // --- reaper ------------------------------------------------------------------------------------
  if (opts.reaperIntervalMs && opts.reaperIntervalMs > 0) {
    const timer = setInterval(() => {
      void reap().catch((err: Error) => app.log.error({ err }, 'reaper failed'));
    }, opts.reaperIntervalMs);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  return app;
}
