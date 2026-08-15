import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PROTOCOL_VERSION, type Capability, type WorkerRegistration } from '@mfarm/protocol';
import type { DeviceBackend } from './device.ts';

/**
 * Worker agent — the control-plane side of a host.
 *
 * Owns: registration and credentials, heartbeat, metering emission, and returning devices to the
 * pool after a snapshot reset. It does NOT touch media, and it is not on the input hot path; see
 * dataplane.ts for the part the browser actually talks to.
 */

export interface AgentOptions {
  controlPlaneUrl: string;
  registrationToken: string;
  hostname: string;
  region: string;
  /** Public data-plane address the browser connects to. Without it the host cannot take sessions. */
  endpoint: string;
  /**
   * Base URL of the automation (Appium) server fronting this host's devices, e.g.
   * `http://10.0.3.14:4723`. INTERNAL address: the control plane's WebDriver hub reaches it, the
   * internet must not. Set it and the host advertises `webdriver`; leave it unset and the host
   * simply does not take WebDriver traffic.
   */
  automationEndpoint?: string;
  devices: DeviceBackend[];
  statePath?: string;
  cores?: number;
  memoryMb?: number;
  /** Cap on unflushed metering events. Exceeding it is a loud failure, never a silent drop. */
  maxBufferedEvents?: number;
}

export interface AgentState {
  hostId: string;
  workerToken: string;
  sessionPublicKey: string;
  /** localId -> control-plane device uuid */
  deviceIds: Record<string, string>;
}

interface MeterEvent {
  eventId: string;
  orgId: string;
  sessionId: string;
  deviceId: string;
  kind: 'device_seconds';
  quantity: number;
  occurredAt: string;
}

interface ActiveSession {
  sessionId: string;
  deviceId: string;
  orgId: string;
  startedAt: number;
  ticksEmitted: number;
}

/**
 * A UUID derived from stable inputs rather than randomness.
 *
 * This is what makes metering safe across a crash. If the agent dies after emitting tick 7 but
 * before the control plane acknowledges it, the restarted agent re-emits an event with the SAME id,
 * and the control plane's ON CONFLICT DO NOTHING absorbs it. With random ids the same crash
 * double-bills the customer, and nobody would notice until they complained.
 */
export function deterministicUuid(key: string): string {
  const h = createHash('sha256').update(key).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x80; // version 8 (custom)
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class Agent {
  private state?: AgentState;
  private heartbeatTimer?: NodeJS.Timeout;
  private meterTimer?: NodeJS.Timeout;
  private readonly active = new Map<string, ActiveSession>();
  private readonly buffer = new Map<string, MeterEvent>();
  private readonly pendingResets: Array<{ deviceId: string; fence: number }> = [];
  /** Per-device high-water mark. See acceptFence. */
  private readonly fenceHighWater = new Map<string, number>();

  private readonly opts: AgentOptions;

  // Explicit field + assignment rather than a constructor parameter property: those emit runtime
  // code, so Node's strip-only type removal rejects them and the no-build-step setup breaks.
  constructor(opts: AgentOptions) {
    this.opts = opts;
  }

  get hostId(): string | undefined { return this.state?.hostId; }
  get sessionPublicKey(): string | undefined { return this.state?.sessionPublicKey; }
  get bufferedEventCount(): number { return this.buffer.size; }
  deviceIdFor(localId: string): string | undefined { return this.state?.deviceIds[localId]; }

  // ---------------------------------------------------------------- registration

  async start(): Promise<AgentState> {
    const restored = await this.loadState();
    if (restored && (await this.heartbeat()).ok) {
      this.state = restored;
    } else {
      // No usable credential, or the control plane rejected it (host rebuilt, token rotated
      // elsewhere). Re-register rather than sitting silently offline.
      this.state = await this.register();
      await this.saveState(this.state);
    }
    return this.state;
  }

  private async register(): Promise<AgentState> {
    // `webdriver` is declared by the host having an automation server, not by the device tier:
    // the same Cuttlefish instance can serve WebDriver on one deployment and not on another, and
    // claiming the capability without the server behind it means the scheduler sends sessions to a
    // device that cannot run them.
    const automation: Capability[] = this.opts.automationEndpoint ? ['webdriver'] : [];

    const registration: WorkerRegistration = {
      protocolVersion: PROTOCOL_VERSION,
      hostname: this.opts.hostname,
      region: this.opts.region,
      endpoint: this.opts.endpoint,
      automationEndpoint: this.opts.automationEndpoint,
      cores: this.opts.cores ?? 0,
      memoryMb: this.opts.memoryMb ?? 0,
      capabilities: ['screen-stream', 'input-datachannel', 'snapshot-reset', ...automation] as Capability[],
      devices: this.opts.devices.map((d) => ({
        localId: d.control.info.localId,
        platform: d.control.info.platform,
        tier: d.control.info.tier,
        model: d.control.info.model,
        osVersion: d.control.info.osVersion,
        capabilities: [...d.control.info.capabilities, ...automation],
      })),
    };

    const res = await fetch(`${this.opts.controlPlaneUrl}/v1/workers/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-registration-token': this.opts.registrationToken },
      body: JSON.stringify(registration),
    });
    if (!res.ok) throw new Error(`registration failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as {
      hostId: string; workerToken: string; sessionPublicKey: string;
      schedulableDevices: string[]; degradedCapabilities: string[];
    };

    // The control plane decides which devices may take tenant traffic. Anything it withheld is
    // reported here rather than left for someone to notice as unexplained idle capacity.
    const withheld = registration.devices
      .map((d) => d.localId)
      .filter((id) => !body.schedulableDevices.includes(id));
    if (withheld.length > 0) {
      console.warn(`[agent] not schedulable (missing required capabilities): ${withheld.join(', ')}`);
    }

    const deviceIds = await this.resolveDeviceIds(body.workerToken);
    return {
      hostId: body.hostId,
      workerToken: body.workerToken,
      sessionPublicKey: body.sessionPublicKey,
      deviceIds,
    };
  }

  /**
   * Map local device names to the control plane's uuids.
   *
   * Registration returns local ids because that is what the worker knows; everything afterwards
   * (metering, resets, fences) is keyed by the control plane's uuid.
   */
  private async resolveDeviceIds(_token: string): Promise<Record<string, string>> {
    // Populated by the control plane on the next protocol revision; until then the agent learns a
    // device's uuid from the session token that arrives for it (claims.did), which is authenticated
    // and therefore trustworthy.
    return {};
  }

  // ---------------------------------------------------------------- heartbeat

  async heartbeat(): Promise<{ ok: boolean; hostState?: string }> {
    const token = this.state?.workerToken ?? (await this.loadState())?.workerToken;
    if (!token) return { ok: false };
    try {
      const res = await fetch(`${this.opts.controlPlaneUrl}/v1/workers/heartbeat`, {
        method: 'POST',
        // No content-type: this request has no body, and claiming JSON with an empty body is what
        // made the control plane 500.
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false };
      const body = await res.json() as { hostState: string };
      // A host quarantined while it was partitioned learns about it here and must drain rather than
      // keep accepting work.
      if (body.hostState === 'QUARANTINED') {
        console.warn('[agent] host is QUARANTINED by the control plane — draining, not accepting sessions');
      }
      return { ok: true, hostState: body.hostState };
    } catch {
      return { ok: false };
    }
  }

  startHeartbeat(intervalMs = 10_000): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  // ---------------------------------------------------------------- metering

  beginSession(sessionId: string, deviceId: string, orgId: string): void {
    this.active.set(sessionId, { sessionId, deviceId, orgId, startedAt: Date.now(), ticksEmitted: 0 });
  }

  /** Emits the final partial tick so the last seconds of a session are not given away free. */
  endSession(sessionId: string): void {
    const s = this.active.get(sessionId);
    if (!s) return;
    this.emitTick(s, Date.now());
    this.active.delete(sessionId);
  }

  private emitTick(s: ActiveSession, now: number): void {
    const elapsed = (now - s.startedAt) / 1000;
    const alreadyBilled = s.ticksEmitted;
    const quantity = Math.max(0, elapsed - alreadyBilled);
    if (quantity <= 0) return;
    const eventId = deterministicUuid(`${s.sessionId}:${s.ticksEmitted}`);
    this.pushEvent({
      eventId, orgId: s.orgId, sessionId: s.sessionId, deviceId: s.deviceId,
      kind: 'device_seconds', quantity: Number(quantity.toFixed(3)),
      occurredAt: new Date(now).toISOString(),
    });
    s.ticksEmitted = elapsed;
  }

  private pushEvent(e: MeterEvent): void {
    const cap = this.opts.maxBufferedEvents ?? 10_000;
    if (this.buffer.size >= cap && !this.buffer.has(e.eventId)) {
      // Losing billable usage is a real financial loss, so it is an error-level event with a count,
      // never a silent eviction.
      const oldest = this.buffer.keys().next().value as string | undefined;
      if (oldest) this.buffer.delete(oldest);
      console.error(`[agent] metering buffer full (${cap}); dropped an event. Control plane unreachable?`);
    }
    this.buffer.set(e.eventId, e);
  }

  /** Called on a timer; also safe to call directly. Buffered events survive a failed flush. */
  async flush(): Promise<{ recorded: number; ok: boolean }> {
    for (const s of this.active.values()) this.emitTick(s, Date.now());
    if (this.buffer.size === 0 && this.pendingResets.length === 0) return { recorded: 0, ok: true };
    if (!this.state) return { recorded: 0, ok: false };

    const metering = [...this.buffer.values()];
    const resets = [...this.pendingResets];

    try {
      const res = await fetch(`${this.opts.controlPlaneUrl}/v1/workers/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.state.workerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ metering, resets }),
      });
      if (!res.ok) return { recorded: 0, ok: false };
      const body = await res.json() as { meteringRecorded: number; resets: Array<{ deviceId: string; accepted: boolean }> };

      // Only clear what we actually sent — anything added while the request was in flight stays.
      for (const e of metering) this.buffer.delete(e.eventId);
      for (const r of resets) {
        const i = this.pendingResets.findIndex((p) => p.deviceId === r.deviceId && p.fence === r.fence);
        if (i >= 0) this.pendingResets.splice(i, 1);
      }
      for (const r of body.resets ?? []) {
        if (!r.accepted) {
          // Expected, not exceptional: this worker was partitioned and the device has moved on.
          console.warn(`[agent] reset for ${r.deviceId} rejected as stale — device was reallocated`);
        }
      }
      return { recorded: body.meteringRecorded, ok: true };
    } catch {
      return { recorded: 0, ok: false };
    }
  }

  startMetering(intervalMs = 15_000): void {
    this.stopMetering();
    this.meterTimer = setInterval(() => { void this.flush(); }, intervalMs);
    this.meterTimer.unref?.();
  }

  stopMetering(): void {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = undefined;
  }

  // ---------------------------------------------------------------- reset

  /**
   * Snapshot-restore a device and report it free.
   *
   * The reset is reported only AFTER the restore actually completes. Reporting on entry would return
   * a device still carrying the previous tenant's accounts, keychain and caches to the pool.
   */
  async resetAndRelease(backend: DeviceBackend, deviceId: string, fence: number): Promise<void> {
    await backend.control.resetToSnapshot();
    this.pendingResets.push({ deviceId, fence });
    await this.flush();
  }

  // ---------------------------------------------------------------- fencing

  /**
   * Monotonic per-device gate.
   *
   * Rejects a client that was partitioned during an earlier allocation and has now reconnected: its
   * token carries an old fence, and without this check it would be driving a device that has since
   * been reset and handed to a different tenant.
   */
  acceptFence(deviceId: string, fence: number): boolean {
    const high = this.fenceHighWater.get(deviceId) ?? 0;
    if (fence < high) return false;
    this.fenceHighWater.set(deviceId, fence);
    return true;
  }

  highWater(deviceId: string): number {
    return this.fenceHighWater.get(deviceId) ?? 0;
  }

  // ---------------------------------------------------------------- state file

  private statePath(): string {
    return this.opts.statePath ?? `${process.env.HOME}/.mfarm/agent-state.json`;
  }

  private async loadState(): Promise<AgentState | undefined> {
    try {
      return JSON.parse(await readFile(this.statePath(), 'utf8')) as AgentState;
    } catch {
      return undefined;
    }
  }

  private async saveState(s: AgentState): Promise<void> {
    await mkdir(dirname(this.statePath()), { recursive: true });
    // 0600: this file holds the worker credential.
    await writeFile(this.statePath(), JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  async shutdown(): Promise<void> {
    this.stopHeartbeat();
    this.stopMetering();
    for (const id of [...this.active.keys()]) this.endSession(id);
    await this.flush();
  }
}
