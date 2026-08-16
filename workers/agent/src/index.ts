import { cpus, hostname as osHostname, totalmem } from 'node:os';
import { Agent } from './agent.ts';
import { AppiumSupervisor, derivePort } from './appium.ts';
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
    console.log(`[agent] Cuttlefish available — starting ${count} instance(s)`);
    return Array.from({ length: count }, (_, i) =>
      createCuttlefishBackend({
        localId: `cf-${i + 1}`,
        instanceNum: i + 1,
        imageDir: env('CF_IMAGE_DIR'),
        publicHost: process.env.PUBLIC_HOST,
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
 * Refuses to run with more than one device, and the reason is a protocol limit rather than a
 * limitation of the supervisor: `WorkerRegistration` carries exactly ONE host-level
 * `automationEndpoint` (packages/protocol/src/protocol.ts), and agent.ts stamps `webdriver` onto
 * every device once it is set. With two devices that means two Appium servers, one advertised
 * address, and a second device claiming a capability whose server the hub can never reach — sessions
 * allocated to it fail every time. Better to serve no WebDriver traffic than to lie about half of it.
 * `AUTOMATION_ENDPOINT` remains the way to front several devices with one operator-managed server.
 */
function createSupervisors(
  backends: DeviceBackend[],
  onPermanentFailure: (reason: string) => void,
  onHealthChange: (healthy: boolean) => void,
): AppiumSupervisor[] {
  if (!flag('APPIUM_ENABLED')) return [];

  if (backends.length > 1) {
    console.error(
      `[agent] APPIUM_ENABLED with ${backends.length} devices, but registration carries only one ` +
      'automationEndpoint for the whole host — the hub could reach at most one of the servers while ' +
      'every device advertised `webdriver`. Not starting Appium. Run one WebDriver device per host, ' +
      'or set AUTOMATION_ENDPOINT to a single externally-managed Appium that fronts all of them.',
    );
    return [];
  }

  const basePort = Number(process.env.APPIUM_BASE_PORT ?? 4723);
  // Exactly one, always — the refusal above guarantees `backends.length === 1` here. A loop
  // checking these supervisors for derived-port collisions used to sit below; it could never see a
  // second entry to collide with, so it was a dead defence that read as a live one, and it is gone.
  // When B2 is fixed and a host can advertise per-device endpoints, that check has to come back
  // together with the multi-supervisor support — see the note on derivePort in appium.ts.
  return backends.map((b) => new AppiumSupervisor({
    localId: b.control.info.localId,
    port: derivePort(b.control.info.localId, basePort),
    command: process.env.APPIUM_PATH,
    // The bind address is always loopback; this only changes what the control plane is told, for
    // hosts where a private tunnel terminates on this machine and forwards to it.
    advertiseHost: process.env.APPIUM_ADVERTISE_HOST,
    // Appium does NOT inherit this process's environment — it would otherwise receive
    // WORKER_REGISTRATION_TOKEN. Anything a particular driver genuinely needs is named here.
    envPassthrough: (process.env.APPIUM_ENV_PASSTHROUGH ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    onPermanentFailure,
    onHealthChange,
  }));
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
 * The address to register, or undefined to register without `webdriver`.
 *
 * Waits for a genuine `/status` answer before returning anything. An endpoint advertised on hope is
 * worse than no endpoint at all: the control plane demands the `webdriver` capability when it
 * allocates for the hub, so a host that claims it and cannot serve it does not degrade — it absorbs
 * sessions and fails them.
 */
async function resolveAutomationEndpoint(supervisors: AppiumSupervisor[]): Promise<string | undefined> {
  const manual = process.env.AUTOMATION_ENDPOINT;
  // Escape hatch, unchanged: an externally-managed Appium (a systemd unit, a sidecar, one server
  // fronting several devices) is still a legitimate deployment and is not second-guessed here.
  if (supervisors.length === 0) return manual;

  if (manual) {
    console.warn('[agent] AUTOMATION_ENDPOINT is ignored while APPIUM_ENABLED is set — the supervised server wins');
  }

  const sup = supervisors[0]!;
  if (await sup.start()) {
    console.log(`[agent] Appium ready for ${sup.localId} at ${sup.endpoint}`);
    return sup.endpoint;
  }

  console.error(
    `[agent] Appium did not become ready (state: ${sup.state}) — registering WITHOUT the webdriver ` +
    'capability rather than advertising a server that is not answering. The supervisor keeps ' +
    'retrying; restart the agent once it is up to start taking WebDriver sessions.',
  );
  return undefined;
}

async function main(): Promise<void> {
  const backends = await chooseBackends();

  // Devices come up before registration so the control plane never sees a host advertising
  // capacity it cannot actually serve.
  for (const b of backends) await b.control.start();

  // Rebound once shutdown() exists below. Until then a give-up can only be reported, because there
  // is nothing registered yet to drain.
  let onGiveUp = (reason: string): void => {
    console.error(`[agent] Appium gave up before registration completed: ${reason}`);
  };
  // Health flips before registration are uninteresting: resolveAutomationEndpoint is waiting on the
  // first one anyway, and nothing has been advertised yet that could need withdrawing.
  let onHealth = (_healthy: boolean): void => {};
  const supervisors = createSupervisors(backends, (r) => onGiveUp(r), (h) => onHealth(h));
  const automationEndpoint = await resolveAutomationEndpoint(supervisors);

  const agent = new Agent({
    controlPlaneUrl: env('CONTROL_PLANE_URL', 'http://localhost:3000'),
    registrationToken: env('WORKER_REGISTRATION_TOKEN'),
    hostname: env('WORKER_HOSTNAME', osHostname()),
    region: env('REGION'),
    endpoint: env('PUBLIC_ENDPOINT'),
    // Derived from a server this agent started and proved is answering, or from AUTOMATION_ENDPOINT
    // when Appium is managed outside. Either way it must NOT be publicly routable — an open Appium
    // port is unauthenticated device control, and the hub is the only thing that knows about tenants.
    automationEndpoint,
    devices: backends,
    cores: cpus().length,
    memoryMb: Math.round(totalmem() / 1_048_576),
  });

  const state = await agent.start();
  console.log(`[agent] registered as host ${state.hostId}`);

  const byUuid = new Map<string, DeviceBackend>();
  const dp = new DataPlane({
    agent,
    backends: new Map(backends.map((b) => [b.control.info.localId, b])),
    // A session token names a control-plane uuid; this host knows only local ids. The token is
    // signed, so its `did` claim is trustworthy and teaches the mapping on first use. With a single
    // device the mapping is unambiguous anyway.
    resolveDevice: (uuid) => byUuid.get(uuid) ?? (backends.length === 1 ? backends[0] : undefined),
  });

  const port = await dp.listen(Number(process.env.DATA_PLANE_PORT ?? 8080));
  console.log(`[agent] data plane listening on :${port}`);

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
  // re-registers truthfully on the way in because resolveAutomationEndpoint runs again against an
  // Appium that is still down. Crude, but it is a real withdrawal rather than a promise, and it is
  // the same mechanism the permanent-failure path already used.
  let withdrawTimer: NodeJS.Timeout | undefined;
  const advertisedWebdriver = automationEndpoint !== undefined && supervisors.length > 0;

  onHealth = (healthy: boolean): void => {
    const sup = supervisors[0];
    if (!sup) return;
    // Keeps registration and the heartbeat payload honest even while the wire cannot carry the
    // change yet: if anything re-registers this agent, it will not re-assert a dead capability.
    agent.setAutomationEndpoint(healthy ? sup.endpoint : undefined);

    // The host registered without `webdriver` because Appium was not ready in time. There is
    // nothing to withdraw, and bouncing the agent over a capability it never claimed would be pure
    // downtime — but the recovery is also not picked up, because only registration writes
    // capabilities. Say so once, rather than leaving idle WebDriver capacity to be discovered.
    if (!advertisedWebdriver) {
      if (healthy) {
        console.warn(
          `[agent] Appium is ready at ${sup.endpoint}, but this host registered without ` +
          '`webdriver` and capabilities are only sent at registration — restart the agent to ' +
          'start taking WebDriver sessions.',
        );
      }
      return;
    }

    if (healthy) {
      if (withdrawTimer) {
        clearTimeout(withdrawTimer);
        withdrawTimer = undefined;
        console.log('[agent] Appium is ready again within the grace window — staying up');
      }
      return;
    }

    console.warn(
      `[agent] Appium for ${sup.localId} is no longer ready (state: ${sup.state}) while this host ` +
      `advertises \`webdriver\`. WebDriver sessions allocated here will fail at the proxy hop. ` +
      `Withdrawing by draining in ${UNHEALTHY_GRACE_MS}ms unless it recovers first.`,
    );
    withdrawTimer ??= setTimeout(() => {
      console.error(
        `[agent] Appium has been unready for ${UNHEALTHY_GRACE_MS}ms — draining to withdraw ` +
        '`webdriver`. The agent re-registers without the capability while Appium stays down.',
      );
      void shutdown('appium-unhealthy', 1);
    }, UNHEALTHY_GRACE_MS);
    withdrawTimer.unref?.();
  };

  onGiveUp = (reason: string): void => {
    console.error(`[agent] Appium is permanently unhealthy: ${reason}`);
    if (!advertisedWebdriver) return; // never advertised it; the host is already honest
    console.error('[agent] this host registered `webdriver` and can no longer serve it — draining');
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
