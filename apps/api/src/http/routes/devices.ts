import type { FastifyInstance } from 'fastify';
import { withTenant } from '../../db.ts';
import { requireTenant, requireUser } from '../server.ts';
import { forbidden, notFound } from '../errors.ts';
import { clearResetEscalation, resetAttempts } from '../../allocator.ts';

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
                  reset_attempts, reset_escalated_at, reset_escalation_reason,
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
          /**
           * THE ESCALATED CONDITION (migration 032), and it is a CONDITION rather than a state:
           * the device still reads `CLEANING`, because that is what "not allocatable" means here
           * and quarantining would also stop the resets that are the only thing which could fix it.
           *
           * Sent only when set, like `profile` and `screen` above — a healthy fleet's device list
           * is unchanged, so no existing reader has a new shape to handle. A console that knows
           * nothing of this field keeps rendering exactly what it rendered before.
           */
          ...(r.reset_escalated_at
            ? {
              resetEscalation: {
                at: r.reset_escalated_at,
                reason: r.reset_escalation_reason,
                attempts: Number(r.reset_attempts),
              },
            }
            : {}),
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
                profile, screen, abis,
                reset_attempts, last_reset_attempt_at, reset_escalated_at, reset_escalation_reason
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
        // Always present on the detail read, unlike the list: this is the screen somebody opens to
        // ask "why is this device not being handed out", and 0 attempts is the answer to that
        // question rather than the absence of one.
        resetAttempts: Number(row.reset_attempts),
        lastResetAttemptAt: row.last_reset_attempt_at,
        ...(row.reset_escalated_at
          ? {
            resetEscalation: {
              at: row.reset_escalated_at,
              reason: row.reset_escalation_reason,
              attempts: Number(row.reset_attempts),
            },
          }
          : {}),
      },
    };
  });

  /**
   * Every counted reset attempt for this device, with its time — §11's "record all reset attempts
   * and timestamps", read back.
   *
   * The device is fetched through `withTenant` FIRST and the history only afterwards. That order is
   * the authorisation: `device_reset_attempts` is fleet-level with no `org_id` and no RLS policy
   * (migration 032), so reading it directly on the system pool would hand any tenant the recovery
   * history of any device in the fleet. RLS on `devices` is what decides, and it already decides
   * correctly for `/devices/:id` above.
   */
  app.get<{ Params: { id: string } }>('/devices/:id/reset-attempts', async (req) => {
    const { orgId } = requireTenant(req);
    const visible = await withTenant(orgId, async (c) => {
      const { rows } = await c.query('SELECT id FROM devices WHERE id = $1', [req.params.id]);
      return rows[0];
    });
    if (!visible) throw notFound('Device');

    const attempts = await resetAttempts(req.params.id);
    return {
      attempts: attempts.map((a) => ({
        attempt: a.attempt, outcome: a.outcome, detail: a.detail,
        fence: a.fence, occurredAt: a.occurredAt,
      })),
    };
  });

  /**
   * Resume recovery on an escalated device — the deliberate act §11 asks for.
   *
   * A SIGNED-IN PERSON, and an owner or admin at that. Three reasons it is not the worker and not a
   * bare API key:
   *
   *   * the heartbeat is what exhausted the budget, so letting that path clear it would rebuild
   *     the unbounded loop migration 032 exists to end;
   *   * an escalation means the device needs a human to look at it, and a CI key clearing it on
   *     every run would turn a terminal state back into an infinite retry with extra steps;
   *   * the role check follows `routes/account.ts`, which is where this codebase already decided
   *     what "an administrative action" looks like.
   *
   * SHARED DEVICES BELONG TO NO ORG, so any org's admin can clear one, and that is honest for the
   * deployment this ships into — a self-hosted farm where the tenant IS the operator. RLS on the
   * read below still stops an admin touching another tenant's DEDICATED handset. A hosted fleet
   * would need a fleet-operator role, and that does not exist yet; do not infer one from this.
   */
  app.post<{ Params: { id: string } }>('/devices/:id/clear-reset-escalation', async (req) => {
    const { orgId, role } = requireUser(req);
    if (role !== 'owner' && role !== 'admin') {
      throw forbidden('Only an owner or admin can clear a reset escalation.');
    }

    // Same order, and the same reason, as the history read above: RLS decides what this person can
    // see, and `clear_reset_escalation` runs on the system pool where nothing would.
    const visible = await withTenant(orgId, async (c) => {
      const { rows } = await c.query('SELECT id FROM devices WHERE id = $1', [req.params.id]);
      return rows[0];
    });
    if (!visible) throw notFound('Device');

    const cleared = await clearResetEscalation(req.params.id);
    return {
      cleared,
      // Said plainly rather than implied by `cleared: false`. Clicking twice is the ordinary way to
      // arrive here, and "there was no escalation" is a different fact from "it did not work".
      detail: cleared
        ? 'Recovery resumed. The next heartbeat will offer this device a reset again.'
        : 'This device was not escalated, so nothing changed.',
    };
  });
}
