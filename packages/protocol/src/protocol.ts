/**
 * Worker protocol — versioned, capability-negotiated.
 *
 * v2 decision 7. Workers live on physical machines you cannot redeploy in lockstep with the control
 * plane, so from the second host onward you are permanently running mixed versions. The protocol
 * therefore versions explicitly and supports N-1 forever.
 *
 * v2 decision 4. Devices DECLARE capabilities rather than implementing one fat uniform interface.
 * A device that cannot record video says so; the platform degrades gracefully instead of every
 * adapter growing a `throw new NotSupported()`.
 */

/**
 * v2 (2026-08-17) — ADR-0004 / ADR-0003 B2. Two additions, both backward compatible:
 *
 *   1. `devices[].automationEndpoint`, so a host with more than one device can advertise a
 *      DIFFERENT automation address per device. v1 carried exactly one host-level string, which is
 *      why `index.ts` refused to run Appium at all on a multi-device host: two servers, one
 *      advertised address, and every device claiming `webdriver` regardless.
 *   2. `deviceIds` on the registration RESPONSE, mapping local id -> control-plane uuid. The worker
 *      previously had no way to learn its own devices' uuids and inferred them from whatever
 *      session token happened to arrive (`resolveDeviceIds` returned `{}`). The automation gateway
 *      cannot do that: it has to decide, BEFORE proxying, whether a grant naming device uuid X may
 *      drive the device at path `/automation/cf-2`. Guessing is not available to it.
 */
export const PROTOCOL_VERSION = 2;
/** Oldest version the control plane still accepts. Bump only when N-1 is genuinely retired. */
export const MIN_SUPPORTED_VERSION = 1;

export const CAPABILITIES = [
  'screen-stream',       // can produce a live media stream
  'input-datachannel',   // input over a persistent channel — NOT per-event adb shell (v2 lever L3)
  'snapshot-reset',      // reset by snapshot restore (v2 decision 5); without it the device
                         // cannot be offered to a second tenant
  'app-install',
  'recording',
  'logcat',
  'network-capture',     // per-session proxy: isolation + record/replay + waterfall (v2 decision 9)
  'gpu',                 // hardware rendering available; absent means software rendering only
  'webdriver',           // an automation (Appium) server fronts this device, so it can serve the
                         // WebDriver hub (v2 decision 10). Not required for interactive use.
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Capabilities without which a device must never be scheduled for a tenant session. */
export const REQUIRED_FOR_TENANT_USE: Capability[] = ['snapshot-reset', 'input-datachannel'];

export interface WorkerRegistration {
  protocolVersion: number;
  hostId?: string;
  hostname: string;
  region: string;
  /** Public data-plane address the browser connects to directly. Without it the host cannot take
   *  sessions at all, because there is nowhere to point the client (v2 decision 2). */
  endpoint?: string;
  /**
   * HOST-LEVEL automation base url. **Legacy since v2** — prefer `devices[].automationEndpoint`.
   *
   * Retained because N-1 workers still send it and because a v1 control plane reads nothing else.
   * A v2 worker sends it only when exactly ONE of its devices has an endpoint, so an older control
   * plane sees precisely what it saw before and a multi-device host degrades to "no webdriver"
   * rather than advertising one server for two devices.
   */
  automationEndpoint?: string;
  cores: number;
  memoryMb: number;
  capabilities: Capability[];
  devices: Array<{
    localId: string;
    platform: 'android' | 'ios';
    tier: 'cuttlefish' | 'avd' | 'container' | 'simulator' | 'physical';
    model: string;
    osVersion: string;
    capabilities: Capability[];
    /**
     * v2. Base url the hub should dial for THIS device — the worker's automation gateway
     * (`https://<host>:<port>/automation/<localId>`), not Appium itself. Appium stays on loopback;
     * see ADR-0004.
     *
     * The hub appends `/session` exactly as before, so this is a change of what the url points at,
     * not of how the hub uses it.
     */
    automationEndpoint?: string;
    /**
     * v2. The serial the driver matches on — `0.0.0.0:6520`, `emulator-5560`, a hardware serial.
     *
     * NOT `localId`. The hub sends this as `appium:udid`; sending the local id instead was blocker
     * B3, and it fails on any real driver because UiAutomator2 has never heard of `cf-1`.
     */
    adbSerial?: string;
    /**
     * v2. Port reserved on THIS host for the driver's device-side helper (`appium:systemPort`).
     *
     * UiAutomator2 defaults every session to 8200, so two concurrent sessions on one host fight over
     * it and the second fails to start. Harmless while a host could only ever run one WebDriver
     * device; a live defect now that per-device endpoints make two the point.
     *
     * The WORKER supplies it because the worker owns its own port space — the same reason it, and
     * not the control plane, derives the Appium port.
     */
    systemPort?: number;
    /** v2. Same defect, same fix, different default: UiAutomator2's MJPEG server sits on 7810. */
    mjpegServerPort?: number;
  }>;
}

/** What `POST /v1/workers/register` answers. */
export interface RegistrationResponse {
  hostId: string;
  protocolVersion: number;
  degradedCapabilities: string[];
  schedulableDevices: string[];
  workerToken: string;
  sessionPublicKey: string;
  /**
   * v2. localId -> control-plane device uuid, for every device in the registration.
   *
   * The gateway authorizes on `claims.did`, which is a uuid, against a path segment, which is a
   * local id. Without this map that comparison cannot be made and the only safe answer is to refuse
   * every request.
   */
  deviceIds?: Record<string, string>;
}

/**
 * The automation base url for one device, honouring the v1 fallback.
 *
 * Single reader for the precedence so the control plane and the worker cannot disagree about it:
 * a device-level endpoint wins, and the host-level string is what a v1 worker meant.
 */
export function deviceAutomationEndpoint(
  reg: Pick<WorkerRegistration, 'automationEndpoint'>,
  device: { automationEndpoint?: string },
): string | undefined {
  return device.automationEndpoint ?? reg.automationEndpoint ?? undefined;
}

/**
 * Path the automation gateway serves for a device, and the hub's advertised suffix.
 *
 * Shared so the two halves cannot drift: the worker parses what this builds. `localId` is encoded
 * because it comes from operator configuration and reaches a url — nothing else validates it.
 */
export const AUTOMATION_PREFIX = '/automation';

export function automationPath(localId: string): string {
  return `${AUTOMATION_PREFIX}/${encodeURIComponent(localId)}`;
}

/**
 * Inverse of `automationPath`, for the gateway's request handler.
 *
 * Returns the device's local id and the REMAINDER of the path, which is proxied verbatim. A request
 * for exactly `/automation/cf-1` has a remainder of `''`, not `'/'` — Appium distinguishes them.
 */
export function parseAutomationPath(
  pathname: string,
): { localId: string; rest: string } | undefined {
  if (!pathname.startsWith(`${AUTOMATION_PREFIX}/`)) return undefined;
  const tail = pathname.slice(AUTOMATION_PREFIX.length + 1);
  if (tail === '') return undefined;
  const slash = tail.indexOf('/');
  const rawId = slash === -1 ? tail : tail.slice(0, slash);
  const rest = slash === -1 ? '' : tail.slice(slash);
  if (rawId === '') return undefined;
  let localId: string;
  try {
    localId = decodeURIComponent(rawId);
  } catch {
    return undefined; // malformed percent-encoding is a bad request, never a lookup
  }
  return { localId, rest };
}

export type NegotiationResult =
  | { ok: true; version: number; degraded: Capability[]; schedulable: string[] }
  | { ok: false; reason: string };

/**
 * Decide whether to accept a worker, at which protocol version, and which of its devices may
 * actually take tenant traffic.
 *
 * Deliberately strict about REQUIRED_FOR_TENANT_USE: a device that cannot snapshot-reset is not a
 * cheap device, it is a device that leaks the previous tenant's state. It registers fine — you want
 * it visible and monitorable — but it is not schedulable.
 */
export function negotiate(reg: WorkerRegistration): NegotiationResult {
  if (!Number.isInteger(reg.protocolVersion)) {
    return { ok: false, reason: 'protocolVersion must be an integer' };
  }
  // A registration is JSON from a machine we do not control, so the arrays may simply not be there.
  // Reading through a missing one throws, and a TypeError inside negotiation surfaces to the worker
  // as a 500 — "the control plane is broken" — for what is a malformed request it could fix itself.
  if (!Array.isArray(reg.capabilities)) {
    return { ok: false, reason: 'capabilities must be an array' };
  }
  if (!Array.isArray(reg.devices)) {
    return { ok: false, reason: 'devices must be an array' };
  }
  const badDevice = reg.devices.find((d) => !d || !Array.isArray(d.capabilities));
  if (badDevice) {
    return { ok: false, reason: `device ${badDevice?.localId ?? '<unnamed>'} must declare a capabilities array` };
  }
  if (reg.protocolVersion < MIN_SUPPORTED_VERSION) {
    return {
      ok: false,
      reason: `protocol v${reg.protocolVersion} is retired; minimum is v${MIN_SUPPORTED_VERSION}`,
    };
  }

  // A newer worker than the control plane is normal during a rollout: workers upgrade first because
  // they are the thing that is hard to redeploy. Speak our version and let it downgrade.
  const version = Math.min(reg.protocolVersion, PROTOCOL_VERSION);

  const known = new Set<string>(CAPABILITIES);
  // Unknown capabilities from a newer worker are ignored, not rejected — that is what makes rolling
  // a new capability out worker-first safe.
  const degraded = CAPABILITIES.filter((c) => !reg.capabilities.includes(c));
  const unknown = reg.capabilities.filter((c) => !known.has(c));

  const schedulable = reg.devices
    .filter((d) => REQUIRED_FOR_TENANT_USE.every((c) => d.capabilities.includes(c)))
    .map((d) => d.localId);

  if (unknown.length > 0) {
    // observable, not fatal
    console.warn(`worker ${reg.hostname} advertises unknown capabilities: ${unknown.join(', ')}`);
  }

  return { ok: true, version, degraded, schedulable };
}

/** Every worker-bound command carries the fence. The worker rejects anything below its high-water mark. */
export interface FencedCommand<T = unknown> {
  sessionId: string;
  deviceId: string;
  fence: number;
  seq: number;
  op: string;
  payload: T;
}

/**
 * Worker-side fence check. Rejects commands from a client that was partitioned and is now acting on
 * a stale allocation — the failure this prevents is a disconnected tenant still driving a device
 * that has since been reset and handed to someone else.
 */
export function acceptFence(highWater: number, incoming: number): boolean {
  return incoming >= highWater;
}
