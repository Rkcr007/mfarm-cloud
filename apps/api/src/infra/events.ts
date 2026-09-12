import { withSystem } from '../db.ts';

/**
 * What happened to this farm recently — one feed, from the three places that already record it.
 *
 * WHY A UNION AND NOT A NEW TABLE. The tempting design is an `infra_events` table that everything
 * writes to, and it would be a fourth copy of facts three tables already hold correctly:
 * `infra_operations` (053) knows what an operator did, `device_quarantine_log` (035) knows what
 * happened to every device and is deliberately append-only, and `host_power_intervals` (054) knows
 * when each machine was on. A new table would need every one of those writers to remember a second
 * write, and the first one to forget would produce a feed that is silently incomplete — which is
 * worse than no feed, because it looks complete.
 *
 * So this reads them. The cost is one query with three arms per page load; the benefit is that the
 * feed cannot drift from the records it describes, because it IS those records.
 *
 * NOTHING HERE IS TENANT DATA and nothing here is scoped to an org. A device quarantine is a fact
 * about the fleet; the session that was on the device at the time is not named. `requireOperator`
 * is the gate, in the route.
 */

export interface InfraEvent {
  at: string;
  /** `operation` | `device` | `power`. The console groups and icons on this. */
  source: 'operation' | 'device' | 'power';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string | null;
  /** Who, when a person was involved. Null for everything the farm did to itself. */
  actor: string | null;
  target: { kind: string; id: string; label: string } | null;
}

interface Row {
  at: Date; source: string; severity: string; title: string; detail: string | null;
  actor: string | null; target_kind: string | null; target_id: string | null; target_label: string | null;
}

/**
 * The feed, newest first.
 *
 * `since` defaults to a week, which is the window in which "what happened recently" is a real
 * question. Older than that and somebody is investigating rather than glancing, and the operations
 * history with its filters is the surface for that.
 */
export async function recentEvents(opts: { limit?: number; sinceHours?: number } = {}): Promise<InfraEvent[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const sinceHours = Math.min(Math.max(opts.sinceHours ?? 168, 1), 24 * 90);

  const rows = await withSystem(async (c) => {
    const { rows } = await c.query<Row>(
      `WITH win AS (SELECT now() - make_interval(hours => $2) AS since)

       -- 1. What an operator did. "accepted" is included on purpose: an operation still in flight is
       --    the single most relevant line on the page while it is happening.
       SELECT o.requested_at AS at, 'operation' AS source,
              CASE o.result WHEN 'failed' THEN 'critical'
                            WHEN 'unknown' THEN 'warning'
                            ELSE 'info' END AS severity,
              o.action || ' ' || o.target_label AS title,
              COALESCE(o.detail, CASE o.result
                WHEN 'accepted'  THEN 'In progress.'
                WHEN 'succeeded' THEN NULL
                WHEN 'noop'      THEN 'Already in the requested state; nothing changed.'
                WHEN 'unknown'   THEN 'The outcome was never confirmed.'
                ELSE NULL END) AS detail,
              o.actor_email AS actor,
              o.target_kind, o.target_id, o.target_label
         FROM infra_operations o, win WHERE o.requested_at >= win.since

       UNION ALL

       -- 2. What happened to the devices. The one feed that already existed, and it was reachable
       --    only one device at a time from that device's own page.
       SELECT q.occurred_at, 'device',
              CASE q.event WHEN 'quarantined' THEN 'warning'
                           WHEN 'recovery-failed' THEN 'critical'
                           ELSE 'info' END,
              d.model || ' ' || q.event
                || CASE WHEN q.source IS NOT NULL THEN ' (' || q.source || ')' ELSE '' END,
              COALESCE(q.reason, q.from_reason),
              q.actor_email,
              'host', h.id::text, h.hostname
         FROM device_quarantine_log q
         JOIN devices d ON d.id = q.device_id
         LEFT JOIN hosts h ON h.id = d.host_id, win
        WHERE q.occurred_at >= win.since

       UNION ALL

       -- 3. Machines coming up. Powering ON is the event with a cost attached, so it is reported
       --    whoever caused it -- a console button, a laptop script, or the VM rebooting itself.
       SELECT i.started_at, 'power', 'info',
              h.hostname || ' powered on', NULL, NULL,
              'host', h.id::text, h.hostname
         FROM host_power_intervals i JOIN hosts h ON h.id = i.host_id, win
        WHERE i.started_at >= win.since

       UNION ALL

       -- 4. ...and going away. "silence" is a WARNING and the other two are not: a host that stopped
       --    beating without anybody stopping it is an incident, while a machine somebody switched
       --    off is the farm working as intended.
       SELECT i.ended_at, 'power',
              CASE i.ended_by WHEN 'silence' THEN 'warning' ELSE 'info' END,
              h.hostname || CASE i.ended_by
                WHEN 'stopped'   THEN ' powered off'
                WHEN 'silence'   THEN ' stopped responding'
                WHEN 'restarted' THEN ' restarted'
                ELSE ' powered off' END,
              CASE i.ended_by WHEN 'silence'
                THEN 'No heartbeat. Billed up to the last beat, so a network partition is '
                     || 'under-counted rather than a stopped machine over-counted.'
                ELSE NULL END,
              NULL,
              'host', h.id::text, h.hostname
         FROM host_power_intervals i JOIN hosts h ON h.id = i.host_id, win
        WHERE i.ended_at IS NOT NULL AND i.ended_at >= win.since

       ORDER BY at DESC
       LIMIT $1`,
      [limit, sinceHours],
    );
    return rows;
  });

  return rows.map((r) => ({
    at: r.at.toISOString(),
    source: r.source as InfraEvent['source'],
    severity: r.severity as InfraEvent['severity'],
    title: r.title,
    detail: r.detail,
    actor: r.actor,
    target: r.target_id
      ? { kind: r.target_kind!, id: r.target_id, label: r.target_label ?? r.target_id }
      : null,
  }));
}
