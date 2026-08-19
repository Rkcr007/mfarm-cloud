#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { ControlPlaneClient, describe, sleep } from './client.ts';
import { run, EXIT_FAILURE } from './run.ts';
import type { AppSummary, DataPlaneCoordinates, DeviceSummary, SessionSummary } from './client.ts';

/**
 * `mfarm` entry point: parse, dispatch, and make sure nothing escapes without an exit code.
 *
 * Every command here follows the same two rules, because they are what make the output usable in a
 * pipeline: progress and diagnostics go to stderr, results go to stdout. A `--json` result is one
 * object on one line, so `mfarm devices --json | jq` works without a flag to suppress chatter.
 *
 * The shebang silences one warning class and no others: type stripping prints an ExperimentalWarning
 * to stderr on every single invocation, and a wrapper that prepends two lines of Node noise to every
 * CI job's log is a wrapper people find a way to stop using.
 */

const DEFAULT_API_URL = 'https://api.mfarm.dev';
const DEFAULT_TTL_MINUTES = 30;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_TTL_MINUTES = 240;
/** An install is a transfer plus a dexopt pass. Long enough for a large build on a busy device. */
const DEFAULT_INSTALL_WAIT_SECONDS = 300;
/** Poll interval while waiting. The worker collects the job on a 10s heartbeat, so faster is noise. */
const INSTALL_POLL_MS = 2_000;

/** A mistake the user can fix by re-reading `--help`; never a reason to print a stack trace. */
class UsageError extends Error {}

const HELP = `mfarm — run your existing mobile test suite on a cloud device.

USAGE
  mfarm run [options] -- <command> [args...]   allocate a device, run the command, release
  mfarm devices [options]                      list devices visible to your organisation
  mfarm session get <id> [options]             inspect one session
  mfarm session rm <id> [options]              force-release a session
  mfarm app upload <file.apk>                  add a build to your organisation's library
  mfarm app list [--package <name>]            list builds
  mfarm app install <app-id> --session <id>    install a build onto the device that session holds
  mfarm app launch <app-id> --session <id>     open it on that device
  mfarm app uninstall <app-id> --session <id>  remove it from that device
  mfarm --version | --help

GLOBAL OPTIONS
  --api <url>       control plane base URL      (env MFARM_API_URL, default ${DEFAULT_API_URL})
  --api-key <key>   tenant API key              (env MFARM_API_KEY, required)
  --json            one JSON object on stdout
  --quiet           no progress output on stderr

RUN OPTIONS
  --region <r>      required                    (env MFARM_REGION)
  --platform <p>    android | ios               (env MFARM_PLATFORM, default android)
  --tier <t>        leave unset to let the server choose  (env MFARM_TIER)
  --ttl <minutes>   session lifetime, 1-${MAX_TTL_MINUTES}       (env MFARM_TTL, default ${DEFAULT_TTL_MINUTES})
  --wait <seconds>  how long to wait out a queue (env MFARM_WAIT, default ${DEFAULT_WAIT_SECONDS}; 0 fails immediately)
  --no-webdriver    allocate a device even if it cannot run Appium. Only for suites that speak
                    the raw data plane; MFARM_WEBDRIVER_URL will not work on such a device.

DEVICES OPTIONS
  --region <r>  --platform <android|ios>  --state <s>   filters, all optional

APP OPTIONS
  --session <id>    which session's device to act on (app install/launch/uninstall; required)
  --package <name>  filter the library to one package        (app list)
  --wait <seconds>  wait for the action to finish, 0 to return as soon as it is queued
                    (app install/launch/uninstall, default ${DEFAULT_INSTALL_WAIT_SECONDS})

ENVIRONMENT GIVEN TO THE CHILD
  MFARM_SESSION_ID  MFARM_DEVICE_ID  MFARM_REGION
  MFARM_WEBDRIVER_URL         point your Appium client here and change nothing else
  MFARM_DATA_PLANE_ENDPOINT   MFARM_SESSION_TOKEN

EXIT CODES
  <child>  the command's own exit code, verbatim
  1        allocation, auth or configuration failure before the command started
  75       no device became available within --wait (retryable)
  130      interrupted

EXAMPLE
  MFARM_API_KEY=mfk_… mfarm run --region us-east -- npx appium-test
`;

const OPTIONS = {
  api: { type: 'string' },
  'api-key': { type: 'string' },
  json: { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  region: { type: 'string' },
  platform: { type: 'string' },
  tier: { type: 'string' },
  ttl: { type: 'string' },
  wait: { type: 'string' },
  'no-webdriver': { type: 'boolean', default: false },
  state: { type: 'string' },
  session: { type: 'string' },
  package: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

interface Globals {
  apiBaseUrl: string;
  apiKey: string;
  json: boolean;
  quiet: boolean;
}

/** Mirrors OPTIONS. Written out rather than inferred so the shape is readable at a glance. */
interface Flags {
  api?: string;
  'api-key'?: string;
  json?: boolean;
  quiet?: boolean;
  region?: string;
  platform?: string;
  tier?: string;
  ttl?: string;
  wait?: string;
  'no-webdriver'?: boolean;
  state?: string;
  session?: string;
  package?: string;
  help?: boolean;
  version?: boolean;
}

async function main(): Promise<number> {
  // `--` is split off before parseArgs ever sees it. node:util would fold everything after it into
  // positionals, which loses the boundary — and `mfarm run -- npx jest --watch` must not have its
  // `--watch` interpreted as ours.
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const childArgv = sep === -1 ? [] : argv.slice(sep + 1);

  let parsed;
  try {
    parsed = parseArgs({ args: own, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(describe(err));
  }
  const flags: Flags = parsed.values;
  const command: string | undefined = parsed.positionals[0];
  const rest = parsed.positionals.slice(1);

  if (flags.version) {
    process.stdout.write(`${await version()}\n`);
    return 0;
  }
  if (flags.help || command === 'help' || command === undefined) {
    // Help is a result when asked for and a diagnostic when the invocation was wrong.
    (flags.help || command === 'help' ? process.stdout : process.stderr).write(HELP);
    return flags.help || command === 'help' ? 0 : EXIT_FAILURE;
  }

  switch (command) {
    case 'run':
      return runCommand(flags, childArgv, sep !== -1);
    case 'devices':
      return devicesCommand(flags);
    case 'session':
      return sessionCommand(flags, rest);
    case 'app':
      return appCommand(flags, rest);
    default:
      throw new UsageError(`Unknown command "${command}". Run "mfarm --help".`);
  }
}

/**
 * First *present* value, where an empty string counts as an absence.
 *
 * `??` is wrong for every string flag here. A generated workflow interpolates its inputs
 * unconditionally — `--platform "${IN_PLATFORM}"` — and GitHub does not apply a composite input's
 * `required:`/`default:` when a caller passes an explicitly empty expression. With `??`, that
 * argument arrives as the *value* `''`: the "No region" usage error is skipped, an empty region is
 * sent to the API, and `--platform ''` fails with a message about a platform nobody typed.
 *
 * So `''` means "not supplied" — fall through to the env var, then to the default. This is exactly
 * what `integer()` below already does for `--ttl` and `--wait`; the string flags were the odd ones
 * out. It also makes the flag/env precedence honest: `--tier '' MFARM_TIER=gpu` now uses the env.
 */
function text(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '') return candidate;
  }
  return undefined;
}

function globals(flags: Flags): Globals {
  const apiBaseUrl = text(flags.api, process.env.MFARM_API_URL) ?? DEFAULT_API_URL;
  try {
    new URL(apiBaseUrl);
  } catch {
    throw new UsageError(`--api is not a URL: ${apiBaseUrl}`);
  }

  // Flag beats env, but CI should use the env: an API key on a command line is visible in `ps` to
  // every other process on the runner and gets echoed by shells with `set -x`.
  const apiKey = text(flags['api-key'], process.env.MFARM_API_KEY);
  if (!apiKey) {
    throw new UsageError('No API key. Set MFARM_API_KEY, or pass --api-key.');
  }
  return { apiBaseUrl, apiKey, json: flags.json ?? false, quiet: flags.quiet ?? false };
}

function client(g: Globals): ControlPlaneClient {
  return new ControlPlaneClient({ baseUrl: g.apiBaseUrl, apiKey: g.apiKey });
}

async function runCommand(flags: Flags, childArgv: string[], hadSeparator: boolean): Promise<number> {
  if (!hadSeparator || childArgv.length === 0) {
    throw new UsageError('Nothing to run. Put your command after `--`, e.g. mfarm run --region us-east -- npx appium-test');
  }
  const g = globals(flags);

  const region = text(flags.region, process.env.MFARM_REGION);
  if (!region) throw new UsageError('No region. Pass --region, or set MFARM_REGION.');

  const platform = text(flags.platform, process.env.MFARM_PLATFORM) ?? 'android';
  if (platform !== 'android' && platform !== 'ios') {
    throw new UsageError(`--platform must be android or ios, not "${platform}".`);
  }

  return run({
    client: client(g),
    apiBaseUrl: g.apiBaseUrl,
    apiKey: g.apiKey,
    region,
    platform,
    tier: text(flags.tier, process.env.MFARM_TIER),
    ttlMinutes: integer('--ttl', text(flags.ttl, process.env.MFARM_TTL), DEFAULT_TTL_MINUTES, 1, MAX_TTL_MINUTES),
    waitSeconds: integer('--wait', text(flags.wait, process.env.MFARM_WAIT), DEFAULT_WAIT_SECONDS, 0, 86_400),
    // Default on: the session id this allocates is handed to the hub in MFARM_WEBDRIVER_URL, and a
    // device with no automation server cannot serve it. Narrowing the pool here trades a rarer
    // exit 75 — which CI knows how to retry — for a mid-run failure, which it does not.
    webdriver: flags['no-webdriver'] !== true,
    command: childArgv[0]!,
    args: childArgv.slice(1),
    json: g.json,
    quiet: g.quiet,
  });
}

async function devicesCommand(flags: Flags): Promise<number> {
  const g = globals(flags);
  const result = await client(g).listDevices({
    region: text(flags.region, process.env.MFARM_REGION),
    platform: text(flags.platform),
    state: text(flags.state),
  });

  if (g.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (result.devices.length === 0) {
    process.stderr.write('mfarm: no devices match.\n');
    return 0;
  }
  for (const d of result.devices) process.stdout.write(`${deviceLine(d)}\n`);
  process.stderr.write(`mfarm: ${result.available} of ${result.devices.length} ready\n`);
  return 0;
}

async function sessionCommand(flags: Flags, rest: string[]): Promise<number> {
  const [sub, id] = rest;
  if (sub !== 'get' && sub !== 'rm') {
    throw new UsageError('Usage: mfarm session get <id> | mfarm session rm <id>');
  }
  if (!id) throw new UsageError(`mfarm session ${sub} needs a session id.`);
  const g = globals(flags);

  if (sub === 'get') {
    const { session, dataPlane } = await client(g).getSession(id);
    // The token goes to `--json` and never to the human rendering. `--json` is consumed by a
    // program that asked for the credential; the plain output is what gets pasted into a chat or
    // scrolled past in a shared terminal, and a session token is a live handle on a device.
    if (g.json) process.stdout.write(`${JSON.stringify({ session, dataPlane })}\n`);
    else process.stdout.write(sessionLines(session, dataPlane));
    return 0;
  }

  // `rm` on a session that has already ended is a success. A cleanup step in CI runs after the
  // reaper may already have collected the session, and failing there would make people stop
  // running the cleanup step at all.
  const released = await client(g).deleteSession(id);
  if (g.json) process.stdout.write(`${JSON.stringify({ sessionId: id, released })}\n`);
  else process.stderr.write(`mfarm: ${released ? `released ${id}` : `${id} was already released`}\n`);
  return 0;
}

async function appCommand(flags: Flags, rest: string[]): Promise<number> {
  const [sub, target] = rest;
  const g = globals(flags);
  const c = client(g);

  if (sub === 'upload') {
    if (!target) throw new UsageError('mfarm app upload needs a path to an .apk file.');
    if (!g.quiet) process.stderr.write(`mfarm: uploading ${target}…\n`);
    const { app, deduplicated } = await c.uploadApp(target);
    if (g.json) process.stdout.write(`${JSON.stringify({ app, deduplicated })}\n`);
    else process.stdout.write(`${app.id}\n`);
    if (!g.quiet) {
      // Said out loud because it is the difference between "my upload did nothing" and "the server
      // already had these exact bytes", and the second one is the good outcome.
      process.stderr.write(
        deduplicated
          ? `mfarm: already in the library — ${app.packageName} ${app.versionName ?? '?'}\n`
          : `mfarm: uploaded ${app.packageName} ${app.versionName ?? '?'} (${app.sizeBytes} bytes)\n`,
      );
    }
    return 0;
  }

  if (sub === 'list') {
    const apps = await c.listApps(text(flags.package));
    if (g.json) { process.stdout.write(`${JSON.stringify({ apps })}\n`); return 0; }
    if (apps.length === 0) { process.stderr.write('mfarm: the library is empty.\n'); return 0; }
    for (const a of apps) process.stdout.write(`${appLine(a)}\n`);
    return 0;
  }

  if (sub === 'install' || sub === 'launch' || sub === 'uninstall') {
    if (!target) throw new UsageError(`mfarm app ${sub} needs an app id. Get one from \`mfarm app list\`.`);
    const sessionId = text(flags.session, process.env.MFARM_SESSION_ID);
    if (!sessionId) {
      throw new UsageError(`No session. Pass --session <id>, or set MFARM_SESSION_ID — a ${sub} needs a device you already hold.`);
    }
    const waitSeconds = integer('--wait', text(flags.wait), DEFAULT_INSTALL_WAIT_SECONDS, 0, 3_600);

    let action = await c.requestAction(sessionId, target, sub);
    if (!g.quiet) process.stderr.write(`mfarm: queued ${sub} ${action.id}\n`);

    if (waitSeconds > 0) {
      const deadline = Date.now() + waitSeconds * 1000;
      while (action.state === 'PENDING' && Date.now() < deadline) {
        await sleep(INSTALL_POLL_MS);
        action = await c.getAction(action.id);
      }
    }

    if (g.json) process.stdout.write(`${JSON.stringify({ action })}\n`);
    else process.stdout.write(`${action.state}\n`);

    // Exit code carries the outcome, because this is a thing scripts branch on. A still-PENDING
    // action is not a failure of the action — it is this command giving up waiting — so it is
    // reported as its own case rather than folded into either success or failure.
    if (action.state === 'DONE') return 0;
    if (action.state === 'FAILED') {
      process.stderr.write(`mfarm: ${sub} failed: ${action.error ?? 'no reason reported'}\n`);
      return EXIT_FAILURE;
    }
    if (!g.quiet) {
      process.stderr.write(`mfarm: ${sub} ${action.id} is still pending after ${waitSeconds}s. Poll it with \`mfarm app status ${action.id}\`.\n`);
    }
    return waitSeconds === 0 ? 0 : EXIT_FAILURE;
  }

  if (sub === 'status') {
    if (!target) throw new UsageError('mfarm app status needs an action id.');
    const action = await c.getAction(target);
    if (g.json) process.stdout.write(`${JSON.stringify({ action })}\n`);
    else process.stdout.write(`${action.state}${action.error ? ` — ${action.error}` : ''}\n`);
    return action.state === 'FAILED' ? EXIT_FAILURE : 0;
  }

  throw new UsageError(
    'Usage: mfarm app upload <file.apk> | mfarm app list | ' +
    'mfarm app install|launch|uninstall <app-id> --session <id> | mfarm app status <action-id>',
  );
}

function appLine(a: AppSummary): string {
  return [
    a.id.padEnd(38),
    a.packageName.padEnd(34),
    (a.versionName ?? '?').padEnd(12),
    (a.versionCode === null ? '?' : String(a.versionCode)).padEnd(8),
    `${Math.round(a.sizeBytes / 1024)}K`.padStart(8),
    a.sha256.slice(0, 12),
  ].join(' ').trimEnd();
}

function deviceLine(d: DeviceSummary): string {
  return [
    d.id.padEnd(38),
    d.state.padEnd(12),
    `${d.platform}/${d.tier}`.padEnd(22),
    (d.model ?? '?').padEnd(18),
    (d.osVersion ?? '?').padEnd(8),
    d.region,
    d.dedicated ? ' (dedicated)' : '',
  ].join(' ').trimEnd();
}

function sessionLines(s: SessionSummary, dataPlane?: DataPlaneCoordinates | null): string {
  const fields: [string, unknown][] = [
    ['id', s.id], ['state', s.state], ['device', s.deviceId], ['region', s.region],
    ['created', s.createdAt], ['started', s.startedAt], ['expires', s.expiresAt],
    ['ended', s.endedAt], ['reason', s.endReason],
    // Endpoint yes, token no — see the caller. `--json` carries both.
    ['endpoint', dataPlane?.endpoint ?? null],
  ];
  return fields
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k.padEnd(9)} ${String(v)}\n`)
    .join('');
}

function integer(flag: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`${flag} must be a whole number between ${min} and ${max}, not "${raw}".`);
  }
  return n;
}

async function version(): Promise<string> {
  // One source of truth. Read lazily so the common path never touches the filesystem.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return String(pkg.version);
}

try {
  process.exitCode = await main();
} catch (err) {
  process.stderr.write(`mfarm: ${describe(err)}\n`);
  if (err instanceof UsageError) process.stderr.write('mfarm: run "mfarm --help" for usage.\n');
  process.exitCode = EXIT_FAILURE;
}
