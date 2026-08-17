import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Capability } from '@mfarm/protocol';
import type { DeviceBackend, DeviceControl, DeviceHealth, DeviceInfo, MediaSource } from '../device.ts';

/**
 * Cuttlefish backend — the target tier.
 *
 * Why this rather than the AVD emulator (the single largest change from the v1 plan):
 *   - headless by design; no display server, no desktop assumptions
 *   - ships a NATIVE WebRTC display and input stack, so there is no capture pipeline to bolt on and
 *     no host-side transcode in the media path
 *   - input arrives over the WebRTC data channel, which satisfies the "never shell out per event"
 *     rule by construction rather than by discipline
 *   - snapshot save/restore, which is what makes both fast reset and per-second billing work
 *
 * REQUIRES Linux with /dev/kvm. It cannot run on macOS at all, which is why AvdDevice exists.
 *
 * The exact cvd flags below track a moving upstream. `spikes/bootstrap_cuttlefish.sh` pins a working
 * environment; verify against the version it installs before trusting the defaults here.
 */

export interface CuttlefishOptions {
  localId: string;
  instanceNum: number;
  imageDir: string;
  webrtcPort?: number;
  publicHost?: string;
  osVersion?: string;
  gpuMode?: 'guest_swiftshader' | 'none';
}

function run(bin: string, args: string[], cwd: string, timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout: ${bin} ${args.join(' ')}`)); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => { clearTimeout(t); c === 0 ? resolve(out.trim()) : reject(new Error(`${bin} exited ${c}: ${err.trim()}`)); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export class CuttlefishDevice implements DeviceControl {
  readonly info: DeviceInfo;
  private readonly opts: Required<Pick<CuttlefishOptions, 'webrtcPort' | 'gpuMode'>> & CuttlefishOptions;
  private readonly adbSerial: string;

  constructor(opts: CuttlefishOptions) {
    this.opts = { webrtcPort: 8443, gpuMode: 'guest_swiftshader', ...opts };
    // cvd assigns adb ports sequentially from 6520 by instance number
    this.adbSerial = `0.0.0.0:${6519 + opts.instanceNum}`;
    this.info = {
      localId: opts.localId,
      platform: 'android',
      tier: 'cuttlefish',
      model: 'cuttlefish',
      osVersion: opts.osVersion ?? 'unknown',
      capabilities: [
        'screen-stream', 'input-datachannel', 'snapshot-reset',
        'app-install', 'logcat', 'recording',
      ] as Capability[],
      screen: { width: 720, height: 1280, density: 320 },
      // Published, not just used internally. This class has always known the serial — every adb
      // call below uses it — but it never left the object, so the hub sent `cf-1` as `appium:udid`
      // and UiAutomator2 matched it against nothing (B3).
      adbSerial: this.adbSerial,
    };
  }

  static async available(): Promise<{ ok: boolean; reason?: string }> {
    if (process.platform !== 'linux') return { ok: false, reason: `Cuttlefish requires Linux; this is ${process.platform}` };
    const { access } = await import('node:fs/promises');
    try { await access('/dev/kvm'); } catch { return { ok: false, reason: '/dev/kvm missing — bare metal with virtualisation enabled is required' }; }
    try { await run('cvd', ['version'], process.cwd(), 10_000); } catch { return { ok: false, reason: 'cvd not on PATH; run spikes/bootstrap_cuttlefish.sh' }; }
    return { ok: true };
  }

  async start(): Promise<void> {
    const avail = await CuttlefishDevice.available();
    if (!avail.ok) throw new Error(`cannot start Cuttlefish: ${avail.reason}`);
    await run('cvd', [
      'start',
      `--instance_nums=${this.opts.instanceNum}`,
      '--start_webrtc=true',
      `--webrtc_device_id=${this.info.localId}`,
      `--gpu_mode=${this.opts.gpuMode}`,
      '--report_anonymous_usage_stats=n',
      '--daemon',
    ], this.opts.imageDir);
    await this.waitForBoot();
  }

  private async waitForBoot(timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const out = await run('adb', ['-s', this.adbSerial, 'shell', 'getprop', 'sys.boot_completed'], process.cwd(), 5_000);
        if (out === '1') return;
      } catch { /* not up yet */ }
      await sleep(1000);
    }
    throw new Error(`instance ${this.opts.instanceNum} did not boot within ${timeoutMs}ms`);
  }

  async stop(): Promise<void> {
    await run('cvd', ['stop', `--instance_nums=${this.opts.instanceNum}`], this.opts.imageDir, 60_000)
      .catch(() => { /* already stopped */ });
  }

  async resetToSnapshot(): Promise<void> {
    await run('cvd', ['snapshot_restore', `--instance_nums=${this.opts.instanceNum}`], this.opts.imageDir, 120_000);
    await this.waitForBoot(60_000);
  }

  /**
   * Input goes over the WebRTC data channel that Cuttlefish already serves, NOT through here.
   *
   * These methods exist for control-plane-initiated actions (health probes, cleanup between
   * sessions) and are correspondingly slow. Routing live user input through them would reintroduce
   * exactly the per-event adb round trip the architecture exists to avoid: 121ms p50, measured.
   */
  async tap(x: number, y: number): Promise<void> {
    await run('adb', ['-s', this.adbSerial, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))], process.cwd(), 10_000);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await run('adb', ['-s', this.adbSerial, 'shell', 'input', 'swipe',
      String(Math.round(x1)), String(Math.round(y1)), String(Math.round(x2)), String(Math.round(y2)), String(Math.round(durationMs))], process.cwd(), 15_000);
  }

  async key(name: string): Promise<void> {
    const codes: Record<string, string> = {
      home: 'KEYCODE_HOME', back: 'KEYCODE_BACK', recents: 'KEYCODE_APP_SWITCH',
      power: 'KEYCODE_POWER', enter: 'KEYCODE_ENTER', backspace: 'KEYCODE_DEL',
    };
    await run('adb', ['-s', this.adbSerial, 'shell', 'input', 'keyevent', codes[name] ?? name], process.cwd(), 10_000);
  }

  async text(value: string): Promise<void> {
    // Passed as a single argv element, not through a shell, so no quoting hazard here.
    await run('adb', ['-s', this.adbSerial, 'shell', 'input', 'text', value], process.cwd(), 10_000);
  }

  async health(): Promise<DeviceHealth> {
    const t0 = performance.now();
    try {
      await run('adb', ['-s', this.adbSerial, 'shell', 'true'], process.cwd(), 5_000);
      return { status: 'healthy', inputLatencyMs: performance.now() - t0 };
    } catch (e) {
      return { status: 'offline', reason: (e as Error).message };
    }
  }
}

/**
 * Media is Cuttlefish's own WebRTC server. The agent reports where it is and does nothing else with
 * it — no proxying, no re-encoding. A transcode here would turn a ~70ms pipeline into ~300ms and
 * consume the CPU that instance density depends on.
 */
export class CuttlefishMedia implements MediaSource {
  private readonly opts: CuttlefishOptions & { webrtcPort?: number };

  constructor(opts: CuttlefishOptions & { webrtcPort?: number }) {
    this.opts = opts;
  }

  async endpoint() {
    const host = this.opts.publicHost ?? 'localhost';
    const port = this.opts.webrtcPort ?? 8443;
    return { url: `https://${host}:${port}/?device_id=${encodeURIComponent(this.opts.localId)}`, kind: 'webrtc' as const };
  }
}

export function createCuttlefishBackend(opts: CuttlefishOptions): DeviceBackend {
  return { control: new CuttlefishDevice(opts), media: new CuttlefishMedia(opts) };
}
