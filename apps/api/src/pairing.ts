import { randomBytes, randomInt } from 'node:crypto';
import { withSystem } from './db.ts';
import { sha256 } from './auth.ts';
import { generateEnrollmentToken } from './enrollment.ts';

/**
 * Pairing a machine by reading a code off its screen — ADR-0014.
 *
 * The agent asks for a pairing and displays the short code it gets back. A signed-in admin types
 * that code into the console. The agent polls, and once the code is approved its poll returns a
 * freshly minted `mae_` enrollment token — the same credential `POST /v1/account/agent-enrollments`
 * has always produced, obtained without anybody driving curl with a cookie jar.
 *
 * TWO SECRETS, DOING DIFFERENT JOBS, and keeping them apart is the design:
 *
 *   `userCode`   — eight characters a human reads and types. Low entropy by necessity, so it is
 *                  short-lived, rate limited, and worth NOTHING on its own: it only ever grants
 *                  anything when an authenticated admin redeems it, and what it grants is decided
 *                  by that admin's org, never by the code.
 *   `deviceCode` — 32 random bytes, returned once to the agent, never displayed. It is what
 *                  authenticates the poll, so it is a credential of the same weight as the `mae_`
 *                  token that poll returns.
 *
 * NOTHING COLLECTABLE IS STORED. The enrollment token is minted at poll time inside the same
 * statement that marks the pairing collected, so there is no window in which a usable credential
 * sits in the table waiting for whoever reads it first. Both secrets above are stored as sha256.
 */

/**
 * The alphabet a person reads off a screen and types into another window.
 *
 * Crockford-style: no `0`/`O`, no `1`/`I`/`L`, no `U` (which is how `V` is misread in some faces).
 * That leaves 30 characters, so eight of them is 30^8 — about 6.6e11, near 2^39.
 *
 * NOT PADDED BACK UP TO 32. The obvious way to reach a round power of two is to add two symbols,
 * and both candidates (`*`, `+`) are characters nobody should have to find on a keyboard to pair a
 * laptop. The half-bit is not worth it; the TTL and the rate limit are what make guessing pointless,
 * not the difference between 2^39 and 2^40.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 8;

/** How long a pending pairing lives. Longer than reading eight characters; shorter than useful. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** What the agent is told to wait between polls — RFC 8628's `interval`, in seconds. */
export const POLL_INTERVAL_SECONDS = 5;

/**
 * `randomInt`, not `randomBytes(1) % 32`.
 *
 * The modulo form is the classic biased-sampling bug. It happens to be unbiased here because 256 is
 * a multiple of 32 — which is exactly why it is the wrong habit to write down: the next person to
 * change the alphabet to 33 characters introduces a bias no test would catch.
 */
function userCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LEN; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * What a person typed, reduced to what was generated.
 *
 * Case is folded and the separators we ourselves displayed are removed, so `abcd-efgh`,
 * `ABCD EFGH` and `ABCDEFGH` are one code. That much leniency is not a kindness — the code is
 * DISPLAYED with a dash, and refusing the thing we printed would be a bug the user gets blamed for.
 *
 * EVERYTHING ELSE IS KEPT so that it fails the length check. Stripping unknown characters instead
 * looks more forgiving and is wrong: it would silently turn `ABCDOEFGH` into the valid, different
 * code `ABCDEFGH`, so a misread `O` would pair a machine the user never looked at rather than
 * telling them the code was not valid.
 */
export function normalizeUserCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/** Whether a normalized string could be a code at all — the cheap check before any query. */
const isCodeShaped = (code: string): boolean =>
  code.length === CODE_LEN && [...code].every((ch) => ALPHABET.includes(ch));

/** Display form. The dash is presentation only and is stripped before anything is compared. */
export const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export interface PendingPairing {
  /** Returned once, to the agent. Never displayed, never logged. */
  deviceCode: string;
  /** Shown to the human, already formatted. */
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface PairingDescription {
  hostname: string | null;
  platform: string | null;
  agentVersion: string | null;
  requestedAt: string;
  expiresAt: string;
  /** True once an admin has approved it and the agent has not yet collected its token. */
  approved: boolean;
}

/** Self-reported by an unauthenticated caller, so it is bounded before it is ever stored. */
const describe = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().slice(0, 120);
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Start a pairing. Unauthenticated — the agent has no credential yet; obtaining one is the point.
 *
 * Sweeping expired rows here rather than on a timer. The table only grows when somebody starts a
 * pairing, so the moment a row is created is exactly the moment the last ones are worth clearing,
 * and it needs no second scheduled job to go wrong quietly. Pending rows only: an approved-and-
 * collected pairing is history and answers "did that laptop ever finish?".
 */
export async function startPairing(desc: {
  hostname?: unknown; platform?: unknown; agentVersion?: unknown;
}): Promise<PendingPairing> {
  const deviceCode = randomBytes(32).toString('base64url');

  return withSystem(async (c) => {
    await c.query(
      'DELETE FROM agent_pairings WHERE expires_at < now() AND collected_at IS NULL',
    );

    /**
     * Retry on collision. The code space is 2^40 and the live population is tiny, so this
     * effectively never fires — but `user_code_hash` is UNIQUE, and the alternative to retrying is
     * a 500 handed to somebody whose only mistake was timing.
     */
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = userCode();
      try {
        const { rows } = await c.query<{ expires_at: Date }>(
          `INSERT INTO agent_pairings
             (user_code_hash, device_code_hash, hostname, platform, agent_version, expires_at)
           VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))
           RETURNING expires_at`,
          [
            sha256(code), sha256(deviceCode),
            describe(desc.hostname), describe(desc.platform), describe(desc.agentVersion),
            PAIRING_TTL_MS / 1000,
          ],
        );
        return {
          deviceCode,
          userCode: formatUserCode(code),
          expiresAt: rows[0].expires_at.toISOString(),
          intervalSeconds: POLL_INTERVAL_SECONDS,
        };
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;   // unique_violation
      }
    }
    throw new Error('could not allocate a pairing code');
  });
}

export type LookupResult =
  | { ok: true; pairing: PairingDescription }
  | { ok: false; reason: 'unknown' | 'expired' | 'already_collected' };

/**
 * What is this code, without approving it — ADR-0014 §2.
 *
 * The flow's one real weakness is somebody being talked into typing an attacker's code into their
 * own console. Naming the machine before asking for confirmation is what gives them the chance to
 * notice, so approval is deliberately two calls rather than one.
 *
 * `unknown` covers "never existed", "already expired and swept" and "mistyped" alike. The caller
 * collapses every reason into one message: a person who mistyped wants to be told the code is not
 * valid, and telling anyone which codes exist is the one thing this must not do.
 */
export async function lookupPairing(rawCode: string): Promise<LookupResult> {
  const code = normalizeUserCode(rawCode);
  if (!isCodeShaped(code)) return { ok: false, reason: 'unknown' };

  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT hostname, platform, agent_version, created_at, expires_at,
              approved_at, collected_at, expires_at <= now() AS expired
         FROM agent_pairings WHERE user_code_hash = $1`,
      [sha256(code)],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: 'unknown' as const };
    if (row.collected_at) return { ok: false, reason: 'already_collected' as const };
    if (row.expired) return { ok: false, reason: 'expired' as const };
    return {
      ok: true as const,
      pairing: {
        hostname: row.hostname,
        platform: row.platform,
        agentVersion: row.agent_version,
        requestedAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        approved: row.approved_at !== null,
      },
    };
  });
}

export type ApproveResult =
  | { ok: true; pairing: PairingDescription }
  | { ok: false; reason: 'unknown' | 'expired' | 'already_collected' | 'already_approved' };

/**
 * Approve a pairing, binding it to the approver's org.
 *
 * THE ORG COMES FROM THE SESSION, never from anything the agent said. That is the whole security
 * argument of ADR-0014 §1: the code proves possession of a machine, and the identity it is
 * attached to is the authenticated user's.
 *
 * Conditional on `approved_at IS NULL` in the statement itself rather than checked first, so two
 * admins racing on the same code produce one approval and one `already_approved` instead of the
 * second silently overwriting the first's org.
 */
export async function approvePairing(
  rawCode: string, orgId: string, userId: string | null,
): Promise<ApproveResult> {
  const code = normalizeUserCode(rawCode);
  if (!isCodeShaped(code)) return { ok: false, reason: 'unknown' };

  return withSystem(async (c) => {
    const { rows } = await c.query(
      `UPDATE agent_pairings
          SET approved_at = now(), org_id = $2, approved_by = $3
        WHERE user_code_hash = $1
          AND approved_at IS NULL
          AND collected_at IS NULL
          AND expires_at > now()
      RETURNING hostname, platform, agent_version, created_at, expires_at`,
      [sha256(code), orgId, userId],
    );
    if (rows[0]) {
      const r = rows[0];
      return {
        ok: true as const,
        pairing: {
          hostname: r.hostname, platform: r.platform, agentVersion: r.agent_version,
          requestedAt: r.created_at.toISOString(),
          expiresAt: r.expires_at.toISOString(),
          approved: true,
        },
      };
    }
    // Nothing updated. Read once to say WHY, which is worth one extra statement here: "that code is
    // already in use" and "that code has expired" are different things for the person to do next.
    const seen = await lookupPairing(code);
    if (seen.ok) return { ok: false as const, reason: 'already_approved' as const };
    return { ok: false as const, reason: seen.reason };
  });
}

export type CollectResult =
  | { ok: true; status: 'pending'; intervalSeconds: number }
  | { ok: true; status: 'approved'; token: string; orgId: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'already_collected' };

/**
 * The agent's poll. Unauthenticated, and authenticated by the device code it presents.
 *
 * THE ENROLLMENT TOKEN IS MINTED HERE, not at approval, and that is deliberate. Minting at approval
 * would leave a usable `mae_` plaintext resting somewhere until the agent came for it — either in
 * this table or in some side channel — and there is no good place to put it. Minting on collection
 * means the credential exists only in the response that carries it.
 *
 * SINGLE USE IS ENFORCED BY THE UPDATE, not by a check before it. `collected_at IS NULL` is in the
 * WHERE clause, so two polls racing serialise on the row and exactly one of them mints anything.
 * A conditional read followed by a write would let both through.
 *
 * One transaction, because a token minted for a pairing that then failed to mark itself collected
 * would be an enrollment nobody can account for.
 */
export async function collectPairing(deviceCode: string): Promise<CollectResult> {
  if (typeof deviceCode !== 'string' || deviceCode.length < 16) {
    return { ok: false, reason: 'unknown' };
  }

  return withSystem(async (c) => {
    await c.query('BEGIN');
    try {
      const { rows } = await c.query(
        `SELECT id, org_id, approved_at, collected_at, expires_at <= now() AS expired
           FROM agent_pairings WHERE device_code_hash = $1 FOR UPDATE`,
        [sha256(deviceCode)],
      );
      const row = rows[0];
      if (!row) { await c.query('ROLLBACK'); return { ok: false as const, reason: 'unknown' as const }; }
      if (row.collected_at) { await c.query('ROLLBACK'); return { ok: false as const, reason: 'already_collected' as const }; }

      /**
       * EXPIRY IS CHECKED BEFORE APPROVAL, and only for a pairing nobody approved.
       *
       * An approved pairing that ages out between the admin's click and the agent's next poll must
       * still be collectable — the TTL exists to bound how long an UNCLAIMED code is guessable, and
       * once a human has approved it that window is closed. Expiring it here instead would mean an
       * admin approving at 9:59 and an agent polling at 10:01 fails with nothing to show for it.
       */
      if (!row.approved_at && row.expired) {
        await c.query('ROLLBACK');
        return { ok: false as const, reason: 'expired' as const };
      }
      if (!row.approved_at) {
        await c.query('ROLLBACK');
        return { ok: true as const, status: 'pending' as const, intervalSeconds: POLL_INTERVAL_SECONDS };
      }

      const { plaintext, prefix, hash } = generateEnrollmentToken();
      await c.query(
        `INSERT INTO agent_enrollments
           (org_id, prefix, token_hash, label, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => 1))`,
        [
          row.org_id, prefix, hash,
          // The label is what an admin sees in the enrollment list, so it should say where this one
          // came from rather than leave a mystery row beside the hand-minted ones.
          'paired from the agent window',
          null,
        ],
      );
      await c.query('UPDATE agent_pairings SET collected_at = now() WHERE id = $1', [row.id]);
      await c.query('COMMIT');
      return { ok: true as const, status: 'approved' as const, token: plaintext, orgId: row.org_id as string };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}
