import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { cpus, hostname as osHostname, totalmem } from 'node:os';
import { join } from 'node:path';

const { X_OK } = fsConstants;
import { automationIsTunnelled, dataPlaneEndpoint, gatewayBase, tunnelEnabled } from './automation-endpoint.ts';
import { Agent } from './agent.ts';
import { AppiumSupervisor, derivePort } from './appium.ts';
import { AutomationGateway } from './gateway.ts';
import { DataPlane } from './dataplane.ts';
import { AgentTunnel } from './tunnel.ts';
import { createCuttlefishBackend, CuttlefishDevice } from './devices/cuttlefish.ts';
import { createAvdBackend } from './devices/avd.ts';
import { createPhysicalBackend, PhysicalDevice } from './devices/physical.ts';
import { discover, localIdForSerial, watchForChanges } from './devices/discovery.ts';
import type { DiscoveredDevice } from './devices/discovery.ts';
import { AgentWindow, openInBrowser, type WindowDevice, type WindowNotice, type WindowState } from './window.ts';
import type { DeviceBackend } from './device.ts';

/**
 * Worker agent entry point.
 *
 * Chooses Cuttlefish when the host can actually run it, and says plainly why it cannot when it
 * cannot — rather than silently degrading to the slower tier and leaving someone to wonder later
 * why latency is bad. The same rule governs the `webdriver` capability below: it is advertised only
 * when a supervised Appium has answered, never because an environment variable said so.
 *
 * And it is un-advertised when that stops being true, which is the harder half. The control plane
 * writes `hosts.capabilities` at registration only, so "withdraw the capability" has no in-place
 * form — see the block around `withdrawTimer` for what is actually available today, why
 * re-registering is not it, and what `packages/protocol` would need for a real one.
 */

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`${key} is required`);
  return v;
}

const flag = (key: string): boolean => /^(1|true|yes|on)$/i.test(process.env[key] ?? '');

/**
 * A flag that is ON unless somebody turns it off — for behaviour that is the product rather than an
 * option, and where an operator who wants it gone should have to say so.
 */
const flagUnless = (key: string): boolean => !/^(0|false|no|off)$/i.test(process.env[key] ?? '');

/**
 * The phones on this machine's USB, as backends (ADR-0008, spec §6).
 *
 * OPT-IN VIA `PHYSICAL_ENABLED`, deliberately. Discovery is a read — `adb devices` — but enrolling
 * what it finds is not: it puts a handset into a farm where a stranger's session can drive it. A
 * developer with a phone plugged in for unrelated reasons must not have it silently join a fleet
 * because they started an agent.
 *
 * WHAT IT DOES WITH A PHONE IT CANNOT USE. Says so, with the fix. An unauthorized or badly-cabled
 * device is the single most common physical-farm support ticket, and the version of this that
 * filters them out silently turns "tap Allow on the screen" into an afternoon.
 */
/**
 * `aapt2` from the Android SDK's build-tools, if this machine has any.
 *
 * Searched rather than configured: `ANDROID_HOME` is already required for Appium, build-tools sit
 * at a versioned path underneath it, and asking an operator for a fifth variable naming a binary
 * inside a directory they already told us about is how setup becomes a support ticket. Newest
 * version wins — `readdir` sorted descending is good enough for the `NN.N.N` names these use, and
 * any of them can read a package name.
 */
async function findAapt2(): Promise<string | undefined> {
  if (process.env.AAPT2_PATH) return process.env.AAPT2_PATH;
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) return undefined;
  try {
    const versions = (await readdir(join(sdk, 'build-tools'))).sort().reverse();
    for (const v of versions) {
      const candidate = join(sdk, 'build-tools', v, 'aapt2');
      try {
        await access(candidate, X_OK);
        return candidate;
      } catch { /* try the next version */ }
    }
  } catch { /* no build-tools directory at all */ }
  return undefined;
}

async function choosePhysicalBackends(): Promise<DeviceBackend[]> {
  let found: DiscoveredDevice[];
  try {
    found = await discover();
  } catch (e) {
    // NOT the same thing as an empty USB bus, and the old message said it was — "adb sees no
    // devices ... check the cable and that adb is installed" covered both, so the one case with an
    // actual error message printed a guess instead of it. The agent still starts: the window is
    // worth more here than anywhere, and the poll retries.
    console.error(
      `[agent] adb is not answering, so no phone on this machine can be found: ${(e as Error).message}`,
    );
    return [];
  }
  if (found.length === 0) {
    console.warn('[agent] PHYSICAL_ENABLED is set and adb reports nothing plugged in — check the cable');
    return [];
  }

  const usable = found.filter((d) => d.state === 'device');
  for (const d of found) {
    if (d.state === 'device') continue;
    // One line per unusable device, naming the device, the state and what to do about it.
    console.warn(`[agent] ${d.serial} is ${d.state} and will NOT be enrolled — ${d.remedy}`);
  }

  /**
   * How a release cleans these phones — ADR-0012, and `install-scoped` unless somebody says
   * otherwise IN THIS PROCESS's environment.
   *
   * There is no console setting for this yet; when there is, it belongs beside the per-device
   * sharing toggle, because it is the same trust decision made by the same person. Until then an
   * operator provisioning a dedicated farm phone opts in here, and a borrowed handset gets the safe
   * mode by doing nothing at all — which is the entire point of the ADR.
   */
  const resetMode = process.env.PHYSICAL_RESET_MODE === 'full-sweep' ? 'full-sweep' as const : 'install-scoped' as const;
  if (resetMode === 'full-sweep') {
    console.warn(
      '[agent] PHYSICAL_RESET_MODE=full-sweep — a release will `pm clear` EVERY third-party package '
      + 'on these devices except the keep list. Correct for a dedicated farm phone; on somebody\'s '
      + 'own handset it wipes their apps\' data. `node deploy/verify-physical.mjs` lists exactly what.',
    );
  }

  // `aapt2` lets the agent read an APK's package name BEFORE installing it, which is what turns
  // "we overwrote the owner's app" from a report into a refusal. Absent is survivable, and
  // installApp says so at the moment it matters rather than here.
  const aapt2Path = await findAapt2();
  if (!aapt2Path && resetMode === 'install-scoped') {
    console.warn(
      '[agent] no aapt2 in the Android SDK build-tools — the agent cannot read an APK\'s package '
      + 'name in advance, so installing over an app the device already has will be reported after '
      + 'the fact instead of refused. Fix: ./deploy/install-build-tools.sh',
    );
  }

  const backends = usable.map((d) => {
    const localId = localIdForSerial(d.serial);
    console.log(
      `[agent] enrolling ${localId}: ${d.props?.manufacturer ?? '?'} ${d.props?.model ?? d.serial}`
      + `, Android ${d.props?.osVersion ?? '?'} (sdk ${d.props?.sdkVersion ?? '?'})`,
    );
    return createPhysicalBackend({
      serial: d.serial,
      localId,
      model: d.props?.model,
      osVersion: d.props?.osVersion,
      manufacturer: d.props?.manufacturer,
      sdkVersion: d.props?.sdkVersion,
      screen: d.props?.screen,
      keepPackages: (process.env.PHYSICAL_KEEP_PACKAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      resetMode,
      aapt2Path,
    });
  });

  /**
   * WILL INSTALLS EVEN WORK ON THESE PHONES? Asked here, once, because the answer costs one adb
   * read and the alternative is finding out 60 seconds into somebody's first session.
   *
   * Play Protect refuses debug-signed APKs pushed over adb — which includes Appium's own helpers,
   * so a phone in this state cannot run a session at all, and the symptom is `upstream_rejected`
   * several hops from the cause.
   *
   * ON THE REAL BACKENDS, not a throwaway probe: `disableInstallVerification` remembers what the
   * setting was so `restoreInstallVerification` can put it back, and a prior value recorded on an
   * object nobody keeps is a promise to restore that could never be kept.
   */
  const mayDisable = flag('PHYSICAL_ALLOW_INSTALL_VERIFICATION_OFF');
  for (const b of backends) {
    const dev = b.control as PhysicalDevice;
    try {
      if (!(await dev.installVerificationOn())) continue;
      if (mayDisable) {
        await dev.disableInstallVerification();
        console.log(
          `[agent] ${dev.info.localId}: adb-install verification turned OFF, as `
          + `PHYSICAL_ALLOW_INSTALL_VERIFICATION_OFF permits. Restored when this agent stops.`);
        continue;
      }
      console.warn(
        `[agent] ${dev.info.localId}: Play Protect will REFUSE apps installed over adb, including `
        + `the automation helpers — so sessions on this device fail before your app ever runs. `
        + `Either tap through "Harmful app blocked" on the phone, or start the agent with `
        + `PHYSICAL_ALLOW_INSTALL_VERIFICATION_OFF=1. It is a security setting on somebody's phone, `
        + `so it is the owner's call and the agent will not make it silently.`);
    } catch (e) {
      // Advice, not a gate: a phone that cannot answer this still enrolls and still works.
      console.warn(`[agent] ${dev.info.localId}: could not read the install-verification setting — ${(e as Error).message}`);
    }
  }

  return backends;
}

async function chooseBackends(): Promise<DeviceBackend[]> {
  // Additive rather than exclusive: a host may legitimately have both, and the tiers do not
  // interact — they are separate devices with separate lifecycles behind one abstraction (§32).
  const physical = flag('PHYSICAL_ENABLED') ? await choosePhysicalBackends() : [];
  const avail = await CuttlefishDevice.available();

  if (avail.ok) {
    const count = Number(process.env.CF_INSTANCES ?? 1);
    const imageDir = env('CF_IMAGE_DIR');
    // One directory PER DEVICE, and a default rather than a required variable.
    //
    // Both halves are load-bearing. A shared directory means device 2 restores device 1's state,
    // which is the tenant leak snapshot-reset exists to prevent. And an unset variable used to mean
    // no snapshot at all: `snapshotDir` was optional, nothing ever passed it, so every reset threw
    // and left the device stuck in CLEANING. Defaulting beside the image dir (`~/cf/image` ->
    // `~/cf/snapshots`) keeps a farm working without a fifth required variable; beside rather than
    // inside because bootstrap_cuttlefish.sh locates the image roots by searching for
    // `bin/launch_cvd` and `super.img`, and a 4 GB snapshot under imageDir would confuse that.
    const snapshotRoot = process.env.CF_SNAPSHOT_DIR ?? join(imageDir, '..', 'snapshots');
    console.log(`[agent] Cuttlefish available — starting ${count} instance(s), snapshots under ${snapshotRoot}`);
    return [...physical, ...Array.from({ length: count }, (_, i) =>
      createCuttlefishBackend({
        localId: `cf-${i + 1}`,
        instanceNum: i + 1,
        imageDir,
        snapshotDir: join(snapshotRoot, `cf-${i + 1}`),
        publicHost: process.env.PUBLIC_HOST,
        // Loopback unless told otherwise. The operator is unauthenticated device control, so the
        // only reason to override this is an unusual cvd layout, never a remote host.
        operatorUrl: process.env.CF_OPERATOR_URL,
        // `powerwash` is what a farm used INTERACTIVELY needs: a snapshot-restored Cuttlefish
        // publishes no display, so there is no live view at all (see `powerwash()`). It costs ~80s
        // per reset instead of ~10s. Default stays `snapshot` so an automation-only farm is not
        // silently slowed down.
        resetMode: process.env.CF_RESET_MODE === 'powerwash' ? 'powerwash' : 'snapshot',
        gpuMode: process.env.GPU_MODE === 'none' ? 'none' : 'guest_swiftshader',
      }),
    )];
  }

  console.warn(`[agent] Cuttlefish unavailable: ${avail.reason}`);

  /**
   * A laptop with phones on it is a COMPLETE host, not a degraded one.
   *
   * This return exists so the AVD fallback below is not reached in that case. Falling through would
   * demand `AVD_NAME` — `env()` throws without it — so an agent doing exactly what ADR-0008 designed
   * it for would exit at startup asking for an emulator nobody wants, with the phones it had already
   * found going unmentioned.
   */
  if (physical.length > 0) {
    console.log(`[agent] serving ${physical.length} physical device(s); no virtual tier on this host`);
    return physical;
  }

  /**
   * `PHYSICAL_ENABLED` WITH NOTHING PLUGGED IN IS A WAIT, NOT A FAILURE — and until M2 there was
   * nothing to wait in.
   *
   * This host said it is a machine phones get plugged into. Falling through to the AVD tier makes
   * `env('AVD_NAME')` throw, so the agent exits — which is exactly backwards for the case ADR-0009
   * is written about: somebody runs this, THEN goes and finds a cable. The window is the thing that
   * tells them the agent is fine and the phone is not plugged in, and an agent that has already
   * exited has no window to say it in.
   *
   * Registering with an empty device list is honest rather than a lie of omission: the host is up,
   * it has capacity for nothing, and the scheduler reads the device list rather than the host's
   * existence. It is also what makes the M2 gate performable at all — "plug a phone in with the
   * window open" needs the window open first.
   *
   * A PHONE THAT ARRIVES STILL RESTARTS THE AGENT, for the reason in the hot-plug block below:
   * capabilities and the device list travel only on registration. Under a process supervisor that
   * is invisible. Run from a terminal it is not, and that gap closes in M5, not here.
   */
  if (flag('PHYSICAL_ENABLED')) {
    console.warn(
      '[agent] no devices yet. Staying up — plug a phone into this machine and it joins on its own; '
      + 'the window says what each one needs.',
    );
    return [];
  }

  console.warn('[agent] falling back to the AVD tier — it cannot meet the 100ms target and has no WebRTC path');
  return [createAvdBackend({ avdName: env('AVD_NAME'), localId: 'avd-1' })];
}

/**
 * Build one Appium supervisor per device, or none.
 *
 * Multi-device is supported as of protocol v2. It was refused before, and the reason was a protocol
 * limit rather than a limitation of the supervisor: `WorkerRegistration` carried exactly ONE
 * host-level `automationEndpoint`, and `agent.ts` stamped `webdriver` onto every device once it was
 * set — so a second device advertised a capability whose server the hub could never reach, and every
 * session allocated to it failed. `devices[].automationEndpoint` plus the ADR-0004 gateway removes
 * both halves of that: each device names its own gateway path, and only devices with a ready server
 * carry the capability.
 *
 * `AUTOMATION_ENDPOINT` remains the way to front several devices with one operator-managed server.
 */
function createSupervisors(
  backends: DeviceBackend[],
  onPermanentFailure: (localId: string, reason: string) => void,
  onHealthChange: (localId: string, healthy: boolean) => void,
): AppiumSupervisor[] {
  if (!flag('APPIUM_ENABLED')) return [];

  const basePort = Number(process.env.APPIUM_BASE_PORT ?? 4723);
  const supervisors = backends.map((b) => {
    const localId = b.control.info.localId;
    return new AppiumSupervisor({
      localId,
      port: derivePort(localId, basePort),
      command: process.env.APPIUM_PATH,
      // Deliberately NOT advertiseHost. Since ADR-0004 nothing outside this host is ever told where
      // Appium is: the gateway is what gets advertised, and it reaches Appium over loopback. The
      // supervisor's own endpoint is now used for health and for the proxy target, nothing else.
      // Appium does NOT inherit this process's environment — it would otherwise receive
      // WORKER_REGISTRATION_TOKEN. Anything a particular driver genuinely needs is named here.
      envPassthrough: (process.env.APPIUM_ENV_PASSTHROUGH ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      onPermanentFailure: (reason) => onPermanentFailure(localId, reason),
      onHealthChange: (healthy) => onHealthChange(localId, healthy),
    });
  });

  // Reinstated with multi-supervisor support, exactly as the note on `derivePort` asked. `derivePort`
  // hashes any id that does not end in digits, and hashes collide — two devices sharing a port means
  // the second Appium never binds, and the failure surfaces as an unrelated readiness timeout.
  const byPort = new Map<number, string>();
  for (const s of supervisors) {
    const clash = byPort.get(s.port);
    if (clash !== undefined) {
      throw new Error(
        `Appium port collision: devices '${clash}' and '${s.localId}' both derive port ${s.port}. ` +
        'Rename one so it ends in a distinct number (cf-1, cf-2), or set APPIUM_BASE_PORT apart.',
      );
    }
    byPort.set(s.port, s.localId);
  }
  return supervisors;
}

/**
 * How long this host may keep advertising `webdriver` after its Appium stops being ready.
 *
 * ADR-0003 decision 3 says an unhealthy supervisor withdraws the capability. There is no way to do
 * that in place: `POST /workers/heartbeat` ignores its body, and the only endpoint that writes
 * capabilities is `POST /workers/register`, which is disqualified as a runtime operation — see the
 * comment on withdrawTimer. So withdrawal means draining and exiting, and the grace window is the
 * knob that decides when a temporary outage becomes a lie worth restarting the agent over.
 *
 * 60s is chosen to survive exactly one ordinary crash-and-recover: a few seconds of backoff plus a
 * cold start that the ADR estimates at ~30s. Below that, every routine Appium restart bounces the
 * whole agent and takes the host's interactive sessions with it — decision 5's crash-loop objection,
 * one level up. Above it, the host is knowingly advertising a capability it cannot serve. Raise it
 * on a host where Appium is slow to boot; lower it on a host that only serves WebDriver.
 */
const UNHEALTHY_GRACE_MS = Number(process.env.APPIUM_UNHEALTHY_GRACE_MS ?? 60_000);

/** A drain that hangs is a host that never releases its devices, so it gets a hard deadline. */
const DRAIN_TIMEOUT_MS = Number(process.env.AGENT_DRAIN_TIMEOUT_MS ?? 30_000);


/**
 * Per-device automation endpoints to register, keyed by local id.
 *
 * Waits for a genuine `/status` answer per device before including it. An endpoint advertised on
 * hope is worse than no endpoint at all: the control plane demands the `webdriver` capability when
 * it allocates for the hub, so a device that claims it and cannot serve it does not degrade — it
 * absorbs sessions and fails them.
 *
 * Per device rather than per host since v2. A host with one healthy Appium and one dead one now
 * registers `webdriver` on the first device only, instead of the old all-or-nothing answer.
 */
async function resolveAutomationEndpoints(
  supervisors: AppiumSupervisor[],
  endpointFor: (localId: string) => string,
): Promise<Record<string, string>> {
  const manual = process.env.AUTOMATION_ENDPOINT;
  // Escape hatch, unchanged: an externally-managed Appium (a systemd unit, a sidecar, one server
  // fronting several devices) is still a legitimate deployment and is not second-guessed here. It
  // stays HOST-level, because that is the shape it has always had.
  if (supervisors.length === 0) return {};

  if (manual) {
    console.warn('[agent] AUTOMATION_ENDPOINT is ignored while APPIUM_ENABLED is set — the supervised servers win');
  }

  // Started concurrently: each cold start costs tens of seconds, and serialising them means the
  // second device is unavailable for the duration of the first one's boot.
  const started = await Promise.all(
    supervisors.map(async (sup) => ({ sup, ready: await sup.start() })),
  );

  const endpoints: Record<string, string> = {};
  for (const { sup, ready } of started) {
    if (ready) {
      endpoints[sup.localId] = endpointFor(sup.localId);
      console.log(`[agent] Appium ready for ${sup.localId} on :${sup.port}, advertised at ${endpoints[sup.localId]}`);
    } else {
      console.error(
        `[agent] Appium for ${sup.localId} did not become ready (state: ${sup.state}) — registering ` +
        'that device WITHOUT the webdriver capability rather than advertising a server that is not ' +
        'answering. The supervisor keeps retrying; restart the agent once it is up.',
      );
    }
  }
  return endpoints;
}

async function main(): Promise<void> {
  const backends = await chooseBackends();

  // Devices come up before registration so the control plane never sees a host advertising
  // capacity it cannot actually serve.
  //
  // SERIAL ON PURPOSE. Booting two devices at once is the obvious optimisation and it is not taken:
  // every `cvd` verb here mutates one shared instance database, and nothing in this project has
  // verified that concurrent invocations are safe against it. The real cost was never the
  // serialisation anyway — it was cold booting when a snapshot restore would do, which start() now
  // handles (38s -> 8s, and 0s when the device is already up). Revisit only with a measurement.
  for (const b of backends) {
    const t0 = Date.now();
    await b.control.start();
    console.log(`[agent] ${b.control.info.localId} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Rebound once shutdown() exists below. Until then a give-up can only be reported, because there
  // is nothing registered yet to drain.
  let onGiveUp = (localId: string, reason: string): void => {
    console.error(`[agent] Appium for ${localId} gave up before registration completed: ${reason}`);
  };
  // Health flips before registration are uninteresting: resolveAutomationEndpoints is waiting on the
  // first one anyway, and nothing has been advertised yet that could need withdrawing.
  let onHealth = (_localId: string, _healthy: boolean): void => {};
  const supervisors = createSupervisors(
    backends,
    (id, r) => onGiveUp(id, r),
    (id, h) => onHealth(id, h),
  );

  const gatewayPort = Number(process.env.AUTOMATION_GATEWAY_PORT ?? 8090);
  // Composed per device, and composed EAGERLY for the first one so an unadvertisable gateway is a
  // startup failure rather than a device that quietly registers without the `webdriver` capability.
  const automationEndpoints = supervisors.length > 0
    ? await resolveAutomationEndpoints(supervisors, (localId) => gatewayBase(gatewayPort, localId))
    : {};

  const agent = new Agent({
    controlPlaneUrl: env('CONTROL_PLANE_URL', 'http://localhost:3000'),
    registrationToken: env('WORKER_REGISTRATION_TOKEN'),
    hostname: env('WORKER_HOSTNAME', osHostname()),
    region: env('REGION'),
    // NOT `env('PUBLIC_ENDPOINT')` any more. It had no default, so an agent on a laptop refused to
    // start over an address that a tunnelled host has never used — see `dataPlaneEndpoint`.
    endpoint: dataPlaneEndpoint(),
    // The gateway's public path per device (ADR-0004), or — when Appium is managed outside this
    // agent — whatever AUTOMATION_ENDPOINT names, which stays host-level and must not be publicly
    // routable, because an open Appium port is unauthenticated device control.
    automationEndpoint: supervisors.length === 0 ? process.env.AUTOMATION_ENDPOINT : undefined,
    automationEndpoints,
    devices: backends,
    cores: cpus().length,
    memoryMb: Math.round(totalmem() / 1_048_576),
  });

  /**
   * The gateway comes up BEFORE registration, and that order is load-bearing.
   *
   * Registration is what puts this host in the scheduler's pool for WebDriver work, so the hub may
   * dial the advertised endpoint the moment it returns. A gateway started afterwards leaves a window
   * where the endpoint is published and nothing is listening on it.
   *
   * It binds the CONFIGURED port, never an ephemeral one: the url was already composed from that
   * number and handed to the agent above. A failure to bind is therefore fatal rather than something
   * to work around — the alternative is registering an endpoint that resolves to nothing.
   */
  const gatewayBindHost = process.env.AUTOMATION_BIND_HOST?.trim()
    || process.env.BIND_HOST?.trim()
    || (automationIsTunnelled() ? '127.0.0.1' : undefined);

  const gateway = supervisors.length > 0
    ? new AutomationGateway({
        agent,
        targets: new Map(supervisors.map((s) => [s.localId, s.port])),
      })
    : undefined;
  if (gateway) {
    // AUTOMATION_BIND_HOST, falling back to the older shared BIND_HOST.
    //
    // The two listeners are bound SEPARATELY as of ADR-0005/ADR-0007, and that split is the whole
    // point: this one only ever has to be reachable by the containerised hub on the same box, so it
    // belongs on the docker bridge or on loopback. The data plane has to be reachable by a browser
    // and cannot live there. Sharing one variable meant satisfying the hub broke the viewer, which
    // is exactly what happened (HANDOFF known issue 15).
    //
    // ON THE TUNNEL PATH IT IS LOOPBACK, and not as a default an operator can drift off: the only
    // client is this same process, replaying what arrived on the tunnel. That is what makes
    // ADR-0009 §3's "nothing listens on the network" true of a laptop rather than aspirational —
    // an explicit bind variable is still honoured, because an operator who set one is describing
    // a deployment we cannot see, but nothing else can widen it by accident.
    await gateway.listen(gatewayPort, gatewayBindHost);
    console.log(`[agent] automation gateway listening on ${gatewayBindHost ?? '0.0.0.0'}:${gatewayPort}`);
  }

  /**
   * ------------------------------------------------------------------ the window (ADR-0009 §1, M2)
   *
   * BEFORE REGISTRATION, deliberately. The moment the window is worth the most is the one where
   * the control plane cannot be reached — a person staring at a phone that will not appear in the
   * console needs to be told that the phone is fine and the network is not. A window that only
   * opens after `agent.start()` returns is dark for exactly that case.
   *
   * It reads; it does not compute. Every field below already exists somewhere in this process, and
   * the snapshot is a pure function over `backends`, `lastDiscovery` and two read-only accessors on
   * the agent — no adb, no device handles, nothing that could make the page a second client of the
   * hardware. That is what keeps a browser tab from being able to disturb a running suite.
   */

  /**
   * The last full USB picture, refreshed by the discovery poll below.
   *
   * The FULL list, not the usable set: a phone sitting at `unauthorized` is precisely the one whose
   * row somebody is waiting to see change, and it is the one `watchForChanges` is right to keep out
   * of its own arrival/departure callback.
   */
  let lastDiscovery: DiscoveredDevice[] = [];

  const windowState = (): WindowState => {
    const devices: WindowDevice[] = [];
    const adopted = new Set<string>();

    for (const b of backends) {
      const info = b.control.info;
      const serial = info.adbSerial;
      if (serial) adopted.add(serial);
      const seen = serial ? lastDiscovery.find((d) => d.serial === serial) : undefined;
      const deviceId = agent.deviceIdFor(info.localId);
      const sessions = deviceId ? agent.sessionsOn(deviceId) : 0;
      const health = agent.healthOf(info.localId);
      const phone = b.control as Partial<PhysicalDevice>;

      // Adopted at start-up and no longer in a discovery pass that found SOMETHING: the cable is
      // out. Distinguished from `health === 'offline'` because the remedy is different and physical
      // — replug it — where a degraded device needs looking at. Guarded on a non-empty pass so an
      // adb hiccup, which returns [], does not report every phone as unplugged.
      const vanished = info.tier === 'physical' && lastDiscovery.length > 0 && !seen;

      const status: WindowDevice['status'] =
        vanished || health === 'offline' || health === 'degraded' ? 'unhealthy'
          : sessions > 0 ? 'busy'
            : !deviceId ? 'starting'
              : 'ready';

      devices.push({
        serial: serial ?? info.localId,
        localId: info.localId,
        model: info.model,
        manufacturer: seen?.props?.manufacturer,
        osVersion: info.osVersion,
        adbState: info.tier === 'physical' ? (seen?.state ?? (vanished ? 'offline' : undefined)) : undefined,
        shared: Boolean(deviceId),
        status,
        remedy: vanished
          ? 'This phone is no longer on USB. Replug it — the agent picks it up again on its own.'
          : seen?.remedy,
        // `undefined` for a tier that has no such setting, so the offer never appears on a
        // Cuttlefish instance, where the button would have nothing to press.
        installVerification: typeof phone.installVerification === 'string' ? phone.installVerification : undefined,
        sessions,
      });
    }

    // Everything adb can see that this agent is NOT using — the whole reason a person opens this
    // page. A phone that is plugged in and missing from the console with no explanation is the
    // single most common physical-farm support ticket, and every one of these rows carries the
    // instruction that ends it.
    for (const d of lastDiscovery) {
      if (adopted.has(d.serial)) continue;
      devices.push({
        serial: d.serial,
        model: d.props?.model ?? d.serial,
        manufacturer: d.props?.manufacturer,
        osVersion: d.props?.osVersion,
        adbState: d.state,
        shared: false,
        status: d.state === 'device' ? 'starting' : 'blocked',
        remedy: d.state === 'device'
          ? 'Usable, and not in the farm yet. The agent restarts to register it — any live session on the other devices finishes first.'
          : d.remedy,
        sessions: 0,
      });
    }

    const notices: WindowNotice[] = [];
    if (!agent.hostId) {
      notices.push({
        level: 'warn',
        title: 'Not registered with the control plane yet',
        detail: `Trying ${env('CONTROL_PLANE_URL', 'http://localhost:3000')}. Devices on this machine `
          + 'work locally, and nobody can reach them from the console until this succeeds.',
      });
    }
    if (!flag('PHYSICAL_ENABLED')) {
      notices.push({
        level: 'info',
        title: 'This agent is not looking for phones on USB',
        detail: 'Start it with PHYSICAL_ENABLED=1 to have handsets discovered and enrolled.',
      });
    }
    // Read from the environment rather than threaded down from `choosePhysicalBackends`, because
    // this is the same pure env read that produced the mode — and the blast radius is worth saying
    // twice, in the log at start-up and on the screen somebody is actually looking at.
    if (process.env.PHYSICAL_RESET_MODE === 'full-sweep') {
      notices.push({
        level: 'warn',
        title: 'Releasing a device here clears every third-party app on it',
        detail: 'PHYSICAL_RESET_MODE=full-sweep is set. That is correct for a dedicated farm phone '
          + 'and wrong for anybody\'s own handset — it wipes app data, including banking and 2FA. '
          + 'Unset it to go back to removing only what a session installed.',
      });
    }

    return {
      host: {
        hostname: env('WORKER_HOSTNAME', osHostname()),
        region: env('REGION'),
        controlPlaneUrl: env('CONTROL_PLANE_URL', 'http://localhost:3000'),
        hostId: agent.hostId,
        endpoint: dataPlaneEndpoint(),
        tunnel: tunnelEnabled(),
      },
      devices,
      notices,
    };
  };

  const win = flagUnless('MFARM_WINDOW')
    ? new AgentWindow({
        snapshot: windowState,
        actions: {
          /**
           * THE BUTTON IS THE CONSENT (M1, ADR-0012's spirit applied to a security setting).
           *
           * `PHYSICAL_ALLOW_INSTALL_VERIFICATION_OFF=1` is the headless path and stays; it is the
           * wrong shape for a person, because it asks somebody to decide about their own phone
           * before they have seen the phone. Here the offer appears beside the device, in the
           * moment it matters, and it is reversible from the same place.
           */
          setInstallVerification: async (localId: string, enabled: boolean): Promise<void> => {
            const found = backends.find((b) => b.control.info.localId === localId);
            const dev = found?.control as Partial<PhysicalDevice> | undefined;
            if (!dev?.disableInstallVerification || !dev.restoreInstallVerification) {
              throw new Error(`${localId} is not a device this agent can change that setting on.`);
            }
            if (enabled) await dev.restoreInstallVerification();
            else await dev.disableInstallVerification();
            console.log(
              `[agent] ${localId}: adb-install verification turned ${enabled ? 'back ON' : 'OFF'} `
              + 'from the window. It is put back exactly as found when this agent stops.',
            );
          },
        },
      })
    : undefined;

  if (win) {
    await win.listen(Number(process.env.MFARM_WINDOW_PORT ?? 7317));
    // THE URL CARRIES THE TOKEN, so this line is a credential. It goes to the agent's own stdout,
    // which on a laptop is the terminal the person is already looking at and on a service box is a
    // journal that already holds the enrollment token — no new exposure either way, and there is
    // nowhere else to put it: ADR-0009 §3 says the token is never persisted.
    console.log(`[agent] window at ${win.url}`);
    // Only where a person is present. `isTTY` is false under systemd, where launching a browser
    // would be a process that fails for no reason anybody asked for.
    if (flagUnless('MFARM_WINDOW_OPEN') && process.stdout.isTTY) openInBrowser(win.url);
  }

  const state = await agent.start();
  console.log(`[agent] registered as host ${state.hostId}`);


  /**
   * Control-plane uuid -> local backend, built from what registration just returned.
   *
   * THIS MAP USED TO BE EMPTY. It was declared here and never written to, and the comment beside it
   * described a mapping "taught on first use" that nothing taught — so the single-device fallback
   * was carrying every case, and a two-device host answered `unknown_device` to every data-plane
   * connection. Nothing caught it because the fallback is correct at N=1 and the data plane had no
   * browser client to fail against. Registration returns `deviceIds` (localId -> uuid) precisely so
   * this does not have to be guessed; that field was added for the automation gateway and is the
   * same answer here.
   */
  const byUuid = new Map<string, DeviceBackend>();
  for (const b of backends) {
    const uuid = agent.deviceIdFor(b.control.info.localId);
    if (uuid) byUuid.set(uuid, b);
    else console.warn(`[agent] the control plane returned no uuid for ${b.control.info.localId} — its data-plane connections will be refused as unknown_device`);
  }

  const dp = new DataPlane({
    agent,
    backends: new Map(backends.map((b) => [b.control.info.localId, b])),
    // Still falls back to the sole device on a single-device host, for the case where a worker is
    // running from persisted state that predates `deviceIds`.
    resolveDevice: (uuid) => byUuid.get(uuid) ?? (backends.length === 1 ? backends[0] : undefined),
  });

  /**
   * Where the data plane binds — the socket a BROWSER connects to, so its reachability is a product
   * requirement rather than an operational preference.
   *
   * Defaults to loopback, and that default changed with ADR-0007. It used to inherit BIND_HOST,
   * which on this deployment meant the docker bridge and meant no client anywhere could reach it.
   * The intended deployment now puts the console's TLS ingress in front (`wss://<console>/dp/<host>`
   * proxied to this port), so loopback is correct AND safe when the proxy runs on this box; set
   * DATA_PLANE_BIND_HOST to the VPC address when the proxy is on a different one, as it is here.
   *
   * It is never a reason to skip the token check: the grant is verified offline on every connection
   * whatever route the packets took (ADR-0005).
   */
  const dataPlaneHost = process.env.DATA_PLANE_BIND_HOST?.trim()
    || process.env.BIND_HOST?.trim()
    || '127.0.0.1';
  const port = await dp.listen(Number(process.env.DATA_PLANE_PORT ?? 8080), dataPlaneHost);
  console.log(`[agent] data plane listening on ${dataPlaneHost}:${port}`);

  /**
   * The SECOND route to the same data plane, and on a host behind NAT the only one.
   *
   * The listener above needs the control plane to be able to dial this box. That holds for a device
   * host on a VPC with a route written into the ingress, and holds for nothing else — a laptop with
   * a phone on it has no address to write down. So the agent also dials OUT and holds a socket
   * open, and the control plane multiplexes viewers onto it.
   *
   * Both are live at once on purpose. The listener keeps working for the existing deployment
   * exactly as it did, so this ships without a flag day; a host that cannot be reached simply never
   * has anyone arrive on it.
   *
   * Set MFARM_TUNNEL=0 to leave it off — for a host where the inbound path is known-good and an
   * extra long-lived connection is not wanted.
   */
  const tunnel = !tunnelEnabled() ? undefined : new AgentTunnel({
    controlPlaneUrl: env('CONTROL_PLANE_URL', 'http://localhost:3000'),
    agent,
    dataPlane: dp,
    // Only when automation is actually advertised over the tunnel (ADR-0011). A host that published
    // a directly-dialable gateway must refuse a tunnelled automation channel rather than serve one:
    // accepting both would mean a route its operator did not advertise still works.
    // The BOUND address, not a hardcoded loopback: an operator who pointed AUTOMATION_BIND_HOST
    // somewhere else has moved the only listener this is allowed to reach, and connecting to
    // 127.0.0.1 anyway would fail every command with a message about a gateway that is running.
    automationTarget: gateway && automationIsTunnelled()
      ? { host: gatewayBindHost ?? '127.0.0.1', port: gatewayPort }
      : undefined,
    log: (msg, meta) => console.log(`[agent] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`),
  });
  tunnel?.start();

  agent.startHeartbeat();
  agent.startMetering();
  // Nothing polled device health before this (spec §18): every backend implemented `health()` and
  // no caller ever asked. A phone that falls off the USB mid-suite is now an incident with a reason,
  // instead of a WebDriver error the suite records as its own test failing.
  agent.startHealthMonitor();

  let shuttingDown = false;
  /** The USB watch, when this host has phones. Stopped first on drain. */
  let discoveryWatch: { stop: () => void } | undefined;
  const shutdown = async (signal: string, exitCode = 0, relaunch = false) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // First, so a discovery tick landing mid-drain cannot call shutdown again or log an arrival
    // nobody can act on.
    discoveryWatch?.stop();
    console.log(`[agent] ${signal} — draining`);
    // Early, and not with the other listeners below: an open tab showing "ready" while the agent is
    // handing devices back is the one lie this page must not tell. Closing the stream is what the
    // browser renders as "reconnecting", which is true.
    await win?.close();
    // A drain reached from uncaughtException runs on a process whose invariants are already broken,
    // so any step here may hang or throw. Without this deadline the `shuttingDown` guard turns a
    // failed drain into a process that never exits and never releases its devices.
    const hard = setTimeout(() => {
      console.error(`[agent] drain exceeded ${DRAIN_TIMEOUT_MS}ms — exiting anyway`);
      process.exit(exitCode || 1);
    }, DRAIN_TIMEOUT_MS);
    hard.unref?.();
    try {
      // Order matters: flush metering before killing devices, or the final seconds of every live
      // session are given away free.
      await agent.shutdown();
      // Before the data plane, so viewers are told the host is going rather than discovering it
      // when their frames stop.
      tunnel?.stop();
      await dp.close();
      // The gateway goes before Appium: it is the only route to Appium from off-host, so closing it
      // first means no command can arrive for a device whose driver is already being torn down.
      await gateway?.close();
      // Appium goes before the devices. It holds adb connections and an on-device helper app, and
      // pulling the device out from under a live driver leaves adb wedged and the helper installed —
      // which the next boot then inherits.
      for (const s of supervisors) await s.stop();
      // Put back anything we changed ON somebody's phone before we let go of it. Before `stop()`,
      // because that is what closes the held adb shell this needs. A failure here is logged rather
      // than thrown: it must never be the reason a drain gives up and leaves devices allocated.
      for (const b of backends) {
        const dev = b.control as Partial<PhysicalDevice>;
        if (typeof dev.restoreInstallVerification !== 'function') continue;
        try {
          await dev.restoreInstallVerification();
        } catch (e) {
          console.warn(`[agent] could not restore the install-verification setting on ${b.control.info.localId}: ${(e as Error).message}`);
        }
      }
      for (const b of backends) await b.control.stop();
    } catch (e) {
      console.error('[agent] drain failed:', (e as Error).message);
      process.exit(exitCode || 1);
    }
    clearTimeout(hard);
    /**
     * COME BACK, when a person is watching and nothing else will bring the agent back.
     *
     * A phone arriving drains and exits — see the hot-plug block below for why the device set
     * cannot be changed in place. Under systemd that is invisible: `Restart=always` has a new agent
     * up before anybody notices. Run from a terminal there is no supervisor at all, so the observed
     * behaviour is that PLUGGING IN A PHONE KILLS THE AGENT, which is close to the opposite of the
     * product. The window makes it worse rather than better: the row appears and then the page goes
     * dark, which reads as the phone having broken something.
     *
     * `isTTY` is the same signal used to decide whether to open a browser, and it means the same
     * thing here: somebody launched this by hand, so there is nobody else to restart it. Under a
     * service manager it is false and this never runs — two supervisors racing to own one agent is
     * a worse failure than the one being fixed.
     *
     * ONLY ON A CLEAN DRAIN FOR A KNOWN-GOOD REASON. A crash loop must stay a crash loop and be
     * seen; this exists for the one case where exiting is a mechanism rather than a fault.
     */
    if (relaunch && exitCode === 0 && flagUnless('MFARM_RELAUNCH') && process.stdout.isTTY) {
      const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        detached: true, stdio: 'inherit', env: process.env, cwd: process.cwd(),
      });
      child.unref();
      console.log(
        `[agent] restarted as pid ${child.pid} with the device set that just changed. `
        + 'It survives Ctrl-C — `kill ' + String(child.pid) + '` to stop it. '
        + 'MFARM_RELAUNCH=0 to exit instead.',
      );
    }
    process.exit(exitCode);
  };

  // Registration is done, so if this host claimed `webdriver` it is now in the scheduler's pool for
  // WebDriver work.
  //
  // THERE IS NO IN-PLACE WITHDRAWAL. `POST /workers/heartbeat` updates `last_heartbeat_at` and
  // reads nothing from its body, and the only endpoint that writes `hosts.capabilities` is
  // `POST /workers/register`. Re-registering was considered and rejected: that statement is an
  // UPSERT that also forces `state = 'UP'` and clears `quarantined_at`/`quarantine_reason`, so an
  // agent that re-registered whenever Appium flapped would repeatedly un-quarantine a host the
  // control plane had deliberately taken out of service. It also mints a fresh worker token on
  // every call and requires keeping WORKER_REGISTRATION_TOKEN — a fleet-wide credential — hot for
  // the life of the process. Withdrawal is not worth silently defeating quarantine.
  //
  // TWO OF THOSE THREE REASONS ARE NOW GONE, and this note is kept rather than deleted because the
  // conclusion still holds for a different one. Registration now respects an operator quarantine —
  // only `clear_silence_quarantine` lifts one, from the heartbeat or from registration — and a host
  // may re-register with its OWN worker token, so the fleet secret no longer has to stay hot. What
  // remains is that the device set and capabilities travel only on registration, which is the
  // protocol gap ADR-0003 named and did not close. In-place withdrawal belongs on the heartbeat,
  // not here.
  //
  // So withdrawal is: drain and exit non-zero. The process supervisor restarts the agent, and it
  // re-registers truthfully on the way in because resolveAutomationEndpoints runs again against an
  // Appium that is still down. Crude, but it is a real withdrawal rather than a promise, and it is
  // the same mechanism the permanent-failure path already used.
  const withdrawTimers = new Map<string, NodeJS.Timeout>();
  const supervisorFor = new Map(supervisors.map((s) => [s.localId, s]));
  /** The devices that registered WITH an endpoint — the only ones with anything to withdraw. */
  const advertisedWebdriver = new Set(Object.keys(automationEndpoints));

  onHealth = (localId: string, healthy: boolean): void => {
    const sup = supervisorFor.get(localId);
    if (!sup) return;
    // Keeps registration and the heartbeat payload honest even while the wire cannot carry the
    // change yet: if anything re-registers this agent, it will not re-assert a dead capability.
    // The url is the GATEWAY's path for this device, not Appium's own address — the gateway is what
    // the control plane was told about, and it keeps listening either way.
    agent.setAutomationEndpoint(
      localId,
      healthy ? gatewayBase(gatewayPort, localId) : undefined,
    );

    // This device registered without `webdriver` because its Appium was not ready in time. There is
    // nothing to withdraw, and bouncing the agent over a capability it never claimed would be pure
    // downtime — but the recovery is also not picked up, because only registration writes
    // capabilities. Say so once, rather than leaving idle WebDriver capacity to be discovered.
    if (!advertisedWebdriver.has(localId)) {
      if (healthy) {
        console.warn(
          `[agent] Appium for ${localId} is ready, but this device registered without ` +
          '`webdriver` and capabilities are only sent at registration — restart the agent to ' +
          'start taking WebDriver sessions on it.',
        );
      }
      return;
    }

    if (healthy) {
      const t = withdrawTimers.get(localId);
      if (t) {
        clearTimeout(t);
        withdrawTimers.delete(localId);
        console.log(`[agent] Appium for ${localId} is ready again within the grace window — staying up`);
      }
      return;
    }

    console.warn(
      `[agent] Appium for ${localId} is no longer ready (state: ${sup.state}) while that device ` +
      'advertises `webdriver`. WebDriver sessions allocated to it will fail at the proxy hop. ' +
      `Withdrawing by draining in ${UNHEALTHY_GRACE_MS}ms unless it recovers first.`,
    );
    /**
     * §18. This is the moment a test is about to fail for a reason that is not the test's fault.
     *
     * Reported HERE rather than when the WebDriver call fails, because by then the only thing left
     * is a proxy error the suite will faithfully record as its own failure. The agent is the only
     * party that knows Appium went away, and this is the only place it knows it.
     */
    agent.reportIncident(localId, 'appium-failure', `Appium became unready (state: ${sup.state})`);
    // Still a whole-agent drain, for the reason in the block comment above: capabilities are written
    // at registration only, so one device's `webdriver` cannot be withdrawn without re-registering
    // the host. Per-device endpoints make the RE-registration honest — the agent returns advertising
    // only the devices whose Appium is actually up — but they do not make withdrawal in-place
    // possible. That needs the heartbeat to carry capabilities.
    if (!withdrawTimers.has(localId)) {
      const timer = setTimeout(() => {
        console.error(
          `[agent] Appium for ${localId} has been unready for ${UNHEALTHY_GRACE_MS}ms — draining to ` +
          'withdraw `webdriver`. The agent re-registers without it while that Appium stays down.',
        );
        void shutdown('appium-unhealthy', 1);
      }, UNHEALTHY_GRACE_MS);
      timer.unref?.();
      withdrawTimers.set(localId, timer);
    }
  };

  onGiveUp = (localId: string, reason: string): void => {
    console.error(`[agent] Appium for ${localId} is permanently unhealthy: ${reason}`);
    agent.reportIncident(localId, 'appium-failure', `permanently unhealthy: ${reason}`);
    // Flushed before the drain below can exit the process, or the incident explaining WHY this host
    // went away dies with it — which is precisely the case somebody will be trying to reconstruct.
    void agent.flush();
    if (!advertisedWebdriver.has(localId)) return; // never advertised it; already honest
    console.error(`[agent] ${localId} registered \`webdriver\` and can no longer serve it — draining`);
    void shutdown('appium-permanent-failure', 1);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  /**
   * USB hot-plug (spec §6) — plug a phone in and it joins the farm without anyone typing anything.
   *
   * ARRIVAL AND DEPARTURE ARE NOT SYMMETRIC, and that asymmetry is the design rather than a gap:
   *
   *   A DEVICE THAT LEAVES needs nothing from here. The health monitor above already probes it,
   *   sees the adb calls fail, files a `device-disconnected` incident and reports it offline — and
   *   the control plane stops scheduling it. Restarting the agent because a phone was unplugged
   *   would take down every OTHER device on the host to react to one that is already handled.
   *
   *   A DEVICE THAT ARRIVES cannot be added in place. `hosts.capabilities` and the device list are
   *   written by `POST /workers/register` and by nothing else — the heartbeat has no field for
   *   them — so a new phone becomes visible only by registering again. That is precisely what
   *   draining and exiting does: the unit's `Restart=always` brings the agent straight back, it
   *   discovers both phones, and registration tells the truth about both. It is the same mechanism
   *   ADR-0003 already uses to withdraw `webdriver`, for the same reason.
   *
   * THE DRAIN IS WHAT MAKES THIS SAFE. `shutdown` waits for live sessions to end before exiting, so
   * plugging in a second phone does not interrupt a suite running on the first.
   *
   * A phone sitting at `unauthorized` counts as an arrival the moment somebody taps Allow — which
   * is the most common way a device becomes usable, and would be missed by watching plug events.
   */
  if (flag('PHYSICAL_ENABLED')) {
    const knownSerials = backends
      .map((b) => b.control.info.adbSerial)
      .filter((x): x is string => typeof x === 'string');

    discoveryWatch = watchForChanges(knownSerials, (added, removed) => {
      // Logged, never acted on — see the block comment. The health monitor owns departures.
      if (removed.length > 0) {
        console.warn(
          `[agent] no longer on USB: ${removed.join(', ')}. Health checks will report them offline; `
          + 'the agent stays up for the devices it still has.',
        );
      }
      if (added.length === 0) return;
      console.log(
        `[agent] new device(s) on USB: ${added.join(', ')}. Draining to re-register — live sessions `
        + 'finish first, then the agent restarts with them.',
      );
      // The one drain that is a mechanism rather than a fault, and so the one that comes back.
      void shutdown('usb-device-added', 0, true);
    }, undefined, undefined, (found) => {
      // Every pass, changed or not. This is what makes the window live: a phone moving from
      // `unauthorized` to `device` because somebody tapped Allow is not an arrival by the
      // definition above — the usable set only changes on the tick after — but it is exactly the
      // moment the person watching wants their row to update.
      lastDiscovery = found;
      win?.push();
    });

    // The first pass is ten seconds away, and a window that opens empty on a machine with a phone
    // already plugged into it reads as broken. One extra `adb devices` at start-up buys the row
    // being there when the browser is.
    void discover().then((found) => { lastDiscovery = found; win?.push(); }).catch(() => { /* the poll will retry */ });
  }


  // Without these the agent died on any unexpected throw WITHOUT draining, and Appium — a detached
  // process group — outlived it holding the device's adb connection and the port. Because
  // derivePort is stable by design, the replacement agent then asks for exactly that port, fails to
  // bind on every attempt and burns its whole restart budget. Both ends are handled: drain on the
  // way out here, reclaim the port on the way in (AppiumSupervisor.reclaimPort).
  const die = (kind: string) => (err: unknown): void => {
    console.error(`[agent] ${kind}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    void shutdown(kind, 1);
  };
  process.on('uncaughtException', die('uncaughtException'));
  process.on('unhandledRejection', die('unhandledRejection'));

  // Nothing async can run in an 'exit' handler, so this is the synchronous backstop for every
  // remaining path out — including a process.exit() from code that never heard of the supervisor.
  process.on('exit', () => { for (const s of supervisors) s.killSync(); });
}

main().catch((e: Error) => {
  console.error('[agent] fatal:', e.message);
  process.exit(1);
});
