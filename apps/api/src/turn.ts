import { createHmac } from 'node:crypto';
import type { Config } from './config.ts';

/**
 * Per-session TURN credentials (ADR-0005, ADR-0007).
 *
 * This is coturn's `use-auth-secret` scheme, and the reason for it is that TURN's own credential
 * model is a username and a password in a config file — a static, fleet-wide, non-expiring secret
 * that every viewer would have to be handed in a page a browser can read. Instead the username is a
 * unix expiry timestamp and the password is `HMAC-SHA1(secret, username)`, which coturn recomputes
 * itself. Nothing is stored anywhere, nothing is revoked, and a credential a viewer keeps is worth
 * nothing after `ttl` seconds.
 *
 * WHAT THIS IS NOT. It is not authorisation to drive a device — that is the Ed25519 grant the
 * worker verifies, and ADR-0005 says so outright: the relay is a route. A stolen TURN credential
 * buys someone bandwidth through the relay for a few hours. It does not name a device, so it opens
 * no session and reaches no screen.
 *
 * The session id is folded into the username anyway. coturn does not check it, but it is what turns
 * a relay access log into something that can answer "which session used this bandwidth", which is
 * the one operational question ADR-0005 flagged as unanswered.
 */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceBlock {
  iceServers: IceServer[];
  expiresInSeconds: number;
}

/**
 * The secret is passed in rather than read from `Config`, and that is deliberate twice over.
 *
 * `describeConfig()` is logged at startup, so every field on the config object is a field that ends
 * up in a log — `turnSecretSource` reports whether one exists, which is the part worth logging.
 * And taking the environment as an argument is how `parseConfig` is written for exactly the same
 * reason: a module that reads `process.env` at call time behind a cache cannot be tested.
 */
export type TurnConfig = Pick<Config, 'turnUrls' | 'turnTtlSeconds'>;

/**
 * Mint the ICE block for one session, or null when no relay is configured.
 *
 * Null is a first-class answer and the console renders it as a sentence: a farm on a LAN genuinely
 * does not need a relay, and inventing a STUN server to fill the gap would produce a viewer that
 * works at the desk and fails from a hotspot with no explanation.
 */
export function mintIce(
  sessionId: string,
  cfg: TurnConfig,
  secret: string | undefined,
  now = Date.now(),
): IceBlock | null {
  const s = secret?.trim();
  if (!s || cfg.turnUrls.length === 0) return null;

  const ttl = cfg.turnTtlSeconds;
  const username = `${Math.floor(now / 1000) + ttl}:${sessionId}`;
  // Base64 of the RAW HMAC, which is what the RFC draft and coturn both expect. Hex here is the
  // classic silent failure: every allocation is refused with a 401 the browser reports only as ICE
  // failing, and the relay's own log is the one place that says why.
  const credential = createHmac('sha1', s).update(username).digest('base64');

  return {
    iceServers: [{ urls: cfg.turnUrls, username, credential }],
    expiresInSeconds: ttl,
  };
}
