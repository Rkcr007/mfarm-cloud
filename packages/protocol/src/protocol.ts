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
  'session-reset',       // reset by package-level cleanup, NOT by restoring an image (ADR-0008).
                         // Weaker than 'snapshot-reset' and named so the difference cannot be
                         // read as a synonym — see REQUIRED_FOR_TENANT_USE for what it does and
                         // does not promise.
  'install-reset',       // reset by uninstalling exactly what THIS SESSION installed, and nothing
                         // else (ADR-0012). Weaker again, and the default for a borrowed handset:
                         // a device whose owner is a person, not the fleet, cannot have its
                         // third-party packages swept — that is somebody's banking app. An app the
                         // owner already had, driven by a session, keeps whatever state that
                         // session left in it, and the console has to say so.
  'app-install',
  'recording',
  'logcat',
  'screenshot',       // a single frame on demand, out of band from the media stream
  'ui-hierarchy',        // the on-screen view tree on demand, for building selectors
  'network-capture',     // per-session proxy: isolation + record/replay + waterfall (v2 decision 9)
  'gpu',                 // hardware rendering available; absent means software rendering only
  'webdriver',           // an automation (Appium) server fronts this device, so it can serve the
                         // WebDriver hub (v2 decision 10). Not required for interactive use.
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * What a device must be able to do before a tenant session may be scheduled on it.
 *
 * A LIST OF ALTERNATIVE GROUPS, not a flat list: a device must satisfy every group, and satisfies
 * one group by declaring ANY capability in it. It was a flat list until ADR-0008, and the shape is
 * the whole of the change.
 *
 * WHY IT HAD TO STOP BEING FLAT. The old list demanded `snapshot-reset` literally, which is a
 * mechanism, while what the gate actually means is "the next tenant will not inherit the last
 * one's state". Those coincided for exactly as long as every device was a Cuttlefish. A physical
 * handset cannot restore an image — so it would register, appear in the console, and never be
 * scheduled, with nothing anywhere saying why. Silence is the failure mode this shape removes:
 * a phone now fails the gate only if it declares NEITHER reset, which is a device that genuinely
 * cannot be handed on.
 *
 * WHAT `session-reset` DOES NOT PROMISE, and why it is a separate name rather than a second way of
 * spelling the same one. `resetToSnapshot`'s own doc comment rejects package-level cleanup as
 * insufficient between tenants, and it is right: uninstalling an app leaves accounts, keychain
 * items, clipboard contents, WebView caches and granted permissions behind. That argument is not
 * softened here. It is answered by tenancy instead — a `session-reset` device inherits
 * `hosts.org_id` at registration and never enters the shared pool (migration 023), so "the next
 * tenant" is the same org that used it last. Anything that puts a `session-reset` device in front
 * of a second org must re-open this decision, not route around it.
 *
 * WHAT `install-reset` DOES NOT PROMISE, which is less again, and is the DEFAULT for a handset
 * somebody lends from their own laptop (ADR-0012). It undoes exactly what the session installed.
 * An app the owner already had — their mail, their browser — keeps whatever state a session left
 * in it, and the next session in the same org can see that. That is not a weakness introduced by
 * the mechanism; it is the irreducible property of borrowing a personal phone, and the only
 * alternative is wiping the owner's apps, which is what `session-reset` does and why it stopped
 * being the default. It stays in this group because the tenancy answer above covers it identically:
 * the device is org-pinned and never enters the shared pool. What it additionally requires is that
 * the person sharing the device is TOLD, at the moment they share it, what colleagues will see.
 */
export const REQUIRED_FOR_TENANT_USE: readonly (readonly Capability[])[] = [
  ['snapshot-reset', 'session-reset', 'install-reset'],
  ['input-datachannel'],
];

/**
 * Does this capability set clear the gate above?
 *
 * Exported as a function because every caller wants the answer, not the rule, and a caller that
 * re-implements `.every(...)` over the groups is one refactor away from implementing it as a flat
 * `.every(...)` again — which is the bug this replaced, and which would come back as a device that
 * silently never schedules.
 */
export function canTakeTenantSession(capabilities: readonly string[]): boolean {
  return REQUIRED_FOR_TENANT_USE.every((group) => group.some((c) => capabilities.includes(c)));
}

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
     * v2. Which device profile this one was configured from — `mfarm-x1-pro` (ADR-0017).
     *
     * A stable key, never a display name: the console keys its device chrome off it, and matching
     * that on `model` would break the first time a marketing name is retyped. Absent on physical
     * handsets, which ARE the real device, and on any virtual device nobody profiled.
     *
     * Its presence is also the console's only way to know that `model` names a CONFIGURED device
     * rather than one read off hardware. Since ADR-0017 that is a smaller distinction than it was —
     * an MFARM X1 Pro is a device this farm genuinely provides, not a handset it is imitating — but
     * it is still what the VIRTUAL DEVICE tag is drawn from.
     */
    profile?: string;
    /**
     * v2. The device's own panel, as the worker observes it.
     *
     * Sent so a device CARD can show geometry and draw a correctly-shaped phone. Before this, screen
     * only ever reached a browser over the live data-plane socket, so anything outside an open
     * session fell back to 16:9 — which is not the shape of any phone made in the last decade.
     */
    screen?: { width: number; height: number; density: number };
    /**
     * v2. ABIs the device can execute, most-preferred first.
     *
     * The install preflight refuses an APK whose native libraries none of these can run, rather than
     * letting `adb install` fail with something that reads like a broken device. Optional: a worker
     * that does not report them keeps the old behaviour (install and find out) instead of having
     * every install blocked by an empty list.
     */
    abis?: string[];
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
 * What a heartbeat answers with.
 *
 * `resets` is the missing half of the reset story, added 2026-08-18 after B8. A released device is
 * parked in CLEANING and `allocate_device` will not hand it out again until a worker confirms the
 * restore — but until this field existed, **nothing ever told the worker to perform one**.
 * `Agent.resetAndRelease()` was fully implemented and had no caller, so a farm served exactly one
 * session per device and then reported `no_capacity` forever (HANDOFF.md issue 16).
 *
 * It rides the heartbeat rather than getting a route of its own because the beat is already the
 * control plane's one regular chance to correct a worker's picture of the world, it already carries
 * the worker credential, and a reset that is missed is retried on the next beat for free. There is
 * no acknowledgement here: the confirmation is `POST /workers/events` with `resets`, which is
 * fenced and idempotent, so re-sending the same request is harmless.
 */
export interface WorkerHeartbeatResponse {
  ok: boolean;
  hostState: string;
  /** Devices of THIS host sitting in CLEANING, with the fence to confirm against. */
  resets?: Array<{
    deviceId: string;
    fence: number;
    /**
     * The session that held this device at this fence, when there is one.
     *
     * v2.1. Optional so an older control plane — which sends no such field — still produces a valid
     * reset, and so a device reset by an operator rather than by a session release does not have to
     * invent one. A worker with no session id skips artifact capture and resets exactly as before.
     */
    sessionId?: string;
  }>;
  /**
   * App actions requested for THIS host's devices and not yet performed.
   *
   * Rides the beat for exactly the reasons `resets` does, and the reasoning is worth restating
   * because it is the second feature to reach for it and will not be the last. Traffic between a
   * worker and the control plane only ever flows one way — the worker dials out, and nothing on the
   * host listens for the control plane — so a job the control plane wants done has to be *offered*
   * rather than pushed. The beat already runs every 10s, already carries the worker credential, and
   * re-sends anything still pending, which makes a missed install self-healing at no cost.
   *
   * Like resets, there is no acknowledgement here: the confirmation is `POST /v1/workers/events`
   * with `actions`, which is scoped to the calling host and idempotent, so re-sending is harmless.
   */
  actions?: AppActionRequest[];
}

/**
 * What a worker may be asked to do to an app on one of its devices.
 *
 * One pipeline for four verbs, because each is a job the control plane cannot push and therefore
 * needs the same delivery, the same host scoping, the same fence check and the same sweep. Only
 * `install` moves bytes, and that is the single place they diverge.
 *
 * `screenshot` is the odd one and the reason the pipeline was generalised: it names no app. It
 * exists because the release-time screenshot is taken after Appium has force-stopped the app, so
 * the artifact a person opens to see why a test failed shows the launcher instead.
 */
export type AppActionKind = 'install' | 'launch' | 'uninstall' | 'screenshot';

/**
 * One app action for one device, as offered to the worker.
 *
 * Carries `sha256` because the worker VERIFIES the blob it downloads before handing it to adb. A
 * truncated download otherwise reaches `adb install` as a corrupt archive, and the failure it
 * produces names the app rather than the transfer — so the person reading it goes looking at their
 * build. The digest is also the cache key: a suite that installs the same build on both devices
 * downloads it once.
 */
export interface AppActionRequest {
  actionId: string;
  kind: AppActionKind;
  /** Control-plane uuid, not a local id. The worker maps it through its registration response. */
  deviceId: string;
  /**
   * Which session this action belongs to. Needed because a `screenshot` uploads an artifact, and an
   * artifact is filed against a session — the control plane knows which one, and a worker that
   * guessed from the device it holds would attach evidence to the wrong tenant the moment a device
   * changed hands mid-beat.
   */
  sessionId: string;
  /** Absent for `screenshot`, which is a picture of the screen rather than an act on an app. */
  appId?: string;
  /**
   * Present for every APP kind, and the ONLY thing `launch` and `uninstall` need — neither moves
   * bytes, so neither downloads anything and neither is authorised to. Absent for `screenshot`.
   */
  packageName?: string;
  /** Install only: the digest the worker verifies before handing the file to adb. */
  sha256?: string;
  sizeBytes?: number;
  /**
   * The device fence this install was requested under.
   *
   * The control plane already refuses to offer an install whose fence has moved on, so this is the
   * second lock rather than the first — and it is the one that still holds if a worker acts on a
   * beat it received before a reallocation it has not heard about yet.
   */
  fence: number;
}

/** What the worker reports back. `ok: false` carries adb's own words in `error`. */
export interface AppActionResult {
  actionId: string;
  ok: boolean;
  error?: string;
}

/**
 * A syntactically valid Android package name.
 *
 * Applied where a package name is READ OUT OF AN APK, which is a file a stranger uploaded. Nothing
 * downstream builds a shell command — every adb call passes argv, so there is no injection to
 * perform — but a package name is a well-defined thing and something that is not one has no
 * business reaching a device command, a database column or a UI. Rejecting it at the door is
 * cheaper than reasoning about every place it later travels to.
 */
export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

export function isValidPackageName(value: string): boolean {
  return value.length <= 255 && PACKAGE_NAME.test(value);
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
 * Deliberately strict about REQUIRED_FOR_TENANT_USE: a device that can reset by NEITHER mechanism
 * is not a cheap device, it is a device that leaks the previous tenant's state. It registers fine —
 * you want it visible and monitorable — but it is not schedulable.
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
    .filter((d) => canTakeTenantSession(d.capabilities))
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

/* ------------------------------------------------------------------------ the agent tunnel (v3)
 *
 * WHY THIS EXISTS. Until now the browser reached a device by dialling the worker: the console's
 * TLS ingress proxied `/dp/<hostId>` to one statically-configured address, and the worker ran a
 * WebSocket SERVER for it. That works for a device host you own and have a route to. It does not
 * work for the case physical devices actually arrive in — a phone on a teammate's laptop, behind
 * NAT, with nothing listening and no address to put in a config file.
 *
 * So the direction inverts. The AGENT dials out and holds one socket open; the control plane
 * multiplexes browser connections onto it as channels. Registration, the heartbeat and artifact
 * upload already worked this way, and for the same reason — this extends the rule rather than
 * adding an exception to it.
 *
 * WHAT IT IS NOT. It is not the private network ADR-0004 rejected. That ADR refused a VPN because
 * "a VPN authenticates the network, not the request", and nothing here authenticates a request.
 * The tunnel authenticates the AGENT and carries opaque bytes; every frame inside it still contains
 * the browser's own 120-second Ed25519 grant, and the AGENT still verifies it offline — signature,
 * audience, then fence — exactly as it does on a directly-dialled socket. The control plane relays
 * and does not get to decide. It is also not a widening of the trust boundary: the control-plane
 * host already sat in this path, because it is where the ingress that proxied `/dp/*` runs.
 */

/** Where the agent dials. One socket per host, re-dialled with backoff. */
export const TUNNEL_PATH = '/v1/workers/tunnel';

/**
 * One frame on the tunnel.
 *
 * `ch` is allocated by the CONTROL PLANE, which is the only side that opens channels — a browser
 * arrives there, never at the agent. That makes the id space single-writer, so there is no
 * collision rule to get wrong and no handshake to lose.
 *
 * `d` is the data-plane message verbatim: the JSON the browser sent, or the JSON the worker is
 * answering with. Deliberately a string rather than a parsed object, so that relaying cannot
 * become inspecting by accident — a control plane that re-serialised these would be one refactor
 * away from editing them.
 */
export type TunnelFrame =
  | { ch: number; t: 'open'; kind?: TunnelChannelKind }
  | { ch: number; t: 'data'; d: string }
  | { ch: number; t: 'close'; reason?: string };

/**
 * What a channel carries.
 *
 * ABSENT MEANS `dp`, and that is a compatibility rule rather than a default worth having: an agent
 * built before ADR-0011 hands every channel it is opened to the data plane, so a control plane that
 * omits the field keeps working against it unchanged. A new agent reads it, and the only reason a
 * new control plane ever sends `automation` is that the device advertised a `mfarm+tunnel:`
 * endpoint — which only a new agent does. The skew resolves itself without a version check.
 */
export type TunnelChannelKind = 'dp' | 'automation';

/**
 * A frame is small: data-plane messages are input events, signalling payloads and batched log
 * lines. A screenshot is the one exception and is already base64 in a JSON field on the existing
 * path, which is why this is generous rather than tight. Anything larger is a bug or an attack,
 * and dropping the tunnel is the honest response to both.
 */
export const TUNNEL_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function isTunnelFrame(v: unknown): v is TunnelFrame {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  if (typeof f.ch !== 'number' || !Number.isInteger(f.ch) || f.ch < 0) return false;
  if (f.t === 'open') {
    // An unrecognised kind is REFUSED rather than read as `dp`. Falling back would hand a future
    // channel type to the data plane, which answers it with a five-second hello timeout instead of
    // an error anybody can read.
    return f.kind === undefined || f.kind === 'dp' || f.kind === 'automation';
  }
  if (f.t === 'close') return true;
  return f.t === 'data' && typeof f.d === 'string';
}

/* ------------------------------------------------------- automation over the tunnel (ADR-0011)
 *
 * WHY. ADR-0004 put the automation gateway on the worker's own public listener, and ADR-0008 then
 * inverted the data plane because a phone arrives on a laptop behind NAT with no address to dial.
 * Automation was left on the old path, so `gatewayBase()` still demanded a publicly reachable
 * hostname — which a laptop cannot supply, and which contradicts ADR-0009 §3's claim that nothing
 * listens on the network. This carries automation on the socket the agent already holds open.
 *
 * WHAT IS UNCHANGED, and it is the whole point: the gateway. The agent replays a tunnelled request
 * against its OWN gateway on loopback, Authorization header included, so the signature check, the
 * audience check, the device check and the fence check all still run in `gateway.ts` and nowhere
 * else. An authorization check that exists twice is a check that will eventually disagree with
 * itself — ADR-0008 said that about the data plane, and it is why this is a transport change only.
 */

/**
 * Scheme for an automation endpoint that is only reachable through the host's tunnel.
 *
 * A scheme rather than a flag column because `automation_endpoint` is ALREADY the one string that
 * says how to reach a device's automation, and the hub already concatenates onto it. Anything that
 * left it looking like an ordinary url would be a url the hub could try to `fetch` — this cannot be
 * dialled by accident, because nothing in Node knows what to do with it.
 */
export const AUTOMATION_TUNNEL_SCHEME = 'mfarm+tunnel:';

/**
 * What a tunnel-only agent advertises for a device.
 *
 * Carries NO authority component, and that is deliberate: the agent composes this before it has
 * registered, so it does not yet know its own host id. It does not need to — the hub reads the host
 * from `devices.host_id`, which it has already joined for the grant's `aud`.
 */
export function tunnelAutomationEndpoint(localId: string): string {
  return `${AUTOMATION_TUNNEL_SCHEME}${automationPath(localId)}`;
}

/**
 * The origin-form request target for a tunnelled automation url, or undefined if it is an ordinary
 * one that should be fetched directly.
 *
 * A prefix strip rather than `new URL`: for a non-special scheme the WHATWG parser has opinions
 * about path normalisation that would silently rewrite an element id, and the hub's whole contract
 * with a driver is that what it sent is what Appium sees.
 */
export function parseTunnelAutomationUrl(url: string): string | undefined {
  if (!url.startsWith(AUTOMATION_TUNNEL_SCHEME)) return undefined;
  const target = url.slice(AUTOMATION_TUNNEL_SCHEME.length);
  return target.startsWith(`${AUTOMATION_PREFIX}/`) ? target : undefined;
}

/**
 * What a tunnel-only agent advertises for its DATA plane — the sibling of the automation form above.
 *
 * `hosts.endpoint` is "where a program on the network dials this worker", and a laptop behind NAT
 * has no answer to that. ADR-0008 had already inverted the data plane for exactly this case: the
 * browser reaches the host at `/dp/<hostId>` through the control plane's ingress, over the socket
 * the agent dialled out. The endpoint column simply never caught up, so `PUBLIC_ENDPOINT` stayed a
 * hard requirement and the agent refused to start without a routable address it cannot have.
 *
 * Like the automation form, this carries NO authority and NO host id. The agent composes it before
 * it has registered; the control plane already knows which host is asking, because it is the one
 * holding the tunnel.
 */
export const DATA_PLANE_PREFIX = '/dp';
export const DATA_PLANE_TUNNEL_ENDPOINT = `${AUTOMATION_TUNNEL_SCHEME}${DATA_PLANE_PREFIX}`;

/** Whether a host's `endpoint` means "through my tunnel" rather than a dialable address. */
export function isTunnelledDataPlane(endpoint: string | null | undefined): boolean {
  return endpoint === DATA_PLANE_TUNNEL_ENDPOINT;
}

/**
 * One message on an `automation` channel.
 *
 * Request and response are both streamed as a head frame, then zero or more body chunks, then an
 * end. Chunked because a tunnel frame is capped at 8 MB while the hub's body limit is 16 MB — a
 * `pushFile` of a large APK is a real request that a single-frame encoding would drop, and it would
 * drop it as a mysterious closed channel rather than as a 413.
 *
 * Bodies are base64, so the codec never has to care whether a payload is text. `err` exists so an
 * agent-side failure arrives as a message the hub can put in a WebDriver error, rather than as a
 * channel that closed for no stated reason.
 */
export type AutomationFrame =
  | { k: 'req'; method: string; path: string; headers: Record<string, string> }
  | { k: 'res'; status: number; headers: Record<string, string> }
  | { k: 'd'; b: string }
  | { k: 'end' }
  | { k: 'err'; message: string };

/**
 * Raw bytes per body chunk before base64.
 *
 * 512 KB inflates to ~683 KB encoded, an order of magnitude under `TUNNEL_MAX_FRAME_BYTES`. The
 * headroom is the point: the frame also carries JSON overhead, and a limit that is only just met is
 * one refactor away from not being met.
 */
export const AUTOMATION_CHUNK_BYTES = 512 * 1024;

export function isAutomationFrame(v: unknown): v is AutomationFrame {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  switch (f.k) {
    case 'req':
      return typeof f.method === 'string' && typeof f.path === 'string'
        && typeof f.headers === 'object' && f.headers !== null;
    case 'res':
      return typeof f.status === 'number' && Number.isInteger(f.status)
        && typeof f.headers === 'object' && f.headers !== null;
    case 'd':
      return typeof f.b === 'string';
    case 'end':
      return true;
    case 'err':
      return typeof f.message === 'string';
    default:
      return false;
  }
}

/* --------------------------------------------------------------- why something failed (spec §18)
 *
 * WHY THIS EXISTS. A test that failed because the assertion was wrong and a test that "failed"
 * because somebody's foot caught the USB cable are the same row today: `status: 'failed'`, with
 * whatever WebDriver error the suite happened to catch in the text. So a run's failure count mixes
 * the product's problems with the farm's, and the number that is supposed to answer "is my app
 * broken" cannot be trusted to. §18 calls this essential, and it is right — a physical-device farm
 * that reports infrastructure as product defects teaches people to ignore red.
 *
 * TWO SOURCES, AND THEY KNOW DIFFERENT THINGS. That split is the whole design:
 *
 *   The SUITE knows whether an assertion failed or the app under test crashed. It is the only thing
 *   that knows, and it says so on `POST /sessions/:id/result`.
 *
 *   The FARM knows the adb connection dropped, Appium had to be restarted, the phone fell below a
 *   usable battery. The suite CANNOT know these — it sees a WebDriver call fail and nothing more —
 *   so the agent records them itself, as incidents against the session.
 *
 * NEITHER OVERWRITES THE OTHER, and that is deliberate. The tempting version reclassifies a failed
 * test as infrastructure when an incident overlaps it, and that is inference dressed as fact in
 * exactly the way migration 021 refuses to infer pass/fail: a test can genuinely fail an assertion
 * during a session that also had a cable glitch, and silently relabelling it hides a real defect.
 * So both are recorded and the console shows the correlation, which is a claim a person can weigh.
 */

/** The three buckets §18 asks for. `test` is the only one that is the product's fault. */
export const FAILURE_CLASSES = ['test', 'infrastructure', 'device-health'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * The specific reason, within its class.
 *
 * A closed list, because the point of this is aggregation — "how many runs did this farm lose to
 * USB last week" is unanswerable over free text. Unknown reasons from a newer agent are ignored
 * rather than rejected, the same rule as capabilities, so a new one can roll out worker-first.
 */
export const FAILURE_REASONS = {
  test: ['assertion-failure', 'application-crash'],
  infrastructure: [
    'adb-failure', 'appium-failure', 'device-disconnected', 'usb-failure',
    'agent-failure', 'network-failure',
    // The device REFUSED the install rather than failing at it — Play Protect's package verifier
    // rejecting an APK pushed over adb. It is infrastructure and not a test failure because the
    // suite never ran: nothing about the app was exercised, and reporting it as a test result
    // would blame the product for a setting on the phone. It has its own name rather than sharing
    // `adb-failure` because it is the one install failure with a specific, actionable remedy, and
    // it is common enough that "how many devices in this fleet cannot install anything" is a
    // question somebody will need answered.
    'install-blocked',
  ],
  'device-health': ['low-storage', 'low-battery', 'device-locked', 'device-unresponsive'],
} as const satisfies Record<FailureClass, readonly string[]>;

export type FailureReason = (typeof FAILURE_REASONS)[FailureClass][number];

/** Every reason, flattened — what a CHECK constraint and a body schema both need. */
export const ALL_FAILURE_REASONS: readonly string[] =
  Object.values(FAILURE_REASONS).flat();

/**
 * Which class a reason belongs to.
 *
 * Derived rather than stored alongside it, so the two cannot disagree. A caller that sends
 * `device-disconnected` with class `test` is not making a judgement call this system should
 * respect — it is sending a contradiction, and `classifyReason` is what the API checks it against.
 */
export function classifyReason(reason: string): FailureClass | undefined {
  for (const cls of FAILURE_CLASSES) {
    if ((FAILURE_REASONS[cls] as readonly string[]).includes(reason)) return cls;
  }
  return undefined;
}

/**
 * Is this failure the farm's fault rather than the product's?
 *
 * The question every report ultimately asks, in one place so the console, the run rollup and any
 * future alerting cannot each answer it slightly differently.
 */
export function isFarmFault(cls: FailureClass): boolean {
  return cls !== 'test';
}
