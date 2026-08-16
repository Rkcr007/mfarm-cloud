import { invalidArgument } from './errors.ts';

/**
 * Capability negotiation for `POST /session`.
 *
 * The promise this endpoint exists to keep is "migration is one hub URL and two capabilities"
 * (v2 decision 10), so this file's job is to accept what real suites actually send — a W3C
 * `capabilities` object from Appium 2 and modern Selenium, or a legacy JSONWP `desiredCapabilities`
 * bag from the Appium 1.x clients a lot of suites are still pinned to — and turn either into an
 * allocation request.
 *
 * It is strict about one thing: a non-standard capability with no `vendor:` prefix is rejected, with
 * a message naming the key. That matches Appium 2 exactly, so a suite that works there works here,
 * and a suite that does not gets the same error it would get from Appium rather than a device that
 * silently ignores half its configuration.
 */

/** https://w3c.github.io/webdriver/#capabilities — everything else needs a `vendor:` prefix. */
const STANDARD = new Set([
  'browserName', 'browserVersion', 'platformName', 'acceptInsecureCerts', 'pageLoadStrategy',
  'proxy', 'setWindowRect', 'timeouts', 'strictFileInteractability', 'unhandledPromptBehavior',
  'webSocketUrl',
]);

/** Ours. Stripped before forwarding upstream — an Appium server would reject unknown vendor keys. */
const MFARM_PREFIX = 'mfarm:';

export interface ParsedCapabilities {
  platform: 'android' | 'ios';
  /**
   * Undefined only when there is a session to bind to — the device was chosen when that session was
   * created, so a region is not something this request gets to decide.
   */
  region?: string;
  tier?: string;
  ttlMinutes?: number;
  /** How long to wait for capacity before giving up. 0 = fail immediately. */
  queueTimeoutSeconds: number;
  /**
   * `mfarm:sessionId` — drive a session the caller already allocated instead of allocating a new
   * one (ADR-0002 D1). Set by anything that owns a session's lifecycle itself; `mfarm run` is the
   * one that matters, and it passes it through the URL rather than the capabilities so that a suite
   * still needs no code change.
   */
  bindSessionId?: string;
  /** The capabilities to hand the upstream automation server, `mfarm:` keys removed. */
  upstream: Record<string, unknown>;
  /** Which dialect the client spoke, so the response can match it. */
  protocol: 'w3c' | 'jsonwp';
}

export interface ParseOptions {
  /** Used when the client sends no `mfarm:region`. Without either, region is a required capability. */
  defaultRegion?: string;
  maxQueueTimeoutSeconds?: number;
  /**
   * A session id carried by the request URL rather than by the capabilities — see
   * `sessionBindingFromBasic`. It means the same thing as `mfarm:sessionId`, and exists because
   * `mfarm run` has to bind without editing the customer's suite. If both are present they must
   * agree.
   */
  urlSessionId?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseCapabilities(body: unknown, opts: ParseOptions = {}): ParsedCapabilities {
  if (!isPlainObject(body)) throw invalidArgument('Request body must be a JSON object.');

  const w3c = body.capabilities;
  if (w3c !== undefined) {
    if (!isPlainObject(w3c)) throw invalidArgument('`capabilities` must be a JSON object.');
    return fromW3c(w3c, opts);
  }

  const legacy = body.desiredCapabilities;
  if (isPlainObject(legacy)) return interpret(normaliseLegacy(legacy), 'jsonwp', opts);

  throw invalidArgument(
    'Send W3C `capabilities` (with alwaysMatch/firstMatch), or legacy `desiredCapabilities`.',
  );
}

function fromW3c(caps: Record<string, unknown>, opts: ParseOptions): ParsedCapabilities {
  const always = caps.alwaysMatch ?? {};
  if (!isPlainObject(always)) throw invalidArgument('`capabilities.alwaysMatch` must be an object.');
  validateKeys(always);

  const first = caps.firstMatch ?? [{}];
  if (!Array.isArray(first) || first.length === 0) {
    throw invalidArgument('`capabilities.firstMatch` must be a non-empty array.');
  }

  // Try each firstMatch entry in order and take the first that yields a usable request — that is
  // what firstMatch is FOR. Reporting the last failure would hide the interesting one, so the first
  // error is what surfaces if none work.
  let firstError: Error | undefined;
  for (const entry of first) {
    if (!isPlainObject(entry)) throw invalidArgument('Each `firstMatch` entry must be an object.');
    validateKeys(entry);

    // The spec makes an overlap an error rather than a precedence question: a suite that sets
    // platformName in both places has a bug, and silently picking one hides it.
    const clash = Object.keys(entry).find((k) => k in always);
    if (clash) {
      throw invalidArgument(
        `\`${clash}\` appears in both alwaysMatch and firstMatch. Put it in exactly one of them.`,
      );
    }

    try {
      return interpret({ ...always, ...entry }, 'w3c', opts);
    } catch (e) {
      firstError ??= e as Error;
    }
  }
  throw firstError ?? invalidArgument('No firstMatch entry could be satisfied.');
}

function validateKeys(caps: Record<string, unknown>): void {
  for (const key of Object.keys(caps)) {
    if (STANDARD.has(key) || key.includes(':')) continue;
    throw invalidArgument(
      `\`${key}\` is not a standard capability, so it needs a vendor prefix — use \`appium:${key}\`. ` +
      'This is the same rule Appium 2 enforces.',
    );
  }
}

/**
 * JSONWP sent everything unprefixed. Rather than reject those suites — they are exactly the ones
 * most worth migrating — prefix the non-standard keys the way the client would have had to.
 */
function normaliseLegacy(caps: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(caps)) {
    out[STANDARD.has(k) || k.includes(':') ? k : `appium:${k}`] = v;
  }
  return out;
}

function interpret(
  caps: Record<string, unknown>,
  protocol: 'w3c' | 'jsonwp',
  opts: ParseOptions,
): ParsedCapabilities {
  const platformRaw = caps.platformName;
  if (typeof platformRaw !== 'string') {
    throw invalidArgument('`platformName` is required, and must be "android" or "ios".');
  }
  // Clients send "Android", "iOS", "ANDROID". The spec lowercases; be liberal here because it costs
  // nothing and every client does it differently.
  const platform = platformRaw.trim().toLowerCase();
  if (platform !== 'android' && platform !== 'ios') {
    throw invalidArgument(`platformName "${platformRaw}" is not supported. Use "android" or "ios".`);
  }

  const bindSessionId = bindTarget(caps, opts);

  const region = str(caps, `${MFARM_PREFIX}region`) ?? opts.defaultRegion;
  // With a session to bind to there is nothing left to place: the device was chosen when that
  // session was allocated. Demanding a region here would also break the case this exists for — a
  // suite running under `mfarm run` sends no mfarm capabilities at all.
  if (!region && !bindSessionId) {
    throw invalidArgument(
      'A region is required. Set the `mfarm:region` capability (see GET /wd/hub/status for the list).',
    );
  }

  const tier = str(caps, `${MFARM_PREFIX}tier`);
  const TIERS = ['cuttlefish', 'avd', 'container', 'simulator', 'physical'];
  if (tier !== undefined && !TIERS.includes(tier)) {
    throw invalidArgument(`mfarm:tier "${tier}" is unknown. One of: ${TIERS.join(', ')}.`);
  }

  const ttlMinutes = int(caps, `${MFARM_PREFIX}ttlMinutes`, 1, 240);
  const maxQueue = opts.maxQueueTimeoutSeconds ?? 600;
  const queueTimeoutSeconds = int(caps, `${MFARM_PREFIX}queueTimeoutSeconds`, 0, maxQueue) ?? 0;

  // Refused rather than ignored. Every one of these is an instruction to the allocator, and the
  // allocator already ran — accepting them would mean silently doing something other than what the
  // capability says, which is the failure mode the whole `mfarm:` namespace exists to avoid.
  if (bindSessionId) {
    const conflict = ([
      [tier !== undefined, `${MFARM_PREFIX}tier`, '`mfarm run --tier`'],
      [ttlMinutes !== undefined, `${MFARM_PREFIX}ttlMinutes`, '`mfarm run --ttl`'],
      [caps[`${MFARM_PREFIX}queueTimeoutSeconds`] !== undefined,
        `${MFARM_PREFIX}queueTimeoutSeconds`, '`mfarm run --wait`'],
    ] as const).find(([present]) => present);
    if (conflict) {
      throw invalidArgument(
        `\`${conflict[1]}\` cannot be combined with \`${MFARM_PREFIX}sessionId\`: the device was ` +
        `already chosen when that session was created. Set it on the session instead — ${conflict[2]}.`,
      );
    }
  }

  const upstream: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(caps)) {
    if (!k.startsWith(MFARM_PREFIX)) upstream[k] = v;
  }
  upstream.platformName = platform;

  return { platform, region, tier, ttlMinutes, queueTimeoutSeconds, upstream, protocol, bindSessionId };
}

/** Exactly the shape Postgres will accept for a uuid, checked here so a bad id is a 400, not a 500. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which existing session, if any, this request is asking to drive.
 *
 * Two carriers for one meaning. The capability is the documented, explicit form. The URL form exists
 * because `mfarm run` must be able to bind without the customer editing their suite — ADR-0002
 * decision 1 is that `MFARM_WEBDRIVER_URL` is the entire migration, and a fix for the double-billing
 * defect that required a code change in every suite would not be a fix.
 */
function bindTarget(caps: Record<string, unknown>, opts: ParseOptions): string | undefined {
  const fromCaps = str(caps, `${MFARM_PREFIX}sessionId`);
  if (fromCaps !== undefined && !UUID.test(fromCaps)) {
    throw invalidArgument(`\`${MFARM_PREFIX}sessionId\` must be an mfarm session id (a uuid).`);
  }
  // Disagreement is not a precedence question. One of the two is wrong, and picking either would
  // drive a device the caller did not mean, on a session they are not watching.
  if (fromCaps !== undefined && opts.urlSessionId !== undefined && fromCaps !== opts.urlSessionId) {
    throw invalidArgument(
      `\`${MFARM_PREFIX}sessionId\` (${fromCaps}) does not match the session in the hub URL ` +
      `(${opts.urlSessionId}). Remove one of them.`,
    );
  }
  return fromCaps ?? opts.urlSessionId;
}

function str(caps: Record<string, unknown>, key: string): string | undefined {
  const v = caps[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.trim() === '') {
    throw invalidArgument(`\`${key}\` must be a non-empty string.`);
  }
  return v.trim();
}

function int(caps: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = caps[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw invalidArgument(`\`${key}\` must be an integer between ${min} and ${max}.`);
  }
  return n;
}
