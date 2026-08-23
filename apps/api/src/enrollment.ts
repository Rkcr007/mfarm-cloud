import { randomBytes } from 'node:crypto';
import { withSystem, withTenant } from './db.ts';
import { sha256, safeEqualHex } from './auth.ts';

/**
 * Agent enrollment tokens — the bootstrap credential for a host nobody here administers.
 *
 * `WORKER_REGISTRATION_TOKEN` stays exactly as it is, and an operator-owned host keeps using it.
 * This is the second door, for the case that secret cannot serve: a laptop belonging to a teammate,
 * with a phone on the end of a USB cable. The differences from the fleet secret are the whole point
 * of the table — it expires, it is used once, it names the person who minted it and the org it
 * belongs to, and revoking it revokes one machine rather than the fleet.
 *
 * Redemption happens INSIDE the registration transaction (see `routes/workers.ts`), which is what
 * makes single-use real rather than advisory: the row is taken `FOR UPDATE` before the token is
 * compared, so two agents racing with the same token serialise and the second one loses.
 */

const PREFIX_LEN = 12;

/** Plaintext is returned exactly once, at creation. Only the hash is stored. */
export function generateEnrollmentToken(): { plaintext: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `mae_${secret}`;
  return { plaintext, prefix: plaintext.slice(0, PREFIX_LEN), hash: sha256(plaintext) };
}

export interface EnrollmentRow {
  prefix: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  usedAt: string | null;
  hostId: string | null;
}

export async function createEnrollment(
  orgId: string, createdBy: string | null, label: string | null, ttlHours: number,
): Promise<{ plaintext: string; prefix: string; expiresAt: string }> {
  const { plaintext, prefix, hash } = generateEnrollmentToken();
  const expiresAt = await withSystem(async (c) => {
    const { rows } = await c.query<{ expires_at: Date }>(
      `INSERT INTO agent_enrollments (org_id, prefix, token_hash, label, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6))
       RETURNING expires_at`,
      [orgId, prefix, hash, label, createdBy, ttlHours],
    );
    return rows[0].expires_at;
  });
  return { plaintext, prefix, expiresAt: expiresAt.toISOString() };
}

/**
 * Read on the TENANT pool, so the org scope is enforced by the policy rather than by this WHERE
 * clause. The explicit `org_id = $1` is belt and braces and is how every other tenant read here is
 * written; RLS is what makes it safe when someone eventually forgets it.
 */
export async function listEnrollments(orgId: string): Promise<EnrollmentRow[]> {
  return withTenant(orgId, async (c) => {
    const { rows } = await c.query(
      `SELECT prefix, label, created_at, expires_at, revoked_at, used_at, host_id
         FROM agent_enrollments
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [orgId],
    );
    return rows.map((r) => ({
      prefix: r.prefix,
      label: r.label,
      createdAt: r.created_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
      usedAt: r.used_at ? r.used_at.toISOString() : null,
      hostId: r.host_id,
    }));
  });
}

export async function revokeEnrollment(orgId: string, prefix: string): Promise<boolean> {
  return withSystem(async (c) => {
    const r = await c.query(
      `UPDATE agent_enrollments SET revoked_at = now()
        WHERE org_id = $1 AND prefix = $2 AND revoked_at IS NULL`,
      [orgId, prefix],
    );
    return (r.rowCount ?? 0) > 0;
  });
}

export type RedeemResult =
  | { ok: true; enrollmentId: string; orgId: string }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' | 'already_used' | 'bad_token' };

/**
 * Validate and LOCK an enrollment token. Call inside the registration transaction, before the host
 * row is written; `markRedeemed` closes it once the host id exists.
 *
 * Split in two rather than done in one UPDATE because a single conditional UPDATE that matched on
 * the hash would have to consume the row to find out the token was wrong — so a stranger spraying
 * guesses at a valid prefix would burn a legitimate enrollment. Taking the row `FOR UPDATE` and
 * comparing afterwards costs one extra statement and cannot do that.
 *
 * Every failure returns the same shape and the caller collapses them into one message. The reasons
 * are for the server log: a person who has just pasted a token wants "this token is not valid",
 * and an attacker should not be told whether a prefix exists.
 */
export async function redeemEnrollment(
  c: { query: (q: string, v?: unknown[]) => Promise<{ rows: any[] }> },
  presented: string,
): Promise<RedeemResult> {
  if (!presented.startsWith('mae_') || presented.length < PREFIX_LEN) return { ok: false, reason: 'unknown' };
  const prefix = presented.slice(0, PREFIX_LEN);

  const { rows } = await c.query(
    `SELECT id, org_id, token_hash, revoked_at, used_at, expires_at <= now() AS expired
       FROM agent_enrollments WHERE prefix = $1 FOR UPDATE`,
    [prefix],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };

  // Signature first, always: never act on a row selected by an unverified credential. The state
  // checks below leak whether a prefix exists, so they only run once the secret has matched.
  if (!safeEqualHex(sha256(presented), row.token_hash)) return { ok: false, reason: 'bad_token' };

  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.used_at) return { ok: false, reason: 'already_used' };
  if (row.expired) return { ok: false, reason: 'expired' };

  return { ok: true, enrollmentId: row.id, orgId: row.org_id };
}

/** Close the one-shot, naming the host it produced. Same transaction as `redeemEnrollment`. */
export async function markRedeemed(
  c: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  enrollmentId: string, hostId: string,
): Promise<void> {
  await c.query(
    'UPDATE agent_enrollments SET used_at = now(), host_id = $2 WHERE id = $1',
    [enrollmentId, hostId],
  );
}
