/**
 * The shape of the device on screen, and the frame that fills it.
 *
 * `stageScreenFor` is the only rule in this console with a silent, wrong-answer failure mode. Every
 * other geometry bug is visible — a squashed phone, a device drawn at no height. This one draws a
 * perfectly convincing device and puts taps in the wrong place, because the video letterboxes inside
 * its own box and `live.js` scales touches by a width that is then the box rather than the picture.
 *
 * The numbers below are worked out from the panels by hand rather than by calling the function under
 * test, so an implementation that is confidently wrong cannot make them agree with it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCREEN, aspectRatio, stageScreenFor, widthDp, type Screen,
} from '../src/app/session/geometry.ts';
import { LiveController } from '../src/app/session/liveController.ts';

const REGISTERED: Screen = { width: 1080, height: 2340, density: 420 };
/** What the worker reports once streaming — deliberately a different shape from the registered one. */
const LIVE: Screen = { width: 720, height: 1280, density: 320 };

describe('which panel the stage draws', () => {
  test('the live panel wins over the registered one', () => {
    assert.deepEqual(stageScreenFor(LIVE, REGISTERED), LIVE);
  });

  test('the registered panel is used until a session reports one', () => {
    assert.deepEqual(stageScreenFor(null, REGISTERED), REGISTERED);
  });

  test('a device that has never reported a panel still gets a shape', () => {
    assert.deepEqual(stageScreenFor(null, undefined), DEFAULT_SCREEN);
  });

  /**
   * The tap-accuracy consequence, stated as arithmetic rather than as a claim.
   *
   * The two panels have genuinely different aspect ratios — 1080/2340 ≈ 0.4615 against
   * 720/1280 = 0.5625. Drawing the registered one while the device encodes the live one letterboxes
   * the video, and every horizontal coordinate is then wrong by that ratio. This asserts they differ
   * enough to matter, so the test above is not quietly comparing two identical shapes.
   */
  test('the two panels really are different shapes, or the rule above proves nothing', () => {
    const drawn = aspectRatio(REGISTERED);
    const actual = aspectRatio(LIVE);
    assert.ok(Math.abs(drawn - actual) > 0.05,
      `the fixtures must disagree for this to be a real test (${drawn} vs ${actual})`);
  });
});

describe('a panel becomes an aspect ratio', () => {
  test('a portrait 1080×2340 panel', () => {
    // 1080/2340 = 0.46153846…
    assert.ok(Math.abs(aspectRatio(REGISTERED) - 0.4615384615) < 1e-9);
  });

  test('a landscape panel is wider than tall', () => {
    assert.equal(aspectRatio({ width: 1280, height: 720, density: 320 }), 1280 / 720);
    assert.ok(aspectRatio({ width: 1280, height: 720, density: 320 }) > 1);
  });

  /**
   * A zero, a negative or a missing dimension must not reach CSS.
   *
   * `aspect-ratio: NaN` and `aspect-ratio: Infinity` are both invalid, and the element collapses to
   * zero height — which does not look like a geometry bug, it looks like the farm is down.
   */
  for (const [name, screen] of [
    ['a zero height', { width: 1080, height: 0, density: 420 }],
    ['a zero width', { width: 0, height: 2340, density: 420 }],
    ['a negative height', { width: 1080, height: -5, density: 420 }],
    ['NaN from a worker one version ahead', { width: Number.NaN, height: 2340, density: 420 }],
    ['Infinity', { width: Number.POSITIVE_INFINITY, height: 2340, density: 420 }],
  ] as [string, Screen][]) {
    test(`${name} falls back to 9:16 rather than an invalid ratio`, () => {
      const r = aspectRatio(screen);
      assert.ok(Number.isFinite(r) && r > 0, `${name} produced ${r}`);
      assert.equal(r, 9 / 16);
    });
  }

  test('an absent panel falls back too', () => {
    assert.equal(aspectRatio(undefined), 9 / 16);
  });
});

describe('density-independent width', () => {
  test('1080 px at 420 dpi is 411 dp', () => {
    // 1080 * 160 / 420 = 411.43 -> 411. A real 1080×2340 phone reports 411dp.
    assert.equal(widthDp(REGISTERED), 411);
  });

  test('720 px at 320 dpi is 360 dp', () => {
    assert.equal(widthDp(LIVE), 360);
  });

  test('a zero density does not divide by zero', () => {
    assert.equal(widthDp({ width: 1080, height: 2340, density: 0 }), 0);
  });
});

/**
 * FRAME RENDERING.
 *
 * What can be checked without a browser is which frames are allowed to reach the screen at all —
 * and that is the half with a correctness consequence: painting a stream from a device we have
 * already released shows one tenant the last frame of another tenant's session.
 *
 * What is deliberately NOT asserted here is the `srcObject` assignment itself. It needs a real
 * `HTMLVideoElement`, there is no DOM in this runner, and a shim that returns whatever it is given
 * would be testing the shim. That line is covered by the hardware verification instead, and this
 * comment exists so nobody reads the file and assumes otherwise.
 */
describe('which frames may be painted', () => {
  class Fake {
    static made: Fake[] = [];
    o: Record<string, (...a: never[]) => void>;
    screen: Screen | null = null;
    stats = { fps: 0, kbps: 0, rtt: null, ice: null };
    constructor(o: Record<string, (...a: never[]) => void>) { this.o = o; Fake.made.push(this); }
    connect() {}
    close() {}
    attachInput() {}
    pressButton() { return true; }
    sendControl() { return true; }
  }

  function rig() {
    Fake.made = [];
    const c = new LiveController({
      createSession: (o) => new Fake(o as never) as never,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    });
    return { c, last: () => Fake.made.at(-1)! };
  }

  const stream = (id: string) => ({ id }) as unknown as MediaStream;

  test('a frame from the current session is offered to the view', () => {
    const r = rig();
    r.c.start({ sessionId: 's1', url: 'ws://x', token: 't' });
    (r.last().o.onStream as (s: unknown, l: string) => void)(stream('display_0'), 'display_0');
    assert.equal((r.c.snapshot.stream as unknown as { id: string }).id, 'display_0');
  });

  test('the frame is dropped the moment the session is released', () => {
    const r = rig();
    r.c.start({ sessionId: 's1', url: 'ws://x', token: 't' });
    (r.last().o.onStream as (s: unknown, l: string) => void)(stream('display_0'), 'display_0');
    r.c.stop();
    assert.equal(r.c.snapshot.stream, null, 'a released device must not keep painting');
  });

  test('the live panel reaches the snapshot, which is what the stage draws', () => {
    const r = rig();
    r.c.start({ sessionId: 's1', url: 'ws://x', token: 't' });
    r.last().screen = LIVE;
    (r.last().o.onState as (s: string) => void)('streaming');
    assert.deepEqual(stageScreenFor(r.c.snapshot.screen, REGISTERED), LIVE);
  });
});
