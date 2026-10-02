/**
 * What a handset is missing before it can serve a session — D60.
 *
 * THE OUTPUTS BELOW ARE THE PHONE'S, not a guess at them. Captured from a OnePlus 8T (KB2001,
 * Android 14, OxygenOS) on 2026-10-03, with "Disable permission monitoring" off and then on. The
 * macOS adb parser bug came from tests written against the one output shape somebody had seen;
 * this file has both.
 *
 * A fake adb on disk for the reason physical-reset.test.ts gives: `physical.ts` resolves ADB_PATH
 * at module scope and shells out, so the honest seam is a real executable.
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let physical: typeof import('../src/devices/physical.ts');

/** The phone's state, one small file each, read by the fake adb on every call. */
const set = (name: string, value: string) => writeFile(join(dir, name), value);
const get = async (name: string) => (await readFile(join(dir, name), 'utf8').catch(() => '')).trim();

/** What OxygenOS prints when permission monitoring refuses a settings write. First lines, verbatim. */
const REFUSAL = `
Exception occurred while executing 'VERB':
java.lang.SecurityException: Permission denial, must have one of: [android.permission.WRITE_SECURE_SETTINGS]
\tat com.android.providers.settings.SettingsProvider.enforceHasAtLeastOnePermission(SettingsProvider.java:2656)
\tat com.android.providers.settings.SettingsProvider.mutateGlobalSetting(SettingsProvider.java:1610)`;

/** And the other two it refuses, also verbatim. The PID is whatever it was that day. */
const GRANT_REFUSAL = `
Exception occurred while executing 'grant':
java.lang.SecurityException: grantRuntimePermission: Neither user 2000 nor current process has android.permission.GRANT_RUNTIME_PERMISSIONS.`;
const CLEAR_REFUSAL = `
Exception occurred while executing 'clear':
java.lang.SecurityException: PID 21294 does not have permission android.permission.CLEAR_APP_USER_DATA to clear data of package dev.mfarm.probe.no.such.package
\tat com.android.server.am.ActivityManagerService.clearApplicationUserData(ActivityManagerService.java:3986)`;

/** `dumpsys window policy`, the part that answers the question. `SHOWING` is filled in per call. */
const POLICY = `    mKeyguardOccluded=false mKeyguardOccludedChanged=false mPendingKeyguardOccluded=false
    KeyguardServiceDelegate
      showing=SHOWING
      deviceHasKeyguard=true
      screenState=SCREEN_STATE_ON
      KeyguardStateMonitor
        mIsShowing=SHOWING`;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mfarm-prereq-'));
  await writeFile(join(dir, 'refusal.txt'), REFUSAL);
  await writeFile(join(dir, 'grant-refusal.txt'), GRANT_REFUSAL);
  await writeFile(join(dir, 'clear-refusal.txt'), CLEAR_REFUSAL);
  await writeFile(join(dir, 'policy.txt'), POLICY);

  const adb = join(dir, 'adb');
  await writeFile(adb, `#!/bin/sh
# args: -s SERIAL shell ...
shift 2
[ "$1" = shell ] || exit 0
shift
d="${dir}"
mode=$(cat "$d/mode" 2>/dev/null)
refuse() { sed "s/VERB/$1/" "$d/refusal.txt" >&2; exit 255; }
case "$*" in
  "settings delete global mfarm_prerequisite_probe; "*)
    # The three-command probe. What each mode prints is what the OnePlus printed in that state.
    [ "$mode" = unreachable ] && { echo "adb: device offline" >&2; exit 1; }
    # A phone on its way down: the shell still runs, and the services that would answer are gone.
    [ "$mode" = dying ] && { echo "cmd: Can't find service: settings" >&2; echo "cmd: Can't find service: package" >&2; echo mfarm-prerequisite-probe-ran; exit 0; }
    case "$mode" in
      restricted) sed "s/VERB/delete/" "$d/refusal.txt" >&2 ;;
      *) echo "Deleted 0 rows" ;;
    esac
    case "$mode" in
      restricted|half) cat "$d/grant-refusal.txt" "$d/clear-refusal.txt" >&2 ;;
      # AOSP's own complaint about a package that is not there: a SecurityException-free failure.
      aosp) echo "java.lang.IllegalArgumentException: Unknown package: dev.mfarm.probe.no.such.package" >&2; echo Failed >&2 ;;
      # A phone that allows it but throws a SecurityException of its own, about something else.
      noisy) echo "java.lang.SecurityException: Package dev.mfarm.probe.no.such.package has not requested permission android.permission.CAMERA" >&2; echo Failed >&2 ;;
      *) echo Failed >&2 ;;
    esac
    echo mfarm-prerequisite-probe-ran ;;
  "settings get global stay_on_while_plugged_in") cat "$d/stay" ;;
  "dumpsys window policy") sed "s/SHOWING/$(cat "$d/keyguard")/" "$d/policy.txt" ;;
  "settings get global verifier_verify_adb_installs") cat "$d/verify" 2>/dev/null || echo null ;;
  "settings put global verifier_verify_adb_installs 0")
    [ "$mode" = restricted ] && refuse put
    echo 0 > "$d/verify" ;;
  "settings delete global verifier_verify_adb_installs")
    echo deleted >> "$d/writes"
    [ "$mode" = restricted ] && refuse delete
    rm -f "$d/verify" ;;
esac
exit 0
`);
  await chmod(adb, 0o755);
  process.env.ADB_PATH = adb;
  // After ADB_PATH is set — a static import would bind the real adb and probe the phone on the desk.
  physical = await import('../src/devices/physical.ts');
});

after(async () => { await rm(dir, { recursive: true, force: true }); });

/** A phone ready to work: the state after every prerequisite was met on the real one. */
beforeEach(async () => {
  await set('mode', 'open');
  await set('stay', '15');
  await set('keyguard', 'false');
  await rm(join(dir, 'verify'), { force: true });
  await rm(join(dir, 'writes'), { force: true });
});

const phone = () => new physical.PhysicalDevice({ serial: 'FAKE8T', localId: 'phone-FAKE8T' });
const codes = async (p: InstanceType<typeof physical.PhysicalDevice>) => (await p.prerequisites()).map((x) => x.code);

describe('what a handset is missing', () => {
  test('a phone that is ready is missing nothing', async () => {
    assert.deepEqual(await codes(phone()), []);
  });

  test('nothing is known until the phone has been asked', () => {
    assert.equal(phone().unmetPrerequisites, undefined,
      'an empty list would say "ready" about a phone nobody has looked at');
  });

  /** D60. The state a OnePlus ships in. */
  test('a phone that refuses adb\'s settings write is blocked, with the switch named', async () => {
    await set('mode', 'restricted');
    const p = phone();
    const unmet = await p.prerequisites();
    assert.deepEqual(unmet.map((x) => x.code), ['adb-restricted']);
    assert.equal(unmet[0].blocks, true, 'no session can start, so it must not be offered for one');
    assert.match(unmet[0].remedy, /Disable permission monitoring/);
    assert.match(unmet[0].remedy, /restart the phone/, 'the switch alone did not lift it — measured');
    assert.deepEqual(p.unmetPrerequisites, unmet, 'the window reads the cached answer');
  });

  test('flipping the switch clears it on the next read, with no restart', async () => {
    await set('mode', 'restricted');
    const p = phone();
    assert.deepEqual(await codes(p), ['adb-restricted']);
    await set('mode', 'open');
    assert.deepEqual(await codes(p), []);
  });

  /**
   * A cable hiccup is not the restriction lifting. Reading it as one would offer a blocked phone
   * for sessions for as long as adb could not reach it.
   */
  test('a probe adb could not deliver keeps the last answer', async () => {
    await set('mode', 'restricted');
    const p = phone();
    await p.prerequisites();
    await set('mode', 'unreachable');
    assert.deepEqual(await codes(p), ['adb-restricted']);
  });

  /**
   * Seen on the handset: rebooted while blocked, the agent logged "can start sessions again" before
   * it had noticed the phone was gone. Nothing refused the probe because nothing was left to.
   */
  test('a phone that is shutting down has not had the restriction lifted', async () => {
    await set('mode', 'restricted');
    const p = phone();
    await p.prerequisites();
    await set('mode', 'dying');
    assert.deepEqual(await codes(p), ['adb-restricted']);
  });

  test('and a phone never yet reached is not called restricted', async () => {
    await set('mode', 'unreachable');
    assert.deepEqual(await codes(phone()), []);
  });

  /**
   * THE THREE DO NOT MOVE TOGETHER. With monitoring switched back on, the OnePlus refused `pm grant`
   * and `pm clear` at once and went on allowing the settings write. The first version of this probe
   * tried only the settings write and called that phone ready.
   */
  test('a phone that allows the settings write and refuses grant and clear is still blocked', async () => {
    await set('mode', 'half');
    assert.deepEqual(await codes(phone()), ['adb-restricted']);
  });

  test('an ordinary phone complaining that the package does not exist is not restricted', async () => {
    await set('mode', 'aosp');
    assert.deepEqual(await codes(phone()), []);
  });

  /** Withdrawing a working phone is the expensive mistake, so the match is on the permission named. */
  test('a SecurityException about something else is not the restriction', async () => {
    await set('mode', 'noisy');
    assert.deepEqual(await codes(phone()), []);
  });

  test('stay-awake off is said, and does not block', async () => {
    await set('stay', '0');
    const unmet = await phone().prerequisites();
    assert.deepEqual(unmet.map((x) => x.code), ['stay-awake-off']);
    assert.equal(unmet[0].blocks, false);
  });

  test('an unset stay-awake row is off — that is the default', async () => {
    await set('stay', 'null');
    assert.deepEqual(await codes(phone()), ['stay-awake-off']);
  });

  test('a lock screen is said, and does not block', async () => {
    await set('keyguard', 'true');
    const unmet = await phone().prerequisites();
    assert.deepEqual(unmet.map((x) => x.code), ['screen-locked']);
    assert.equal(unmet[0].blocks, false);
  });

  test('a factory phone reports all three, the blocking one first', async () => {
    await set('mode', 'restricted');
    await set('stay', '0');
    await set('keyguard', 'true');
    assert.deepEqual(await codes(phone()), ['adb-restricted', 'stay-awake-off', 'screen-locked']);
  });
});

describe('turning install verification off on a phone that refuses the write', () => {
  test('it says which switch, not forty lines of Java', async () => {
    await set('mode', 'restricted');
    const p = phone();
    await assert.rejects(p.disableInstallVerification(), (e: Error) => {
      assert.match(e.message, /Disable permission monitoring/);
      assert.doesNotMatch(e.message, /SettingsProvider\.java/);
      return true;
    });
    assert.notEqual(p.installVerification, 'off', 'the write did not land, so it is not off');
  });

  /** A prior value kept for a change that never happened made shutdown write to an untouched phone. */
  test('and nothing is restored at shutdown, because nothing was changed', async () => {
    await set('mode', 'restricted');
    const p = phone();
    await p.disableInstallVerification().catch(() => {});
    await p.restoreInstallVerification();
    assert.equal(await get('writes'), '', 'restore attempted a write on a phone it never changed');
  });

  test('on a phone that allows it, the change lands and is put back', async () => {
    const p = phone();
    await p.disableInstallVerification();
    assert.equal(await get('verify'), '0');
    assert.equal(p.installVerification, 'off');
    await p.restoreInstallVerification();
    assert.equal(await get('writes'), 'deleted', 'it was unset before, so restoring deletes the row');
  });
});
