import type { PoolClient } from 'pg';
import { withTenant } from './db.ts';

/**
 * The execution timeline: what the farm DID during a run (migration 030).
 *
 * A run's rollup is derived at read time from `sessions` and `test_results`, which answers "what
 * ran" and "what failed" but not "what happened". A session that waited four minutes for capacity
 * and one allocated instantly leave identical rows behind, so "why was this run slow" is not a slow
 * question — it is an unanswerable one. These events are the answer, and per ADR-0018 they are the
 * part of `AutomationExecutionPlan.md` §4/§17/§18 that MFARM can record honestly: the farm's own
 * actions, never a claim about the test.
 *
 * ---------------------------------------------------------------- two rules
 *
 * **An event never fails the thing it describes.** Every writer here is wrapped by `safely()`. A
 * timeline is diagnostic; a session is the product. Losing a row because the insert raced a
 * cascade is a gap in a chart, and failing a customer's session to protect a chart would be the
 * wrong trade in a way that is obvious only after it has happened.
 *
 * **A session with no run writes nothing, and that is expressed in SQL rather than in a branch.**
 * `run_id` is NOT NULL on the table, because this is the timeline OF A RUN — a lease taken by
 * somebody poking at a device from the console is not one. The INSERT ... SELECT below simply
 * matches no rows when the session has no `run_id`, so there is no round trip to decide it and no
 * code path that can forget to.
 */

/** Kinds are constrained in the database too (migration 030); this is the caller-facing list. */
export type ExecutionEventKind =
  | 'run-created'
  | 'session-queued'
  | 'device-allocated'
  | 'session-active'
  | 'build-install-started'
  | 'build-install-finished'
  | 'session-ended'
  | 'device-released'
  | 'incident'
  | 'run-completed';

/**
 * Swallow and report. Deliberately not `void`-ing the promise: awaiting keeps the event ordered
 * with respect to the state change it describes, which is the whole point of a timeline, and the
 * cost is one indexed insert.
 */
async function safely(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // `console` rather than a request logger: this is called from handlers, the reaper and the
    // worker path, and threading a logger through all three to report a diagnostic write would put
    // more weight on the failure than it deserves.
    console.warn(`[timeline] could not record ${what}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Record something that happened to a SESSION. The run and device are read from the session row, so
 * a caller cannot attribute an event to the wrong run by passing a stale id — the same reasoning
 * that keeps a worker from naming the org it bills (architecture rule 4).
 */
export async function recordSessionEvent(
  orgId: string,
  sessionId: string,
  kind: ExecutionEventKind,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await safely(`${kind} for session ${sessionId}`, () => withTenant(orgId, async (c) => {
    await c.query(
      `INSERT INTO execution_events (org_id, run_id, session_id, device_id, kind, detail)
       SELECT s.org_id, s.run_id, s.id, s.device_id, $2, $3::jsonb
         FROM sessions s
        WHERE s.id = $1 AND s.run_id IS NOT NULL`,
      [sessionId, kind, JSON.stringify(detail)],
    );
  }));
}

/** Record something about the run itself — creation, and anything that belongs to no lease. */
export async function recordRunEvent(
  orgId: string,
  runId: string,
  kind: ExecutionEventKind,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await safely(`${kind} for run ${runId}`, () => withTenant(orgId, async (c) => {
    await c.query(
      `INSERT INTO execution_events (org_id, run_id, kind, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [orgId, runId, kind, JSON.stringify(detail)],
    );
  }));
}

export interface TimelineRow {
  kind: string;
  detail: Record<string, unknown>;
  occurredAt: Date;
  sessionId: string | null;
  deviceId: string | null;
}

/**
 * One run's timeline, oldest first — the §18 read.
 *
 * Bounded rather than unbounded: a long soak run can produce a lot of rows and this is rendered in
 * a browser. The cap is generous enough that no ordinary run is truncated and small enough that one
 * pathological run cannot take the screen down.
 */
export async function timeline(orgId: string, runId: string, limit = 1000): Promise<TimelineRow[]> {
  return withTenant(orgId, async (c: PoolClient) => {
    const { rows } = await c.query(
      `SELECT kind, detail, occurred_at, session_id, device_id
         FROM execution_events
        WHERE run_id = $1
        ORDER BY occurred_at, id
        LIMIT $2`,
      [runId, limit],
    );
    return rows.map((r) => ({
      kind: r.kind as string,
      detail: (r.detail ?? {}) as Record<string, unknown>,
      occurredAt: r.occurred_at as Date,
      sessionId: r.session_id as string | null,
      deviceId: r.device_id as string | null,
    }));
  });
}
