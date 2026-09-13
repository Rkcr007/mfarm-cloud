import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withSystem } from '../../db.ts';
import { requireUser } from '../server.ts';
import { forbidden } from '../errors.ts';
import { loadConfig } from '../../config.ts';

/**
 * The MACHINES, as an operator sees them — and what leaving them on is costing.
 *
 * WHY THIS EXISTS, precisely. On 2026-09-11 the device host ran for twenty hours and forty-eight
 * minutes after a check that needed it for two, and no surface in the product said so. The header
 * read "4 of 5 ready" the entire time — true, and completely silent about the fact that ready is
 * the expensive state. `docs/STATUS.md` opens by saying the device host is ~95% of the bill and is
 * stopped between sessions; nothing enforced or even reported that.
 *
 * **THE METER COULD NOT HAVE CAUGHT IT.** `metering_events` records device-seconds per org and
 * records them correctly; across those twenty hours it recorded a few minutes, because the devices
 * were idle. The per-org usage view the product review asked for would have shown almost nothing.
 * What costs money is the host being POWERED ON, allocated or not — a different question from
 * "what did this tenant consume", and the one with no data behind it until migration 050.
 *
 * ---
 *
 * ADMIN-ONLY, AND THROUGH A USER SESSION. `002_rls.sql` revokes `hosts` from `mfarm_app` entirely —
 * hosts are fleet metadata, not tenant data — so this reads on the system pool and the scope in the
 * SQL below IS the authorization, exactly as `account.ts` describes for its own writes.
 *
 * A KNOWN LIMIT, named rather than designed around: on a farm with more than one tenant, the cost
 * of a SHARED host is operator information and not attributable to whoever asked. This farm has one
 * org and that org is the operator, so the distinction costs nothing today. When an operator role
 * exists, the cost block belongs behind it — the rest of this payload does not.
 */
function requireOrgAdmin(req: FastifyRequest): { orgId: string } {
  const { orgId, role } = requireUser(req);
  if (role !== 'owner' && role !== 'admin') {
    throw forbidden('Only an owner or admin can see the machines behind the fleet.');
  }
  return { orgId };
}

interface HostRow {
  id: string;
  hostname: string;
  region: string;
  state: string;
  up_since: Date | null;
  last_heartbeat_at: Date | null;
  protocol_version: number;
  cores: number | null;
  memory_mb: number | null;
  quarantined_at: Date | null;
  quarantine_reason: string | null;
  disk_free_bytes: string | null;
  disk_total_bytes: string | null;
  load1: number | null;
  mem_available_mb: number | null;
  mem_total_mb: number | null;
  stats_at: Date | null;
  device_count: string;
  ready_count: string;
  /**
   * The start of the host's OPEN power interval, or null when it has none — the ledger's answer to
   * "is this machine switched on right now". See the comment on `uptimeSeconds` below.
   */
  powered_since: Date | null;
}

export async function hostRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/hosts — every machine this org's fleet runs on, with its uptime and what that costs.
   *
   * This is also the console read endpoint migration 044's numbers never had: disk, load and memory
   * have reached Prometheus since 2026-09-07 and nothing in the product could show them, so the
   * Health screen said plainly that it could not answer "why is the farm sick?".
   *
   * NOT an agent version, because there is no such column. `hosts.protocol_version` is what the
   * agent SPEAKS, which is a different and coarser fact — it moves when the protocol does, not when
   * somebody ships an agent. Reported as what it is rather than relabelled into the field the
   * product review asked for.
   */
  app.get('/hosts', async (req) => {
    const { orgId } = requireOrgAdmin(req);
    const cfg = loadConfig();

    const rows = await withSystem(async (c) => {
      const r = await c.query<HostRow>(
        `SELECT h.id, h.hostname, h.region, h.state, h.up_since, h.last_heartbeat_at,
                h.protocol_version, h.cores, h.memory_mb,
                h.quarantined_at, h.quarantine_reason,
                h.disk_free_bytes, h.disk_total_bytes, h.load1,
                h.mem_available_mb, h.mem_total_mb, h.stats_at,
                d.device_count, d.ready_count,
                p.started_at AS powered_since
           FROM hosts h
           -- THE LEDGER, NOT THE STATE, decides whether this machine is on — 054. At most one row
           -- per host can be open (host_power_intervals_open_idx is a partial unique index), so
           -- this is one index probe and cannot multiply the outer row.
           LEFT JOIN host_power_intervals p
                  ON p.host_id = h.id AND p.ended_at IS NULL
           LEFT JOIN LATERAL (
             SELECT count(*)                                    AS device_count,
                    count(*) FILTER (WHERE dv.state = 'READY')  AS ready_count
               FROM devices dv WHERE dv.host_id = h.id
           ) d ON true
          -- THE AUTHORIZATION, since this runs on the system pool. A shared host (org_id IS NULL)
          -- serves every tenant; a dedicated one serves exactly its own.
          -- Retired machines are not part of the fleet (056); their history lives on in the cost
          -- ledger and the operations log, which is where it belongs.
          WHERE h.retired_at IS NULL AND (h.org_id IS NULL OR h.org_id = $1)
          ORDER BY h.hostname`,
        [orgId],
      );
      return r.rows;
    });

    const now = Date.now();
    return {
      /**
       * Echoed so the console never has to know the rate, and so a page that shows money can say
       * where the number came from. Null rate means the operator has not configured one and the
       * console shows hours with no currency — see `config.ts`.
       */
      rate: cfg.hostHourlyCost === null
        ? null
        : { hourly: cfg.hostHourlyCost, currency: cfg.costCurrency },
      hosts: rows.map((h) => {
        const upSince = h.up_since;
        /**
         * FROM THE POWER LEDGER, NEVER FROM `state`. An open interval in `host_power_intervals` is
         * the only thing in this database that means "switched on"; `state` is a report about
         * whether the host is USABLE, and the two part company in both directions.
         *
         * The version this replaces read `state === 'UP' || state === 'QUARANTINED'`, and the
         * second half of that is how a machine gets billed for being off. A VM that is stopped goes
         * quiet, the reaper quarantines it for missing beats, and `up_since` still points at the
         * morning it last came up — so the console reported a switched-off host as having been
         * running for twelve hours and charged ~₹776 for it, while the operations centre, reading
         * the provider, said the fleet was costing nothing. Found on the live farm 2026-09-13.
         *
         * 054 ALREADY DREW THE LINE THIS NEEDS, and drew it more carefully than a state check can:
         * a REAPER quarantine closes the interval (silence is the only evidence of power we lose),
         * while an OPERATOR quarantine deliberately leaves it open, because draining a host for
         * maintenance leaves the machine switched on and costing exactly what it cost yesterday.
         * Reading the ledger inherits that distinction for free; reading `state` cannot express it.
         *
         * `up_since` stays in the payload — it is still the honest answer to "when did this host
         * last come up", which is a different question from "how long has it been on".
         */
        const poweredSince = h.powered_since;
        const uptimeSeconds = poweredSince
          ? Math.max(0, Math.round((now - poweredSince.getTime()) / 1000))
          : null;

        return {
          id: h.id,
          hostname: h.hostname,
          region: h.region,
          state: h.state,
          /** Null means the control plane does not know — a host that has not registered since 050. */
          upSince: upSince ? upSince.toISOString() : null,
          uptimeSeconds,
          /**
           * What this host has cost since it came up. Null whenever either half is unknown, never
           * zero: zero is a measurement and "we have no rate configured" is not one.
           */
          costSinceUp: cfg.hostHourlyCost !== null && uptimeSeconds !== null
            ? Number(((uptimeSeconds / 3600) * cfg.hostHourlyCost).toFixed(2))
            : null,
          lastHeartbeatAt: h.last_heartbeat_at ? h.last_heartbeat_at.toISOString() : null,
          protocolVersion: h.protocol_version,
          cores: h.cores,
          memoryMb: h.memory_mb,
          quarantine: h.quarantined_at
            ? { at: h.quarantined_at.toISOString(), reason: h.quarantine_reason }
            : null,
          devices: { total: Number(h.device_count ?? 0), ready: Number(h.ready_count ?? 0) },
          /**
           * Migration 044's numbers, with the timestamp they were taken at RATHER THAN WITHOUT IT.
           * That column exists because all five gauges are green on a host whose disk filled an hour
           * after it stopped reporting, and a reading with no age is indistinguishable from a
           * current one.
           */
          machine: h.stats_at
            ? {
                at: h.stats_at.toISOString(),
                diskFreeBytes: h.disk_free_bytes === null ? null : Number(h.disk_free_bytes),
                diskTotalBytes: h.disk_total_bytes === null ? null : Number(h.disk_total_bytes),
                load1: h.load1,
                memAvailableMb: h.mem_available_mb,
                memTotalMb: h.mem_total_mb,
              }
            : null,
        };
      }),
    };
  });
}
