import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Capability } from '@mfarm/protocol';
import type {
  DeviceBackend, DeviceControl, DeviceHealth, DeviceInfo, LogcatHandle, MediaSource,
  SignalChannel, SignalOptions,
} from '../device.ts';
import { openSignalChannel } from './operator.ts';

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
  /**
   * Where cvd's WebRTC operator answers. Loopback in every real deployment (ADR-0007) — this is the
   * signalling server a viewer is relayed to, and it is unauthenticated, so it must never be bound
   * anywhere a browser could reach it directly.
   */
  operatorUrl?: string;
  /**
   * How a device is returned to a clean state between tenants.
   *
   * `snapshot` (the default) restores in ~10s and is what makes per-second billing and fast
   * recycling work. `powerwash` returns the device to first boot in ~80s and is THE ONLY MODE WITH A
   * WORKING LIVE VIEW on this cvd build — see `powerwash()` for the measurement. A farm used
   * interactively wants powerwash; one used only for automation wants snapshot.
   */
  resetMode?: 'snapshot' | 'powerwash';
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

/** What `cvd fleet` says about one instance, reduced to the fields the boot decision needs. */
export interface FleetInstance {
  group?: string;
  status?: string;
  /**
   * `<HOME>/cuttlefish/instances/cvd-<n>`. Carried because it is the only place the group's HOME
   * appears, and a snapshot is only valid for the HOME it was taken under — see `snapshotIsStale`.
   */
  instanceDir?: string;
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
export function findFleetInstance(
  fleetJson: string,
  match: { adbSerial: string; localId: string; instanceNum: number },
): FleetInstance | undefined {
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

    // Matched on the INSTANCE NUMBER first, because it is the only identifier cvd will not rewrite.
    // A restored group loses the `--webrtc_device_id` it was created with — after
    // `start --snapshot_path`, cf-1's group reported `cvd_1-1-1` — and the fleet document carries
    // `adb_port`, not the `adb_serial` this once matched on. With neither matching, the adopt path
    // stopped recognising a device that was sitting right there and `cvd create` answered
    // "New instance conflicts with existing instance". The names are kept as secondary evidence.
    const identifies = obj.adb_port === 6519 + match.instanceNum
      || obj.instance_name === String(match.instanceNum)
      || obj.adb_serial === match.adbSerial
      || obj.webrtc_device_id === match.localId
      || obj.instance_name === match.localId;
    if (identifies) {
      // Returned two ways rather than with an undefined field: a `deepStrictEqual` on the parser's
      // output counts an explicitly-undefined key as present, and older shapes genuinely lack it.
      return typeof obj.instance_dir === 'string'
        ? { group: g, status: s, instanceDir: obj.instance_dir }
        : { group: g, status: s };
    }

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

/**
 * `run`, but for a command whose output is bytes rather than text.
 *
 * Separate rather than a flag on `run` because the two differ in more than the return type: this one
 * must never touch the encoding, must not trim, and concatenates buffers instead of a string. A
 * screenshot that went through `run` would arrive as a UTF-8-mangled string and be unopenable.
 */
function runBinary(bin: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    const chunks: Buffer[] = [];
    let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout: ${bin} ${args.join(' ')}`)); }, timeoutMs);
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => { clearTimeout(t); c === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${bin} exited ${c}: ${err.trim()}`)); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * How long one `adb install` may take before it is killed.
 *
 * Generous on purpose. A 100 MB APK onto a SwiftShader Cuttlefish is a slow push followed by a
 * dexopt pass that is entirely CPU-bound on the same cores doing the rendering, and a timeout that
 * fires mid-install leaves a half-installed package the next attempt has to reinstall anyway.
 */
const INSTALL_TIMEOUT_MS = 600_000;

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
      // `recording` USED TO BE HERE AND WAS NEVER IMPLEMENTED. Nothing in the worker started a
      // screenrecord, so the console correctly offered no control for it and the declaration was
      // simply a lie — the one place this codebase broke ADR-0003's rule that a capability is
      // observed state. It comes back when `startRecording` does. `logcat` and `screenshot` are
      // here because the methods below now exist.
      capabilities: [
        'screen-stream', 'input-datachannel',
        'app-install', 'logcat', 'screenshot',
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

    const route = await this.bringUp();

    // THE SELECTOR IS NOT OPTIONAL ONCE THERE IS A SECOND DEVICE, AND ITS ABSENCE IS INVISIBLE
    // UNTIL THEN. `coldBoot` scrapes the group name out of cvd's output, which is a guess about a
    // format — and on 2026-08-18, running two devices for the first time, it turned out to be the
    // wrong guess: cf-1 worked all day because with one group cvd falls back to the only one there
    // is, and cf-2 failed its snapshot with `Multiple groups found. Narrow the selection with
    // selector arguments.` So take the name from `cvd fleet`, which reports structured data and is
    // already parsed for the adopt path, and treat the scrape as nothing more than a fast path.
    await this.resolveGroupName();

    // Before registration, deliberately: a device with no snapshot is not schedulable, so taking
    // one here is what turns a freshly bootstrapped host into a usable farm without a human running
    // a snapshot command by hand. Costs ~4 GB and a suspend/resume once per device, ever.
    // A GROUP THAT EXISTS IS NOT THE SAME AS A GROUP THAT WORKS, and until 2026-08-18 nothing here
    // could tell the two apart. Snapshot support is a BOOT-TIME property: a group booted without
    // the flags in `coldBoot` can never be suspended, so `cvd suspend` answers
    // `LauncherResponse::kError` and the device registers unschedulable — permanently, because
    // every later agent start finds the same group and restarts into it again. Seen on the lab VM
    // with a group left behind by a failed `create`: it restarted, booted, answered adb, and could
    // not snapshot, on every attempt.
    //
    // So a failed snapshot on a group this agent did not build is treated as evidence the group is
    // unusable, not as a property of the host: discard it and cold boot once. Bounded to a single
    // retry, and never attempted when we just created the group — a fresh group that cannot
    // snapshot is a real host problem (kernel, apparmor, disk) that rebuilding would only hide
    // behind a boot loop.
    // Checked on EVERY start, not just after a rebuild this agent did: the adopt path would
    // otherwise re-advertise a snapshot whose group was replaced while the agent was not running.
    const seen = await this.findExisting();
    if (await this.snapshotIsStale(seen?.instanceDir)) {
      await this.dropSnapshot(`it belongs to a group that no longer exists (${seen?.instanceDir})`);
    }

    // In powerwash mode there is nothing to take and nothing to be stale: the reset is a first-boot
    // restore, so the whole snapshot apparatus below is skipped rather than kept warm for a path
    // that will never run. It also skips ~4 GB of disk and a minute of boot per device.
    if (this.opts.resetMode === 'powerwash') {
      await this.refreshResetCapability();
      this.info.osVersion = await run('adb', ['-s', this.adbSerial, 'shell', 'getprop', 'ro.build.version.release'], process.cwd(), 10_000)
        .catch(() => this.opts.osVersion ?? 'unknown');
      return;
    }

    let snapshotted = await this.ensureSnapshot();
    if (!snapshotted && route !== 'created') {
      console.warn(
        `[cuttlefish] ${this.info.localId}: ${route} group ${this.groupName} cannot snapshot — ` +
        'discarding it and cold booting once, because a group that cannot be reset is not schedulable',
      );
      await this.discardGroup();
      await this.coldBoot();
      await this.waitForBoot();
      await this.resolveGroupName();
      snapshotted = await this.ensureSnapshot();
    }
    if (!snapshotted) {
      console.error(`[cuttlefish] ${this.info.localId}: no snapshot, device will not be schedulable`);
    }
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
   * Get the device running by the cheapest correct route, and say which route it took — the caller
   * needs that to decide whether a later failure is the group's fault or the host's.
   *
   * The `restartExisting` failure path is the one worth explaining. cvd's instance database OUTLIVES
   * THE HOST: after a reboot the groups are still recorded, still carry the `start_time` from before
   * the reboot, and still count as active, while every process behind them is gone. `cvd fleet` says
   * `"status": "Unreachable"`, and `cvd start` refuses outright with `Selected instance group is
   * already started, use 'cvd create' to create a new one` — so the restore path cannot run and the
   * adopt path has nothing to adopt. Before this, that combination bricked the farm on every host
   * reboot until a human ran `cvd reset` by hand (verified on the lab VM, 2026-08-18).
   *
   * `cvd rm` scoped to the group is the repair, NOT `cvd reset`. Two reasons, both measured:
   *   * `cvd reset` is host-wide — it stops every device, so on a farm it would kill the tenants'
   *     sessions on every other device to fix one.
   *   * `cvd reset` also cleans the instance runtime dirs, and a snapshot pins the absolute HOME it
   *     was taken under (`snapshot_meta_info.json`). Clean those dirs and `create --snapshot_path`
   *     fails on a missing `logs/fetch.log`, which is to say the reset destroys the snapshots it was
   *     meant to rescue.
   * `cvd rm` leaves other groups running and does NOT delete an image supplied via `--host_path`.
   */
  private async bringUp(): Promise<'created' | 'adopted' | 'restarted'> {
    const existing = await this.findExisting();
    if (existing?.group) {
      this.groupName = existing.group;
      if (/running/i.test(existing.status ?? '') && await this.adbAlive()) {
        console.log(`[cuttlefish] ${this.info.localId}: adopting running group ${existing.group}`);
        return 'adopted';
      }
      try {
        await this.restartExisting();
        await this.waitForBoot();
        return 'restarted';
      } catch (e) {
        console.warn(
          `[cuttlefish] ${this.info.localId}: cannot restart group ${existing.group} ` +
          `(${(e as Error).message.split('\n')[0]}) — discarding it and cold booting`,
        );
        await this.discardGroup();
      }
    }
    await this.coldBoot();
    await this.waitForBoot();
    return 'created';
  }

  /**
   * Forget a group entirely, so the next `cvd create` builds a clean one — and throw away its
   * snapshot, because the snapshot cannot outlive it.
   *
   * A SNAPSHOT IS ONLY VALID FOR THE GROUP IT WAS TAKEN UNDER. `snapshot_meta_info.json` records an
   * absolute `HOME` (`/var/tmp/cvd/<uid>/<id>/home`), cvd generates a new `<id>` for every group it
   * creates, and restore copies the snapshot back into the HOME the FILE names rather than the one
   * the running group has. So a snapshot kept across a rebuild restores into a directory that no
   * longer exists and fails on a missing `logs/fetch.log`.
   *
   * Verified on the lab VM 2026-08-18, and the symptom is worth recognising: bring-up succeeds, the
   * device registers READY advertising `snapshot-reset`, the first session runs green, and then
   * every reset fails and the device is parked in CLEANING for good. That is the same
   * one-session-per-device failure as HANDOFF issue 16, arriving through a different door — which is
   * why the snapshot is dropped HERE, at the one place a group stops being the group its snapshot
   * belongs to, rather than anywhere it could be forgotten.
   *
   * Tolerant of failure on purpose: this only ever runs on a group already known to be unusable, and
   * the cold boot afterwards is the thing that actually has to work.
   */
  private async discardGroup(): Promise<void> {
    await run('cvd', this.sel('rm'), this.opts.imageDir, 120_000)
      .catch((e) => console.warn(`[cuttlefish] ${this.info.localId}: rm failed: ${(e as Error).message.split('\n')[0]}`));
    this.groupName = undefined;
    await this.dropSnapshot('the group it was taken under has been destroyed');
  }

  /**
   * Throw a snapshot away, and stop claiming the capability that depends on it.
   *
   * The capability half is not bookkeeping. Between here and the retake the device genuinely cannot
   * be reset, and a device that advertises `snapshot-reset` it cannot honour is one the control
   * plane will hand to a tenant and then fail to recycle — which parks it in CLEANING for good.
   */
  private async dropSnapshot(why: string): Promise<void> {
    const dir = this.opts.snapshotDir;
    if (!dir) return;
    console.warn(`[cuttlefish] ${this.info.localId}: discarding snapshot — ${why}`);
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    this.info.capabilities = this.info.capabilities.filter((c) => c !== 'snapshot-reset');
  }

  /**
   * Is the snapshot on disk bound to a HOME the current group does not have?
   *
   * `cvd` restores a snapshot into the absolute HOME recorded in its own `snapshot_meta_info.json`,
   * NOT into the HOME of the group being restored, and it mints a fresh HOME for every group it
   * creates. So any snapshot that outlives its group restores into a directory that is no longer
   * there and fails on a missing `logs/fetch.log`.
   *
   * `discardGroup` covers the rebuilds this agent performs itself. This covers every other way the
   * two can drift apart — an operator running `cvd rm`, a `cvd reset`, a group rebuilt by a version
   * of this agent that did not know to drop it — because the next agent start ADOPTS the running
   * group and would otherwise re-advertise the stale snapshot without ever touching it.
   *
   * Unrecognised or absent metadata returns false. A snapshot is expensive and a false positive
   * destroys a good one, so this only ever acts on a HOME it has actually read and compared.
   */
  private async snapshotIsStale(instanceDir?: string): Promise<boolean> {
    const dir = this.opts.snapshotDir;
    if (!dir || !instanceDir) return false;
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const raw = await readFile(join(dir, 'snapshot_meta_info.json'), 'utf8').catch(() => '');
    if (!raw) return false;
    let home: unknown;
    try { home = (JSON.parse(raw) as Record<string, unknown>).HOME; } catch { return false; }
    if (typeof home !== 'string') return false;
    // instance_dir is `<HOME>/cuttlefish/instances/cvd-<n>`.
    const [current] = instanceDir.split('/cuttlefish/instances/');
    if (!current || current === instanceDir) return false;
    return current !== home;
  }

  /**
   * THE SELECTOR IS NOT OPTIONAL ONCE THERE IS A SECOND DEVICE, AND ITS ABSENCE IS INVISIBLE UNTIL
   * THEN. `coldBoot` scrapes the group name out of cvd's output, which is a guess about a format —
   * and on 2026-08-18, running two devices for the first time, it turned out to be the wrong guess:
   * cf-1 worked all day because with one group cvd falls back to the only one there is, and cf-2
   * failed its snapshot with `Multiple groups found. Narrow the selection with selector arguments.`
   * So take the name from `cvd fleet`, which reports structured data and is already parsed for the
   * adopt path, and treat the scrape as nothing more than a fast path.
   */
  private async resolveGroupName(): Promise<void> {
    if (this.groupName) return;
    this.groupName = (await this.findExisting())?.group;
    if (!this.groupName) {
      console.error(
        `[cuttlefish] ${this.info.localId}: cvd did not name its group and fleet does not list this ` +
        'device — every later cvd command will be unselected, which fails outright on a host with ' +
        'more than one device.',
      );
    }
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
    return findFleetInstance(out, {
      adbSerial: this.adbSerial,
      localId: this.info.localId,
      instanceNum: this.opts.instanceNum,
    });
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
        if (out === '1') { await this.makeUsable(); return; }
      } catch { /* not up yet */ }
      await sleep(1000);
    }
    throw new Error(`instance ${this.opts.instanceNum} did not boot within ${timeoutMs}ms`);
  }

  /**
   * Leave a freshly booted device on its launcher rather than on the keyguard.
   *
   * FOUND ON REAL HARDWARE, 2026-08-19, and only by looking at a screenshot. A cold-booted
   * Cuttlefish device sits on the lock screen. `launch` still reported DONE — `monkey` resolves the
   * launcher activity, injects the intent and exits 0, and the activity genuinely does start behind
   * the keyguard — so the control plane was telling the truth about what it did while the user saw a
   * clock. That is the exact failure shape this codebase treats as a lie: an action that confirms
   * while nothing observable happened.
   *
   * It is not specific to `launch`. A screenshot, a video, the future live view and any Appium
   * session that does not itself dismiss the keyguard all see the same lock screen, which is why
   * this lives in the one place every bring-up path funnels through rather than in `launchApp`.
   *
   * `stayon true` is the half that keeps it fixed: dismissing once is undone by the next screen
   * timeout, and a device that re-locks after ten minutes of a long suite is worse than one that was
   * never unlocked, because the failure moves around.
   *
   * BEST EFFORT, DELIBERATELY. Every command here is cosmetic relative to "did this device boot",
   * and none of them may turn a booted device into a failed one — a farm of two cannot afford to
   * lose a device to a keyevent. AOSP Cuttlefish has no lock credential set, so `dismiss-keyguard`
   * is a swipe rather than an unlock; a device that ever gets a real PIN needs a different answer.
   */
  private async makeUsable(): Promise<void> {
    const attempts: string[][] = [
      ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
      ['shell', 'wm', 'dismiss-keyguard'],
      ['shell', 'svc', 'power', 'stayon', 'true'],
    ];
    for (const args of attempts) {
      await run('adb', ['-s', this.adbSerial, ...args], process.cwd(), 10_000)
        .catch(() => { /* cosmetic; a booted device stays booted */ });
    }
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
    if (this.opts.resetMode === 'powerwash') return this.powerwash();
    const path = this.snapshotPath();
    await run('cvd', this.sel('stop'), this.opts.imageDir, 60_000).catch(() => { /* already stopped */ });
    await run('cvd', this.sel('start', `--snapshot_path=${path}`, '--daemon'), this.opts.imageDir, 120_000);
    await this.waitForBoot(60_000);
  }

  /**
   * Reset by returning the device to first-boot state, instead of restoring a snapshot.
   *
   * SLOWER AND THE ONLY OPTION FOR A LIVE VIEW, which is the whole reason it exists. Measured on the
   * lab box 2026-08-19: a snapshot-restored Cuttlefish completes the WebRTC negotiation, sends an
   * audio track, and publishes NO DISPLAY — so there is no video at all. A cold-booted one streams
   * at ~49 fps over the same path. Re-taking the snapshot from a device whose display was working
   * did not help; the restore itself is what loses it. So the two headline properties of this tier —
   * a 10s recycle and a live screen — cannot both be had from a restore on this cvd build.
   *
   * `cvd powerwash` is documented as "functionally equivalent to removing the device and creating it
   * again, but more efficient", and it leaves the group intact — which matters, because rebuilding a
   * group invalidates its snapshot (that path is a boot loop, not a reset).
   *
   * The tenant guarantee is unchanged and is the reason this still counts as `snapshot-reset`: the
   * next tenant gets first-boot state, with the previous tenant's apps, accounts and data gone.
   */
  private async powerwash(): Promise<void> {
    // Generous, and matched to cvd's own default: this is a full boot, not a restore. The device is
    // already out of the schedulable pool while it runs, so the cost of waiting is bounded.
    await run('cvd', this.sel('powerwash'), this.opts.imageDir, 600_000);
    await this.waitForBoot(120_000);
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
    // POWERWASH MODE IGNORES SNAPSHOTS ENTIRELY, and this one line is what makes that true rather
    // than aspirational. Without it `CF_RESET_MODE=powerwash` changed only how a device is RESET
    // and left `restartExisting()` free to boot from a snapshot still sitting on disk from before
    // the mode was set — so the farm came up restored, published no display, and the live view was
    // gone for exactly the reason the mode exists to avoid. Caught on the box, not in review.
    if (this.opts.resetMode === 'powerwash') return undefined;
    const dir = this.opts.snapshotDir;
    if (!dir) return undefined;
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir).catch(() => [] as string[]);
    return entries.length > 0 ? dir : undefined;
  }

  /**
   * Take the golden snapshot if this device does not have one yet.
   *
   * A failure is reported, never thrown. The consequence is already carried by
   * `refreshResetCapability` below — no snapshot means no `snapshot-reset`, which means the control
   * plane will not schedule tenant sessions onto this device. Throwing instead would take down a
   * worker that is otherwise fine, and hide a device that is genuinely usable for everything except
   * multi-tenant recycling. The boolean exists so `start` can tell "this group cannot snapshot"
   * (rebuild it) from "this host cannot snapshot" (rebuilding would be a boot loop).
   */
  private async ensureSnapshot(): Promise<boolean> {
    const dir = this.opts.snapshotDir;
    // No snapshot directory configured is a deliberate choice, not a failure: the device simply is
    // not resettable. Report success so `start` does not rebuild a group over a setting.
    if (!dir) return true;
    if (await this.snapshotOnDisk()) return true;
    const { mkdir, rm } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    try {
      await mkdir(dirname(dir), { recursive: true });
      console.log(`[cuttlefish] ${this.info.localId}: taking first snapshot into ${dir} (~4 GB, once)`);
      await this.takeSnapshot();
      return true;
    } catch (e) {
      console.error(`[cuttlefish] ${this.info.localId}: snapshot failed: ${(e as Error).message.split('\n')[0]}`);
      // A take that fails partway leaves a NON-EMPTY directory, and `snapshotOnDisk` reads any
      // content as a usable snapshot. Left in place it would be advertised as `snapshot-reset` and
      // then fail at the point where the cost is a tenant's session instead of a boot.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return false;
    }
  }

  /**
   * Advertise `snapshot-reset` when, and only when, there is a way to reset to a clean state.
   *
   * The capability's NAME says snapshot and its MEANING is "this device can be handed to a second
   * tenant" — `REQUIRED_FOR_TENANT_USE` is what reads it. Powerwash satisfies that meaning exactly:
   * the next tenant gets first-boot state. Withholding the capability in powerwash mode would make
   * every device unschedulable for the sake of a word.
   */
  private async refreshResetCapability(): Promise<void> {
    const has = this.opts.resetMode === 'powerwash' || Boolean(await this.snapshotOnDisk());
    const listed = this.info.capabilities.includes('snapshot-reset');
    if (has && !listed) this.info.capabilities = [...this.info.capabilities, 'snapshot-reset'];
    if (!has && listed) this.info.capabilities = this.info.capabilities.filter((c) => c !== 'snapshot-reset');
  }

  /**
   * `adb install` the file at `apkPath`, which the agent has already downloaded and checksummed.
   *
   * `-r` so reinstalling a build over itself keeps data instead of failing with
   * INSTALL_FAILED_ALREADY_EXISTS — the control plane re-offers a pending install on every
   * heartbeat, so an install that succeeded and lost its confirmation WILL be run twice, and the
   * second attempt has to be a no-op rather than an error.
   *
   * Deliberately NOT `-g`. Granting every runtime permission up front makes the app behave unlike
   * it does on a user's phone, and the permission dialog someone is trying to reproduce is exactly
   * the thing it would silently remove. A future `installApp(path, { grantPermissions: true })` can
   * offer it as a choice; defaulting to it would make the farm quietly unrepresentative.
   *
   * adb exits non-zero on a failed install, which `run` turns into a throw — but it has also
   * historically exited 0 while printing `Failure [INSTALL_FAILED_…]`, so the output is checked too.
   * The message the tenant reads is adb's own words; a category ("install failed") would send them
   * to us instead of to the reason.
   */
  async installApp(apkPath: string): Promise<void> {
    const out = await run('adb', ['-s', this.adbSerial, 'install', '-r', apkPath], process.cwd(), INSTALL_TIMEOUT_MS);
    if (/^\s*(Failure|Error)/im.test(out)) {
      throw new Error(`adb install failed on ${this.info.localId}: ${out.trim().split('\n').slice(-3).join(' ')}`);
    }
  }

  /**
   * Bring an app to the foreground, without knowing which activity is its launcher.
   *
   * `monkey` resolves that from the package's own intent filters, which is why it is used here in
   * preference to `am start -n <pkg>/<activity>` — the activity name is not something the control
   * plane knows, and asking a user for it to click "Launch" would be absurd.
   *
   * **monkey exits 0 when it fails.** `** No activities found to run, monkey aborted.` comes back on
   * stdout with a success code, so the output check below is not belt-and-braces — it is the only
   * signal there is. A package with no launcher activity (a service-only APK, an SDK, a test APK)
   * is the normal way to reach it.
   */
  async launchApp(packageName: string): Promise<void> {
    const out = await run('adb', [
      '-s', this.adbSerial, 'shell', 'monkey', '-p', packageName,
      '-c', 'android.intent.category.LAUNCHER', '1',
    ], process.cwd(), 60_000);
    if (/No activities found|Error|Exception/i.test(out)) {
      throw new Error(`could not launch ${packageName} on ${this.info.localId}: ${out.trim().split('\n').slice(-2).join(' ')}`);
    }
  }

  async uninstallApp(packageName: string): Promise<void> {
    const out = await run('adb', ['-s', this.adbSerial, 'uninstall', packageName], process.cwd(), 120_000);
    // Same shape as install: adb has historically reported failure on stdout with a zero exit.
    if (/^\s*(Failure|Error)/im.test(out)) {
      throw new Error(`adb uninstall failed for ${packageName} on ${this.info.localId}: ${out.trim().split('\n').slice(-2).join(' ')}`);
    }
  }

  /**
   * Follow this device's log.
   *
   * `-v threadtime` because that is the format every Android engineer already reads, and the one the
   * console's parser splits on. `-T 200` seeds the view with the last 200 lines rather than either
   * replaying the entire buffer (tens of thousands of lines into a browser) or starting empty and
   * making a person wait for the device to say something.
   *
   * The child is killed by the returned handle and nothing else. A logcat left running is an adb
   * connection held open against a device that is about to be snapshot-restored out from under it.
   */
  async captureLogcat(onLine: (line: string) => void): Promise<LogcatHandle> {
    const p = spawn('adb', ['-s', this.adbSerial, 'logcat', '-v', 'threadtime', '-T', '200']);
    let carry = '';
    const feed = (chunk: Buffer): void => {
      // Chunk boundaries do not respect lines, so the tail of one read is the head of the next.
      const parts = (carry + chunk.toString()).split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) onLine(line);
    };
    p.stdout.on('data', feed);
    // adb writes its own diagnostics ("device offline", "waiting for device") to stderr, and those
    // are exactly the lines someone staring at an empty log pane needs to see.
    p.stderr.on('data', feed);
    p.on('error', (e) => onLine(`--- logcat could not start: ${e.message}`));
    return {
      stop: () => { p.kill('SIGTERM'); },
    };
  }

  /**
   * The whole log buffer as it stands, for the artifact a finished session leaves behind.
   *
   * `-d` dumps and exits rather than following, so there is no process to manage and no window in
   * which lines are missed. `-v threadtime` matches the live stream's format, so a person reading a
   * downloaded log and a person watching the dock are reading the same thing.
   *
   * Capped, because a chatty run can produce tens of megabytes and the upload limit would reject
   * the whole artifact — leaving the session with no log at all rather than a long one. Losing the
   * oldest lines is the right half to lose: a failure is at the end.
   */
  async dumpLogcat(): Promise<string> {
    const out = await runBinary('adb', ['-s', this.adbSerial, 'logcat', '-d', '-v', 'threadtime'], 60_000);
    const text = out.toString('utf8');
    const LIMIT = 8 * 1024 * 1024;
    if (text.length <= LIMIT) return text;
    const kept = text.slice(text.length - LIMIT);
    return `--- truncated: ${text.length - LIMIT} earlier bytes dropped ---\n${kept}`;
  }

  /**
   * One PNG, straight off the framebuffer.
   *
   * `exec-out` rather than `shell`, because `adb shell` mangles binary output on some platforms by
   * translating CRLF — the classic corrupt-screenshot bug — and `exec-out` is the raw-bytes channel
   * that exists to avoid it. `maxBuffer` is raised because a 720x1280 PNG comfortably exceeds
   * Node's 1 MB default and the failure mode is a truncated file rather than an error.
   */
  async screenshot(): Promise<{ bytes: Buffer; contentType: string }> {
    const bytes = await runBinary('adb', ['-s', this.adbSerial, 'exec-out', 'screencap', '-p'], 30_000);
    // PNG magic. adb has been known to exit 0 having written an error message instead of an image,
    // and a console that renders that as a broken <img> tells nobody anything.
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
      throw new Error(`screencap did not return a PNG on ${this.info.localId}: ${bytes.subarray(0, 120).toString().trim()}`);
    }
    return { bytes, contentType: 'image/png' };
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
      volume_up: 'KEYCODE_VOLUME_UP', volume_down: 'KEYCODE_VOLUME_DOWN',
    };
    await run('adb', ['-s', this.adbSerial, 'shell', 'input', 'keyevent', codes[name] ?? name], process.cwd(), 10_000);
  }

  /**
   * Rotate by lying to the accelerometer, which is the only thing Android listens to.
   *
   * `cuttlefish_sensor_injection` ships in the guest image for exactly this. Turning the display
   * instead — `cvd display` or a WM override — moves the pixels and leaves every orientation-aware
   * app believing the device is still upright, which is worse than not offering the button.
   *
   * The argument is an absolute orientation (0 portrait, 1 landscape), not a delta, so "left" and
   * "right" are the two states rather than a running total. A device that has no such binary is
   * reported as a failure rather than silently doing nothing.
   */
  async rotate(direction: 'left' | 'right'): Promise<void> {
    const out = await run('adb', [
      '-s', this.adbSerial, 'shell', '/vendor/bin/cuttlefish_sensor_injection',
      'rotate', direction === 'left' ? '1' : '0',
    ], process.cwd(), 15_000);
    if (/not found|No such file|Error/i.test(out)) {
      throw new Error(`this image has no sensor injection binary, so it cannot be rotated: ${out.trim().split('\n').slice(-1)[0]}`);
    }
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

  /**
   * Open the operator conversation on behalf of one viewer (ADR-0007).
   *
   * Note what is NOT here: no peer connection, no track, no frame. This returns a pipe for the
   * browser's own negotiation, and the media it negotiates flows between the browser and this host
   * without passing through the worker at all.
   */
  async signal(handlers: SignalOptions): Promise<SignalChannel> {
    return openSignalChannel(
      {
        baseUrl: this.opts.operatorUrl,
        localId: this.opts.localId,
        instanceNum: this.opts.instanceNum,
      },
      handlers,
    );
  }
}

export function createCuttlefishBackend(opts: CuttlefishOptions): DeviceBackend {
  return { control: new CuttlefishDevice(opts), media: new CuttlefishMedia(opts) };
}
