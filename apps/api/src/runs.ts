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
  opts: { orgId: string; externalId: string },
): Promise<Run> {
  const { rows: inserted } = await c.query<{ id: string }>(
    `INSERT INTO runs (org_id, external_id) VALUES ($1, $2)
     ON CONFLICT (org_id, external_id) DO NOTHING
     RETURNING id`,
    [opts.orgId, opts.externalId],
  );
  if (inserted[0]) return { id: inserted[0].id, externalId: opts.externalId, created: true };

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
