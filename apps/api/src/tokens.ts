import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { TOKEN_ALG, type SessionClaims } from '@mfarm/protocol';

// Verification lives in @mfarm/protocol because workers need it and must never have the minting
// half. Re-exported here so callers in this app have one import site.
export { verifySessionToken, type SessionClaims, type VerifyResult } from '@mfarm/protocol';

/**
 * Session tokens — the mechanism behind v2 decision 2.
 *
 * The control plane authorises, then gets out of the way: it mints a short-lived token and returns
 * the worker's endpoint. The browser connects DIRECTLY to the worker, which verifies the token
 * offline. No callback to the API on the hot path, so p99 input latency never depends on the
 * control plane's availability or its garbage collector.
 *
 * Ed25519 rather than HMAC on purpose. With a shared secret, every worker can MINT tokens, so one
 * compromised host in a rack forges access to the whole fleet. With a signing key, workers hold only
 * the public half and can verify but never issue.
 */

/** Long enough to survive a slow page load, short enough that a leaked token is near-worthless. */
export const DEFAULT_TTL_SECONDS = 120;

export interface Keypair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateKeypair(): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const b64u = (b: Buffer) => b.toString('base64url');

export function mintSessionToken(
  claims: Omit<SessionClaims, 'iat' | 'exp'>,
  privateKeyPem: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: SessionClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const body = b64u(Buffer.from(JSON.stringify(full)));
  const payload = `${TOKEN_ALG}.${body}`;
  const sig = sign(null, Buffer.from(payload), createPrivateKey(privateKeyPem));
  return `${payload}.${b64u(sig)}`;
}



/**
 * Signing key for this process. In production this comes from a secret manager and rotates; the
 * ephemeral fallback exists so local dev and tests need no setup, and it is deliberately loud about
 * being ephemeral rather than silently generating a key that changes on every restart.
 */
export function loadSigningKey(): Keypair {
  const priv = process.env.SESSION_SIGNING_KEY;
  const pub = process.env.SESSION_PUBLIC_KEY;
  if (priv && pub) return { privateKeyPem: priv, publicKeyPem: pub };
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SIGNING_KEY and SESSION_PUBLIC_KEY are required in production');
  }
  const kp = generateKeypair();
  console.warn('[tokens] no SESSION_SIGNING_KEY set — generated an ephemeral keypair (dev only)');
  return kp;
}
