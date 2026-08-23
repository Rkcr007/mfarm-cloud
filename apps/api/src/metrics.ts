/**
 * Prometheus metrics: a tiny registry, and the fleet collectors that fill it at scrape time.
 *
 * WHY THERE IS NO CLIENT LIBRARY HERE. `prom-client` would be one more dependency on a control
 * plane whose entire runtime is fastify + pg, and it would buy default process metrics we do not
 * alert on. What we actually need is a text encoder and three SQL queries. The exposition format is
 * a stable, documented text protocol; implementing it is smaller than the code that would configure
 * a library to do the same thing.
 *
 * WHY THE OWNER POOL. Every gauge below is fleet-wide: devices across all orgs, sessions across all
 * orgs, hosts. `appPool` cannot produce them — `mfarm_app` is bound by RLS and with no `app.org_id`
 * set every policy matches zero rows, so the collectors would report a perfectly healthy fleet of
 * nothing. They must run on `systemPool`.
 *
 * WHICH IS EXACTLY WHY /metrics IS NOT ON THE TENANT LISTENER. This data crosses every tenant
 * boundary the rest of the codebase spends its effort defending. It is served from a second listener
 * bound to loopback (see `metrics-server.ts`), never from the port that carries the WebDriver hub.
 */
import { appPool, systemPool, withSystem } from './db.ts';

// ---------------------------------------------------------------- registry primitives

export type LabelValues = Record<string, string>;

/**
 * A cap on distinct label combinations per metric family.
 *
 * Not paranoia: a label whose value is caller-controlled — a raw URL instead of a route pattern, a
 * device id, an error message — turns a Map into an unbounded memory leak that only shows up weeks
 * later as an OOM in a process that is otherwise idle. Every label used here is bounded by design;
 * this exists so that a future one that is NOT bounded fails as a visible dropped-series counter
 * rather than as a restart loop nobody can explain.
 */
const MAX_SERIES_PER_METRIC = 2_000;

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** Backslash, newline and double quote, in that order — escaping the quote first would then have
 *  its own backslash escaped by the next pass, producing `\\"` for what should be `\"`. */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** `# HELP` is a single line: a newline in the text truncates the family and silently breaks the
 *  parser's view of everything after it. */
function escapeHelp(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, ' ');
}

function renderLabels(labelNames: readonly string[], values: readonly string[]): string {
  if (labelNames.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < labelNames.length; i++) {
    parts.push(`${labelNames[i]}="${escapeLabelValue(values[i] ?? '')}"`);
  }
  return `{${parts.join(',')}}`;
}

/** A float rendered the way the exposition format wants it. `Infinity` is `+Inf`, and `1e21`
 *  stringifies as `1e+21` which the parser accepts; `NaN` is legal too and means "no value". */
function renderValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

abstract class Metric {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  /** Keyed by the label values joined with a NUL — a separator no label value can contain, so
   *  `{a="x",b="y"}` and `{a="xy",b=""}` cannot collide. */
  protected readonly series = new Map<string, { values: string[]; state: SeriesState }>();
  protected dropped = 0;

  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid Prometheus metric name.`);
    for (const l of labelNames) {
      if (!NAME_RE.test(l)) throw new Error(`"${l}" is not a valid Prometheus label name.`);
    }
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  abstract readonly type: 'counter' | 'gauge' | 'histogram';
  protected abstract newState(): SeriesState;
  protected abstract renderSeries(values: readonly string[], state: SeriesState): string[];

  /** Missing labels are the empty string rather than an error: a metric with a label the caller
   *  forgot is still worth having, and throwing from an instrumentation call site would let a
   *  counter take down the request it was counting. */
  protected slot(labels: LabelValues): SeriesState | null {
    const values = this.labelNames.map((n) => labels[n] ?? '');
    const key = values.join('\0');
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_SERIES_PER_METRIC) {
        this.dropped++;
        return null;
      }
      entry = { values, state: this.newState() };
      this.series.set(key, entry);
    }
    return entry.state;
  }

  droppedSeries(): number {
    return this.dropped;
  }

  /** Gauges sampled from the database call this before re-setting: a device state that no longer
   *  exists must stop being reported, not linger at its last value forever. */
  reset(): void {
    this.series.clear();
  }

  render(): string {
    // An unlabelled metric that has never been touched still gets its zero.
    //
    // Without this, `mfarm_reaper_failures_total` and `mfarm_scrape_errors_total` are ABSENT until
    // the first failure — and an absent series is not a zero. `increase(...) > 0` cannot fire on
    // one, `absent()` alerts on it as if the whole target were gone, and a dashboard panel reads
    // "No data" for a farm that is working perfectly. The zero has to be published.
    //
    // Done lazily rather than in the constructor because `newState()` is implemented by the
    // subclass and would run before the subclass's own fields exist — Histogram's buckets are
    // assigned after `super()` returns.
    if (this.labelNames.length === 0 && this.series.size === 0) {
      this.series.set('', { values: [], state: this.newState() });
    }
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`];
    for (const { values, state } of this.series.values()) {
      lines.push(...this.renderSeries(values, state));
    }
    return lines.join('\n');
  }
}

type SeriesState = { v: number } | { buckets: number[]; sum: number; count: number };

export class Counter extends Metric {
  readonly type = 'counter' as const;
  protected newState(): SeriesState {
    return { v: 0 };
  }
  inc(labels: LabelValues = {}, n = 1): void {
    const s = this.slot(labels);
    if (s && 'v' in s) s.v += n;
  }
  protected renderSeries(values: readonly string[], state: SeriesState): string[] {
    if (!('v' in state)) return [];
    return [`${this.name}${renderLabels(this.labelNames, values)} ${renderValue(state.v)}`];
  }
}

export class Gauge extends Metric {
  readonly type = 'gauge' as const;
  protected newState(): SeriesState {
    return { v: 0 };
  }
  set(labels: LabelValues, v: number): void {
    const s = this.slot(labels);
    if (s && 'v' in s) s.v = v;
  }
  protected renderSeries(values: readonly string[], state: SeriesState): string[] {
    if (!('v' in state)) return [];
    return [`${this.name}${renderLabels(this.labelNames, values)} ${renderValue(state.v)}`];
  }
}

/** Seconds. Spread wide on purpose: the interesting half of an API latency distribution is under
 *  100ms and the interesting half of a reaper sweep is over a second. */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export class Histogram extends Metric {
  readonly type = 'histogram' as const;
  private readonly buckets: readonly number[];

  constructor(name: string, help: string, labelNames: readonly string[] = [], buckets: readonly number[] = DEFAULT_BUCKETS) {
    super(name, help, labelNames);
    this.buckets = [...buckets].sort((a, b) => a - b);
    if (labelNames.includes('le')) {
      throw new Error(`Histogram "${name}" cannot take a label called "le" — it is the bucket boundary.`);
    }
  }

  protected newState(): SeriesState {
    return { buckets: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
  }

  observe(labels: LabelValues, seconds: number): void {
    const s = this.slot(labels);
    if (!s || !('buckets' in s)) return;
    s.sum += seconds;
    s.count++;
    // Cumulative: every bucket counts everything at or below its boundary, which is what `le` means.
    for (let i = 0; i < this.buckets.length; i++) {
      if (seconds <= this.buckets[i]!) s.buckets[i]!++;
    }
  }

  protected renderSeries(values: readonly string[], state: SeriesState): string[] {
    if (!('buckets' in state)) return [];
    const lines: string[] = [];
    const base = [...values];
    for (let i = 0; i < this.buckets.length; i++) {
      lines.push(
        `${this.name}_bucket${renderLabels([...this.labelNames, 'le'], [...base, String(this.buckets[i])])} ` +
          renderValue(state.buckets[i]!),
      );
    }
    // +Inf is mandatory and must equal _count, or the parser rejects the histogram outright.
    lines.push(`${this.name}_bucket${renderLabels([...this.labelNames, 'le'], [...base, '+Inf'])} ${renderValue(state.count)}`);
    lines.push(`${this.name}_sum${renderLabels(this.labelNames, base)} ${renderValue(state.sum)}`);
    lines.push(`${this.name}_count${renderLabels(this.labelNames, base)} ${renderValue(state.count)}`);
    return lines;
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];

  register<T extends Metric>(m: T): T {
    if (this.metrics.some((x) => x.name === m.name)) {
      throw new Error(`Metric "${m.name}" is already registered.`);
    }
    this.metrics.push(m);
    return m;
  }

  /** The whole exposition, one family per block. A trailing newline is required by the format. */
  render(): string {
    return this.metrics.map((m) => m.render()).join('\n') + '\n';
  }

  totalDroppedSeries(): number {
    return this.metrics.reduce((n, m) => n + m.droppedSeries(), 0);
  }

  /** Tests only. The registry is process-wide state and a suite that shares it across cases reads
   *  another case's counters. */
  clear(): void {
    this.metrics.length = 0;
  }
}

export const registry = new Registry();

// ---------------------------------------------------------------- the metrics themselves

const g = (name: string, help: string, labels: readonly string[] = []) =>
  registry.register(new Gauge(name, help, labels));
const c = (name: string, help: string, labels: readonly string[] = []) =>
  registry.register(new Counter(name, help, labels));

/** Every value `device_state` can take. Enumerated here rather than derived from what happens to be
 *  in the table, because a gauge that DISAPPEARS when its count reaches zero is the specific failure
 *  this whole file exists to avoid: `mfarm_devices{state="READY"} == 0` never fires if the series is
 *  absent, so the alert for "no device is allocatable" would be silent at exactly the moment it
 *  matters. Emitting an explicit zero keeps the series alive. Same reasoning for sessions and hosts.
 *
 *  Kept in sync with `001_init.sql` by `metrics.test.ts`, which reads the enum out of the database. */
export const DEVICE_STATES = [
  'OFFLINE', 'BOOTING', 'READY', 'RESERVED', 'SESSION_ACTIVE', 'CLEANING', 'QUARANTINED', 'EVICTED',
] as const;
export const SESSION_STATES = ['QUEUED', 'ALLOCATING', 'ACTIVE', 'ENDING', 'ENDED', 'FAILED'] as const;
export const HOST_STATES = ['UP', 'DRAINING', 'QUARANTINED', 'DOWN'] as const;

// --- fleet gauges, sampled from Postgres at scrape time -----------------------------------------

const devices = g('mfarm_devices', 'Devices by state and placement.', ['state', 'region', 'platform', 'tier']);

const cleaningAge = g(
  'mfarm_device_cleaning_age_seconds_max',
  'Age of the longest-running snapshot restore. A reset that fails leaves its device in CLEANING ' +
    'forever — by design, because a device must never return to READY unconfirmed — so this rising ' +
    'without bound IS the reset-failure signal.',
);

const sessions = g('mfarm_sessions', 'Sessions by state.', ['state']);

const queueOldest = g(
  'mfarm_session_queue_oldest_seconds',
  'How long the oldest QUEUED session has been waiting. At two devices, contention is the dominant ' +
    'user-visible problem and this is its measure.',
);

const hosts = g('mfarm_hosts', 'Worker hosts by state.', ['state']);

const hostHeartbeat = g(
  'mfarm_host_last_heartbeat_timestamp_seconds',
  'Unix time of a host\'s last heartbeat; 0 if it has registered and never beaten. A timestamp ' +
    'rather than an age so that "never" is expressible — an age gauge has to invent a number for it, ' +
    'and every invented number is either a false alert or a silent one.',
  ['hostname', 'region'],
);

const devicesTotal = g('mfarm_devices_total', 'Devices in the fleet, all states.');

// --- process and pool ---------------------------------------------------------------------------

const buildInfo = g('mfarm_build_info', 'Always 1. Labels carry the versions.', ['version', 'node']);
const uptime = g('mfarm_process_uptime_seconds', 'Seconds since this process started.');
const rss = g('mfarm_process_resident_memory_bytes', 'Resident set size.');
const heapUsed = g('mfarm_process_heap_used_bytes', 'V8 heap in use.');

const poolConns = g(
  'mfarm_pg_pool_connections',
  'Connections per pool by state. `waiting` above zero means requests are queued for a connection, ' +
    'which is the shape of every pool-exhaustion incident before it becomes a timeout.',
  ['pool', 'state'],
);

// --- counters, accumulated in-process -----------------------------------------------------------

export const httpRequests = c(
  'mfarm_http_requests_total',
  'HTTP responses served. `route` is the ROUTE PATTERN, never the URL — labelling by URL puts a ' +
    'session uuid in a label and makes the series count unbounded.',
  ['method', 'route', 'status'],
);

export const httpDuration = registry.register(
  new Histogram('mfarm_http_request_duration_seconds', 'Request latency.', ['method', 'route']),
);

export const reaperRuns = c('mfarm_reaper_runs_total', 'Reaper sweeps that completed.');
export const reaperFailures = c(
  'mfarm_reaper_failures_total',
  'Reaper sweeps that threw. The reaper is what expires abandoned sessions and promotes queued ' +
    'ones; it failing is invisible in every other signal, because nothing it does has a caller.',
);
export const reaperExpired = c('mfarm_reaper_sessions_expired_total', 'Sessions expired by the reaper.');
export const reaperPromoted = c('mfarm_reaper_sessions_promoted_total', 'Queued sessions promoted by the reaper.');
export const reaperDuration = registry.register(
  new Histogram('mfarm_reaper_duration_seconds', 'Reaper sweep duration.', [], [0.01, 0.05, 0.1, 0.5, 1, 5, 15]),
);

/**
 * Hosts that came back from a silence quarantine on their own (migration 016).
 *
 * Worth a counter rather than a log line alone: a steady trickle means hosts keep going silent long
 * enough to be reaped and then returning, which is a network or a supervisor problem that recovery
 * now hides. Zero after a deploy that includes 016 would mean the clear is not firing.
 */
export const hostsRecovered = c(
  'mfarm_hosts_recovered_total',
  'Hosts whose silence quarantine was cleared by a heartbeat.',
);

export const workerResets = c(
  'mfarm_worker_resets_total',
  'Reset completions reported by workers. `accepted="false"` means a stale fence or another host\'s ' +
    'device — expected occasionally after a partition, alarming as a rate.',
  ['accepted'],
);

export const appActions = c(
  'mfarm_app_actions_total',
  'App installs, launches and uninstalls reported by workers, by outcome. `failed` is the app or the ' +
    'device — the person who asked for it sees the reason. `ignored` means the action was not this ' +
    "host's, or had already been recorded, and a sustained rate of it is a worker re-sending " +
    'confirmations it never gets credit for.',
  ['outcome'],
);

export const meteringEvents = c(
  'mfarm_metering_events_total',
  'Metering events by outcome. `rejected` means a host reported usage for a session that is not on ' +
    'it, which is either an agent bug or a host reaching past its own hardware.',
  ['outcome'],
);

export const scrapes = c('mfarm_scrape_total', 'Metrics scrapes served.');
export const scrapeErrors = c(
  'mfarm_scrape_errors_total',
  'Scrapes where the fleet query failed. Non-zero means the gauges above are stale, which otherwise ' +
    'looks exactly like a fleet that has stopped changing.',
);
const scrapeDuration = registry.register(
  new Histogram('mfarm_scrape_duration_seconds', 'Time to collect one scrape.', [], [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 2]),
);

/**
 * Age of the newest backup on disk, in seconds. `-1` when the directory cannot be read at all.
 *
 * THE GAP THIS CLOSES was listed in HANDOFF as a known one: the backup sidecar logs its failures and
 * NOTHING SCRAPES IT, so backups could stop for six weeks and the dashboard would look exactly the
 * same. A backup you are not measuring is a backup you are assuming.
 *
 * Measured from the FILE, not from the sidecar reporting success, and the difference is the whole
 * point: a sidecar that has crashed reports nothing at all, which is indistinguishable from a
 * sidecar that was never asked. A file's mtime is evidence that a backup was actually written.
 *
 * `-1` rather than a large number when the directory is unreadable, so "we cannot see the backups"
 * and "the backups are old" are different alerts. Serving a big age for a missing mount would be
 * serving a guess as a measurement.
 */
const backupAge = g(
  'mfarm_backup_age_seconds',
  'Seconds since the newest backup file was written. -1 when BACKUP_DIR cannot be read.',
);

const backupCount = g('mfarm_backup_files', 'Number of backup files currently retained.');

/**
 * Seconds since the newest local backup was last CONFIRMED present off this machine.
 *
 * A separate measurement from `mfarm_backup_age_seconds`, because they fail independently and mean
 * different things. Fresh local backups with a stale offsite age is the dangerous combination and
 * the one that looks healthiest: dumps are being written, verified and retained, and every one of
 * them is on the same disk as the database.
 *
 * Read from `.offsite-receipt`, which `deploy/backup-offsite.sh` rewrites only after asking the
 * bucket how big the newest object is and getting the local size back. So this is not "the uploader
 * is running" — a process that logs failures every fifteen minutes would keep that fresh. It is
 * "the newest backup is known to exist somewhere else", which is the only claim worth alerting on.
 *
 * -1 means there is no such evidence. That covers an uploader that has never succeeded and an
 * operator who set BACKUP_BUCKET=none, and it reports them identically ON PURPOSE — accepting
 * single-disk backups is a real choice, and the honest way to express it is to silence an alert
 * that is telling the truth, not to have the farm report a copy that does not exist.
 */
const backupOffsiteAge = g(
  'mfarm_backup_offsite_age_seconds',
  'Seconds since the newest backup was confirmed present in off-box storage. -1 when there is no such confirmation.',
);

const droppedSeries = g(
  'mfarm_metric_series_dropped_total',
  `Series refused because a metric exceeded ${MAX_SERIES_PER_METRIC} label combinations. Any value ` +
    'above zero means a label is unbounded and some metric is now lying.',
);

// ---------------------------------------------------------------- collectors

const started = Date.now();

/** No I/O. Safe to call on every scrape and safe to call when the database is down. */
export function collectRuntime(): void {
  buildInfo.set({ version: process.env.MFARM_VERSION ?? 'dev', node: process.versions.node }, 1);
  uptime.set({}, (Date.now() - started) / 1000);
  const mem = process.memoryUsage();
  rss.set({}, mem.rss);
  heapUsed.set({}, mem.heapUsed);

  for (const [name, pool] of [['app', appPool], ['system', systemPool]] as const) {
    poolConns.set({ pool: name, state: 'total' }, pool.totalCount);
    poolConns.set({ pool: name, state: 'idle' }, pool.idleCount);
    poolConns.set({ pool: name, state: 'waiting' }, pool.waitingCount);
  }

  droppedSeries.set({}, registry.totalDroppedSeries());
}

/**
 * Read the backup directory and report how fresh it is.
 *
 * Synchronous-looking but async, and called from `scrape` rather than on a timer: a scrape is
 * already the moment someone asks, and a timer would keep a directory listing running on a farm
 * nobody is watching.
 *
 * Every failure lands on `-1`. An unset BACKUP_DIR, a directory that is not mounted, a permission
 * error — none of them mean "the backups are fine" and none of them mean "the backups are old",
 * they mean the measurement is unavailable, and the alert rule reads it that way.
 */
export async function collectBackups(): Promise<void> {
  const dir = process.env.BACKUP_DIR?.trim();
  if (!dir) { backupAge.set({}, -1); backupCount.set({}, 0); backupOffsiteAge.set({}, -1); return; }
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const { join } = await import('node:path');

    // The offsite receipt is read FIRST and independently of the dumps, so that "no backups at all"
    // and "backups that never left the box" stay separable. Reading it inside the dump branch would
    // make an empty directory silently imply an offsite failure it says nothing about.
    const receipt = await stat(join(dir, '.offsite-receipt')).catch(() => null);
    backupOffsiteAge.set({}, receipt ? (Date.now() - receipt.mtimeMs) / 1000 : -1);
    // `mfarm-*.dump` exactly, which is what `deploy/backup.sh` writes and what its own retention
    // sweep counts. Two details make this the right filter rather than a guess:
    //
    //   the dump is written as `.dump.partial`, VERIFIED with `pg_restore --list`, and only then
    //   renamed — so a file with this suffix is a backup that was proven readable, not one that was
    //   merely started;
    //
    //   the companion `.globals.sql` is deliberately not counted. It is written first and would
    //   make a run that died halfway through `pg_dump` look like a fresh, complete backup.
    const names = (await readdir(dir)).filter((n) => n.startsWith('mfarm-') && n.endsWith('.dump'));
    if (!names.length) { backupAge.set({}, -1); backupCount.set({}, 0); return; }
    let newest = 0;
    for (const n of names) {
      const st = await stat(join(dir, n)).catch(() => null);
      if (st && st.mtimeMs > newest) newest = st.mtimeMs;
    }
    backupCount.set({}, names.length);
    backupAge.set({}, newest ? (Date.now() - newest) / 1000 : -1);
  } catch {
    backupAge.set({}, -1);
    backupCount.set({}, 0);
    backupOffsiteAge.set({}, -1);
  }
}

interface DeviceRow { state: string; region: string; platform: string; tier: string; n: string }
interface SessionRow { state: string; n: string }
interface HostRow { hostname: string; region: string; state: string; beat: string | null }
interface AgeRow { cleaning_age: string; queue_age: string }

/**
 * One transaction, four queries, on the owner pool.
 *
 * A transaction rather than four loose queries so the scrape holds one connection for a bounded
 * moment instead of contending four times with the reaper for a pool of five. It is read-only; the
 * counts are cheap at any fleet size this design targets, and every one of them is an index scan or
 * a sequential scan over tens of rows.
 */
export async function collectFleet(): Promise<void> {
  const { deviceRows, sessionRows, hostRows, ages } = await withSystem(async (client) => {
    const d = await client.query<DeviceRow>(
      `SELECT state::text AS state, region, platform, tier, count(*)::text AS n
         FROM devices GROUP BY 1,2,3,4`,
    );
    const s = await client.query<SessionRow>(
      `SELECT state::text AS state, count(*)::text AS n FROM sessions GROUP BY 1`,
    );
    const h = await client.query<HostRow>(
      `SELECT hostname, region, state::text AS state,
              EXTRACT(EPOCH FROM last_heartbeat_at)::text AS beat
         FROM hosts`,
    );
    const a = await client.query<AgeRow>(
      `SELECT
         COALESCE((SELECT max(EXTRACT(EPOCH FROM now() - updated_at))
                     FROM devices WHERE state = 'CLEANING'), 0)::text AS cleaning_age,
         COALESCE((SELECT max(EXTRACT(EPOCH FROM now() - created_at))
                     FROM sessions WHERE state = 'QUEUED'), 0)::text AS queue_age`,
    );
    return { deviceRows: d.rows, sessionRows: s.rows, hostRows: h.rows, ages: a.rows[0]! };
  });

  // Reset before re-setting: a placement that no longer has any devices must stop being reported,
  // and a host that was deleted must stop appearing to be silent rather than gone.
  devices.reset();
  sessions.reset();
  hosts.reset();
  hostHeartbeat.reset();

  // Every placement gets all eight states, zeros included — see DEVICE_STATES.
  const placements = new Map<string, { region: string; platform: string; tier: string }>();
  for (const r of deviceRows) {
    placements.set(`${r.region}\0${r.platform}\0${r.tier}`, { region: r.region, platform: r.platform, tier: r.tier });
  }
  for (const p of placements.values()) {
    for (const state of DEVICE_STATES) devices.set({ state, ...p }, 0);
  }
  let total = 0;
  for (const r of deviceRows) {
    const n = Number(r.n);
    total += n;
    devices.set({ state: r.state, region: r.region, platform: r.platform, tier: r.tier }, n);
  }
  devicesTotal.set({}, total);

  for (const state of SESSION_STATES) sessions.set({ state }, 0);
  for (const r of sessionRows) sessions.set({ state: r.state }, Number(r.n));

  const hostCounts = new Map<string, number>(HOST_STATES.map((s) => [s, 0]));
  for (const r of hostRows) {
    hostCounts.set(r.state, (hostCounts.get(r.state) ?? 0) + 1);
    hostHeartbeat.set({ hostname: r.hostname, region: r.region }, r.beat === null ? 0 : Number(r.beat));
  }
  for (const [state, n] of hostCounts) hosts.set({ state }, n);

  cleaningAge.set({}, Number(ages.cleaning_age));
  queueOldest.set({}, Number(ages.queue_age));
}

/**
 * The scrape body.
 *
 * A failed fleet query does NOT fail the scrape. Prometheus treats a non-200 as "target down", which
 * hides the process metrics and the counters that would say *why* — including `mfarm_scrape_errors_total`
 * itself. So the error is counted, the stale gauges are served with it, and the alert rule watches
 * the counter. The one thing this must never do is serve zeros as if they were measurements.
 */
export async function scrape(): Promise<string> {
  const t0 = process.hrtime.bigint();
  scrapes.inc();
  try {
    await collectFleet();
  } catch {
    scrapeErrors.inc();
  }
  collectRuntime();
  // Its own try: a directory that cannot be read must not cost the scrape its fleet numbers.
  try { await collectBackups(); } catch { scrapeErrors.inc(); }
  scrapeDuration.observe({}, Number(process.hrtime.bigint() - t0) / 1e9);
  return registry.render();
}
