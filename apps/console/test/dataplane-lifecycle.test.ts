/**
 * The connection, over a real socket, with the far end watching.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `liveController.test.ts`. That one drives a fake session and
 * can prove the controller *called* close. It cannot prove anybody heard it — and the property that
 * keeps `MAX_CHANNELS_PER_HOST` from filling up is not "we called close", it is "the worker's
 * channel went away". Those are the same sentence right up until the moment a socket is half-open,
 * which is the exact failure ADR-0021 documented for the agent tunnel and deliberately left open
 * for browser channels.
 *
 * So every assertion below is made by the SERVER, about what it observed. This is the same lesson
 * as `mfarm-inject-blindspot`: a suite that only ever asks the client whether it hung up cannot see
 * a socket-lifecycle bug, and one such bug shipped a feature that worked 0% of the time.
 *
 * Node 22+ has a native `WebSocket` client, so `live.js` runs unmodified here — the code under test
 * is the same file the browser loads, not a port of it. No `RTCPeerConnection` exists in Node, and
 * that is fine: the server never sends `signal-ready`, so negotiation never begins.
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

import { LiveController, armUnloadGuard } from '../src/app/session/liveController.ts';

/** What the fake worker saw. Every assertion in this file reads from here. */
interface Observed {
  opened: number;
  closed: number;
  live: number;
  hellos: { token: string }[];
  messages: Record<string, unknown>[];
}

let http: Server;
let wss: WebSocketServer;
let url: string;
let seen: Observed;
/** Set by a test that wants the worker to refuse, before the client connects. */
let rejectNext = false;

before(async () => {
  http = createServer();
  wss = new WebSocketServer({ server: http });

  wss.on('connection', (ws: WsSocket) => {
    seen.opened += 1;
    seen.live += 1;
    ws.on('close', () => { seen.closed += 1; seen.live -= 1; });
    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      seen.messages.push(msg);
      if (msg.t === 'hello') {
        seen.hellos.push({ token: String(msg.token) });
        if (rejectNext) {
          // The worker's own refusal shape: an error frame, then an immediate close.
          ws.send(JSON.stringify({ t: 'error', message: 'the account is not authorised for this device' }));
          ws.close();
          return;
        }
        ws.send(JSON.stringify({
          t: 'ready',
          device: { screen: { width: 720, height: 1280, density: 320 }, capabilities: ['screen-stream'] },
        }));
      }
      // `signal-open` is acknowledged with silence on purpose. Answering `signal-ready` would send
      // `live.js` into `new RTCPeerConnection`, which does not exist in Node.
    });
  });

  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const addr = http.address();
  if (typeof addr === 'object' && addr) url = `ws://127.0.0.1:${addr.port}/dp/host-1`;
});

after(async () => {
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => http.close(() => r()));
});

/**
 * Every controller a test makes, stopped afterwards WHETHER OR NOT THE TEST PASSED.
 *
 * Not tidiness. A controller whose connection failed has a retry timer pending, and in Node a
 * pending timer keeps the event loop alive — so one failing assertion turned the whole run into a
 * hang with no output rather than a red test with a name. That is the same trap as the agent
 * keepalive test, which needed an explicit timeout for the same reason.
 */
const opened: LiveController[] = [];
function mk(): LiveController {
  const c = new LiveController();
  opened.push(c);
  return c;
}

beforeEach(() => {
  seen = { opened: 0, closed: 0, live: 0, hellos: [], messages: [] };
  rejectNext = false;
});

afterEach(() => {
  while (opened.length) opened.pop()!.stop();
});

/** Poll until `cond` holds, so a test never sleeps a fixed amount and hopes. */
async function until(cond: () => boolean, what: string, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

const target = (id = 's1') => ({ sessionId: id, url, token: `grant-for-${id}` });

describe('a viewer that connects', () => {
  test('opens one channel and presents its grant', { timeout: 15_000 }, async () => {
    const c = mk();
    c.start(target());
    await until(() => seen.hellos.length === 1, 'the hello frame');

    assert.equal(seen.opened, 1, 'exactly one channel');
    assert.equal(seen.hellos[0]!.token, 'grant-for-s1');
    await until(() => c.snapshot.state === 'authenticated', 'the worker to accept');
    // Read back from the socket rather than from our own defaults: this is the panel that decides
    // tap accuracy, and it must come from the worker.
    assert.deepEqual(c.snapshot.screen, { width: 720, height: 1280, density: 320 });
    c.stop();
    await until(() => seen.live === 0, 'the channel to close');
  });

  test('asks to open signalling once accepted', { timeout: 15_000 }, async () => {
    const c = mk();
    c.start(target());
    await until(() => seen.messages.some((m) => m.t === 'signal-open'), 'signal-open');
    c.stop();
    await until(() => seen.live === 0, 'the channel to close');
  });
});

describe('a viewer that goes away', () => {
  /**
   * THE ONE THAT MATTERS. The server, not the client, reports the close.
   *
   * A controller that merely dropped its reference would pass any assertion made against its own
   * state and fail this one, because the channel would sit open on the worker until TCP noticed.
   */
  test('stop closes the channel at the worker', { timeout: 15_000 }, async () => {
    const c = mk();
    c.start(target());
    await until(() => seen.live === 1, 'the channel to open');

    c.stop();
    await until(() => seen.closed === 1, 'the worker to observe the close');
    assert.equal(seen.live, 0, 'the worker must be holding no channel for this viewer');
  });

  test('switching device leaves exactly one channel open, never two', { timeout: 15_000 }, async () => {
    const c = mk();
    c.start(target('s1'));
    await until(() => seen.live === 1, 'the first channel');

    c.start(target('s2'));
    await until(() => seen.opened === 2, 'the second channel');
    // The interesting number is the LIVE one. Two opens is correct; two live at once is the leak.
    await until(() => seen.live === 1, 'the first channel to have been closed');

    c.stop();
    await until(() => seen.live === 0, 'the last channel to close');
    assert.equal(seen.closed, 2, 'both channels should have been closed by us');
  });

  /**
   * The StrictMode double-invoke, over a real socket.
   *
   * React mounts, runs the effect, tears it down, and runs it again. If any of those three steps
   * leaked, the worker would be holding two channels at the end of this test.
   */
  test('a mount/unmount/mount cycle leaves one channel', { timeout: 15_000 }, async () => {
    const c = mk();
    c.start(target());
    c.stop();
    c.start(target());
    await until(() => seen.live === 1 && seen.opened >= 1, 'exactly one live channel');

    // Settle, then assert it stayed at one rather than catching it mid-flight.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(seen.live, 1, 'a remount must not accumulate channels');

    c.stop();
    await until(() => seen.live === 0, 'the channel to close');
  });

  /**
   * Closing the tab. This is the gap ADR-0021 named and left open for browser channels: without
   * this guard the channel survives until the worker's TCP stack times out.
   */
  test('pagehide closes the channel', { timeout: 15_000 }, async () => {
    const handlers: Record<string, (() => void)[]> = {};
    const fakeWindow = {
      addEventListener: (ev: string, fn: () => void) => { (handlers[ev] ??= []).push(fn); },
      removeEventListener: (ev: string, fn: () => void) => {
        handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn);
      },
    };
    const g = globalThis as unknown as { window?: unknown };
    const had = 'window' in g;
    g.window = fakeWindow;
    try {
      const c = mk();
      c.start(target());
      const disarm = armUnloadGuard(c);
      await until(() => seen.live === 1, 'the channel to open');

      assert.equal(handlers.pagehide?.length, 1, 'the guard should be listening for pagehide');
      for (const fn of handlers.pagehide!) fn();
      await until(() => seen.closed === 1, 'the worker to observe the close on tab hide');

      disarm();
      assert.equal(handlers.pagehide?.length, 0, 'the guard must remove its own listener');
    } finally {
      if (!had) delete g.window; else g.window = undefined;
    }
  });
});

describe('a worker that refuses', () => {
  /**
   * The worker's words win over ours.
   *
   * `reject()` sends an error frame and closes immediately. "the account is not authorised for this
   * device" is a better thing to show a person than "the connection closed", and `live.js` keeps
   * the last error precisely so the close handler can quote it.
   */
  test('the refusal reaches the view, and no channel is left open', { timeout: 15_000 }, async () => {
    rejectNext = true;
    const c = mk();
    c.start(target());
    await until(() => c.snapshot.state === 'failed', 'the view to report failure');
    assert.match(String(c.snapshot.detail), /not authorised/);
    await until(() => seen.live === 0, 'the refused channel to be gone');
    c.stop();
  });
});
