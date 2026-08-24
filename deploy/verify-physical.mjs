// What does `physical.ts` actually do when the device on the other end is somebody's phone?
//
//   node deploy/verify-physical.mjs                    # first device adb sees
//   node deploy/verify-physical.mjs --serial 39121FDH…
//   node deploy/verify-physical.mjs --samples 200      # more latency samples
//   node deploy/verify-physical.mjs --all              # list every package a reset would clear
//
// WHY THIS EXISTS, and why it is separate from verify-webdriver.mjs.
//
// `workers/agent/test/physical.test.ts` is 106 lines and every test in it asserts a field on
// `info` — the tier, the capability list, the screen geometry. Nothing in the suite has ever
// called `resetToSnapshot`, `send`, `health`, `screenshot` or `installApp`. The entire behavioural
// surface of that backend is unexecuted, and the first thing that would execute it is a tenant's
// session on a real handset.
//
// The obvious way to find out is to enroll a phone and run a suite, and that is what phase 0 of
// AGENT_BUILD_PLAN.md asks for. But releasing a session calls `resetToSnapshot`, which runs
// `pm clear` on every package `pm list packages -3` returns. On Cuttlefish that list is nearly
// empty. On a handset it is the owner's applications, and `pm clear` logs them out of all of them.
// Finding that out by doing it is not a test, it is an incident.
//
// So this probe answers the same questions WITHOUT clearing anything:
//
//   BLAST RADIUS   the exact list `resetToSnapshot` would clear on THIS phone, with the packages
//                  that would break the device if cleared called out by name. This is the number
//                  the plan predicted would surprise us, and it is cheaper to read than to survive.
//   FAILURE DETECTION
//                  whether a `pm clear` that fails is actually noticed. The safety property in
//                  PHYSICAL_DEVICES.md §6 — "a failed reset takes the device out of the pool" —
//                  depends entirely on adb exiting non-zero, because `run()` in physical.ts only
//                  rejects on a thrown error. If `pm` reports failure on stdout with exit code 0,
//                  a reset that cleared nothing reports success and the next session gets a dirty
//                  device. Probed against a package that does not exist, which clears nothing.
//   HELD SHELL     the input channel over USB, which §9's "known limitations" says nobody has
//                  measured. 39ms p50 is the emulator number. USB is a different bus.
//   RESET DURATION extrapolated from one real `pm clear` against a package with no data, times the
//                  blast radius. A reset that outruns the lease is a device stuck in CLEANING.
//   READ PATHS     screenshot, UI hierarchy, battery and storage — each parsed by physical.ts with
//                  a regex written against one OEM's output format.
//
// NOTHING HERE MUTATES THE DEVICE except `input keyevent KEYCODE_HOME`, which presses the home
// button. It installs nothing, clears nothing and uninstalls nothing.
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const SAMPLES = Number(args.get('samples') ?? 100);
// The blast-radius list runs to three figures on a real phone; `--all` prints every name.
const SHOW_ALL = process.argv.includes('--all');

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

let failures = 0;
let warnings = 0;
const ok = (m, d = '') => console.log(`  ${green('✓')} ${m}${d ? dim(` — ${d}`) : ''}`);
const bad = (m, d = '') => { failures++; console.log(`  ${red('✗')} ${m}${d ? dim(` — ${d}`) : ''}`); };
const warn = (m, d = '') => { warnings++; console.log(`  ${yellow('!')} ${m}${d ? dim(` — ${d}`) : ''}`); };

const ADB = process.env.ADB_PATH
  ?? (process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb');

/**
 * Unlike physical.ts's `run`, this resolves on a non-zero exit and hands back the code, because the
 * whole point of the failure-detection probe is to see the exit code physical.ts would throw on.
 */
function raw(argv, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile(ADB, argv, { timeout: timeoutMs, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      resolve({
        code: err?.code ?? 0,
        timedOut: Boolean(err?.killed),
        stdout: String(stdout).trim(),
        stderr: String(stderr).trim(),
      });
    });
  });
}

function pct(values, p) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function pickSerial() {
  const explicit = args.get('serial');
  if (explicit) return explicit;
  const { stdout } = await raw(['devices']);
  const usable = stdout.split('\n').slice(1)
    .map((l) => l.trim()).filter(Boolean)
    .filter((l) => /\tdevice$/.test(l))
    .map((l) => l.split('\t')[0]);
  if (usable.length === 0) {
    console.error(red('\nNo usable device.') + ' `adb devices` shows nothing in state `device`.');
    console.error('If a phone is plugged in, unlock it and tap "Allow USB debugging".\n');
    console.error(stdout);
    process.exit(2);
  }
  if (usable.length > 1) console.log(dim(`  (${usable.length} devices; using ${usable[0]} — pass --serial to choose)`));
  return usable[0];
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The four packages physical.ts refuses to clear whatever the config says. Duplicated from the
 * source rather than imported because it is not exported, and a drift between the two is itself
 * worth seeing in this output.
 */
const NEVER_CLEAR = new Set([
  'io.appium.settings',
  'io.appium.uiautomator2.server',
  'io.appium.uiautomator2.server.test',
  'com.android.shell',
]);

async function main() {
  const serial = await pickSerial();

  // Straight from source, so this probes the code that ships rather than a restatement of it.
  const physicalPath = join(HERE, '..', 'workers', 'agent', 'src', 'devices', 'physical.ts');
  const { PhysicalDevice } = await import(pathToFileURL(physicalPath).href);

  const prop = async (name) => (await raw(['-s', serial, 'shell', 'getprop', name], 10_000)).stdout;
  const [model, release, manufacturer, sdk] = await Promise.all([
    prop('ro.product.model'), prop('ro.build.version.release'),
    prop('ro.product.manufacturer'), prop('ro.build.version.sdk'),
  ]);

  console.log(`\n${bold('device')}   ${manufacturer} ${model} · Android ${release} (API ${sdk}) · ${serial}`);
  console.log(dim(`adb      ${ADB}`));

  const device = new PhysicalDevice({ serial, localId: `phone-${serial}`, model, osVersion: release });

  // ── 1. The held shell ─────────────────────────────────────────────────────────────────────────
  // start() waits for boot and opens the long-lived `adb shell`. Everything below the reset section
  // depends on it, and it has only ever been opened against an emulator and Cuttlefish.
  console.log(`\n${bold('Held shell')} ${dim('(physical.ts start / send — the input channel)')}`);
  const startedAt = performance.now();
  try {
    await device.start();
    ok('start() adopted the phone', `${Math.round(performance.now() - startedAt)}ms`);
  } catch (e) {
    bad('start() failed', e.message);
    console.log(red('\nNothing below can run without the shell. Stopping.\n'));
    process.exit(1);
  }

  // health() measures exactly this round trip and reports it as `inputLatencyMs`, so measuring the
  // same thing here is measuring the number the console will show, not a proxy for it.
  const rtt = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now();
    try {
      await device.key('home');
      rtt.push(performance.now() - t);
    } catch (e) {
      bad(`held shell died after ${i} sends`, e.message);
      break;
    }
  }
  if (rtt.length > 0) {
    const p50 = pct(rtt, 50), p95 = pct(rtt, 95), worst = Math.max(...rtt);
    console.log(`  ${dim(`${rtt.length} keyevents · p50 ${p50.toFixed(0)}ms · p95 ${p95.toFixed(0)}ms · worst ${worst.toFixed(0)}ms`)}`);
    // 100ms is physical.ts's own threshold: above it health() reports the device `degraded` with
    // "input latency above budget". A phone that is permanently degraded is a phone the console
    // permanently apologises for, so this is the line that decides whether that reads as noise.
    (p50 < 100 ? ok : bad)('input latency over USB', `p50 ${p50.toFixed(0)}ms against physical.ts\'s 100ms budget`);
    if (p95 > 100 && p50 < 100) {
      warn('p95 is over the budget even though p50 is under it',
        `${p95.toFixed(0)}ms — health() samples once, so it will intermittently call this device degraded`);
    }
  }

  // ── 2. The prerequisites nothing in the agent checks ──────────────────────────────────────────
  // PHYSICAL_DEVICES.md §1 asks a human to enable "Stay awake" and leave the phone unlocked, and
  // then no code anywhere confirms either. A locked, dozing handset enrolls, schedules, and fails
  // every session — and §18 will file those as test failures, because nothing knows better.
  //
  // This is the condition that produced the first three capture runs on this device: 2.2 fps, one
  // keyframe, 0.01 Mbps, all of them measurements of an always-on-display clock.
  console.log(`\n${bold('Prerequisites')} ${dim('(PHYSICAL_DEVICES.md §1 — nothing in the agent checks these)')}`);
  const power = (await raw(['-s', serial, 'shell', 'dumpsys', 'power'], 15_000)).stdout;
  const wake = /mWakefulness=(\w+)/.exec(power)?.[1] ?? 'unknown';
  const stayOn = (await raw(['-s', serial, 'shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in'], 10_000)).stdout;
  const locked = /mDreamingLockscreen=true/.test(
    (await raw(['-s', serial, 'shell', 'dumpsys', 'window'], 20_000)).stdout);

  (wake === 'Awake' ? ok : warn)('screen is awake', `mWakefulness=${wake}`);
  // 0 means the screen sleeps on its own timeout even while charging, which is what a farm device
  // must not do. Any non-zero value covers at least one charging mode.
  (stayOn !== '0' ? ok : warn)('"Stay awake" is enabled',
    stayOn === '0' ? 'stay_on_while_plugged_in=0 — the phone will doze mid-session' : `stay_on_while_plugged_in=${stayOn}`);
  (!locked ? ok : warn)('screen is unlocked',
    locked ? 'the keyguard is up — input lands on the lockscreen and most automation fails' : 'no keyguard');

  // ── 3. Reset blast radius ─────────────────────────────────────────────────────────────────────
  console.log(`\n${bold('What a reset would clear')} ${dim('(physical.ts resetToSnapshot — NOT executed)')}`);
  const listed = await raw(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], 60_000);
  const thirdParty = listed.stdout.split('\n')
    .map((l) => l.trim().replace(/^package:/, ''))
    .filter(Boolean);
  const wouldClear = thirdParty.filter((p) => !NEVER_CLEAR.has(p));

  console.log(`  ${dim(`pm list packages -3 returned ${thirdParty.length}; ${wouldClear.length} are not on the keep list`)}`);

  // The classes of package that do not merely lose their data when cleared, but leave the phone
  // unusable or unreachable afterwards. Read from the system's own current selections rather than
  // guessed from package names, because every OEM names these differently.
  const danger = new Map();
  const noteDanger = (pkg, why) => {
    if (!pkg || !wouldClear.includes(pkg)) return;
    danger.set(pkg, [...(danger.get(pkg) ?? []), why]);
  };

  // The current home app. Clearing a third-party launcher drops the user at a setup wizard, or at
  // nothing, and `input keyevent KEYCODE_HOME` at the end of the reset then goes nowhere.
  const homeRes = await raw(['-s', serial, 'shell', 'cmd', 'package', 'resolve-activity',
    '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'], 15_000);
  const homePkg = homeRes.stdout.split('\n').map((l) => l.trim())
    .find((l) => l.includes('/'))?.split('/')[0];
  noteDanger(homePkg, 'the current home screen');

  // The current keyboard. Clearing it can leave the phone with no IME selected, and every text
  // entry after that — including Appium's — silently does nothing.
  const ime = (await raw(['-s', serial, 'shell', 'settings', 'get', 'secure', 'default_input_method'], 15_000))
    .stdout.split('/')[0];
  noteDanger(ime, 'the current keyboard (IME)');

  // Device admins. An MDM agent that is cleared can re-enroll the phone, lock it, or wipe it;
  // PHYSICAL_DEVICES.md §6 names exactly this as a reason for the keep list.
  //
  // PARSED, NOT SUBSTRING-MATCHED. Searching the whole `dumpsys device_policy` dump for each
  // package name flagged all 133 third-party packages on the first handset this ran against —
  // because that dump also contains a numbered index of every package installed. A check that
  // fires on everything is the same as no check, only louder.
  const policy = (await raw(['-s', serial, 'shell', 'dumpsys', 'device_policy'], 20_000)).stdout;
  const adminPkgs = new Set([
    ...[...policy.matchAll(/mPackageName=\s*([\w.]+)/g)].map((m) => m[1]),
    ...[...policy.matchAll(/ComponentInfo\{([\w.]+)\//g)].map((m) => m[1]),
  ]);
  const owners = (await raw(['-s', serial, 'shell', 'dpm', 'list-owners'], 15_000)).stdout;
  for (const m of owners.matchAll(/([\w.]+)\//g)) adminPkgs.add(m[1]);
  for (const pkg of adminPkgs) noteDanger(pkg, 'holds device-admin policy');

  const a11y = (await raw(['-s', serial, 'shell', 'settings', 'get', 'secure', 'enabled_accessibility_services'], 15_000)).stdout;
  for (const pkg of wouldClear) if (a11y.includes(pkg)) noteDanger(pkg, 'an enabled accessibility service');

  if (wouldClear.length === 0) {
    ok('nothing would be cleared', 'this device carries no third-party packages');
  } else {
    // Not a failure — this is the designed behaviour. It is printed because the number is the
    // decision: on Cuttlefish it is ~0 and on a handset it is the owner's phone.
    warn(`${wouldClear.length} package(s) would have their data wiped`);
    // Everything dangerous, always. Then a sample of the rest, because a hundred and thirty lines
    // of package names is a wall people scroll past — and the ones that matter are at the top.
    for (const [p, why] of danger) console.log(`      ${red(p)}  ${red(`← ${why.join(', ')}`)}`);
    const ordinary = wouldClear.filter((p) => !danger.has(p));
    const shown = SHOW_ALL ? ordinary : ordinary.slice(0, 12);
    for (const p of shown) console.log(`      ${dim(p)}`);
    if (shown.length < ordinary.length) {
      console.log(dim(`      … and ${ordinary.length - shown.length} more (--all to list them)`));
    }
  }

  if (danger.size > 0) {
    bad(`${danger.size} package(s) would break the device itself, not just lose data`,
      'these belong in NEVER_CLEAR or PHYSICAL_KEEP_PACKAGES before any reset runs');
  } else if (wouldClear.length > 0) {
    ok('no package that would break the device is in the list', 'launcher, IME, admin and a11y all safe');
  }

  // ── 4. Is a failed clear actually detected? ───────────────────────────────────────────────────
  // PHYSICAL_DEVICES.md §6: "A failed reset takes the device out of the pool. That is the safety
  // property." physical.ts implements it by catching a rejection from `run()`, and `run()` only
  // rejects when execFile yields an error — i.e. a non-zero exit. If `pm` says Failed on stdout and
  // exits 0, every failure is invisible and the property does not hold.
  console.log(`\n${bold('Does a failed clear get noticed?')} ${dim('(the pool-safety property)')}`);
  const bogus = 'dev.mfarm.probe.no.such.package';
  const clearRes = await raw(['-s', serial, 'shell', 'pm', 'clear', bogus], 30_000);
  console.log(`  ${dim(`pm clear ${bogus} → exit ${clearRes.code}, stdout ${JSON.stringify(clearRes.stdout)}, stderr ${JSON.stringify(clearRes.stderr)}`)}`);
  const saysFailed = /fail/i.test(clearRes.stdout) || /fail/i.test(clearRes.stderr);
  if (clearRes.code !== 0) {
    ok('a clear that fails exits non-zero', 'physical.ts rejects, the device leaves the pool');
  } else if (saysFailed) {
    bad('a clear that fails still exits 0',
      'physical.ts only inspects thrown errors, so this reset reports success having cleared nothing');
  } else {
    warn('pm reported neither a failure nor a non-zero exit for a package that does not exist',
      'the failure path could not be probed on this device');
  }

  // ── 5. How long would a reset take? ───────────────────────────────────────────────────────────
  // Not academic: the control plane holds the device in CLEANING for the duration, and a reset that
  // outlives the lease is a device that never comes back READY.
  console.log(`\n${bold('How long a reset would take')}`);
  const t = performance.now();
  await raw(['-s', serial, 'shell', 'pm', 'clear', bogus], 30_000);
  const perClear = performance.now() - t;
  const estimate = (perClear * wouldClear.length) / 1000;
  console.log(`  ${dim(`one pm clear round trip ${perClear.toFixed(0)}ms × ${wouldClear.length} packages, run sequentially`)}`);
  // A real clear does more work than a no-op one, so this is a floor, and it is labelled as one.
  (estimate < 60 ? ok : warn)('estimated reset duration',
    `at least ${estimate.toFixed(0)}s — a floor; a clear that actually deletes data is slower`);

  // ── 6. The read paths ─────────────────────────────────────────────────────────────────────────
  // Each of these is parsed by a regex in physical.ts written against one vendor's output.
  console.log(`\n${bold('Read paths')} ${dim('(each one parses OEM output with a regex)')}`);

  try {
    const shot = await device.screenshot();
    ok('screenshot', `${(shot.bytes.length / 1024).toFixed(0)} KB ${shot.contentType}`);
  } catch (e) { bad('screenshot', e.message); }

  try {
    const xml = await device.uiHierarchy();
    const nodes = (xml.match(/<node /g) ?? []).length;
    (nodes > 0 ? ok : bad)('UI hierarchy', `${nodes} nodes, ${(xml.length / 1024).toFixed(0)} KB`);
  } catch (e) { bad('UI hierarchy', e.message); }

  try {
    const log = await device.dumpLogcat();
    ok('logcat dump', `${(log.length / 1024).toFixed(0)} KB`);
  } catch (e) { bad('logcat dump', e.message); }

  // health() folds battery and storage together and is what the console renders, so calling it is
  // more honest than probing dumpsys directly — a parse failure inside it is swallowed by design
  // (`.catch(() => undefined)`), and the way that shows up is a health report missing a reason.
  try {
    const h = await device.health();
    const detail = [
      h.status,
      h.reasonCode ? `reason ${h.reasonCode}` : null,
      h.inputLatencyMs !== undefined ? `input ${h.inputLatencyMs.toFixed(0)}ms` : null,
    ].filter(Boolean).join(' · ');
    (h.status === 'healthy' ? ok : warn)('health()', `${detail}${h.reason ? ` — ${h.reason}` : ''}`);
  } catch (e) { bad('health()', e.message); }

  // The two probes health() hides behind a catch. If either is silently failing, health() will
  // never report low battery or low storage on this OEM — it will just always look fine.
  const batt = await raw(['-s', serial, 'shell', 'dumpsys', 'battery'], 10_000);
  const battOk = /^\s*level:\s*(\d+)/m.exec(batt.stdout);
  (battOk ? ok : bad)('battery level parses', battOk ? `${battOk[1]}%` : 'the level: regex found nothing on this OEM');

  // Mirrors the corrected parse in physical.ts. `df -m` is rejected outright by this device's
  // toybox ("Unknown option 'm'"), and `df /data` reports its row mounted at `/data/user/0` — so
  // the old code missed twice over and `health()` swallowed both misses.
  const df = await raw(['-s', serial, 'shell', 'df', '/data'], 10_000);
  const dfRows = df.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const availKb = Number(dfRows.at(-1)?.split(/\s+/).at(-3));
  const parsed = dfRows.length >= 2 && Number.isFinite(availKb);
  (parsed ? ok : bad)('free storage parses',
    parsed ? `${Math.round(availKb / 1024)} MB free` : `df /data did not parse: ${JSON.stringify(dfRows.slice(0, 2))}`);

  await device.stop();

  console.log(failures === 0
    ? green(`\nThe physical backend works against this handset.${warnings > 0 ? ` ${warnings} thing(s) to read above before enrolling it.` : ''}\n`)
    : red(`\n${failures} check(s) failed — these are phase-0 findings, fix them before enrolling.\n`));
  process.exit(failures === 0 ? 0 : 1);
}

await main();
