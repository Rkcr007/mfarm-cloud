import { cpus, hostname as osHostname, totalmem } from 'node:os';
import { join } from 'node:path';
import { automationPath } from '@mfarm/protocol';
import { Agent } from './agent.ts';
import { AppiumSupervisor, derivePort } from './appium.ts';
import { AutomationGateway } from './gateway.ts';
import { DataPlane } from './dataplane.ts';
import { createCuttlefishBackend, CuttlefishDevice } from './devices/cuttlefish.ts';
import { createAvdBackend } from './devices/avd.ts';
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

async function chooseBackends(): Promise<DeviceBackend[]> {
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
    return Array.from({ length: count }, (_, i) =>
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
    );
  }

  console.warn(`[agent] Cuttlefish unavailable: ${avail.reason}`);
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
 * The externally-reachable base url of this host's automation gateway.
 *
 * `AUTOMATION_ADVERTISE_BASE` wins outright and is what a TLS deployment sets
 * (`https://worker-1.example:8443`) — the worker already terminates TLS for the data plane, and
 * ADR-0004 point 3 puts automation on that same public listener rather than inventing a second
 * exposure class. Otherwise it is composed from `APPIUM_ADVERTISE_HOST`, which keeps exactly the
 * meaning ADR-0004 gives it: the externally-reachable name for the worker.
 */
function gatewayBase(port: number): string {
  const explicit = process.env.AUTOMATION_ADVERTISE_BASE;
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = process.env.APPIUM_ADVERTISE_HOST ?? process.env.PUBLIC_HOST;
  if (!host) {
    throw new Error(
      'APPIUM_ENABLED needs somewhere to advertise the automation gateway. Set ' +
      'AUTOMATION_ADVERTISE_BASE to its full public base url, or APPIUM_ADVERTISE_HOST/PUBLIC_HOST ' +
      'to this host\'s externally-reachable name. Advertising 127.0.0.1 would register an endpoint ' +
      'only this machine can reach.',
    );
  }
  return `http://${host}:${port}`;
}

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
  base: string,
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
      endpoints[sup.localId] = `${base}${automationPath(sup.localId)}`;
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
  const automationEndpoints = supervisors.length > 0
    ? await resolveAutomationEndpoints(supervisors, gatewayBase(gatewayPort))
    : {};

  const agent = new Agent({
    controlPlaneUrl: env('CONTROL_PLANE_URL', 'http://localhost:3000'),
    registrationToken: env('WORKER_REGISTRATION_TOKEN'),
    hostname: env('WORKER_HOSTNAME', osHostname()),
    region: env('REGION'),
    endpoint: env('PUBLIC_ENDPOINT'),
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
    const bindHost = process.env.AUTOMATION_BIND_HOST?.trim() || process.env.BIND_HOST?.trim() || undefined;
    await gateway.listen(gatewayPort, bindHost);
    console.log(`[agent] automation gateway listening on ${bindHost ?? '0.0.0.0'}:${gatewayPort}`);
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

  agent.startHeartbeat();
  agent.startMetering();

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agent] ${signal} — draining`);
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
      await dp.close();
      // The gateway goes before Appium: it is the only route to Appium from off-host, so closing it
      // first means no command can arrive for a device whose driver is already being torn down.
      await gateway?.close();
      // Appium goes before the devices. It holds adb connections and an on-device helper app, and
      // pulling the device out from under a live driver leaves adb wedged and the helper installed —
      // which the next boot then inherits.
      for (const s of supervisors) await s.stop();
      for (const b of backends) await b.control.stop();
    } catch (e) {
      console.error('[agent] drain failed:', (e as Error).message);
      process.exit(exitCode || 1);
    }
    clearTimeout(hard);
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
      healthy ? `${gatewayBase(gatewayPort)}${automationPath(localId)}` : undefined,
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
    if (!advertisedWebdriver.has(localId)) return; // never advertised it; already honest
    console.error(`[agent] ${localId} registered \`webdriver\` and can no longer serve it — draining`);
    void shutdown('appium-permanent-failure', 1);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

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
