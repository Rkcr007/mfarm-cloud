import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Capability } from '@mfarm/protocol';
import type {
  DeviceBackend, DeviceControl, DeviceHealth, DeviceInfo, KeyName, LogcatHandle, MediaSource, Screen,
} from '../device.ts';

/**
 * A physical Android handset on the end of a USB cable (ADR-0008, spec §9 "USB first").
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER TWO TIERS, and it is not the adb commands — those are
 * nearly identical to `avd.ts`. It is ownership. A Cuttlefish or an AVD is a process this agent
 * starts, owns and can throw away; a phone exists before the agent does and outlives it. Three
 * consequences run through everything below:
 *
 *   1. `start()` and `stop()` do NOT create or destroy the device. Nothing here may power a
 *      handset off — the agent would have no way to turn it back on, and a farm that bricks a
 *      teammate's phone until someone walks over to it is worse than one that never had it.
 *   2. There is no snapshot, so there is no clean image to return to. See `resetToSnapshot`.
 *   3. It can vanish mid-session, and it comes back with the same serial. Discovery, not this
 *      class, owns that — see `trackDevices` in `discovery.ts`.
 *
 * DELIBERATELY NO `screen-stream`. A phone publishes no WebRTC stream the way Cuttlefish does, and
 * the honest options are scrcpy-over-RTP (unbuilt, and ADR-0008 names its throughput in Node as the
 * largest open risk) or a screenshot loop (a false performance baseline that would survive into
 * production). Until one is built and measured, this tier says it cannot stream, and the console
 * offers no live view rather than a bad one. `screenshot` is a separate capability and IS declared:
 * "what was on screen when it failed" is a different question from "show me the device", and adb
 * answers it fine.
 */

const ADB = process.env.ADB_PATH ?? (process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb');

const KEYCODES: Record<KeyName, string> = {
  home: 'KEYCODE_HOME', back: 'KEYCODE_BACK', recents: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER', enter: 'KEYCODE_ENTER', backspace: 'KEYCODE_DEL',
  volume_up: 'KEYCODE_VOLUME_UP', volume_down: 'KEYCODE_VOLUME_DOWN',
};

/**
 * Packages never removed by a reset, whatever `PHYSICAL_KEEP_PACKAGES` says.
 *
 * `resetToSnapshot` clears third-party packages, and on a real handset "third party" includes the
 * things that make the device reachable at all. Uninstalling the Appium server mid-farm leaves a
 * phone that enrolls, schedules, and fails every session with an error pointing at the test.
 */
/**
 * An install the DEVICE refused, as opposed to one that failed.
 *
 * Its own class because the caller has to tell these apart to classify the incident, and matching
 * adb's wording in two places is how the two copies drift. `remedy` is a sentence for a person, not
 * a log line: this is the single most likely thing to stop somebody's first session, and the fix is
 * a setting on their phone that they, not we, have to agree to.
 */
export class InstallBlockedError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'InstallBlockedError';
    this.remedy = remedy;
  }
}

/**
 * What adb says when the package verifier refuses an APK.
 *
 * Two spellings because OEMs differ: AOSP reports VERIFICATION_FAILURE, and some builds report the
 * user-restriction form when the same block is applied by policy. Both mean "the phone declined",
 * and both have the same remedy.
 */
const INSTALL_BLOCKED = /INSTALL_FAILED_VERIFICATION_FAILURE|INSTALL_FAILED_USER_RESTRICTED|verification (failed|timed out)/i;

/** The global setting that decides whether Play Protect vets APKs pushed over adb. */
export const ADB_VERIFY_SETTING = 'verifier_verify_adb_installs';

/**
 * How a release cleans this device — ADR-0012.
 *
 * `install-scoped` IS THE DEFAULT, and the default is the whole decision. The alternative sweeps
 * every third-party package, which on an operator-owned farm phone is nearly nothing and on a
 * handset somebody lent from their desk is 134 apps including their bank and their authenticator.
 * A default that is safe only when an operator remembers a variable is not a safe default, and the
 * failure is not recoverable.
 */
export type ResetMode = 'install-scoped' | 'full-sweep';

const NEVER_CLEAR = [
  'io.appium.settings',
  'io.appium.uiautomator2.server',
  'io.appium.uiautomator2.server.test',
  'com.android.shell',
];

export interface PhysicalOptions {
  /** The adb serial. Stable across a USB replug, which is what makes it the identity. */
  serial: string;
  localId: string;
  /** Populated by discovery from `getprop`; a device that answers none of it still enrolls. */
  model?: string;
  osVersion?: string;
  manufacturer?: string;
  sdkVersion?: number;
  screen?: Screen;
  /**
   * Packages a reset must leave alone, beyond NEVER_CLEAR — a corporate VPN client, an MDM agent,
   * a test account helper. Spec §17: the reset strategy must be configurable and must never be a
   * factory reset.
   */
  keepPackages?: string[];
  /**
   * How a release cleans this device. Defaults to `install-scoped` (ADR-0012) — `full-sweep` is
   * the pre-ADR behaviour and is a choice the device's OWNER makes, after being shown what it
   * would clear, never a default anything falls into.
   */
  resetMode?: ResetMode;
  /**
   * Where the install ledger is persisted. Overridable so a test does not write to `$HOME`, and
   * so two agents on one machine cannot share a file.
   */
  ledgerPath?: string;
  /** `aapt2`, for reading an APK's package name before installing it. See `packageNameOf`. */
  aapt2Path?: string;
}

function run(bin: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${bin} ${args.join(' ')}: ${stderr.trim() || err.message}`));
      resolve(stdout.trim());
    });
  });
}

/** Raw bytes, for the two commands whose output is not text. */
function runBinary(bin: string, args: string[], timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${bin} ${args.join(' ')}: ${stderr.toString().trim() || err.message}`));
        resolve(stdout);
      });
  });
}

/** How long one `adb install` may take. Matches the other tiers; see avd.ts for why it is generous. */
const INSTALL_TIMEOUT_MS = 600_000;

export class PhysicalDevice implements DeviceControl {
  readonly info: DeviceInfo;
  private readonly serial: string;
  private readonly keep: Set<string>;
  private readonly resetMode: ResetMode;
  private readonly ledgerPath: string;
  private readonly aapt2Path?: string;
  /**
   * What this session installed, and therefore the entire blast radius of an `install-scoped`
   * release.
   *
   * PERSISTED, not just held in memory. The agent restarting mid-session is ordinary — a phone
   * replug re-registers it — and an in-memory ledger would forget the tester's APK, leaving it on
   * somebody's personal phone with nothing that would ever remove it. A file costs one write per
   * install and closes that hole.
   */
  private installed: string[] = [];
  /** What `verifier_verify_adb_installs` was before we touched it, so it can be put back exactly. */
  private priorVerifySetting?: string;
  /** Held open for the life of the device. Reopening per event costs 57-77ms of pure overhead. */
  private shell?: ReturnType<typeof spawn>;
  private shellSeq = 0;

  constructor(opts: PhysicalOptions) {
    this.serial = opts.serial;
    this.keep = new Set([...NEVER_CLEAR, ...(opts.keepPackages ?? [])]);
    this.resetMode = opts.resetMode ?? 'install-scoped';
    this.aapt2Path = opts.aapt2Path;
    // Per DEVICE, not per host: two phones on one laptop have separate ledgers, and the serial is
    // the identity that survives a replug.
    this.ledgerPath = opts.ledgerPath
      ?? join(process.env.HOME ?? '/tmp', '.mfarm', `installed-${opts.serial}.json`);
    this.info = {
      localId: opts.localId,
      platform: 'android',
      tier: 'physical',
      model: opts.model ?? opts.serial,
      osVersion: opts.osVersion ?? 'unknown',
      /**
       * `session-reset`, NOT `snapshot-reset`, and the distinction is load-bearing (ADR-0008).
       * Package-level cleanup does not give the next tenant a clean device — accounts, keychain
       * items and granted permissions survive it. What makes this schedulable at all is that the
       * host is org-pinned (migration 023), so the next tenant is the same org. Declaring
       * `snapshot-reset` here to "make it work" would put a dirty handset into the shared pool.
       *
       * `input-datachannel` is honest for the same reason avd.ts claims it: the held shell is a
       * persistent channel with no per-event process spawn. It is slow (~39ms p50 measured on an
       * emulator; unmeasured over USB) and `health()` says so rather than hiding it.
       */
      capabilities: [
        'input-datachannel',
        // WHICH RESET THIS DEVICE ACTUALLY DOES, never both and never the stronger one by default
        // (ADR-0012). The scheduler reads this to decide the device can be handed on at all, and a
        // device that swept nothing while claiming `session-reset` would be claiming the next
        // session gets clean applications when it does not.
        (opts.resetMode ?? 'install-scoped') === 'full-sweep' ? 'session-reset' : 'install-reset',
        'app-install', 'logcat', 'screenshot', 'ui-hierarchy',
      ] as Capability[],
      // A real panel, once discovery has read it. The fallback is a common phone geometry rather
      // than zeroes, because the console divides by these to map a click to a coordinate.
      screen: opts.screen ?? { width: 1080, height: 2400, density: 420 },
      adbSerial: opts.serial,
    };
  }

  private adb(args: string[], timeoutMs = 30_000): Promise<string> {
    return run(ADB, ['-s', this.serial, ...args], timeoutMs);
  }

  /**
   * Adopt a phone that is already there.
   *
   * Waits for boot rather than assuming it: a device replugged mid-reboot answers `adb devices`
   * before it answers anything useful, and every command issued in that window fails in a way that
   * reads like a broken device rather than a booting one.
   */
  async start(): Promise<void> {
    await this.waitForBoot();
    await this.openShell();
  }

  /**
   * Release the phone. NOT a power-off — see the class comment.
   *
   * Closing the held shell is the whole of it. The device stays enrolled and reachable; the agent
   * simply stops holding a process against it.
   */
  async stop(): Promise<void> {
    await this.closeShell();
  }

  private async waitForBoot(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = 'no answer from adb';
    while (Date.now() < deadline) {
      try {
        if ((await this.adb(['shell', 'getprop', 'sys.boot_completed'], 5_000)) === '1') return;
        last = 'boot not completed';
      } catch (e) { last = (e as Error).message; }
      await sleep(1000);
    }
    throw new Error(`${this.serial} did not reach boot_completed within ${timeoutMs}ms: ${last}`);
  }

  /** One long-lived shell. See avd.ts for why this matters more than it looks. */
  private async openShell(): Promise<void> {
    await this.closeShell();
    const sh = spawn(ADB, ['-s', this.serial, 'shell'], { stdio: ['pipe', 'pipe', 'ignore'] });
    // An unhandled 'error' on a stream is an uncaught exception, which would take down the agent and
    // with it every other phone on this host because one cable was pulled. Kept local: the in-flight
    // send() times out and health() reports the device offline.
    const note = (e: Error) => console.error(`[physical:${this.serial}] shell pipe failed: ${e.message}`);
    sh.on('error', note);
    sh.stdin?.on('error', note);
    sh.stdout?.on('error', note);
    this.shell = sh;
  }

  private async closeShell(): Promise<void> {
    if (!this.shell) return;
    this.shell.stdin?.end();
    this.shell.kill();
    this.shell = undefined;
  }

  /** Send a command down the held shell and wait for its echoed marker. */
  private send(cmd: string, timeoutMs = 10_000): Promise<void> {
    const sh = this.shell;
    if (!sh?.stdin || !sh.stdout) return Promise.reject(new Error('shell not open; call start() first'));
    const marker = `__mf${++this.shellSeq}__`;
    return new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => { sh.stdout!.off('data', onData); reject(new Error(`shell timeout: ${cmd}`)); }, timeoutMs);
      const onData = (d: Buffer) => {
        buf += d.toString();
        if (buf.includes(marker)) { clearTimeout(t); sh.stdout!.off('data', onData); resolve(); }
      };
      sh.stdout!.on('data', onData);
      sh.stdin!.write(`${cmd}; echo ${marker}\n`);
    });
  }

  /**
   * Package-level cleanup — spec §17, and the honest limit of what a handset can promise.
   *
   * NAMED `resetToSnapshot` BECAUSE THAT IS THE INTERFACE METHOD, and the interface's own comment
   * says package cleanup is insufficient between tenants. That comment is correct and is not being
   * argued with here: this device declares `session-reset`, never `snapshot-reset`, and is pinned
   * to one org for exactly that reason. What this gives is a clean *application* state for the next
   * session of the same tenant, which is what §17 asks for.
   *
   * WHAT IT DELIBERATELY DOES NOT DO. No factory reset (§17: never automatically, and the agent
   * could not re-authorize adb afterwards anyway). No `pm clear` on system packages — clearing
   * `com.android.systemui` or a vendor package soft-bricks the phone until someone reboots it by
   * hand. It clears third-party packages only, minus the keep list.
   *
   * A FAILURE HERE MUST THROW. The control plane reads a rejected reset as "do not return this
   * device to the pool", which is the entire safety property; swallowing an error would hand the
   * next session a device carrying the last one's logins.
   */
  async resetToSnapshot(): Promise<void> {
    if (this.resetMode === 'install-scoped') return this.resetByUninstall();
    return this.resetBySweep();
  }

  /**
   * The default: undo exactly what this session installed, and touch nothing else (ADR-0012).
   *
   * Uninstall rather than `pm clear`, and the difference is the whole point. `pm clear` wipes an
   * app's data and leaves it installed, which is right for a farm phone that will run the same
   * suite again and wrong for a borrowed one — it would leave the tester's APK sitting on
   * somebody's home screen after they unplugged the cable.
   *
   * Reverse order, because a suite that installed a test harness after the app under test should
   * see them removed the other way round.
   *
   * AN EMPTY LEDGER IS A SUCCESSFUL RESET, not a suspicious one. A session that failed before it
   * installed anything has nothing to undo — which is exactly the case that, before this ADR, fired
   * a full package sweep on the unhappy path before the product had ever worked once.
   */
  private async resetByUninstall(): Promise<void> {
    const ledger = this.installed.length > 0 ? this.installed : await this.loadLedger();
    const failed: string[] = [];

    for (const pkg of [...ledger].reverse()) {
      // NEVER_CLEAR is honoured here too. The automation helpers are installed by the driver
      // rather than by a session, but a ledger that ever picked one up must not uninstall the
      // thing the next session needs in order to run at all.
      if (this.keep.has(pkg)) continue;
      try {
        await this.adb(['uninstall', pkg], 120_000);
      } catch (e) {
        failed.push(`${pkg} (${(e as Error).message})`);
      }
    }

    try {
      await this.adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'], 10_000);
    } catch { /* the failure that matters is the uninstall above, not the keypress */ }

    if (failed.length > 0) {
      // The ledger is deliberately NOT cleared: what could not be removed is still on the device
      // and still ours to remove, and the device is about to leave the pool anyway.
      throw new Error(
        `could not uninstall ${failed.length} package(s) this session installed on `
        + `${this.info.localId}, so they are still on the device: `
        + `${failed.slice(0, 3).join('; ')}${failed.length > 3 ? ' …' : ''}`);
    }

    await this.saveLedger([]);
    await rm(this.ledgerPath, { force: true });
  }

  /**
   * The opt-in sweep: every third-party package minus the keep list.
   *
   * Unchanged from what ADR-0008 shipped, and no longer the default — see ADR-0012 for why, and
   * `deploy/verify-physical.mjs` for what it would clear on a given handset before anyone agrees
   * to it.
   */
  private async resetBySweep(): Promise<void> {
    const listed = await this.adb(['shell', 'pm', 'list', 'packages', '-3'], 60_000);
    const packages = listed.split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter((p) => p && !this.keep.has(p));

    const failed: string[] = [];
    for (const pkg of packages) {
      try {
        // `pm clear` wipes data and cache and leaves the app installed. Preferred over uninstall:
        // a suite that reinstalls its APK every session pays a full install either way, and a suite
        // that does not still finds its app present.
        await this.adb(['shell', 'pm', 'clear', pkg], 60_000);
      } catch (e) {
        failed.push(`${pkg} (${(e as Error).message})`);
      }
    }

    // Close whatever is on screen and return to the launcher, so the next session starts where it
    // would on a fresh device rather than mid-way through the last one's flow.
    try {
      await this.adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'], 10_000);
    } catch { /* the failure that matters is the clear above, not the keypress */ }

    // Re-open the shell: `pm clear` on a package the shell touched can leave the held process in a
    // state where the next marker never echoes, and a device stuck in CLEANING is worse than a slow one.
    await this.openShell();

    if (failed.length > 0) {
      throw new Error(
        `could not clear ${failed.length} package(s) on ${this.info.localId}, so it is not clean for `
        + `the next session: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? ' …' : ''}`);
    }

    // A sweep supersedes the ledger — everything in it was just cleared — so leaving entries behind
    // would have the NEXT release uninstall packages this one already dealt with.
    await this.saveLedger([]);
    await rm(this.ledgerPath, { force: true });
  }

  // ---------------------------------------------------------------- the install ledger (ADR-0012)

  /** Third-party packages currently on the device, as a set. The one question `pm` answers cheaply. */
  private async thirdPartyPackages(): Promise<Set<string>> {
    const out = await this.adb(['shell', 'pm', 'list', 'packages', '-3'], 60_000);
    return new Set(
      out.split('\n').map((l) => l.trim().replace(/^package:/, '')).filter(Boolean),
    );
  }

  private async loadLedger(): Promise<string[]> {
    try {
      const raw = JSON.parse(await readFile(this.ledgerPath, 'utf8')) as unknown;
      return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
    } catch {
      // Absent, unreadable or corrupt all mean the same thing and it is the SAFE thing: this device
      // has nothing recorded, so a release uninstalls nothing. The failure direction matters —
      // guessing from a damaged file is how you uninstall somebody's app.
      return [];
    }
  }

  private async saveLedger(packages: string[]): Promise<void> {
    this.installed = packages;
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    await writeFile(this.ledgerPath, JSON.stringify(packages), { mode: 0o600 });
  }

  /**
   * An APK's package name, read from the file BEFORE it is installed.
   *
   * This is what makes the refusal in `installApp` a refusal rather than an apology: knowing the
   * name up front is the difference between declining to overwrite the owner's app and discovering
   * afterwards that we already did.
   *
   * `aapt2` ships in the Android SDK's build-tools, which the farm already treats as a dependency
   * (`deploy/install-build-tools.sh`, and farm-up.sh warns when it is missing because `appium:app`
   * needs it too). Returns undefined when it is absent, and the caller degrades — it does not
   * pretend to know.
   */
  private async packageNameOf(apkPath: string): Promise<string | undefined> {
    if (!this.aapt2Path) return undefined;
    try {
      const out = await run(this.aapt2Path, ['dump', 'packagename', apkPath], 60_000);
      const name = out.split('\n')[0]?.trim();
      return name && /^[A-Za-z][\w.]*$/.test(name) ? name : undefined;
    } catch {
      return undefined;
    }
  }

  async installApp(apkPath: string): Promise<void> {
    if (this.resetMode !== 'install-scoped') {
      await this.rawInstall(apkPath);
      return;
    }

    if (this.installed.length === 0) this.installed = await this.loadLedger();
    const pkg = await this.packageNameOf(apkPath);

    /**
     * THE GOOD PATH: we know what is in the APK before it touches the device.
     *
     * With the name in hand there is nothing to deduce afterwards — the refusal below is a refusal
     * rather than an apology, and no second `pm list packages` is needed to find out what landed.
     */
    if (pkg) {
      // Re-installing what this session already installed is ordinary; a suite that pushes its APK
      // once per test does it constantly. The ledger already owns the package, so a release still
      // undoes exactly one thing.
      if (!this.installed.includes(pkg)) {
        /**
         * REFUSING TO INSTALL OVER AN APP THE OWNER ALREADY HAS (ADR-0012 §2).
         *
         * The ledger's contract is that a release undoes exactly what a session did. It cannot undo
         * this: uninstalling takes the owner's copy AND their data, and there is no version to put
         * back. A failed test is recoverable; silently replacing somebody's banking app is not.
         */
        if ((await this.thirdPartyPackages()).has(pkg)) {
          throw new Error(
            `refusing to install ${pkg} on ${this.info.localId}: it is already installed and was `
            + `not put there by this session, so a release could not undo it without taking the `
            + `owner's copy and its data. Remove it from the device first, or set this device to `
            + `full-sweep.`,
          );
        }
      }
      await this.rawInstall(apkPath);
      // Ledgered AFTER the install succeeds. The other order would have a release try to uninstall
      // something that was never there, which fails, which takes a healthy device out of the pool.
      if (!this.installed.includes(pkg)) await this.saveLedger([...this.installed, pkg]);
      return;
    }

    /**
     * THE DEGRADED PATH: no `aapt2`, so the package name is unknowable in advance.
     *
     * All that is left is to look at the device before and after and see what appeared. It cannot
     * prevent an overwrite — by the time the difference is visible the owner's app is already
     * gone — so it reports one loudly instead. `index.ts` warns about this at startup, where there
     * is still time to install build-tools.
     */
    const before = await this.thirdPartyPackages();
    await this.rawInstall(apkPath);
    const fresh = [...await this.thirdPartyPackages()].filter((p) => !before.has(p));

    if (fresh.length === 0) {
      throw new Error(
        `installed an APK on ${this.info.localId} that added no new package, so it either REPLACED `
        + `one already on the device — which a release cannot undo — or reinstalled one this `
        + `session had already installed. Without aapt2 the agent cannot tell those apart. Install `
        + `build-tools so it can refuse the dangerous one before it happens: `
        + `deploy/install-build-tools.sh`,
      );
    }
    await this.saveLedger([...this.installed, ...fresh.filter((p) => !this.installed.includes(p))]);
  }

  /**
   * The install itself, with adb's habit of reporting failure on stdout accounted for.
   *
   * A REFUSAL IS NOT A FAILURE, and separating them is the whole of M1. Play Protect declining an
   * APK looks like any other non-zero adb exit, so it used to surface as `upstream_rejected` after
   * a 60-second timeout — several hops from a cause that has a one-line fix. It blocks Appium's own
   * helper APKs too, which are debug-signed, so a stock phone cannot run a session at all until
   * somebody deals with it.
   */
  private async rawInstall(apkPath: string): Promise<void> {
    let out: string;
    try {
      out = await this.adb(['install', '-r', apkPath], INSTALL_TIMEOUT_MS);
    } catch (e) {
      // adb exits non-zero AND prints the reason to stderr, which `run` folds into the message.
      const msg = (e as Error).message;
      if (INSTALL_BLOCKED.test(msg)) throw this.installBlocked(msg);
      throw e;
    }
    if (INSTALL_BLOCKED.test(out)) throw this.installBlocked(out.trim().split('\n').slice(-2).join(' '));
    if (/^\s*(Failure|Error)/im.test(out)) {
      throw new Error(`adb install failed on ${this.info.localId}: ${out.trim().split('\n').slice(-3).join(' ')}`);
    }
  }

  private installBlocked(detail: string): InstallBlockedError {
    return new InstallBlockedError(
      `${this.info.localId} refused the install: the phone's package verifier blocked it. ${detail}`,
      `On the phone this shows as "Harmful app blocked". It is Play Protect vetting an APK pushed `
      + `over adb, and it refuses debug-signed builds — including the automation helpers, so no `
      + `session can run until it is dealt with. Either tap through the prompt on the device, or `
      + `turn off adb-install verification for this phone: `
      + `adb -s ${this.serial} shell settings put global ${ADB_VERIFY_SETTING} 0. `
      + `That is the device owner's decision, so the agent will not do it unless asked `
      + `(PHYSICAL_ALLOW_INSTALL_VERIFICATION_OFF=1).`,
    );
  }

  /**
   * Will installs be refused on this device? Read at start-up, so the answer arrives before a
   * session needs it rather than 60 seconds into somebody's first test.
   *
   * `null` means the setting is unset, which is the DEFAULT and means verification is ON. Reading
   * it is not changing it — this method never writes.
   */
  async installVerificationOn(): Promise<boolean> {
    const raw = (await this.adb(['shell', 'settings', 'get', 'global', ADB_VERIFY_SETTING], 15_000)).trim();
    return raw !== '0';
  }

  /**
   * Turn adb-install verification off, and remember what it was.
   *
   * ONLY EVER CALLED BEHIND AN EXPLICIT OPT-IN. This is a security setting on somebody's personal
   * phone: the agent proposes, the owner disposes. `restoreInstallVerification` puts it back, and
   * the previous value is captured rather than assumed so restoring cannot silently ENABLE a
   * setting the owner had deliberately turned off before we arrived.
   */
  async disableInstallVerification(): Promise<void> {
    if (this.priorVerifySetting === undefined) {
      this.priorVerifySetting = (await this.adb(
        ['shell', 'settings', 'get', 'global', ADB_VERIFY_SETTING], 15_000)).trim();
    }
    await this.adb(['shell', 'settings', 'put', 'global', ADB_VERIFY_SETTING, '0'], 15_000);
  }

  /** Put the setting back exactly as it was found. A no-op if we never changed it. */
  async restoreInstallVerification(): Promise<void> {
    const prior = this.priorVerifySetting;
    if (prior === undefined) return;
    this.priorVerifySetting = undefined;
    // `null` is how `settings get` spells "unset", and the way to restore that is to delete the
    // row rather than to write the string "null" into it.
    if (prior === 'null' || prior === '') {
      await this.adb(['shell', 'settings', 'delete', 'global', ADB_VERIFY_SETTING], 15_000);
    } else {
      await this.adb(['shell', 'settings', 'put', 'global', ADB_VERIFY_SETTING, prior], 15_000);
    }
  }

  /** See the Cuttlefish backend for why `monkey`, and why its output must be read on success. */
  async launchApp(packageName: string): Promise<void> {
    const out = await this.adb([
      'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1',
    ], 60_000);
    if (/No activities found|Error|Exception/i.test(out)) {
      throw new Error(`could not launch ${packageName} on ${this.info.localId}: ${out.trim().split('\n').slice(-2).join(' ')}`);
    }
  }

  async uninstallApp(packageName: string): Promise<void> {
    const out = await this.adb(['uninstall', packageName], 120_000);
    if (/^\s*(Failure|Error)/im.test(out)) {
      throw new Error(`adb uninstall failed for ${packageName} on ${this.info.localId}: ${out.trim().split('\n').slice(-2).join(' ')}`);
    }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.send(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.send(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(durationMs)}`);
  }

  async key(name: KeyName): Promise<void> {
    await this.send(`input keyevent ${KEYCODES[name]}`);
  }

  async text(value: string): Promise<void> {
    // Shell-quote: user text reaches a shell, so anything unescaped is a command injection into the
    // guest. Single-quote wrapping with the standard '\'' escape for embedded quotes.
    await this.send(`input text '${value.replace(/'/g, `'\\''`)}'`);
  }

  /** See the Cuttlefish backend: `exec-out` is the raw-bytes channel, and PNG magic is checked. */
  async screenshot(): Promise<{ bytes: Buffer; contentType: string }> {
    const bytes = await runBinary(ADB, ['-s', this.serial, 'exec-out', 'screencap', '-p'], 30_000);
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
      throw new Error(`screencap did not return a PNG on ${this.info.localId}: ${bytes.subarray(0, 120).toString().trim()}`);
    }
    return { bytes, contentType: 'image/png' };
  }

  /** See the Cuttlefish backend, including why an Appium session mid-suite makes this fail. */
  async uiHierarchy(): Promise<string> {
    const out = (await runBinary(
      ADB, ['-s', this.serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], 45_000,
    )).toString('utf8');

    const end = out.lastIndexOf('</hierarchy>');
    if (end === -1) {
      const said = out.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (/idle|Killed|ERROR/i.test(said)) {
        throw new Error(
          `uiautomator could not read the screen on ${this.info.localId}. This usually means an `
          + `Appium session is driving this device and holds the accessibility service. adb said: ${said}`);
      }
      throw new Error(`uiautomator returned no hierarchy on ${this.info.localId}: ${said || '(nothing)'}`);
    }
    const start = out.indexOf('<');
    return out.slice(start === -1 ? 0 : start, end + '</hierarchy>'.length);
  }

  async captureLogcat(onLine: (line: string) => void): Promise<LogcatHandle> {
    const p = spawn(ADB, ['-s', this.serial, 'logcat', '-v', 'threadtime', '-T', '200']);
    let carry = '';
    const feed = (chunk: Buffer): void => {
      const parts = (carry + chunk.toString()).split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) onLine(line);
    };
    p.stdout.on('data', feed);
    // adb's own diagnostics go to stderr, and they are what explains an otherwise empty pane.
    p.stderr.on('data', feed);
    p.on('error', (e) => onLine(`--- logcat could not start: ${e.message}`));
    return { stop: () => { p.kill('SIGTERM'); } };
  }

  /**
   * The whole buffer, capped. Unlike a powerwashed Cuttlefish, a phone's buffer carries lines from
   * before this session — `-T` cannot bound a dump — so this is "the device's recent log", not
   * "this session's log". Worth knowing before reading a timestamp as evidence.
   */
  async dumpLogcat(): Promise<string> {
    const out = await runBinary(ADB, ['-s', this.serial, 'logcat', '-d', '-v', 'threadtime'], 60_000);
    const text = out.toString('utf8');
    const LIMIT = 8 * 1024 * 1024;
    if (text.length <= LIMIT) return text;
    const kept = text.slice(text.length - LIMIT);
    return `--- truncated: ${text.length - LIMIT} earlier bytes dropped ---\n${kept}`;
  }

  /**
   * Health, and the checks a handset needs that a VM does not (spec §7, §18).
   *
   * Battery and storage are here because they are the two device-health failures that present as
   * flaky tests: a phone that drops below a usable charge, or fills its storage, fails installs and
   * launches in ways that read like application bugs. Reported as `degraded` with a reason rather
   * than `offline`, because the device is still there and still answering — an operator needs to
   * see the cause, and §18 needs somewhere to have learned it.
   */
  async health(): Promise<DeviceHealth> {
    const t0 = performance.now();
    try {
      /**
       * MEASURED THROUGH THE `input` BINARY, not through the shell, and the difference is the
       * whole value of the number. This used to time `true`, which measures how fast the held
       * shell echoes a marker — on a Samsung SM-S918B over USB that is **1ms p50**, while an
       * actual input event through the same shell is **24-55ms p50**. Reporting the former as
       * `inputLatencyMs` understated the thing it names by twenty to fifty times, and made the
       * 100ms budget below unreachable: no device could ever be slow enough to trip it, because
       * the quantity being compared was a shell round trip.
       *
       * Keycode 0 is `KEYCODE_UNKNOWN`. It travels the entire path a real tap does — spawn
       * `input`, into InputManager — and does nothing when it arrives, which is what makes it
       * safe to run on every health check against somebody's phone.
       */
      await this.send('input keyevent 0', 5_000);
      const inputLatencyMs = performance.now() - t0;

      // Both probes are best-effort: an OEM that does not answer `dumpsys battery` in the expected
      // shape must not make an otherwise healthy phone look broken.
      const battery = await this.batteryPercent().catch(() => undefined);
      if (battery !== undefined && battery < 15) {
        return {
          status: 'degraded', reasonCode: 'low-battery', inputLatencyMs,
          reason: `battery at ${battery}% — installs and launches fail below ~10%`,
        };
      }
      const freeMb = await this.freeStorageMb().catch(() => undefined);
      if (freeMb !== undefined && freeMb < 500) {
        return {
          status: 'degraded', reasonCode: 'low-storage', inputLatencyMs,
          reason: `${freeMb} MB free — an APK install needs headroom`,
        };
      }
      if (inputLatencyMs > 100) {
        return { status: 'degraded', reason: 'input latency above budget', inputLatencyMs };
      }
      return { status: 'healthy', inputLatencyMs };
    } catch (e) {
      /**
       * A pulled cable lands here, and `offline` is what withdraws the device from scheduling.
       *
       * `device-disconnected` rather than `usb-failure`, even though USB is how it is attached. The
       * agent cannot tell a pulled cable from a phone that rebooted or one whose adb died, and
       * `usb-failure` would be a claim about a cause it did not observe. §18 wants a reason that is
       * true, not the most specific one available.
       */
      return { status: 'offline', reasonCode: 'device-disconnected', reason: (e as Error).message };
    }
  }

  private async batteryPercent(): Promise<number> {
    const out = await this.adb(['shell', 'dumpsys', 'battery'], 10_000);
    const m = /^\s*level:\s*(\d+)/m.exec(out);
    if (!m) throw new Error('battery level not reported');
    return Number(m[1]);
  }

  /**
   * Free space on the partition installs land on.
   *
   * THIS WAS BROKEN TWO WAYS, and both were invisible because `health()` catches the throw and
   * carries on — so the low-storage check simply never fired, on any device, and looked fine.
   * Found on a Samsung SM-S918B running Android 16:
   *
   *   `df -m` IS NOT PORTABLE. The old comment asserted that `-m` means megabytes on Android's
   *   toybox df; this device answers `df: Unknown option 'm'`. Plain `df` reports 1K blocks
   *   everywhere and has since forever, so the conversion belongs here rather than in an argument.
   *
   *   THE MOUNT POINT IS NOT `/data`. Asking about `/data` reports the row mounted at
   *   `/data/user/0`, so matching the line that ends in `/data` discarded the only row there was.
   *   Nothing is matched by path now — the last row of the table is the answer to the question that
   *   was asked, whatever the kernel chooses to call it.
   */
  private async freeStorageMb(): Promise<number> {
    const out = await this.adb(['shell', 'df', '/data'], 10_000);
    const rows = out.split('\n').map((l) => l.trim()).filter(Boolean);
    // Drop the header; the remaining row describes the filesystem backing /data.
    const cols = rows.at(-1)?.split(/\s+/) ?? [];
    // Counted from the right — Filesystem, 1K-blocks, Used, Available, Use%, Mounted on — because
    // the left-hand device name is the column most likely to differ between OEMs.
    const availKb = Number(cols.at(-3));
    if (rows.length < 2 || !Number.isFinite(availKb)) {
      throw new Error(`df did not report available space for /data: ${JSON.stringify(out.slice(0, 200))}`);
    }
    return Math.round(availKb / 1024);
  }
}

/**
 * No stream on this tier — see the file comment for why, and why a screenshot loop is refused
 * rather than shipped. `endpoint()` returning null and `signal` being absent say the same thing
 * from two directions, and both are honest.
 */
export class PhysicalMedia implements MediaSource {
  async endpoint() {
    return null;
  }
}

export function createPhysicalBackend(opts: PhysicalOptions): DeviceBackend {
  return { control: new PhysicalDevice(opts), media: new PhysicalMedia() };
}
