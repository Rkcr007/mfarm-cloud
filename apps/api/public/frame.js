/**
 * The device frame — one component, every place a device appears.
 *
 * TWO OBJECTS AND ONE RULE, and the rule is the whole reason this file is separate from the panel
 * it wraps:
 *
 *   THE FRAME   chassis, bezel, corner radius, cutout, side rails, edge highlight, contact shadow.
 *               Ours to draw, and MFARM's own industrial design (ADR-0017). Everything premium
 *               about the session screen lives here.
 *   THE SCREEN  the real framebuffer from the running Android instance. Every pixel comes from the
 *               device. No placeholder wallpaper, no mocked status bar, no fake app — and no
 *               screenshot standing in for one, however good it looks in a design file.
 *
 * THE IMPLEMENTATION RULE THAT KEEPS THEM SEPARATE: the frame is ADDITIVE AROUND the panel box,
 * never drawn over it. Bezel is padding on the chassis, rails are positioned outside the chassis
 * edge, and the contact shadow is a sibling below it. Exactly one element overlaps the panel — the
 * punch-hole — and that one is physically accurate: a real camera does occlude pixels and Android
 * reserves that region. It is centred and sized FROM GEOMETRY so it can never land on status-bar
 * content, which the previous frame got wrong: its panel edge clipped the status-bar clock.
 *
 * GEOMETRY DRIVES EVERYTHING. Nothing is hand-placed per device. Every dimension below is a ratio
 * of the RENDERED PANEL WIDTH, so one component serves a 12px result in the command palette and a
 * 600px stage in the cockpit with no second set of numbers — and a corner radius that looks right
 * at one size looks right at every other one. Percentages, not pixels, for the same reason
 * `profiles.js` uses them.
 *
 * A BROWSER ASSET, so it stays plain JavaScript: the console has no build step and the API serves
 * these files exactly as they sit on disk. See `live.js` and `profiles.js` for the same reasoning.
 */

import { DEVICE_CHROME } from '/profiles.js';

/**
 * @typedef {object} Frame
 * @property {string} kind          'virtual' | 'unprofiled' | 'physical' — drives fill and rails.
 * @property {number} bezel         Chassis thickness, as a ratio of rendered panel width.
 * @property {number} panelRadius   Screen corner radius, same units.
 * @property {number} chassisRadius Derived: panelRadius + bezel. Never picked from a scale.
 * @property {number|null} cutout   Punch-hole diameter, same units. Null for no cutout.
 * @property {number} cutoutInset   Distance from the top of the panel to the cutout's centre.
 * @property {Array<{side:'left'|'right',topPct:number,lenPct:number}>} rails
 * @property {string} railStyle     'curved' | 'flat' | 'squared' — how the rail ends are drawn.
 * @property {number} edgeAlpha     Opacity of the 1px highlight along the chassis edge.
 * @property {boolean} edgeWarm     Warm highlight, or neutral for a chassis we know nothing about.
 * @property {number} aspect        width / height, ALWAYS from reported pixels.
 */

/**
 * The four rows of 02's geometry table, keyed by the case each one answers.
 *
 * Ratios of rendered panel width. The pixel values in the design document are these numbers at a
 * 300px render — `.020w · 6px` is this table's `.020` — and they scale linearly to any size.
 */
const GEOMETRY = {
  'mfarm-x1-pro': { bezel: .020, panelRadius: .110, cutout: .037, cutoutInset: .030, railStyle: 'curved',  edgeAlpha: 1,   edgeWarm: true },
  'mfarm-x1':     { bezel: .030, panelRadius: .087, cutout: .043, cutoutInset: .032, railStyle: 'flat',    edgeAlpha: .6,  edgeWarm: true },
  unprofiled:     { bezel: .040, panelRadius: .020, cutout: null, cutoutInset: 0,    railStyle: 'none',    edgeAlpha: .35, edgeWarm: false },
  physical:       { bezel: .012, panelRadius: .067, cutout: .033, cutoutInset: .026, railStyle: 'squared', edgeAlpha: 1,   edgeWarm: true },
};

/** Power and volume, as a percentage of chassis HEIGHT. Absent entirely on the neutral chassis. */
const RAILS = [
  { side: 'right', topPct: 20, lenPct: 7 },    // volume
  { side: 'right', topPct: 29, lenPct: 5 },    // power
];

/** 16:9 portrait, used only when a device has reported no panel at all. */
const FALLBACK_ASPECT = 1080 / 1920;

/**
 * The aspect ratio, ALWAYS from reported pixels — never from the profile table.
 *
 * A 720×1280 device is visibly stubbier than a 1080×2340 one and it MUST be: screen shape is the
 * reason somebody chose a device, so the frame is where that difference becomes visible before they
 * start testing. Taking it from the table instead would draw a shape the device is not, which is
 * the one thing a device-mirroring panel must never do — if the two ever disagree the device is
 * right and the table is stale.
 */
function aspectOf(screen) {
  return screen?.width && screen?.height ? screen.width / screen.height : FALLBACK_ASPECT;
}

/**
 * Resolve a device to a frame. Never throws, never returns null.
 *
 * ONE RETURN SHAPE FOR ALL FOUR CASES, which is the point of the whole function: the stage has no
 * per-device conditionals, so adding a profile row gives a new device a correct frame with no
 * frontend change at all.
 *
 * `screen` may be passed separately to override the registered geometry — the live socket reports
 * the panel the stream is actually being encoded from, which wins over what registration recorded.
 */
export function frameFor(device, screen) {
  const geo = aspectOf(screen || device?.screen);

  /**
   * A PHYSICAL HANDSET IS A DIFFERENT KIND OF OBJECT and is drawn as one.
   *
   * Squarer corners, the thinnest bezel in the family, a squared rail. It is a real machine
   * somebody can unplug, with a different reset story and no snapshot — nobody should ever be
   * unsure which of the two they are looking at. Checked before the profile lookup because a
   * handset is never profiled, and never will be.
   */
  if (device?.tier === 'physical') {
    return { kind: 'physical', ...GEOMETRY.physical, rails: RAILS, chassisRadius: GEOMETRY.physical.panelRadius + GEOMETRY.physical.bezel, aspect: geo };
  }

  const profile = device?.profile && GEOMETRY[device.profile];
  if (!profile) {
    /**
     * THE NEUTRAL CHASSIS, AND WHY IT HAS NO CUTOUT.
     *
     * Because we do not know where its camera is. Drawing one would be inventing data, and the
     * whole point of this frame is that it is honest about what the farm knows: geometry, and
     * nothing more. It reads as a deliberate industrial enclosure rather than as a failed phone —
     * which matters, because this is the ORDINARY case and not an error state. Two of this farm's
     * four devices are deliberately unprofiled, and a worker one version ahead sends a profile this
     * build has never heard of.
     */
    return { kind: 'unprofiled', ...GEOMETRY.unprofiled, rails: [], chassisRadius: GEOMETRY.unprofiled.panelRadius + GEOMETRY.unprofiled.bezel, aspect: geo };
  }

  return {
    kind: 'virtual',
    ...profile,
    rails: DEVICE_CHROME[device.profile]?.buttons ?? RAILS,
    chassisRadius: profile.panelRadius + profile.bezel,
    aspect: geo,
  };
}

/**
 * Build the frame's DOM. SIX NESTED ELEMENTS AND NO IMAGES.
 *
 * It costs one paint and never composites over the panel, which matters more here than it would
 * anywhere else in the console: rendering on this farm is software, and frame rate is the proof
 * the session is healthy. Compositing cost near the panel is a bug, not a style choice.
 *
 * `panel` is whatever shows the pixels — a `<video>` in the cockpit, a plain element everywhere
 * else. It is passed IN rather than created here because the cockpit's video element must survive
 * every re-render: destroying and recreating it drops the stream, re-attaches `srcObject` and
 * re-decodes, which is a visible stutter twice a minute on the one surface where smoothness is the
 * product.
 */
export function buildFrame(panel) {
  const el = (tag, cls) => {
    const n = document.createElement(tag);
    n.className = cls;
    return n;
  };

  const cutout = el('i', 'mf-cutout');
  const sheen = el('i', 'mf-sheen');
  const glass = el('div', 'mf-glass');
  glass.append(panel, cutout, sheen);

  const edge = el('i', 'mf-edge');
  const rails = el('i', 'mf-rails');
  const chassis = el('div', 'mf-chassis');
  chassis.append(edge, rails, glass);

  // A SIBLING, BELOW — the grounded shadow. Inside the chassis it would be clipped by the radius
  // and would read as a vignette rather than as contact with a surface.
  const contact = el('i', 'mf-contact');

  const root = el('div', 'mf-device');
  root.append(chassis, contact);

  return { root, chassis, glass, panel, cutout, sheen, edge, rails, contact };
}

/**
 * Write a frame onto built DOM. Everything is a CSS custom property, so a resize costs no layout
 * thrash and no element is created or destroyed on a panel that exists precisely not to be rebuilt.
 *
 * @param {ReturnType<typeof buildFrame>} dom
 * @param {Frame} frame
 * @param {{ size?: number, state?: string, sheen?: number, zoom?: number }} opts
 *   `size` is the rendered PANEL WIDTH in px and every dimension derives from it. `state` is one of
 *   off · waking · live · nosignal · ended.
 */
export function applyFrame(dom, frame, opts = {}) {
  const { root, chassis, cutout, rails } = dom;
  const size = opts.size;

  root.dataset.kind = frame.kind;
  root.dataset.state = opts.state || 'off';
  root.dataset.rail = frame.railStyle;

  // Ratios go on as unitless numbers multiplied by the panel width in CSS, so ONE property changes
  // when the stage resizes and every derived dimension follows.
  if (size) root.style.setProperty('--f-w', `${size}px`);
  if (opts.zoom) root.style.setProperty('--f-zoom', String(opts.zoom));
  root.style.setProperty('--f-aspect', String(frame.aspect));
  root.style.setProperty('--f-bezel', String(frame.bezel));
  root.style.setProperty('--f-panel-r', String(frame.panelRadius));
  root.style.setProperty('--f-chassis-r', String(frame.chassisRadius));
  root.style.setProperty('--f-edge-a', String(frame.edgeAlpha));
  root.style.setProperty('--f-edge-warm', frame.edgeWarm ? '255, 246, 235' : '235, 238, 245');
  // The sheen tints REAL PIXELS, so it is a value the viewer can take to zero rather than a branch.
  if (opts.sheen !== undefined) root.style.setProperty('--glass-sheen', String(opts.sheen));

  // Hidden rather than absent when there is no cutout: the element never has to be created or
  // destroyed on a frame that is deliberately not rebuilt between polls.
  cutout.hidden = !frame.cutout;
  if (frame.cutout) {
    cutout.style.setProperty('--f-cut-d', String(frame.cutout));
    cutout.style.setProperty('--f-cut-y', String(frame.cutoutInset));
  }

  /**
   * Rails are rebuilt only when the SET actually changes.
   *
   * An unconditional rebuild would drop and recreate DOM on every poll, which is exactly what the
   * cockpit's panel exists to avoid — and it would do it inside the element the video is composited
   * next to.
   */
  const signature = `${frame.railStyle}|${frame.rails.map((r) => `${r.side}:${r.topPct}:${r.lenPct}`).join(',')}`;
  if (rails.dataset.signature !== signature) {
    rails.dataset.signature = signature;
    rails.replaceChildren(...frame.rails.map((r) => {
      const n = document.createElement('i');
      n.className = 'mf-rail';
      n.dataset.side = r.side;
      n.style.top = `${r.topPct}%`;
      n.style.height = `${r.lenPct}%`;
      return n;
    }));
  }

  return chassis;
}

/**
 * A frame at a fixed width, for anywhere that is not the cockpit — a card, a table row, a palette
 * result. The panel is an ordinary element rather than a video.
 *
 * IT SHOWS NO CONTENT, and that is deliberate rather than unfinished. A device that is not in a
 * session has no framebuffer, and the alternatives are all worse than an empty screen: a screenshot
 * is a picture of a moment that has passed, a wallpaper is a claim about a device we do not make,
 * and a placeholder app is a lie. The empty panel says "this device is not showing you anything
 * right now", which is true.
 */
export function staticFrame(device, size, state = 'off') {
  const panel = document.createElement('div');
  panel.className = 'mf-panel';
  const dom = buildFrame(panel);
  applyFrame(dom, frameFor(device), { size, state });
  dom.root.setAttribute('aria-hidden', 'true');
  return dom.root;
}
