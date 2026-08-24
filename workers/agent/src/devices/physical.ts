import { spawn, execFile } from 'node:child_process';
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
  /** Held open for the life of the device. Reopening per event costs 57-77ms of pure overhead. */
  private shell?: ReturnType<typeof spawn>;
  private shellSeq = 0;

  constructor(opts: PhysicalOptions) {
    this.serial = opts.serial;
    this.keep = new Set([...NEVER_CLEAR, ...(opts.keepPackages ?? [])]);
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
        'input-datachannel', 'session-reset', 'app-install', 'logcat', 'screenshot', 'ui-hierarchy',
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
  }

  async installApp(apkPath: string): Promise<void> {
    const out = await this.adb(['install', '-r', apkPath], INSTALL_TIMEOUT_MS);
    if (/^\s*(Failure|Error)/im.test(out)) {
      throw new Error(`adb install failed on ${this.info.localId}: ${out.trim().split('\n').slice(-3).join(' ')}`);
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
      await this.send('true', 5_000);
      const inputLatencyMs = performance.now() - t0;

      // Both probes are best-effort: an OEM that does not answer `dumpsys battery` in the expected
      // shape must not make an otherwise healthy phone look broken.
      const battery = await this.batteryPercent().catch(() => undefined);
      if (battery !== undefined && battery < 15) {
        return { status: 'degraded', reason: `battery at ${battery}% — installs and launches fail below ~10%`, inputLatencyMs };
      }
      const freeMb = await this.freeStorageMb().catch(() => undefined);
      if (freeMb !== undefined && freeMb < 500) {
        return { status: 'degraded', reason: `${freeMb} MB free — an APK install needs headroom`, inputLatencyMs };
      }
      if (inputLatencyMs > 100) {
        return { status: 'degraded', reason: 'input latency above budget', inputLatencyMs };
      }
      return { status: 'healthy', inputLatencyMs };
    } catch (e) {
      // A pulled cable lands here, and `offline` is what withdraws the device from scheduling.
      return { status: 'offline', reason: (e as Error).message };
    }
  }

  private async batteryPercent(): Promise<number> {
    const out = await this.adb(['shell', 'dumpsys', 'battery'], 10_000);
    const m = /^\s*level:\s*(\d+)/m.exec(out);
    if (!m) throw new Error('battery level not reported');
    return Number(m[1]);
  }

  private async freeStorageMb(): Promise<number> {
    // `-m` is megabytes on Android's toybox df. The data partition is the one installs land on.
    const out = await this.adb(['shell', 'df', '-m', '/data'], 10_000);
    const line = out.split('\n').find((l) => l.trim().endsWith('/data'));
    const cols = line?.trim().split(/\s+/) ?? [];
    const avail = Number(cols[3]);
    if (!Number.isFinite(avail)) throw new Error('df did not report available space');
    return avail;
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
