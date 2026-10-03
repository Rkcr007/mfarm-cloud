/**
 * D71 — a media connection that drops for a moment and comes back is still streaming.
 *
 * Found on the TURN relay in the console: Chrome's consent checks stalled behind a busy TCP leg, the
 * connection went `disconnected` and recovered 3.7 s later, and the view announced "connected, but no
 * display" over a picture that was playing. `disconnected` was treated as terminal, and on the way
 * back `ontrack` — which had already fired — never fired again, so the display grace timer decided
 * there was no display.
 *
 * Driven here through the real negotiation: the worker's frames on a fake socket, and a fake peer
 * connection whose state the test moves. The clock is mocked, because both decisions are timers.
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { LiveSession } from '../public/live.js';

function harness() {
  const states: string[] = [];
  let socket: any;
  let peer: any;
  const g = globalThis as Record<string, unknown>;
  const saved = { WebSocket: g.WebSocket, RTCPeerConnection: g.RTCPeerConnection };
  g.WebSocket = class {
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readyState = 1;
    constructor() { socket = this; }
    send() {}
    close() {}
  };
  g.RTCPeerConnection = class {
    connectionState = 'new';
    ontrack: ((ev: unknown) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    onicecandidate: (() => void) | null = null;
    ondatachannel: (() => void) | null = null;
    constructor() { peer = this; }
    createDataChannel() { return { readyState: 'connecting', send() {} }; }
    close() {}
    getStats() { return Promise.resolve(new Map()); }
  };
  const live: any = new LiveSession({
    url: 'ws://unused', token: 't',
    onState: (s: string) => states.push(s),
    onStream: () => {},
  });
  live.connect();
  const deliver = (msg: unknown) => socket.onmessage?.({ data: JSON.stringify(msg) });
  deliver({ t: 'ready', device: {} });
  deliver({ t: 'signal-ready', iceServers: [] });
  const move = (state: string) => { peer.connectionState = state; peer.onconnectionstatechange?.(); };
  const track = () => peer.ontrack?.({ streams: [{ id: 'display_phone-test' }] });
  const restore = () => { live.close(); Object.assign(g, saved); };
  return { live, states, move, track, restore };
}

describe('a dropped media connection that comes back', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }));
  afterEach(() => mock.timers.reset());

  test('is streaming again, and never "no display"', () => {
    const h = harness();
    try {
      h.track();
      h.move('connected');
      assert.equal(h.live.state, 'streaming');
      h.move('disconnected');
      mock.timers.tick(3_700);               // the relay's stall, as measured
      h.move('connected');
      mock.timers.tick(30_000);              // well past both grace timers
      assert.equal(h.live.state, 'streaming', `went ${h.states.join(' → ')}`);
      assert.ok(!h.states.includes('nodisplay'), 'a playing picture was called "no display"');
      assert.ok(!h.states.includes('failed'), 'a hiccup the connection recovered from was called a failure');
    } finally { h.restore(); }
  });

  test('a drop that does not come back is said to have dropped', () => {
    const h = harness();
    try {
      h.track();
      h.move('connected');
      h.move('disconnected');
      mock.timers.tick(7_000);
      assert.equal(h.live.state, 'streaming', 'called failed before the grace ran out');
      mock.timers.tick(2_000);
      assert.equal(h.live.state, 'failed');
    } finally { h.restore(); }
  });

  test('and recovering after being called dropped brings the picture back', () => {
    const h = harness();
    try {
      h.track();
      h.move('connected');
      h.move('disconnected');
      mock.timers.tick(10_000);
      assert.equal(h.live.state, 'failed');
      h.move('connected');
      assert.equal(h.live.state, 'streaming');
    } finally { h.restore(); }
  });

  test('a connection that never delivered a display still says so', () => {
    const h = harness();
    try {
      h.move('connected');                   // no track
      mock.timers.tick(10_000);
      assert.equal(h.live.state, 'nodisplay', 'the Cuttlefish no-display case still has to be reported');
    } finally { h.restore(); }
  });
});
