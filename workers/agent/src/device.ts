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
