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

/**
 * LIVE SUBSCRIBERS — the §17 half, in memory.
 *
 * A listener is registered per RUN, and events are published only after the row has actually
 * landed. Publishing before the insert, or publishing what the caller passed rather than what came
 * back, would let a viewer see something the timeline does not contain — and the first time those
 * disagree, the stream is the one nobody will trust again.
 *
 * SINGLE INSTANCE ONLY, and this is now the second reason for that constraint rather than a new
 * one: ADR-0001 already blocks a second control-plane process because rate limiting is in memory.
 * A subscriber registry has exactly the same shape. If the control plane is ever made
 * multi-instance, both have to move together — and a viewer connected to instance B silently
 * missing every event produced on instance A is a far quieter failure than a doubled rate limit.
 *
 * BOUNDED, because a Map keyed by caller-supplied ids is otherwise a memory leak with a nice name.
 * Both caps drop new subscriptions rather than evicting existing ones: a viewer who is already
 * watching keeps working, and the one who cannot connect finds out immediately.
 */
const MAX_RUNS_WATCHED = 500;
const MAX_LISTENERS_PER_RUN = 20;

export interface PublishedEvent {
  kind: string;
  detail: Record<string, unknown>;
  sessionId: string | null;
  deviceId: string | null;
  occurredAt: Date;
}

type Listener = (e: PublishedEvent) => void;
const listeners = new Map<string, Set<Listener>>();

/**
 * Watch one run. Returns the unsubscribe, or `null` when a cap is hit.
 *
 * The caller MUST invoke the returned function on disconnect. An SSE handler that forgets leaves a
 * listener holding a dead socket for the lifetime of the process, and the set never shrinks.
 */
export function subscribe(runId: string, fn: Listener): (() => void) | null {
  let set = listeners.get(runId);
  if (!set) {
    if (listeners.size >= MAX_RUNS_WATCHED) return null;
    set = new Set();
    listeners.set(runId, set);
  }
  if (set.size >= MAX_LISTENERS_PER_RUN) return null;
  set.add(fn);
  return () => {
    set!.delete(fn);
    // Drop the key with its last listener, or the Map grows forever with empty sets — the leak the
    // cap above would then be measuring rather than preventing.
    if (set!.size === 0) listeners.delete(runId);
  };
}

/** How many runs are being watched right now. Exported for the test that proves cleanup happens. */
export function watchedRuns(): number {
  return listeners.size;
}

function publish(runId: string, e: PublishedEvent): void {
  const set = listeners.get(runId);
  if (!set) return;
  for (const fn of set) {
    // One viewer's broken socket must not stop the others being told, and must never propagate back
    // into the handler that recorded the event.
    try { fn(e); } catch { /* a dead listener is the SSE handler's problem, not the writer's */ }
  }
}

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
    const { rows } = await c.query(
      `INSERT INTO execution_events (org_id, run_id, session_id, device_id, kind, detail)
       SELECT s.org_id, s.run_id, s.id, s.device_id, $2, $3::jsonb
         FROM sessions s
        WHERE s.id = $1 AND s.run_id IS NOT NULL
       RETURNING run_id, session_id, device_id, kind, detail, occurred_at`,
      [sessionId, kind, JSON.stringify(detail)],
    );
    // Zero rows is the ordinary case for a session with no run, and there is nothing to publish.
    // Publishing what was PASSED IN rather than what came back would let a viewer see an event the
    // timeline does not contain.
    for (const r of rows) {
      publish(r.run_id, {
        kind: r.kind, detail: r.detail ?? {}, sessionId: r.session_id,
        deviceId: r.device_id, occurredAt: r.occurred_at,
      });
    }
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
    const { rows } = await c.query(
      `INSERT INTO execution_events (org_id, run_id, kind, detail)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING run_id, session_id, device_id, kind, detail, occurred_at`,
      [orgId, runId, kind, JSON.stringify(detail)],
    );
    for (const r of rows) {
      publish(r.run_id, {
        kind: r.kind, detail: r.detail ?? {}, sessionId: r.session_id,
        deviceId: r.device_id, occurredAt: r.occurred_at,
      });
    }
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
