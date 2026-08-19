import type { Capability } from '@mfarm/protocol';

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

export type DeviceHealth =
  | { status: 'healthy'; inputLatencyMs: number }
  | { status: 'degraded'; reason: string; inputLatencyMs?: number }
  | { status: 'offline'; reason: string };

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
   * Turn the device, the way a person turns a phone.
   *
   * OPTIONAL, and on Cuttlefish it is a sensor injection rather than a display command — the guest
   * has to believe gravity moved, or Android rotates nothing. A backend with no accelerometer to
   * lie to does not implement it, and the toolbar does not offer it.
   */
  rotate?(direction: 'left' | 'right'): Promise<void>;

  /**
   * One frame, right now, as encoded image bytes.
   *
   * Deliberately NOT a way to build a video: it shells out, it costs a round trip and an encode,
   * and a caller that wants motion wants `screen-stream`. It exists because "what was on screen
   * when it failed" is a different question from "show me the device", and it is the only one of
   * the two that survives the session ending.
   */
  screenshot?(): Promise<{ bytes: Buffer; contentType: string }>;

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
