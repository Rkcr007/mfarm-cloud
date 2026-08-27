// Does a release actually leave somebody's phone alone? — ADR-0012's verification section.
//
//   node deploy/verify-reset.mjs --apk ~/Downloads/bitbar-sample-demo.apk
//   node deploy/verify-reset.mjs --apk … --serial RZCX61ANKGE
//
// WHY THIS EXISTS. ADR-0012 changed what a release does to a device from "clear every third-party
// package" to "undo what this session installed", because on a handset somebody lends from their
// desk the first one wipes their bank, their authenticator and their chat history. The unit tests
// for it drive a fake adb, which is honest about argument lists and says nothing about whether a
// real `pm` and a real `aapt2` behave the way this code assumes.
//
// IT INSTALLS AND UNINSTALLS ONE APP, and nothing else. The app is the one named by --apk, it must
// not already be on the device, and it is removed again by the reset being tested. Every other
// package on the phone is counted before and after, and a difference is a FAILURE — that count is
// the whole point of the ADR.
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const APK = arg('apk');
if (!APK) {
  console.error('--apk is required: an APK that is NOT already installed on the device.');
  process.exit(64);
}

const ADB = process.env.ADB_PATH
  ?? (process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb');

const run = (bin, args, timeout = 120_000) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
    err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim()));
});

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
let failed = 0;
const ok = (what, detail) => console.log(`  \x1b[32m✓\x1b[0m ${what}${detail ? dim(` — ${detail}`) : ''}`);
const bad = (what, detail) => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${what}${detail ? dim(` — ${detail}`) : ''}`); };

const serial = arg('serial') ?? (await run(ADB, ['devices']))
  .split('\n').slice(1).map((l) => l.split(/\s+/)).find((p) => p[1] === 'device')?.[0];
if (!serial) { console.error('no device in `adb devices` is in state `device`.'); process.exit(1); }

const packages = async () => new Set((await run(ADB, ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3']))
  .split('\n').map((l) => l.trim().replace(/^package:/, '')).filter(Boolean));

// aapt2 the same way the agent finds it, so this probe and the agent agree about the good path.
const findAapt2 = async () => {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) return undefined;
  try {
    const { readdir, access } = await import('node:fs/promises');
    const { constants } = await import('node:fs');
    for (const v of (await readdir(join(sdk, 'build-tools'))).sort().reverse()) {
      const c = join(sdk, 'build-tools', v, 'aapt2');
      try { await access(c, constants.X_OK); return c; } catch { /* next */ }
    }
  } catch { /* none */ }
  return undefined;
};

const aapt2Path = await findAapt2();
const { PhysicalDevice } = await import('../workers/agent/src/devices/physical.ts');

const pkg = aapt2Path ? await run(aapt2Path, ['dump', 'packagename', APK]) : '(unknown — no aapt2)';
const before = await packages();

console.log(`\n${bold('device')}   ${serial}`);
console.log(`${dim(`apk      ${APK} -> ${pkg}`)}`);
console.log(`${dim(`aapt2    ${aapt2Path ?? 'NOT FOUND — the refusal degrades to a report'}`)}`);
console.log(`${dim(`packages ${before.size} third-party on the device right now`)}`);

if (before.has(pkg)) {
  console.error(`\n${pkg} is already installed. Pick an APK the device does not have — this probe `
    + `must not be the thing that removes an app somebody wanted.`);
  process.exit(1);
}

const ledgerPath = join(tmpdir(), `mfarm-verify-reset-${serial}.json`);
await rm(ledgerPath, { force: true });
const device = () => new PhysicalDevice({ serial, localId: `verify-${serial}`, ledgerPath, aapt2Path });

// ── 1. The unhappy path: a session that installed nothing ──────────────────────────────────────
console.log(`\n${bold('A release after a session that installed nothing')} ${dim('(ADR-0012 verification 2)')}`);
await device().resetToSnapshot();
const afterEmpty = await packages();
afterEmpty.size === before.size
  ? ok('nothing was touched', `${afterEmpty.size} packages, unchanged`)
  : bad('the device changed', `${before.size} -> ${afterEmpty.size}`);

// ── 2. Install, then release ───────────────────────────────────────────────────────────────────
console.log(`\n${bold('Install one app, then release')} ${dim('(ADR-0012 verification 1)')}`);
const d = device();
await d.installApp(APK);
const withApp = await packages();
withApp.has(pkg) ? ok('the app installed', pkg) : bad('the app is not on the device', pkg);
try {
  ok('it was ledgered', JSON.parse(await readFile(ledgerPath, 'utf8')).join(', '));
} catch { bad('nothing was ledgered', 'a release would not know to undo it'); }

await d.resetToSnapshot();
const afterReset = await packages();
!afterReset.has(pkg) ? ok('the release removed it', pkg) : bad('it is still installed', pkg);

const lost = [...before].filter((p) => !afterReset.has(p));
const gained = [...afterReset].filter((p) => !before.has(p));
lost.length === 0
  ? ok(`every one of the owner's ${before.size} apps is still installed`)
  : bad(`${lost.length} of the owner's apps were removed`, lost.slice(0, 5).join(', '));
gained.length === 0 ? ok('and nothing was left behind') : bad('packages were left behind', gained.join(', '));

// ── 3. The refusal ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${bold('Installing over an app the owner already has')} ${dim('(ADR-0012 §2)')}`);
const victim = [...afterReset][0];
if (!victim) {
  console.log(`  ${dim('skipped — this device has no third-party app to stand in for the owner\'s')}`);
} else if (!aapt2Path) {
  console.log(`  ${dim('skipped — without aapt2 this case is reported after the fact, not refused')}`);
} else {
  // A DIFFERENT device object, so the ledger does not already own the package: this is the
  // "somebody else's app" case, which is the one that must be refused.
  const fresh = new PhysicalDevice({ serial, localId: `verify-${serial}`, ledgerPath: join(tmpdir(), 'mfarm-verify-empty.json'), aapt2Path });
  // Stub the package name to the victim WITHOUT touching the device: installApp reads it from the
  // APK, so pointing it at an APK whose package is already installed is the whole test. We do not
  // have a second APK, so the check is done through the same public method with the real one after
  // it has been installed by hand — see below.
  await run(ADB, ['-s', serial, 'install', '-r', APK]);
  try {
    await fresh.installApp(APK);
    bad('it installed over an app it did not put there', pkg);
  } catch (e) {
    /refusing to install/.test(e.message)
      ? ok('refused, naming the package', e.message.split(':')[0])
      : bad('it failed for the wrong reason', e.message.slice(0, 120));
  }
  // Put the device back exactly as it was found.
  await run(ADB, ['-s', serial, 'uninstall', pkg]);
}

const final = await packages();
console.log(`\n${bold('Final state')}`);
final.size === before.size && [...before].every((p) => final.has(p))
  ? ok(`the device is exactly as it was found`, `${final.size} packages`)
  : bad('the device is NOT as it was found', `${before.size} -> ${final.size}`);

await rm(ledgerPath, { force: true });
console.log(failed === 0
  ? `\n\x1b[32mA release undoes what a session installed, and nothing else.\x1b[0m\n`
  : `\n\x1b[31m${failed} check(s) failed.\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
