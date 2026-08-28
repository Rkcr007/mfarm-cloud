/**
 * How a profiled device is DRAWN — ADR-0016.
 *
 * PRESENTATION ONLY. Nothing here reaches the device, and nothing here is a claim about it. The
 * worker's `workers/agent/src/devices/profiles.ts` owns what a device actually IS — panel, density,
 * RAM, reported identity — and sends the profile id and the real screen geometry up with
 * registration. This file only answers "what does that phone look like".
 *
 * The split matters: geometry is drawn from the DEVICE'S OWN `screen`, never from the table below.
 * If the two ever disagree, the device is right and this file is stale, and drawing from here would
 * silently show a shape the device is not — which is the one thing a device-mirroring panel must
 * never do.
 *
 * A BROWSER ASSET, so it stays plain JavaScript: the console has no build step, and the API serves
 * these files exactly as they sit on disk. See live.js for the same reasoning.
 *
 * Percentages, not pixels. The frame is sized from the viewport and a zoom factor, so every metric
 * has to survive being scaled — a corner radius in px looks right at one zoom and wrong at every
 * other one.
 */

/**
 * @typedef {object} Chrome
 * @property {string} label           Short name for the body, e.g. "Galaxy S25 Ultra".
 * @property {number} radiusPct       Screen corner radius, as a % of the frame's WIDTH.
 * @property {number} bezelPct        Body thickness around the screen, as a % of the frame's width.
 * @property {{xPct:number,yPct:number,dPct:number}|null} cutout
 *   Punch-hole camera, positioned as a % of the SCREEN box and sized as a % of its width. Null for
 *   a device with no cutout.
 * @property {Array<{side:'left'|'right',topPct:number,lenPct:number}>} buttons
 *   Side buttons, positioned and sized as a % of the frame's HEIGHT.
 */

/**
 * Chrome for the profiles the worker can boot.
 *
 * Keyed by the SAME ids as the worker's catalog, and that coupling is the point — the console asks
 * for `d.profile` and gets the matching body, with no string matching on a marketing name that
 * somebody will eventually retype.
 *
 * The metrics are eyeballed to read as the right phone, not measured off a caliper. They are honest
 * as "this is a Galaxy-shaped body" and are not a dimensional reference for anything.
 */
export const DEVICE_CHROME = {
  'galaxy-s25-ultra': {
    label: 'Galaxy S25 Ultra',
    // The Ultra is the squarer-cornered one of the pair; that is most of what distinguishes the two
    // bodies at a glance.
    radiusPct: 4.5,
    bezelPx: 9,
    cutout: { xPct: 50, yPct: 1.55, dPct: 3.4 },
    buttons: [
      { side: 'right', topPct: 20, lenPct: 7 },   // volume
      { side: 'right', topPct: 29, lenPct: 5 },   // power
    ],
  },
  'galaxy-s25': {
    label: 'Galaxy S25',
    radiusPct: 7.5,
    bezelPx: 10,
    cutout: { xPct: 50, yPct: 1.8, dPct: 3.8 },
    buttons: [
      { side: 'right', topPct: 21, lenPct: 7.5 },
      { side: 'right', topPct: 31, lenPct: 5.5 },
    ],
  },
};

/**
 * The body drawn for a device with no profile, or with one this console has never heard of.
 *
 * NOT AN ERROR STATE, and it must never look like one. Two of this farm's four devices are
 * deliberately unprofiled, physical handsets are never profiled at all, and an N-1 worker sends no
 * profile for anything — so this is the ordinary case, and it renders as the plain bezel the console
 * has always drawn. No cutout and no buttons: hardware this console cannot describe is hardware it
 * does not draw.
 */
export const PLAIN_CHROME = {
  label: '',
  radiusPct: 2.5,
  bezelPx: 8,
  cutout: null,
  buttons: [],
};

/**
 * Chrome for a device, always. Never throws, never returns null.
 *
 * An unknown profile id falls back rather than failing, because the console is served from the same
 * image as the API but a WORKER can be a version ahead — a device profiled with something added
 * after this file was written must still render, as a plain phone, rather than blanking the panel
 * that is the whole screen someone is looking at.
 */
export function chromeFor(device) {
  return (device && DEVICE_CHROME[device.profile]) || PLAIN_CHROME;
}

/** True when this device has chrome worth offering a hide/show control for. */
export function hasChrome(device) {
  return Boolean(device && DEVICE_CHROME[device.profile]);
}

/**
 * `1440 × 3120 · 600dpi` — the geometry line on a device card, or '' when the worker sent no screen.
 *
 * Empty rather than a placeholder: a device that did not report its panel has nothing to say here,
 * and a row reading "— × —" is worse than no row.
 */
export function geometryText(device) {
  const s = device?.screen;
  if (!s?.width || !s?.height) return '';
  return `${s.width} × ${s.height}${s.density ? ` · ${s.density}dpi` : ''}`;
}
