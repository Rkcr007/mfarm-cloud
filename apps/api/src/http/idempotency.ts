import { createHash } from 'node:crypto';
import { withTenant } from '../db.ts';
import { conflict } from './errors.ts';

/**
 * Idempotency for unsafe requests — the gap flagged in the v1 review.
 *
 * Session creation allocates a scarce, billable resource. A client whose request times out will
 * retry, and without this it gets a second device and a second bill while the first session sits
 * orphaned until the reaper collects it. Any client that retries (every CI system, every SDK with
 * backoff, every agent) hits this within days of launch.
 */

export interface Replay {
  statusCode: number;
  body: unknown;
}

const hashRequest = (method: string, path: string, body: unknown): string =>
  createHash('sha256').update(`${method}\n${path}\n${JSON.stringify(body ?? null)}`).digest('hex');

/**
 * Returns a stored response if this key was already used.
 *
 * Reusing a key with a DIFFERENT body is a client bug, not a retry — returning the old response
 * would silently ignore what was actually asked for, so it 409s instead.
 */
export async function checkReplay(
  orgId: string,
  key: string,
  method: string,
  path: string,
  body: unknown,
): Promise<Replay | null> {
  const rh = hashRequest(method, path, body);
  return withTenant(orgId, async (c) => {
    const { rows } = await c.query(
      'SELECT request_hash, status_code, response FROM idempotency_keys WHERE org_id = $1 AND key = $2',
      [orgId, key],
    );
    if (rows.length === 0) return null;
    if (rows[0].request_hash !== rh) {
      throw conflict(
        'idempotency_key_reuse',
        'This Idempotency-Key was already used with a different request body. Use a new key for a new request.',
      );
    }
    return { statusCode: rows[0].status_code, body: rows[0].response };
  });
}

export async function record(
  orgId: string,
  key: string,
  method: string,
  path: string,
  body: unknown,
  statusCode: number,
  response: unknown,
): Promise<void> {
  const rh = hashRequest(method, path, body);
  await withTenant(orgId, (c) =>
    c.query(
      `INSERT INTO idempotency_keys (org_id, key, request_hash, status_code, response)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, key) DO NOTHING`,
      [orgId, key, rh, statusCode, JSON.stringify(response)],
    ),
  );
}
