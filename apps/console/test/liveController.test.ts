/**
 * The rules that decide whether a viewer leaks a data-plane channel.
 *
 * These drive `LiveController` with an injected fake session, so every test is about WHEN a
 * connection exists rather than about what it negotiates. The companion file
 * `dataplane-lifecycle.test.ts` does the same journey over a real socket against a real server,
 * because a fake cannot tell you whether the far end saw the close — and "the far end saw the
 * close" is the entire property that keeps `MAX_CHANNELS_PER_HOST` from filling up.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { LiveController, RETRY_DELAYS_MS, type LiveSnapshot } from '../src/app/session/liveController.ts';

/* ------------------------------------------------------------------ fakes */

/** Records what was done to it, and lets a test drive the callbacks the real session would fire. */
class FakeSession {
  static made: FakeSession[] = [];
  connected = 0;
  closed = 0;
  attached: unknown[] = [];
  screen: { width: number; height: number; density: number } | null = null;
  stats = { fps: 0, kbps: 0, rtt: null as number | null, ice: null as string | null };
  readonly o: Record<string, (...a: never[]) => void> & Record<string, unknown>;
  constructor(o: Record<string, (...a: never[]) => void> & Record<string, unknown>) {
    this.o = o;
    FakeSession.made.push(this);
  }
  connect() { this.connected += 1; }
  close() { this.closed += 1; }
  attachInput(v: unknown) { this.attached.push(v); }
  pressButton() { return true; }
  sendControl() { return true; }
  /* the callbacks, as the real session would call them */
  fireState(state: string, detail?: string) {
    (this.o.onState as (s: string, d?: string) => void)?.(state, detail);
  }
  fireStream(stream: unknown) {
    (this.o.onStream as (s: unknown, l: string) => void)?.(stream, 'display_0');
  }
  fireNotice(m: string) { (this.o.onNotice as (m: string) => void)?.(m); }
}

/** Deterministic clock. Nothing here waits on wall time. */
class Clock {
  private q: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  now = 0;
  set = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.q.push({ at: this.now + ms, fn, id });
    return id;
  };
  clear = (h: unknown): void => { this.q = this.q.filter((e) => e.id !== h); };
  /** Run everything due within `ms`, in time order, including work those callbacks schedule. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = this.q.filter((e) => e.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.q = this.q.filter((e) => e !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = until;
  }
  get pending(): number { return this.q.length; }
}

function harness() {
  FakeSession.made = [];
  const clock = new Clock();
  const seen: LiveSnapshot[] = [];
  const c = new LiveController({
    createSession: (o) => new FakeSession(o as never) as never,
    setTimeoutFn: clock.set,
    clearTimeoutFn: clock.clear,
  });
  c.subscribe((s) => seen.push(s));
  return { c, clock, seen, made: () => FakeSession.made, last: () => FakeSession.made.at(-1)! };
}

const TARGET = { sessionId: 's1', url: 'wss://farm.example/dp/h1', token: 'tok' };

/* ------------------------------------------------------------------ tests */

describe('one socket per controller', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  /**
   * THE STRICTMODE CASE, and the reason this rule exists at all.
   *
   * React 19 invokes every effect twice on mount in development. A controller that dialled per call
   * would open two channels for every device anyone looked at, against a per-host cap of 32.
   */
  test('starting twice with the same session dials once', () => {
    h.c.start(TARGET);
    h.c.start(TARGET);
    assert.equal(h.made().length, 1, 'a second start on the same session must not dial again');
    assert.equal(h.last().connected, 1);
  });

  test('a different session closes the first before opening the second', () => {
    h.c.start(TARGET);
    const first = h.last();
    h.c.start({ ...TARGET, sessionId: 's2' });
    assert.equal(h.made().length, 2, 'the new session should have dialled');
    assert.equal(first.closed, 1, 'the previous session must be closed, not abandoned');
  });

  test('restarting after a stop dials again', () => {
    h.c.start(TARGET);
    h.c.stop();
    h.c.start(TARGET);
    assert.equal(h.made().length, 2);
    assert.equal(h.made()[0]!.closed, 1);
  });
});

describe('a superseded session cannot speak', () => {
  /**
   * Verified through the SNAPSHOT rather than through a flag on the controller.
   *
   * Asserting "the generation counter went up" would pass against an implementation that increments
   * the counter and then ignores it. What matters is that the stale callback changes nothing a
   * viewer would render, so that is what is checked.
   */
  test('a state event from the previous session is ignored', () => {
    const h = harness();
    h.c.start(TARGET);
    const first = h.last();
    h.c.start({ ...TARGET, sessionId: 's2' });
    h.last().fireState('streaming');
    assert.equal(h.c.snapshot.state, 'streaming');

    first.fireState('failed', 'the old one died');
    assert.equal(h.c.snapshot.state, 'streaming', 'the superseded session must not overwrite state');
    assert.equal(h.c.snapshot.detail, null);
  });

  test('a stream from the previous session never reaches the view', () => {
    const h = harness();
    h.c.start(TARGET);
    const first = h.last();
    h.c.start({ ...TARGET, sessionId: 's2' });
    const stale = { id: 'stale' };
    first.fireStream(stale);
    assert.equal(h.c.snapshot.stream, null, 'a frame from the device we let go must not be painted');
  });
});

describe('stopping is final', () => {
  test('stop closes the session and reports closed', () => {
    const h = harness();
    h.c.start(TARGET);
    h.c.stop();
    assert.equal(h.last().closed, 1);
    assert.equal(h.c.snapshot.state, 'closed');
    assert.equal(h.c.snapshot.stream, null);
  });

  test('stop is safe when nothing was ever started', () => {
    const h = harness();
    h.c.stop();
    assert.equal(h.c.snapshot.state, 'closed');
  });

  test('stop is idempotent', () => {
    const h = harness();
    h.c.start(TARGET);
    h.c.stop();
    h.c.stop();
    assert.equal(h.last().closed, 1, 'closing twice must not double-close the session');
  });

  /**
   * The race this is really about: a socket that fails DURING teardown.
   *
   * Without the stopped flag the failure schedules a retry, the retry fires after the component is
   * gone, and the page holds a channel nobody can see or close.
   */
  test('a failure after stop schedules no retry', () => {
    const h = harness();
    h.c.start(TARGET);
    const s = h.last();
    h.c.stop();
    s.fireState('failed', 'closed underneath us');
    h.clock.advance(60_000);
    assert.equal(h.made().length, 1, 'a stopped controller must never re-dial');
  });
});

describe('reconnect', () => {
  test('a failure re-dials on the backoff schedule', () => {
    const h = harness();
    h.c.start(TARGET);
    h.last().fireState('failed', 'dropped');
    assert.equal(h.made().length, 1, 'the retry is scheduled, not immediate');

    h.clock.advance(RETRY_DELAYS_MS[0]!);
    assert.equal(h.made().length, 2, 'it should have re-dialled after the first delay');
  });

  test('the failed session is closed before the next is dialled', () => {
    const h = harness();
    h.c.start(TARGET);
    const first = h.last();
    first.fireState('failed', 'dropped');
    assert.equal(first.closed, 1, 'overlapping the two is how one viewer holds two channels');
    h.clock.advance(RETRY_DELAYS_MS[0]!);
    assert.equal(h.made().length, 2);
  });

  test('the budget is finite — it gives up rather than dialling forever', () => {
    const h = harness();
    h.c.start(TARGET);
    for (let i = 0; i < RETRY_DELAYS_MS.length; i += 1) {
      h.last().fireState('failed', 'dropped');
      h.clock.advance(RETRY_DELAYS_MS[i]!);
    }
    const afterBudget = h.made().length;
    h.last().fireState('failed', 'dropped');
    h.clock.advance(600_000);
    assert.equal(h.made().length, afterBudget, 'past the budget it must stop dialling');
    assert.equal(h.c.snapshot.state, 'failed');
  });

  test('a clean connect resets the budget so a link that flaps hourly never exhausts it', () => {
    const h = harness();
    h.c.start(TARGET);
    h.last().fireState('failed', 'dropped');
    h.clock.advance(RETRY_DELAYS_MS[0]!);
    assert.equal(h.c.snapshot.retries, 1);

    h.last().fireState('streaming');
    assert.equal(h.c.snapshot.retries, 0, 'reaching a stream should forgive the earlier drop');
  });

  test('retryNow re-dials immediately and resets the budget', () => {
    const h = harness();
    h.c.start(TARGET);
    h.last().fireState('failed', 'dropped');
    h.c.retryNow();
    assert.equal(h.made().length, 2);
    assert.equal(h.c.snapshot.retries, 0);
  });
});

describe('what the view is told', () => {
  test('the live panel is carried, because it decides tap accuracy', () => {
    const h = harness();
    h.c.start(TARGET);
    h.last().screen = { width: 720, height: 1280, density: 320 };
    h.last().fireState('authenticated');
    assert.deepEqual(h.c.snapshot.screen, { width: 720, height: 1280, density: 320 });
  });

  test('notices accumulate without replacing the state, and stay bounded', () => {
    const h = harness();
    h.c.start(TARGET);
    h.last().fireState('streaming');
    for (let i = 0; i < 25; i += 1) h.last().fireNotice(`notice ${i}`);
    assert.equal(h.c.snapshot.state, 'streaming', 'a refused verb must not tear the view down');
    assert.equal(h.c.snapshot.notices.length, 20, 'an input-overrun loop must not grow without limit');
    assert.equal(h.c.snapshot.notices.at(-1), 'notice 24');
  });

  test('subscribers are released on unsubscribe', () => {
    const h = harness();
    let count = 0;
    const off = h.c.subscribe(() => { count += 1; });
    h.c.start(TARGET);
    const afterStart = count;
    off();
    h.last().fireState('streaming');
    assert.equal(count, afterStart, 'an unsubscribed listener must stop being called');
  });
});

describe('input is attached exactly once per element', () => {
  /**
   * Two `pointerdown` listeners means two `multi-touch` frames per tap, and the device reads that
   * as a second finger. `live.js`'s `attachInput` offers no way to remove what it added, so the
   * only defence is not calling it twice.
   */
  test('attaching the same element repeatedly binds once', () => {
    const h = harness();
    h.c.start(TARGET);
    const el = { id: 'video' } as unknown as HTMLVideoElement;
    h.c.attach(el);
    h.c.attach(el);
    h.c.attach(el);
    assert.equal(h.last().attached.length, 1);
  });

  test('attaching before a session exists does nothing rather than throwing', () => {
    const h = harness();
    h.c.attach({ id: 'video' } as unknown as HTMLVideoElement);
    assert.equal(h.made().length, 0);
  });
});
