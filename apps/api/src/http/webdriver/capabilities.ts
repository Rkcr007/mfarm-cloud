import { AppRefError, parseAppRef, type AppRef } from '../../appref.ts';
import { parseRunId, RunRefError } from '../../runs.ts';
import { invalidArgument } from './errors.ts';
import { isValidTunnelName } from '@mfarm/protocol';

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

/**
 * Every `mfarm:` key this hub understands. An unrecognised one is REFUSED, and that rule is the
 * reason the vendor prefix exists at all: `mfarm:appid` differs from `mfarm:appId` by one character,
 * and the alternative to refusing it is a session that starts happily on a device with no app on it.
 * A capability is an instruction, and silently discarding an instruction is the worst answer
 * available — worse than failing, because the run continues and reports something.
 */
const MFARM_KEYS = new Set([
  'region', 'tier', 'ttlMinutes', 'queueTimeoutSeconds', 'sessionId', 'appId', 'runId',
  'runName', 'name', 'deviceClass', 'tunnel',
]);

function rejectUnknownMfarmKeys(caps: Record<string, unknown>): void {
  for (const key of Object.keys(caps)) {
    if (!key.startsWith(MFARM_PREFIX)) continue;
    const name = key.slice(MFARM_PREFIX.length);
    if (MFARM_KEYS.has(name)) continue;
    throw invalidArgument(
      `\`${key}\` is not a capability this hub understands. Known: ` +
      `${[...MFARM_KEYS].map((k) => `${MFARM_PREFIX}${k}`).join(', ')}.`,
    );
  }
}

export interface ParsedCapabilities {
  platform: 'android' | 'ios';
  /**
   * Undefined only when there is a session to bind to — the device was chosen when that session was
   * created, so a region is not something this request gets to decide.
   */
  region?: string;
  tier?: string;
  ttlMinutes?: number;
  /**
   * `mfarm:appId` — a build in the org's app library to put on the device BEFORE the automation
   * session opens. Parsed here, resolved against `app_builds` by the caller, because resolution
   * needs the tenant's database scope and this file is pure.
   */
  appRef?: AppRef;
  /** The reference exactly as the caller wrote it, for error messages that quote them back. */
  appRefRaw?: string;
  /**
   * `mfarm:runId` — the caller's own name for the run this session belongs to, so that twenty
   * tests are one run rather than twenty unrelated leases. Validated here; the row is found or
   * created by the caller, because that needs the tenant's database scope and this file is pure.
   */
  runId?: string;
  /**
   * `mfarm:runName` — what the SUITE calls this run, as opposed to `mfarm:runId`, which is what CI
   * calls it. Both are wanted at once and they disagree: the id is the join key back to the CI job
   * (`$GITHUB_RUN_ID`, a number) and the name is what a person scans a list for
   * (`Android_UAE_Expenses_08_09_2026_06_53_38`). See migration 048.
   */
  runName?: string;
  /**
   * `mfarm:name` — the TEST this session is running, set at creation.
   *
   * This is LambdaTest's `lt:options.name` and BrowserStack's `name`, and it is here for the reason
   * they have it: the name is the only thing that makes a list of live sessions legible, and it has
   * to arrive at the START of the test. `test_results.name` carries it too, but not until the suite
   * posts a result — which is after the test finished, and never at all for a passing one.
   */
  name?: string;
  /**
   * `mfarm:deviceClass` — WHICH KIND OF DEVICE, by profile id (ADR-0016), or `null` for this
   * farm's unprofiled ones.
   *
   * The allocator has taken this since migration 037 and `POST /v1/sessions` has passed it since;
   * the hub never did, so a WebDriver client could ask for a tier ("physical") and not for a class
   * ("mfarm-x1-pro"). On a fleet of one kind that is invisible. On a mixed fleet it means a suite
   * pinned to a screen geometry gets whatever was free.
   *
   * TWO FIELDS, mirroring `AllocationRequest`, and for its reason: "no profile" is itself a class
   * somebody can ask for, and one nullable value cannot distinguish it from "any device at all".
   */
  deviceClass?: string | null;
  matchDeviceClass: boolean;
  /**
   * `mfarm:tunnel` — route this device's HTTP traffic through one of this org's tunnels, so the
   * app under test can reach a host on the customer's own network (migration 052).
   *
   * A NAME, not a boolean. An org can hold several — one per developer laptop, one on a CI runner
   * — and "use the tunnel" is ambiguous the moment there are two. Naming it also means a suite that
   * asks for a tunnel nobody started gets a 503 saying WHICH one, instead of a session that starts
   * fine and silently cannot reach anything.
   *
   * NOT AN ALLOCATION CONSTRAINT. It does not narrow which device is chosen — every device on this
   * farm can proxy — so it is not in the list of keys that pick hardware. It is recorded on the
   * session, and the router reads it when a device actually asks to fetch something.
   */
  tunnel?: string;
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
  rejectUnknownMfarmKeys(caps);
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

  // Both dialects converge here, and the JSONWP path never went through `validateKeys` — so this
  // is the call that actually covers every request.
  rejectUnknownMfarmKeys(caps);

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

  const appRefRaw = str(caps, `${MFARM_PREFIX}appId`);
  let appRef: AppRef | undefined;
  if (appRefRaw !== undefined) {
    // Refused, not ordered. `appium:app` is Appium installing a file it can reach; `mfarm:appId` is
    // the farm installing a build from the library. Both name the app under test, and a suite that
    // sets both has one of them left over from the migration — picking either would install
    // something the author did not mean and would look like it worked.
    if (caps['appium:app'] !== undefined) {
      throw invalidArgument(
        `\`${MFARM_PREFIX}appId\` and \`appium:app\` both name the app to install. Keep ` +
        `\`${MFARM_PREFIX}appId\` and drop \`appium:app\` — the library build is installed before ` +
        'your session starts, and needs no path on the device host.',
      );
    }
    try {
      appRef = parseAppRef(appRefRaw);
    } catch (e) {
      if (e instanceof AppRefError) throw invalidArgument(`\`${MFARM_PREFIX}appId\`: ${e.message}`);
      throw e;
    }
  }

  const runIdRaw = str(caps, `${MFARM_PREFIX}runId`);
  let runId: string | undefined;
  if (runIdRaw !== undefined) {
    try {
      runId = parseRunId(runIdRaw);
    } catch (e) {
      if (e instanceof RunRefError) throw invalidArgument(`\`${MFARM_PREFIX}runId\`: ${e.message}`);
      throw e;
    }
  }

  /**
   * A NAME FOR THE RUN NEEDS A RUN TO NAME. Without `mfarm:runId` there is no row to put it on, so
   * accepting it would mean discarding an instruction — the thing `rejectUnknownMfarmKeys` exists
   * to prevent, arrived at from the other direction.
   */
  const runName = label(caps, `${MFARM_PREFIX}runName`, 200);
  if (runName !== undefined && runId === undefined) {
    throw invalidArgument(
      `\`${MFARM_PREFIX}runName\` names a run, so it needs \`${MFARM_PREFIX}runId\` beside it — ` +
      'the id is what groups the sessions; the name is what a person reads.',
    );
  }

  const name = label(caps, `${MFARM_PREFIX}name`, 300);

  /**
   * The device class, and the one capability here whose ABSENCE and whose EXPLICIT NULL mean
   * different things — see `deviceClass` on `ParsedCapabilities`. `null` is "an unprofiled device,
   * specifically"; leaving the key out is "any device you can drive".
   */
  /**
   * `mfarm:tunnel`, validated HERE rather than at first use.
   *
   * A misspelled tunnel name is the caller's mistake and it is worth the whole session: the
   * alternative is a suite that allocates a device, installs a build, runs for four minutes and
   * then fails every request with a 503 naming a tunnel that was never going to exist. The same
   * reasoning `mfarm:appId` is resolved before anything is allocated.
   */
  const tunnel = str(caps, `${MFARM_PREFIX}tunnel`);
  if (tunnel !== undefined && !isValidTunnelName(tunnel)) {
    throw invalidArgument(
      `\`${MFARM_PREFIX}tunnel\` must be a tunnel name: lowercase letters, digits and dashes. `
      + `Got "${tunnel}".`,
    );
  }

  const hasDeviceClass = `${MFARM_PREFIX}deviceClass` in caps
    && caps[`${MFARM_PREFIX}deviceClass`] !== undefined;
  const deviceClass = hasDeviceClass ? (str(caps, `${MFARM_PREFIX}deviceClass`) ?? null) : undefined;

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
      /**
       * Same rule, and the one most likely to be set by accident: a suite that migrates to
       * `mfarm run` keeps its capabilities, and a device class among them is an instruction to an
       * allocator that already finished.
       *
       * The remedy names `POST /v1/sessions` rather than a CLI flag, because there is no CLI flag —
       * `mfarm run` takes `--tier`, `--ttl` and `--wait` and no `--profile`. Pointing at one that
       * does not exist would be worse than pointing at nothing: it reads as a fix and costs an
       * afternoon.
       *
       * `mfarm:name` is NOT in this list — it labels the session rather than choosing the device,
       * so it is meaningful on both paths.
       */
      [hasDeviceClass, `${MFARM_PREFIX}deviceClass`,
        'the `profile` field on `POST /v1/sessions`, which is what allocated it'],
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

  return {
    platform, region, tier, ttlMinutes, queueTimeoutSeconds, upstream, protocol, bindSessionId,
    appRef, appRefRaw, runId, runName, name,
    deviceClass, matchDeviceClass: hasDeviceClass,
    tunnel,
  };
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

/**
 * A human label: trimmed, non-empty, and bounded.
 *
 * TRUNCATED RATHER THAN REFUSED, which is the opposite of what `str` does and deliberate. A
 * capability that CHOOSES something — a region, an app, a device class — must be refused when it is
 * wrong, because the alternative is doing something other than what it says. A label chooses
 * nothing: it is the caller's most useful payload arriving slightly too long, and failing their
 * session over a scenario title with an unusually verbose Examples row would trade the whole test
 * for a cosmetic bound. `results.ts` makes the same call about a stack trace, for the same reason.
 *
 * The cut is MARKED, so nobody debugs a name that silently stops.
 */
function label(caps: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = caps[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalidArgument(`\`${key}\` must be a string.`);
  const text = v.trim();
  if (text === '') return undefined;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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
