import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  PROTOCOL_VERSION,
  type AppActionRequest,
  type AppActionResult,
  type Capability,
  type RegistrationResponse,
  type WorkerHeartbeatResponse,
  type WorkerRegistration,
} from '@mfarm/protocol';
import { derivePort } from './appium.ts';
import type { DeviceBackend } from './device.ts';

/**
 * Bases for the two ports UiAutomator2 otherwise defaults to a single fixed number.
 *
 * Kept clear of the Appium port range (4723 + 0..99) so the three derivations for one device can
 * never land on each other.
 */
const UIAUTOMATOR2_SYSTEM_PORT_BASE = 8200;
const UIAUTOMATOR2_MJPEG_PORT_BASE = 7810;

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
   * Automation base url applied to EVERY device on this host — the v1 shape.
   *
   * Still meaningful for the escape hatch in `AUTOMATION_ENDPOINT`: one externally-managed Appium
   * genuinely can front several devices. For a supervised, per-device setup use
   * `automationEndpoints` instead, which is what the ADR-0004 gateway produces.
   *
   * The INITIAL value only. A supervised Appium moves it at runtime through
   * `setAutomationEndpoint`, because the capability tracks the server's health rather than the
   * configuration it was started with (ADR-0003 decision 3).
   */
  automationEndpoint?: string;
  /**
   * v2. Per-device automation base urls, keyed by local id — `cf-1` -> the gateway path for `cf-1`.
   *
   * Takes precedence over `automationEndpoint` for the devices it names. This is what makes B2
   * expressible: a device with no entry here simply does not advertise `webdriver`, so a host can
   * serve WebDriver on one device and not on another instead of lying about both.
   */
  automationEndpoints?: Record<string, string>;
  devices: DeviceBackend[];
  statePath?: string;
  cores?: number;
  memoryMb?: number;
  /** Cap on unflushed metering events. Exceeding it is a loud failure, never a silent drop. */
  maxBufferedEvents?: number;
  /**
   * Where downloaded APKs are cached, keyed by their sha256.
   *
   * Content-addressed like the control plane's own store, so installing the same build on both
   * devices of this host downloads it once, and a re-offered install after a restart downloads it
   * not at all. Nothing prunes it yet — see the note in `fetchApk`.
   */
  appCacheDir?: string;
}

export interface AgentState {
  hostId: string;
  workerToken: string;
  sessionPublicKey: string;
  /** localId -> control-plane device uuid */
  deviceIds: Record<string, string>;
  /**
   * What this host last told the control plane it could do. See `capabilityFingerprint()`.
   *
   * Absent on a state file written before v2, which reads as "unknown" and forces one
   * re-registration on first start. That is the safe direction: it re-asserts the truth.
   */
  registered?: string;
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

/** sha256 of a file, streamed — the APKs this hashes are hundreds of megabytes. */
async function digestOf(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
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
  /** Devices currently being restored, so a re-sent heartbeat request cannot start a second one. */
  private readonly resetsInFlight = new Set<string>();
  /** Same guard, same reason: the beat re-offers an action that is still running. */
  private readonly actionsInFlight = new Set<string>();
  /** Outcomes waiting to be reported. Flushed alongside metering and resets. */
  private readonly pendingActions: AppActionResult[] = [];

  private readonly opts: AgentOptions;
  /**
   * Live, not frozen at construction, and keyed by device local id. ADR-0003 decision 3 makes
   * `webdriver` a claim about the present, so the supervisor moves entries here every time an
   * Appium's health changes and everything that reports capabilities reads from this map rather
   * than from `opts`.
   *
   * Per-device since v2 (B2): with one string per host, a second device inherited the first one's
   * endpoint and advertised a server the hub could never reach.
   */
  private readonly automation = new Map<string, string>();

  // Explicit field + assignment rather than a constructor parameter property: those emit runtime
  // code, so Node's strip-only type removal rejects them and the no-build-step setup breaks.
  constructor(opts: AgentOptions) {
    this.opts = opts;
    // Host-level first so a per-device entry can override it, which is the same precedence
    // `deviceAutomationEndpoint` applies on the control-plane side.
    if (opts.automationEndpoint) {
      for (const d of opts.devices) this.automation.set(d.control.info.localId, opts.automationEndpoint);
    }
    for (const [localId, url] of Object.entries(opts.automationEndpoints ?? {})) {
      this.automation.set(localId, url);
    }
  }

  get hostId(): string | undefined { return this.state?.hostId; }

  /**
   * The HOST-level endpoint to report, or undefined.
   *
   * Deliberately answers only when exactly one distinct url is in play. A v1 control plane can
   * store one string per host, so reporting one of two would tell it that both devices are served
   * by a server that can only reach one — the precise defect B2 describes. Answering `undefined`
   * instead means an old control plane sees a host with no automation server and schedules no
   * WebDriver work at it, which is a truthful degradation.
   */
  get automationEndpoint(): string | undefined {
    // EVERY device must be covered, not merely "all the entries agree". The control plane resolves a
    // missing device-level endpoint by falling back to this field, so reporting cf-1's url on a host
    // where cf-2 has none makes the control plane store it for cf-2 as well — which is precisely the
    // B2 defect, re-entering through the compatibility path. Caught by a test, not by review.
    if (this.automation.size !== this.opts.devices.length) return undefined;
    const distinct = new Set(this.automation.values());
    return distinct.size === 1 ? [...distinct][0] : undefined;
  }

  automationEndpointFor(localId: string): string | undefined {
    return this.automation.get(localId);
  }

  /**
   * Point one device at a different automation server, or at none.
   *
   * `undefined` withdraws `webdriver` from that device in everything this agent reports from now
   * on. It cannot un-say what registration already said — see the heartbeat for how far that
   * actually gets today — but it does mean the agent never re-asserts a capability it can no longer
   * serve.
   */
  setAutomationEndpoint(localId: string, url: string | undefined): void {
    if (this.automation.get(localId) === url) return;
    if (url === undefined) this.automation.delete(localId);
    else this.automation.set(localId, url);
    // Deliberately about what the AGENT now reports, not about what the control plane believes:
    // nothing here reaches the control plane until the next registration.
    console.warn(
      url === undefined
        ? `[agent] no automation endpoint is serving ${localId}; \`webdriver\` dropped for it`
        : `[agent] automation endpoint for ${localId} is ${url}; \`webdriver\` advertised for it`,
    );
  }

  /**
   * The host-level capability set, computed from present state every time it is asked for.
   *
   * `webdriver` is declared by the host having a *reachable* automation server, not by the device
   * tier and not by configuration: the same Cuttlefish instance can serve WebDriver on one
   * deployment and not on another, and claiming the capability without the server behind it means
   * the scheduler sends sessions to a device that cannot run them.
   *
   * At host level this is an ANY: the host can serve WebDriver if at least one of its devices can.
   * Which devices is said per-device in the registration payload.
   */
  private capabilities(): Capability[] {
    const automation: Capability[] = this.automation.size > 0 ? ['webdriver'] : [];
    // An ANY, like `webdriver` beside it: the host can install apps if at least one of its devices
    // can. Which ones is said per-device, from each backend's own capability list — a host that
    // claimed it while no device implemented `installApp` would collect install jobs it must then
    // fail one at a time.
    const install: Capability[] = this.opts.devices.some((d) => typeof d.control.installApp === 'function')
      ? ['app-install'] : [];
    // One capability covers install, launch and uninstall: they are the same adb on the same
    // device, and a tier that has one and not the others is not a shape that exists today. The
    // per-method checks in `performAction` are what keep that assumption honest if it ever stops
    // being true — they name the missing verb instead of failing obscurely.
    return ['screen-stream', 'input-datachannel', 'snapshot-reset', ...install, ...automation];
  }
  get sessionPublicKey(): string | undefined { return this.state?.sessionPublicKey; }
  get bufferedEventCount(): number { return this.buffer.size; }
  deviceIdFor(localId: string): string | undefined { return this.state?.deviceIds[localId]; }

  // ---------------------------------------------------------------- registration

  /**
   * A stable summary of everything registration ASSERTS about this host's abilities.
   *
   * Exists because a valid credential is not evidence that the control plane's picture is still
   * right. `start()` used to reuse a stored credential whenever the heartbeat succeeded, and skip
   * registration — which meant the drain-and-restart withdrawal documented in `index.ts` did not
   * withdraw anything. The agent came back with the same token, never re-registered, and the control
   * plane went on believing `webdriver` was available on a device whose Appium was still dead.
   *
   * Fingerprinting the claim and re-registering when it changes is what makes that path real.
   */
  private capabilityFingerprint(): string {
    const devices = this.opts.devices
      .map((d) => {
        const localId = d.control.info.localId;
        return {
          localId,
          caps: [...d.control.info.capabilities].sort(),
          automation: this.automation.get(localId) ?? null,
        };
      })
      .sort((a, b) => a.localId.localeCompare(b.localId));
    return JSON.stringify({ host: [...this.capabilities()].sort(), devices });
  }

  async start(): Promise<AgentState> {
    const restored = await this.loadState();
    const fingerprint = this.capabilityFingerprint();

    // The state is adopted BEFORE the heartbeat that validates it, and put back if that beat fails.
    //
    // The obvious order — heartbeat first, assign on success — is what shipped, and it silently
    // discarded every piece of work the control plane handed back on that first beat. A beat's
    // response carries resets and app actions naming devices by their control-plane uuid, and the
    // only thing that can map a uuid to a local backend is `state.deviceIds`; with the assignment
    // after the call, `backendForDeviceId` had nothing to look in and logged "unknown device" for
    // devices sitting right there. It self-healed on the next beat, which is exactly why it went
    // unnoticed — a restart during a restore just left the device CLEANING for another ten seconds.
    // Found by running the fake farm, not by a test.
    if (restored && restored.registered === fingerprint) {
      this.state = restored;
      if (!(await this.heartbeat()).ok) this.state = undefined;
    }

    if (!this.state) {
      // Three ways to land here, and all three want the same answer:
      //   - no usable credential, or the control plane rejected it (host rebuilt, token rotated);
      //   - a state file from before v2, which cannot prove what it registered;
      //   - what this host can do has CHANGED since it last registered — an Appium that died and
      //     did not come back, or one that came back after registering without it.
      // Re-register rather than sitting silently offline, or worse, silently lying.
      if (restored && restored.registered !== fingerprint) {
        console.warn('[agent] capabilities differ from what was last registered — re-registering');
      }
      this.state = await this.register();
      await this.saveState(this.state);
    }
    return this.state;
  }

  private async register(): Promise<AgentState> {
    const registration: WorkerRegistration = {
      protocolVersion: PROTOCOL_VERSION,
      hostname: this.opts.hostname,
      region: this.opts.region,
      endpoint: this.opts.endpoint,
      // Legacy field: set only when one url covers the whole host. See the getter.
      automationEndpoint: this.automationEndpoint,
      cores: this.opts.cores ?? 0,
      memoryMb: this.opts.memoryMb ?? 0,
      capabilities: this.capabilities(),
      devices: this.opts.devices.map((d) => {
        const localId = d.control.info.localId;
        const endpoint = this.automation.get(localId);
        // Per DEVICE, not per host. Before v2 this list was `[...info.capabilities, ...automation]`
        // with one host-level `automation`, so every device on a host with any Appium claimed
        // `webdriver` — including the ones no server was fronting.
        const automation: Capability[] = endpoint ? ['webdriver'] : [];
        return {
          localId,
          platform: d.control.info.platform,
          tier: d.control.info.tier,
          model: d.control.info.model,
          osVersion: d.control.info.osVersion,
          capabilities: [...d.control.info.capabilities, ...automation],
          automationEndpoint: endpoint,
          // The device's real identity, as the driver knows it (B3).
          adbSerial: d.control.info.adbSerial,
          // Only meaningful alongside an automation server, and only the worker can allocate them:
          // this host's port space is its own. Same derivation as the Appium port, different base,
          // so they are stable across a restart and never overlap.
          ...(endpoint
            ? {
                systemPort: derivePort(localId, UIAUTOMATOR2_SYSTEM_PORT_BASE),
                mjpegServerPort: derivePort(localId, UIAUTOMATOR2_MJPEG_PORT_BASE),
              }
            : {}),
        };
      }),
    };

    const res = await fetch(`${this.opts.controlPlaneUrl}/v1/workers/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-registration-token': this.opts.registrationToken },
      body: JSON.stringify(registration),
    });
    if (!res.ok) throw new Error(`registration failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as RegistrationResponse;

    // The control plane decides which devices may take tenant traffic. Anything it withheld is
    // reported here rather than left for someone to notice as unexplained idle capacity.
    const withheld = registration.devices
      .map((d) => d.localId)
      .filter((id) => !body.schedulableDevices.includes(id));
    if (withheld.length > 0) {
      console.warn(`[agent] not schedulable (missing required capabilities): ${withheld.join(', ')}`);
    }

    return {
      hostId: body.hostId,
      workerToken: body.workerToken,
      sessionPublicKey: body.sessionPublicKey,
      deviceIds: this.resolveDeviceIds(body, registration),
      // Recorded AFTER the control plane accepted it, so a failed registration never leaves a state
      // file claiming the fleet knows something it does not.
      registered: this.capabilityFingerprint(),
    };
  }

  /**
   * Map local device names to the control plane's uuids.
   *
   * Registration sends local ids because that is what the worker knows; everything afterwards
   * (metering, resets, fences, automation grants) is keyed by the control plane's uuid.
   *
   * v2 gets this from the response. Before that it returned `{}` and the agent inferred a device's
   * uuid from whatever session token arrived — authenticated and therefore safe, but only usable
   * AFTER a token shows up, and ambiguous on a host with more than one device. The automation
   * gateway needs the mapping *before* it proxies anything, to decide whether a grant naming uuid X
   * may drive the device at `/automation/cf-2`, so inference is not an option there.
   */
  private resolveDeviceIds(
    body: RegistrationResponse,
    sent: WorkerRegistration,
  ): Record<string, string> {
    const ids = body.deviceIds ?? {};
    // A v1 control plane sends none. Say so once: it is the difference between "the gateway will
    // refuse every request" and "WebDriver is quietly broken on this host".
    const missing = sent.devices.map((d) => d.localId).filter((id) => !ids[id]);
    if (missing.length > 0) {
      console.warn(
        `[agent] the control plane returned no device uuid for: ${missing.join(', ')}. ` +
        'The automation gateway cannot authorize grants for these devices and will refuse them. ' +
        'This control plane predates protocol v2.',
      );
    }
    return ids;
  }

  // ---------------------------------------------------------------- heartbeat

  /**
   * Liveness, and — as far as the protocol currently allows — the host's CURRENT capability set.
   *
   * The capability payload is the right home for ADR-0003 decision 3. Registration states
   * capabilities once and never revisits them, so a supervised Appium that crashes and comes back
   * leaves the control plane believing whatever was true at boot. A beat already happens every 10s
   * and already carries the worker credential, so attaching present state costs one field and
   * bounds the lie at one heartbeat interval.
   *
   * IT DOES NOT WORK YET, AND THAT IS NOT SILENT. `POST /workers/heartbeat` in
   * `apps/api/src/http/routes/workers.ts` touches `last_heartbeat_at` and reads nothing from the
   * body, and `packages/protocol` has no type for it — so today this body is parsed and dropped.
   * It is sent anyway because it is inert on the current control plane (the route has no body
   * schema, so an unexpected body is accepted and ignored) and because the worker half then needs
   * no change at all when the protocol catches up. Until it does, the real withdrawal path is the
   * drain-and-exit in index.ts. See the report accompanying ADR-0003 for the exact protocol change.
   */
  async heartbeat(): Promise<{ ok: boolean; hostState?: string }> {
    const token = this.state?.workerToken ?? (await this.loadState())?.workerToken;
    if (!token) return { ok: false };
    try {
      const res = await fetch(`${this.opts.controlPlaneUrl}/v1/workers/heartbeat`, {
        method: 'POST',
        // A real body, so content-type is honest. Claiming JSON with an EMPTY body is what made the
        // control plane 500 before; an empty body is no longer possible here.
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: this.capabilities(),
          automationEndpoint: this.automationEndpoint ?? null,
          // Per-device since v2, for the same reason registration carries it: one string cannot
          // describe a host whose devices are served by different gateways.
          devices: Object.fromEntries(this.automation),
        }),
      });
      if (!res.ok) return { ok: false };
      const body = await res.json() as WorkerHeartbeatResponse;
      // A host quarantined while it was partitioned learns about it here and must drain rather than
      // keep accepting work.
      if (body.hostState === 'QUARANTINED') {
        console.warn('[agent] host is QUARANTINED by the control plane — draining, not accepting sessions');
      }
      // Deliberately not awaited: a restore takes seconds and the beat must stay a liveness signal.
      // A slow reset that delayed the heartbeat would look like a dead host and get the whole
      // machine quarantined, which is the opposite of what a device needing cleaning calls for.
      void this.runRequestedResets(body.resets ?? []);
      // Not awaited for the same reason, and more so: an install is a download plus a dexopt pass,
      // which is minutes, not seconds. The in-flight guard is what makes re-offering it every beat
      // harmless in the meantime.
      void this.runRequestedActions(body.actions ?? []);
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
    // `orgId` is still sent for older control planes, but it no longer decides anything: since
    // migration 008 the control plane derives the paying org from the session and ignores this
    // field. Do not add logic that assumes a worker's opinion about billing carries weight.
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
    if (this.buffer.size === 0 && this.pendingResets.length === 0 && this.pendingActions.length === 0) {
      return { recorded: 0, ok: true };
    }
    if (!this.state) return { recorded: 0, ok: false };

    const metering = [...this.buffer.values()];
    const resets = [...this.pendingResets];
    const actions = [...this.pendingActions];

    try {
      const res = await fetch(`${this.opts.controlPlaneUrl}/v1/workers/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.state.workerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ metering, resets, actions }),
      });
      if (!res.ok) return { recorded: 0, ok: false };
      const body = await res.json() as {
        meteringRecorded: number; meteringRejected?: number;
        resets: Array<{ deviceId: string; accepted: boolean }>;
        actions?: Array<{ actionId: string; accepted: boolean }>;
      };

      // Only clear what we actually sent — anything added while the request was in flight stays.
      for (const e of metering) this.buffer.delete(e.eventId);
      for (const r of resets) {
        const i = this.pendingResets.findIndex((p) => p.deviceId === r.deviceId && p.fence === r.fence);
        if (i >= 0) this.pendingResets.splice(i, 1);
      }
      // Dropped whether or not the control plane accepted them: a rejected outcome means the
      // action was already recorded or is not ours, and re-sending gets the same answer forever.
      // The action itself is not lost by this — it stays PENDING there and comes back on a beat.
      for (const r of actions) {
        const i = this.pendingActions.findIndex((p) => p.actionId === r.actionId);
        if (i >= 0) this.pendingActions.splice(i, 1);
      }
      for (const r of body.resets ?? []) {
        if (!r.accepted) {
          // Expected, not exceptional: this worker was partitioned and the device has moved on.
          console.warn(`[agent] reset for ${r.deviceId} rejected as stale — device was reallocated`);
        }
      }
      // Not expected, and not retryable: the control plane says these sessions are not on this host,
      // and re-sending will get the same answer. Dropped from the buffer above along with everything
      // else, so this line is the only trace it will ever leave — usage that will never be billed.
      if (body.meteringRejected) {
        console.error(
          `[agent] ${body.meteringRejected} of ${metering.length} metering events REJECTED as not ` +
          'belonging to this host — usage has been lost. This is a bug, not a retryable failure.',
        );
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

  /**
   * Act on the reset requests the control plane attaches to a heartbeat.
   *
   * THIS IS THE CALLER `resetAndRelease` NEVER HAD. Until 2026-08-18 the control plane parked a
   * released device in CLEANING and waited for a confirmation that no code path ever produced, so a
   * farm served one session per device and then answered `no_capacity` for good (HANDOFF.md issue
   * 16). Found by running B8, not by review — every test had called `resetAndRelease` directly.
   *
   * Three properties worth keeping:
   *
   * - **In-flight guard.** The request is re-sent on every beat until the state changes, and a
   *   restore takes longer than a beat interval. Without the guard a ten-second restore starts a
   *   second `cvd stop` on a device that is mid-restore.
   * - **A failure is logged and dropped, not retried here.** The next beat brings the request back
   *   for free, and a device that cannot be restored must stay in CLEANING — that state is exactly
   *   what the "reset failure" alert watches for.
   * - **An unknown device is a warning, never a throw.** A control plane naming a device this
   *   worker does not have is a bug somewhere, but it must not stop the beat.
   */
  private async runRequestedResets(requests: Array<{ deviceId: string; fence: number }>): Promise<void> {
    for (const { deviceId, fence } of requests) {
      if (this.resetsInFlight.has(deviceId)) continue;
      const backend = this.backendForDeviceId(deviceId);
      if (!backend) {
        console.warn(`[agent] control plane asked to reset unknown device ${deviceId}`);
        continue;
      }
      this.resetsInFlight.add(deviceId);
      try {
        console.log(`[agent] resetting ${backend.control.info.localId} (fence ${fence})`);
        await this.resetAndRelease(backend, deviceId, fence);
        console.log(`[agent] ${backend.control.info.localId} restored and released`);
      } catch (e) {
        // Stays CLEANING, which is the designed signal for a failed restore — a device that cannot
        // be cleaned must never go back into the pool carrying the last tenant's state.
        console.error(`[agent] reset failed for ${backend.control.info.localId}: ${(e as Error).message}`);
      } finally {
        this.resetsInFlight.delete(deviceId);
      }
    }
  }

  // ---------------------------------------------------------------- app install

  private appCacheDir(): string {
    return this.opts.appCacheDir ?? `${process.env.HOME}/.mfarm/apps`;
  }

  /**
   * Perform the app actions the control plane attached to a heartbeat.
   *
   * Same three properties as `runRequestedResets`, for the same reasons — an in-flight guard
   * because the request is re-offered every beat and an action outlives one, a failure that is
   * REPORTED rather than retried here, and an unknown device that warns instead of throwing.
   *
   * The difference is what a failure means. A reset that fails must leave the device stuck in
   * CLEANING, because a device that cannot be cleaned must never go back into the pool. An action
   * that fails is a fact about the tenant's APK — a bad signature, a wrong ABI, no launcher
   * activity, not enough space — and the person who asked for it is waiting for exactly that
   * sentence. So it is recorded as FAILED with adb's own words rather than left pending for a retry
   * that would fail identically.
   */
  private async runRequestedActions(requests: AppActionRequest[]): Promise<void> {
    for (const r of requests) {
      if (this.actionsInFlight.has(r.actionId)) continue;
      if (this.pendingActions.some((p) => p.actionId === r.actionId)) continue; // done, awaiting flush

      const backend = this.backendForDeviceId(r.deviceId);
      if (!backend) {
        // Delivery is host-scoped, so this should be unreachable. Warn rather than report a
        // failure: claiming an outcome for a device we do not own is the one answer that is worse
        // than silence.
        console.warn(`[agent] control plane asked to ${r.kind} on unknown device ${r.deviceId}`);
        continue;
      }
      const control = backend.control;

      // Second lock on a device that has been reallocated since this beat was built. The control
      // plane already refuses to offer a stale action; this one still holds if the beat was in
      // flight while the device changed hands.
      if (!this.acceptFence(r.deviceId, r.fence)) {
        this.report(r, false, 'Stale fence: this device was reallocated before the action ran.');
        await this.flush();
        continue;
      }

      this.actionsInFlight.add(r.actionId);
      try {
        console.log(`[agent] ${r.kind} ${r.packageName} on ${control.info.localId}`);
        await this.performAction(backend, r);
        console.log(`[agent] ${r.kind} of ${r.packageName} on ${control.info.localId} succeeded`);
        this.report(r, true);
      } catch (e) {
        const error = (e as Error).message;
        console.error(`[agent] ${r.kind} of ${r.packageName} on ${control.info.localId} failed: ${error}`);
        this.report(r, false, error);
      } finally {
        this.actionsInFlight.delete(r.actionId);
      }
      // Reported immediately rather than on the metering timer: someone is watching this in a UI or
      // a CLI poll, and a 15s wait to learn it finished is most of a short action.
      await this.flush();
    }
  }

  private report(r: AppActionRequest, ok: boolean, error?: string): void {
    this.pendingActions.push({ actionId: r.actionId, ok, ...(error ? { error } : {}) });
  }

  /**
   * Dispatch one verb.
   *
   * The capability check is per METHOD, not per device, and that is the whole point of the optional
   * members on `DeviceControl`: a tier can gain the ability to install without gaining the ability
   * to launch, and the honest answer for the one it lacks is a named failure rather than a silent
   * success. Only `install` touches the network, which is why the download lives here and not in
   * the caller — `launch` and `uninstall` carry a package name and nothing else.
   */
  private async performAction(backend: DeviceBackend, r: AppActionRequest): Promise<void> {
    const control = backend.control;
    if (r.kind === 'install') {
      if (!control.installApp) {
        throw new Error(`${control.info.localId} cannot install apps: this device tier has no install path.`);
      }
      // Refused rather than defaulted: without a digest there is nothing to check the download
      // against, and installing an unverified blob is the one thing this path exists to prevent.
      const { sha256 } = r;
      if (!sha256) throw new Error('the control plane offered an install with no digest to verify against');
      await control.installApp(await this.fetchApk({ ...r, sha256 }));
      return;
    }
    if (r.kind === 'launch') {
      if (!control.launchApp) {
        throw new Error(`${control.info.localId} cannot launch apps: this device tier has no launch path.`);
      }
      await control.launchApp(r.packageName);
      return;
    }
    if (r.kind === 'uninstall') {
      if (!control.uninstallApp) {
        throw new Error(`${control.info.localId} cannot uninstall apps: this device tier has no uninstall path.`);
      }
      await control.uninstallApp(r.packageName);
      return;
    }
    // A verb from a newer control plane. Reported as a failure rather than ignored: the row would
    // otherwise stay PENDING and be re-offered on every beat forever.
    throw new Error(`this worker does not know how to "${String((r as { kind: string }).kind)}" an app`);
  }

  /**
   * The APK on local disk, downloaded if it is not cached, and VERIFIED either way.
   *
   * The digest is checked on both paths, and neither check is paranoia:
   *
   *   after a download, because a truncated transfer reaches `adb install` as a corrupt archive and
   *   the error it produces names the app, sending whoever reads it to look at their own build;
   *
   *   on a cache hit, because this file is written by a previous process that may have been killed
   *   mid-write, and because the cache directory is ordinary disk that anything on the host can
   *   write to. Re-hashing a cached 100 MB APK costs a few hundred milliseconds against an install
   *   measured in tens of seconds.
   *
   * Nothing prunes this cache yet. At two devices and a handful of builds that is a few gigabytes
   * and not a problem; it becomes one on a long-lived host, and the fix is a sweep by last-access,
   * not a smaller cache.
   */
  private async fetchApk(r: AppActionRequest & { sha256: string }): Promise<string> {
    const dir = this.appCacheDir();
    await mkdir(dir, { recursive: true });
    const finalPath = join(dir, `${r.sha256}.apk`);

    if (await stat(finalPath).then(() => true).catch(() => false)) {
      if (await digestOf(finalPath) === r.sha256) return finalPath;
      console.warn(`[agent] cached ${r.sha256.slice(0, 12)} does not match its digest; re-downloading`);
      await unlink(finalPath).catch(() => {});
    }

    if (!this.state) throw new Error('not registered: cannot download an app');
    // The action id is the authorization, not the worker token alone — the control plane will only
    // serve a build this host is currently holding a pending INSTALL for.
    const url = `${this.opts.controlPlaneUrl}/v1/apps/${encodeURIComponent(r.appId)}/blob`
      + `?actionId=${encodeURIComponent(r.actionId)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.state.workerToken}` } });
    if (!res.ok || !res.body) {
      throw new Error(`downloading the app failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }

    // Written to a temp name and renamed, so a crash mid-download cannot leave a truncated file
    // sitting at the name of its own digest — the one file nothing would think to re-verify.
    const tmp = join(dir, `${randomUUID()}.part`);
    try {
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
      const actual = await digestOf(tmp);
      if (actual !== r.sha256) {
        throw new Error(`downloaded app digest ${actual.slice(0, 12)} does not match the expected ${r.sha256.slice(0, 12)}`);
      }
      await rename(tmp, finalPath);
      return finalPath;
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  /** uuid -> backend, via the localId->uuid map registration returned. */
  private backendForDeviceId(deviceId: string): DeviceBackend | undefined {
    const ids = this.state?.deviceIds ?? {};
    const localId = Object.keys(ids).find((k) => ids[k] === deviceId);
    if (!localId) return undefined;
    return this.opts.devices.find((b) => b.control.info.localId === localId);
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
