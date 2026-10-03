/**
 * Live video for a phone — M6.
 *
 * The last test here runs the real WebRTC stack on both ends: a werift peer plays the console's part —
 * asks for an offer, answers, receives RTP, sends a touch on `input-channel` — against the agent's
 * phone peer fed by a scripted capture. What it cannot stand in for is a browser's decoder and a real
 * phone's encoder; those are the hardware run.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  packetizeNal, videoSizeFor, charFor, InputMapper, H264Fanout, PhoneVideoPeer, nalType,
  parseIceUrl, answersOverUdp, answersOverTcp, reachableIceServers, spsSize,
} from '../src/devices/phone-stream.ts';
import type { ScreenCapture, FrameMark, LiveControl } from '../src/devices/capture.ts';

/** A NAL of `type` and `size` bytes — the header byte carries NRI 3. */
const nal = (type: number, size: number) => { const b = Buffer.alloc(size, 0xab); b[0] = 0x60 | type; return b; };

describe('RTP packetization (RFC 6184)', () => {
  test('a NAL that fits goes out whole', () => {
    const parts = packetizeNal(nal(1, 500));
    assert.equal(parts.length, 1);
    assert.equal(parts[0].length, 500);
  });

  test('a large NAL is cut into FU-A fragments that reassemble exactly', () => {
    const big = nal(5, 5000);
    const parts = packetizeNal(big, 1100);
    assert.ok(parts.length > 4);
    assert.equal(parts[0][0] & 0x1f, 28, 'FU-A indicator');
    assert.equal(parts[0][0] & 0x60, 0x60, 'NRI carried from the NAL header');
    assert.equal(parts[0][1] & 0x80, 0x80, 'start bit on the first');
    assert.equal(parts.at(-1)![1] & 0x40, 0x40, 'end bit on the last');
    assert.ok(parts.every((p) => (p[1] & 0x1f) === 5), 'every fragment names the original type');
    const rebuilt = Buffer.concat([Buffer.from([big[0]]), ...parts.map((p) => p.subarray(2))]);
    assert.deepEqual(rebuilt, big);
    assert.ok(parts.every((p) => p.length <= 1100));
  });
});

describe('the size scrcpy encodes at', () => {
  test('a 1080x2400 phone at 1280 is 576x1280', () => {
    assert.deepEqual(videoSizeFor({ width: 1080, height: 2400 }, 1280), { w: 576, h: 1280 });
  });
  test('no limit keeps the panel, rounded to multiples of 8', () => {
    assert.deepEqual(videoSizeFor({ width: 1080, height: 2400 }), { w: 1080, h: 2400 });
    assert.deepEqual(videoSizeFor({ width: 1084, height: 2404 }), { w: 1080, h: 2400 });
  });
  test('landscape keeps its orientation', () => {
    assert.deepEqual(videoSizeFor({ width: 2400, height: 1080 }, 1280), { w: 1280, h: 576 });
  });
});

/**
 * Two real parameter sets: the OnePlus's own, captured off the farm through the console's path, and a
 * 1080p High-profile one from x264 — a cropped height (1088 coded, 1080 shown) and emulation
 * prevention bytes in the middle, the two things a naive reader gets wrong.
 */
const SPS_ONEPLUS_576x1280 = Buffer.from('6742800ada0240286948283030368509a8', 'hex');
const SPS_X264_HIGH_1080P = Buffer.from('67640028acd940780227e5c044000003000400000300f03c60c658', 'hex');

describe('the picture size, read from the stream itself', () => {
  test('the phone\'s own SPS is the size it streams at', () => {
    assert.deepEqual(spsSize(SPS_ONEPLUS_576x1280), { w: 576, h: 1280 });
  });
  test('High profile, cropped, with emulation prevention bytes', () => {
    assert.deepEqual(spsSize(SPS_X264_HIGH_1080P), { w: 1920, h: 1080 });
  });
  test('anything else is no answer, not a wrong one', () => {
    assert.equal(spsSize(nal(8, 4)), undefined, 'a PPS');
    // Filler that Exp-Golomb happily reads as 14x28 — the size every touch would then have named.
    assert.equal(spsSize(nal(7, 20)), undefined, 'junk read as a picture size');
    assert.equal(spsSize(SPS_X264_HIGH_1080P.subarray(0, 8)), undefined, 'cut short');
    assert.equal(spsSize(Buffer.alloc(0)), undefined);
  });
});

/** A control socket that records what it is asked to send, and can be made to have died. */
function fakeControl() {
  const calls: unknown[][] = [];
  const c = {
    calls,
    alive: true,
    touch(action: string, id: number, x: number, y: number, v: { w: number; h: number }) { calls.push(['touch', action, id, x, y, v.w, v.h]); return c.alive; },
    key(k: number) { calls.push(['key', k]); return c.alive; },
    text(t: string) { calls.push(['text', t]); return c.alive; },
    resetVideo() { calls.push(['reset']); return c.alive; },
  };
  return c satisfies LiveControl & { calls: unknown[][]; alive: boolean };
}

describe('input over scrcpy\'s control socket, as it happens', () => {
  const setup = (size?: { w: number; h: number }) => {
    const adb: unknown[][] = [];
    const input = {
      tap: async (...a: unknown[]) => { adb.push(['tap', ...a]); },
      swipe: async (...a: unknown[]) => { adb.push(['swipe', ...a]); },
      key: async (...a: unknown[]) => { adb.push(['key', ...a]); },
      text: async (...a: unknown[]) => { adb.push(['text', ...a]); },
    };
    const live: { control?: LiveControl; size?: { w: number; h: number } } = { control: fakeControl(), size };
    const m = new InputMapper(input, { width: 1080, height: 2400 }, { w: 576, h: 1280 }, live);
    return { adb, m, live, ctl: () => live.control as ReturnType<typeof fakeControl> };
  };
  const touch = (down: number, x: number, y: number, id = 1) => JSON.stringify({ type: 'multi-touch', id: [id], x: [x], y: [y], down });

  test('a drag goes down, every move, then up — in the video\'s pixels, while the finger moves', () => {
    const { adb, m, ctl } = setup();
    m.handle(touch(1, 288, 1000));
    assert.deepEqual(ctl().calls, [['touch', 'down', 1, 288, 1000, 576, 1280]], 'the phone heard nothing until the finger lifted');
    m.handle(touch(1, 288, 600));
    m.handle(touch(1, 288, 200));
    m.handle(touch(0, 288, 200));
    assert.deepEqual(ctl().calls.map((c) => c[1]), ['down', 'move', 'move', 'up']);
    assert.deepEqual(adb, [], 'the same drag also went over adb');
    assert.equal(m.last?.verb, 'release');
  });

  test('two fingers are two pointers', () => {
    const { m, ctl } = setup();
    m.handle(touch(1, 100, 100, 1));
    m.handle(touch(1, 400, 400, 2));
    m.handle(touch(0, 100, 100, 1));
    m.handle(touch(0, 400, 400, 2));
    assert.deepEqual(ctl().calls.map((c) => `${c[1]}:${c[2]}`), ['down:1', 'down:2', 'up:1', 'up:2']);
  });

  test('the size the encoder says it is producing wins over the one computed at start', () => {
    // Turned to landscape: the stream is 1280x576 now, and a touch stating 576x1280 would be dropped.
    const { m, ctl } = setup({ w: 1280, h: 576 });
    m.handle(touch(1, 640, 288));
    assert.deepEqual(ctl().calls[0], ['touch', 'down', 1, 640, 288, 1280, 576]);
  });

  test('a gesture finishes on the path it began on', () => {
    const { adb, m, live, ctl } = setup();
    const control = live.control;
    live.control = undefined;
    m.handle(touch(1, 288, 640));                    // began over adb
    live.control = control;                          // the socket opens mid-press
    m.handle(touch(0, 288, 640));
    assert.deepEqual(adb, [['tap', 540, 1200]]);
    assert.deepEqual(ctl().calls, [], 'an up the phone never saw go down');
  });

  test('a socket that has died sends the press over adb instead of dropping it', () => {
    const { adb, m, ctl } = setup();
    ctl().alive = false;
    m.handle(touch(1, 288, 640));
    m.handle(touch(0, 288, 640));
    assert.deepEqual(adb, [['tap', 540, 1200]]);
  });

  test('keys are keycodes and characters go one by one, unbatched', () => {
    const { adb, m, ctl } = setup();
    const key = (code: string, kind = 'keydown') => m.handle(JSON.stringify({ type: 'keyboard', keycode: code, event_type: kind }));
    key('ShiftLeft'); key('KeyH'); key('ShiftLeft', 'keyup'); key('KeyI');
    key('Tab'); key('ArrowDown'); key('Enter'); key('Backspace'); key('F5');
    assert.deepEqual(ctl().calls, [['text', 'H'], ['text', 'i'], ['key', 61], ['key', 20], ['key', 66], ['key', 67]]);
    assert.deepEqual(adb, []);
  });

  test('buttons are the phone\'s keycodes; menu is Recents', () => {
    const { adb, m, ctl } = setup();
    m.button(JSON.stringify({ command: 'home', button_state: 'down' }));
    m.button(JSON.stringify({ command: 'home', button_state: 'up' }));
    m.button(JSON.stringify({ command: 'menu', button_state: 'down' }));
    m.button(JSON.stringify({ command: 'power', button_state: 'down' }));
    assert.deepEqual(ctl().calls, [['key', 3], ['key', 187], ['key', 26]]);
    assert.deepEqual(adb, []);
  });
});

describe('the browser input channel, to the phone', () => {
  const recorder = () => {
    const calls: unknown[][] = [];
    const input = {
      tap: async (...a: unknown[]) => { calls.push(['tap', ...a]); },
      swipe: async (...a: unknown[]) => { calls.push(['swipe', ...a]); },
      key: async (...a: unknown[]) => { calls.push(['key', ...a]); },
      text: async (...a: unknown[]) => { calls.push(['text', ...a]); },
    };
    return { calls, m: new InputMapper(input, { width: 1080, height: 2400 }, { w: 576, h: 1280 }) };
  };
  const touch = (down: number, x: number, y: number) => JSON.stringify({ type: 'multi-touch', id: [1], x: [x], y: [y], down });

  test('a press in video pixels is a tap in device pixels', () => {
    const { calls, m } = recorder();
    m.handle(touch(1, 288, 640));
    m.handle(touch(0, 288, 640));
    assert.deepEqual(calls, [['tap', 540, 1200]]);
  });

  test('a drag is a swipe from where it began to where it ended', () => {
    const { calls, m } = recorder();
    m.handle(touch(1, 288, 1000));
    m.handle(touch(1, 288, 600));
    m.handle(touch(0, 288, 200));
    assert.equal(calls[0][0], 'swipe');
    assert.deepEqual(calls[0].slice(1, 5), [540, 1875, 540, 375]);
  });

  test('typing is gathered into one text call; Enter and Backspace are keys', async () => {
    const { calls, m } = recorder();
    const key = (code: string, kind = 'keydown') => m.handle(JSON.stringify({ type: 'keyboard', keycode: code, event_type: kind }));
    key('ShiftLeft'); key('KeyH'); key('ShiftLeft', 'keyup'); key('KeyI'); key('Space'); key('Digit2');
    key('Enter');
    key('Backspace');
    assert.deepEqual(calls, [['text', 'Hi 2'], ['key', 'enter'], ['key', 'backspace']]);
  });

  test('characters by code, with and without Shift', () => {
    assert.equal(charFor('KeyA', false), 'a');
    assert.equal(charFor('KeyA', true), 'A');
    assert.equal(charFor('Digit2', true), '@');
    assert.equal(charFor('F5', false), undefined, 'a key that types nothing sends nothing');
  });

  test('the latest input is on record with when it went and when the phone finished it', async () => {
    const { m } = recorder();
    m.handle(touch(1, 288, 640));
    const before = Date.now();
    m.handle(touch(0, 288, 640));
    assert.equal(m.last?.verb, 'tap');
    assert.ok(m.last!.at >= before);
    await new Promise((r) => setImmediate(r));
    assert.ok(m.last!.doneAt !== undefined && m.last!.doneAt >= m.last!.at, 'PHYSICAL_VIDEO_TRACE has nothing to time against');
  });

  test('a hardware button is pressed on its down half; menu is Recents', () => {
    const { calls, m } = recorder();
    m.button(JSON.stringify({ command: 'home', button_state: 'down' }));
    m.button(JSON.stringify({ command: 'home', button_state: 'up' }));
    m.button(JSON.stringify({ command: 'menu', button_state: 'down' }));
    assert.deepEqual(calls, [['key', 'home'], ['key', 'recents']]);
  });

  test('garbage on the channel is ignored, not thrown', () => {
    const { calls, m } = recorder();
    m.handle('not json');
    m.handle(JSON.stringify({ type: 'multi-touch', id: [1], x: ['nope'], y: [1], down: 1 }));
    assert.deepEqual(calls, []);
  });
});

/** A capture the test drives by hand — with a control socket when given one. */
function scriptedCapture(control?: LiveControl) {
  let emit: ((n: Buffer, at: number, frame?: FrameMark) => void) | undefined;
  let starts = 0;
  let stops = 0;
  const capture: ScreenCapture & { push(n: Buffer, frame?: FrameMark): void; starts: () => number; stops: () => number } = {
    kind: 'scrcpy',
    stats: { frames: 0, bytes: 0, startedAt: 0 },
    control,
    async start(onNal) { starts += 1; emit = onNal; },
    async stop() { stops += 1; emit = undefined; },
    push(n, frame) { emit?.(n, Date.now(), frame); },
    starts: () => starts,
    stops: () => stops,
  };
  return capture;
}

describe('one capture per phone, however many viewers', () => {
  test('started by the first viewer, stopped with the last, parameter sets kept', async () => {
    const cap = scriptedCapture();
    const fan = new H264Fanout(() => cap);
    const a: number[] = []; const b: number[] = [];
    const offA = await fan.subscribe((n) => a.push(nalType(n)));
    const offB = await fan.subscribe((n) => b.push(nalType(n)));
    assert.equal(cap.starts(), 1, 'a second viewer started a second scrcpy');
    cap.push(nal(7, 20)); cap.push(nal(8, 6)); cap.push(nal(5, 300));
    assert.deepEqual(a, [7, 8, 5]);
    assert.deepEqual(b, [7, 8, 5]);
    assert.ok(fan.sps && fan.pps);
    offA();
    assert.equal(cap.stops(), 0);
    offB();
    assert.equal(cap.stops(), 1);
  });

  test('the encoder\'s size is read from its SPS', async () => {
    const cap = scriptedCapture();
    const fan = new H264Fanout(() => cap);
    await fan.subscribe(() => {});
    cap.push(SPS_ONEPLUS_576x1280);
    assert.deepEqual(fan.size, { w: 576, h: 1280 });
    cap.push(nal(7, 3));                             // unreadable: the last good answer stands
    assert.deepEqual(fan.size, { w: 576, h: 1280 });
  });

  test('a viewer who joins a running capture is given a keyframe; requests are limited', async () => {
    const ctl = fakeControl();
    const cap = scriptedCapture(ctl);
    const fan = new H264Fanout(() => cap);
    await fan.subscribe(() => {});
    assert.deepEqual(ctl.calls, [], 'the first viewer starts the encoder, which begins on a keyframe anyway');
    await fan.subscribe(() => {});
    assert.deepEqual(ctl.calls, [['reset']], 'a late viewer waits for a keyframe that a still screen never sends');
    assert.equal(fan.requestKeyframe(), false, 'a second restart straight after the first');
    assert.deepEqual(fan.keyframes, { asked: 1, limited: 1 });
  });

  test('without a control socket there is nothing to ask, and nothing breaks', async () => {
    const fan = new H264Fanout(() => scriptedCapture());
    await fan.subscribe(() => {});
    assert.equal(fan.requestKeyframe(), false);
    assert.equal(fan.control, undefined);
  });
});

/**
 * THE REAL STACK, BOTH ENDS. A werift peer does exactly what `live.js` does in the browser, and the
 * agent's peer is the production class over a scripted capture.
 */
describe('a viewer negotiates, receives the screen and sends a touch', () => {
  test('offer, answer, a keyframe on the wire, and a tap back', { timeout: 30_000 }, async (t) => {
    /** Bound UDP sockets in this process — the ICE transports. */
    // A socket mid-close throws from `address()`; that one is going, so it does not count.
    const bound = (h: any) => { try { return Boolean(typeof h.address === 'function' && h.address()?.port); } catch { return false; } };
    const udp = () => (process as any)._getActiveHandles().filter(bound).length;
    const before = udp();
    const ctl = fakeControl();
    const cap = scriptedCapture(ctl);
    const taps: number[][] = [];
    const input = {
      tap: async (x: number, y: number) => { taps.push([x, y]); },
      swipe: async () => {}, key: async () => {}, text: async () => {},
    };
    const toBrowser: Array<Record<string, unknown>> = [];
    let closedWith: string | undefined;
    // Wired exactly as `PhysicalMedia` wires it: the fanout is the mapper's live input.
    const fanout = new H264Fanout(() => cap);
    const peer = new PhoneVideoPeer({
      signal: { onPayload: (p) => toBrowser.push(p as Record<string, unknown>), onClose: (r) => { closedWith = r; } },
      fanout,
      input: new InputMapper(input, { width: 1080, height: 2400 }, { w: 576, h: 1280 }, fanout),
      label: 'phone-test', video: { w: 576, h: 1280 },
    });

    const browser = new RTCPeerConnection({
      codecs: { audio: [], video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000,
        parameters: 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1' })] },
    });
    // Torn down even when an assertion fails: left open, both peers' sockets keep the process alive
    // and the run hangs with the failure unreported.
    let drain: ReturnType<typeof setInterval> | undefined;
    t.after(() => { clearInterval(drain); peer.close(); void browser.close(); });
    const inputChannel = browser.createDataChannel('input-channel');
    const received: number[] = [];
    const packets: Array<{ type: number; ts: number; marker: boolean }> = [];
    let streamId = '';
    let ssrc = 0;
    browser.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        ssrc = rtp.header.ssrc;
        const t = rtp.payload[0] & 0x1f;
        received.push(t === 28 ? rtp.payload[1] & 0x1f : t);
        packets.push({ type: t === 28 ? rtp.payload[1] & 0x1f : t, ts: rtp.header.timestamp, marker: rtp.header.marker });
      });
    });
    browser.ontrack = (ev) => { streamId = ev.streams?.[0]?.id ?? streamId; };
    browser.onicecandidate = (ev) => {
      if (ev.candidate) peer.send({ type: 'ice-candidate', candidate: ev.candidate.toJSON() });
    };

    peer.send({ type: 'request-offer', ice_servers: [] });
    const waitFor = async (ok: () => boolean, what: string, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!ok()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); }
    };
    await waitFor(() => toBrowser.some((p) => p.type === 'offer'), 'the offer');
    const offer = toBrowser.find((p) => p.type === 'offer')!;
    // A browser applies payloads in the order they arrive, and cannot add a candidate before it has
    // the offer it belongs to — the second refusal Chrome gave the first live negotiation.
    const firstCandidate = toBrowser.findIndex((p) => p.type === 'ice-candidate');
    assert.ok(firstCandidate === -1 || toBrowser.indexOf(offer) < firstCandidate,
      `a candidate went before the offer: ${toBrowser.map((p) => p.type).join(', ')}`);
    assert.match(String(offer.sdp), /H264/);
    assert.match(String(offer.sdp), /m=application/, 'no data section in the offer, so the input channel can never open');
    assert.match(String(offer.sdp), /a=msid:display_phone-test/, 'the console renders only a display_ stream');
    await browser.setRemoteDescription({ type: 'offer', sdp: String(offer.sdp) });
    const answer = await browser.createAnswer();
    await browser.setLocalDescription(answer);
    peer.send({ type: 'answer', sdp: browser.localDescription!.sdp });
    let sent = 0;
    // Read exactly as live.js reads a device's candidate — the SDP's field names, not RTCIceCandidate's.
    drain = setInterval(() => {
      for (const p of toBrowser.slice(sent)) {
        if (p.type === 'ice-candidate') {
          void browser.addIceCandidate({ sdpMid: p.mid, sdpMLineIndex: p.mLineIndex, candidate: p.candidate } as never);
        }
      }
      sent = toBrowser.length;
    }, 20);

    await waitFor(() => browser.connectionState === 'connected', 'the connection');
    // What a BROWSER requires and werift does not: Chrome throws on a candidate naming no section, and
    // live.js builds it from `mid` / `mLineIndex` / `candidate` — the device's shape, as Cuttlefish sends.
    const cands = toBrowser.filter((p) => p.type === 'ice-candidate');
    assert.ok(cands.length > 0);
    for (const c of cands) {
      assert.equal(typeof c.candidate, 'string', `not the device's shape: ${JSON.stringify(c)}`);
      assert.ok(c.mid != null || c.mLineIndex != null, `a candidate Chrome would refuse: ${JSON.stringify(c)}`);
    }
    await waitFor(() => cap.starts() === 1, 'the capture to start');
    // A P-frame before any keyframe must not be sent; the keyframe must arrive with its parameter sets.
    cap.push(nal(1, 400));
    cap.push(SPS_ONEPLUS_576x1280); cap.push(nal(8, 6)); cap.push(nal(5, 3000));
    await waitFor(() => received.includes(5), 'a keyframe on the wire');
    assert.deepEqual(received.slice(0, 3), [7, 8, 5], 'the viewer started on the keyframe, parameter sets first');

    /**
     * A FRAME IN TWO SLICES, the way scrcpy marks them: one RTP timestamp for both — the encoder's,
     * 33 ms on — and the marker only on the last packet. Sent the old way, each slice was a frame of
     * its own with a marker, which a browser decodes as two broken pictures.
     */
    const from = packets.length;
    cap.push(nal(1, 400), { last: false, ptsUs: 1_000_000 });
    cap.push(nal(1, 400), { last: true, ptsUs: 1_000_000 });
    cap.push(nal(1, 300), { last: true, ptsUs: 1_033_333 });
    await waitFor(() => packets.length >= from + 3, 'the sliced frame and the next');
    const [a, b, c] = packets.slice(from, from + 3);
    assert.equal(a.ts, b.ts, 'two slices of one frame went out under different timestamps');
    assert.deepEqual([a.marker, b.marker], [false, true], 'the marker must end the frame, not each slice');
    assert.equal(((c.ts - b.ts) >>> 0), 3000, 'the encoder\'s 33.3 ms is 3000 ticks of the 90 kHz clock');

    /**
     * THE VIEWER ASKS FOR A KEYFRAME, AND GETS ONE. A PLI from the browser restarts the encoder; the
     * restarted encoder's clock may begin again, and the keyframe it sends must still go out AFTER the
     * last frame — a receiver drops a frame whose timestamp went backwards as a stale copy.
     */
    await browser.getReceivers()[0].sendRtcpPLI(ssrc);
    await waitFor(() => ctl.calls.some((x) => x[0] === 'reset'), 'the PLI to restart the encoder');
    const afterReset = packets.length;
    cap.push(nal(7, 20)); cap.push(nal(8, 6));
    cap.push(nal(5, 600), { last: true, ptsUs: 40_000 });   // the encoder's clock, started again
    await waitFor(() => packets.slice(afterReset).some((p) => p.type === 5), 'the keyframe after the restart');
    const idr = packets.slice(afterReset).find((p) => p.type === 5)!;
    assert.equal(((idr.ts - c.ts) >>> 0), 1500, 'a clock that stepped back must carry on one frame later, not go back');

    /**
     * AND NOT FOR CHROME'S PROBE OF A STILL SCREEN (D68). Chrome sends a PLI when no frame has come for
     * 3 s; answering it made frames, which made Chrome ask again 3 s later — an encoder restarted every
     * ~4 s for as long as anyone watched a still phone. werift never sends that probe, so this sends it.
     */
    const resets = ctl.calls.filter((x) => x[0] === 'reset').length;
    await new Promise((r) => setTimeout(r, 2200));
    await browser.getReceivers()[0].sendRtcpPLI(ssrc);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(ctl.calls.filter((x) => x[0] === 'reset').length, resets,
      'a still screen restarted the encoder for a viewer that already had its picture');

    await waitFor(() => inputChannel.readyState === 'open', 'the input channel');
    inputChannel.send(JSON.stringify({ type: 'multi-touch', id: [1], x: [288], y: [640], down: 1 }));
    inputChannel.send(JSON.stringify({ type: 'multi-touch', id: [1], x: [288], y: [640], down: 0 }));
    // Live: straight to the control socket, in the video's pixels, at the size the phone's SPS declared.
    await waitFor(() => ctl.calls.filter((x) => x[0] === 'touch').length === 2, 'the touch');
    assert.deepEqual(ctl.calls.filter((x) => x[0] === 'touch'), [['touch', 'down', 1, 288, 640, 576, 1280], ['touch', 'up', 1, 288, 640, 576, 1280]]);
    // And over adb when the socket has gone.
    ctl.alive = false;
    inputChannel.send(JSON.stringify({ type: 'multi-touch', id: [1], x: [288], y: [640], down: 1 }));
    inputChannel.send(JSON.stringify({ type: 'multi-touch', id: [1], x: [288], y: [640], down: 0 }));
    await waitFor(() => taps.length === 1, 'the tap');
    assert.deepEqual(taps[0], [540, 1200]);

    clearInterval(drain);
    peer.close();
    await browser.close();
    assert.equal(closedWith, undefined, `the channel closed itself: ${closedWith}`);
    await waitFor(() => cap.stops() === 1, 'the capture to stop with the last viewer');
    /**
     * EVERY SOCKET GOES WITH THE VIEWER. Under werift's default bundle policy the offer's second
     * section got a transport of its own that was dropped on bundling and never closed — three UDP
     * sockets left bound per viewer, which a long-running agent would have kept for good.
     */
    await waitFor(() => udp() <= before, `the ICE sockets to close (still ${udp()} bound, ${before} before)`, 5_000);
  });
});

/**
 * A relay that is down, on loopback: UDP that takes everything and answers nothing, and TCP on the
 * same port that accepts and then says nothing. Both halves matter — werift falls back from UDP to
 * TCP, and a refused TCP port fails fast where the farm's filtered one hung.
 */
async function silentRelay() {
  const sock = createSocket('udp4');
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  const port = (sock.address() as AddressInfo).port;
  const held: import('node:net').Socket[] = [];
  const tcp = createServer((c) => { held.push(c); c.on('error', () => {}); });
  await new Promise<void>((r, f) => { tcp.once('error', f); tcp.listen(port, '127.0.0.1', () => r()); });
  return {
    port,
    close: () => { sock.close(); for (const c of held) c.destroy(); tcp.close(); },
  };
}

describe('a relay that does not answer does not hold the offer', () => {
  test('the URLs the console sends, taken apart', () => {
    assert.deepEqual(parseIceUrl('turn:turn.example.test:3478'), { scheme: 'turn', host: 'turn.example.test', port: 3478, transport: 'udp' });
    assert.deepEqual(parseIceUrl('turn:turn.example.test:3478?transport=tcp')?.transport, 'tcp');
    assert.deepEqual(parseIceUrl('turns:turn.example.test'), { scheme: 'turns', host: 'turn.example.test', port: 5349, transport: 'tcp' });
    assert.deepEqual(parseIceUrl('stun:[2001:db8::1]:19302')?.host, '2001:db8::1');
    assert.equal(parseIceUrl('https://not.ice'), undefined);
  });

  test('a STUN answer counts; silence does not, and is given up on in time', async () => {
    const server = createSocket('udp4');
    server.on('message', (m, from) => {
      const reply = Buffer.from(m);
      reply.writeUInt16BE(0x0101, 0);               // Binding success, same transaction
      server.send(reply, from.port, from.address);
    });
    await new Promise<void>((r) => server.bind(0, '127.0.0.1', () => r()));
    const silent = await silentRelay();
    try {
      assert.equal(await answersOverUdp('127.0.0.1', (server.address() as AddressInfo).port, 1000), true);
      const t = Date.now();
      assert.equal(await answersOverUdp('127.0.0.1', silent.port, 300), false);
      assert.ok(Date.now() - t < 1000, 'the probe outlived its limit');
    } finally {
      server.close(); silent.close();
    }
  });

  test('over TCP, an answer counts and an accepted-but-silent connection does not', async () => {
    const srv = createServer((c) => c.once('data', (m: Buffer) => {
      const reply = Buffer.from(m.subarray(0, 20));
      reply.writeUInt16BE(0x0101, 0);
      c.end(reply);
    }));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    const silent = await silentRelay();
    try {
      assert.equal(await answersOverTcp('127.0.0.1', port, 1000), true);
      assert.equal(await answersOverTcp('127.0.0.1', silent.port, 300), false, 'accepted is not answered');
    } finally {
      silent.close();
      await new Promise((r) => srv.close(r));
    }
    assert.equal(await answersOverTcp('127.0.0.1', port, 1000), false, 'nothing listening is not an answer');
  });

  test('the dead relay is left out, STUN kept, and a public-address server added when none is named', async () => {
    const dropped: string[] = [];
    const probe = { udp: async (host: string) => host !== 'dead.example.test', tcp: async () => false };
    const out = await reachableIceServers([
      { urls: ['turn:dead.example.test:3478', 'turn:dead.example.test:3478?transport=tcp'], username: 'u', credential: 'c' },
      { urls: 'turn:alive.example.test:3478', username: 'u', credential: 'c' },
    ], probe, (u) => dropped.push(u));
    assert.deepEqual(out.map((s) => s.urls), [['turn:alive.example.test:3478'], 'stun:stun.l.google.com:19302']);
    assert.deepEqual(dropped, ['turn:dead.example.test:3478', 'turn:dead.example.test:3478 (tcp)']);
    assert.equal(out[0].credential, 'c', 'the credentials stay with the relay they belong to');

    const named = await reachableIceServers([{ urls: 'stun:stun.example.test:3478' }], probe);
    assert.deepEqual(named.map((s) => s.urls), [['stun:stun.example.test:3478']], 'a named STUN server is not doubled');
  });

  /**
   * What the farm did: the console sent the minted relay, the relay host was down, and werift — which
   * will not offer until every candidate is in — never offered. The page said "negotiating" for good.
   */
  test('the offer goes out promptly while the relay the console named is silent', { timeout: 30_000 }, async () => {
    const silent = await silentRelay();
    const toBrowser: Array<Record<string, unknown>> = [];
    const peer = new PhoneVideoPeer({
      signal: { onPayload: (p) => toBrowser.push(p as Record<string, unknown>), onClose: () => {} },
      fanout: new H264Fanout(() => scriptedCapture()),
      input: new InputMapper({ tap: async () => {}, swipe: async () => {}, key: async () => {}, text: async () => {} },
        { width: 1080, height: 2400 }, { w: 576, h: 1280 }),
      label: 'phone-relay', video: { w: 576, h: 1280 },
    });
    const t = Date.now();
    try {
      peer.send({ type: 'request-offer', ice_servers: [{ urls: [`turn:127.0.0.1:${silent.port}`], username: 'u', credential: 'c' }] });
      while (!toBrowser.some((p) => p.type === 'offer') && Date.now() - t < 10_000) await new Promise((r) => setTimeout(r, 50));
      const took = Date.now() - t;
      assert.ok(toBrowser.some((p) => p.type === 'offer'), `no offer in ${took}ms — the silent relay held it`);
      assert.ok(took < 8_000, `the offer took ${took}ms`);
    } finally {
      peer.close();
      silent.close();
    }
  });
});
