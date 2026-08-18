import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sha256 } from './auth.ts';
import { withSystem } from './db.ts';

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Human authentication: passwords and browser sessions.
 *
 * Kept out of `auth.ts` on purpose. That module is about MACHINE credentials — an org-wide API key
 * and a worker token, both bearer strings handed to a program. This one is about a person, and the
 * differences are not cosmetic: a password is low-entropy and must be slow to verify, a browser
 * attaches its cookie to requests the user did not intend, and a person can be removed from an org
 * while a program's key stays valid. Every rule below follows from one of those three.
 */

/**
 * scrypt parameters. N=2^15 with r=8 costs ~32 MB and ~100ms per verification here, which is the
 * point: it is the only defence that survives the database itself leaking.
 *
 * The cost is stored INSIDE each digest, so raising N later is not a flag day — an old digest still
 * verifies under its own parameters, and `login` rewrites it at the new cost on the next success.
 */
const SCRYPT_N = 32768, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;
// scrypt's default maxmem (32 MB) is exactly at the limit for these parameters and node rejects the
// call rather than rounding; give it room so the cost is chosen here rather than by a default.
const MAXMEM = 128 * 1024 * 1024;

/** A browser session outlives a working day and not much more. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'mfarm_session';
export const CSRF_HEADER = 'x-mfarm-csrf';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Verify a password against a stored digest.
 *
 * Returns false for anything it cannot parse rather than throwing: a malformed digest is a corrupt
 * row, and the safe reading of a corrupt credential is "does not authenticate".
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const N = Number(n), R = Number(r), P = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P)) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N, r: R, p: P, maxmem: MAXMEM,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a digest was made with parameters weaker than the current ones and should be rewritten. */
function isStale(stored: string): boolean {
  const parts = stored.split('$');
  return parts.length !== 6 || Number(parts[1]) < SCRYPT_N;
}

export interface UserSession {
  /** The cookie value. Returned once, at creation; only its hash is stored. */
  token: string;
  /** Double-submitted by the UI in `x-mfarm-csrf`. Also returned once. */
  csrf: string;
  sessionId: string;
  orgId: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Authenticate a person and mint a browser session.
 *
 * Returns null for a bad email, a bad password, a user with no password set, and a user with no
 * membership — deliberately indistinguishable to the caller. Telling them apart is an account
 * enumeration oracle, and the one place it is worth spending a needless 100ms is here: a missing
 * user still costs a scrypt verification against a dummy digest, so "no such account" and "wrong
 * password" do not differ in timing either.
 */
export async function login(email: string, password: string, orgSlug?: string): Promise<UserSession | null> {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT u.id, u.password_hash, u.credential_epoch, m.org_id, m.role, o.slug
         FROM users u
         JOIN memberships m ON m.user_id = u.id
         JOIN orgs o ON o.id = m.org_id
        WHERE lower(u.email) = lower($1)
        ORDER BY (o.slug = $2) DESC, m.role = 'owner' DESC`,
      [email, orgSlug ?? null],
    );

    if (rows.length === 0) {
      // Constant-ish work for an unknown account. The digest is real, so the cost is real.
      await verifyPassword(password, DUMMY_DIGEST);
      return null;
    }

    const row = rows[0];
    if (!(await verifyPassword(password, row.password_hash))) return null;

    // Opportunistic upgrade: the user just proved the password, so this is the only moment the
    // plaintext is available to re-hash at the current cost.
    if (isStale(row.password_hash)) {
      const rehashed = await hashPassword(password);
      await c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [rehashed, row.id]);
    }

    return mintSession(c, row.id, row.org_id, row.credential_epoch);
  });
}

/** A real digest of a value nobody holds, so the unknown-account path costs what the known one does. */
const DUMMY_DIGEST =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'D8F4CqQb4dHCg9RfP3RUgm3aVYq9L2mrn9wOCZ0P8FiNQIP1kkRPP9kEtV0DHFAcbaCkzs7z2eK2rTNPvOZucg==';

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

async function mintSession(c: Queryable, userId: string, orgId: string, epoch: number): Promise<UserSession> {
  const token = `mus_${randomBytes(32).toString('base64url')}`;
  const csrf = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const { rows } = await c.query(
    `INSERT INTO user_sessions (user_id, org_id, token_hash, csrf, epoch, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, orgId, sha256(token), csrf, epoch, expiresAt],
  );
  return { token, csrf, sessionId: rows[0].id, orgId, userId, expiresAt };
}

export interface SessionPrincipal {
  kind: 'user';
  userId: string;
  orgId: string;
  role: string;
  sessionId: string;
  /** The CSRF value this session was minted with, compared against the request header. */
  csrf: string;
}

/**
 * Resolve a session cookie to a principal, or null.
 *
 * Four ways a row can exist and still not authenticate, and each is a real event rather than a
 * defensive flourish: revoked (an explicit logout), expired (time), a membership that no longer
 * exists (removed from the org), and an epoch behind the user's (password changed elsewhere). The
 * last two are why this joins rather than trusting the session's own org_id: a session must not
 * outlive the authority it was minted from.
 */
export async function authenticateSession(token: string | undefined): Promise<SessionPrincipal | null> {
  if (!token?.startsWith('mus_')) return null;
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `SELECT s.id, s.user_id, s.org_id, s.csrf, s.epoch, m.role, u.credential_epoch
         FROM user_sessions s
         JOIN memberships m ON m.user_id = s.user_id AND m.org_id = s.org_id
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.epoch !== row.credential_epoch) return null;

    // Cheap liveness for "when did this person last use the product", written outside any tenant
    // transaction so it cannot fail a request that was otherwise fine.
    await c.query('UPDATE user_sessions SET last_seen_at = now() WHERE id = $1', [row.id])
      .catch(() => {});

    return {
      kind: 'user',
      userId: row.user_id,
      orgId: row.org_id,
      role: row.role,
      sessionId: row.id,
      csrf: row.csrf,
    };
  });
}

export async function logout(sessionId: string): Promise<void> {
  await withSystem((c) =>
    c.query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]),
  );
}

/**
 * Create a person who can log in, and put them in an org.
 *
 * Idempotent on email so that seeding a farm twice does not fail, and so an operator can reset a
 * forgotten password with the same command they created the account with. The epoch bump on a
 * password change is what makes that safe: every session minted under the old password stops
 * authenticating at the next request.
 */
export async function upsertUser(
  email: string, password: string, orgId: string, role: 'owner' | 'admin' | 'member' = 'member',
): Promise<{ userId: string; created: boolean }> {
  const digest = await hashPassword(password);
  return withSystem(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (email, password_hash)
       VALUES (lower($1), $2)
       ON CONFLICT (lower(email)) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             credential_epoch = users.credential_epoch + 1
       RETURNING id, (xmax = 0) AS created`,
      [email, digest],
    );
    const userId = rows[0].id;
    await c.query(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [orgId, userId, role],
    );
    return { userId, created: rows[0].created };
  });
}

/** Delete sessions that expired long enough ago to be of no forensic use. */
export async function sweepExpiredSessions(olderThanMs = SESSION_TTL_MS): Promise<number> {
  return withSystem(async (c) => {
    const r = await c.query(
      `DELETE FROM user_sessions WHERE expires_at < now() - make_interval(secs => $1)`,
      [Math.round(olderThanMs / 1000)],
    );
    return r.rowCount ?? 0;
  });
}

/**
 * Parse a Cookie header. Written here rather than pulled in as a dependency because the whole job
 * is one split, and a cookie parser is a poor thing to take a supply-chain risk on.
 */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Serialise the session cookie.
 *
 * `HttpOnly` so script cannot read it, `SameSite=Strict` so the browser does not attach it to a
 * request another site initiated — which is most of CSRF closed before the token check runs at all —
 * and `Secure` whenever the deployment has TLS. It is left off only for a plain-HTTP local farm,
 * because a cookie the browser refuses to send is indistinguishable from a broken login.
 */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
    `Expires=${expiresAt.toUTCString()}`,
  ].filter(Boolean).join('; ');
}

export function clearedCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].filter(Boolean).join('; ');
}
