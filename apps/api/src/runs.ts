import type { PoolClient } from 'pg';

/**
 * Runs: the group a session belongs to, named by whoever started it.
 *
 * A run exists because twenty tests are otherwise twenty unrelated `sessions` rows, and "what
 * failed on build 4471" is then not a slow query but an unanswerable one (docs/EXECUTION_MODEL.md
 * §4.2). The name comes from the CLIENT — `$GITHUB_RUN_ID`, a Jenkins build number, a uuid minted
 * per `npm test` — because anything we minted would have to be handed back to the suite before its
 * first session, which means a coordination call, a step that can fail, and a run row left behind
 * when the suite dies. Get-or-create by name has none of that: the first session to use a name
 * creates the run, every later one joins it, and a crashed suite leaves a run that simply stops
 * gaining sessions.
 *
 * Everything here runs under the tenant's own RLS. The unique index is on `(org_id, external_id)`,
 * which is the only reason client-chosen names are safe — every CI system numbers builds from 1, so
 * two orgs both running `mfarm:runId: '412'` is the ordinary case, not the adversarial one.
 */

/** Bounds matching the CHECK constraint in migration 020. Rendered in the console, so no controls. */
export const MAX_RUN_ID_LENGTH = 200;

/** A run reference the caller wrote that cannot be used. Callers map this to their own error shape. */
export class RunRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunRefError';
  }
}

/**
 * C0, DEL and C1. Tested by code point rather than with a regex literal so that this source file
 * contains none of the bytes it is rejecting — a control character pasted into a regex is invisible
 * in every diff and every review that would otherwise catch it changing.
 */
function hasControlCharacter(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Validate a client-supplied run name.
 *
 * Control characters are refused rather than stripped. A run id containing a newline would break
 * every log line it appears in and would render as two rows in a console table, and the caller who
 * sent it is far better placed to notice at session creation than to work out later why their run
 * name looks truncated.
 */
export function parseRunId(raw: string): string {
  const id = raw.trim();
  if (id === '') throw new RunRefError('a run id cannot be empty.');
  if (id.length > MAX_RUN_ID_LENGTH) {
    throw new RunRefError(`a run id cannot be longer than ${MAX_RUN_ID_LENGTH} characters.`);
  }
  if (hasControlCharacter(id)) {
    throw new RunRefError('a run id cannot contain control characters or line breaks.');
  }
  return id;
}

export interface Run {
  id: string;
  externalId: string;
  /** True when THIS call created the row — the first session of the run. Logged, never returned. */
  created: boolean;
}

/**
 * The run with this name for this org, creating it if it is the first session to use it.
 *
 * `ON CONFLICT DO NOTHING` plus a fallback SELECT rather than `DO UPDATE ... RETURNING`, because
 * the update form would need an UPDATE grant and an update path through the RLS policy for a
 * statement that changes nothing. Under READ COMMITTED the two-statement form is race-free in the
 * way that matters: a concurrent inserter blocks our INSERT until it commits, and the SELECT that
 * follows then sees the committed row. Twenty parallel workers starting one CI run hit this
 * simultaneously, so that is the ordinary case rather than a corner.
 */
export async function findOrCreateRun(
  c: PoolClient,
  opts: { orgId: string; externalId: string; name?: string },
): Promise<Run> {
  const { rows: inserted } = await c.query<{ id: string }>(
    `INSERT INTO runs (org_id, external_id, name) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, external_id) DO NOTHING
     RETURNING id`,
    [opts.orgId, opts.externalId, opts.name ?? null],
  );
  if (inserted[0]) return { id: inserted[0].id, externalId: opts.externalId, created: true };

  /**
   * THE FIRST SESSION'S NAME IS THE RUN'S NAME, and later ones do not overwrite it (migration 048).
   *
   * Not a precedence quibble: a suite whose sessions disagree about the run name has a bug, and the
   * one worth showing is the one that created the run — every other choice makes the label change
   * under a reader partway through a run. `WHERE name IS NULL` is the whole rule: a run created
   * before anybody sent a name can still acquire one, and a name already set is never traded for a
   * different one.
   */
  if (opts.name !== undefined) {
    await c.query(
      'UPDATE runs SET name = $2 WHERE external_id = $1 AND name IS NULL',
      [opts.externalId, opts.name],
    );
  }

  const { rows } = await c.query<{ id: string }>(
    'SELECT id FROM runs WHERE external_id = $1',
    [opts.externalId],
  );
  if (!rows[0]) {
    // RLS scopes the SELECT to this org and the INSERT just told us a row exists, so the only way
    // here is a policy or index that no longer matches this function. Failing loudly beats
    // returning a run id that would silently label sessions with nothing.
    throw new RunRefError(`run "${opts.externalId}" could neither be created nor found.`);
  }
  return { id: rows[0].id, externalId: opts.externalId, created: false };
}

/**
 * Put a session into a run, or report that it is already in a different one.
 *
 * First stamp wins, and a second stamp naming the SAME run is a no-op rather than an error — a
 * suite that opens several WebDriver sessions against one `mfarm run` allocation passes the same
 * `mfarm:runId` every time, and that is correct usage, not a conflict.
 *
 * Two different names for one session is a caller bug with no defensible resolution: the session
 * belongs to one run or the other, and picking either silently files a device lease, its artifacts
 * and its cost under a run that did not incur them. Returns false and lets the caller refuse.
 */
export async function stampSessionRun(
  c: PoolClient,
  opts: { sessionId: string; runId: string },
): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE sessions SET run_id = $2
      WHERE id = $1 AND (run_id IS NULL OR run_id = $2)`,
    [opts.sessionId, opts.runId],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------- what a run held, and cost

/** One session's hold on a device, as the run detail reads it. `hostId` is null when the device
 *  row has since been removed — the minutes were still held, the host that carried them is unknown. */
export interface DeviceHold {
  seconds: number;
  hostId: string | null;
}

export interface RunCost {
  inr: number;
  hostHourlyCost: number;
  note: string;
}

/**
 * Device-minutes for a run, and the share of the host rate those minutes stand for (ADR-0039).
 *
 * THE RATE IS PER HOST AND A HOST CARRIES SEVERAL DEVICES. Multiplying device-minutes by the whole
 * `HOST_HOURLY_COST` would bill a four-device host four times over for one hour of four parallel
 * sessions — a number wrong by exactly the factor nobody checks, on the screen somebody quotes in a
 * budget. So each session is priced at the rate DIVIDED BY THE DEVICES ITS HOST CARRIES, which is
 * what the hour would cost if every device on that host were busy: the fair share, and an upper
 * bound on nothing else.
 *
 * The divisor is the host's devices NOW, not at the time. Nothing records how many devices a host
 * had last Tuesday, and a farm whose device count changes is rare enough that inventing a history
 * for it would be the less honest choice. The ADR says so; the note does not need to.
 *
 * A session whose device has since been removed has minutes and no host, so it counts towards
 * `deviceMinutes` and is NOT priced — and the note says how much was left out, because a cost
 * silently lower than the minutes imply is the same lie pointed the other way.
 *
 * `cost` is null when no rate is configured, never zero: ADR-0035's rule that a number invented in
 * config would be rendered as though the farm had measured it.
 */
export function attributeRunCost(
  holds: DeviceHold[],
  devicesPerHost: Map<string, number>,
  rate: number | null,
  currency: string,
): { deviceMinutes: number; cost: RunCost | null } {
  const totalSeconds = holds.reduce((n, h) => n + Math.max(0, h.seconds), 0);
  const deviceMinutes = Math.round(totalSeconds / 60);
  if (rate === null) return { deviceMinutes, cost: null };

  let inr = 0;
  let unpricedSeconds = 0;
  const divisors = new Set<number>();
  for (const h of holds) {
    const seconds = Math.max(0, h.seconds);
    const devices = h.hostId ? devicesPerHost.get(h.hostId) ?? 0 : 0;
    if (devices <= 0) { unpricedSeconds += seconds; continue; }
    divisors.add(devices);
    inr += (seconds / 3600) * (rate / devices);
  }

  const rateText = `${currency}${rate}/hr`;
  const plural = (n: number) => `${n} device${n === 1 ? '' : 's'}`;
  let note: string;
  if (holds.length === 0 || totalSeconds === 0) {
    note = `No device was held, so no share of ${rateText} is attributed`;
  } else if (divisors.size === 0) {
    note = `≈ share of ${rateText}, but the devices this run held have since been removed, so none of it is priced`;
  } else {
    const sorted = [...divisors].sort((a, b) => a - b);
    note = sorted.length === 1
      ? `≈ share of ${rateText} across ${plural(sorted[0])}`
      : `≈ share of ${rateText}, split across each host's ${sorted[0]}–${sorted[sorted.length - 1]} devices`;
    const unpricedMinutes = Math.round(unpricedSeconds / 60);
    if (unpricedMinutes > 0) note += `; ${unpricedMinutes} min on a since-removed device is not priced`;
  }

  return {
    deviceMinutes,
    cost: { inr: Math.round(inr * 100) / 100, hostHourlyCost: rate, note },
  };
}

// ---------------------------------------------------------------- flake history

/** How many runs a failing test's history carries. Enough to see a pattern, few enough to draw. */
export const HISTORY_RUNS = 20;

export interface HistoryRow {
  test_name: string;
  run_id: string;
  external_id: string;
  run_name: string | null;
  failed: boolean;
  at: Date;
  rn: number;
}

export interface TestHistory {
  runs: Array<{ runId: string; name: string | null; outcome: 'passed' | 'failed'; at: string; current: boolean }>;
  failedCount: number;
  total: number;
}

/**
 * Fold the history query's rows into one history per test name.
 *
 * THE CURRENT RUN IS ALWAYS IN IT. The query returns the newest `HISTORY_RUNS` per name plus the
 * current run wherever it ranks; for a run opened weeks later, when twenty newer runs have reported
 * the same test, the current one takes the OLDEST slot rather than being dropped. A history that
 * omitted the run you are looking at could not say where that run sits in it.
 *
 * `runId` is the run's EXTERNAL id — what `runJson` calls `runId`, and what the console routes by.
 */
export function shapeHistory(rows: HistoryRow[], currentRunId: string): Map<string, TestHistory> {
  const byName = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    const list = byName.get(r.test_name) ?? [];
    list.push(r);
    byName.set(r.test_name, list);
  }

  const out = new Map<string, TestHistory>();
  for (const [name, list] of byName) {
    const newest = list.filter((r) => Number(r.rn) <= HISTORY_RUNS).sort((a, b) => Number(a.rn) - Number(b.rn));
    const current = list.find((r) => r.run_id === currentRunId);
    const kept = current && !newest.includes(current)
      ? [...newest.slice(0, HISTORY_RUNS - 1), current]
      : newest;
    // Oldest → newest, the order a strip of dots is read in.
    const runs = kept.reverse().map((r) => ({
      runId: r.external_id,
      name: r.run_name,
      outcome: r.failed ? 'failed' as const : 'passed' as const,
      at: r.at.toISOString(),
      current: r.run_id === currentRunId,
    }));
    out.set(name, { runs, failedCount: runs.filter((r) => r.outcome === 'failed').length, total: runs.length });
  }
  return out;
}
