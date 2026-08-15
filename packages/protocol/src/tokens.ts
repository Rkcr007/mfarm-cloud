import { createPublicKey, verify } from 'node:crypto';

/**
 * Session token VERIFICATION only.
 *
 * Minting deliberately lives in the control plane and is not exported from this package. The worker
 * holds only the public key, so a compromised host can verify tokens but can never issue one for
 * itself or for any other host in the fleet. Keeping the two halves in different packages makes
 * that boundary structural rather than a convention someone can forget.
 */

export const TOKEN_ALG = 'v1';

export interface SessionClaims {
  sid: string;    // session id
  did: string;    // device id
  org: string;
  fence: number;  // must be >= the worker's high-water mark for this device
  aud: string;    // host id — a token minted for one worker is useless at another
  iat: number;
  exp: number;
}

export type VerifyResult =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_audience' };

export function verifySessionToken(
  token: string,
  publicKeyPem: string,
  expectedAudience?: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_ALG) return { ok: false, reason: 'malformed' };

  const payload = `${parts[0]}.${parts[1]}`;
  let sigOk = false;
  try {
    sigOk = verify(
      null,
      Buffer.from(payload),
      createPublicKey(publicKeyPem),
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  // Signature first, always: never parse or act on claims from an unverified token.
  if (!sigOk) return { ok: false, reason: 'bad_signature' };

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  if (expectedAudience && claims.aud !== expectedAudience) return { ok: false, reason: 'wrong_audience' };
  return { ok: true, claims };
}
