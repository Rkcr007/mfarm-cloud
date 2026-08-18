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
 * The cvd invocations below were verified end to end against cvd 1.55.1 on 2026-08-18 (lab VM,
 * n2-standard-16, AOSP build 16102939): cold boot 38s, snapshot restore 8s, snapshot 4.0 GB.
 * `spikes/bootstrap_cuttlefish.sh` pins that environment. HANDOFF.md issues 2, 11 and 12 record why
 * each flag is here — several are non-obvious and their absence produces errors that point
 * somewhere else entirely.
 */

export interface CuttlefishOptions {
  localId: string;
  instanceNum: number;
  /** Holds both the host tools (`bin/`) and the device images. cvd needs it named explicitly. */
  imageDir: string;
  /**
   * Where THIS device's snapshot is written and restored from — one directory per device, never
   * shared. Two devices pointed at one path restore each other's state, which is the tenant leak
   * `snapshot-reset` exists to prevent.
   *
   * Reset is unavailable without it, and a device that cannot reset is not schedulable
   * (`REQUIRED_FOR_TENANT_USE`). It was optional and never passed by anything until 2026-08-18, so
   * every device advertised a reset it would have thrown on.
   */
  snapshotDir?: string;
  webrtcPort?: number;
  publicHost?: string;
  osVersion?: string;
  gpuMode?: 'guest_swiftshader' | 'none';
  /**
   * TEST SEAM — production leaves this unset and gets the real environment probe.
   *
   * `available()` is a hard platform check (Linux, /dev/kvm, cvd on PATH), so on any developer
   * machine the boot decision below could otherwise only be reviewed, never executed. The decision
   * is exactly the part worth testing: adopting a running device instead of creating a second one,
   * and restoring instead of cold booting.
   */
  probe?: () => Promise<{ ok: boolean; reason?: string }>;
  /** How long to wait for `sys.boot_completed`. 5 minutes by default; a cold boot measured 38s. */
  bootTimeoutMs?: number;
}

/** What `cvd fleet` says about one instance, reduced to the two fields the boot decision needs. */
export interface FleetInstance {
  group?: string;
  status?: string;
}

/**
 * Locate this device in `cvd fleet` output.
 *
 * Deliberately tolerant. cvd's fleet JSON has changed shape across versions — flat arrays of
 * instances in the `launch_cvd` era, `{groups:[{group_name, instances:[…]}]}` since the instance
 * database — and the shape is NOT something this repo has verified beyond "it contains a status"
 * (HANDOFF.md issues 11, 12). So rather than assume a layout, walk the tree for an object that
 * identifies itself as ours and carry down the nearest enclosing `group_name` and `status`.
 *
 * Matching is on the adb serial or the webrtc device id, both of which we set or derive ourselves.
 * An unrecognisable document returns undefined, and the caller cold boots — which is exactly what
 * it did before any of this existed, so a parse miss is never worse than the old behaviour.
 */
export function findFleetInstance(fleetJson: string, match: { adbSerial: string; localId: string }): FleetInstance | undefined {
  let doc: unknown;
  try { doc = JSON.parse(fleetJson); } catch { return undefined; }

  const walk = (node: unknown, group?: string, status?: string): FleetInstance | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = walk(child, group, status);
        if (hit) return hit;
      }
      return undefined;
    }
    if (node === null || typeof node !== 'object') return undefined;

    const obj = node as Record<string, unknown>;
    const g = typeof obj.group_name === 'string' ? obj.group_name : group;
    const s = typeof obj.status === 'string' ? obj.status : status;

    const identifies = obj.adb_serial === match.adbSerial
      || obj.webrtc_device_id === match.localId
      || obj.instance_name === match.localId;
    if (identifies) return { group: g, status: s };

    for (const value of Object.values(obj)) {
      const hit = walk(value, g, s);
      if (hit) return hit;
    }
    return undefined;
  };

  return walk(doc);
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
  /** Assigned by cvd at create time, parsed out of its output; needed as a selector afterwards. */
  private groupName?: string;

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
      // `snapshot-reset` is NOT here, and its absence is the point. It is added by start() only
      // once a snapshot actually exists on disk — a capability is a claim about observed state, not
      // about configuration (the rule earned by AUTOMATION_ENDPOINT in HANDOFF.md). Advertising it
      // unconditionally is what made every device claim a reset that threw `no snapshotDir
      // configured`, which leaves it stuck in CLEANING forever because a restore that never
      // completes never reports completion.
      capabilities: [
        'screen-stream', 'input-datachannel',
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
    const { access, readFile } = await import('node:fs/promises');
    try { await access('/dev/kvm'); } catch { return { ok: false, reason: '/dev/kvm missing — bare metal with virtualisation enabled is required' }; }
    try { await run('cvd', ['version'], process.cwd(), 10_000); } catch { return { ok: false, reason: 'cvd not on PATH; run spikes/bootstrap_cuttlefish.sh' }; }
    // Ubuntu 24.04 defaults this to 1, which denies CAP_SYS_ADMIN to the user namespaces crosvm
    // uses to sandbox each virtual device. crosvm then dies during VM setup while cvd cheerfully
    // reports "Starting" — and no Cuttlefish log names AppArmor, only dmesg does. Checking it here
    // converts a multi-hour debug into one line (HANDOFF.md known issue 12).
    try {
      const v = (await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')).trim();
      if (v !== '0') return { ok: false, reason: 'kernel.apparmor_restrict_unprivileged_userns=1 blocks crosvm; set it to 0 (see spikes/bootstrap_cuttlefish.sh preflight)' };
    } catch { /* not an AppArmor kernel, or the knob does not exist — fine */ }
    return { ok: true };
  }

  /**
   * Bring the device up by the cheapest route that is correct, in this order:
   *
   *   already running   0s   adopt it
   *   stopped group     8s   `start --snapshot_path` (or a plain start with no snapshot)
   *   nothing yet      38s   `cvd create` — the only verb that builds a group from artifacts
   *
   * The measurements are B7's, on the lab VM. The first rung matters more than the numbers: an
   * agent restart used to run `cvd create` against a host whose device was already up, producing a
   * SECOND group rather than reattaching to the first. Nothing in the old code could reattach,
   * because `groupName` lived only in the process that created it.
   */
  async start(): Promise<void> {
    const avail = await (this.opts.probe ?? CuttlefishDevice.available)();
    if (!avail.ok) throw new Error(`cannot start Cuttlefish: ${avail.reason}`);

    const existing = await this.findExisting();
    if (existing?.group) {
      this.groupName = existing.group;
      if (/running/i.test(existing.status ?? '') && await this.adbAlive()) {
        console.log(`[cuttlefish] ${this.info.localId}: adopting running group ${existing.group}`);
      } else {
        await this.restartExisting();
        await this.waitForBoot();
      }
    } else {
      await this.coldBoot();
      await this.waitForBoot();
    }

    // THE SELECTOR IS NOT OPTIONAL ONCE THERE IS A SECOND DEVICE, AND ITS ABSENCE IS INVISIBLE
    // UNTIL THEN. `coldBoot` scrapes the group name out of cvd's output, which is a guess about a
    // format — and on 2026-08-18, running two devices for the first time, it turned out to be the
    // wrong guess: cf-1 worked all day because with one group cvd falls back to the only one there
    // is, and cf-2 failed its snapshot with `Multiple groups found. Narrow the selection with
    // selector arguments.` So take the name from `cvd fleet`, which reports structured data and is
    // already parsed for the adopt path, and treat the scrape as nothing more than a fast path.
    if (!this.groupName) {
      this.groupName = (await this.findExisting())?.group;
      if (!this.groupName) {
        console.error(
          `[cuttlefish] ${this.info.localId}: cvd did not name its group and fleet does not list this ` +
          'device — every later cvd command will be unselected, which fails outright on a host with ' +
          'more than one device.',
        );
      }
    }

    // Before registration, deliberately: a device with no snapshot is not schedulable, so taking
    // one here is what turns a freshly bootstrapped host into a usable farm without a human running
    // a snapshot command by hand. Costs ~4 GB and a suspend/resume once per device, ever.
    await this.ensureSnapshot();
    await this.refreshResetCapability();

    // Cheap, and the control plane surfaces it per session; unknown here would be a silent gap.
    this.info.osVersion = await run('adb', ['-s', this.adbSerial, 'shell', 'getprop', 'ro.build.version.release'], process.cwd(), 10_000)
      .catch(() => this.opts.osVersion ?? 'unknown');
  }

  /** `cvd create` — the cold path. 38s measured. */
  private async coldBoot(): Promise<void> {
    // `create`, not `start`. cvd 1.x keeps an instance database and the verbs are not
    // interchangeable: create builds a new group from artifacts, start only restarts an existing
    // stopped one. On a fresh host start fails with "no devices present", which reads like a boot
    // failure but happens before anything boots.
    //
    // --host_path/--product_path are not optional either. cvd defaults both to $HOME rather than
    // the working directory, so without them it looks in $HOME/bin and reports that the host tools
    // are missing while they sit in imageDir.
    const out = await run('cvd', [
      'create',
      `--host_path=${this.opts.imageDir}`,
      `--product_path=${this.opts.imageDir}`,
      `--instance_nums=${this.opts.instanceNum}`,
      '--start_webrtc=true',
      `--webrtc_device_id=${this.info.localId}`,
      `--gpu_mode=${this.opts.gpuMode}`,
      // Snapshot support is a boot-time property, so it goes on every device whether or not this
      // one is ever snapshotted — a device booted without it cannot be made resettable later.
      '--enable_virtiofs=false',
      '--report_anonymous_usage_stats=n',
      '--daemon',
    ], this.opts.imageDir);
    // cvd names the group itself and prints "group:cvd_2|instance(s):2". Every later command needs
    // that name as a selector, because a host running more than one device has more than one group
    // and the unselected default is whichever cvd picks.
    this.groupName = /group:(\S+?)\|/.exec(out)?.[1];
  }

  /**
   * Restart a group cvd already knows about. With a snapshot this is the 8s path; without one it is
   * a plain restart, which is still cheaper than building a second group beside the first.
   *
   * No --gpu_mode or --enable_virtiofs here: on the snapshot path the device configuration comes
   * back out of the snapshot and passing them again is a good way to get a confusing failure, and
   * on the plain path the group already carries what it was created with.
   */
  private async restartExisting(): Promise<void> {
    const snapshot = await this.snapshotOnDisk();
    const args = snapshot
      ? this.sel('start', `--snapshot_path=${snapshot}`, '--daemon')
      : this.sel('start', '--daemon');
    console.log(`[cuttlefish] ${this.info.localId}: restarting ${this.groupName}${snapshot ? ' from snapshot' : ' (no snapshot yet)'}`);
    await run('cvd', args, this.opts.imageDir, 120_000);
  }

  /** Ask cvd what it already has. A failure here means "nothing", never a thrown start. */
  private async findExisting(): Promise<FleetInstance | undefined> {
    const out = await run('cvd', ['fleet'], this.opts.imageDir, 30_000).catch(() => '');
    if (!out) return undefined;
    return findFleetInstance(out, { adbSerial: this.adbSerial, localId: this.info.localId });
  }

  private async adbAlive(): Promise<boolean> {
    return await run('adb', ['-s', this.adbSerial, 'shell', 'getprop', 'sys.boot_completed'], process.cwd(), 5_000)
      .then((v) => v === '1')
      .catch(() => false);
  }

  /** Selector flags go BEFORE the verb: `cvd --group_name=X suspend`, not `cvd suspend --group_name=X`. */
  private sel(...verb: string[]): string[] {
    return this.groupName ? [`--group_name=${this.groupName}`, ...verb] : verb;
  }

  private async waitForBoot(timeoutMs = this.opts.bootTimeoutMs ?? 300_000): Promise<void> {
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
    await run('cvd', this.sel('stop'), this.opts.imageDir, 60_000)
      .catch(() => { /* already stopped */ });
  }

  /**
   * Capture the golden image this device resets to. Run once per image, after the device has booted
   * and been brought to whatever state a session should start from.
   *
   * The suspend/resume pair is mandatory: `snapshot_take` on a running device is refused outright
   * with "The device is not suspended, and snapshot cannot be taken". Resume is non-destructive —
   * the device is still booted afterwards — so this is safe to call on a device about to be used.
   *
   * Measured: ~4.0 GB per snapshot, which is per device image rather than per device, but still the
   * sizing constraint once the fleet keeps several Android versions warm.
   */
  async takeSnapshot(): Promise<void> {
    const path = this.snapshotPath();
    await run('cvd', this.sel('suspend'), this.opts.imageDir, 120_000);
    try {
      await run('cvd', this.sel('snapshot_take', `--snapshot_path=${path}`), this.opts.imageDir, 300_000);
    } finally {
      // Resume even if the take failed, otherwise the device is left suspended and every later
      // health probe times out with nothing explaining why.
      await run('cvd', this.sel('resume'), this.opts.imageDir, 120_000).catch(() => {});
    }
    // The device just became resettable, so say so. Called on the first-boot path before
    // registration, and again by hand whenever a new golden image is captured.
    await this.refreshResetCapability();
  }

  /**
   * Restore to the snapshot. Measured at 8s against a 38s cold boot — the ~4.75x that per-session
   * device recycling is predicated on.
   *
   * `start`, not `create`, and that is consistent with start() above rather than a contradiction:
   * `cvd stop` leaves the group in the database as Stopped, and start is the verb for an existing
   * group. No --gpu_mode or --enable_virtiofs here either; the device configuration comes back out
   * of the snapshot, and passing them again is a good way to get a confusing failure.
   */
  async resetToSnapshot(): Promise<void> {
    const path = this.snapshotPath();
    await run('cvd', this.sel('stop'), this.opts.imageDir, 60_000).catch(() => { /* already stopped */ });
    await run('cvd', this.sel('start', `--snapshot_path=${path}`, '--daemon'), this.opts.imageDir, 120_000);
    await this.waitForBoot(60_000);
  }

  private snapshotPath(): string {
    if (!this.opts.snapshotDir) {
      throw new Error(`no snapshotDir configured for ${this.info.localId}; snapshot reset is unavailable`);
    }
    return this.opts.snapshotDir;
  }

  /**
   * The snapshot directory if it is configured AND actually holds a snapshot, else undefined.
   *
   * Existence is not enough — `cvd snapshot_take` creates the directory before it fills it, so an
   * empty one is the signature of a take that failed, and restoring from it would fail at the point
   * where the failure costs a tenant's session rather than here.
   */
  private async snapshotOnDisk(): Promise<string | undefined> {
    const dir = this.opts.snapshotDir;
    if (!dir) return undefined;
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir).catch(() => [] as string[]);
    return entries.length > 0 ? dir : undefined;
  }

  /**
   * Take the golden snapshot if this device does not have one yet.
   *
   * A failure is logged and swallowed on purpose. The consequence is already carried by
   * `refreshResetCapability` below — no snapshot means no `snapshot-reset`, which means the control
   * plane will not schedule tenant sessions onto this device. Throwing instead would take down a
   * worker that is otherwise fine, and hide a device that is genuinely usable for everything except
   * multi-tenant recycling.
   */
  private async ensureSnapshot(): Promise<void> {
    const dir = this.opts.snapshotDir;
    if (!dir || await this.snapshotOnDisk()) return;
    const { mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    try {
      await mkdir(dirname(dir), { recursive: true });
      console.log(`[cuttlefish] ${this.info.localId}: taking first snapshot into ${dir} (~4 GB, once)`);
      await this.takeSnapshot();
    } catch (e) {
      console.error(`[cuttlefish] ${this.info.localId}: snapshot failed, device will not be schedulable: ${(e as Error).message}`);
    }
  }

  /** Advertise `snapshot-reset` when, and only when, a snapshot exists to reset to. */
  private async refreshResetCapability(): Promise<void> {
    const has = Boolean(await this.snapshotOnDisk());
    const listed = this.info.capabilities.includes('snapshot-reset');
    if (has && !listed) this.info.capabilities = [...this.info.capabilities, 'snapshot-reset'];
    if (!has && listed) this.info.capabilities = this.info.capabilities.filter((c) => c !== 'snapshot-reset');
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
