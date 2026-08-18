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

  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  key(name: 'home' | 'back' | 'recents' | 'power' | 'enter' | 'backspace'): Promise<void>;
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
}

export interface DeviceBackend {
  control: DeviceControl;
  media: MediaSource;
}
