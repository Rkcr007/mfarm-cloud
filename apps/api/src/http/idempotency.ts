import { createHash } from 'node:crypto';
import { withTenant } from '../db.ts';
import { conflict, badRequest } from './errors.ts';

/**
 * Idempotency for unsafe requests — the gap flagged in the v1 review.
 *
 * Session creation allocates a scarce, billable resource. A client whose request times out will
 * retry, and without this it gets a second device and a second bill while the first session sits
 * orphaned until the reaper collects it. Any client that retries (every CI system, every SDK with
 * backoff, every agent) hits this within days of launch.
 *
 * The key is CLAIMED before the work starts, not recorded after it finishes.
 *
 * That ordering is the whole design. "Check, then do, then record" only protects a retry that
 * arrives after the first request completed — but the retry that matters is the one a client sends
 * because the first request is *taking too long*, which by definition arrives while it is still
 * running. Both would miss the check, both would allocate a device, and the customer would be billed
 * twice for the one session they asked for. Claiming first turns that window into a 409.
 */

export type ClaimOutcome =
  | { kind: 'claimed' }
  | { kind: 'replay'; statusCode: number; body: unknown };

/** Not a valid HTTP status, so it can never collide with a genuine stored response. */
const IN_FLIGHT = 0;

/**
 * How long a claim can sit unfinished before another request may take it over. Long enough that a
 * slow allocation is never stolen, short enough that an API process killed mid-request does not
 * leave a key permanently unusable — which for a CI job pinning one key per build means a permanent
 * 409 rather than a transient one.
 */
const CLAIM_TTL_SECONDS = 300;

/** Bounds what goes into an indexed text column from a header a client controls. */
const MAX_KEY_LENGTH = 255;

const hashRequest = (method: string, path: string, body: unknown): string =>
  createHash('sha256').update(`${method}\n${path}\n${JSON.stringify(body ?? null)}`).digest('hex');

/** Normalise the header into a usable key, or null when the client sent none. */
export function idempotencyKey(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key.length === 0) return null;
  if (key.length > MAX_KEY_LENGTH) {
    throw badRequest(`Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.`);
  }
  return key;
}

/**
 * Take exclusive ownership of a key, or report what the first request already produced.
 *
 * Reusing a key with a DIFFERENT body is a client bug, not a retry — returning the first response
 * would silently ignore what was actually asked for, so it 409s instead.
 */
export async function claim(
  orgId: string,
  key: string,
  method: string,
  path: string,
  body: unknown,
): Promise<ClaimOutcome> {
  const rh = hashRequest(method, path, body);

  return withTenant(orgId, async (c) => {
    const inserted = await c.query(
      `INSERT INTO idempotency_keys (org_id, key, request_hash, status_code, response)
       VALUES ($1, $2, $3, $4, 'null'::jsonb)
       ON CONFLICT (org_id, key) DO NOTHING
       RETURNING key`,
      [orgId, key, rh, IN_FLIGHT],
    );
    if ((inserted.rowCount ?? 0) > 0) return { kind: 'claimed' };

    const { rows } = await c.query(
      'SELECT request_hash, status_code, response FROM idempotency_keys WHERE org_id = $1 AND key = $2',
      [orgId, key],
    );
    // Collected by the reaper between the two statements. Vanishingly rare, and proceeding is the
    // same risk profile as having no key at all.
    if (rows.length === 0) return { kind: 'claimed' };

    if (rows[0].request_hash !== rh) {
      throw conflict(
        'idempotency_key_reuse',
        'This Idempotency-Key was already used with a different request body. Use a new key for a new request.',
      );
    }
    if (rows[0].status_code !== IN_FLIGHT) {
      return { kind: 'replay', statusCode: rows[0].status_code, body: rows[0].response };
    }

    // Still in flight. Take it over only if the holder is old enough to be presumed dead, and do it
    // with a conditional UPDATE so two simultaneous takers cannot both win.
    const takenOver = await c.query(
      `UPDATE idempotency_keys SET created_at = now()
        WHERE org_id = $1 AND key = $2 AND status_code = $3
          AND created_at < now() - make_interval(secs => $4)
        RETURNING key`,
      [orgId, key, IN_FLIGHT, CLAIM_TTL_SECONDS],
    );
    if ((takenOver.rowCount ?? 0) > 0) return { kind: 'claimed' };

    throw conflict(
      'idempotency_in_flight',
      'A request with this Idempotency-Key is still being processed. Retry in a few seconds with the same body.',
    );
  });
}

/** Store the response the claim produced. Subsequent retries replay it verbatim. */
export async function complete(
  orgId: string,
  key: string,
  statusCode: number,
  response: unknown,
): Promise<void> {
  await withTenant(orgId, (c) =>
    c.query(
      `UPDATE idempotency_keys SET status_code = $3, response = $4
        WHERE org_id = $1 AND key = $2`,
      [orgId, key, statusCode, JSON.stringify(response)],
    ),
  );
}

/**
 * Release a claim whose request failed.
 *
 * Without this, one transient failure (a database blip, a device with no endpoint) would burn the
 * key: the retry the client is about to send would meet its own abandoned claim and 409 until the
 * TTL expired. Only unfinished claims are removed, so a completed response is never lost.
 */
export async function abandon(orgId: string, key: string): Promise<void> {
  await withTenant(orgId, (c) =>
    c.query('DELETE FROM idempotency_keys WHERE org_id = $1 AND key = $2 AND status_code = $3', [
      orgId, key, IN_FLIGHT,
    ]),
  );
}
