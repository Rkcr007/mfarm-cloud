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

export const PROTOCOL_VERSION = 1;
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
  /** Base URL of this host's automation (Appium) server, e.g. `http://10.0.3.14:4723`. Reached by
   *  the control plane over the internal network only — the WebDriver hub is the sole public ingress
   *  to it, because an exposed Appium port is unauthenticated device control. */
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
  }>;
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
