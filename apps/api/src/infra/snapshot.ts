import { withSystem } from '../db.ts';
import { loadConfig } from '../config.ts';
import { backupState, volumeState } from './storage.ts';

/**
 * Everything the Infrastructure page reads, assembled once.
 *
 * ---------------------------------------------------------------- the rule that shapes this file
 *
 * **NOTHING HERE IS ALLOWED TO SAY "HEALTHY" WHEN IT MEANS "WE HAVE NOT HEARD".**
 *
 * That is not a slogan, it is the specific defect this module exists downstream of. Migration 044
 * put five gauges on a host and `routes/hosts.ts` had to write a paragraph explaining that all five
 * are green on a machine whose disk filled an hour after it stopped reporting. The same trap is
 * everywhere in an operations dashboard: a stale number and a current number look identical, and the
 * stale one is more dangerous because it is reassuring.
 *
 * So every measurement in here travels with its own age, and every status is one of FOUR values,
 * never two:
 *
 *   live        -- measured recently enough to act on
 *   stale       -- real, and old. The number is shown, greyed, with how old it is
 *   unavailable -- we tried and could not reach it. NOT a reading of zero
 *   unknown     -- it has never reported this at all
 *
 * A caller that collapses those four into a boolean has thrown away the only thing that makes the
 * page trustworthy.
 *
 * ---------------------------------------------------------------- where the numbers come from
 *
 * Nothing new is invented. Every fact below already existed somewhere and was unreachable from the
 * product:
 *
 *   `hosts`                  -- state, up_since, heartbeat, cores/memory, quarantine (001, 016, 050)
 *   `hosts` machine columns  -- disk, load, memory and the age of the reading (044, ADR-0031)
 *   `host_power_intervals`   -- what was on, when, and therefore what it cost (054)
 *   `devices` / `sessions`   -- capacity and demand (001)
 *   `metering_events`        -- device-seconds actually consumed, for utilisation (001)
 *   the agent tunnel         -- whether a host is reachable RIGHT NOW (ADR-0011/0037)
 *   `infra/storage.ts`       -- the control plane's own disk and its backups
 *
 * The one thing the control plane still cannot see is a host that is powered off, because a stopped
 * machine has no agent. That is reported as `unavailable` with a reason, never as DOWN-but-fine.
 */

/* ------------------------------------------------------------------------------ freshness */

export type Freshness = 'live' | 'stale' | 'unavailable' | 'unknown';

/**
 * The beat interval the agent uses (`startHeartbeat`'s default), restated here as the unit the
 * thresholds below are expressed in rather than as a coincidence.
 */
const BEAT_MS = 10_000;

/** Three beats. One missed beat is a packet; three is a pattern. */
const LIVE_MS = 3 * BEAT_MS;

/**
 * Nine beats — `HOST_SILENCE_TIMEOUT_MS`, the reaper's own threshold, read from the same place so
 * the page and the reaper cannot disagree about when a host stopped being trustworthy. A host the
 * console calls `stale` while the reaper has already withdrawn its devices would be the console
 * arguing with the system it is supposed to be a window onto.
 */
function silenceMs(): number {
  return Number(process.env.HOST_SILENCE_TIMEOUT_MS ?? 90_000);
}

/**
 * How fresh a heartbeat-derived fact is.
 *
 * `reachable` is the agent tunnel, and it OVERRIDES an aging heartbeat in one direction only: a
 * live socket proves the machine is there right now, which a beat from 40 seconds ago does not. It
 * deliberately does NOT rescue a host past the silence threshold — at that point the reaper has
 * already acted on the fleet, and a page that disagreed would be telling an operator their devices
 * are fine while the allocator refuses to hand them out.
 */
export function freshness(lastBeat: Date | null, reachable: boolean): Freshness {
  if (!lastBeat) return 'unknown';
  const age = Date.now() - lastBeat.getTime();
  if (age >= silenceMs()) return 'unavailable';
  if (reachable || age <= LIVE_MS) return 'live';
  return 'stale';
}

/* ------------------------------------------------------------------------------ shapes */

export interface Measurement<T> {
  value: T | null;
  /** Seconds since this was measured. Null when it has never been measured. */
  ageSeconds: number | null;
  status: Freshness;
}

export interface HostSnapshot {
  id: string;
  hostname: string;
  region: string;
  /** The control plane's own state machine: UP, DOWN, QUARANTINED. */
  state: string;
  /**
   * What an operator means by "is it running" — derived, and deliberately not the same field as
   * `state`. A drained host is RUNNING and QUARANTINED at the same time, and an operations page
   * that showed only one of those would be hiding the expensive half.
   */
  power: 'running' | 'stopped' | 'unknown';
  reachability: Freshness;
  /** True only while the agent's tunnel socket is open. The live-view path depends on this. */
  tunnelConnected: boolean;
  upSince: string | null;
  uptimeSeconds: number | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  protocolVersion: number;
  specs: { cores: number | null; memoryMb: number | null };
  machine: {
    at: string | null;
    ageSeconds: number | null;
    status: Freshness;
    diskUsedPct: number | null;
    diskFreeBytes: number | null;
    diskTotalBytes: number | null;
    load1: number | null;
    loadPerCore: number | null;
    memUsedPct: number | null;
    memAvailableMb: number | null;
    memTotalMb: number | null;
  };
  devices: { total: number; ready: number; allocated: number; quarantined: number; offline: number };
  /**
   * Tenants on this machine RIGHT NOW.
   *
   * On the snapshot rather than derived in the browser, because it is the number a confirmation
   * dialog has to put in front of somebody before they drain or stop a host — "3 sessions are
   * running on this host" — and a count the page computed from a list it happened to have would be
   * a different number from the one the server acts on.
   */
  sessions: { active: number };
  maintenance: { drained: boolean; since: string | null; reason: string | null; source: string | null };
  cost: {
    perHour: number | null;
    sinceUp: number | null;
    today: number | null;
    monthToDate: number | null;
  };
  utilisationPct: number | null;
  alerts: Alert[];
}

export interface Alert {
  severity: 'warning' | 'critical';
  /** Stable identifier, so the console can style and de-duplicate without matching on prose. */
  code: string;
  message: string;
}

export type ComponentStatus = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface HealthComponent {
  id: string;
  label: string;
  status: ComponentStatus;
  /** Why, in one sentence, ALWAYS — including when it is healthy. A green light with no evidence
   *  behind it is the thing this page exists to stop being. */
  detail: string;
}

/* ------------------------------------------------------------------------------ hosts */

interface HostRow {
  id: string; hostname: string; region: string; state: string;
  up_since: Date | null; last_heartbeat_at: Date | null; protocol_version: number;
  cores: number | null; memory_mb: number | null;
  quarantined_at: Date | null; quarantine_reason: string | null; quarantine_source: string | null;
  disk_free_bytes: string | null; disk_total_bytes: string | null; load1: string | null;
  mem_available_mb: number | null; mem_total_mb: number | null; stats_at: Date | null;
  device_count: string; ready_count: string; allocated_count: string;
  quarantined_count: string; offline_count: string; active_sessions: string;
  powered_today_seconds: string | null; powered_month_seconds: string | null;
  device_seconds_today: string | null;
}

/**
 * A silence, in words a person can read at a glance.
 *
 * `Math.round(seconds / 60)` was fine for the case it was written for — a host that missed a few
 * beats — and on the real farm it produced **"No heartbeat for 21310 minutes"** for a laptop that
 * had been switched off for a fortnight. A number that large is not a duration, it is a puzzle, and
 * the alert it is in is one somebody reads while deciding whether to worry.
 */
function silenceFor(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

const pct = (used: number, total: number): number | null =>
  total > 0 ? Math.round((used / total) * 1000) / 10 : null;

const money = (seconds: number | null, hourly: number | null): number | null =>
  seconds === null || hourly === null ? null : Number(((seconds / 3600) * hourly).toFixed(2));

/**
 * Disk that should worry somebody. 85% is where a Cuttlefish reset starts failing on this farm —
 * four instances, a 4 GB snapshot each, plus an app cache `fetchApk` never prunes — and the failure
 * presents as a device problem, so the warning has to arrive before it.
 */
const DISK_WARN_PCT = 85;
const DISK_CRIT_PCT = 93;
/** Load per core. Above 1 the machine is oversubscribed; above 2 it is the binding constraint —
 *  which `docs/RENDER_BASELINE.md` measured this host's CPU to be. */
const LOAD_WARN_PER_CORE = 1.5;
const LOAD_CRIT_PER_CORE = 2.5;
const MEM_WARN_PCT = 88;

export async function hostSnapshots(reachable: (hostId: string) => boolean): Promise<HostSnapshot[]> {
  const cfg = loadConfig();
  const hourly = cfg.hostHourlyCost;

  const rows = await withSystem(async (c) => {
    const { rows } = await c.query<HostRow>(
      `SELECT h.id, h.hostname, h.region, h.state, h.up_since, h.last_heartbeat_at,
              h.protocol_version, h.cores, h.memory_mb,
              h.quarantined_at, h.quarantine_reason, h.quarantine_source,
              h.disk_free_bytes, h.disk_total_bytes, h.load1,
              h.mem_available_mb, h.mem_total_mb, h.stats_at,
              d.device_count, d.ready_count, d.allocated_count,
              d.quarantined_count, d.offline_count, d.active_sessions,
              p.today_seconds  AS powered_today_seconds,
              p.month_seconds  AS powered_month_seconds,
              m.device_seconds AS device_seconds_today
         FROM hosts h
         LEFT JOIN LATERAL (
           SELECT count(*)                                              AS device_count,
                  count(*) FILTER (WHERE dv.state = 'READY')            AS ready_count,
                  count(*) FILTER (WHERE dv.state IN ('RESERVED','SESSION_ACTIVE'))
                                                                        AS allocated_count,
                  count(*) FILTER (WHERE dv.state = 'QUARANTINED')      AS quarantined_count,
                  count(*) FILTER (WHERE dv.state = 'OFFLINE')          AS offline_count,
                  -- The SESSION rows, not the device states. A device in RESERVED is allocated and
                  -- may have no live session behind it yet; what a confirmation dialog has to name
                  -- is the number of tenants who would notice.
                  (SELECT count(*) FROM sessions s
                     JOIN devices d2 ON d2.id = s.device_id
                    WHERE d2.host_id = h.id AND s.state IN ('ACTIVE', 'ALLOCATING'))
                                                                        AS active_sessions
             FROM devices dv WHERE dv.host_id = h.id
         ) d ON true
         -- POWERED TIME, clipped to each window rather than summed whole (054). An interval that
         -- started yesterday and is still open contributes only the part that falls inside today,
         -- which is the difference between a daily cost and a running total wearing its label.
         LEFT JOIN LATERAL (
           SELECT
             COALESCE(SUM(EXTRACT(EPOCH FROM (
               LEAST(COALESCE(i.ended_at, now()), now())
               - GREATEST(i.started_at, date_trunc('day', now()))
             ))) FILTER (WHERE COALESCE(i.ended_at, now()) > date_trunc('day', now())), 0) AS today_seconds,
             COALESCE(SUM(EXTRACT(EPOCH FROM (
               LEAST(COALESCE(i.ended_at, now()), now())
               - GREATEST(i.started_at, date_trunc('month', now()))
             ))) FILTER (WHERE COALESCE(i.ended_at, now()) > date_trunc('month', now())), 0) AS month_seconds
           FROM host_power_intervals i WHERE i.host_id = h.id
         ) p ON true
         -- What tenants actually CONSUMED on this host today, for the utilisation figure. Joined
         -- through devices because a metering row names a device, never a host — a worker that could
         -- name the host would be a worker that could bill another one (migration 008's rule, one
         -- level up).
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(me.quantity), 0) AS device_seconds
             FROM metering_events me
             JOIN devices dv2 ON dv2.id = me.device_id
            WHERE dv2.host_id = h.id
              AND me.kind = 'device_seconds'
              AND me.occurred_at >= date_trunc('day', now())
         ) m ON true
        ORDER BY h.hostname`,
    );
    return rows;
  });

  const now = Date.now();
  return rows.map((h) => {
    const tunnelConnected = reachable(h.id);
    const reach = freshness(h.last_heartbeat_at, tunnelConnected);
    const beatAge = h.last_heartbeat_at
      ? Math.round((now - h.last_heartbeat_at.getTime()) / 1000)
      : null;

    /**
     * RUNNING, and only where there is evidence. `state = 'UP'` alone is not evidence: the reaper
     * writes QUARANTINED, nothing writes DOWN on a graceful stop today, and a row can sit at UP for
     * as long as nobody sweeps it. A host is reported as running when it has been heard from inside
     * the silence window, stopped when the control plane put it DOWN, and `unknown` otherwise —
     * which is the honest answer for a machine somebody switched off in the cloud console.
     */
    /**
     * `DOWN` OUTRANKS A RECENT HEARTBEAT, and the other order was a real defect.
     *
     * Nothing writes `DOWN` except the column default — a host row before its first registration —
     * and a STOP this control plane performed and watched the provider confirm. Both mean the
     * machine is not running. A heartbeat cannot argue with either: a never-registered host has no
     * heartbeat, and a stopped one's last beat is from BEFORE we stopped it.
     *
     * With reachability first, a host stopped from the console read `running` for the thirty seconds
     * its last beat stayed fresh — so the card offered Stop on a machine that was already off, and
     * then offered no way back. Found by stopping the real lab.
     *
     * A beat LIFTS the DOWN rather than overriding it here — see the heartbeat route, which does it
     * the same way it lifts a silence quarantine. That is what keeps this from being sticky.
     */
    const power: HostSnapshot['power'] =
      h.state === 'DOWN' ? 'stopped'
        : reach === 'live' || reach === 'stale' ? 'running'
          : 'unknown';

    /**
     * Uptime is only meaningful while the host is ACTUALLY UP — ADR-0035's point, kept. A stopped
     * machine's `up_since` is the last time it came up, and subtracting it from now would report a
     * VM switched off since Tuesday as having run for four days.
     */
    const uptimeSeconds = power === 'running' && h.up_since
      ? Math.max(0, Math.round((now - h.up_since.getTime()) / 1000))
      : null;

    const statsAgeSeconds = h.stats_at ? Math.round((now - h.stats_at.getTime()) / 1000) : null;
    /**
     * The gauges age SEPARATELY from the heartbeat, and this is the trap migration 044 wrote itself
     * a paragraph about. A host can be beating perfectly while its stats collector has been wedged
     * for an hour; reusing the heartbeat's freshness here would paint an hour-old disk reading green
     * because a different subsystem is healthy.
     */
    const machineStatus: Freshness = h.stats_at === null ? 'unknown'
      : statsAgeSeconds! >= silenceMs() / 1000 ? 'unavailable'
        : statsAgeSeconds! <= (LIVE_MS / 1000) * 6 ? 'live'
          : 'stale';

    const diskFree = h.disk_free_bytes === null ? null : Number(h.disk_free_bytes);
    const diskTotal = h.disk_total_bytes === null ? null : Number(h.disk_total_bytes);
    const diskUsedPct = diskFree !== null && diskTotal !== null && diskTotal > 0
      ? pct(diskTotal - diskFree, diskTotal) : null;
    const load1 = h.load1 === null ? null : Number(h.load1);
    const loadPerCore = load1 !== null && h.cores ? Math.round((load1 / h.cores) * 100) / 100 : null;
    const memUsedPct = h.mem_available_mb !== null && h.mem_total_mb
      ? pct(h.mem_total_mb - h.mem_available_mb, h.mem_total_mb) : null;

    const poweredToday = h.powered_today_seconds === null ? null : Number(h.powered_today_seconds);
    const poweredMonth = h.powered_month_seconds === null ? null : Number(h.powered_month_seconds);
    const deviceSecondsToday = h.device_seconds_today === null
      ? null : Number(h.device_seconds_today);

    /**
     * UTILISATION — device-seconds sold, over device-seconds the farm paid for.
     *
     * The denominator is powered time MULTIPLIED BY the device count, because that is what was
     * bought: a four-device host powered for an hour offered four device-hours whether or not
     * anybody took them. Dividing by powered time alone would report a host with one busy device
     * out of four as fully utilised, which is exactly backwards for a page whose job is finding
     * machines that are on and idle.
     *
     * Null rather than zero when the host has not been on today. "Nothing ran because the machine
     * was off" is not underutilisation, and colouring it as such would put a permanent red number
     * next to the hosts that are costing nothing.
     */
    const capacitySeconds = poweredToday !== null && Number(h.device_count) > 0
      ? poweredToday * Number(h.device_count) : null;
    const utilisationPct = capacitySeconds && capacitySeconds > 0 && deviceSecondsToday !== null
      ? Math.min(100, Math.round((deviceSecondsToday / capacitySeconds) * 1000) / 10)
      : null;

    const alerts: Alert[] = [];
    if (reach === 'unavailable') {
      alerts.push({
        severity: 'critical', code: 'host-silent',
        message: beatAge === null
          ? 'This host has never sent a heartbeat.'
          : `No heartbeat for ${silenceFor(beatAge)}. Its devices have left the pool.`,
      });
    } else if (reach === 'stale') {
      alerts.push({
        severity: 'warning', code: 'host-slow',
        message: `Last heartbeat ${beatAge}s ago. Expected every ${BEAT_MS / 1000}s.`,
        // Seconds, spelled out, because this alert only ever fires inside the silence window — the
        // one place where the difference between 12 and 53 seconds is the whole message.
      });
    }
    if (machineStatus === 'unavailable' || machineStatus === 'unknown') {
      alerts.push({
        severity: 'warning', code: 'machine-stats-stale',
        message: machineStatus === 'unknown'
          ? 'This host has never reported disk, load or memory.'
          : `Disk, load and memory were last measured ${silenceFor(statsAgeSeconds ?? 0)} ago, `
            + 'so the figures below are not current.',
      });
    }
    // Gauges are only worth an alert while the reading is current — see `machineStatus`. A full disk
    // reported an hour ago may have been cleared fifty minutes ago.
    if (machineStatus === 'live' || machineStatus === 'stale') {
      if (diskUsedPct !== null && diskUsedPct >= DISK_CRIT_PCT) {
        alerts.push({ severity: 'critical', code: 'disk-full',
          message: `Disk is ${diskUsedPct}% full. Device resets fail before it reaches 100%.` });
      } else if (diskUsedPct !== null && diskUsedPct >= DISK_WARN_PCT) {
        alerts.push({ severity: 'warning', code: 'disk-high',
          message: `Disk is ${diskUsedPct}% full.` });
      }
      if (loadPerCore !== null && loadPerCore >= LOAD_CRIT_PER_CORE) {
        alerts.push({ severity: 'critical', code: 'load-high',
          message: `Load is ${loadPerCore} per core. Sessions on this host will be slow.` });
      } else if (loadPerCore !== null && loadPerCore >= LOAD_WARN_PER_CORE) {
        alerts.push({ severity: 'warning', code: 'load-elevated',
          message: `Load is ${loadPerCore} per core.` });
      }
      if (memUsedPct !== null && memUsedPct >= MEM_WARN_PCT) {
        alerts.push({ severity: 'warning', code: 'memory-high',
          message: `Memory is ${memUsedPct}% used.` });
      }
    }
    if (h.quarantine_source === 'operator') {
      alerts.push({ severity: 'warning', code: 'drained',
        message: 'This host is drained: it is powered on and costing money, and the allocator will '
          + 'not put new sessions on it.' });
    }
    if (power === 'running' && !tunnelConnected && reach !== 'unavailable') {
      /**
       * THE FAILURE `mfarm_tunnel_hosts_connected` WAS ADDED FOR, finally on a screen. A host can
       * beat over plain HTTPS while its tunnel is down, so the fleet reads perfectly healthy on a
       * farm where every live view and every automation command fails.
       */
      alerts.push({ severity: 'warning', code: 'tunnel-down',
        message: 'The agent is beating but its tunnel is not connected. Live view and automation '
          + 'cannot reach this host.' });
    }

    return {
      id: h.id,
      hostname: h.hostname,
      region: h.region,
      state: h.state,
      power,
      reachability: reach,
      tunnelConnected,
      upSince: h.up_since ? h.up_since.toISOString() : null,
      uptimeSeconds,
      lastHeartbeatAt: h.last_heartbeat_at ? h.last_heartbeat_at.toISOString() : null,
      heartbeatAgeSeconds: beatAge,
      protocolVersion: h.protocol_version,
      specs: { cores: h.cores, memoryMb: h.memory_mb },
      machine: {
        at: h.stats_at ? h.stats_at.toISOString() : null,
        ageSeconds: statsAgeSeconds,
        status: machineStatus,
        diskUsedPct, diskFreeBytes: diskFree, diskTotalBytes: diskTotal,
        load1, loadPerCore,
        memUsedPct, memAvailableMb: h.mem_available_mb, memTotalMb: h.mem_total_mb,
      },
      devices: {
        total: Number(h.device_count ?? 0),
        ready: Number(h.ready_count ?? 0),
        allocated: Number(h.allocated_count ?? 0),
        quarantined: Number(h.quarantined_count ?? 0),
        offline: Number(h.offline_count ?? 0),
      },
      sessions: { active: Number(h.active_sessions ?? 0) },
      maintenance: {
        drained: h.quarantine_source === 'operator',
        since: h.quarantined_at ? h.quarantined_at.toISOString() : null,
        reason: h.quarantine_reason,
        source: h.quarantine_source,
      },
      cost: {
        perHour: hourly,
        sinceUp: money(uptimeSeconds, hourly),
        today: money(poweredToday, hourly),
        monthToDate: money(poweredMonth, hourly),
      },
      utilisationPct,
      alerts,
    };
  });
}

/* ------------------------------------------------------------------------------ the fleet */

export interface FleetSnapshot {
  devices: {
    total: number; ready: number; allocated: number; quarantined: number;
    offline: number; preparing: number; cleaning: number;
  };
  sessions: { active: number; queued: number; oldestQueuedSeconds: number | null };
  /** Allocated devices over devices that could be allocated. The farm's instantaneous load. */
  loadPct: number | null;
}

export async function fleetSnapshot(): Promise<FleetSnapshot> {
  return withSystem(async (c) => {
    const d = await c.query<{ state: string; n: string }>(
      `SELECT state::text AS state, count(*)::text AS n FROM devices GROUP BY 1`);
    const s = await c.query<{ state: string; n: string }>(
      `SELECT state::text AS state, count(*)::text AS n FROM sessions GROUP BY 1`);
    const q = await c.query<{ oldest: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::text AS oldest
         FROM sessions WHERE state = 'QUEUED'`);

    const byState = new Map(d.rows.map((r) => [r.state, Number(r.n)]));
    const at = (k: string) => byState.get(k) ?? 0;
    const total = [...byState.values()].reduce((a, b) => a + b, 0);
    const allocated = at('RESERVED') + at('SESSION_ACTIVE');
    const ready = at('READY');
    // The denominator is capacity that COULD serve somebody: ready plus already-allocated. A
    // quarantined device is not idle capacity being wasted, it is capacity that is gone, and
    // including it would make a farm with one broken device look permanently underloaded.
    const usable = ready + allocated;

    const sess = new Map(s.rows.map((r) => [r.state, Number(r.n)]));
    return {
      devices: {
        total, ready, allocated,
        quarantined: at('QUARANTINED'),
        offline: at('OFFLINE'),
        preparing: at('PREPARING'),
        cleaning: at('CLEANING'),
      },
      sessions: {
        active: (sess.get('ACTIVE') ?? 0) + (sess.get('ALLOCATING') ?? 0),
        queued: sess.get('QUEUED') ?? 0,
        oldestQueuedSeconds: q.rows[0]?.oldest === null || q.rows[0]?.oldest === undefined
          ? null : Math.round(Number(q.rows[0].oldest)),
      },
      loadPct: usable > 0 ? Math.round((allocated / usable) * 1000) / 10 : null,
    };
  });
}

/* ------------------------------------------------------------------------------ cost */

export interface CostSnapshot {
  rate: { hourly: number; currency: string } | null;
  /** What the farm is burning per hour RIGHT NOW, across everything powered on. */
  runningPerHour: number | null;
  today: number | null;
  monthToDate: number | null;
  /**
   * The month's projection, and the assumption it rests on, stated. An estimate that does not say
   * what it assumes is a number people quote back at you.
   */
  estimatedMonth: { value: number | null; basis: string };
  /** Cost per day over the trailing fortnight, oldest first, for the trend. */
  trend: Array<{ date: string; cost: number | null; poweredHours: number }>;
  /** Hosts that were on and barely used. The page's one cost-saving recommendation. */
  idle: Array<{ hostId: string; hostname: string; poweredHours: number; utilisationPct: number | null; wastedCost: number | null }>;
}

/** A host under this much utilisation over the trailing day is worth a look. */
const IDLE_UTILISATION_PCT = 5;
/** ...but only if it was on long enough for the number to mean anything. */
const IDLE_MIN_HOURS = 2;

export async function costSnapshot(hosts: HostSnapshot[]): Promise<CostSnapshot> {
  const cfg = loadConfig();
  const hourly = cfg.hostHourlyCost;
  const rate = hourly === null ? null : { hourly, currency: cfg.costCurrency };

  const { trend, totals } = await withSystem(async (c) => {
    /**
     * POWERED HOURS PER DAY over the trailing fortnight.
     *
     * `generate_series` on the LEFT so a day on which nothing was powered appears as a zero instead
     * of vanishing. A trend line that silently skips its cheapest days is a trend line that slopes
     * the wrong way.
     */
    const t = await c.query<{ day: Date; seconds: string }>(
      `WITH days AS (
         SELECT generate_series(date_trunc('day', now()) - interval '13 days',
                                date_trunc('day', now()), interval '1 day') AS day
       )
       SELECT d.day,
              COALESCE(SUM(EXTRACT(EPOCH FROM (
                LEAST(COALESCE(i.ended_at, now()), d.day + interval '1 day')
                - GREATEST(i.started_at, d.day)
              ))), 0)::text AS seconds
         FROM days d
         LEFT JOIN host_power_intervals i
                ON i.started_at < d.day + interval '1 day'
               AND COALESCE(i.ended_at, now()) > d.day
        GROUP BY d.day ORDER BY d.day`);

    const tot = await c.query<{ today: string; month: string }>(
      `SELECT
         COALESCE(SUM(EXTRACT(EPOCH FROM (
           LEAST(COALESCE(i.ended_at, now()), now()) - GREATEST(i.started_at, date_trunc('day', now()))
         ))) FILTER (WHERE COALESCE(i.ended_at, now()) > date_trunc('day', now())), 0)::text AS today,
         COALESCE(SUM(EXTRACT(EPOCH FROM (
           LEAST(COALESCE(i.ended_at, now()), now()) - GREATEST(i.started_at, date_trunc('month', now()))
         ))) FILTER (WHERE COALESCE(i.ended_at, now()) > date_trunc('month', now())), 0)::text AS month
       FROM host_power_intervals i`);

    return { trend: t.rows, totals: tot.rows[0] };
  });

  const running = hosts.filter((h) => h.power === 'running').length;
  const todaySeconds = Number(totals?.today ?? 0);
  const monthSeconds = Number(totals?.month ?? 0);

  /**
   * THE PROJECTION, and it is deliberately the conservative one: what the month costs if the farm
   * carries on exactly as it is. The alternative — extrapolating the month-to-date average across
   * the remaining days — reads lower on the day somebody leaves a host on overnight, which is the
   * one day the number needs to be alarming.
   */
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const hoursLeft = (daysInMonth - now.getDate()) * 24 + (24 - now.getHours());
  const runningPerHour = hourly === null ? null : Number((running * hourly).toFixed(2));

  return {
    rate,
    runningPerHour,
    today: money(todaySeconds, hourly),
    monthToDate: money(monthSeconds, hourly),
    estimatedMonth: {
      value: hourly === null ? null
        : Number(((monthSeconds / 3600) * hourly + hoursLeft * running * hourly).toFixed(2)),
      basis: running === 0
        ? 'Nothing is powered on, so this is the month to date and nothing further.'
        : `Assumes the ${running} host${running === 1 ? '' : 's'} that ${running === 1 ? 'is' : 'are'} `
          + 'powered on now stay on for the rest of the month.',
    },
    trend: trend.map((r) => {
      const seconds = Number(r.seconds);
      return {
        date: r.day.toISOString().slice(0, 10),
        poweredHours: Math.round((seconds / 3600) * 10) / 10,
        cost: money(seconds, hourly),
      };
    }),
    idle: hosts
      .filter((h) => {
        const poweredHours = h.cost.today !== null && hourly
          ? h.cost.today / hourly
          : null;
        return poweredHours !== null && poweredHours >= IDLE_MIN_HOURS
          && h.utilisationPct !== null && h.utilisationPct < IDLE_UTILISATION_PCT;
      })
      .map((h) => {
        const poweredHours = hourly ? (h.cost.today ?? 0) / hourly : 0;
        return {
          hostId: h.id,
          hostname: h.hostname,
          poweredHours: Math.round(poweredHours * 10) / 10,
          utilisationPct: h.utilisationPct,
          // What was spent on the part of the day nothing was using. Not a promise of a saving —
          // a device has to be ready before somebody can ask for it — but it is the number that
          // makes "stop it when you are done" concrete.
          wastedCost: hourly === null ? null
            : Number((poweredHours * hourly * (1 - (h.utilisationPct ?? 0) / 100)).toFixed(2)),
        };
      }),
  };
}

/* ------------------------------------------------------------------------------ health */

/**
 * The six lights, and the sentence under each.
 *
 * WHY EVERY COMPONENT CARRIES A DETAIL EVEN WHEN GREEN. An operations page whose healthy state is
 * a word with nothing behind it teaches its reader that the word is decoration, and then the word
 * does not work on the day it turns amber. Each line below says what was measured and when.
 */
/**
 * A few names, and then a count.
 *
 * A COMPONENT DETAIL IS A SENTENCE, NOT A LIST. The first version of this joined every matching
 * hostname, which reads fine with two hosts and turned the Hosts panel into a four-hundred-line
 * wall of identifiers the first time it met a database with a lot of them in it. The panel's job is
 * to say what is wrong in one glance; WHICH hosts is the Hosts section, one click away.
 */
function someOf(names: string[], limit = 3): string {
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`;
}

export async function healthComponents(
  hosts: HostSnapshot[],
  fleet: FleetSnapshot,
  dbLatencyMs: number | null,
): Promise<HealthComponent[]> {
  const cfg = loadConfig();
  const out: HealthComponent[] = [];

  /* -------- hosts */
  const running = hosts.filter((h) => h.power === 'running');
  const silent = hosts.filter((h) => h.reachability === 'unavailable');
  const drained = hosts.filter((h) => h.maintenance.drained);
  out.push({
    id: 'hosts', label: 'Hosts',
    status: hosts.length === 0 ? 'unknown'
      : silent.length === hosts.length ? 'down'
        : silent.length > 0 || drained.length > 0 ? 'degraded' : 'healthy',
    detail: hosts.length === 0
      ? 'No host has ever registered with this control plane.'
      : [
          `${running.length} of ${hosts.length} powered on`,
          silent.length ? `${someOf(silent.map((h) => h.hostname))} not answering` : null,
          drained.length ? `${someOf(drained.map((h) => h.hostname))} drained for maintenance` : null,
        ].filter(Boolean).join(' · '),
  });

  /* -------- the agents, which are NOT the hosts */
  const beating = hosts.filter((h) => h.reachability === 'live');
  const tunnelless = running.filter((h) => !h.tunnelConnected);
  out.push({
    id: 'agents', label: 'Worker agents',
    status: running.length === 0 ? 'unknown'
      : beating.length === 0 ? 'down'
        : tunnelless.length > 0 || beating.length < running.length ? 'degraded' : 'healthy',
    detail: running.length === 0
      ? 'Nothing is powered on, so no agent is expected to be reporting.'
      : tunnelless.length
        // Named separately from the beat because they fail independently, and this combination is
        // the one that reads healthiest while being broken — see `mfarm_tunnel_hosts_connected`.
        ? `${beating.length} of ${running.length} beating; ${tunnelless.length} with no tunnel, `
          + 'so live view and automation cannot reach them'
        : `${beating.length} of ${running.length} beating within the last 30 seconds`,
  });

  /* -------- the database */
  out.push({
    id: 'database', label: 'Database',
    status: dbLatencyMs === null ? 'down' : dbLatencyMs > 1000 ? 'degraded' : 'healthy',
    detail: dbLatencyMs === null
      ? 'The control plane could not complete a query. Everything on this page is stale.'
      : `Answering in ${Math.round(dbLatencyMs)}ms.`,
  });

  /* -------- the device farm */
  const usable = fleet.devices.ready + fleet.devices.allocated;
  out.push({
    id: 'devices', label: 'Device farm',
    status: fleet.devices.total === 0 ? 'unknown'
      : usable === 0 ? 'down'
        : fleet.devices.quarantined > 0 || fleet.sessions.queued > 0 ? 'degraded' : 'healthy',
    detail: fleet.devices.total === 0
      ? 'No devices are registered.'
      : [
          `${fleet.devices.ready} ready, ${fleet.devices.allocated} in use of ${fleet.devices.total}`,
          fleet.devices.quarantined ? `${fleet.devices.quarantined} quarantined` : null,
          fleet.sessions.queued
            ? `${fleet.sessions.queued} waiting${fleet.sessions.oldestQueuedSeconds
                ? ` (longest ${Math.round(fleet.sessions.oldestQueuedSeconds / 60)}m)` : ''}`
            : null,
        ].filter(Boolean).join(' · '),
  });

  /* -------- the network between here and the hosts */
  out.push({
    id: 'network', label: 'Network',
    status: running.length === 0 ? 'unknown'
      : tunnelless.length === running.length ? 'down'
        : tunnelless.length > 0 ? 'degraded' : 'healthy',
    detail: running.length === 0
      ? 'No host is powered on, so there is nothing to be connected to.'
      : `${running.length - tunnelless.length} of ${running.length} agent tunnels connected.`,
  });

  /* -------- storage, on BOTH sides */
  const backups = await backupState();
  const vol = await volumeState(cfg.artifactDir);
  const worstHostDisk = hosts
    .filter((h) => h.machine.status === 'live' && h.machine.diskUsedPct !== null)
    .reduce<{ pct: number; name: string } | null>(
      (w, h) => (!w || h.machine.diskUsedPct! > w.pct
        ? { pct: h.machine.diskUsedPct!, name: h.hostname } : w), null);
  const cpDiskPct = vol.freeBytes !== null && vol.totalBytes !== null && vol.totalBytes > 0
    ? pct(vol.totalBytes - vol.freeBytes, vol.totalBytes) : null;
  /**
   * `-1` IS NOT AN AGE, it is "we cannot see the backups" — `infra/storage.ts` preserves that
   * convention from the metrics it shares, and collapsing it into a large number here would turn a
   * missing mount into a reassuring "backups are old" and hide it behind the same amber light.
   */
  const backupsUnseen = backups.ageSeconds < 0;
  const backupsOld = !backupsUnseen && backups.ageSeconds > 24 * 3600;
  out.push({
    id: 'storage', label: 'Storage',
    status: (cpDiskPct !== null && cpDiskPct >= DISK_CRIT_PCT)
      || (worstHostDisk && worstHostDisk.pct >= DISK_CRIT_PCT) ? 'down'
      : backupsUnseen ? 'unknown'
        : (cpDiskPct !== null && cpDiskPct >= DISK_WARN_PCT)
          || (worstHostDisk && worstHostDisk.pct >= DISK_WARN_PCT) || backupsOld ? 'degraded'
          : 'healthy',
    detail: [
      cpDiskPct === null ? 'control plane disk unmeasurable' : `control plane disk ${cpDiskPct}% used`,
      worstHostDisk ? `${worstHostDisk.name} ${worstHostDisk.pct}% used` : null,
      backupsUnseen
        ? 'backups cannot be read'
        : `newest backup ${Math.round(backups.ageSeconds / 3600)}h old`,
      backups.offsiteAgeSeconds < 0 ? 'none confirmed off-box' : null,
    ].filter(Boolean).join(' · '),
  });

  return out;
}

/** The single word at the top. The worst component wins; `unknown` never masquerades as healthy. */
export function overallHealth(components: HealthComponent[]): ComponentStatus {
  if (components.some((c) => c.status === 'down')) return 'down';
  if (components.some((c) => c.status === 'degraded')) return 'degraded';
  // Every light unknown means the page has measured nothing, which is not a healthy farm — it is a
  // farm nobody can see. Reported as such rather than rounded up.
  if (components.every((c) => c.status === 'unknown')) return 'unknown';
  return components.some((c) => c.status === 'unknown') ? 'degraded' : 'healthy';
}

/** How long the database took to answer one trivial query, or null if it did not. */
export async function probeDatabase(): Promise<number | null> {
  const started = Date.now();
  try {
    await withSystem((c) => c.query('SELECT 1'));
    return Date.now() - started;
  } catch {
    return null;
  }
}
