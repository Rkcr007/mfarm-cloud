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
  region: string;
  tier?: string;
  ttlMinutes?: number;
  /** How long to wait for capacity before giving up. 0 = fail immediately. */
  queueTimeoutSeconds: number;
  /** The capabilities to hand the upstream automation server, `mfarm:` keys removed. */
  upstream: Record<string, unknown>;
  /** Which dialect the client spoke, so the response can match it. */
  protocol: 'w3c' | 'jsonwp';
}

export interface ParseOptions {
  /** Used when the client sends no `mfarm:region`. Without either, region is a required capability. */
  defaultRegion?: string;
  maxQueueTimeoutSeconds?: number;
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

  const region = str(caps, `${MFARM_PREFIX}region`) ?? opts.defaultRegion;
  if (!region) {
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

  const upstream: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(caps)) {
    if (!k.startsWith(MFARM_PREFIX)) upstream[k] = v;
  }
  upstream.platformName = platform;

  return { platform, region, tier, ttlMinutes, queueTimeoutSeconds, upstream, protocol };
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
