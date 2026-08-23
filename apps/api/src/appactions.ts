import type { PoolClient } from 'pg';
import type { AppActionKind } from '@mfarm/protocol';
import { withTenant } from './db.ts';

/**
 * Requesting an app action, and waiting for one.
 *
 * The INSERT below is the security-critical statement in the app library and it now has two callers
 * — `POST /v1/sessions/:id/app-actions` and the WebDriver hub's `mfarm:appId` — so it lives in one
 * place. What makes it safe is entirely in its SELECT, and every clause is load-bearing:
 *
 *   the org comes from the SESSION row, not the caller's claim about it;
 *   the DEVICE comes from the session too, so there is no field a caller can set to aim an action
 *     at hardware it does not hold;
 *   the FENCE is copied at request time and re-checked at delivery, so an action requested moments
 *     before a device was reclaimed is never performed for the next tenant;
 *   and it all runs under the tenant's own RLS, which is what makes `app_builds` unnameable across
 *     orgs rather than merely unauthorised.
 *
 * Two copies of that would drift, and the way it would drift is silent.
 */

/** Sessions that still hold a device. An action against anything else has nowhere to land. */
export const LIVE_SESSION_STATES = ['ALLOCATING', 'ACTIVE'];

export interface AppActionRow {
  id: string;
  kind: string;
  app_id: string;
  session_id: string;
  device_id: string;
  state: string;
  error: string | null;
  requested_at: Date;
  finished_at: Date | null;
}

/**
 * Queue one action, or return null when nothing matched.
 *
 * Null covers "no live session", "not this org's session" and "no such build" without saying which,
 * because this function cannot tell them apart — the SELECT either finds a row or does not. Callers
 * that want to name the failure check the preconditions first and separately, which both of them do:
 * a single INSERT ... SELECT returning zero rows is correct and useless to whoever reads the error.
 */
export async function requestAppAction(
  c: PoolClient,
  opts: { sessionId: string; appId: string; kind: AppActionKind },
): Promise<AppActionRow | null> {
  const { rows } = await c.query<AppActionRow>(
    `INSERT INTO app_actions (org_id, app_id, session_id, device_id, fence, kind)
     SELECT s.org_id, a.id, s.id, s.device_id, s.fence, $4::app_action_kind
       FROM sessions s, app_builds a
      WHERE s.id = $1 AND a.id = $2
        AND s.state = ANY($3::session_state[])
        AND s.device_id IS NOT NULL AND s.fence IS NOT NULL
     RETURNING *`,
    [opts.sessionId, opts.appId, LIVE_SESSION_STATES, opts.kind],
  );
  return rows[0] ?? null;
}

export type AppActionOutcome =
  | { state: 'DONE' }
  | { state: 'FAILED'; error: string | null }
  /**
   * Still PENDING when we stopped looking, which is TWO different facts and they must not be
   * conflated:
   *
   *   deadline   the worker never picked it up, or is still working. A real timeout.
   *   abandoned  the caller went away, so we stopped watching. Says NOTHING about the install,
   *              which may well be about to succeed.
   *
   * They used to be one value, and the cost of that is on the record: when the abandon predicate
   * was wrong, every session reported a 240-second install timeout after waiting a millisecond,
   * and it read as a slow device for as long as it took someone to check the timestamps. A caller
   * that cannot tell "I gave up" from "it is late" will eventually tell somebody the wrong story.
   *
   * `waitedMs` is MEASURED, not the configured budget, for the same reason.
   */
  | { state: 'PENDING'; waitedMs: number; gaveUp: 'deadline' | 'abandoned' }
  /** The row is gone: its session or its build was deleted underneath us. */
  | { state: 'GONE' };

/**
 * Block until an action finishes.
 *
 * There is no push channel to wait on — the control plane cannot dial a worker, so an action is
 * delivered on the next heartbeat and confirmed by `POST /v1/workers/events` (migration 014's
 * design note). Polling the row is therefore not a shortcut around a better mechanism; it is the
 * only observation point that exists.
 *
 * The floor on latency is one heartbeat interval (10 s), before the install itself has started.
 * Anything that waits on this has to be willing to spend that.
 */
export async function awaitAppAction(
  orgId: string,
  actionId: string,
  opts: { timeoutMs: number; pollIntervalMs: number; abandoned?: () => boolean },
): Promise<AppActionOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + opts.timeoutMs;
  for (;;) {
    const row = await withTenant(orgId, async (c) => {
      const { rows } = await c.query<{ state: string; error: string | null }>(
        'SELECT state::text AS state, error FROM app_actions WHERE id = $1',
        [actionId],
      );
      return rows[0];
    });
    if (!row) return { state: 'GONE' };
    if (row.state === 'DONE') return { state: 'DONE' };
    if (row.state === 'FAILED') return { state: 'FAILED', error: row.error };

    // Checked in this order because they are not equally informative. The caller leaving is a fact
    // about the caller; the deadline passing is a fact about the install. If both are true the
    // caller left first, and saying so is more use than reporting a timeout to nobody.
    if (opts.abandoned?.()) {
      return { state: 'PENDING', waitedMs: Date.now() - startedAt, gaveUp: 'abandoned' };
    }
    if (Date.now() >= deadline) {
      return { state: 'PENDING', waitedMs: Date.now() - startedAt, gaveUp: 'deadline' };
    }
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
  }
}
