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
