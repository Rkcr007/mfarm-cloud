import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Capability } from '@mfarm/protocol';
import type { DeviceBackend, DeviceControl, DeviceHealth, DeviceInfo, MediaSource } from '../device.ts';

/**
 * Android Emulator (AVD) backend.
 *
 * This is the FALLBACK tier, not the target one. It exists because it runs on a developer's laptop
 * and on macOS, where Cuttlefish cannot run at all — useful for developing the control plane and the
 * agent without a Linux box.
 *
 * It cannot meet the 100ms product target and should not be sold as if it could:
 *
 *   adb shell per event      p50 121ms, p95 418ms   (measured, M1, Android 34)
 *   held adb shell           p50  39ms, p95  70ms   (what this class uses)
 *
 * 39ms of input latency alone is most of a 74ms budget, and there is no WebRTC path here at all.
 * Cuttlefish takes input over its own data channel and streams natively; that is the tier to build
 * the product on.
 */

const ADB = process.env.ADB_PATH ?? `${process.env.ANDROID_HOME ?? ''}/platform-tools/adb`;
const EMULATOR = process.env.EMULATOR_PATH ?? `${process.env.ANDROID_HOME ?? ''}/emulator/emulator`;

const KEYCODES: Record<string, string> = {
  home: 'KEYCODE_HOME', back: 'KEYCODE_BACK', recents: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER', enter: 'KEYCODE_ENTER', backspace: 'KEYCODE_DEL',
};

export interface AvdOptions {
  avdName: string;
  localId: string;
  port?: number;
  snapshotName?: string;
  model?: string;
  osVersion?: string;
}

function run(bin: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout: ${bin} ${args.join(' ')}`)); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(t);
      code === 0 ? resolve(out.trim()) : reject(new Error(`${bin} exited ${code}: ${err.trim() || out.trim()}`));
    });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export class AvdDevice implements DeviceControl {
  readonly info: DeviceInfo;
  private readonly serial: string;
  private readonly opts: Required<Pick<AvdOptions, 'avdName' | 'port' | 'snapshotName'>> & AvdOptions;
  private emulator?: ChildProcess;
  /** Held open for the life of the device. Reopening per event costs 57-77ms of pure overhead. */
  private shell?: ChildProcess;
  private shellSeq = 0;

  constructor(opts: AvdOptions) {
    this.opts = { port: 5560, snapshotName: 'mfarm_clean', ...opts };
    this.serial = `emulator-${this.opts.port}`;
    this.info = {
      localId: opts.localId,
      platform: 'android',
      tier: 'avd',
      model: opts.model ?? opts.avdName,
      osVersion: opts.osVersion ?? 'unknown',
      // No 'screen-stream': there is no WebRTC path on this tier and claiming one would be a lie the
      // scheduler would act on. 'input-datachannel' IS honest — the held shell is a persistent
      // channel with no per-event process spawn — it is simply a slow one.
      capabilities: ['input-datachannel', 'snapshot-reset', 'app-install', 'logcat'] as Capability[],
      screen: { width: 1080, height: 2220, density: 440 },
      // See the note in cuttlefish.ts: the serial has always been known here and never published,
      // which is why the hub sent the local id as `appium:udid` (B3).
      adbSerial: this.serial,
    };
  }

  private async adb(args: string[], timeoutMs = 30_000): Promise<string> {
    return run(ADB, ['-s', this.serial, ...args], timeoutMs);
  }

  async start(): Promise<void> {
    const hasSnapshot = await this.snapshotExists();
    const args = [
      '-avd', this.opts.avdName, '-port', String(this.opts.port),
      '-no-window', '-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect',
      ...(hasSnapshot ? ['-snapshot', this.opts.snapshotName] : ['-no-snapshot-load']),
    ];
    this.emulator = spawn(EMULATOR, args, { detached: false, stdio: 'ignore' });
    await this.waitForBoot();
    await this.openShell();
    if (!hasSnapshot) {
      // First boot: capture the clean state so every subsequent reset is a 3s restore, not a 35s boot.
      await this.adb(['emu', 'avd', 'snapshot', 'save', this.opts.snapshotName], 120_000);
    }
  }

  private async snapshotExists(): Promise<boolean> {
    try {
      const out = await run(ADB, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'list'], 5_000);
      return out.includes(this.opts.snapshotName);
    } catch {
      return false; // emulator not running yet
    }
  }

  private async waitForBoot(timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await this.adb(['shell', 'getprop', 'sys.boot_completed'], 5_000)) === '1') return;
      } catch { /* not up yet */ }
      await sleep(1000);
    }
    throw new Error(`${this.serial} did not reach boot_completed within ${timeoutMs}ms`);
  }

  /** One long-lived shell. See the class comment for why this matters more than it looks. */
  private async openShell(): Promise<void> {
    await this.closeShell();
    const sh = spawn(ADB, ['-s', this.serial, 'shell'], { stdio: ['pipe', 'pipe', 'ignore'] });
    // Writing to a shell whose adb has died emits 'error' on the pipe, and an unhandled 'error' on a
    // stream is an uncaught exception — which would take down the whole agent, and with it every
    // other device on the host, because one emulator went away. Handled here so the failure stays
    // local: the in-flight send() times out and health() reports the device offline.
    const note = (e: Error) => console.error(`[avd:${this.serial}] shell pipe failed: ${e.message}`);
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

  async stop(): Promise<void> {
    await this.closeShell();
    try { await this.adb(['emu', 'kill'], 10_000); } catch { /* already gone */ }
    this.emulator?.kill();
    this.emulator = undefined;
  }

  /**
   * Snapshot restore in place — no process restart, so this is the fast path. Falls back to a
   * relaunch if the running emulator refuses the load, because a device that cannot be reset must
   * never be returned to the pool.
   */
  async resetToSnapshot(): Promise<void> {
    try {
      await this.adb(['emu', 'avd', 'snapshot', 'load', this.opts.snapshotName], 120_000);
      await this.waitForBoot(60_000);
      await this.openShell();
    } catch {
      await this.stop();
      await this.start();
    }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.send(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.send(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(durationMs)}`);
  }

  async key(name: 'home' | 'back' | 'recents' | 'power' | 'enter' | 'backspace'): Promise<void> {
    await this.send(`input keyevent ${KEYCODES[name]}`);
  }

  async text(value: string): Promise<void> {
    // Shell-quote: user text reaches a shell, so anything unescaped is a command injection into the
    // guest. Single-quote wrapping with the standard '\'' escape for embedded quotes.
    await this.send(`input text '${value.replace(/'/g, `'\\''`)}'`);
  }

  async health(): Promise<DeviceHealth> {
    const t0 = performance.now();
    try {
      await this.send('true', 5_000);
      const inputLatencyMs = performance.now() - t0;
      // Surfaced so the control plane can see this tier is slow, rather than discovering it from
      // customer complaints about a laggy session.
      if (inputLatencyMs > 100) return { status: 'degraded', reason: 'input latency above budget', inputLatencyMs };
      return { status: 'healthy', inputLatencyMs };
    } catch (e) {
      return { status: 'offline', reason: (e as Error).message };
    }
  }
}

/** No streaming on this tier. Reported honestly rather than emulated with a screenshot loop. */
export class AvdMedia implements MediaSource {
  async endpoint() {
    return null;
  }
}

export function createAvdBackend(opts: AvdOptions): DeviceBackend {
  return { control: new AvdDevice(opts), media: new AvdMedia() };
}
