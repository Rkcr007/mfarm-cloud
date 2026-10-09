import type { FastifyInstance } from 'fastify';
import { withSystem, withTenant } from '../../db.ts';
import { requireOperator, requireTenant, requireUser } from '../server.ts';
import { forbidden, notFound } from '../errors.ts';
import {
  clearResetEscalation, quarantineDevice, quarantineLog, releaseDeviceQuarantine, resetAttempts,
} from '../../allocator.ts';
import { forgetDevice, forgotten, inFleet, restoreDevice } from '../../forgotten.ts';

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
                  profile, screen, abis, last_reset_at,
                  reset_attempts, reset_escalated_at, reset_escalation_reason,
                  quarantined_at, quarantine_reason, quarantine_source,
                  recovery_started_at, recovery_from_reason, away_since, away_reason,
                  (org_id IS NOT NULL) AS dedicated
             FROM devices d
            WHERE ($1::text IS NULL OR region = $1)
              AND ($2::text IS NULL OR platform = $2)
              AND ($3::text IS NULL OR state::text = $3)
              -- A device somebody forgot is not part of the fleet (069). Never retired_at alone:
              -- see forgotten.ts for why a hidden device cannot be an allocatable one.
              AND ${inFleet('d')}
            ORDER BY platform, model`,
          [region ?? null, platform ?? null, state ?? null],
        );
        return rows;
      });

      /**
       * WHAT WAS FORGOTTEN, so that it can be found and put back (069). The same RLS read as the
       * list above, so a tenant sees the forgotten devices it could have seen in the fleet and no
       * others. Unfiltered by region or platform on purpose: this is a short list of exceptions,
       * and one hidden by a filter is one nobody can restore.
       */
      const gone = await withTenant(orgId, async (c) => (await c.query(
        `SELECT d.id, d.platform, d.tier, d.model, d.os_version, d.profile,
                d.retired_at, d.retired_reason,
                (d.org_id IS NOT NULL) AS dedicated
           FROM devices d
          WHERE ${forgotten('d')}
          ORDER BY d.retired_at DESC
          LIMIT 100`)).rows);

      /**
       * THE HOSTS' BEATS, ON THE SYSTEM POOL AND KEYED TO WHAT RLS ALREADY ALLOWED — D2.
       *
       * NOT A JOIN. Migration 002 revokes `hosts` from `mfarm_app` entirely, so a join inside
       * `withTenant` is a 500 — which is exactly what the first version of this was, and what
       * `device-health-fields.test.ts` reported before anybody looked at a farm.
       *
       * The order IS the authorisation, the same shape `/devices/:id` uses for this same field: the
       * tenant read above decides which devices this caller may see, and only those ids are carried
       * into a system-pool read. Nothing here widens what is visible; it annotates it.
       *
       * Skipped entirely for an empty fleet, so the ordinary "no devices yet" answer costs one query
       * rather than two.
       */
      const heartbeats = new Map<string, string>();
      /**
       * DEVICES WHOSE HOST WAS RETIRED ARE NOT IN THE FLEET (056) — and this list was still showing
       * them. Retiring a machine says "N devices went with it"; they then sat in every tenant's
       * Fleet as QUARANTINED, reason "retired: …", for good, with a Recover button that asked a
       * machine nobody would ever switch on again. The rows stay — a session that ran on one still
       * names it, and `GET /devices/:id` still answers — but a list of what the fleet HAS leaves
       * them out. Read in the same system-pool query as the beat, for the reason given above: the
       * tenant cannot join `hosts`.
       */
      const onRetiredHost = new Set<string>();
      if (rows.length || gone.length) {
        await withSystem(async (c) => {
          const { rows: hostFacts } = await c.query(
            `SELECT d.id, h.last_heartbeat_at, (h.retired_at IS NOT NULL) AS retired
               FROM devices d JOIN hosts h ON h.id = d.host_id
              WHERE d.id = ANY($1::uuid[])`,
            [[...rows, ...gone].map((r) => r.id)],
          );
          for (const b of hostFacts) {
            if (b.last_heartbeat_at) heartbeats.set(b.id as string, b.last_heartbeat_at as string);
            if (b.retired) onRetiredHost.add(b.id as string);
          }
        });
      }

      return {
        devices: rows.filter((r) => !onRetiredHost.has(r.id)).map((r) => ({
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
           * WHEN THE FARM LAST CONFIRMED THIS DEVICE WAS GOOD — D1, and the Health page's per-device
           * line (document 05 §06: "check passed 4m ago").
           *
           * A COLUMN, NOT THE LATERAL JOIN THE DEFECT ASKED FOR. `docs/DEFECTS.md` proposed joining
           * `device_reset_attempts`, and that table is the wrong source: migration 032 writes to it
           * only when a reset has been outstanding too long or has been escalated, so its outcomes
           * are `timed-out | succeeded | escalated` and a HEALTHY device has no rows in it at all.
           * Joining it would have produced "no check recorded" for every device that has never had a
           * problem, which is the exact inverse of the truth.
           *
           * `last_reset_at` is the fact the design is reaching for. It is stamped by both paths that
           * end with the farm saying this device is fit to hand over: the worker confirming a
           * snapshot restore, and `complete_recovery` when a released quarantine passes its health
           * check (migration 035). Device DETAIL has always shown it as "Last reset"; it was absent
           * from the list for no reason beyond nobody needing it there yet.
           */
          ...(r.last_reset_at ? { lastResetAt: r.last_reset_at } : {}),
          /**
           * WHEN THE FARM LAST HEARD FROM THIS DEVICE'S HOST — D2, and it is the difference between
           * two readings of the same blank field.
           *
           * `Screen: not reported` on a handset was recorded as a worker defect. It is not: the
           * agent has read a panel with `wm size` / `wm density` since 2026-08-24 and cannot send a
           * device without one. The farm's handset shows nothing because its row has not been
           * written since its host last beat on 2026-08-29 — the data is nine days old, and the
           * console said "not reported" as though the device had been asked this morning.
           *
           * A silent host and a device that genuinely reports no geometry are indistinguishable
           * without this timestamp, and they call for opposite actions: plug the machine back in,
           * or go and look at the device. Detail has carried it since ADR-0026; the list did not,
           * so the Fleet — where somebody actually notices a blank column — could not tell them
           * apart.
           *
           * A TIMESTAMP, NEVER THE HOSTNAME (ADR-0026). It sharpens a fact the tenant already reads
           * off the device's own state; a hostname would group their devices beside somebody else's
           * permanently and cannot be acted on.
           */
          ...(heartbeats.has(r.id) ? { hostLastSeenAt: heartbeats.get(r.id) } : {}),
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
          /**
           * WHY a device is quarantined, and — while one is running — the recovery an operator
           * authorised (migration 035).
           *
           * Both absent when they do not apply, like every optional field above. A quarantined
           * device without this object is one quarantined before 035 shipped: honest, and visibly
           * different from one whose reason is the empty string.
           *
           * `state` alone was all a console could ever show here, which is how the fleet arrived at
           * a screen that said "Quarantined — Failed health checks" about a handset whose host had
           * simply stopped beating.
           */
          // ONLY BESIDE A QUARANTINE (D63). A device returned to service by Resume kept these three
          // columns until 068, and this sent them on — the Fleet then printed "its host was
          // quarantined" next to AVAILABLE. 068 clears them; this keeps a stale row from ever
          // reaching a screen again, whatever path leaves one.
          ...(r.quarantined_at && r.state === 'QUARANTINED'
            ? {
              quarantine: {
                at: r.quarantined_at,
                reason: r.quarantine_reason,
                source: r.quarantine_source,
              },
            }
            : {}),
          ...(r.recovery_started_at
            ? {
              recovery: {
                startedAt: r.recovery_started_at,
                fromReason: r.recovery_from_reason,
              },
            }
            : {}),
          // WHY AN OFFLINE DEVICE IS OFFLINE, when its own agent said (067, D62). Without it the
          // console could only say "the host has not reported it" about a phone the host had
          // reported, precisely, as not being on its cable.
          ...(r.away_since ? { away: { since: r.away_since, reason: r.away_reason } } : {}),
        })),
        // Availability is what callers actually decide on, so it is computed here rather than
        // leaving every client to derive it from the state enum.
        available: rows.filter((r) => r.state === 'READY').length,
        // A forgotten device on a RETIRED host is left out of this too: restoring it would put a
        // device back in a fleet its machine is not part of. Restore the host and it returns here.
        forgotten: gone.filter((r) => !onRetiredHost.has(r.id)).map((r) => ({
          // `tier` and `profile` are what the console names a device from. Without them every
          // forgotten device is "Unprofiled device", and a list of those identifies nothing.
          id: r.id, platform: r.platform, tier: r.tier, model: r.model, osVersion: r.os_version,
          ...(r.profile ? { profile: r.profile } : {}),
          dedicated: r.dedicated, forgottenAt: r.retired_at, reason: r.retired_reason,
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/devices/:id', async (req) => {
    const { orgId } = requireTenant(req);
    const row = await withTenant(orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT d.id, d.region, d.platform, d.tier, d.model, d.os_version, d.state, d.capabilities,
                d.last_reset_at, d.profile, d.screen, d.abis,
                d.reset_attempts, d.last_reset_attempt_at, d.reset_escalated_at,
                d.reset_escalation_reason,
                d.quarantined_at, d.quarantine_reason, d.quarantine_source,
                d.recovery_started_at, d.recovery_from_reason, d.recovery_released_by,
                d.away_since, d.away_reason,
                d.retired_at, d.retired_reason, (d.org_id IS NOT NULL) AS dedicated,
                -- Joined here rather than exposed as a bare uuid the console would have to resolve
                -- against an endpoint it cannot reach: the users table is RLS-scoped to the
                -- caller's org, and an operator releasing a SHARED device need not be in it. It
                -- resolves to NULL when the account has since been deleted — the audit log keeps a
                -- copy of the address for exactly that case, and this read is the live one.
                (SELECT u.email FROM users u WHERE u.id = d.recovery_released_by) AS released_by_email
           FROM devices d WHERE d.id = $1`,
        [req.params.id],
      );
      return rows[0];
    });
    if (!row) throw notFound('Device');

    /**
     * WHEN THE FARM LAST HEARD FROM THE MACHINE BEHIND THIS DEVICE.
     *
     * On the tenant pool and not from `devices`, because neither is a substitute:
     *
     *   - `devices.updated_at` moves on a state change or a re-registration, and registration
     *     happens at agent start and on a fingerprint change — NOT on the ten-second beat. Labelling
     *     it "last seen" would say a healthy idle device had been silent for days.
     *   - `hosts.last_heartbeat_at` is the beat, and migration 002 revokes `hosts` from `mfarm_app`
     *     entirely, so the tenant pool cannot reach it at all.
     *
     * The order is the authorisation, exactly as in `/devices/:id/reset-attempts` below: the
     * `withTenant` read above is what decides whether this device is visible to this caller, and
     * only a device that survived RLS gets a second, system-pool read keyed to its own id.
     *
     * A TIMESTAMP, NEVER THE HOSTNAME — see ADR-0026. The design package's device detail screen
     * shows `Host lab-host-02`, and that field is deliberately not implemented: a hostname is a
     * stable identifier that lets a tenant map the farm's topology and confirm, permanently, which
     * of their devices sit beside which of somebody else's. The heartbeat adds no fact the tenant
     * cannot already infer — a host that stops beating takes its devices OFFLINE, which they can
     * see — it only adds precision to a fact they already have.
     */
    const heard = await withSystem(async (c) => {
      const { rows } = await c.query<{ last_heartbeat_at: Date | null }>(
        `SELECT h.last_heartbeat_at
           FROM hosts h JOIN devices d ON d.host_id = h.id
          WHERE d.id = $1`,
        [req.params.id],
      );
      return rows[0]?.last_heartbeat_at ?? null;
    });

    return {
      device: {
        // Named for what it measures. "lastSeenAt" would invite a reader to attach it to the
        // device, and a device can be unplugged from a host that is beating perfectly.
        hostLastSeenAt: heard,
        id: row.id, region: row.region, platform: row.platform, tier: row.tier,
        model: row.model, osVersion: row.os_version, state: row.state,
        capabilities: row.capabilities, lastResetAt: row.last_reset_at,
        // Whose it is decides who may forget or restore it, and a forgotten device is not in the
        // list this page otherwise reads that from.
        dedicated: row.dedicated,
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
        ...(row.quarantined_at && row.state === 'QUARANTINED'
          ? {
            quarantine: {
              at: row.quarantined_at,
              reason: row.quarantine_reason,
              source: row.quarantine_source,
            },
          }
          : {}),
        ...(row.recovery_started_at
          ? {
            recovery: {
              startedAt: row.recovery_started_at,
              fromReason: row.recovery_from_reason,
              releasedBy: row.released_by_email ?? null,
            },
          }
          : {}),
        ...(row.away_since ? { away: { since: row.away_since, reason: row.away_reason } } : {}),
        /**
         * FORGOTTEN (069) — the same test the list uses, so this page and the Fleet cannot disagree
         * about whether a device is in it. The page still answers for a forgotten device: a session
         * that ran on it links here, and this is where it is restored from.
         */
        ...(row.retired_at && (row.state === 'OFFLINE' || row.state === 'QUARANTINED')
          ? { forgotten: { at: row.retired_at, reason: row.retired_reason } }
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
  /* -------------------------------------------------------- quarantine, and the gated way back */

  /**
   * Who may act on one device's quarantine.
   *
   * The same rule and the same three reasons as `clear-reset-escalation` above: a signed-in owner
   * or admin, never a worker and never a bare API key. Taking a handset out of service and
   * authorising it back in are both judgements, and a CI key making either on every run would turn
   * the gate into a formality.
   *
   * SHARED DEVICES BELONG TO NO ORG, so any org's admin can act on one. Honest for a self-hosted
   * farm where the tenant IS the operator; RLS on the read still stops an admin touching another
   * tenant's DEDICATED handset. A hosted fleet would need a fleet-operator role, and that does not
   * exist yet — do not infer one from this (ADR-0019 said the same, and it is still true).
   */
  async function operatorOn(req: Parameters<typeof requireUser>[0], deviceId: string) {
    const { orgId, role, userId } = requireUser(req);
    if (role !== 'owner' && role !== 'admin') {
      throw forbidden('Only an owner or admin can change a device’s quarantine.');
    }
    // RLS decides what this person can see, and the definer functions below run on the system pool
    // where nothing would. Same order, and the same reason, as every other route in this file.
    const visible = await withTenant(orgId, async (c) => {
      const { rows } = await c.query('SELECT id FROM devices WHERE id = $1', [deviceId]);
      return rows[0];
    });
    if (!visible) throw notFound('Device');
    return userId;
  }

  /**
   * Take a device out of service.
   *
   * The reason is REQUIRED. A quarantine with no reason is a device nobody can triage: the operator
   * who finds it a week later has the same information they would have had from an unexplained
   * `available: 0`, which is the failure the whole of migration 035 is about.
   *
   * Any live session on the device ends — see `quarantine_device`. "Remove it from allocation
   * immediately" is not satisfied by refusing future allocations while somebody is still driving a
   * handset that just failed its health checks.
   */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/devices/:id/quarantine',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (req) => {
      const userId = await operatorOn(req, req.params.id);
      const quarantined = await quarantineDevice(
        req.params.id, req.body.reason!.trim(), 'operator', userId,
      );
      return {
        quarantined,
        detail: quarantined
          ? 'The device is out of the allocation pool. Any session on it has ended.'
          : 'This device is already quarantined, or it has been evicted. Nothing changed.',
      };
    },
  );

  /**
   * Release a quarantine — which authorises a RECOVERY ATTEMPT and nothing more (ADR-0024).
   *
   * The response says so in as many words, and that wording is load-bearing rather than decorative.
   * The obvious implementation of §30's "[Recover Device]" is `UPDATE devices SET state = 'READY'`,
   * and an endpoint that returned "device available" here would leave every caller — the console,
   * a script, the next person to read this file — believing that is what happened. What actually
   * happens is that the device moves to `PREPARING`, the heartbeat starts offering it a reset
   * again, and only a completed reset plus a passing health check reported by its own host reaches
   * `READY`. Anything else puts it back in quarantine carrying the new failure.
   */
  app.post<{ Params: { id: string } }>('/devices/:id/release-quarantine', async (req) => {
    const userId = await operatorOn(req, req.params.id);
    /**
     * NOT A FORGOTTEN DEVICE (069). A recovery moves it to PREPARING, which makes it visible again
     * by the rule in `forgotten.ts` — and if the recovery then fails it is quarantined and hidden
     * once more, with a reset attempted on a device somebody had said was gone. Restore it first:
     * that is one click, and it puts the Recover button back where a person can see what it does.
     */
    const isForgotten = await withSystem(async (c) => (await c.query(
      `SELECT 1 FROM devices d WHERE d.id = $1 AND ${forgotten('d')}`, [req.params.id])).rowCount);
    if (isForgotten) {
      return {
        released: false,
        state: null,
        detail: 'This device was forgotten, so nothing was attempted. Restore it first, then recover it.',
      };
    }
    const released = await releaseDeviceQuarantine(req.params.id, userId);
    return {
      released,
      // The state is named explicitly, because "released" on its own is the word that invites the
      // wrong assumption. A caller that reads nothing else reads this.
      state: released ? 'PREPARING' : null,
      detail: released
        ? 'Recovery authorised. The device is PREPARING — its host will reset it and report a '
          + 'health check, and only a passing one makes it available. A failure puts it back in '
          + 'quarantine with the new reason.'
        : 'This device is not quarantined, so nothing changed.',
    };
  });

  /**
   * Every quarantine, release and recovery outcome for this device — the audit trail.
   *
   * The device is fetched through `withTenant` FIRST and the log only afterwards, for exactly the
   * reason `reset-attempts` does it: `device_quarantine_log` is fleet-level with no `org_id` and no
   * RLS policy, so reading it on the system pool without that check would hand any tenant the
   * recovery history — and the operator email — of any device in the fleet.
   */
  /**
   * Who may forget, or restore, this device — and it is not the same answer for every device.
   *
   * A DEDICATED device belongs to one org: its owners and admins decide. A SHARED device is the
   * fleet's, and every tenant can see it, so removing it from the fleet is a FLEET decision — the
   * operator capability from migration 053, not an org role. `operatorOn` above lets any org admin
   * quarantine a shared device, which its own comment calls a known limit of a one-org farm; a
   * removal should not be built on the same gap.
   *
   * Visibility first, through RLS, exactly as `operatorOn` does it: a device this caller cannot see
   * is a 404, whoever they are.
   */
  async function removerOf(req: Parameters<typeof requireUser>[0], deviceId: string): Promise<string> {
    const { orgId, role, userId } = requireUser(req);
    const visible = await withTenant(orgId, async (c) => (await c.query<{ dedicated: boolean }>(
      'SELECT (org_id IS NOT NULL) AS dedicated FROM devices WHERE id = $1', [deviceId])).rows[0]);
    if (!visible) throw notFound('Device');
    if (visible.dedicated) {
      if (role !== 'owner' && role !== 'admin') {
        throw forbidden('Only an owner or admin can forget or restore one of your organisation’s devices.');
      }
    } else {
      // Throws the same refusal every Infrastructure route does, naming the fleet capability.
      requireOperator(req);
    }
    return userId;
  }

  /**
   * POST /v1/devices/:id/forget — this device is gone; stop listing it (migration 069).
   *
   * NOT A DELETE: the row, its sessions and its history stay, and `GET /devices/:id` still answers.
   * It leaves the fleet list and every count. See `forgotten.ts` for what may be forgotten and why
   * each refusal is its own sentence.
   */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/devices/:id/forget',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req) => {
      const userId = await removerOf(req, req.params.id);
      const reason = (req.body?.reason ?? '').replace(/\s+/g, ' ').trim() || null;
      const out = await forgetDevice(req.params.id, userId, reason);
      if (out.forgotten) {
        return {
          forgotten: true,
          detail: 'The device is off the fleet list and out of every count. Its history is kept, '
            + 'and it comes back by itself if its agent ever sees it again.',
        };
      }
      const WHY: Record<typeof out.why, string> = {
        already: 'This device was already forgotten. Nothing changed.',
        present: 'Its agent can see this device right now, so it would only come straight back. '
          + 'Unplug it, or stop sharing it, and then forget it.',
        'in-use': 'Somebody is using this device. Forgetting is for a device that is gone, not a '
          + 'way to take one from under a session.',
        'host-held': 'This device is out because its host is away, and it returns when the host '
          + 'does. If the machine itself is not coming back, retire the host instead.',
        busy: 'The farm is in the middle of resetting or recovering this device. Try again when '
          + 'that has finished.',
        missing: 'That device no longer exists.',
      };
      return { forgotten: false, detail: WHY[out.why] };
    },
  );

  /** POST /v1/devices/:id/restore — put a forgotten device back on the list. */
  app.post<{ Params: { id: string } }>(
    '/devices/:id/restore',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
    async (req) => {
      await removerOf(req, req.params.id);
      const restored = await restoreDevice(req.params.id);
      return {
        restored,
        detail: restored
          // It returns in the state it was in. Saying "available" would be a promise about a phone
          // that may still be in a drawer.
          ? 'The device is back on the fleet list, in the state it was in. Restoring does not make '
            + 'it available: that takes its agent seeing it, or a recovery if it was quarantined.'
          : 'This device was not forgotten, so nothing changed.',
      };
    },
  );

  app.get<{ Params: { id: string } }>('/devices/:id/quarantine-log', async (req) => {
    const { orgId } = requireTenant(req);
    const visible = await withTenant(orgId, async (c) => {
      const { rows } = await c.query('SELECT id FROM devices WHERE id = $1', [req.params.id]);
      return rows[0];
    });
    if (!visible) throw notFound('Device');

    const events = await quarantineLog(req.params.id);
    return {
      events: events.map((e) => ({
        event: e.event, source: e.source, reason: e.reason,
        // The copied address, not a join. An audit row that outlives the account it names still has
        // to say who — see migration 035.
        actor: e.actorEmail, fromReason: e.fromReason,
        detail: e.detail, fence: e.fence, occurredAt: e.occurredAt,
      })),
    };
  });
}
