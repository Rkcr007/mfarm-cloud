/**
 * Which transport a hardware button goes down — and why a phone's Home button was dead.
 *
 * The console has two input paths and they were split by accident rather than by design. Volume and
 * Rotate call `sendControl`, which writes to the data-plane socket every attached device holds.
 * Power, Back, Home and Overview called `pressButton`, which wrote to the `device-control` WebRTC
 * datachannel — and a physical handset negotiates no peer connection at all, so it has no such
 * channel and those four buttons did nothing. They were also gated on `streaming`, so they rendered
 * disabled, which is why it read as "physical devices are not interactive" rather than as a bug.
 *
 * The datachannel is still preferred where one exists: it carries a real down/up pair, and the data
 * plane's `{t:'key'}` is a single event.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { LiveSession, BUTTON_KEY } from '../public/live.js';

type Sent = string[];

/** A LiveSession with no transports, so each test opens exactly the one it is about. */
function session(): { live: any; ws: Sent; channel: Sent } {
  const ws: Sent = [];
  const channel: Sent = [];
  const live: any = new LiveSession({ url: 'ws://unused', token: 't', onState: () => {}, onStream: () => {} });
  live.ws = { readyState: 1 /* WebSocket.OPEN */, send: (m: string) => ws.push(m) };
  return { live, ws, channel };
}

const openChannel = (live: any, sink: Sent) => {
  live.control = { readyState: 'open', send: (m: string) => sink.push(m) };
};

describe('a hardware button on a device with no video', () => {
  let s: ReturnType<typeof session>;
  beforeEach(() => { s = session(); });

  test('Home reaches the device over the data-plane socket', () => {
    assert.equal(s.live.pressButton('home'), true);
    assert.equal(s.ws.length, 1);
    const msg = JSON.parse(s.ws[0]);
    assert.equal(msg.t, 'key');
    assert.equal(msg.name, 'home');
    assert.ok(typeof msg.seq === 'number', 'the data plane drops anything without a newer seq');
  });

  test('Back does too', () => {
    assert.equal(s.live.pressButton('back'), true);
    assert.equal(JSON.parse(s.ws[0]).name, 'back');
  });

  test('Overview is sent as `recents`, which is what the agent calls it', () => {
    // The one name that differs between the two vocabularies. Sending `menu` down the data plane
    // would be rejected by the agent's KeyName union and the button would look broken again.
    assert.equal(s.live.pressButton('menu'), true);
    assert.equal(JSON.parse(s.ws[0]).name, 'recents');
  });

  test('a command with no data-plane equivalent is refused, not silently dropped', () => {
    assert.equal(s.live.pressButton('eject'), false);
    assert.equal(s.ws.length, 0, 'the caller toasts on false; sending nothing and returning true would not');
  });

  test('with no socket either, it fails rather than pretending', () => {
    s.live.ws = { readyState: 3 /* CLOSED */, send: () => { throw new Error('must not send'); } };
    assert.equal(s.live.pressButton('home'), false);
  });
});

describe('a hardware button on a device that does have video', () => {
  test('prefers the control channel, and leaves the data plane alone', () => {
    const s = session();
    openChannel(s.live, s.channel);
    assert.equal(s.live.pressButton('home'), true);
    assert.equal(s.ws.length, 0, 'the datachannel is the shorter path where it exists');
    assert.deepEqual(JSON.parse(s.channel[0]), { command: 'home', button_state: 'down' });
  });

  test('a closed channel falls through to the data plane rather than failing', () => {
    // The window between attach and the datachannel opening: Cuttlefish used to refuse input in it.
    const s = session();
    s.live.control = { readyState: 'connecting', send: () => { throw new Error('must not send'); } };
    assert.equal(s.live.pressButton('home'), true);
    assert.equal(JSON.parse(s.ws[0]).name, 'home');
  });
});

describe('the two vocabularies', () => {
  test('every console button maps to a real agent KeyName', () => {
    // workers/agent/src/device.ts: 'home' | 'back' | 'recents' | 'power' | 'enter' | 'backspace'
    // | 'volume_up' | 'volume_down'. A typo here is a button that renders enabled and does nothing.
    const KEY_NAMES = new Set(['home', 'back', 'recents', 'power', 'enter', 'backspace', 'volume_up', 'volume_down']);
    for (const [command, name] of Object.entries(BUTTON_KEY)) {
      assert.ok(KEY_NAMES.has(name as string), `${command} -> ${name} is not a KeyName`);
    }
  });
});

/**
 * A FAILED COMMAND MUST NOT TAKE DOWN A WORKING STREAM.
 *
 * `case 'error'` used to call `#state('failed')` for every error frame, justified by a comment
 * reading "the worker's refusals are terminal by construction — it closes the socket after each
 * one". That was false, and the worker has three paths that prove it:
 *
 *   `reject()`       sends an error and CLOSES the socket — auth, an unknown message. Terminal.
 *   `device_error`   sends an error and keeps going — a tap, a key, a rotate that failed.
 *   `input_overrun`  sends an error and keeps going — the device is behind on input.
 *
 * So a rotate that a portrait-locked app declined tore down a healthy 50fps stream and replaced the
 * video with `adb exited 134:`. Observed on a real session 2026-08-31. `input_overrun` would do the
 * same under heavy interaction, which is worse — it fires when the device is BUSY, not broken.
 *
 * The fix does not enumerate fatal codes; that list is wrong the moment the worker adds one. The
 * SOCKET decides. These drive the real `connect()` path with a fake WebSocket, because the bug was
 * in socket lifecycle and a test that called a handler directly would not have seen it.
 */
describe('an error frame is information; the close is the verdict', () => {
  /** The minimum WebSocket `connect()` needs, with the frames it received observable. */
  function harness() {
    const states: { state: string; detail: string | undefined }[] = [];
    const notices: string[] = [];
    let socket: any;

    const previous = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = class {
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      readyState = 1;
      constructor() { socket = this; }
      send() { /* the hello; nothing here reads it */ }
      close() { /* the console closing is not what these tests are about */ }
    };

    const live: any = new LiveSession({
      url: 'ws://unused', token: 't',
      onState: (state: string, detail?: string) => states.push({ state, detail }),
      onStream: () => {},
      onNotice: (m: string) => notices.push(m),
    });
    live.connect();
    // Past the handshake: these tests are about a device that is already working. `connect()`
    // reports 'connecting' on the way, which is setup noise rather than anything under test.
    live.state = 'streaming';
    states.length = 0;

    const restore = () => { (globalThis as Record<string, unknown>).WebSocket = previous; };
    const deliver = (msg: unknown) => socket.onmessage?.({ data: JSON.stringify(msg) });
    return { live, states, notices, deliver, hangUp: () => socket.onclose?.(), restore };
  }

  test('a device_error is a toast, and the stream keeps streaming', () => {
    const h = harness();
    try {
      h.deliver({ t: 'error', code: 'device_error', message: 'the app on screen is locked to its current orientation' });
      assert.deepEqual(h.states.map((s) => s.state), [], 'no state change: the connection is fine');
      assert.equal(h.live.state, 'streaming', 'the video was still arriving and must keep arriving');
      assert.deepEqual(h.notices, ['the app on screen is locked to its current orientation']);
    } finally { h.restore(); }
  });

  test('an input_overrun does not kill the view of a device that is merely busy', () => {
    const h = harness();
    try {
      h.deliver({ t: 'error', code: 'input_overrun', message: 'Input queue full; the device is not keeping up.' });
      assert.equal(h.live.state, 'streaming');
      assert.equal(h.notices.length, 1);
    } finally { h.restore(); }
  });

  test('an error the worker CLOSES on still fails, and quotes the worker', () => {
    // `reject()` sends the frame and closes immediately. The close is what makes it terminal, and
    // the worker's own words beat the generic "the connection to the device closed."
    const h = harness();
    try {
      h.deliver({ t: 'error', code: 'forbidden', message: 'That grant is not for this device.' });
      h.hangUp();
      const failed = h.states.filter((s) => s.state === 'failed');
      assert.equal(failed.length, 1, 'the close is what declares failure');
      assert.equal(failed[0]!.detail, 'That grant is not for this device.');
    } finally { h.restore(); }
  });

  test('a close with no preceding error still explains itself', () => {
    const h = harness();
    try {
      h.hangUp();
      const failed = h.states.filter((s) => s.state === 'failed');
      assert.equal(failed.length, 1);
      assert.match(failed[0]!.detail!, /connection to the device closed/);
    } finally { h.restore(); }
  });
});
