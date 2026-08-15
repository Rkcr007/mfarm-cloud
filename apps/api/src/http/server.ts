import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { authenticate, type Principal } from '../auth.ts';
import { loadSigningKey, type Keypair } from '../tokens.ts';
import { ApiError, unauthorized, forbidden } from './errors.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { deviceRoutes } from './routes/devices.ts';
import { workerRoutes } from './routes/workers.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
  interface FastifyInstance {
    signingKey: Keypair;
  }
}

/** Routes reachable without credentials. Everything else is authenticated by default — the safe
 *  direction for the failure mode where someone forgets to add a guard. */
const PUBLIC_PATHS = new Set(['/health', '/v1/workers/register']);

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

export async function buildServer(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
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
  // Registered before the rate limiter so the limiter can key on the resolved principal.
  app.addHook('onRequest', async (req) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0])) return;
    const principal = await authenticate(req.headers.authorization);
    if (!principal) throw unauthorized();
    req.principal = principal;
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
    errorResponseBuilder: (_req, ctx) => ({
      error: {
        code: 'rate_limited',
        message: `Rate limit exceeded. Retry after ${Math.ceil(ctx.ttl / 1000)}s.`,
      },
    }),
  });

  // --- errors ----------------------------------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
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

  return app;
}
