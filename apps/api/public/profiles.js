/**
 * How a profiled device is DRAWN — ADR-0017.
 *
 * PRESENTATION ONLY. Nothing here reaches the device, and nothing here is a claim about it. The
 * worker's `workers/agent/src/devices/profiles.ts` owns what a device actually IS — panel, density,
 * RAM, cores — and sends the profile id and the real screen geometry up with registration. This file
 * only answers "what does that device look like".
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
 * @property {string} label           Short name for the body, e.g. "MFARM X1 Pro".
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
 * The metrics are eyeballed to read as a modern flagship body, not measured off a caliper. They are
 * MFARM's own industrial design (ADR-0017) and are not a dimensional reference for anything.
 */
export const DEVICE_CHROME = {
  'mfarm-x1-pro': {
    label: 'MFARM X1 Pro',
    // The Pro is the squarer-cornered, thinner-bezelled body of the two; that is most of what
    // separates them at a glance, and it is MFARM's own industrial design rather than a trace of
    // somebody else's (ADR-0017).
    radiusPct: 4.5,
    bezelPx: 9,
    cutout: { xPct: 50, yPct: 1.55, dPct: 3.4 },
    buttons: [
      { side: 'right', topPct: 20, lenPct: 7 },   // volume
      { side: 'right', topPct: 29, lenPct: 5 },   // power
    ],
  },
  'mfarm-x1': {
    label: 'MFARM X1',
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
 * `1080 × 2340 · 450dpi` — the geometry line on a device card, or '' when the worker sent no screen.
 *
 * Empty rather than a placeholder: a device that did not report its panel has nothing to say here,
 * and a row reading "— × —" is worse than no row.
 */
export function geometryText(device) {
  const s = device?.screen;
  if (!s?.width || !s?.height) return '';
  return `${s.width} × ${s.height}${s.density ? ` · ${s.density}dpi` : ''}`;
}

/* ============================================================ what a device is CALLED ==========
 *
 * THE RULE, from the copy deck: a device is addressed by WHAT IT IS. Internal vocabulary — tier,
 * cuttlefish, fence, host id, region code — belongs in a details panel or a copyable field, never
 * in a button or a heading. "Start a session on tier cuttlefish" names an implementation the reader
 * did not choose and cannot act on; "Start MFARM X1 Pro" names the thing they asked for.
 *
 * Those terms are not banned, they are PLACED. Session id, WebDriver URL, package name, ABI,
 * geometry, capability names, log lines, host id and tier are all still shown — as machine text, in
 * a copy field or a details table. The mono register itself tells the reader this came from the
 * machine rather than from us, which is exactly why it can stay.
 */

/** The word for a device with geometry and nothing else. Named by what we know, not by the stack. */
export const UNPROFILED = 'Unprofiled device';

/**
 * What to call this device, anywhere a human reads it.
 *
 * THREE CASES, and the physical one is the interesting exception. A profiled virtual device is an
 * MFARM X1 Pro, because that is genuinely what the farm provides it as. A PHYSICAL handset is
 * called by its own model number — `SM-S918B` — and that is not a lapse from ADR-0017's rule
 * against other manufacturers' identity: it genuinely IS that device, and naming it accurately is
 * the opposite of the counterfeiting the ADR forbids. Nobody should ever be unsure which of the two
 * they are holding.
 *
 * An unprofiled device gets a NAME rather than a raw tier string. It used to render as
 * `cuttlefish`, which tells a tester nothing they can use and quite a lot they should not have to
 * know.
 */
export function deviceName(device) {
  if (!device) return UNPROFILED;
  if (device.tier === 'physical') return device.model || UNPROFILED;
  const chrome = DEVICE_CHROME[device.profile];
  if (chrome) return chrome.label;
  /**
   * A profiled device the console has never heard of.
   *
   * The worker can be a VERSION AHEAD of the image serving this file, so a profile added after this
   * was written arrives with a model string the worker set deliberately. Preferring it over
   * "Unprofiled device" is the difference between a new device class showing its real name a
   * release early and showing nothing at all — and it cannot be a stale marketing name, because the
   * worker is the newer of the two.
   */
  if (device.profile && device.model) return device.model;
  return UNPROFILED;
}

/**
 * The stable key for "devices of this kind", which is what the allocator actually hands out.
 *
 * ALLOCATION IS CLASS-ONLY. The picker promises a CLASS, never a unit — so every count, every "3 of
 * 4 free", and the substitution notice at handover are all computed over this key rather than over
 * a device id. If pinning ever becomes possible this is the one function that has to change.
 *
 * Physical handsets are keyed by model, because two handsets of the same model genuinely are
 * interchangeable and two of different models are not.
 */
export function deviceClass(device) {
  if (!device) return 'unprofiled';
  if (device.tier === 'physical') return `physical:${device.model || 'unknown'}`;
  return device.profile || 'unprofiled';
}

/**
 * `3 of 4 MFARM X1 Pro free` — capacity as a fraction, over the class.
 *
 * A BARE COUNT IS THE BUG THIS REPLACES. "3 free on tier cuttlefish" answers "can I get one" and
 * nothing else; the fraction also answers "is this farm nearly full", which is the question behind
 * it and the one that decides whether you start now or wait. The denominator is not decoration.
 */
export function capacityText(devices, device) {
  const key = deviceClass(device);
  const kin = (devices || []).filter((d) => deviceClass(d) === key);
  const free = kin.filter((d) => d.state === 'READY').length;
  return `${free} of ${kin.length} ${deviceName(device)} free`;
}

/** `2 of 2 free` — the same fraction without the name, for a row that already says the name. */
export function freeText(devices, device) {
  const key = deviceClass(device);
  const kin = (devices || []).filter((d) => deviceClass(d) === key);
  return `${kin.filter((d) => d.state === 'READY').length} of ${kin.length} free`;
}

/**
 * `384 dp`, or '' when the device reported no density.
 *
 * THE NUMBER A LAYOUT BUG IS ACTUALLY EXPRESSED IN. Two devices can share a panel and differ only
 * here — this farm's X1 and X1 Pro are 1080x2340 on both, and 360 dp against 384 dp — so the pixel
 * count alone cannot tell somebody which one their layout will break on. Same formula as the React
 * console's `geometry.ts`; if these ever disagree, one of them is drawing a device that does not
 * exist.
 */
export function widthDp(device) {
  const s = device?.screen;
  if (!s?.width || !s?.density || s.density <= 0) return '';
  return `${Math.round((s.width * 160) / s.density)} dp`;
}

/* ================================================================= the catalogue's prose ======
 *
 * WHAT A CLASS IS FOR, in a sentence, for the one page that advertises the fleet as products.
 *
 * PRESENTATION ONLY, like everything else in this file, and the constraint is sharper here than it
 * looks: every sentence below has to stay true of the DEVICE, because the catalogue sits beside the
 * real geometry and the real capability chips, and a reader will compare them.
 *
 * SO: NO SENTENCE HERE NAMES A CAPABILITY. The first draft of the Pro's blurb said "the full
 * capability set — live view, UI inspection and screenshots", and a test caught it immediately: the
 * card below it advertises the INTERSECTION of what its devices declare, so the prose could promise
 * a screenshot the class does not have. Capabilities are a fact the device reports and the chips
 * already show; prose that restates them is prose that can contradict them.
 *
 * These describe what the class is FOR — the judgement a buyer or a tester is making — and nothing
 * a device could disagree with.
 *
 * Document 05 asks for this to come from the profile table as a marketing-facing column. It does
 * not exist there, and adding it would mean a worker change and a re-registration to ship a
 * sentence. Here it is one file, no protocol change, and the honest fallback 05 itself names —
 * "the catalogue shows specs without prose" — is what an unlisted class already gets.
 */
export const CLASS_BLURB = {
  'mfarm-x1-pro': {
    badge: 'FLAGSHIP',
    blurb: 'The roomier of the two layouts. Start here unless you are specifically testing how a '
      + 'screen behaves when it gets narrower.',
  },
  'mfarm-x1': {
    badge: 'STANDARD',
    blurb: 'The same panel at a higher density, so a narrower layout in the units a layout is '
      + 'written in. This is the width most Android phones actually report.',
  },
};

/** The badge and sentence for a device's class, or nulls where we have nothing honest to say. */
export function classBlurb(device) {
  if (device?.tier === 'physical') {
    return {
      badge: 'REAL DEVICE',
      blurb: 'A real phone plugged into a real machine. It cannot be reset from a snapshot — only '
        + 'apps are cleared between sessions — and it is named by its own model number rather than '
        + 'an MFARM class.',
    };
  }
  const known = device?.profile && CLASS_BLURB[device.profile];
  if (known) return known;
  return {
    badge: 'NO PROFILE',
    blurb: 'A device the farm knows the geometry of and nothing else. Everything works; there is '
      + 'simply no class description to give you.',
  };
}
