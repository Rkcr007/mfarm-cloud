import type { FastifyInstance, FastifyReply } from 'fastify';
import { withTenant, withSystem } from '../../db.ts';
import { allocate, release } from '../../allocator.ts';
import { mintSessionToken, DEFAULT_TTL_SECONDS } from '../../tokens.ts';
import { requireTenant } from '../server.ts';
import { notFound, badRequest } from '../errors.ts';
import { idempotencyKey, claim, complete, abandon } from '../idempotency.ts';

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
      // Capabilities the device must declare, e.g. ["webdriver"]. Distinct from `requested`, which
      // is an opaque tenant blob: these are scheduling input, and the allocator records them on the
      // session so promotion off the queue re-applies the same constraints.
      //
      // Without this the CLI could not allocate a device it can then drive over WebDriver — it would
      // get any device, and binding would fail at the hub with "no automation server" (ADR-0002 D1).
      requireCapabilities: {
        type: 'array', maxItems: 8, uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
  },
} as const;

interface CreateBody {
  region: string;
  platform: 'android' | 'ios';
  tier?: 'cuttlefish' | 'avd' | 'container' | 'simulator' | 'physical';
  ttlMinutes?: number;
  requested?: Record<string, unknown>;
  requireCapabilities?: string[];
}

/** States in which a session has a device and can still be driven. Outside these there is nothing
 *  to hand coordinates for, and minting a token would produce a credential for a device somebody
 *  else now holds. */
const LIVE_STATES = new Set(['ALLOCATING', 'ACTIVE']);

interface HostRow {
  id: string;
  endpoint: string | null;
  region: string;
}

/**
 * The host behind a device, on the owner pool.
 *
 * `hosts` is fleet infrastructure with no `org_id`, so this cannot go through `withTenant` — the
 * tenant-scoped read is the session row, and that has already happened by the time this is called.
 */
function hostForDevice(deviceId: string): Promise<HostRow | undefined> {
  return withSystem(async (c) => {
    const { rows } = await c.query<HostRow>(
      `SELECT h.id, h.endpoint, h.region
         FROM devices d JOIN hosts h ON h.id = d.host_id
        WHERE d.id = $1`,
      [deviceId],
    );
    return rows[0];
  });
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
    const idemKey = idempotencyKey(req.headers['idempotency-key']);

    if (idemKey) {
      const outcome = await claim(orgId, idemKey, 'POST', '/v1/sessions', req.body);
      if (outcome.kind === 'replay') {
        return reply.code(outcome.statusCode).header('idempotent-replay', 'true').send(outcome.body);
      }
    }

    // The claim is held from here on, so every failure path has to release it — otherwise one
    // transient error makes the client's own retry collide with its abandoned claim.
    try {
      return await createSession(req, reply, orgId, idemKey);
    } catch (err) {
      if (idemKey) await abandon(orgId, idemKey).catch(() => {});
      throw err;
    }
  });

  async function createSession(
    req: { body: CreateBody },
    reply: FastifyReply,
    orgId: string,
    idemKey: string | null,
  ) {
    const alloc = await allocate({
      orgId,
      userId: null,
      region: req.body.region,
      platform: req.body.platform,
      tier: req.body.tier ?? null,
      ttlMinutes: req.body.ttlMinutes,
      requested: req.body.requested,
      requireCapabilities: req.body.requireCapabilities,
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
      const host = await hostForDevice(alloc.deviceId!);

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

    if (idemKey) await complete(orgId, idemKey, status, payload);
    return reply.code(status).send(payload);
  }

  /**
   * Recent sessions for this org, newest first.
   *
   * Deliberately NOT paginated by offset. Sessions are append-only and a farm generates them
   * steadily, so an offset walks a shifting list; a caller who needs more than this asks for a
   * larger limit or filters by state. `limit` is clamped rather than validated into an error,
   * because the console asking for too many is not worth a failed page.
   *
   * No data-plane token here, unlike GET /sessions/:id. A list is a browsing surface and minting a
   * live device credential for every row of it would hand out N credentials to answer one question.
   */
  app.get<{ Querystring: { limit?: string; state?: string } }>('/sessions', async (req) => {
    const { orgId } = requireTenant(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;

    const rows = await withTenant(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT s.id, s.state, s.device_id, s.region, s.created_at, s.started_at, s.ended_at,
                s.end_reason, d.local_id AS device_local_id, d.model AS device_model
           FROM sessions s
           LEFT JOIN devices d ON d.id = s.device_id
          WHERE ($1::text IS NULL OR s.state = $1::session_state)
          ORDER BY s.created_at DESC
          LIMIT $2`,
        [state ?? null, limit],
      );
      return rows;
    });

    return {
      sessions: rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        state: r.state,
        region: r.region,
        deviceId: r.device_id,
        device: r.device_local_id ?? r.device_model ?? null,
        createdAt: r.created_at,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        endReason: r.end_reason,
      })),
    };
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

    /**
     * The data-plane block, and the reason this endpoint mints a token at all (known issue 9).
     *
     * Two things made its absence a real bug rather than an omission. A session created on the
     * QUEUED path gets no coordinates from `POST` — there is no device yet — so `mfarm run` had
     * nothing to hand its child once the reaper promoted the session, and anything speaking the raw
     * data plane simply did not work after a wait. And a session token lives for
     * DEFAULT_TTL_SECONDS (120s), so even on the immediate path the coordinates from `POST` go
     * stale during any run longer than two minutes and there was nowhere to refresh them.
     *
     * Minting on a GET is safe because it discloses nothing new: the caller already proved they are
     * the org that owns this session — RLS returned the row — and the claims are exactly those
     * `POST` would have issued. What it must not do is mint for a session that has ended, which is
     * why LIVE_STATES is checked rather than just `device_id IS NOT NULL`: a device is reassigned
     * the moment it is reset, and a token naming a fence that has moved on is a credential for
     * someone else's device. The worker's fence check would reject it, but a token that has to be
     * rejected should never have been issued.
     */
    let dataPlane: { endpoint: string; token: string; expiresInSeconds: number } | undefined;
    if (row.device_id && row.fence !== null && LIVE_STATES.has(row.state)) {
      const host = await hostForDevice(row.device_id);
      // An endpoint-less host is a real state (a worker registered before it had one), not an
      // error. `POST` releases the device in that case because it is mid-allocation and can still
      // undo it; here the session is already running, so the honest answer is coordinates omitted.
      if (host?.endpoint) {
        dataPlane = {
          endpoint: host.endpoint,
          token: mintSessionToken(
            {
              sid: row.id,
              did: row.device_id,
              org: orgId,
              fence: Number(row.fence),
              aud: host.id,
            },
            app.signingKey.privateKeyPem,
          ),
          expiresInSeconds: DEFAULT_TTL_SECONDS,
        };
      }
    }

    return {
      session: {
        id: row.id, state: row.state, deviceId: row.device_id,
        fence: row.fence === null ? null : Number(row.fence),
        region: row.region, createdAt: row.created_at, startedAt: row.started_at,
        expiresAt: row.expires_at, endedAt: row.ended_at, endReason: row.end_reason,
      },
      ...(dataPlane ? { dataPlane } : {}),
    };
  });

  app.delete<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const { orgId } = requireTenant(req);
    const ok = await release(orgId, req.params.id, 'client_request');
    if (!ok) throw notFound('Active session');
    return reply.code(204).send();
  });
}
