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
  type FailureReason,
  type RegistrationResponse,
  type WorkerHeartbeatResponse,
  type WorkerRegistration,
} from '@mfarm/protocol';
import { derivePort } from './appium.ts';
import type { DeviceBackend, DeviceHealth } from './device.ts';

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

/**
 * Registration was refused for the CREDENTIAL, as opposed to failing for any other reason.
 *
 * A distinct type rather than a status check at the call site: the retry in `register()` turns on
 * this distinction, and "did the control plane reject who we are, or reject what we said" is
 * exactly the question a bare `Error` with a status glued into its message makes easy to get wrong.
 */
class RegistrationRefused extends Error {
  // A plain field, not a parameter property: this package runs under Node's type stripping, where
  // `constructor(readonly status: number)` is syntax that cannot simply be erased.
  status: number;
  constructor(status: number, body: string) {
    super(`registration refused: ${status} ${body}`);
    this.name = 'RegistrationRefused';
    this.status = status;
  }
}

export class Agent {
  private state?: AgentState;
  private heartbeatTimer?: NodeJS.Timeout;
  /** Last `hostState` the control plane reported, so the log carries transitions, not a metronome. */
  private lastHostState?: string;
  private meterTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  /** Last health status per device, so only TRANSITIONS become incidents. */
  private readonly lastHealth = new Map<string, DeviceHealth['status']>();
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

  /**
   * Sessions a data-plane client has attached to, waiting to be reported (migration 017).
   *
   * Buffered like every other worker-observed fact rather than sent immediately: `hello` is on the
   * viewer's critical path and must not wait on the control plane, which is the whole reason the
   * grant is verified offline in the first place. A beat's delay in the session reading ACTIVE is
   * invisible; a round trip before the first frame is not.
   */
  private readonly pendingAttaches: Array<{ sessionId: string; fence: number }> = [];

  /**
   * Infrastructure and device-health failures waiting to be reported (spec §18, migration 024).
   *
   * Unbounded, unlike `buffer`, and deliberately so. Metering is capped because a partitioned host
   * emits a tick per device per second forever and would exhaust memory; incidents are emitted on
   * TRANSITIONS — a device going unhealthy, an Appium dying — which a broken host produces a
   * handful of, not thousands. Capping them would drop exactly the evidence explaining why the host
   * was broken, to save memory that was never at risk.
   */
  private readonly pendingIncidents: Array<{
    eventId: string; deviceId: string; sessionId: string | null;
    reason: FailureReason; detail?: string; occurredAt: string;
  }> = [];

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

    /**
     * ALSO AN ANY, and it was three hardcoded literals until ADR-0008.
     *
     * `['screen-stream', 'input-datachannel', 'snapshot-reset']` was true by construction while
     * every device on every host was a Cuttlefish. It stops being true the moment a host serves
     * phones: a handset publishes no stream and cannot restore an image, so a phone-only laptop
     * registered claiming both. Nothing scheduled on it — `negotiate` reads the PER-DEVICE lists —
     * so the damage was confined to `degradedCapabilities` and `hosts.capabilities` telling an
     * operator the opposite of the truth about their own fleet.
     *
     * Derived the same way as `install` beside it, so the rule is one rule: the host can do what at
     * least one of its devices can do. Behaviour is unchanged for a Cuttlefish host, which is what
     * makes this safe to land ahead of the hardware — every cf device declares all three.
     */
    const anyDevice = (c: Capability): Capability[] =>
      this.opts.devices.some((d) => d.control.info.capabilities.includes(c)) ? [c] : [];

    return [
      ...anyDevice('screen-stream'),
      ...anyDevice('input-datachannel'),
      ...anyDevice('snapshot-reset'),
      ...anyDevice('session-reset'),
      ...install,
      ...automation,
    ];
  }
  get sessionPublicKey(): string | undefined { return this.state?.sessionPublicKey; }

  /** The host's own bearer credential, once registration has issued one. */
  get workerToken(): string | undefined { return this.state?.workerToken; }
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
    // THE DATA-PLANE ENDPOINT IS PART OF THIS, and leaving it out was a silent staleness bug.
    //
    // `hosts.endpoint` is written at registration and nowhere else, so anything not in this
    // fingerprint can never be corrected on a host that already exists — it resumes, heartbeats,
    // and keeps advertising whatever it said the first time. The automation endpoint was already
    // covered (`automation`, per device); its sibling was not.
    //
    // It matters most on exactly the machine this is for. A laptop moves: it registers a direct
    // address on one network and is behind NAT on the next, and the stale row then fails every
    // session at the browser, with a device that looks perfectly healthy. Found on 2026-08-26,
    // when removing PUBLIC_ENDPOINT changed what the agent WOULD send and changed nothing at all
    // about what the control plane had stored.
    return JSON.stringify({ host: [...this.capabilities()].sort(), endpoint: this.opts.endpoint, devices });
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
      // `restored?.workerToken` explicitly, because `this.state` is undefined on every path that
      // reaches here — including the one where a heartbeat just failed. Without passing it, a
      // re-registering laptop would fall back to its configured credential, which for an enrolled
      // host is a single-use token that was spent the first time it started.
      this.state = await this.register(restored?.workerToken);
      await this.saveState(this.state);
    }
    return this.state;
  }

  /**
   * The credential to present at REGISTRATION — which is not always the configured one.
   *
   * WHY THIS EXISTS. `POST /workers/register` accepts three credential kinds on one header, told
   * apart by prefix: the fleet secret, a single-use `mae_` enrollment token, and the host's own
   * `mwk_` worker token. The agent only ever sent the configured value, and for an operator-owned
   * Cuttlefish host — where that value is the fleet secret, which never expires — nothing was
   * wrong with that.
   *
   * It breaks completely on the machine ADR-0008 built enrollment FOR. A laptop enrolls with an
   * `mae_` token that is spent by the end of the first registration. The agent re-registers
   * whenever its capability fingerprint changes — plugging in a second phone is exactly that — and
   * it also re-registers on any restart where the fingerprint moved. Every one of those would
   * re-present the spent token and fail, so a person would have to mint a fresh enrollment token to
   * restart their own agent. That defeats the point of the credential being single-use: it would
   * force the thing to be minted so routinely that nobody would treat it as precious.
   *
   * So: once this host HAS its own worker token, that is what re-registration presents. The API has
   * accepted it since migration 023 — this is the agent side that was missing, and without it the
   * `mwk_` branch in `resolveCredential` was unreachable in practice.
   *
   * The configured token stays the credential for the FIRST registration, and for a host whose
   * stored state is gone (rebuilt machine, cleared state file) — which is correctly a re-enrollment.
   *
   * AND IT FALLS BACK. A prior worker token can be genuinely dead — the host row was deleted, the
   * token rotated, the database restored from before this host existed — and `start()` reaches
   * re-registration precisely when a heartbeat has just failed, which is one of the ways that
   * happens. Presenting a dead `mwk_` and giving up would turn a recoverable state into a host that
   * never comes back, so an auth refusal falls through to the configured credential and tries once
   * more. Anything that is not an auth refusal is a real error and is not retried.
   */
  private async register(priorToken?: string): Promise<AgentState> {
    const stored = priorToken ?? this.state?.workerToken;
    if (!stored) return this.registerWith(this.opts.registrationToken);
    try {
      return await this.registerWith(stored);
    } catch (e) {
      if (!(e instanceof RegistrationRefused)) throw e;
      console.warn(
        `[agent] this host's own worker token was refused (${e.status}) — re-registering with the configured credential`,
      );
      return this.registerWith(this.opts.registrationToken);
    }
  }

  private async registerWith(credential: string): Promise<AgentState> {
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
      headers: { 'content-type': 'application/json', 'x-worker-registration-token': credential },
      body: JSON.stringify(registration),
    });
    if (!res.ok) {
      const body = await res.text();
      // Told apart so `register()` knows which failures are worth retrying with another credential.
      // A 401/403 says "not this credential"; a 400 or a 500 says something else is wrong and
      // presenting a second secret would only produce the same error twice.
      if (res.status === 401 || res.status === 403) throw new RegistrationRefused(res.status, body);
      throw new Error(`registration failed: ${res.status} ${body}`);
    }
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
      //
      // ON TRANSITIONS ONLY. Beating every ten seconds, an unconditional line writes 360 identical
      // warnings an hour, which is how the lab box's quarantine hid in its own log — the state that
      // mattered was an hour old and every line looked like news. The recovery line is the other
      // half: since migration 016 a silence quarantine clears on the next beat, so "it came back"
      // is a thing that now happens and is worth exactly one line when it does.
      if (body.hostState !== this.lastHostState) {
        if (body.hostState === 'QUARANTINED') {
          console.warn('[agent] host is QUARANTINED by the control plane — draining, not accepting sessions');
        } else if (this.lastHostState === 'QUARANTINED') {
          console.log(`[agent] host is ${body.hostState} again — back in service`);
        }
        this.lastHostState = body.hostState;
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

  beginSession(sessionId: string, deviceId: string, orgId: string, fence?: number): void {
    this.active.set(sessionId, { sessionId, deviceId, orgId, startedAt: Date.now(), ticksEmitted: 0 });
    // A client attached. Queued, never sent inline — see `pendingAttaches`.
    if (typeof fence === 'number' && !this.pendingAttaches.some((a) => a.sessionId === sessionId && a.fence === fence)) {
      this.pendingAttaches.push({ sessionId, fence });
    }
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

  /**
   * Record something the FARM saw go wrong (spec §18, migration 024).
   *
   * The suite cannot know any of these: it sees one WebDriver call fail and has no vocabulary for
   * why. So the agent says it, and the control plane keeps it beside — never on top of — whatever
   * the suite reported.
   *
   * Buffered like metering rather than POSTed directly, because the incidents most worth having are
   * the ones that happen when the network is bad, which is exactly when a fire-and-forget request
   * is lost. `eventId` makes the inevitable re-send idempotent.
   */
  reportIncident(deviceLocalId: string, reason: FailureReason, detail?: string): void {
    const deviceId = this.deviceIdFor(deviceLocalId);
    if (!deviceId) {
      // Before registration, or a device the control plane does not know. Logged rather than
      // queued: an incident naming a device id we cannot supply can never be accepted.
      console.warn(`[agent] incident '${reason}' on ${deviceLocalId} not reported — no device id yet`);
      return;
    }
    const occurredAt = new Date().toISOString();
    this.pendingIncidents.push({
      eventId: randomUUID(),
      deviceId,
      // The session holding the device right now, if any. An incident outside a session is normal
      // and is stored with a null — a phone can go unhealthy while idle.
      sessionId: this.sessionForDevice(deviceId),
      reason,
      detail: detail?.slice(0, 4000),
      occurredAt,
    });
    console.warn(`[agent] incident on ${deviceLocalId}: ${reason}${detail ? ` — ${detail}` : ''}`);
  }

  /**
   * Which live session holds this device, for attributing an incident to it.
   *
   * Keyed on the CONTROL-PLANE uuid, because that is what `ActiveSession` carries — the local id is
   * this host's private name for the device and appears nowhere in the session bookkeeping.
   */
  private sessionForDevice(deviceId: string): string | null {
    for (const s of this.active.values()) {
      if (s.deviceId === deviceId) return s.sessionId;
    }
    return null;
  }

  /**
   * Watch every device's health, and report the transitions (spec §18/§19).
   *
   * WHY THIS EXISTS AT ALL. `DeviceControl.health()` was implemented by every backend and called by
   * NOTHING — dead code since it was written. So a phone that fell off the USB, filled its storage
   * or dropped below a usable battery produced no signal anywhere: the next WebDriver command
   * failed, the suite recorded its own test as broken, and the farm had nothing to say. That is the
   * exact failure §18 exists to end, and no taxonomy fixes it without something actually looking.
   *
   * ONLY TRANSITIONS ARE REPORTED. A device that is offline stays offline, and a probe every 30s
   * would file a hundred incidents an hour for one pulled cable — burying the one that matters and
   * making "how many incidents last week" a measure of how long nobody noticed. The recovery is
   * logged too, because "it came back on its own" is the other half of the story and the reason not
   * to send somebody to the lab.
   *
   * CHEAP ON PURPOSE. The probe is `true` down the already-open shell plus, on a handset, two
   * `dumpsys`-class reads. It is not free, so it runs on a slow timer and never during a reset —
   * a device mid-`pm clear` is legitimately unresponsive and reporting that would be noise.
   */
  startHealthMonitor(intervalMs = Number(process.env.DEVICE_HEALTH_INTERVAL_MS ?? 30_000)): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => { void this.probeHealth(); }, intervalMs);
    this.healthTimer.unref?.();
  }

  /** One pass over every device. Exported for tests and for a probe on demand. */
  async probeHealth(): Promise<void> {
    for (const backend of this.opts.devices) {
      const localId = backend.control.info.localId;
      // A device being reset is expected to be unresponsive; probing it would report the cleanup
      // as a fault. `resetsInFlight` is keyed by control-plane uuid, which is what we have here.
      const deviceId = this.deviceIdFor(localId);
      if (deviceId && this.resetsInFlight.has(deviceId)) continue;

      let health: DeviceHealth;
      try {
        health = await backend.control.health();
      } catch (e) {
        // A health check that THROWS is itself a health signal — the backend could not even ask.
        health = { status: 'offline', reasonCode: 'agent-failure', reason: (e as Error).message };
      }

      const previous = this.lastHealth.get(localId) ?? 'healthy';
      this.lastHealth.set(localId, health.status);
      if (health.status === previous) continue;

      if (health.status === 'healthy') {
        console.log(`[agent] ${localId} is healthy again (was ${previous})`);
        continue;
      }
      // `device-unresponsive` is the honest default: something is wrong and the backend did not say
      // what, which is different from claiming to know it was the cable.
      this.reportIncident(localId, health.reasonCode ?? 'device-unresponsive', health.reason);
    }
  }

  /** Called on a timer; also safe to call directly. Buffered events survive a failed flush. */
  async flush(): Promise<{ recorded: number; ok: boolean }> {
    for (const s of this.active.values()) this.emitTick(s, Date.now());
    if (this.buffer.size === 0 && this.pendingResets.length === 0 && this.pendingActions.length === 0
        && this.pendingAttaches.length === 0 && this.pendingIncidents.length === 0) {
      return { recorded: 0, ok: true };
    }
    if (!this.state) return { recorded: 0, ok: false };

    const metering = [...this.buffer.values()];
    const resets = [...this.pendingResets];
    const actions = [...this.pendingActions];
    const attaches = [...this.pendingAttaches];
    const incidents = [...this.pendingIncidents];

    try {
      const res = await fetch(`${this.opts.controlPlaneUrl}/v1/workers/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.state.workerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ metering, resets, actions, attaches, incidents }),
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
      // Dropped whether or not they were accepted, and `false` is the ordinary answer: it means the
      // session was already ACTIVE, which is what a reconnect looks like. Re-sending gets the same
      // answer forever.
      for (const a of attaches) {
        const i = this.pendingAttaches.findIndex((p) => p.sessionId === a.sessionId && p.fence === a.fence);
        if (i >= 0) this.pendingAttaches.splice(i, 1);
      }
      // Dropped whether or not accepted, for the same reason as actions and attaches: `false` here
      // means "already recorded" (the event id collided) or "not this host's device", and both give
      // the same answer forever. Keeping them would make one bad device id a permanent buffer leak.
      for (const i of incidents) {
        const at = this.pendingIncidents.findIndex((p) => p.eventId === i.eventId);
        if (at >= 0) this.pendingIncidents.splice(at, 1);
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

  stopHealthMonitor(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
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
  /**
   * Collect what the finished session leaves behind, and ship it to the control plane.
   *
   * A RELEASE IS NEVER BLOCKED ON AN UPLOAD. Every failure here is logged and swallowed: a device
   * that cannot ship its logcat is still a device that must reset, and on a two-device farm a
   * capture that threw would strand half the fleet in CLEANING over a missing screenshot. The
   * control plane makes the same promise from the other side — `artifact_record` returns NULL
   * rather than raising when the checks fail.
   *
   * Ordered screenshot first. It is the smaller, likelier-to-succeed artifact and the one a person
   * looks at first; if the device is wedged badly enough that the log dump hangs to its timeout,
   * the screenshot showing why is already uploaded.
   */
  private async captureArtifacts(
    backend: DeviceBackend, deviceId: string, sessionId: string,
  ): Promise<void> {
    const { control } = backend;
    const name = control.info.localId;

    if (control.screenshot) {
      try {
        const shot = await control.screenshot();
        await this.uploadArtifact(sessionId, deviceId, 'screenshot', shot.bytes, `${name}-final.png`);
      } catch (e) {
        console.warn(`[agent] final screenshot for ${name} failed: ${(e as Error).message}`);
      }
    }

    if (control.dumpLogcat) {
      try {
        const log = await control.dumpLogcat();
        if (log.trim()) {
          await this.uploadArtifact(sessionId, deviceId, 'logcat', Buffer.from(log, 'utf8'), `${name}.log`);
        }
      } catch (e) {
        console.warn(`[agent] logcat dump for ${name} failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * POST one artifact. Worker-authenticated; the owning org is derived from the session by the
   * control plane, so nothing here names an org and nothing here could if it wanted to.
   */
  private async uploadArtifact(
    sessionId: string, deviceId: string, kind: 'logcat' | 'screenshot',
    bytes: Buffer, filename: string,
  ): Promise<void> {
    // An unregistered agent has no token to present. Refusing here keeps the failure inside
    // `captureArtifacts`'s swallow, rather than sending `Bearer undefined` and getting a 401 that
    // reads like a credential problem.
    const token = this.state?.workerToken;
    if (!token) throw new Error('not registered — no worker token to upload with');

    const q = new URLSearchParams({ kind, device: deviceId, filename });
    const res = await fetch(
      `${this.opts.controlPlaneUrl}/v1/sessions/${sessionId}/artifacts?${q}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array(bytes),
      },
    );
    if (!res.ok) {
      // Logged with the status, because the two interesting failures look identical from here and
      // do not from the response: 409 means this worker does not own that session (a bug worth
      // finding), 400 means the artifact was refused on its own merits.
      throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    console.log(`[agent] uploaded ${kind} for session ${sessionId} (${bytes.length} bytes)`);
  }

  private async runRequestedResets(
    requests: Array<{ deviceId: string; fence: number; sessionId?: string }>,
  ): Promise<void> {
    for (const { deviceId, fence, sessionId } of requests) {
      if (this.resetsInFlight.has(deviceId)) continue;
      const backend = this.backendForDeviceId(deviceId);
      if (!backend) {
        console.warn(`[agent] control plane asked to reset unknown device ${deviceId}`);
        continue;
      }
      this.resetsInFlight.add(deviceId);
      try {
        // BEFORE the reset, because the reset destroys exactly what is being captured — and inside
        // the in-flight guard, so a capture that outlasts a beat cannot start a second one.
        if (sessionId) await this.captureArtifacts(backend, deviceId, sessionId);
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
      const { sha256, appId } = r;
      if (!sha256) throw new Error('the control plane offered an install with no digest to verify against');
      // Both became optional when `screenshot` joined the pipeline. The digest is what makes the
      // download safe and the id is what makes it reachable; neither has a sane default, so an
      // install missing either is refused by name rather than attempted.
      if (!appId) throw new Error('the control plane offered an install with no app to install');
      await control.installApp(await this.fetchApk({ ...r, sha256, appId }));
      return;
    }
    if (r.kind === 'launch') {
      if (!control.launchApp) {
        throw new Error(`${control.info.localId} cannot launch apps: this device tier has no launch path.`);
      }
      // `packageName` became optional when `screenshot` arrived. Named explicitly rather than
      // passed through as undefined, which adb would turn into a baffling usage error.
      if (!r.packageName) throw new Error('the control plane offered a launch with no package name');
      await control.launchApp(r.packageName);
      return;
    }
    if (r.kind === 'uninstall') {
      if (!control.uninstallApp) {
        throw new Error(`${control.info.localId} cannot uninstall apps: this device tier has no uninstall path.`);
      }
      if (!r.packageName) throw new Error('the control plane offered an uninstall with no package name');
      await control.uninstallApp(r.packageName);
      return;
    }
    if (r.kind === 'screenshot') {
      if (!control.screenshot) {
        throw new Error(`${control.info.localId} cannot take screenshots: this device tier has no capture path.`);
      }
      // THE POINT OF THIS VERB. The release-time screenshot is taken when the device is handed
      // back, by which time Appium's `deleteSession()` has force-stopped the app — so it shows the
      // launcher rather than the failure. This one is taken while the suite still holds the device
      // and the screen still shows whatever went wrong.
      const shot = await control.screenshot();
      await this.uploadArtifact(r.sessionId, r.deviceId, 'screenshot', shot.bytes, `${r.actionId}.png`);
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
  private async fetchApk(r: AppActionRequest & { sha256: string; appId: string }): Promise<string> {
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
    this.stopHealthMonitor();
    for (const id of [...this.active.keys()]) this.endSession(id);
    // The final flush carries any incident recorded on the way down — including the one explaining
    // why the agent is shutting down at all, which is the one somebody will come looking for.
    await this.flush();
  }
}
