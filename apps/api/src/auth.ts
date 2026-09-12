import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withSystem } from './db.ts';

/**
 * Credential handling.
 *
 * Two principal types that must never be interchangeable: a TENANT acts on its own org's data, a
 * WORKER acts on the fleet. A worker credential cannot read tenant data and a tenant key cannot
 * register a host. Routes declare which they require; there is no "any authenticated caller" tier.
 */

/**
 * What an API key may do (migration 049).
 *
 * `automation` is what a CI job needs and nothing more; `full` is what every key could do before
 * this existed. The one thing the pair actually gates is evidence deletion — see the migration for
 * why that is the honest boundary and a capability matrix is not.
 */
export type KeyScope = 'automation' | 'full';

export type Principal =
  // `scope` is absent for a signed-in person on purpose: a human's authority comes from their
  // membership role, and giving them a key scope would invite code to check the wrong one.
  | { kind: 'tenant'; orgId: string; keyId: string; scope: KeyScope }
  | { kind: 'worker'; hostId: string; region: string }
  // A logged-in person, from `users.ts`. Structurally identical to `SessionPrincipal` there and
  // restated rather than imported, because users.ts already imports this module and a cycle between
  // the two would be a worse price than one duplicated shape.
  | { kind: 'user'; userId: string; orgId: string; role: string; sessionId: string; csrf: string;
      /** Fleet operator (migration 053). Orthogonal to `role`, which is per-org. */
      operator: boolean };

const KEY_PREFIX_LEN = 12;

/** Plaintext is returned exactly once, at creation. Only the hash is ever stored. */
export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  // 32 bytes of entropy; base64url so the whole key is one copy-pasteable token
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `mfk_${secret}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, KEY_PREFIX_LEN),
    hash: sha256(plaintext),
  };
}

export function generateWorkerToken(): { plaintext: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `mwk_${secret}`;
  return { plaintext, prefix: plaintext.slice(0, KEY_PREFIX_LEN), hash: sha256(plaintext) };
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Compare two hex digests without leaking length or content through timing.
 * Both operands are fixed-length sha256 output, so a length mismatch means malformed input, not a
 * near-miss guess — reject it rather than padding.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Pull a tenant key out of HTTP Basic credentials.
 *
 * This exists for the WebDriver hub. A WebDriver client is given exactly one thing — a URL — and
 * every incumbent solves it the same way: `https://<key>@hub.example.com/wd/hub`. Every HTTP client
 * turns that into a Basic header, which is why "migration is one URL change" is achievable at all.
 * Over TLS it is a bearer token in a different envelope.
 *
 * Either field may carry the key, because clients disagree about which half of `user:pass` a
 * credential belongs in. WORKER tokens are deliberately not accepted here: workers never live in a
 * URL, so allowing it would only widen where a fleet credential can appear.
 */
function basicParts(header: string): string[] | null {
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  return sep === -1 ? [decoded] : [decoded.slice(0, sep), decoded.slice(sep + 1)];
}

function tenantKeyFromBasic(header: string): string | null {
  return basicParts(header)?.find((p) => p.startsWith('mfk_')) ?? null;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The mfarm session id a WebDriver URL is carrying, if it is carrying one.
 *
 * `https://<api-key>:<session-id>@hub.mfarm.dev/wd/hub` — the key in the username half, the session
 * to bind to in the password half. It looks like an odd place to put it, and it is the only place
 * that works: a WebDriver client is handed exactly one string and offers no other hook, the path is
 * fixed by the protocol, and a query string does not survive the naive `base + '/session'`
 * concatenation most clients do. So the second Basic field — which carries nothing today, because
 * the key alone is the credential — is the seam.
 *
 * This is what closes ADR-0002 D1 without asking anyone to edit a test suite: `mfarm run` allocates
 * once and puts the session id here, and the hub drives that device instead of allocating a second
 * one. It is not a credential and grants nothing on its own: the key still has to authenticate, and
 * the session still has to belong to the org that key resolves to.
 *
 * Anything that is not a uuid is ignored rather than rejected — plenty of clients put a placeholder
 * in the password field, and failing their first request over it would be a poor welcome.
 */
export function sessionBindingFromBasic(header: string | undefined): string | undefined {
  if (!header?.startsWith('Basic ')) return undefined;
  const candidate = basicParts(header)?.find((p) => !p.startsWith('mfk_') && SESSION_ID.test(p));
  return candidate ?? undefined;
}

/**
 * Resolve a credential to a principal, or null.
 *
 * Runs on the SYSTEM pool deliberately: api_keys is RLS-protected by org_id, and we do not know the
 * org until after the lookup succeeds. Authentication is the one place that legitimately precedes
 * tenant scope. Everything downstream of it must use withTenant.
 */
export async function authenticate(bearer: string | undefined): Promise<Principal | null> {
  if (!bearer) return null;
  const token = bearer.startsWith('Basic ')
    ? tenantKeyFromBasic(bearer) ?? ''
    : bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : bearer.trim();
  if (token.length < KEY_PREFIX_LEN + 8) return null;

  const prefix = token.slice(0, KEY_PREFIX_LEN);
  const presented = sha256(token);

  if (token.startsWith('mfk_')) {
    return withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT id, org_id, key_hash, scope, expires_at, last_used_at FROM api_keys
          WHERE prefix = $1 AND revoked_at IS NULL`,
        [prefix],
      );
      if (rows.length === 0) return null;
      if (!safeEqualHex(rows[0].key_hash, presented)) return null;

      /**
       * AN EXPIRED KEY AUTHENTICATES AS NOTHING, not as a refused principal (migration 049).
       *
       * Returning null means the presenter gets exactly the answer a presenter of nonsense gets. A
       * 403 reading "that key expired on the 3rd" would confirm the key was real, which is a fact
       * worth having if you found it in a log and do not know whether it is worth trying elsewhere.
       *
       * Compared in the application rather than in the WHERE clause so that the row is still read:
       * a future audit trail wants to know that an expired key was PRESENTED, which a query that
       * filtered it out could never report.
       */
      const expiresAt: Date | null = rows[0].expires_at;
      if (expiresAt && expiresAt.getTime() <= Date.now()) return null;

      await touchKey(c, rows[0].id, rows[0].last_used_at);

      return {
        kind: 'tenant',
        orgId: rows[0].org_id,
        keyId: rows[0].id,
        // A row written before 049's default, or by hand, still has to produce a valid scope rather
        // than `undefined` leaking into an authorization check.
        scope: rows[0].scope === 'automation' ? 'automation' : 'full',
      } satisfies Principal;
    });
  }

  if (token.startsWith('mwk_')) {
    return withSystem(async (c) => {
      const { rows } = await c.query(
        `SELECT id, region, token_hash, state FROM hosts WHERE token_prefix = $1`,
        [prefix],
      );
      if (rows.length === 0) return null;
      if (!safeEqualHex(rows[0].token_hash, presented)) return null;
      // A quarantined host may still report in — that is how it tells us it recovered. It just
      // cannot be scheduled, which the allocator enforces separately.
      return { kind: 'worker', hostId: rows[0].id, region: rows[0].region } satisfies Principal;
    });
  }

  return null;
}

/**
 * How stale `last_used_at` is allowed to get.
 *
 * THE POINT OF THE COLUMN IS "is anything still using this key", and five minutes is far finer than
 * that question needs. Writing it on every request would put an UPDATE on every authenticated call
 * — including every WebDriver command the hub proxies, which is hundreds per minute per running
 * session — to sharpen a value nobody reads at that resolution.
 */
const LAST_USED_STALE_MS = 5 * 60_000;

/**
 * Record that a key was used, at most once every `LAST_USED_STALE_MS`.
 *
 * FAILURE HERE MUST NOT COST THE REQUEST ITS AUTHENTICATION. This is bookkeeping: if the UPDATE
 * fails the caller still presented a valid credential, and refusing them would turn a full disk
 * into an outage of the whole API. Swallowed deliberately, and the write is fire-and-forget for the
 * same reason — authentication is on the hot path of every request in the system.
 */
async function touchKey(
  c: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  keyId: string,
  lastUsedAt: Date | null,
): Promise<void> {
  if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_STALE_MS) return;
  try {
    await c.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [keyId]);
  } catch { /* bookkeeping; never worth failing a valid credential over */ }
}

/**
 * Issue a tenant API key. Returns the plaintext once; it is unrecoverable afterwards.
 *
 * `label` is required by the signature as well as by the column, so that a caller cannot mint an
 * anonymous key by omitting an argument — which is exactly how the console produced four of them.
 */
export async function createApiKey(
  orgId: string,
  label: string,
  opts: { scope?: KeyScope; expiresAt?: Date | null; createdBy?: string | null } = {},
): Promise<{ plaintext: string; prefix: string; scope: KeyScope; expiresAt: Date | null }> {
  const { plaintext, prefix, hash } = generateApiKey();
  const scope: KeyScope = opts.scope ?? 'automation';
  const expiresAt = opts.expiresAt ?? null;
  await withSystem((c) =>
    c.query(
      `INSERT INTO api_keys (org_id, prefix, key_hash, label, scope, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, prefix, hash, label, scope, expiresAt, opts.createdBy ?? null],
    ),
  );
  return { plaintext, prefix, scope, expiresAt };
}

export async function revokeApiKey(orgId: string, prefix: string): Promise<boolean> {
  return withSystem(async (c) => {
    const r = await c.query(
      'UPDATE api_keys SET revoked_at = now() WHERE org_id = $1 AND prefix = $2 AND revoked_at IS NULL',
      [orgId, prefix],
    );
    return (r.rowCount ?? 0) > 0;
  });
}
