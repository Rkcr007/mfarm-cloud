/**
 * The frame resolver — `frameFor`, on its own.
 *
 * WHY SEPARATELY FROM THE SCREEN TESTS. `console-screens.test.ts` asserts that a tree gets built,
 * which is the failure that actually shipped once and the one nothing else can see. It cannot see
 * whether the NUMBERS are right, because a frame with every ratio set to zero still renders six
 * elements and still passes every assertion there.
 *
 * The resolver is pure — a device object in, a metrics object out — so this is the one part of the
 * frame system that can be checked exactly rather than structurally.
 *
 * The DOM shim is installed anyway: `frame.js` also exports builders that touch `document`, and the
 * module is evaluated as a whole on import.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { installDom } from './dom-shim.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let frame: any;

before(async () => {
  // Same rewrite as the screen tests: browser-absolute specifiers are correct in a browser and
  // unresolvable in Node. Whole graph, not one file — `frame.js` imports `/profiles.js`.
  const dir = await mkdtemp(join(tmpdir(), 'mfarm-frame-'));
  const modules = (await readdir(PUBLIC, { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name);
  for (const name of modules) {
    const src = (await readFile(join(PUBLIC, name), 'utf8')).replace(
      /from '\/([\w.-]+\.js)'/g,
      (whole, file: string) => (modules.includes(file)
        ? `from ${JSON.stringify(pathToFileURL(join(dir, file)).href)}`
        : whole),
    );
    await writeFile(join(dir, name), src);
  }
  installDom();
  frame = await import(pathToFileURL(join(dir, 'frame.js')).href);
});

const x1pro = { tier: 'cuttlefish', profile: 'mfarm-x1-pro', screen: { width: 1080, height: 2340, density: 450 } };
const x1 = { tier: 'cuttlefish', profile: 'mfarm-x1', screen: { width: 1080, height: 2340, density: 480 } };
const plain = { tier: 'cuttlefish', screen: { width: 720, height: 1280, density: 320 } };
const handset = { tier: 'physical', model: 'SM-S918B', screen: { width: 1440, height: 3088, density: 500 } };

describe('frameFor resolves every device to one shape', () => {
  /**
   * ONE RETURN SHAPE FOR ALL FOUR CASES is the entire reason this function exists: the stage has no
   * per-device conditionals, so a profile row added to the table gives a new device a correct frame
   * with no frontend change at all. A case that returned a different shape would put the branch
   * back in the caller, one `if` at a time, and nothing else would notice.
   */
  test('every case returns the same keys', () => {
    const keys = (d: unknown) => Object.keys(frame.frameFor(d)).sort();
    const expected = keys(x1pro);
    assert.ok(expected.length >= 9, 'the frame is missing fields');
    for (const [name, device] of [['x1', x1], ['unprofiled', plain], ['physical', handset], ['nothing at all', undefined]] as const) {
      assert.deepEqual(keys(device), expected, `${name} returns a different shape`);
    }
  });

  test('it never throws and never returns null', () => {
    for (const d of [undefined, null, {}, { tier: 'nonsense' }, { profile: 'from-the-future' }]) {
      assert.ok(frame.frameFor(d), `${JSON.stringify(d)} produced nothing`);
    }
  });
});

describe('geometry comes from the device, never from the table', () => {
  /**
   * A 720×1280 device is visibly STUBBIER than a 1080×2340 one, and it must be — screen shape is
   * the reason somebody chose a device, so the frame is where that difference becomes visible
   * before they start testing.
   */
  test('the aspect is the reported pixels', () => {
    assert.equal(frame.frameFor(x1pro).aspect, 1080 / 2340);
    assert.equal(frame.frameFor(plain).aspect, 720 / 1280);
    assert.ok(frame.frameFor(plain).aspect > frame.frameFor(x1pro).aspect, 'the 720p device is stubbier');
  });

  /**
   * THE LIVE SOCKET WINS OVER THE REGISTERED GEOMETRY.
   *
   * The stream is encoded from the panel the device actually has right now; registration recorded
   * what it had when it last registered. If the two disagree the DEVICE is right, and drawing the
   * stale one would show a shape the device is not — the single thing a device-mirroring panel must
   * never do.
   */
  test('a live screen overrides the registered one', () => {
    const live = frame.frameFor(x1pro, { width: 720, height: 1280 });
    assert.equal(live.aspect, 720 / 1280);
  });

  test('a device that reported no panel falls back rather than dividing by zero', () => {
    const f = frame.frameFor({ tier: 'cuttlefish' });
    assert.ok(Number.isFinite(f.aspect) && f.aspect > 0, `aspect was ${f.aspect}`);
  });
});

describe('the four bodies are actually different', () => {
  /**
   * The step down from Pro to standard has to be LEGIBLE without being punitive, and the unprofiled
   * fallback has to look deliberate rather than broken. Both of those are claims about numbers, and
   * this is where they are either true or quietly not.
   */
  test('bezel thickness separates the family', () => {
    const bezel = (d: unknown) => frame.frameFor(d).bezel;
    // Thinnest to thickest: a real handset, the Pro, the standard, the neutral enclosure.
    assert.ok(bezel(handset) < bezel(x1pro), 'the handset has the thinnest bezel in the family');
    assert.ok(bezel(x1pro) < bezel(x1), 'the Pro is the thinner-bezelled of the two');
    assert.ok(bezel(x1) < bezel(plain), 'the neutral chassis is the chunkiest');
  });

  /**
   * THE UNPROFILED CHASSIS HAS NO CUTOUT, and that is honesty rather than an omission.
   *
   * We do not know where that device's camera is. Drawing one would be inventing data, and the
   * whole point of the neutral body is that it is honest about what the farm knows: geometry, and
   * nothing more. It is also the ORDINARY case — two of this farm's four devices are deliberately
   * unprofiled, every handset is, and an N-1 worker profiles nothing — so it must read as a
   * deliberate industrial enclosure and never as a failed phone.
   */
  test('no cutout and no rails are invented for a device we do not know', () => {
    const f = frame.frameFor(plain);
    assert.equal(f.cutout, null, 'a camera we cannot locate is a camera we do not draw');
    assert.deepEqual(f.rails, [], 'nor side keys');
    assert.equal(f.railStyle, 'none');
  });

  test('a profiled device gets both', () => {
    const f = frame.frameFor(x1pro);
    assert.ok(f.cutout > 0);
    assert.ok(f.rails.length > 0);
  });

  /**
   * A PHYSICAL HANDSET IS A DIFFERENT KIND OF OBJECT and is drawn as one — nobody should ever be
   * unsure which of the two they are holding. It is resolved BEFORE the profile lookup, because a
   * handset is never profiled and never will be.
   */
  test('a handset is physical even if something hands it a profile id', () => {
    const f = frame.frameFor({ ...handset, profile: 'mfarm-x1-pro' });
    assert.equal(f.kind, 'physical');
    assert.equal(f.railStyle, 'squared');
  });

  /**
   * A worker can be a VERSION AHEAD of the console serving this file, so a profile added after it
   * was written is the ordinary case and not an error. It must fall back to the neutral chassis
   * rather than blanking the panel that is the whole screen somebody is looking at.
   */
  test('an unknown profile falls back to the neutral chassis', () => {
    const f = frame.frameFor({ tier: 'cuttlefish', profile: 'mfarm-x9', screen: { width: 1080, height: 2340 } });
    assert.equal(f.kind, 'unprofiled');
    assert.equal(f.cutout, null);
    // And it still keeps the device's OWN geometry, which is the half that stays true regardless.
    assert.equal(f.aspect, 1080 / 2340);
  });
});

describe('the derived dimensions', () => {
  /**
   * CHASSIS RADIUS IS DERIVED, NEVER PICKED. It is the panel radius plus the bezel, which is what
   * makes the chassis and the screen concentric — the thing the eye reads as "machined" rather than
   * "two rounded rectangles". A radius chosen off the shape scale would be right for one device.
   */
  test('chassis radius is panel radius plus bezel, for every body', () => {
    for (const d of [x1pro, x1, plain, handset]) {
      const f = frame.frameFor(d);
      assert.equal(f.chassisRadius, f.panelRadius + f.bezel, `${f.kind} is not concentric`);
    }
  });

  /**
   * EVERY DIMENSION IS A RATIO OF RENDERED PANEL WIDTH, which is what lets one component serve a
   * 12px palette result and a 600px cockpit stage from one set of numbers. A value that arrived as
   * a pixel length would look right at whatever size it was written for and wrong at every other.
   */
  test('the ratios are ratios — unitless and well under 1', () => {
    for (const d of [x1pro, x1, plain, handset]) {
      const f = frame.frameFor(d);
      for (const key of ['bezel', 'panelRadius', 'chassisRadius', 'cutoutInset']) {
        assert.equal(typeof f[key], 'number', `${f.kind}.${key} is not a number`);
        assert.ok(f[key] >= 0 && f[key] < 1, `${f.kind}.${key} is ${f[key]}, which is not a ratio of width`);
      }
    }
  });

  /**
   * THE CUTOUT CANNOT LAND ON STATUS-BAR CONTENT, which is the specific defect the old frame had:
   * its panel edge clipped the status-bar clock. The punch-hole is the ONE element allowed over the
   * framebuffer, and it is only allowed because it is physically true — so it has to sit where a
   * real camera sits, inside the region Android reserves, and not lower.
   */
  test('the cutout sits within the reserved strip at the top', () => {
    for (const d of [x1pro, x1, handset]) {
      const f = frame.frameFor(d);
      // Its centre is `cutoutInset` down; its lowest edge is half a diameter below that. Android's
      // status bar is 24dp on a ~384dp-wide panel, so a shade over 6% of the width is the strip.
      assert.ok(f.cutoutInset + f.cutout / 2 < 0.062, `${f.kind} draws its camera into the status bar`);
    }
  });
});
