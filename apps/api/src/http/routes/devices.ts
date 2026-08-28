import type { FastifyInstance } from 'fastify';
import { withTenant } from '../../db.ts';
import { requireTenant } from '../server.ts';
import { notFound } from '../errors.ts';

export async function deviceRoutes(app: FastifyInstance) {
  /**
   * Fleet catalogue. RLS restricts this to the shared pool plus anything dedicated to the caller,
   * so no filtering happens in application code — a query that forgets the org clause still cannot
   * leak another tenant's dedicated hardware.
   */
  app.get<{ Querystring: { region?: string; platform?: string; state?: string } }>(
    '/devices',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            region: { type: 'string', maxLength: 64 },
            platform: { type: 'string', enum: ['android', 'ios'] },
            state: { type: 'string', maxLength: 32 },
          },
        },
      },
    },
    async (req) => {
      const { orgId } = requireTenant(req);
      const { region, platform, state } = req.query;

      const rows = await withTenant(orgId, async (c) => {
        const { rows } = await c.query(
          `SELECT id, region, platform, tier, model, os_version, state, capabilities,
                  profile, screen, abis,
                  (org_id IS NOT NULL) AS dedicated
             FROM devices
            WHERE ($1::text IS NULL OR region = $1)
              AND ($2::text IS NULL OR platform = $2)
              AND ($3::text IS NULL OR state::text = $3)
            ORDER BY platform, model`,
          [region ?? null, platform ?? null, state ?? null],
        );
        return rows;
      });

      return {
        devices: rows.map((r) => ({
          id: r.id, region: r.region, platform: r.platform, tier: r.tier,
          model: r.model, osVersion: r.os_version, state: r.state,
          capabilities: r.capabilities, dedicated: r.dedicated,
          // Null-coalesced away rather than sent as null. A device card reads these as "draw the
          // chrome for this profile" and "show this geometry"; absent is a meaningful answer for
          // both, and an explicit null in the payload is one more shape every reader has to handle
          // to arrive at the same place (ADR-0016).
          ...(r.profile ? { profile: r.profile } : {}),
          ...(r.screen ? { screen: r.screen } : {}),
          ...(r.abis ? { abis: r.abis } : {}),
        })),
        // Availability is what callers actually decide on, so it is computed here rather than
        // leaving every client to derive it from the state enum.
        available: rows.filter((r) => r.state === 'READY').length,
      };
    },
  );

  app.get<{ Params: { id: string } }>('/devices/:id', async (req) => {
    const { orgId } = requireTenant(req);
    const row = await withTenant(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, region, platform, tier, model, os_version, state, capabilities, last_reset_at,
                profile, screen, abis
           FROM devices WHERE id = $1`,
        [req.params.id],
      );
      return rows[0];
    });
    if (!row) throw notFound('Device');
    return {
      device: {
        id: row.id, region: row.region, platform: row.platform, tier: row.tier,
        model: row.model, osVersion: row.os_version, state: row.state,
        capabilities: row.capabilities, lastResetAt: row.last_reset_at,
        ...(row.profile ? { profile: row.profile } : {}),
        ...(row.screen ? { screen: row.screen } : {}),
        ...(row.abis ? { abis: row.abis } : {}),
      },
    };
  });
}
