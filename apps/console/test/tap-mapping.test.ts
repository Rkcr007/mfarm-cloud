/**
 * Where a tap lands — the one thing this console cannot get slightly wrong.
 *
 * A stream at the wrong frame rate is a worse demo. A touch at the wrong coordinate is a test that
 * pressed the button next to the one it meant, and it fails somewhere else entirely. `HANDOFF.md`
 * has carried "touch accuracy has no test coverage" as an open item since the old console shipped,
 * because its DOM shim answers `getBoundingClientRect` with zeroes.
 *
 * This tests the REAL implementation — `live.js`'s `attachInput`, the same function the browser
 * runs — by giving it a fake element whose geometry a test controls. Nothing here reimplements the
 * scaling; a copy of the formula would agree with itself forever and prove nothing.
 *
 * THE RULE BEING PINNED, from `live.js`'s own comment: coordinates scale by the ratio of the
 * video's INTRINSIC width to its RENDERED width, and the height is never consulted, because the
 * element preserves the aspect ratio and reading `offsetHeight` on a letterboxed element gives the
 * wrong ratio. That is why `LiveSnapshot.screen` carries the panel the WORKER reports rather than
 * the registered one — if the element letterboxes, this whole file's assumption is void.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { LiveSession } from '../../api/public/live.js';

/* ------------------------------------------------------------------ a video element, minimally */

interface PointerLike {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  clientX?: number;
  clientY?: number;
}

class FakeVideo {
  listeners = new Map<string, ((e: unknown) => void)[]>();
  focused = 0;
  captured: number[] = [];
  /** The stream's own pixel width. 0 before the first frame arrives, which is a real case. */
  videoWidth = 0;
  videoHeight = 0;
  /** The width the element is drawn at, in CSS pixels. */
  offsetWidth = 0;
  offsetHeight = 0;
  /** No `.dev-taps` under it, so the local echo is skipped — it draws nothing we assert on. */
  parentElement = { querySelector: () => null };

  addEventListener(ev: string, fn: (e: unknown) => void) {
    const l = this.listeners.get(ev) ?? [];
    l.push(fn);
    this.listeners.set(ev, l);
  }
  focus() { this.focused += 1; }
  setPointerCapture(id: number) { this.captured.push(id); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.offsetWidth, height: this.offsetHeight }; }

  fire(ev: string, e: PointerLike) {
    for (const fn of this.listeners.get(ev) ?? []) fn(e);
  }
}

interface TouchFrame {
  type: string;
  id: number[];
  x: number[];
  y: number[];
  down: number;
  device_label: string;
}

function rig(opts: { videoWidth: number; offsetWidth: number }) {
  const sent: TouchFrame[] = [];
  const video = new FakeVideo();
  video.videoWidth = opts.videoWidth;
  video.offsetWidth = opts.offsetWidth;

  const live = new LiveSession({ url: 'ws://unused', token: 't' });
  // The input datachannel, which `attachInput` writes to. Created by us in the real negotiation.
  (live as unknown as { input: unknown }).input = {
    readyState: 'open',
    send: (m: string) => sent.push(JSON.parse(m) as TouchFrame),
  };
  live.attachInput(video as unknown as HTMLVideoElement);
  return { live, video, sent };
}

const down = (v: FakeVideo, p: PointerLike) => v.fire('pointerdown', p);
const move = (v: FakeVideo, p: PointerLike) => v.fire('pointermove', p);
const up = (v: FakeVideo, p: PointerLike) => v.fire('pointerup', p);

/* ------------------------------------------------------------------ tests */

describe('a tap is scaled to device pixels', () => {
  test('a 1:1 element passes coordinates through unchanged', () => {
    const r = rig({ videoWidth: 720, offsetWidth: 720 });
    down(r.video, { pointerId: 1, offsetX: 300, offsetY: 640 });
    assert.equal(r.sent.length, 1);
    assert.deepEqual(r.sent[0]!.x, [300]);
    assert.deepEqual(r.sent[0]!.y, [640]);
  });

  /**
   * The ordinary case: a 1080-wide panel drawn 360 CSS pixels wide.
   *
   * The expected values are computed from the DEVICE's geometry by hand — 100 × 3 and 200 × 3 —
   * rather than by re-running the implementation's formula, so the assertion cannot agree with a
   * broken implementation by construction.
   */
  test('a downscaled element multiplies by the intrinsic ratio', () => {
    const r = rig({ videoWidth: 1080, offsetWidth: 360 });
    down(r.video, { pointerId: 1, offsetX: 100, offsetY: 200 });
    assert.deepEqual(r.sent[0]!.x, [300]);
    assert.deepEqual(r.sent[0]!.y, [600]);
  });

  test('an upscaled element divides', () => {
    const r = rig({ videoWidth: 360, offsetWidth: 720 });
    down(r.video, { pointerId: 1, offsetX: 500, offsetY: 300 });
    assert.deepEqual(r.sent[0]!.x, [250]);
    assert.deepEqual(r.sent[0]!.y, [150]);
  });

  test('the far corner maps to the far corner, not past it', () => {
    const r = rig({ videoWidth: 1080, offsetWidth: 360 });
    // The last addressable CSS pixel of a 360-wide element.
    down(r.video, { pointerId: 1, offsetX: 359, offsetY: 779 });
    assert.deepEqual(r.sent[0]!.x, [1077]);
    assert.deepEqual(r.sent[0]!.y, [2337], 'must stay inside a 1080×2340 panel');
  });

  test('coordinates are truncated to integers, never fractional', () => {
    const r = rig({ videoWidth: 1000, offsetWidth: 300 });
    down(r.video, { pointerId: 1, offsetX: 100, offsetY: 100 });
    // 100 * (1000/300) = 333.33…
    assert.deepEqual(r.sent[0]!.x, [333]);
    assert.ok(Number.isInteger(r.sent[0]!.x[0]), 'the device protocol takes integers');
  });

  /**
   * Before the first frame there is no intrinsic width, and `live.js` deliberately sends a tap at
   * the origin rather than dropping the event — "a click at 0,0 is no more dangerous than a click
   * anywhere else on a screen the user cannot see". Pinned so nobody later "fixes" it into a
   * divide-by-zero or a silent drop.
   */
  test('a tap before the first frame is sent at the origin rather than dropped', () => {
    const r = rig({ videoWidth: 0, offsetWidth: 360 });
    down(r.video, { pointerId: 1, offsetX: 100, offsetY: 200 });
    assert.equal(r.sent.length, 1, 'the event must not be swallowed');
    assert.deepEqual(r.sent[0]!.x, [0]);
    assert.deepEqual(r.sent[0]!.y, [0]);
  });

  test('an unlaid-out element does not divide by zero', () => {
    const r = rig({ videoWidth: 1080, offsetWidth: 0 });
    down(r.video, { pointerId: 1, offsetX: 10, offsetY: 10 });
    assert.equal(r.sent.length, 1);
    assert.ok(Number.isFinite(r.sent[0]!.x[0]), 'no Infinity may reach the device');
  });
});

describe('a gesture is a press, a drag and a release', () => {
  let r: ReturnType<typeof rig>;
  beforeEach(() => { r = rig({ videoWidth: 720, offsetWidth: 360 }); });

  test('press then release sends down then up, with the same pointer id', () => {
    down(r.video, { pointerId: 7, offsetX: 10, offsetY: 20 });
    up(r.video, { pointerId: 7, offsetX: 10, offsetY: 20 });
    assert.equal(r.sent.length, 2);
    assert.equal(r.sent[0]!.down, 1);
    assert.equal(r.sent[1]!.down, 0);
    assert.deepEqual(r.sent[0]!.id, [7]);
    assert.deepEqual(r.sent[1]!.id, [7]);
  });

  /**
   * A move with no finger down is the mouse crossing the screen. Sending it would drag the device's
   * UI with an unpressed cursor, which is not a gesture any user made.
   */
  test('a move with nothing pressed sends nothing', () => {
    move(r.video, { pointerId: 1, offsetX: 50, offsetY: 50 });
    assert.equal(r.sent.length, 0);
  });

  test('a move while pressed is sent, scaled', () => {
    down(r.video, { pointerId: 1, offsetX: 10, offsetY: 10 });
    move(r.video, { pointerId: 1, offsetX: 50, offsetY: 60 });
    assert.equal(r.sent.length, 2);
    assert.deepEqual(r.sent[1]!.x, [100]);
    assert.deepEqual(r.sent[1]!.y, [120]);
    assert.equal(r.sent[1]!.down, 1, 'a drag is still a press');
  });

  test('a release that was never pressed sends nothing', () => {
    up(r.video, { pointerId: 99, offsetX: 1, offsetY: 1 });
    assert.equal(r.sent.length, 0);
  });

  test('releasing twice sends one up', () => {
    down(r.video, { pointerId: 1, offsetX: 1, offsetY: 1 });
    up(r.video, { pointerId: 1, offsetX: 1, offsetY: 1 });
    up(r.video, { pointerId: 1, offsetX: 1, offsetY: 1 });
    assert.equal(r.sent.filter((f) => f.down === 0).length, 1);
  });

  /**
   * Pointer capture, so a swipe that overshoots the phone's edge still delivers its release.
   * Without it the device is left believing a finger is still down — a stuck drag with no event
   * that would ever end it.
   */
  test('a press captures the pointer', () => {
    down(r.video, { pointerId: 3, offsetX: 1, offsetY: 1 });
    assert.deepEqual(r.video.captured, [3]);
  });

  test('two fingers are tracked independently', () => {
    down(r.video, { pointerId: 1, offsetX: 10, offsetY: 10 });
    down(r.video, { pointerId: 2, offsetX: 20, offsetY: 20 });
    move(r.video, { pointerId: 2, offsetX: 30, offsetY: 30 });
    up(r.video, { pointerId: 1, offsetX: 10, offsetY: 10 });
    move(r.video, { pointerId: 2, offsetX: 40, offsetY: 40 });

    const ids = r.sent.map((f) => f.id[0]);
    assert.deepEqual(ids, [1, 2, 2, 1, 2]);
    assert.equal(r.sent.at(-1)!.down, 1, 'the second finger is still down after the first lifted');
  });
});

describe('what the device is told about itself', () => {
  test('every frame carries the stream label the device matches on', () => {
    const r = rig({ videoWidth: 720, offsetWidth: 720 });
    down(r.video, { pointerId: 1, offsetX: 5, offsetY: 5 });
    assert.equal(r.sent[0]!.device_label, 'display_0');
    assert.equal(r.sent[0]!.type, 'multi-touch');
  });

  test('a press takes focus, so typing reaches the device', () => {
    const r = rig({ videoWidth: 720, offsetWidth: 720 });
    down(r.video, { pointerId: 1, offsetX: 5, offsetY: 5 });
    assert.equal(r.video.focused, 1);
  });

  /**
   * INSPECT MODE SWALLOWS THE TOUCH. Picking an element and pressing it are different intentions,
   * and one stray tap on "Delete" while hunting for its id is a bad afternoon.
   */
  test('inspect mode selects instead of tapping', () => {
    const picks: [number, number][] = [];
    const sent: TouchFrame[] = [];
    const video = new FakeVideo();
    video.videoWidth = 1080;
    video.offsetWidth = 360;
    const live = new LiveSession({
      url: 'ws://unused', token: 't',
      onInspectPick: (x: number, y: number) => picks.push([x, y]),
    });
    (live as unknown as { input: unknown }).input = {
      readyState: 'open', send: (m: string) => sent.push(JSON.parse(m) as TouchFrame),
    };
    live.attachInput(video as unknown as HTMLVideoElement);
    live.inspectMode = true;

    down(video, { pointerId: 1, offsetX: 100, offsetY: 200 });
    assert.equal(sent.length, 0, 'nothing may reach the device while inspecting');
    assert.deepEqual(picks, [[300, 600]], 'the pick is in device coordinates, scaled the same way');
  });
});

describe('a closed channel', () => {
  test('sends nothing rather than throwing', () => {
    const sent: TouchFrame[] = [];
    const video = new FakeVideo();
    video.videoWidth = 720;
    video.offsetWidth = 720;
    const live = new LiveSession({ url: 'ws://unused', token: 't' });
    (live as unknown as { input: unknown }).input = {
      readyState: 'closed', send: (m: string) => sent.push(JSON.parse(m) as TouchFrame),
    };
    live.attachInput(video as unknown as HTMLVideoElement);
    down(video, { pointerId: 1, offsetX: 5, offsetY: 5 });
    assert.equal(sent.length, 0);
  });
});
