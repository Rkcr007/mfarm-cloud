/**
 * Who owns the socket — the half of the live view that React must not be trusted with.
 *
 * `LiveSession` (`apps/api/public/live.js`, shared with the old console rather than copied) already
 * knows how to negotiate media and push input. What it does NOT know is when it should exist. In
 * the old console that was answered by a plain module variable and a `closeLive()` called from a
 * router; in React it is answered by effects, which run twice in development, run again on every
 * dependency change, and do not run at all when the tab is closed.
 *
 * So the lifecycle lives here, in a plain class with no React in it, and the hook is a thin binding.
 * That split is not tidiness — it is what makes the rules below testable without a renderer, and
 * every one of them is a way this connection leaks:
 *
 *   1. ONE SOCKET PER CONTROLLER. `start()` twice is one connection. React 19 StrictMode invokes
 *      every effect twice on mount in development, so a controller that connected per call would
 *      hold two channels against `MAX_CHANNELS_PER_HOST` for every device anyone opened.
 *   2. A SUPERSEDED SESSION CANNOT SPEAK. Callbacks are gated on a generation counter, so a state
 *      or stream event from a connection we already replaced is dropped rather than painting the
 *      previous device's frame onto the current one.
 *   3. STOPPING IS FINAL. `stop()` closes and disarms reconnect. A socket that fails *while* we are
 *      tearing down must not schedule a retry that outlives the component.
 *   4. THE TAB CLOSING IS A DISCONNECT. See `armUnloadGuard`.
 *
 * WHY THIS MATTERS MORE HERE THAN IT WOULD ELSEWHERE. ADR-0021 made both ends of the *agent* tunnel
 * ping, but it deliberately left browser data-plane channels unpinged — a viewer that vanishes
 * without a TCP FIN holds its channel until the OS notices, and the farm caps channels per host.
 * A leaked viewer is therefore not a wasted socket, it is a device nobody else can watch. The old
 * console got away with a looser story because a full page navigation tears its socket down for it.
 * A single-page app has no such backstop, which is exactly why this file exists.
 */
import {
  LiveSession,
  type LiveScreen, type LiveScreenshot, type LiveState, type LiveStats,
} from '../../../../api/public/live.js';

/** What the view needs to render. Everything here is derived from the connection, never guessed. */
export interface LiveSnapshot {
  state: LiveState | 'idle';
  detail: string | null;
  stream: MediaStream | null;
  stats: LiveStats;
  /**
   * The panel the WORKER reports for this session, which outranks the registered one.
   *
   * THIS IS A TAP-ACCURACY FIELD, not a display detail, and it is the reason it is carried at all.
   * `live.js` scales a touch by `videoWidth / offsetWidth` and consults no height, which is correct
   * only while the element preserves the stream's aspect ratio. The element's ratio comes from
   * whatever geometry the stage is given — so handing it the REGISTERED panel while the device is
   * encoding a different one letterboxes the video inside its own box, and then `offsetWidth` is
   * the box rather than the picture and every coordinate is wrong by the crop.
   *
   * The old console makes the same choice in `paintFrame`: "the live socket's screen wins over the
   * registered one because it is the panel the stream is actually being encoded from".
   *
   * Null until the worker's `ready` arrives, which is why the caller falls back rather than waits.
   */
  screen: LiveScreen | null;
  /** Non-fatal messages, newest last. A refused rotate belongs here, not in `detail`. */
  notices: string[];
  /** How many times we have re-dialled since the last clean connect. Surfaced so a flapping link is visible. */
  retries: number;
}

export interface LiveTarget {
  /** Distinguishes one connection from the next. A change here means tear down and re-dial. */
  sessionId: string;
  url: string;
  token: string;
  iceServers?: RTCIceServer[];
}

const IDLE_STATS: LiveStats = { fps: 0, kbps: 0, rtt: null, ice: null };

/**
 * Backoff for an UNEXPECTED drop only.
 *
 * Capped and finite. An unbounded retry against a device whose lease has ended is the same mistake
 * ADR-0019 bounded on the reset path: the farm cannot tell "retrying" from "wedged", and a viewer
 * left open overnight would dial forever. After the last delay the view says it gave up and offers
 * the person the retry, which is a decision a person should be making by then anyway.
 */
export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

export interface LiveControllerOptions {
  /** Injected in tests. Defaults to the real thing. */
  createSession?: (o: ConstructorParameters<typeof LiveSession>[0]) => LiveSession;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: unknown) => void;
}

export class LiveController {
  #target: LiveTarget | null = null;
  #session: LiveSession | null = null;
  #generation = 0;
  #stopped = false;
  #retries = 0;
  #retryHandle: unknown = null;
  #snapshot: LiveSnapshot = {
    state: 'idle', detail: null, stream: null, stats: IDLE_STATS,
    screen: null, notices: [], retries: 0,
  };
  #listeners = new Set<(s: LiveSnapshot) => void>();
  #attached: HTMLVideoElement | null = null;
  #opts: Required<LiveControllerOptions>;

  constructor(opts: LiveControllerOptions = {}) {
    this.#opts = {
      createSession: opts.createSession ?? ((o) => new LiveSession(o)),
      setTimeoutFn: opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeoutFn: opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
  }

  /* ------------------------------------------------------------------ subscription */

  subscribe(fn: (s: LiveSnapshot) => void): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  /** Referentially stable between changes, so `useSyncExternalStore` does not loop. */
  get snapshot(): LiveSnapshot { return this.#snapshot; }

  #emit(patch: Partial<LiveSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const fn of this.#listeners) fn(this.#snapshot);
  }

  /* ------------------------------------------------------------------ lifecycle */

  /**
   * Connect to `target`, or do nothing if already connected to it.
   *
   * The identity check is on `sessionId`, not on object identity: React hands a fresh object every
   * render, and re-negotiating under someone's finger because a parent re-rendered is precisely the
   * bug the old console's `ensureLive` comment warns about.
   */
  start(target: LiveTarget): void {
    if (this.#session && this.#target?.sessionId === target.sessionId && !this.#stopped) return;
    if (this.#session) this.#teardown();

    this.#stopped = false;
    this.#target = target;
    this.#retries = 0;
    this.#emit({
      state: 'connecting', detail: null, stream: null, stats: IDLE_STATS, screen: null, retries: 0,
    });
    this.#dial();
  }

  #dial(): void {
    const target = this.#target;
    if (!target || this.#stopped) return;
    const generation = ++this.#generation;
    /** True only while this generation is the current one AND we have not been stopped. */
    const current = () => generation === this.#generation && !this.#stopped;

    const session = this.#opts.createSession({
      url: target.url,
      token: target.token,
      iceServers: target.iceServers,
      onState: (state, detail) => {
        if (!current()) return;
        // Read on every transition rather than only on `authenticated`: the worker sets it before
        // announcing itself, and a reconnect to a device that rotated reports a different panel.
        const screen = this.#session?.screen ?? null;
        this.#emit({ state, detail: detail ?? null, screen });
        // A clean connect resets the budget, so a link that flaps once an hour never exhausts it.
        if (state === 'streaming' || state === 'nostream' || state === 'nodisplay') {
          this.#retries = 0;
          this.#emit({ retries: 0 });
        }
        if (state === 'failed') this.#scheduleRetry();
      },
      onStream: (stream) => { if (current()) this.#emit({ stream }); },
      onNotice: (message) => {
        if (!current()) return;
        // Bounded. A device in an input-overrun loop emits these faster than anyone reads them.
        this.#emit({ notices: [...this.#snapshot.notices, message].slice(-20) });
      },
    });

    this.#session = session;
    session.connect();
    this.#pollStats(generation);
  }

  /**
   * Mirror the session's own stats into the snapshot.
   *
   * `LiveSession` samples `getStats()` on its own one-second timer and writes a plain property; it
   * has no change event. Rather than reach into it from the render path — which would make the
   * number depend on when React happened to paint — it is copied on the same cadence and only when
   * it actually differs, so an idle connection emits nothing.
   */
  #pollStats(generation: number): void {
    const tick = () => {
      if (generation !== this.#generation || this.#stopped) return;
      const s = this.#session?.stats;
      if (s) {
        const prev = this.#snapshot.stats;
        if (s.fps !== prev.fps || s.kbps !== prev.kbps || s.rtt !== prev.rtt || s.ice !== prev.ice) {
          this.#emit({ stats: { ...s } });
        }
      }
      this.#opts.setTimeoutFn(tick, 1_000);
    };
    this.#opts.setTimeoutFn(tick, 1_000);
  }

  #scheduleRetry(): void {
    if (this.#stopped) return;
    const delay = RETRY_DELAYS_MS[this.#retries];
    if (delay === undefined) return;      // budget spent; `failed` stands and a person decides
    this.#retries += 1;
    this.#emit({ retries: this.#retries });
    /**
     * ORPHAN THE DYING SESSION BEFORE CLOSING IT, and the order is the whole of this comment.
     *
     * `live.js`'s `close()` calls `#state('closed')` SYNCHRONOUSLY. Closing while this generation
     * is still current therefore delivers `onState('closed')` straight back into the callback above,
     * which overwrites the `failed` state and its detail — so the view showed "Disconnected." in
     * place of whatever the worker actually objected to. On a refused grant that meant the person
     * was told the connection closed rather than "the account is not authorised for this device",
     * which is the difference between a fixable problem and a mystery.
     *
     * Caught by `dataplane-lifecycle.test.ts` → "a worker that refuses", against a real socket.
     * No fake would have shown it: the fake's `close()` fires nothing.
     */
    this.#generation += 1;
    // The failed session is closed BEFORE the next is dialled. Overlapping them is how one viewer
    // ends up holding two channels for the same device.
    this.#closeSession();
    this.#opts.clearTimeoutFn(this.#retryHandle);
    this.#retryHandle = this.#opts.setTimeoutFn(() => {
      this.#retryHandle = null;
      this.#dial();
    }, delay);
  }

  /** Re-dial now, resetting the budget. What the "Try again" button calls. */
  retryNow(): void {
    if (!this.#target) return;
    this.#stopped = false;
    this.#retries = 0;
    // Same ordering rule as `#scheduleRetry`: orphan first, so the close does not report itself.
    this.#generation += 1;
    this.#closeSession();
    this.#emit({
      state: 'connecting', detail: null, stream: null, stats: IDLE_STATS, screen: null, retries: 0,
    });
    this.#dial();
  }

  /**
   * Close, and stay closed.
   *
   * Idempotent and safe to call when nothing was ever started — the unmount path calls it
   * unconditionally, and an unmount before the first connect is the ordinary case in StrictMode.
   */
  stop(): void {
    this.#stopped = true;
    this.#teardown();
    this.#emit({ state: 'closed', stream: null, stats: IDLE_STATS, screen: null });
  }

  #teardown(): void {
    this.#generation += 1;           // orphan every callback still in flight
    this.#opts.clearTimeoutFn(this.#retryHandle);
    this.#retryHandle = null;
    this.#closeSession();
    this.#attached = null;
    this.#target = null;
  }

  #closeSession(): void {
    const s = this.#session;
    this.#session = null;
    // `close()` is idempotent in `live.js`, but it can still throw if the socket is mid-handshake,
    // and a throw here would abandon the rest of the teardown.
    try { s?.close(); } catch { /* already gone */ }
  }

  /* ------------------------------------------------------------------ the view's handles */

  /**
   * Hand the `<video>` to the session so taps reach the device.
   *
   * Attached ONCE per element. `live.js`'s `attachInput` adds listeners and offers no way to remove
   * them, which is correct for its own console — the element dies with the page. Here the element
   * outlives individual connections, so calling it twice would double every touch: two `pointerdown`
   * listeners means two `multi-touch` frames per tap, and the device would see a second finger.
   */
  attach(video: HTMLVideoElement | null): void {
    if (!video || this.#attached === video || !this.#session) return;
    this.#attached = video;
    this.#session.attachInput(video);
  }

  pressButton(command: string): boolean { return this.#session?.pressButton(command) ?? false; }
  sendControl(msg: Record<string, unknown>): boolean { return this.#session?.sendControl(msg) ?? false; }
  screenshot(): Promise<LiveScreenshot & { id: string }> {
    return this.#session
      ? this.#session.screenshot()
      : Promise.reject(new Error('Not connected to the device.'));
  }

  /** Test seam. Never used by the view. */
  get sessionForTest(): LiveSession | null { return this.#session; }
}

/**
 * Close the connection when the page goes away, rather than leaving it to TCP.
 *
 * `pagehide` and not `beforeunload`: `beforeunload` does not fire on mobile Safari or on a
 * background tab being discarded, which are two of the ways a viewer actually disappears. `pagehide`
 * fires for both, including into the back/forward cache.
 *
 * This is the one guard that addresses the gap ADR-0021 named and left open. Without it, closing a
 * tab mid-stream holds a channel against `MAX_CHANNELS_PER_HOST` until the worker's TCP stack times
 * out — invisible from the console, and it looks like the farm running out of viewers.
 */
export function armUnloadGuard(controller: LiveController): () => void {
  if (typeof window === 'undefined') return () => {};
  const bye = () => controller.stop();
  window.addEventListener('pagehide', bye);
  return () => window.removeEventListener('pagehide', bye);
}
