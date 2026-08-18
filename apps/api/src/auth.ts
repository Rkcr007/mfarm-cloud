import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withSystem } from './db.ts';

/**
 * Credential handling.
 *
 * Two principal types that must never be interchangeable: a TENANT acts on its own org's data, a
 * WORKER acts on the fleet. A worker credential cannot read tenant data and a tenant key cannot
 * register a host. Routes declare which they require; there is no "any authenticated caller" tier.
 */

export type Principal =
  | { kind: 'tenant'; orgId: string; keyId: string }
  | { kind: 'worker'; hostId: string; region: string }
  // A logged-in person, from `users.ts`. Structurally identical to `SessionPrincipal` there and
  // restated rather than imported, because users.ts already imports this module and a cycle between
  // the two would be a worse price than one duplicated shape.
  | { kind: 'user'; userId: string; orgId: string; role: string; sessionId: string; csrf: string };

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
function safeEqualHex(a: string, b: string): boolean {
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
        `SELECT id, org_id, key_hash FROM api_keys
          WHERE prefix = $1 AND revoked_at IS NULL`,
        [prefix],
      );
      if (rows.length === 0) return null;
      if (!safeEqualHex(rows[0].key_hash, presented)) return null;
      return { kind: 'tenant', orgId: rows[0].org_id, keyId: rows[0].id } satisfies Principal;
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

/** Issue a tenant API key. Returns the plaintext once; it is unrecoverable afterwards. */
export async function createApiKey(orgId: string): Promise<{ plaintext: string; prefix: string }> {
  const { plaintext, prefix, hash } = generateApiKey();
  await withSystem((c) =>
    c.query('INSERT INTO api_keys (org_id, prefix, key_hash) VALUES ($1, $2, $3)', [
      orgId, prefix, hash,
    ]),
  );
  return { plaintext, prefix };
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
