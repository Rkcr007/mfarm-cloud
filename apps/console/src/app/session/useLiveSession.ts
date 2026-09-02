/**
 * The React binding. Deliberately thin — every rule worth testing lives in `LiveController`.
 *
 * `useSyncExternalStore` rather than `useState` + a subscription effect, because the connection is
 * exactly what that hook is for: state owned outside React, changing on its own clock. It also
 * removes the tearing case where a stats tick lands between a render and its commit.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { LiveController, armUnloadGuard, type LiveSnapshot, type LiveTarget } from './liveController.ts';

export type { LiveSnapshot, LiveTarget };

export interface UseLiveSession {
  live: LiveSnapshot;
  /** Ref callback for the `<video>`. Attaches input once, per element. */
  videoRef: (el: HTMLVideoElement | null) => void;
  retry: () => void;
  pressButton: (command: string) => boolean;
  sendControl: (msg: Record<string, unknown>) => boolean;
}

/**
 * Hold a live connection to `target` for as long as this component is mounted.
 *
 * Pass `null` to hold nothing — that is the ordinary state of the screen before anyone starts a
 * session, and it must not construct a connection that immediately fails.
 */
export function useLiveSession(target: LiveTarget | null): UseLiveSession {
  // One controller for the life of the component. `useMemo` is not a guarantee, but the controller
  // is inert until `start()`, so a discarded one costs nothing and holds nothing.
  const controller = useMemo(() => new LiveController(), []);
  const videoEl = useRef<HTMLVideoElement | null>(null);

  const subscribe = useCallback((fn: () => void) => controller.subscribe(fn), [controller]);
  const live = useSyncExternalStore(subscribe, () => controller.snapshot, () => controller.snapshot);

  /**
   * Depend on the FIELDS, not the object.
   *
   * A parent that builds `{sessionId, url, token}` inline hands a new object every render. Keying
   * the effect on that identity would tear down and re-negotiate the stream on every unrelated
   * state change in the page — a black flash and a fresh ICE round trip because a log line arrived.
   */
  const { sessionId, url, token } = target ?? { sessionId: '', url: '', token: '' };
  const iceServers = target?.iceServers;
  const iceKey = iceServers ? JSON.stringify(iceServers) : '';

  useEffect(() => {
    if (!sessionId || !url) return;
    controller.start({ sessionId, url, token, iceServers: iceKey ? JSON.parse(iceKey) : undefined });
    // The video element usually exists before the connection does, so the attach that matters is
    // this one; the ref callback covers the reverse order.
    controller.attach(videoEl.current);
    const disarm = armUnloadGuard(controller);
    return () => { disarm(); controller.stop(); };
  }, [controller, sessionId, url, token, iceKey]);

  const videoRef = useCallback((el: HTMLVideoElement | null) => {
    videoEl.current = el;
    controller.attach(el);
  }, [controller]);

  /**
   * Put the stream on the element.
   *
   * `srcObject` is a property, not an attribute, so React cannot set it from JSX — this effect is
   * the only way the media reaches the element. Guarded on identity so a re-render does not reassign
   * the same stream, which restarts decoding and shows a visible stutter.
   */
  useEffect(() => {
    const el = videoEl.current;
    if (!el) return;
    if (live.stream && el.srcObject !== live.stream) {
      el.srcObject = live.stream;
      // Autoplay is only permitted because the stream is muted; Cuttlefish sends an audio track and
      // an unmuted autoplay is refused by every browser, which reads as "the video is broken".
      el.play?.().catch(() => { /* a paused element is recoverable; a thrown promise is noise */ });
    }
    if (!live.stream && el.srcObject) el.srcObject = null;
  }, [live.stream]);

  const retry = useCallback(() => controller.retryNow(), [controller]);
  const pressButton = useCallback((c: string) => controller.pressButton(c), [controller]);
  const sendControl = useCallback((m: Record<string, unknown>) => controller.sendControl(m), [controller]);

  return { live, videoRef, retry, pressButton, sendControl };
}
