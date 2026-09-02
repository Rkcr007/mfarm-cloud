/**
 * Which panel the stage draws, and what shape that makes it.
 *
 * Three lines of arithmetic that decide whether taps land where they look, which is why they are a
 * module and not an expression inside JSX. `DeviceStage` turns a panel into an aspect ratio, the
 * `<video>` fills that box with `object-fit: contain`, and `live.js` scales every touch by
 * `videoWidth / offsetWidth` — a ratio that is only the truth while the element is NOT letterboxing.
 *
 * So the geometry handed to the stage is not a presentational choice. Give it a panel the stream is
 * not being encoded at and the video letterboxes inside its own box; `offsetWidth` then measures the
 * box rather than the picture, and every coordinate is wrong by the crop, silently, on a screen that
 * still looks perfectly fine.
 */
import type { LiveScreen } from '../../../../api/public/live.js';

/** What a device reports at registration, and what the worker reports for a live session. */
export type Screen = LiveScreen;

/**
 * A sane panel for a device that has never reported one.
 *
 * Used only to give the stage a shape to draw before anything better exists. It is never used to
 * scale a touch — that always comes from the video's own intrinsic size.
 */
export const DEFAULT_SCREEN: Screen = { width: 1080, height: 2340, density: 420 };

/**
 * THE LIVE PANEL WINS.
 *
 * In priority order: the panel the worker reports for this session, then the one the device
 * registered, then a default. The old console makes the same call in `paintFrame` and says why —
 * "the live socket's screen wins over the registered one because it is the panel the stream is
 * actually being encoded from". The registered panel is the right answer only before a session
 * exists; after that it is a claim that can be stale, and a stale claim here is a mis-aimed tap.
 */
export function stageScreenFor(live: Screen | null, registered: Screen | undefined): Screen {
  return live ?? registered ?? DEFAULT_SCREEN;
}

/**
 * Width over height, which is what the stage sizes itself by.
 *
 * A degenerate panel (a zero, a negative, a missing number from a worker one version ahead) falls
 * back to 9:16 rather than producing `Infinity` or `NaN` — either of which reaches CSS as an
 * invalid `aspect-ratio`, and the element then collapses to zero height. A device drawn at the
 * wrong shape is a bug; a device drawn at no size at all looks like the farm is down.
 */
export function aspectRatio(screen: Screen | undefined): number {
  const w = screen?.width;
  const h = screen?.height;
  if (!w || !h || w <= 0 || h <= 0 || !Number.isFinite(w) || !Number.isFinite(h)) return 9 / 16;
  return w / h;
}

/** Density-independent width, the number a layout is actually written against. */
export function widthDp(screen: Screen): number {
  if (!screen.density || screen.density <= 0) return 0;
  return Math.round((screen.width * 160) / screen.density);
}
