import type { FastifyInstance } from 'fastify';
import { withTenant, withSystem } from '../../db.ts';
import { allocate, release } from '../../allocator.ts';
import { mintSessionToken, DEFAULT_TTL_SECONDS } from '../../tokens.ts';
import { requireTenant } from '../server.ts';
import { notFound, badRequest } from '../errors.ts';
import { checkReplay, record } from '../idempotency.ts';

const createSchema = {
  body: {
    type: 'object',
    required: ['region', 'platform'],
    additionalProperties: false,
    properties: {
      region: { type: 'string', minLength: 1, maxLength: 64 },
      platform: { type: 'string', enum: ['android', 'ios'] },
      tier: { type: 'string', enum: ['cuttlefish', 'avd', 'container', 'simulator', 'physical'] },
      ttlMinutes: { type: 'integer', minimum: 1, maximum: 240 },
      requested: { type: 'object' },
    },
  },
} as const;

interface CreateBody {
  region: string;
  platform: 'android' | 'ios';
  tier?: 'cuttlefish' | 'avd' | 'container' | 'simulator' | 'physical';
  ttlMinutes?: number;
  requested?: Record<string, unknown>;
}

export async function sessionRoutes(app: FastifyInstance) {
  /**
   * Allocate a device and return the DATA PLANE coordinates.
   *
   * The response is the whole of v2 decision 2 in practice: the API hands back a worker endpoint and
   * a short-lived signed token, and then has nothing further to do with the session. The browser
   * connects straight to the worker. No frame and no tap ever transits this process.
   */
  app.post<{ Body: CreateBody }>('/sessions', { schema: createSchema }, async (req, reply) => {
    const { orgId } = requireTenant(req);
    const idemKey = req.headers['idempotency-key'];

    if (typeof idemKey === 'string' && idemKey.length > 0) {
      const replayed = await checkReplay(orgId, idemKey, 'POST', '/v1/sessions', req.body);
      if (replayed) {
        return reply.code(replayed.statusCode).header('idempotent-replay', 'true').send(replayed.body);
      }
    }

    const alloc = await allocate({
      orgId,
      userId: null,
      region: req.body.region,
      platform: req.body.platform,
      tier: req.body.tier ?? null,
      ttlMinutes: req.body.ttlMinutes,
      requested: req.body.requested,
    });

    let status: number;
    let payload: Record<string, unknown>;

    if (alloc.deviceId === null) {
      // Queued is a success, not a failure: the client holds a real session id and can poll or wait
      // for the webhook. Returning 409 here is what forces clients to build their own retry loops.
      status = 202;
      payload = {
        session: { id: alloc.sessionId, state: 'QUEUED', deviceId: null },
        message: 'No device is free right now. The session is queued and will start automatically.',
      };
    } else {
      const host = await withSystem(async (c) => {
        const { rows } = await c.query(
          `SELECT h.id, h.endpoint, h.region
             FROM devices d JOIN hosts h ON h.id = d.host_id
            WHERE d.id = $1`,
          [alloc.deviceId],
        );
        return rows[0];
      });

      if (!host?.endpoint) {
        // A device whose host has no data-plane endpoint cannot serve a session. Give the device
        // back immediately rather than leaving it reserved against a session that can never connect.
        await release(orgId, alloc.sessionId, 'no_endpoint');
        throw badRequest('The allocated device has no data-plane endpoint configured. Its host must register an endpoint before it can take sessions.');
      }

      const token = mintSessionToken(
        { sid: alloc.sessionId, did: alloc.deviceId, org: orgId, fence: alloc.fence!, aud: host.id },
        app.signingKey.privateKeyPem,
      );

      status = 201;
      payload = {
        session: {
          id: alloc.sessionId,
          state: alloc.state,
          deviceId: alloc.deviceId,
          fence: alloc.fence,
          region: host.region,
        },
        dataPlane: {
          endpoint: host.endpoint,
          token,
          expiresInSeconds: DEFAULT_TTL_SECONDS,
        },
      };
    }

    if (typeof idemKey === 'string' && idemKey.length > 0) {
      await record(orgId, idemKey, 'POST', '/v1/sessions', req.body, status, payload);
    }
    return reply.code(status).send(payload);
  });

  app.get<{ Params: { id: string } }>('/sessions/:id', async (req) => {
    const { orgId } = requireTenant(req);
    const row = await withTenant(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, state, device_id, fence, region, created_at, started_at, expires_at,
                ended_at, end_reason
           FROM sessions WHERE id = $1`,
        [req.params.id],
      );
      return rows[0];
    });
    // RLS makes another org's session indistinguishable from a nonexistent one, which is the
    // correct disclosure boundary — a 403 here would confirm the id exists.
    if (!row) throw notFound('Session');
    return {
      session: {
        id: row.id, state: row.state, deviceId: row.device_id,
        fence: row.fence === null ? null : Number(row.fence),
        region: row.region, createdAt: row.created_at, startedAt: row.started_at,
        expiresAt: row.expires_at, endedAt: row.ended_at, endReason: row.end_reason,
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const { orgId } = requireTenant(req);
    const ok = await release(orgId, req.params.id, 'client_request');
    if (!ok) throw notFound('Active session');
    return reply.code(204).send();
  });
}
