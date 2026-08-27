/**
 * What a release actually does to somebody's phone — ADR-0012.
 *
 * WHY THIS IS A SEPARATE FILE FROM physical.test.ts. That one is explicit that no adb is spawned by
 * any of it, which is what makes it fast and phone-free — and it is also why the entire behavioural
 * surface of this backend went unexecuted until a handset ran it. `resetToSnapshot` is the method
 * that, on a borrowed device, can log its owner out of their bank. It does not get to be the
 * untested one.
 *
 * A FAKE adb ON DISK, not a stubbed method. `physical.ts` reads `ADB_PATH` at module scope and
 * shells out, so the only honest seam is a real executable — which also means these tests exercise
 * the argument lists and the output parsing rather than a mock's idea of them.
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let statePath: string;
let ledgerPath: string;
let PhysicalDevice: typeof import('../src/devices/physical.ts').PhysicalDevice;

/** The device's installed third-party packages, as the fake adb sees them. */
// The trailing newline is load-bearing: `echo >>` in the fake adb would otherwise append onto the
// last line and invent a package called `com.owner.chatcom.acme.tests`.
const setPackages = (pkgs: string[]) =>
  writeFile(statePath, pkgs.length ? `${pkgs.join('\n')}\n` : '');
const getPackages = async (): Promise<string[]> =>
  (await readFile(statePath, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * ONE directory for the whole file, not one per test.
 *
 * `physical.ts` resolves `ADB_PATH` at module scope, and a module is imported once — so a per-test
 * temp directory binds the fake adb to whichever directory happened to be first and every later
 * test shells out to a path that no longer exists. The state file is stable too and simply rewritten
 * between tests, which is also closer to the truth: a phone does not get replaced between sessions.
 */
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mfarm-reset-'));
  statePath = join(dir, 'packages.txt');
  ledgerPath = join(dir, 'ledger.json');

  // `install` maps an apk path to a package name via a sidecar file, so a test can say what an APK
  // contains without building one. `aapt2` reads the same sidecar.
  const adb = join(dir, 'adb');
  await writeFile(adb, `#!/bin/sh
# args: -s SERIAL <verb> ...
shift 2
verb="$1"; shift
state="${statePath}"
case "$verb" in
  install)
    apk=""
    for a in "$@"; do case "$a" in -*) ;; *) apk="$a";; esac; done
    pkg=$(cat "$apk.pkg")
    grep -qx "$pkg" "$state" || echo "$pkg" >> "$state"
    echo "Success"
    ;;
  uninstall)
    pkg="$1"
    grep -qx "$pkg" "$state" || { echo "Failure [DELETE_FAILED_INTERNAL_ERROR]"; exit 1; }
    grep -vx "$pkg" "$state" > "$state.tmp"; mv "$state.tmp" "$state"
    echo "Success"
    ;;
  shell)
    case "$*" in
      *"list packages"*) sed 's/^/package:/' "$state" ;;
      *) : ;;
    esac
    ;;
esac
exit 0
`);
  await chmod(adb, 0o755);

  const aapt2 = join(dir, 'aapt2');
  await writeFile(aapt2, `#!/bin/sh\ncat "$3.pkg"\n`);
  await chmod(aapt2, 0o755);

  process.env.ADB_PATH = adb;
  // Imported AFTER ADB_PATH is set: physical.ts resolves it at module scope, so a static import at
  // the top of this file would bind the real adb and every test here would drive the phone on the
  // desk.
  ({ PhysicalDevice } = await import('../src/devices/physical.ts'));
});

beforeEach(async () => {
  await setPackages(['com.owner.bank', 'com.owner.chat']);
  await rm(ledgerPath, { force: true });
});

after(async () => {
  delete process.env.ADB_PATH;
  await rm(dir, { recursive: true, force: true });
});

const makeApk = async (pkg: string): Promise<string> => {
  const apk = join(dir, `${pkg}.apk`);
  await writeFile(apk, 'not really an apk');
  await writeFile(`${apk}.pkg`, pkg);
  return apk;
};

const device = (extra: Record<string, unknown> = {}) => new PhysicalDevice({
  serial: 'FAKESERIAL', localId: 'phone-FAKESERIAL', ledgerPath,
  aapt2Path: join(dir, 'aapt2'), ...extra,
} as ConstructorParameters<typeof PhysicalDevice>[0]);

describe('an install-scoped release (the default)', () => {
  test('removes what the session installed and leaves the owner\'s apps alone', async () => {
    const d = device();
    await d.installApp(await makeApk('com.acme.tests'));
    assert.deepEqual((await getPackages()).sort(), ['com.acme.tests', 'com.owner.bank', 'com.owner.chat']);

    await d.resetToSnapshot();

    // The run that, before ADR-0012, would have cleared the data of every app on this list.
    assert.deepEqual((await getPackages()).sort(), ['com.owner.bank', 'com.owner.chat']);
  });

  test('a session that installed nothing clears nothing', async () => {
    // THE UNHAPPY PATH, and the one that mattered on hardware: a session that fails at creation is
    // still allocated and still released, so it still resets. Two of those fired before the product
    // had ever worked once.
    await device().resetToSnapshot();
    assert.deepEqual((await getPackages()).sort(), ['com.owner.bank', 'com.owner.chat']);
  });

  test('refuses to install over an app the owner already has', async () => {
    const d = device();
    const apk = await makeApk('com.owner.bank');
    await assert.rejects(() => d.installApp(apk), /refusing to install com\.owner\.bank/);
    // And it really did not touch it: the package list is untouched and nothing was ledgered.
    assert.deepEqual((await getPackages()).sort(), ['com.owner.bank', 'com.owner.chat']);
  });

  test('re-installing what THIS session installed is allowed', async () => {
    // A suite that installs its APK twice is ordinary, and the ledger already owns that package —
    // so the refusal above must not fire on it.
    const d = device();
    const apk = await makeApk('com.acme.tests');
    await d.installApp(apk);
    await d.installApp(apk);
    await d.resetToSnapshot();
    assert.deepEqual((await getPackages()).sort(), ['com.owner.bank', 'com.owner.chat']);
  });

  test('the ledger survives the agent forgetting everything', async () => {
    // A replug re-registers the agent, and an in-memory ledger would leave the tester's APK on a
    // personal phone with nothing that would ever remove it.
    await device().installApp(await makeApk('com.acme.tests'));
    const afterRestart = device();               // a fresh object, as a restart would build
    await afterRestart.resetToSnapshot();
    assert.deepEqual((await getPackages()).sort(), ['com.owner.bank', 'com.owner.chat']);
  });

  test('a failed uninstall keeps the ledger and fails the reset', async () => {
    // The pool-safety property: a reset that did not finish must reject, so the device leaves the
    // pool rather than being handed on with the last session's app still installed.
    const d = device();
    await d.installApp(await makeApk('com.acme.tests'));
    await setPackages(['com.owner.bank']);       // the app vanished from under us
    await assert.rejects(() => d.resetToSnapshot(), /could not uninstall 1 package/);
    assert.deepEqual(JSON.parse(await readFile(ledgerPath, 'utf8')), ['com.acme.tests']);
  });

  test('never uninstalls the automation helpers, even if they reach the ledger', async () => {
    const d = device({ ledgerPath });
    await writeFile(ledgerPath, JSON.stringify(['io.appium.settings', 'com.acme.tests']));
    await setPackages(['com.owner.bank', 'io.appium.settings', 'com.acme.tests']);
    await d.resetToSnapshot();
    assert.deepEqual((await getPackages()).sort(), ['com.owner.bank', 'io.appium.settings'],
      'uninstalling the helper leaves a phone that fails every session it is given');
  });
});

describe('a full-sweep release (opt-in)', () => {
  test('clears every third-party package except the keep list', async () => {
    const d = device({ resetMode: 'full-sweep', keepPackages: ['com.owner.bank'] });
    await d.installApp(await makeApk('com.acme.tests'));
    await d.resetToSnapshot();
    // `pm clear` leaves packages installed, so the list is unchanged — what this asserts is that
    // the sweep path ran at all rather than the uninstall one, which would have removed the app.
    assert.ok((await getPackages()).includes('com.acme.tests'),
      'the sweep clears data and leaves the package; uninstalling it means the wrong path ran');
  });
});
