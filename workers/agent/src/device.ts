import type { Capability, FailureReason } from '@mfarm/protocol';

/**
 * The device abstraction — v2 decision 4, and deliberately NOT the v1 `DeviceAdapter`.
 *
 * v1 proposed one fat interface returning `Buffer` and `AsyncIterable` across what becomes a network
 * boundary, with every device expected to implement every method. That holds for two emulators and
 * shatters at the first physical device, leaving adapters full of `throw new NotSupported()`.
 *
 * Split three ways instead:
 *
 *   DeviceControl  narrow, typed, idempotent request/response. No media, no streams.
 *   MediaSource    entirely out of band. Never in the same interface as tap().
 *   capabilities   devices DECLARE what they support; the platform degrades gracefully.
 */

export interface Screen {
  width: number;
  height: number;
  density: number;
}

export interface DeviceInfo {
  localId: string;
  platform: 'android' | 'ios';
  tier: 'cuttlefish' | 'avd' | 'container' | 'simulator' | 'physical';
  model: string;
  osVersion: string;
  capabilities: Capability[];
  screen: Screen;
  /**
   * Which device profile this one was configured from, if any (ADR-0016).
   *
   * A STABLE KEY, NOT A NAME — the console keys its bezel art off it, and matching that on the
   * human-readable model string would break the moment a marketing name is retyped. Absent on every
   * unprofiled device, which is most of them: physical handsets ARE the real device and need no
   * profile, and `cf-1`/`cf-2` deliberately have none.
   */
  profile?: string;
  /**
   * ABIs the device can execute, most-preferred first — `ro.product.cpu.abilist`.
   *
   * Published so an APK carrying only `lib/arm64-v8a/` can be refused before it is pushed, with the
   * reason said out loud. Optional because a tier that has not been taught to report it should
   * degrade to today's behaviour (install and find out) rather than have every install blocked by an
   * empty list.
   */
  abis?: string[];
  /**
   * The serial the platform's own tooling matches on — `0.0.0.0:6520` for Cuttlefish,
   * `emulator-5560` for an AVD, a hardware serial for a physical handset.
   *
   * Distinct from `localId`, and the distinction is the whole of blocker B3. `localId` is OUR name
   * for the device (`cf-1`) and is what the control plane, the metering rows and the gateway path
   * use. UiAutomator2 has never heard of it: it matches `appium:udid` against the adb serial, so a
   * session created with the local id targets nothing and fails on a real driver.
   *
   * Optional because a tier may genuinely not have one (iOS simulators use a UDID, not adb). A
   * device that does not report one cannot serve WebDriver — the hub refuses rather than guessing,
   * because on a multi-device host a guess can land on another tenant's device.
   */
  adbSerial?: string;
}

/**
 * The keys a device can be asked to press.
 *
 * Volume joined this list with the device toolbar (ADR-0007): Cuttlefish's WebRTC control channel
 * carries power, home, menu and back and nothing else, so every other button a real device toolbar
 * has must come down this path instead.
 */
export type KeyName =
  | 'home' | 'back' | 'recents' | 'power' | 'enter' | 'backspace'
  | 'volume_up' | 'volume_down';

/**
 * `reason` is for a human; `reasonCode` is for aggregation (spec §18).
 *
 * Both, rather than one derived from the other. Sniffing the prose for the word "battery" is a
 * classifier that breaks the first time somebody rewords a message, and it puts the taxonomy in the
 * hands of the code FURTHEST from the evidence. The backend saw the `dumpsys` output; it is the
 * thing that knows whether this was a battery or a disk, so it says so.
 *
 * `reasonCode` is optional because the older tiers do not set it and a health report without a code
 * is still worth having — it just aggregates as an unclassified device-health event rather than as
 * a low battery.
 */
export type DeviceHealth =
  | { status: 'healthy'; inputLatencyMs: number }
  | { status: 'degraded'; reason: string; reasonCode?: FailureReason; inputLatencyMs?: number }
  | { status: 'offline'; reason: string; reasonCode?: FailureReason };

/**
 * A finished screen recording, as a file on the device host.
 *
 * A PATH, NEVER BYTES, for `installApp`'s reason inverted: the agent uploads this by streaming it,
 * and a `Buffer` here would put a whole recording through the agent's heap on the way to an HTTP
 * request that only wanted a file.
 */
export interface Recording {
  path: string;
  bytes: number;
  /** Host wall clock when recording began — see `startRecording`. */
  startedAt: number;
  stoppedAt: number;
  /**
   * The recorder did not stop cleanly, so the container may have no duration and no cues.
   *
   * Carried rather than thrown, because a partial recording of a device that crashed is often the
   * most valuable artifact a session produces. It must never be presented as the complete record of
   * an execution, which is what this flag exists to prevent.
   */
  partial: boolean;
}

export interface DeviceControl {
  readonly info: DeviceInfo;

  /** Bring the device up. Prefers snapshot restore over cold boot where the backend supports it. */
  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * Reset by SNAPSHOT RESTORE (v2 decision 5).
   *
   * Not a cleanup script. Uninstalling an app leaves accounts, keychain items, clipboard contents,
   * WebView caches and granted permissions behind, and this device is about to be handed to a
   * different tenant. Measured on an M1: 2.9s restore vs 35.5s cold boot, so this is also what makes
   * per-second billing viable.
   */
  resetToSnapshot(): Promise<void>;

  /**
   * Install an APK that is already on THIS host's disk.
   *
   * OPTIONAL, and that is the interface decision this file exists to make (v2 decision 4). An iOS
   * simulator does not take an APK, a physical device behind a lab firewall may not accept a
   * sideload at all, and the alternative — a required method every backend implements as
   * `throw new NotSupported()` — is exactly the fat interface the class comment above rejects.
   *
   * A backend that implements it declares `app-install`; a backend that does not, does not, and the
   * control plane refuses the install request rather than queueing a job nobody can run.
   *
   * Takes a PATH, never bytes. The agent has already downloaded and verified the blob, and an
   * `installApp(Buffer)` would put a 200 MB APK through the agent's heap on the way to a tool that
   * only wanted a filename.
   */
  installApp?(apkPath: string): Promise<void>;

  /**
   * Bring an installed app to the foreground. No-op-safe to call twice.
   *
   * Separate from `installApp` rather than an option on it, because the two fail for entirely
   * different reasons — an install fails on the package, a launch fails on the *device* having no
   * launcher activity for it — and a caller that wants "install then open" wants to know which of
   * the two went wrong.
   */
  launchApp?(packageName: string): Promise<void>;

  /** Remove an app and its data. Uninstalling something that is not there is an error, not a no-op. */
  uninstallApp?(packageName: string): Promise<void>;

  /**
   * Stream this device's log until the returned handle is stopped.
   *
   * OPTIONAL for the same reason `installApp` is: an iOS simulator has no logcat, and a required
   * method every backend answers with `throw new NotSupported()` is the fat interface this file
   * exists to reject. A backend that implements it declares `logcat`.
   *
   * Push, not pull. The alternative — a `readLogcat(since)` the console polls — means either
   * buffering the whole log in the worker or losing the lines between two polls, and the thing a
   * person watches a log for is the line that appears while they are watching.
   */
  captureLogcat?(onLine: (line: string) => void): Promise<LogcatHandle>;

  /**
   * The device's whole log buffer, right now, as one string.
   *
   * DELIBERATELY NOT `captureLogcat` with a timer around it. The two answer different questions and
   * fail differently: a stream is for a person watching a device and it starts from the moment they
   * looked, while this is for the artifact a finished session leaves behind and it wants everything
   * the run produced. A session on a powerwashed device starts with an empty buffer, so a dump at
   * release time IS that session's log — with no capture process to keep alive for its duration, and
   * nothing to lose if the worker restarts mid-session.
   *
   * Optional for the same reason the rest are: a backend with no logcat does not implement it and
   * does not declare `logcat`.
   */
  dumpLogcat?(): Promise<string>;

  /**
   * Turn the device, the way a person turns a phone.
   *
   * OPTIONAL, and on Cuttlefish it is a sensor injection rather than a display command — the guest
   * has to believe gravity moved, or Android rotates nothing. A backend with no accelerometer to
   * lie to does not implement it, and the toolbar does not offer it.
   */
  rotate?(direction: 'left' | 'right'): Promise<void>;

  /**
   * The view tree currently on screen, as the platform's own XML.
   *
   * EXISTS BECAUSE SELECTORS HAVE TO COME FROM SOMEWHERE. A person writing an Appium test needs to
   * know what is on the screen and what identifies it, and on a Compose app there is nothing to
   * guess from — Compose emits no resource-ids at all, so `findElement(By.id(...))` has nothing to
   * match and the only usable handles are text and content-desc. Without this the answer is "dump
   * the page source over the WebDriver API and read XML by hand", which is a thing people do and
   * should not have to.
   *
   * Returns the raw document rather than a parsed tree: the shape differs per platform, the console
   * is the only consumer, and a parser in the worker would be a second place to keep in step with
   * whatever Android emits next.
   *
   * OPTIONAL, like every other capability here. A backend that implements it declares
   * `ui-hierarchy`; one that does not, does not, and the console offers no inspector rather than an
   * inspector that never fills.
   */
  uiHierarchy?(): Promise<string>;

  /**
   * One frame, right now, as encoded image bytes.
   *
   * Deliberately NOT a way to build a video: it shells out, it costs a round trip and an encode,
   * and a caller that wants motion wants `screen-stream`. It exists because "what was on screen
   * when it failed" is a different question from "show me the device", and it is the only one of
   * the two that survives the session ending.
   */
  screenshot?(): Promise<{ bytes: Buffer; contentType: string }>;

  /**
   * Begin recording this device's screen, and answer with the instant recording began.
   *
   * OPTIONAL, and on Cuttlefish it is emphatically NOT `screenrecord`. `deploy/measure-encode-cost.mjs`
   * measured guest-side encode costing the Flutter canvas a third of its frame rate and doubling
   * dropped frames on ordinary UI, so a recorder that runs inside the guest changes what the test
   * observes — which is the one thing evidence must never do (ADR-0027, docs/VIDEO_EVIDENCE.md).
   * The Cuttlefish implementation drives cvd's own host-side recorder and the guest is not involved.
   *
   * A backend that implements this pair declares `recording`. That capability spent months in
   * `CAPABILITIES` with nothing behind it — the one place this codebase broke ADR-0003's rule that a
   * capability is observed state — so it is declared only where the recorder is actually present on
   * disk, never from configuration.
   *
   * `startedAt` IS THE WHOLE TIMESTAMP MODEL. A WebM stamps its first frame at zero, so the only
   * thing relating a video position to a test event is this anchor: `position = eventAt − startedAt`.
   * It is host wall clock, taken as close to the first frame as this side can observe, and it is
   * accurate to about a frame interval — not to a millisecond. Anything presented as more precise
   * than that is presenting a guess.
   */
  startRecording?(): Promise<{ startedAt: number }>;

  /**
   * Stop recording and either keep the file or destroy it.
   *
   * `keep` IS A PARAMETER RATHER THAN A SEPARATE `discard()` FOR ONE REASON: video is only
   * affordable if the overwhelming majority of recordings are deleted (a saturated two-device farm
   * fills the control plane's disk in ~1.3 days at §4.4's arithmetic). A caller that has to remember
   * a second call to delete will eventually forget, and the failure mode of forgetting is a full
   * disk that takes the database with it. Here the deletion is the default path through the code.
   *
   * Returns null when there is nothing to hand over — nothing was recording, no file appeared, or
   * `keep` was false and the file has been deleted. Never returns a path that no longer exists.
   */
  stopRecording?(opts: { keep: boolean }): Promise<Recording | null>;

  /**
   * Put the recorder back in a known state: stop anything this agent did not start, and delete
   * recordings old enough that nothing is coming for them.
   *
   * WHY THIS EXISTS AT ALL. `stopRecording` is reached from exactly one place — the teardown that
   * runs when a device is released — and there are three ways to miss it:
   *
   *   1. the agent restarts mid-session. The handle to the running recorder is in memory, so after
   *      a restart nothing knows a recorder is running or which file is its. It records forever.
   *   2. a quarantine recovery resets the device down a different branch, which has no session to
   *      attach a recording to and used to skip the stop entirely.
   *   3. the upload fails. The file is then referenced by nothing — no artifact row names it — so
   *      it is invisible to every other cleanup in the system.
   *
   * ADR-0032 argues there is no `video-stop` verb *because* the teardown "runs on every path a
   * session can end". That was written about the paths a SESSION takes and is false about the
   * paths an AGENT takes. This is the reconciliation that makes the claim true — the same shape as
   * the reset sweep: a loop that converges on the desired state rather than a promise that every
   * caller remembers.
   *
   * MUST NOT TOUCH A LIVE RECORDING. A device recording right now has a file whose mtime is moving
   * and an in-memory handle; both are how an implementation tells the two apart.
   */
  reconcileRecordings?(
    maxAgeMs: number,
    opts?: {
      /**
       * Also issue a blind stop, for a recorder this process cannot know about.
       *
       * TRUE AT STARTUP AND NOWHERE ELSE. At startup a running recorder cannot be ours, because we
       * have started none — so stopping one is unambiguous. On any later call it could be a
       * recording in progress on another device path, and a housekeeping pass that can stop a live
       * recording is worse than the leak it is cleaning up.
       */
      stopOrphans?: boolean;
    },
  ): Promise<{ stopped: boolean; deleted: number }>;

  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  key(name: KeyName): Promise<void>;
  text(value: string): Promise<void>;

  health(): Promise<DeviceHealth>;
}

/**
 * Media, kept strictly out of band.
 *
 * For Cuttlefish the media path is Cuttlefish's own WebRTC stack: the browser negotiates with it
 * directly, and this interface only reports where and whether. The agent never touches frames — a
 * transcode in the agent would turn a ~70ms pipeline into ~300ms and burn the CPU that device
 * density depends on.
 */
export interface MediaSource {
  /** null when the backend cannot stream at all, which the capability list must also reflect. */
  endpoint(): Promise<{ url: string; kind: 'webrtc' } | null>;

  /**
   * Open a signaling channel to whatever negotiates this device's stream (ADR-0007).
   *
   * The worker relays the frames of this conversation between the browser and the device's own
   * WebRTC stack and reads none of them. That is the whole contract: `send` takes an opaque payload
   * from the client, `onPayload` hands opaque payloads back, and the media itself never appears
   * here — it is negotiated to flow directly between the browser and the device host.
   *
   * Optional, and its absence is what a tier without a live view looks like. `endpoint()` returning
   * null and `signal` being undefined say the same thing from two directions; both are honest.
   */
  signal?(opts: SignalOptions): Promise<SignalChannel>;
}

export interface SignalOptions {
  onPayload: (payload: unknown) => void;
  /** Called once when the far side goes away, with a reason to show a human. */
  onClose: (reason: string) => void;
}

export interface SignalChannel {
  /** What the device's own signaling server said about itself when the channel opened. */
  readonly deviceInfo: unknown;
  /**
   * ICE servers the device's host suggests. Advisory only — the control plane's minted TURN
   * credentials take precedence, because those expire with the session and these do not.
   */
  readonly iceServers: unknown[];
  send(payload: unknown): void;
  close(): void;
}

export interface LogcatHandle {
  stop(): void;
}

export interface DeviceBackend {
  control: DeviceControl;
  media: MediaSource;
}
