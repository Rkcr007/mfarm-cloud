import { withSystem, withTenant } from './db.ts';

/**
 * Attempts: what the farm had to do to serve ONE user request (migration 033, plan §33/§35).
 *
 * ---------------------------------------------------------------- the rule
 *
 * A user asks for a device once. If the emulator goes unhealthy, adb drops, or a handset falls off
 * the end of its cable, MFARM recovers and carries on — and that recovery is the FARM's cost, not
 * the user's. So:
 *
 *   one logical user request  =  one attempt with origin 'user'
 *   every recovery MFARM does =  another attempt with origin 'infra-retry'
 *
 * The rule is enforced in the schema by a partial unique index rather than here, because a rule that
 * lives only in application code is a rule until somebody writes a second caller.
 *
 * ---------------------------------------------------------------- what this is NOT
 *
 * **Not billing, and not a change to usage.** `metering.ts` and `metering_events` are untouched: the
 * tenant is still metered `device_seconds` for the time it held a device, which is the right unit
 * and a different question from this one. Nothing in this file is a price or a credit.
 *
 * **Not an opinion about a test.** A failed assertion belongs to the suite and lives in
 * `test_results` (021, 024). The farm cannot see one — it watches a session drive a device, and a
 * passing test and a failing test look identical from here — so there is no 'test-failure' outcome
 * to record and `record_infra_retry` refuses anything that is not an infrastructure failure. That
 * refusal is §34 in code: retrying a failed test would manufacture a false green.
 */

/** What ended an attempt. Deliberately has no test-failure member — see the note above. */
export type AttemptOutcome =
  | 'succeeded'
  | 'device-failure'
  | 'infrastructure-failure'
  | 'abandoned';

export type AttemptOrigin = 'user' | 'infra-retry';

/**
 * Open the FIRST attempt on a session — the user's own.
 *
 * Called once, when a session is created. A second call for the same session violates the partial
 * unique index and throws, which is the intended behaviour: it means a caller was about to charge a
 * user twice for asking once.
 *
 * Returns the attempt number, or null when the session no longer exists.
 */
export async function openUserAttempt(sessionId: string): Promise<number | null> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT open_session_attempt($1, 'user') AS attempt`, [sessionId],
    );
    return rows[0].attempt === null ? null : Number(rows[0].attempt);
  });
}

/**
 * Close the session's open attempt.
 *
 * `false` when there was none, which is ordinary rather than exceptional: a session created before
 * migration 033, or one that queued and ended without ever holding a device.
 */
export async function closeAttempt(
  sessionId: string, outcome: AttemptOutcome, reason: string | null = null,
): Promise<boolean> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      'SELECT close_session_attempt($1, $2, $3) AS ok', [sessionId, outcome, reason],
    );
    return rows[0].ok === true;
  });
}

/**
 * The farm failed and is trying again: close the failed attempt, open an `infra-retry`.
 *
 * THE USER'S ATTEMPT COUNT DOES NOT MOVE, and that is guaranteed by the schema rather than by this
 * function being careful — the new row is not `origin = 'user'`, so the partial unique index that
 * makes "one user attempt per session" true is not even consulted.
 *
 * Returns the new attempt number, or null when the session had no open attempt to fail — a session
 * that already ended, or one that never opened one.
 */
export async function recordInfraRetry(
  sessionId: string,
  outcome: 'device-failure' | 'infrastructure-failure',
  reason: string,
): Promise<number | null> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      'SELECT record_infra_retry($1, $2, $3) AS attempt', [sessionId, outcome, reason],
    );
    return rows[0].attempt === null ? null : Number(rows[0].attempt);
  });
}

export interface AttemptCounts {
  /** How many times a user actually asked. One per session, by construction. */
  userAttempts: number;
  /** How many times MFARM had to try again to serve one of those asks. */
  infraRetries: number;
  /** Of those retries, how many were the DEVICE going bad rather than something around it. */
  deviceFailures: number;
  /** Attempts that ended having served the request. */
  successfulAttempts: number;
}

/**
 * The four counters, for one org over a window — the §2 questions, answered.
 *
 * On the TENANT pool, so RLS decides what is counted. That is not a detail: these numbers are about
 * one org's consumption, and computing them on the system pool would make a query that forgot an
 * org clause report the whole fleet's to whoever asked.
 */
export async function counts(orgId: string, from: Date, to: Date): Promise<AttemptCounts> {
  return withTenant(orgId, async (c) => {
    const { rows } = await c.query(
      `SELECT count(*) FILTER (WHERE origin = 'user')                     AS user_attempts,
              count(*) FILTER (WHERE origin = 'infra-retry')              AS infra_retries,
              count(*) FILTER (WHERE outcome = 'device-failure')          AS device_failures,
              count(*) FILTER (WHERE outcome = 'succeeded')               AS successful_attempts
         FROM session_attempts
        WHERE started_at >= $1 AND started_at < $2`,
      [from, to],
    );
    return {
      userAttempts: Number(rows[0].user_attempts),
      infraRetries: Number(rows[0].infra_retries),
      deviceFailures: Number(rows[0].device_failures),
      successfulAttempts: Number(rows[0].successful_attempts),
    };
  });
}

export interface DeviceReliability {
  deviceId: string;
  attempts: number;
  failures: number;
}

/**
 * "How often does a particular device fail" — §2's device-health question, per device.
 *
 * Tenant-scoped for the same reason as `counts`. A device shared by several orgs shows each of them
 * only the attempts THEY made on it, which is the honest answer to a tenant: the fleet-wide view of
 * the same hardware belongs to the operator surfaces on the system pool (`metrics.ts`).
 */
export async function deviceReliability(
  orgId: string, from: Date, to: Date, limit = 50,
): Promise<DeviceReliability[]> {
  return withTenant(orgId, async (c) => {
    const { rows } = await c.query(
      `SELECT device_id,
              count(*)                                           AS attempts,
              count(*) FILTER (WHERE outcome IN ('device-failure',
                                                 'infrastructure-failure')) AS failures
         FROM session_attempts
        WHERE device_id IS NOT NULL AND started_at >= $1 AND started_at < $2
        GROUP BY device_id
        ORDER BY failures DESC, attempts DESC
        LIMIT $3`,
      [from, to, limit],
    );
    return rows.map((r) => ({
      deviceId: r.device_id as string,
      attempts: Number(r.attempts),
      failures: Number(r.failures),
    }));
  });
}
