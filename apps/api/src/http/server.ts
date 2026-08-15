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
const PUBLIC_PATHS = new Set(['/health', '/v1/workers/register', '/status', '/wd/hub/status']);

/** Stable `code` values for the client errors the framework raises on our behalf. */
const CLIENT_ERROR_CODES: Record<number, string> = {
  405: 'method_not_allowed',
  408: 'request_timeout',
  413: 'payload_too_large',
  414: 'uri_too_long',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

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

export interface ServerOptions {
  logger?: boolean;
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
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
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

  // --- routes ----------------------------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok' }));

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
