/**
 * The device, lit rather than framed — the whole of the Stage direction in one component.
 *
 * THE SPLIT THIS COMPONENT EXISTS TO PRESERVE (direction document §8, and it is architectural):
 *
 *   the CHASSIS  is ours, drawn in the browser from the device's profile
 *   the SCREEN   is the real device, live pixels, never anything we invented
 *
 * So this file draws a body, a bezel, a punch-hole and side buttons, and then gets out of the way.
 * The one child it accepts fills the screen box exactly, and on a live session that child is the
 * `<video>` element carrying the stream. It is never given a picture to show.
 *
 * GEOMETRY COMES FROM THE DEVICE, never from a table keyed on its name. A device reports its own
 * panel at registration; this component turns that into an aspect ratio. If the two ever disagree,
 * the device is right — drawing a shape the device is not is the one thing a mirror must never do.
 */
import type { CSSProperties, ReactNode } from 'react';

export interface DeviceChrome {
  /** Screen corner radius, as a % of the frame's width, so it survives any zoom. */
  radiusPct: number;
  /** Body thickness around the screen, in px — a percentage is silently discarded by box-shadow. */
  bezelPx: number;
  /** Punch-hole camera, positioned as a % of the screen box. Null for a device without one. */
  cutout: { xPct: number; yPct: number; dPct: number } | null;
  /** Side buttons, positioned and sized as a % of the body's height. */
  buttons: { side: 'left' | 'right'; topPct: number; lenPct: number }[];
}

export interface DeviceStageProps {
  screen: { width: number; height: number; density: number };
  chrome: DeviceChrome;
  /** How tall the body may be, in px. The width follows from the panel's own aspect ratio. */
  maxHeight?: number;
  /** Dim the stage light. Used while the device is not streaming, so the eye is not drawn to it. */
  lit?: boolean;
  children?: ReactNode;
}

export function DeviceStage({
  screen, chrome, maxHeight = 560, lit = true, children,
}: DeviceStageProps) {
  const ratio = screen.width > 0 && screen.height > 0 ? screen.width / screen.height : 9 / 16;

  /**
   * Custom properties rather than inline geometry on each node.
   *
   * A profile change, a rotate or a zoom then costs one property write on the root and no re-layout
   * of the video — which matters because moving or rebuilding a live `<video>` drops its stream and
   * re-decodes, a visible stutter on the one surface where smoothness is the product.
   */
  const vars = {
    '--dev-ratio': String(ratio),
    '--dev-max-h': `${maxHeight}px`,
    '--dev-radius': `${chrome.radiusPct}%`,
    '--dev-bezel': `${chrome.bezelPx}px`,
  } as CSSProperties;

  return (
    <div className="stage" data-lit={lit ? 'on' : 'off'}>
      <div className="stage-pool" aria-hidden="true" />
      <div className="dev" style={vars}>
        <div className="dev-body">
          <div className="dev-screen">
            {children}
            {chrome.cutout && (
              /**
               * OVER the screen, and the only thing allowed there.
               *
               * A modern phone's camera IS in the display, so a body that puts it in the bezel is
               * drawing a device nobody makes. It takes no pointer events, so it can never
               * intercept a tap meant for the app under test, and the chrome toggle removes it —
               * which is what makes covering a few pixels of somebody's app acceptable at all.
               */
              <span
                className="dev-cutout"
                aria-hidden="true"
                style={{
                  '--cut-x': `${chrome.cutout.xPct}%`,
                  '--cut-y': `${chrome.cutout.yPct}%`,
                  '--cut-d': `${chrome.cutout.dPct}%`,
                } as CSSProperties}
              />
            )}
          </div>
          {chrome.buttons.map((b, i) => (
            <span
              key={`${b.side}-${b.topPct}-${i}`}
              className={`dev-btn dev-btn-${b.side}`}
              aria-hidden="true"
              style={{ top: `${b.topPct}%`, height: `${b.lenPct}%` } as CSSProperties}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
