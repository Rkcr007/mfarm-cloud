import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The environment, read and judged once, at startup.
 *
 * Until this file existed every setting was read where it happened to be needed —
 * `Number(process.env.RATE_LIMIT_MAX ?? 120)` inside buildServer, a connection string default inside
 * db.ts. That has one failure mode and it is expensive: a missing or mistyped variable is found by
 * the first request that needs it, in production, and only ever one variable per restart. Deploying
 * then becomes a guessing loop. `parseConfig` collects EVERY complaint and refuses to start with the
 * whole list.
 *
 * `parseConfig` takes the environment as an argument and mutates nothing, so a test can ask what
 * would happen under a production environment without making the test process production.
 */

/** Mirrors the fallbacks in db.ts. They live here too so that production can REFUSE them — that is
 *  the only reason config needs to know a local-dev default exists. */
export const DEV_SYSTEM_URL = 'postgres://mfarm:mfarm@localhost:5433/mfarm';
export const DEV_APP_URL = 'postgres://mfarm_app:mfarm_app@localhost:5433/mfarm';

/** Passwords committed to 001_init.sql. Anything still using one is not a secret, whatever host it
 *  points at — HANDOFF issue 4. */
const COMMITTED_PASSWORDS = new Set(['mfarm', 'mfarm_app']);

/** pino throws on an unknown level, and it throws while the logger is being constructed — so a typo
 *  here kills the process at startup with a stack trace instead of a sentence. */
const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

const NODE_ENVS = new Set(['production', 'development', 'test']);

/** Below this the reaper is a load generator: three fleet-wide queries per tick against the owner
 *  pool, which has 5 connections. */
const MIN_PRODUCTION_REAPER_MS = 1_000;

export type NodeEnv = 'production' | 'development' | 'test';

export interface Config {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  host: string;
  /** Owner role. Migrations and fleet operations only — never a request handler. */
  databaseUrl: string;
  /** `mfarm_app`, the RLS-bound role every request handler goes through. */
  appDatabaseUrl: string;
  /** Connection ceiling for the RLS-bound request pool. */
  poolMax: number;
  /** Connection ceiling for the owner pool — migrations, fleet ops, the reaper. */
  systemPoolMax: number;
  /** How long `pool.connect()` waits before failing rather than queueing forever. */
  pgConnectTimeoutMs: number;
  /** Whether a real keypair was supplied. The key material itself is deliberately NOT carried on
   *  this object: config gets logged, and the cheapest way to guarantee a private key never reaches
   *  a log line is for the thing being logged to have never held it. tokens.ts reads the env. */
  signingKeySource: 'environment' | 'ephemeral';
  reaperIntervalMs: number;
  rateLimitMax: number;
  logLevel: string;
  shutdownGraceMs: number;
  /** Whether to bind the second listener that serves `/metrics`. */
  metricsEnabled: boolean;
  /** Mark the console session cookie `Secure`. See the parse site for why it is not just isProduction. */
  sessionCookieSecure: boolean;
  /** Believe `X-Forwarded-For` when deciding the client address. See the parse site: this is only
   *  safe when something we control is the sole way in. */
  trustProxy: boolean;
  metricsPort: number;
  metricsHost: string;
  /** Whether a scrape credential was supplied. The token itself is deliberately NOT on this object,
   *  for the same reason the signing key is not: `describeConfig` gets logged. */
  metricsTokenSource: 'environment' | 'none';
  /** Where uploaded APKs are written. Content-addressed; see `appstore.ts`. */
  appStoreDir: string;
  /** Largest upload `POST /v1/apps` will accept, enforced on the stream rather than on a header. */
  appMaxUploadBytes: number;

  /**
   * Public base url of the data-plane route, or null when no live view is reachable.
   *
   * The worker's own `hosts.endpoint` is what a program on the network dials. This is what a
   * BROWSER dials, and they are not the same thing since ADR-0007: the browser reaches the worker
   * through the console's own TLS ingress (`wss://<console>/dp/<hostId>`), which is what keeps the
   * socket same-origin and the strict CSP intact. Null is a supported state and means the console
   * says the live view has no route rather than offering a button that hangs.
   */
  dataPlanePublicBase: string | null;

  /**
   * The TURN relay ADR-0005 chose, and the secret its credentials are derived from.
   *
   * The secret is NOT on this object — `describeConfig` gets logged — only whether one was
   * supplied. Without both, `GET /v1/sessions/:id` returns no `ice` block and the viewer falls back
   * to whatever the device's own host suggests, which works on a LAN and not from a hotspot.
   */
  turnUrls: string[];
  turnSecretSource: 'environment' | 'none';
  /** How long a minted TURN credential stays valid. Not the lease — see `turn.ts`. */
  turnTtlSeconds: number;
}

// Fields are declared and assigned explicitly rather than through constructor parameter properties:
// those emit runtime code, which Node's native type stripping rejects.
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Refusing to start — ${problems.length} configuration problem(s):\n` +
        problems.map((p) => `  * ${p}`).join('\n'),
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

/** `Number('')` is 0 and `Number('30s')` is NaN; both have shipped as a silently wrong setting. */
function intVar(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name}="${raw}" must be a whole number between ${min} and ${max}.`);
    return fallback;
  }
  return n;
}

/**
 * A boolean that refuses to guess.
 *
 * `Boolean(env.X)` is true for the string "false", and `x === 'true'` silently reads a typo as off —
 * which for a feature flag means the feature is missing and nothing says so. Accept the spellings
 * people actually type, reject everything else by name.
 */
function boolVar(raw: string | undefined, name: string, fallback: boolean, problems: string[]): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  problems.push(`${name}="${raw}" is not a boolean. Use 1/0, true/false, yes/no or on/off.`);
  return fallback;
}

/** Addresses that cannot be reached from off the box, so a listener on one needs no credential of
 *  its own. Deliberately not a pattern: `127.0.0.2` is loopback too, and so is every address in
 *  127/8, but nothing here binds one and a broad match is how `0.0.0.0` eventually slips in. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function parsePostgresUrl(raw: string, name: string, problems: string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} is not a URL. Expected postgres://user:password@host:port/database.`);
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    problems.push(`${name} has scheme "${url.protocol}"; pg only understands postgres: or postgresql:.`);
    return null;
  }
  return url;
}

/**
 * Whether two connection strings dial the same role on the same database.
 *
 * `===` on the raw strings was the whole check, and it is trivially defeated by spelling: adding
 * `?sslmode=require` to one, writing `postgresql://` in one and `postgres://` in the other, a
 * trailing slash on the database name. All four are the same connection and all four used to pass,
 * producing a control plane where every request runs as the schema owner — owner bypasses RLS, so
 * every policy reads as enabled while enforcing nothing.
 *
 * Compare what pg actually dials. Password is excluded (two credentials for one role are still one
 * role) and so are the query parameters (TLS settings do not change who you are). Host aliases —
 * `db.internal` vs `db-primary.internal` vs the pgbouncer address — are still invisible here, which
 * is why `assertAppRoleIsRlsBound()` re-checks against the live server at startup.
 */
function sameConnection(a: URL | null, b: URL | null): boolean {
  if (!a || !b) return false;
  const key = (u: URL) =>
    [
      decodeURIComponent(u.username),
      u.hostname.toLowerCase(),
      u.port || '5432',
      decodeURIComponent(u.pathname).replace(/\/+$/, ''),
      // '\0' as an escape, never a literal NUL byte in the source. A raw NUL makes this file
      // `data` rather than text to grep, diff and some editors — and any tool that silently
      // drops it turns the separator into '', so host 'db' + port '5432' would then compare
      // equal to host 'db5432' + no port. Same value at runtime, no longer invisible.
    ].join('\0');
  return key(a) === key(b);
}

/** A constant. The signature is over a fixed string, so the self-test discloses nothing about the
 *  process and costs one Ed25519 sign plus one verify at startup. */
const KEYPAIR_PROOF = Buffer.from('mfarm control plane keypair self-test');

function parseKey(pem: string, name: string, priv: boolean, problems: string[]): KeyObject | null {
  try {
    return priv ? createPrivateKey(pem) : createPublicKey(pem);
  } catch (err) {
    problems.push(
      `${name} is not a readable ${priv ? 'private' : 'public'} key: ${(err as Error).message}`,
    );
    return null;
  }
}

/** True when the PEM carries private key material, whatever it is called. `createPublicKey()` is no
 *  help here — it accepts a private PEM and quietly derives the public half. */
function isPrivatePem(pem: string): boolean {
  try {
    createPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
}

/**
 * The two halves are the same Ed25519 pair, proven rather than assumed.
 *
 * `createPublicKey()` succeeding says almost nothing: it accepts a private PEM, and it accepts a
 * public key from a different (or differently-typed) pair. Both of those boot cleanly and fail
 * later — the first by putting the signing key in the variable everyone hands to workers, the
 * second by minting tokens that no worker can verify. A sign/verify round trip catches both, and
 * stays pure.
 */
function checkKeypair(priv: string, pub: string, problems: string[]): void {
  if (isPrivatePem(pub)) {
    problems.push(
      'SESSION_PUBLIC_KEY contains PRIVATE key material. createPublicKey() accepts a private PEM ' +
        'and derives the public half from it, so this would validate — while the variable that gets ' +
        'distributed to every worker holds the key that mints tokens.',
    );
  }
  const privateKey = parseKey(priv, 'SESSION_SIGNING_KEY', true, problems);
  const publicKey = parseKey(pub, 'SESSION_PUBLIC_KEY', false, problems);
  if (!privateKey || !publicKey) return;

  for (const [name, key] of [['SESSION_SIGNING_KEY', privateKey], ['SESSION_PUBLIC_KEY', publicKey]] as const) {
    if (key.asymmetricKeyType !== 'ed25519') {
      problems.push(
        `${name} is ${key.asymmetricKeyType ?? 'not an asymmetric key'}, not ed25519. Session tokens ` +
          'are signed with Ed25519 (TOKEN_ALG) and mintSessionToken() would throw on the first request.',
      );
    }
  }
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') return;

  if (!verify(null, KEYPAIR_PROOF, publicKey, sign(null, KEYPAIR_PROOF, privateKey))) {
    problems.push(
      'SESSION_PUBLIC_KEY is not the public half of SESSION_SIGNING_KEY — a signature made with one ' +
        'does not verify with the other. Both parse, so nothing else notices; every session token ' +
        'minted would be rejected by every worker. The usual cause is one half left over from the ' +
        'previous rotation.',
    );
  }
}

/**
 * Both halves of the pair or neither. Half a pair is the worst of the three states: loadSigningKey()
 * requires both and falls back to an ephemeral key when either is missing, so a deployment that sets
 * only one mints tokens that stop verifying at the next restart — and the only symptom is workers
 * rejecting sessions that were valid a moment ago.
 */
function checkSigningKey(env: Env, isProduction: boolean, problems: string[]): 'environment' | 'ephemeral' {
  const priv = env.SESSION_SIGNING_KEY;
  const pub = env.SESSION_PUBLIC_KEY;

  if (!priv && !pub) {
    if (isProduction) {
      problems.push(
        'SESSION_SIGNING_KEY and SESSION_PUBLIC_KEY are unset. In production the ephemeral fallback ' +
          'is not an option: the keypair would change on every restart and on every replica, so ' +
          'every session token in flight would stop verifying at the worker.',
      );
    }
    return 'ephemeral';
  }
  if (!priv || !pub) {
    problems.push(
      `${priv ? 'SESSION_PUBLIC_KEY' : 'SESSION_SIGNING_KEY'} is missing while the other half is set. ` +
        'loadSigningKey() needs both and quietly generates an ephemeral pair otherwise, so the ' +
        'key you deployed would not be the key in use.',
    );
    return 'ephemeral';
  }

  // Parse, do not pattern-match. A truncated PEM (a secret manager that dropped the trailing
  // newline, a value pasted through a shell that ate the line breaks) still contains the header.
  // And parsing alone is not enough either — see checkKeypair.
  checkKeypair(priv, pub, problems);
  return 'environment';
}

/** Everything `db.ts` needs to build its two pools. */
export interface DbConfig {
  databaseUrl: string;
  appDatabaseUrl: string;
  poolMax: number;
  systemPoolMax: number;
  pgConnectTimeoutMs: number;
}

/**
 * The single reader for the database environment. Called from `parseConfig` AND from `db.ts`.
 *
 * It exists because those two used to read the same variables independently: `db.ts` had its own
 * copies of the local-dev connection strings, so the literals lived in two files and would drift
 * silently — the day someone changed the dev port in one of them, the other would keep working
 * against a database nobody meant to use (known issue 7).
 *
 * `problems` is an accumulator rather than a throw, which is what lets the two callers behave
 * differently on bad input without duplicating the parsing. See the call in `db.ts`.
 */
export function parseDbConfig(env: Env, problems: string[]): DbConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? DEV_SYSTEM_URL,
    appDatabaseUrl: env.APP_DATABASE_URL ?? DEV_APP_URL,
    // Bounded, and previously unbounded and unchecked: `Number('twenty')` is NaN, and a pool built
    // with `max: NaN` does not fail loudly — it misbehaves under load, which is the worst time to
    // find out (known issue 8). The upper bound is a sanity rail: a pool larger than Postgres'
    // own max_connections cannot help and will exhaust the server instead.
    poolMax: intVar(env.PG_POOL_MAX, 'PG_POOL_MAX', 20, 1, 1000, problems),
    systemPoolMax: intVar(env.PG_SYSTEM_POOL_MAX, 'PG_SYSTEM_POOL_MAX', 5, 1, 1000, problems),
    // 0 is allowed and means "wait forever", which is pg's own default. It is a bad idea here and
    // the comment in db.ts says why, but it is a legitimate choice rather than a typo.
    pgConnectTimeoutMs: intVar(env.PG_CONNECT_TIMEOUT_MS, 'PG_CONNECT_TIMEOUT_MS', 10_000, 0, 600_000, problems),
  };
}

/**
 * Pure: reads `env`, touches nothing else, and throws a ConfigError naming every problem at once.
 */
export function parseConfig(env: Env): Config {
  const problems: string[] = [];

  const rawNodeEnv = env.NODE_ENV ?? 'development';
  if (!NODE_ENVS.has(rawNodeEnv)) {
    problems.push(
      `NODE_ENV="${rawNodeEnv}" is not one of production, development, test. A misspelt value ` +
        'reads as "not production", which switches off every production guard below.',
    );
  }
  const nodeEnv = (NODE_ENVS.has(rawNodeEnv) ? rawNodeEnv : 'development') as NodeEnv;
  const isProduction = nodeEnv === 'production';

  const port = intVar(env.PORT, 'PORT', 3000, 0, 65535, problems);

  // 0.0.0.0 by default because the normal deployment is a container: binding 127.0.0.1 there
  // produces a process that is up, healthy, and unreachable from outside its own namespace.
  const host = env.HOST?.trim() || '0.0.0.0';

  const db = parseDbConfig(env, problems);
  const { databaseUrl, appDatabaseUrl } = db;
  const systemUrl = parsePostgresUrl(databaseUrl, 'DATABASE_URL', problems);
  const appUrl = parsePostgresUrl(appDatabaseUrl, 'APP_DATABASE_URL', problems);

  // Same parsed comparison as the owner/app check below, and for the same reason: a `?sslmode=`
  // suffix or a `postgresql://` spelling must not launder the local-dev default past this.
  const isDevSystem = sameConnection(systemUrl, new URL(DEV_SYSTEM_URL));
  const isDevApp = sameConnection(appUrl, new URL(DEV_APP_URL));

  if (isProduction) {
    if (isDevSystem) {
      problems.push(
        'DATABASE_URL is still the local-dev default. It points at localhost:5433 with a password ' +
          'that is committed to 001_init.sql, and the compose file it belongs to keeps its data on ' +
          'tmpfs — so at best this fails to connect, at worst it connects to something that is not ' +
          'the fleet database and loses everything written to it on reboot.',
      );
    }
    if (isDevApp) {
      problems.push(
        'APP_DATABASE_URL is still the local-dev default, whose password is committed to ' +
          '001_init.sql. That credential is the RLS boundary for every tenant.',
      );
    }
    if (sameConnection(systemUrl, appUrl)) {
      problems.push(
        'APP_DATABASE_URL and DATABASE_URL are the same connection, so request handling would run ' +
          'as the schema owner. Owners bypass row-level security (and superusers bypass it even ' +
          'with FORCE), which means every tenant policy still reads as enabled while enforcing ' +
          'nothing. This is the tenant-isolation failure that shows up as a customer seeing ' +
          "another customer's session.",
      );
    }
    // Skipped for a variable already reported as the dev default, whose password is committed by
    // definition. Saying it twice makes the list look like noise, and a list that looks like noise
    // gets skimmed.
    const alreadyFlagged = new Set<string>();
    if (isDevSystem) alreadyFlagged.add('DATABASE_URL');
    if (isDevApp) alreadyFlagged.add('APP_DATABASE_URL');
    for (const [name, url] of [['DATABASE_URL', systemUrl], ['APP_DATABASE_URL', appUrl]] as const) {
      if (!alreadyFlagged.has(name) && url && COMMITTED_PASSWORDS.has(decodeURIComponent(url.password))) {
        problems.push(
          `${name} still uses a password that is committed to 001_init.sql. Pointing it at a ` +
            'different host does not make it a secret.',
        );
      }
    }
  }

  const signingKeySource = checkSigningKey(env, isProduction, problems);

  const reaperIntervalMs = intVar(env.REAPER_INTERVAL_MS, 'REAPER_INTERVAL_MS', 30_000, 0, 3_600_000, problems);
  if (isProduction && reaperIntervalMs === 0) {
    problems.push(
      'REAPER_INTERVAL_MS is 0, which turns the reaper off. Then expire_sessions() never runs, so a ' +
        'client that crashes holds its device until a human notices; promote_queued() never runs, ' +
        'so a QUEUED WebDriver session can only ever time out; and nothing purges idempotency_keys, ' +
        'a table on the hot path of every session creation that otherwise grows forever.',
    );
  } else if (isProduction && reaperIntervalMs < MIN_PRODUCTION_REAPER_MS) {
    problems.push(
      `REAPER_INTERVAL_MS=${reaperIntervalMs} is below ${MIN_PRODUCTION_REAPER_MS}ms. The reaper is ` +
        'fleet-wide and costs three queries per tick on the owner pool, which has five connections; ' +
        'at this rate it competes with the migrations and fleet operations that share it.',
    );
  }

  const rateLimitMax = intVar(env.RATE_LIMIT_MAX, 'RATE_LIMIT_MAX', 120, 1, 1_000_000, problems);

  const logLevel = env.LOG_LEVEL?.trim() || 'info';
  if (!LOG_LEVELS.has(logLevel)) {
    problems.push(`LOG_LEVEL="${logLevel}" is not one of ${[...LOG_LEVELS].join(', ')}.`);
  }

  // 15s fits inside Kubernetes' default 30s terminationGracePeriodSeconds with room for the pod to
  // be pulled from endpoints first. A grace longer than the platform's own is not a longer drain —
  // it is a SIGKILL in the middle of one.
  const shutdownGraceMs = intVar(env.SHUTDOWN_GRACE_MS, 'SHUTDOWN_GRACE_MS', 15_000, 0, 300_000, problems);

  // --- metrics ---------------------------------------------------------------------------------
  const metricsEnabled = boolVar(env.METRICS_ENABLED, 'METRICS_ENABLED', true, problems);

  /**
   * Mark the console's session cookie `Secure`.
   *
   * Defaults to ON in production and it must stay overridable, because the two are genuinely
   * independent: this farm is a production deployment that serves plain HTTP on :3000 and gets its
   * TLS from `tailscale serve` in front, or from nothing at all on a LAN.
   *
   * Get it wrong in either direction and the failure is confusing rather than loud. Set when the
   * browser is on plain HTTP and the browser REFUSES TO STORE THE COOKIE AT ALL — login returns 200
   * and the next request is anonymous, which reads as "login silently does nothing". Unset when the
   * browser is on TLS and the cookie is one downgraded request away from travelling in the clear.
   */
  const sessionCookieSecure = boolVar(
    env.SESSION_COOKIE_SECURE, 'SESSION_COOKIE_SECURE', isProduction, problems,
  );
  /**
   * Take the client address from `X-Forwarded-For` rather than from the socket.
   *
   * Defaults OFF, and deliberately NOT to `isProduction` the way the cookie flag above does. The two
   * look like the same question and are not. Marking a cookie `Secure` when nothing terminates TLS
   * costs a confusing login; believing a forwarded header when nothing sets it hands every caller a
   * free `req.ip` of their choosing, and `req.ip` is what the rate limiter keys anonymous traffic on.
   * A spoofable limiter key is not a limiter. So this stays off until a deployment states that a
   * proxy it controls is the ONLY way in — which is exactly what `deploy/README.md` now asks of it.
   *
   * The symptom when it is wrongly off is not an error either, which is why it is worth naming: with
   * a proxy in front, every anonymous request in the world arrives from one address (the docker
   * bridge gateway, in this deployment), so the whole internet shares a single rate-limit bucket and
   * one attacker can 429 everybody else's login.
   */
  const trustProxy = boolVar(env.TRUST_PROXY, 'TRUST_PROXY', false, problems);
  // 0 is allowed and means "let the kernel choose", exactly as it does for PORT. Useless for a
  // deployment — Prometheus has to be told a number — and the only way a test can start the real
  // entrypoint without two children fighting over a fixed port.
  const metricsPort = intVar(env.METRICS_PORT, 'METRICS_PORT', 9464, 0, 65535, problems);
  const metricsHost = env.METRICS_HOST?.trim() || '127.0.0.1';
  const metricsToken = env.METRICS_TOKEN?.trim();
  const metricsTokenSource = metricsToken ? 'environment' : 'none';

  // `0 === 0` is not a collision: both mean "the kernel picks", and it picks twice.
  if (metricsEnabled && metricsPort !== 0 && metricsPort === port) {
    problems.push(
      `METRICS_PORT=${metricsPort} is also PORT. The metrics listener is a second server on purpose — ` +
        'sharing the port would put fleet-wide, cross-tenant gauges on the same listener as the ' +
        'WebDriver hub, which is internet-facing by design. One of the two would also simply fail to ' +
        'bind, and which one is a race.',
    );
  }

  // Loopback is the default and needs no credential, because nothing off the box can reach it. Any
  // other bind address can, so it must carry one. The realistic case is a container: `METRICS_HOST`
  // has to be 0.0.0.0 for Prometheus to scrape across the compose network, and "only reachable on
  // the docker network" stops being true the first time someone publishes the port.
  if (isProduction && metricsEnabled && !LOOPBACK_HOSTS.has(metricsHost) && !metricsToken) {
    problems.push(
      `METRICS_HOST="${metricsHost}" is not loopback and METRICS_TOKEN is unset. /metrics reports every ` +
        'device, session and host in the fleet across every org — it is collected on the owner pool ' +
        'precisely because RLS would hide it — so an unauthenticated non-loopback listener discloses ' +
        'the whole fleet. Set METRICS_TOKEN, or bind 127.0.0.1 and scrape through the host.',
    );
  }

  // --- app library -----------------------------------------------------------------------------
  //
  // The default is a temp directory, and production is REQUIRED to override it. Both halves are
  // deliberate. A default of nothing means `npm test` and a laptop run work with no setup; a temp
  // directory in production means the app library survives until the next reboot and then quietly
  // does not, with a database full of rows pointing at blobs that no longer exist. That failure
  // appears as "install failed: no such file" days later, on someone else's shift.
  const appStoreDir = env.APP_STORE_DIR?.trim() || join(tmpdir(), 'mfarm-app-store');
  if (isProduction && !env.APP_STORE_DIR?.trim()) {
    problems.push(
      'APP_STORE_DIR is unset. Uploaded APKs would be written under the system temp directory, ' +
        'which is cleared on reboot while the app_builds rows naming them survive. Point it at ' +
        'persistent storage (the compose file uses a named volume).',
    );
  }

  // 512 MB. Comfortably past a large debug build with every ABI in it, and far short of a number
  // that lets one upload fill the disk the snapshots live on.
  const appMaxUploadBytes = intVar(
    env.APP_MAX_UPLOAD_BYTES, 'APP_MAX_UPLOAD_BYTES', 512 * 1024 * 1024, 1024, 4 * 1024 * 1024 * 1024, problems,
  );

  /**
   * Where the console tells a browser to reach the data plane.
   *
   * Validated as a url with a websocket scheme, because the failure it prevents is silent: a value
   * of `https://...` produces a viewer that cannot connect and a console that shows a spinner, and
   * the mistake is one character away from correct.
   */
  const dataPlanePublicBase = (() => {
    const raw = env.DATA_PLANE_PUBLIC_BASE?.trim();
    if (!raw) return null;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
        problems.push(`DATA_PLANE_PUBLIC_BASE="${raw}" must be a ws:// or wss:// url — it is what a browser opens a WebSocket to.`);
        return null;
      }
      if (isProduction && u.protocol === 'ws:') {
        problems.push('DATA_PLANE_PUBLIC_BASE is ws:// in production. A page served over HTTPS cannot open a plain-ws socket, so the live view would fail as mixed content.');
        return null;
      }
      return raw.replace(/\/+$/, '');
    } catch {
      problems.push(`DATA_PLANE_PUBLIC_BASE="${raw}" is not a url.`);
      return null;
    }
  })();

  // Comma-separated because a working TURN deployment is normally several urls — udp, tcp and 443
  // for the networks that only allow that — and asking an operator to pick one guarantees the
  // hotspot case fails.
  const turnUrls = (env.TURN_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  const turnSecret = env.TURN_SECRET?.trim();
  if (turnUrls.length > 0 && !turnSecret) {
    problems.push('TURN_URLS is set without TURN_SECRET. Credentials are derived from the shared secret coturn is started with (`use-auth-secret`), so a url alone mints nothing.');
  }
  if (turnSecret && turnUrls.length === 0) {
    problems.push('TURN_SECRET is set without TURN_URLS. There is nowhere to point a viewer.');
  }
  // 12 hours. Long enough that no lease outlives its own relay credential mid-session — a session
  // can be extended, and a relay that stops working half way through a debugging session presents
  // as the device freezing. Short enough that a leaked one is not a permanent grant of bandwidth.
  const turnTtlSeconds = intVar(env.TURN_TTL_SECONDS, 'TURN_TTL_SECONDS', 12 * 3600, 60, 24 * 3600, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    nodeEnv,
    isProduction,
    port,
    host,
    databaseUrl,
    appDatabaseUrl,
    poolMax: db.poolMax,
    systemPoolMax: db.systemPoolMax,
    pgConnectTimeoutMs: db.pgConnectTimeoutMs,
    signingKeySource,
    reaperIntervalMs,
    rateLimitMax,
    logLevel,
    shutdownGraceMs,
    metricsEnabled,
    sessionCookieSecure,
    trustProxy,
    metricsPort,
    metricsHost,
    metricsTokenSource,
    appStoreDir,
    appMaxUploadBytes,
    dataPlanePublicBase,
    turnUrls,
    turnSecretSource: turnSecret ? 'environment' as const : 'none' as const,
    turnTtlSeconds,
  });
}

let cached: Config | undefined;

/**
 * The configuration for this process, parsed once.
 *
 * A function rather than a module-scope `const` on purpose: a const would parse during module
 * evaluation, so an invalid environment would throw while `main` was still being imported — before
 * any handler exists to turn a ConfigError into the list of sentences it was written to be. What
 * operators would get instead is an ESM stack trace, which is the opposite of the point.
 */
export function loadConfig(env: Env = process.env): Config {
  return (cached ??= parseConfig(env));
}

/** Password out, everything else intact — a connection string is useless in a log without the host
 *  and database name, and dangerous in one with the password. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable>';
  }
}

/** What `main` logs at startup. Anything added to Config must be added here deliberately, which is
 *  the checkpoint that keeps a future secret from being logged by default. */
export function describeConfig(c: Config): Record<string, string | number | boolean> {
  return {
    nodeEnv: c.nodeEnv,
    listen: `${c.host}:${c.port}`,
    databaseUrl: redactUrl(c.databaseUrl),
    appDatabaseUrl: redactUrl(c.appDatabaseUrl),
    poolMax: c.poolMax,
    systemPoolMax: c.systemPoolMax,
    pgConnectTimeoutMs: c.pgConnectTimeoutMs,
    signingKeySource: c.signingKeySource,
    reaperIntervalMs: c.reaperIntervalMs,
    rateLimitMax: c.rateLimitMax,
    logLevel: c.logLevel,
    shutdownGraceMs: c.shutdownGraceMs,
    metrics: c.metricsEnabled ? `${c.metricsHost}:${c.metricsPort}` : 'disabled',
    sessionCookie: c.sessionCookieSecure ? 'Secure' : 'not Secure (plain HTTP)',
    clientAddress: c.trustProxy ? 'X-Forwarded-For (proxied)' : 'socket peer',
    metricsTokenSource: c.metricsTokenSource,
    appStoreDir: c.appStoreDir,
    appMaxUploadBytes: c.appMaxUploadBytes,
    dataPlanePublicBase: c.dataPlanePublicBase ?? 'unset (no live view route)',
    turn: c.turnUrls.length ? `${c.turnUrls.length} url(s), secret ${c.turnSecretSource}` : 'unconfigured',
  };
}
