import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant } from '../../db.ts';
import { requireTenant, requireUser } from '../server.ts';
import { forbidden, notFound } from '../errors.ts';
import type { TunnelAllowRule } from '@mfarm/protocol';

/**
 * Removing a tunnel is an org-level change, so it takes an org admin — the same guard
 * `pairing.ts` and `account.ts` each keep locally rather than importing from one another, and for
 * the same reason: one four-line check in three places beats an import cycle between route modules.
 */
function requireOrgAdmin(req: FastifyRequest): { userId: string; orgId: string } {
  const { userId, orgId, role } = requireUser(req);
  if (role !== 'owner' && role !== 'admin') {
    throw forbidden('Only an owner or admin can remove a tunnel from this org.');
  }
  return { userId, orgId };
}

/**
 * What this org's tunnels are, and letting an admin forget one (migration 052).
 *
 * NO ROUTE CREATES A TUNNEL, deliberately. A row appears when a CLIENT connects and says hello,
 * because a tunnel that exists in a database and nowhere else is a promise the product cannot keep:
 * a suite that named it would allocate a device, install a build and then fail every request. The
 * console shows what has connected and what once did; the way to have one is to run the client.
 */

interface TunnelRow {
  name: string;
  allow: TunnelAllowRule[];
  client: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  requests: string;
  created_by_email: string | null;
}

export async function tunnelRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/tunnels — every tunnel this org has, live or not.
   *
   * `connected` COMES FROM THE REGISTRY, not from `last_seen_at`. A row's timestamp says when a
   * client was last here; only the socket says whether one is here NOW, and those differ during
   * exactly the incident somebody opens this page for. A page that inferred "connected" from a
   * recent timestamp would show a tunnel as up for however long its staleness window was, which is
   * the window in which every request through it is failing.
   */
  app.get('/tunnels', async (req) => {
    const { orgId } = requireTenant(req);
    const rows = await withTenant(orgId, async (c) => (await c.query<TunnelRow>(
      `SELECT t.name, t.allow, t.client, t.created_at, t.last_seen_at, t.requests,
              u.email AS created_by_email
         FROM tunnels t
         LEFT JOIN users u ON u.id = t.created_by
        WHERE t.org_id = $1
        ORDER BY t.last_seen_at DESC NULLS LAST, t.created_at DESC`,
      [orgId],
    )).rows);

    const live = new Map(app.customerTunnels.listFor(orgId).map((t) => [t.name.toLowerCase(), t]));

    return {
      tunnels: rows.map((r) => {
        const now = live.get(r.name.toLowerCase());
        return {
          name: r.name,
          connected: Boolean(now),
          // The LIVE rules where there is a live client, because those are the ones in force. The
          // stored ones are what the last client declared, and a reader comparing them to what is
          // actually happening should be shown what is actually happening.
          allow: now?.allow ?? r.allow ?? [],
          client: now?.client ?? r.client,
          createdAt: r.created_at.toISOString(),
          createdByEmail: r.created_by_email,
          lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
          connectedAt: now ? new Date(now.connectedAt).toISOString() : null,
          // bigint arrives as a string from pg; a request count is small enough to be a number and
          // a caller formatting it should not have to know that.
          requests: Number(r.requests) + (now?.requests ?? 0),
        };
      }),
    };
  });

  /**
   * DELETE /v1/tunnels/:name — forget one.
   *
   * ADMIN ONLY, like every other org-level removal. What it removes is the RECORD and the live
   * socket; it cannot stop somebody re-running the client, which is correct — the client holds a
   * valid API key and revoking that is the actual control. What this is for is a tunnel nobody
   * meant to leave running, and a list that has accumulated six names for three laptops.
   */
  app.delete<{ Params: { name: string } }>('/tunnels/:name', async (req, reply) => {
    const { orgId } = requireOrgAdmin(req);
    const gone = await withTenant(orgId, async (c) => (await c.query(
      'DELETE FROM tunnels WHERE org_id = $1 AND lower(name) = lower($2)',
      [orgId, req.params.name],
    )).rowCount ?? 0);
    if (!gone) throw notFound('Tunnel');
    // Dropped from the registry too, so the name stops routing immediately rather than at the next
    // reconnect. A record removed while its socket keeps carrying traffic is the worst of both.
    app.customerTunnels.disconnect(orgId, req.params.name, 'this tunnel was removed');
    return reply.code(200).send({ deleted: true });
  });
}
