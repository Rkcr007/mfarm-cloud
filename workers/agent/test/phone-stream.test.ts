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
import { RTCPeerConnection, RTCRtpCodecParameters, consentResponseTimeoutMs, RtcpRrPacket, RtcpReceiverInfo } from 'werift';
import type { RTCRtpSender } from 'werift';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  packetizeNal, videoSizeFor, charFor, InputMapper, H264Fanout, PhoneVideoPeer, nalType,
  parseIceUrl, agentIceServers, relayOverTcp, spsSize, BitrateGovernor, ntpNow, fixSenderClock,
  SenderReportLog, stretchConsentWait, frameRateFor, BITRATE_TIERS,
} from '../src/devices/phone-stream.ts';
import type { CaptureRate, LinkReport } from '../src/devices/phone-stream.ts';
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

describe('the agent offers without a relay of its own', () => {
  test('the URLs the console sends, taken apart', () => {
    assert.deepEqual(parseIceUrl('turn:turn.example.test:3478'), { scheme: 'turn', host: 'turn.example.test', port: 3478, transport: 'udp' });
    assert.deepEqual(parseIceUrl('turn:turn.example.test:3478?transport=tcp')?.transport, 'tcp');
    assert.deepEqual(parseIceUrl('turns:turn.example.test'), { scheme: 'turns', host: 'turn.example.test', port: 5349, transport: 'tcp' });
    assert.deepEqual(parseIceUrl('stun:[2001:db8::1]:19302')?.host, '2001:db8::1');
    assert.equal(parseIceUrl('https://not.ice'), undefined);
  });

  /**
   * D70: the agent's werift is never given a relay. With one, werift sent down its own first-nominated
   * pair — a relay pair — while Chrome listened on another, and the picture froze on both the direct
   * and the relayed path. The browser has the relay; the agent keeps only STUN, for its public address.
   */
  /**
   * The priorities are the ones Chrome sent from the console on 2026-10-04: two relay candidates
   * reached over TCP (16785407, top byte 1) and one over UDP (50340095, top byte 3). The TCP ones
   * arrived first, werift nominated one, and a 4 Mbit/s stream queued down TURN-over-TCP to a 6.2 s
   * round trip with the UDP relay sitting unused.
   */
  const chromeRelay = (priority: number, port: number) =>
    `candidate:3829451234 1 udp ${priority} 34.100.138.213 ${port} typ relay raddr 0.0.0.0 rport 0 generation 0 ufrag Ab1c network-cost 999`;

  test('a relay reached over TCP is told from one reached over UDP, by its priority', () => {
    assert.equal(relayOverTcp(chromeRelay(16785407, 59233)), true, 'Chrome, TURN over TCP');
    assert.equal(relayOverTcp(chromeRelay(50340095, 65162)), false, 'Chrome, TURN over UDP');
    assert.equal(relayOverTcp({ candidate: chromeRelay(16785407, 61502), sdpMid: '0' }), true, 'as RTCIceCandidate JSON');
    assert.equal(relayOverTcp(chromeRelay(255, 1)), true, 'TURN over TLS ranks lowest of all');
    assert.equal(relayOverTcp(chromeRelay((5 << 24) + 255, 1)), false, 'Firefox ranks UDP relay 5');
    assert.equal(relayOverTcp('candidate:1 1 udp 2122260223 192.168.0.11 50000 typ host'), false, 'a host candidate');
    assert.equal(relayOverTcp('not a candidate'), false);
    assert.equal(relayOverTcp(undefined), false);
  });

  test('the browser\'s relay over TCP is held back, so its relay over UDP can be nominated first', async () => {
    const peer = new PhoneVideoPeer({
      signal: { onPayload: () => {}, onClose: () => {} },
      fanout: new H264Fanout(() => scriptedCapture()),
      input: undefined as never, label: 'phone-hold', video: { w: 576, h: 1280 },
    });
    const added: string[] = [];
    (peer as any).pc = { addIceCandidate: async (c: { candidate: string }) => { added.push(c.candidate.split(' ')[5]); }, close: async () => {} };
    try {
      peer.send({ type: 'ice-candidate', candidate: { candidate: chromeRelay(16785407, 59233), sdpMid: '0' } });
      peer.send({ type: 'ice-candidate', candidate: { candidate: chromeRelay(50340095, 65162), sdpMid: '0' } });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(added, ['65162'], 'the UDP relay must go in first, and the TCP one must not');
      await new Promise((r) => setTimeout(r, 1_700));
      assert.deepEqual(added, ['65162', '59233'], 'held, not dropped: on a UDP-blocking network it is the only way in');
    } finally { peer.close(); }
  });

  test('the agent keeps STUN and drops every relay, adding a public-address server when none is named', () => {
    const out = agentIceServers([
      { urls: ['turn:turn.example.test:3478', 'turn:turn.example.test:3478?transport=tcp'], username: 'u', credential: 'c' },
      { urls: ['stun:stun.example.test:3478', 'turns:turn.example.test:5349'], username: 'u', credential: 'c' },
    ]);
    assert.deepEqual(out, [{ urls: ['stun:stun.example.test:3478'] }], 'a relay, or a relay credential, reached werift');
    assert.deepEqual(agentIceServers([{ urls: 'turn:turn.example.test:3478', username: 'u', credential: 'c' }]),
      [{ urls: 'stun:stun.l.google.com:19302' }]);
    assert.deepEqual(agentIceServers([]), [{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  /**
   * What the farm did (D67): the console sent the minted relay, the relay host was down, and werift —
   * which will not offer until every candidate is in — never offered. The page said "negotiating" for
   * good. Since D70 werift is never handed the relay at all, so a silent one cannot hold the offer, and
   * the offer carries no relay candidate of the agent's own. Hand it the relay and this hangs.
   */
  test('the offer goes out promptly, with no relay candidate, whatever relay the console names', { timeout: 30_000 }, async () => {
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
      assert.ok(took < 3_000, `the offer took ${took}ms`);
      const sdp = String(toBrowser.find((p) => p.type === 'offer')!.sdp);
      assert.doesNotMatch(sdp, / typ relay/, 'the agent offered a relay candidate of its own');
    } finally {
      peer.close();
      silent.close();
    }
  });
});

/**
 * BANDWIDTH ADAPTATION. The governor is driven with a clock of its own: what it is asked is "at this
 * moment, with these reports, should the rate change" — and the reports are shaped like the ones the
 * OnePlus's relayed view produced on a 3 Mbit/s downlink: a 90 ms floor, then a queue of 1.7 s.
 */
describe('the stream\'s rate follows the viewer\'s link', () => {
  const T = 1_000_000;
  /** Report `rtt` (and loss) once a second for `secs` seconds from `from`, ticking after each. */
  const run = (g: BitrateGovernor, from: number, secs: number, rttMs: number, fractionLost = 0, viewer = 'v1', sending = Infinity) => {
    const out: Array<number | undefined> = [];
    for (let i = 0; i < secs; i++) {
      const now = from + i * 1000;
      g.report(viewer, { rttMs, fractionLost, at: now });
      out.push(g.tick(now, sending));
    }
    return out.filter((x) => x !== undefined);
  };

  test('a clear link keeps the rate it has', () => {
    const g = new BitrateGovernor(4_000_000);
    assert.deepEqual(run(g, T, 60, 95), []);
    assert.equal(g.bitRate, 4_000_000);
  });

  test('a queue that builds steps down at once, two tiers, and again if it does not clear', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 90);                                  // the floor
    const first = run(g, T + 3_000, 2, 1_700);         // the second congested report decides
    assert.deepEqual(first, [1_500_000], 'a 1.7 s queue must not wait for more than two reports');
    assert.match(g.reason, /4\.0 Mbit\/s → 1\.5 Mbit\/s: round trip 1700 ms against 90 ms at best/);
    assert.deepEqual(run(g, T + 5_000, 2, 1_700), [], 'a second step inside four seconds is too soon to judge');
    assert.deepEqual(run(g, T + 7_000, 3, 1_700), [400_000]);
  });

  test('one bad report is not congestion', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 90);
    assert.deepEqual([...run(g, T + 3_000, 1, 2_000), ...run(g, T + 4_000, 10, 95)], []);
  });

  test('loss alone steps it down', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 90);
    assert.deepEqual(run(g, T + 3_000, 2, 95, 0.12), [1_500_000]);
  });

  test('a link that stays clear is tried one tier higher, after a while', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 90);
    run(g, T + 3_000, 2, 1_700);                       // down to 1.5
    const up = run(g, T + 5_000, 30, 95);
    assert.deepEqual(up, [2_500_000], 'one tier at a time, once in 30 clear seconds');
    assert.match(g.reason, /1\.5 Mbit\/s → 2\.5 Mbit\/s: 15 s without congestion/);
  });

  test('a step up that does not hold makes the next one wait twice as long', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 90);
    run(g, T + 3_000, 2, 1_700);                       // 1.5
    let t = T + 5_000;
    const up: number[] = [];
    for (; up.length === 0; t += 1000) { const r = run(g, t, 1, 95); up.push(...r as number[]); }
    assert.equal(g.bitRate, 2_500_000);
    // Back to the tier it came from, not by the queue's depth to 0.8 (the OnePlus, 2026-10-09).
    assert.deepEqual(run(g, t, 2, 900), [1_500_000], 'the step up did not hold');
    t += 2_000;
    // The hold is 30 s now: nothing at 20 s of clear link, one step by 35 s.
    assert.deepEqual(run(g, t, 20, 95), []);
    assert.deepEqual(run(g, t + 20_000, 15, 95), [2_500_000]);
  });

  /** Report a round trip per second from `from`, ticking after each; the decisions, with when. */
  const walk = (g: BitrateGovernor, from: number, rtts: number[]) => {
    const out: Array<[number, number]> = [];
    rtts.forEach((rttMs, i) => {
      const now = from + i * 1000;
      g.report('v1', { rttMs, fractionLost: 0, at: now });
      const d = g.tick(now);
      if (d !== undefined) out.push([now - from, d]);
    });
    return out;
  };

  test('a queue that is draining is waited out, not answered again', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 60);
    assert.deepEqual(run(g, T + 3_000, 2, 1_567), [1_500_000]);   // the step, at T + 4000
    // The OnePlus's numbers: the queue the step left behind, draining. It used to take a second step
    // here, four seconds on at 859 ms, to 0.4 Mbit/s and 15 fps.
    const after = walk(g, T + 5_000, [1_400, 1_250, 1_050, 859, 700, 500, 300, 150, 70, 65, 65, 65]);
    assert.deepEqual(after, [], 'a step that was working was answered again');
    assert.equal(g.bitRate, 1_500_000);
  });

  test('a queue that stops draining is answered after all — later, not never', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 60);
    run(g, T + 3_000, 2, 1_567);                                   // 1.5, at T + 4000
    // It fell below four fifths and stopped there: still a queue, so it is answered at eight seconds.
    const stalled = walk(g, T + 5_000, Array(12).fill(1_000));
    assert.deepEqual(stalled, [[7_000, 400_000]]);                 // T + 12000: eight seconds on
    // One that never fell is answered at the usual four.
    const h = new BitrateGovernor(4_000_000);
    run(h, T, 3, 60);
    run(h, T + 3_000, 2, 1_567);
    assert.deepEqual(walk(h, T + 5_000, Array(6).fill(1_500)), [[3_000, 400_000]]);
  });

  test('a step up that holds brings the wait back to where it started', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 90);
    run(g, T + 3_000, 2, 1_700);                                   // 1.5
    let t = T + 5_000;
    const clear = (n: number) => { const d = walk(g, t, Array(n).fill(95)); t += n * 1000; return d; };
    assert.deepEqual(clear(16).map(([, r]) => r), [2_500_000]);    // a probe, after 15 s
    assert.deepEqual(walk(g, t, [900, 900]).map(([, r]) => r), [1_500_000]);  // it fails: the wait is 30 s
    t += 2_000;
    const probeAt = t;
    const up = clear(31);
    assert.deepEqual(up.map(([, r]) => r), [2_500_000]);           // probed again at 30 s, and it holds
    const upAt = probeAt + up[0][0];
    // Held 20 s, so the wait is 15 s again: 4.0 comes 20 s after, where a wait left doubled makes it 30.
    const nextFrom = t;
    const next = clear(25);
    assert.deepEqual(next.map(([, r]) => r), [4_000_000], 'the wait stayed doubled after a step up held');
    assert.ok(nextFrom + next[0][0] - upAt <= 21_000, `took ${nextFrom + next[0][0] - upAt} ms`);
  });

  test('the slowest viewer sets the rate, and leaving takes its vote with it', () => {
    const g = new BitrateGovernor(4_000_000);
    for (let i = 0; i < 3; i++) { g.report('fast', { rttMs: 10, at: T + i * 1000 }); g.report('slow', { rttMs: 90, at: T + i * 1000 }); g.tick(T + i * 1000); }
    const decided: Array<number | undefined> = [];
    for (let i = 3; i < 5; i++) {
      g.report('fast', { rttMs: 11, at: T + i * 1000 });
      g.report('slow', { rttMs: 1_500, at: T + i * 1000 });
      decided.push(g.tick(T + i * 1000));
    }
    assert.deepEqual(decided.filter(Boolean), [1_500_000], 'one encoder serves both, so the slow link decides');
    g.forget('slow');
    assert.deepEqual(run(g, T + 5_000, 20, 11, 0, 'fast'), [2_500_000]);
  });

  /**
   * Found live, at 4 a.m. on a home link: the screen was still, the round trip drifted from 115 to
   * 300 ms on its own, and the stream was stepped down twice — for a queue it was not filling.
   */
  test('a queue the stream is not filling is not the stream\'s to answer', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 111, 0, 'v1', 50_000);
    assert.deepEqual(run(g, T + 3_000, 10, 300, 0, 'v1', 50_000), [], 'a still screen sends 50 kbit/s');
    assert.equal(g.bitRate, 4_000_000);
    // The same queue while the stream IS sending its rate is the stream's.
    assert.deepEqual(run(g, T + 13_000, 2, 300, 0, 'v1', 3_500_000), [2_500_000]);
  });

  test('nothing fresh to go on, nothing decided', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 90);
    g.report('v1', { rttMs: 3_000, at: T + 3_000 });
    assert.equal(g.tick(T + 30_000), undefined, 'a report from a link half a minute ago is not this link');
  });

  test('never below the bottom tier, never above the start', () => {
    const g = new BitrateGovernor(4_000_000);
    run(g, T, 3, 90);
    for (let i = 0; i < 10; i++) run(g, T + 3_000 + i * 5_000, 5, 5_000);
    assert.equal(g.bitRate, 400_000);
    const h = new BitrateGovernor(4_000_000);
    assert.deepEqual(run(h, T, 120, 20), []);
    assert.equal(h.bitRate, 4_000_000);
  });

  // The start is a ceiling an operator chose (`PHYSICAL_VIDEO_BIT_RATE`), not only where the top tier
  // happens to be: a stream capped at 2.5 Mbit/s for a metered uplink must not climb to 4 on a clear
  // link, and a start between two tiers is itself the top rate rather than being rounded away.
  test('a start below the top tier is the ceiling, and a start between tiers is kept', () => {
    const capped = new BitrateGovernor(2_500_000);
    assert.equal(capped.bitRate, 2_500_000);
    assert.deepEqual(run(capped, T, 600, 20), []);
    assert.equal(capped.bitRate, 2_500_000);

    const between = new BitrateGovernor(3_000_000);
    assert.equal(between.bitRate, 3_000_000);
    run(between, T, 3, 90);
    assert.deepEqual(run(between, T + 3_000, 2, 1_700), [1_500_000]);
    run(between, T + 5_000, 600, 90);
    assert.equal(between.bitRate, 3_000_000);
  });
});

describe('a new rate is a new encoder, and the viewers stay', () => {
  test('the capture restarts at the rate, the stream and the control socket carry on', async () => {
    const caps: Array<ReturnType<typeof scriptedCapture> & { bitRate?: number }> = [];
    const fan = new H264Fanout(({ bitRate }) => {
      const c = Object.assign(scriptedCapture(fakeControl()), { bitRate });
      caps.push(c);
      return c;
    }, { bitRate: 4_000_000, adapt: true });
    const got: number[] = [];
    const off = await fan.subscribe((n) => got.push(nalType(n)));
    try {
      assert.equal(caps[0].bitRate, 4_000_000);
      caps[0].push(nal(5, 10));
      await fan.setBitRate(1_500_000, 'test');
      assert.equal(caps.length, 2);
      assert.equal(caps[0].stops(), 1, 'two encoders on one phone fight over one forwarded port');
      assert.equal(caps[1].bitRate, 1_500_000);
      assert.equal(fan.currentBitRate, 1_500_000);
      caps[1].push(SPS_ONEPLUS_576x1280); caps[1].push(nal(8, 6)); caps[1].push(nal(5, 20));
      assert.deepEqual(got, [5, 7, 8, 5], 'the viewer was dropped across the restart');
      assert.equal(fan.control, caps[1].control, 'live input must follow the new server');
      assert.deepEqual(fan.changes.map((c) => c.bitRate), [1_500_000]);
    } finally { off(); }
  });

  test('the viewers\' reports move it on their own', { timeout: 15_000 }, async () => {
    const caps: Array<ReturnType<typeof scriptedCapture> & { bitRate?: number }> = [];
    const fan = new H264Fanout(({ bitRate }) => {
      const c = Object.assign(scriptedCapture(), { bitRate });
      caps.push(c);
      return c;
    }, { bitRate: 4_000_000, adapt: true });
    const off = await fan.subscribe(() => {});
    try {
      fan.report('v', { rttMs: 90, at: Date.now() });
      const end = Date.now() + 8_000;
      while (caps.length < 2 && Date.now() < end) {
        // The stream is busy — 60 KB every 250 ms is ~1.9 Mbit/s — so the queue is the stream's.
        caps[0].push(nal(1, 60_000));
        fan.report('v', { rttMs: 1_700, at: Date.now() });
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(caps.length, 2, 'a 1.7 s queue went unanswered');
      assert.equal(caps[1].bitRate, 1_500_000);
    } finally { off(); }
  });

  test('a still screen under the same queue is left alone', { timeout: 15_000 }, async () => {
    const caps: Array<ReturnType<typeof scriptedCapture> & { bitRate?: number }> = [];
    const fan = new H264Fanout(({ bitRate }) => {
      const c = Object.assign(scriptedCapture(), { bitRate });
      caps.push(c);
      return c;
    }, { bitRate: 4_000_000, adapt: true });
    const off = await fan.subscribe(() => {});
    try {
      fan.report('v', { rttMs: 90, at: Date.now() });
      for (let i = 0; i < 16; i++) {
        caps[0].push(nal(1, 200));                    // a status-bar tick, not a stream
        fan.report('v', { rttMs: 1_700, at: Date.now() });
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(caps.length, 1, 'a queue the stream was not filling restarted the encoder');
    } finally { off(); }
  });

  test('without adaptation, the rate never moves', async () => {
    const fan = new H264Fanout(() => scriptedCapture(), { bitRate: 4_000_000 });
    assert.equal(fan.governor, undefined);
    fan.report('v', { rttMs: 5_000, at: Date.now() });
    assert.equal(fan.currentBitRate, 4_000_000);
  });
});

describe('a sender clock the receiver reports can be matched against', () => {
  test('NTP time is seconds since 1900 and a binary fraction, not decimal digits', () => {
    const at = Date.UTC(2026, 9, 4, 3, 30, 0, 567);
    const ntp = ntpNow(at);
    const sec = Number(ntp >> 32n);
    const frac = Number(ntp & 0xffffffffn);
    assert.equal(sec, Math.floor((at + 2_208_988_800_000) / 1000));
    assert.ok(Math.abs(frac / 2 ** 32 - 0.567) < 1e-6, `fraction ${frac} is not 0.567 of a second`);
    // werift's own wrote 567 here: these two moments 1 ms apart must not share a compact value.
    const compact = (x: bigint) => Number((x >> 16n) & 0xffffffffn);
    assert.notEqual(compact(ntpNow(at)), compact(ntpNow(at + 1)));
  });

  test('a sender reads the time now; werift\'s writes after each packet are ignored', async () => {
    const sender: Record<string, unknown> = { ntpTimestamp: 0n };
    fixSenderClock(sender);
    sender.ntpTimestamp = 123n;                       // what werift does on every packet
    const a = sender.ntpTimestamp as bigint;
    assert.notEqual(a, 123n);
    assert.equal(sender.ntpTimestamp, a, 'the report and the LSR it is matched by must read the same value');
    await new Promise((r) => setTimeout(r, 20));
    const b = sender.ntpTimestamp as bigint;
    assert.ok(b > a, 'a still screen must not repeat the last packet\'s timestamp');
    const ms = Number(b >> 32n) * 1000 + (Number(b & 0xffffffffn) / 2 ** 32) * 1000 - 2_208_988_800_000;
    assert.ok(Math.abs(ms - Date.now()) < 50, `${ms} is not now`);
  });

  test('the governor does not take an impossible round trip for a fast link', () => {
    const g = new BitrateGovernor(4_000_000);
    const T = 2_000_000;
    for (let i = 0; i < 3; i++) { g.report('v', { rttMs: 90, at: T + i * 1000 }); g.tick(T + i * 1000); }
    g.report('v', { rttMs: -56, at: T + 3_000 }); g.tick(T + 3_000);
    g.report('v', { rttMs: 0, at: T + 4_000 }); g.tick(T + 4_000);
    // With a floor of -56 ms or 0 ms, an ordinary 160 ms would read as a queue.
    const out: Array<number | undefined> = [];
    for (let i = 5; i < 12; i++) { g.report('v', { rttMs: 160, at: T + i * 1000 }); out.push(g.tick(T + i * 1000)); }
    assert.deepEqual(out.filter(Boolean), []);
    assert.equal(g.bitRate, 4_000_000);
  });
});

/** The compact NTP time a receiver echoes as LSR: the middle 32 bits. */
const lsrOf = (ntp: bigint) => Number((ntp >> 16n) & 0xffff_ffffn);

describe('the round trip, from whichever sender report a receiver echoes (D78)', () => {
  test('a report echoing an OLDER sender report still gives the round trip, queue and all', () => {
    const log = new SenderReportLog();
    const t0 = 1_760_000_000_000;
    const srs = [0, 1_000, 2_000].map((dt) => { const ntp = ntpNow(t0 + dt); log.record(ntp, t0 + dt); return ntp; });
    // Behind a queue the receiver answers the FIRST report 2.7 s after it went, having held it 100 ms.
    // werift matches only its latest report (sent at t0 + 2000), so it learns nothing from this one:
    // its round trip stays wherever it last matched, which is how it read 70 ms against Chrome's 730.
    const rtt = log.rttMs(lsrOf(srs[0]), 6_554, t0 + 2_700);
    assert.ok(rtt !== undefined && Math.abs(rtt - 2_600) < 1, `round trip ${rtt}`);
    const fresh = log.rttMs(lsrOf(srs[2]), 0, t0 + 2_090);
    assert.ok(fresh !== undefined && Math.abs(fresh - 90) < 1, `round trip ${fresh}`);
  });

  test('an LSR that is not one of ours, or none at all, gives nothing rather than a guess', () => {
    const log = new SenderReportLog();
    log.record(ntpNow(1_760_000_000_000), 1_760_000_000_000);
    assert.equal(log.rttMs(0, 0), undefined);
    assert.equal(log.rttMs(12_345, 0), undefined);
  });

  test('the clock records every time it hands werift', () => {
    const sender: { ntpTimestamp?: bigint } = {};
    const log = fixSenderClock(sender);
    const ntp = sender.ntpTimestamp!;
    const at = performance.timeOrigin + performance.now();
    const rtt = log.rttMs(lsrOf(ntp), 0, at + 50);
    assert.ok(rtt !== undefined && rtt >= 49 && rtt < 60, `round trip ${rtt}`);
  });
});

describe('consent waits for the queue it is stuck in (D79)', () => {
  test('the pair is given the round trip the reports measured, and werift\'s own wait grows to fit', () => {
    const pair = { rtt: 0.07 };
    const sender = { dtlsTransport: { iceTransport: { connection: { nominated: pair } } } } as unknown as RTCRtpSender;
    // At connection the pair measured 70 ms, so werift waits 500 ms: a 0.9 s queue outlasts every wait,
    // and 30 s of that expires consent and closes the view.
    assert.equal(consentResponseTimeoutMs(pair.rtt), 500);
    stretchConsentWait(sender, 900);
    assert.equal(pair.rtt, 0.9);
    assert.equal(consentResponseTimeoutMs(pair.rtt), 2_000);
  });

  test('a sender with no connection yet is left alone', () => {
    stretchConsentWait({} as RTCRtpSender, 900);
    stretchConsentWait({ dtlsTransport: { iceTransport: { connection: {} } } } as unknown as RTCRtpSender, 900);
  });
});

describe('a rate the encoder will actually hold (D77)', () => {
  test('each tier runs at the highest frame rate the OnePlus\'s encoder holds it at', () => {
    assert.deepEqual(BITRATE_TIERS.map(frameRateFor), [60, 60, 60, 30, 15]);
    assert.equal(frameRateFor(1_000_000), 30, 'under 1.37 Mbit/s, 60 fps does not hold');
    assert.equal(frameRateFor(600_000), 20);
  });

  test('a restart passes the rate, its frame rate and a constant bitrate', async () => {
    const made: CaptureRate[] = [];
    const fan = new H264Fanout((o) => { made.push(o); return scriptedCapture(); },
      { bitRate: 4_000_000, adapt: true, cbr: true });
    const off = await fan.subscribe(() => {});
    try {
      await fan.setBitRate(800_000, 'test');
      assert.deepEqual(made, [
        { bitRate: 4_000_000, maxFps: 60, cbr: true },
        { bitRate: 800_000, maxFps: 30, cbr: true },
      ]);
      assert.equal(fan.currentFps, 30);
      assert.deepEqual(fan.changes.map((c) => [c.bitRate, c.maxFps]), [[800_000, 30]]);
    } finally { off(); }
  });

  test('an encoder that refuses a constant bitrate gets its own rate control, once and for good', async () => {
    const made: CaptureRate[] = [];
    const fan = new H264Fanout((o) => {
      made.push(o);
      const c = scriptedCapture();
      if (o.cbr) c.start = async () => { throw new Error('bitrate-mode not supported'); };
      return c;
    }, { bitRate: 4_000_000, adapt: true, cbr: true });
    const got: number[] = [];
    const off = await fan.subscribe((n) => got.push(nalType(n)));   // a viewer, not an error
    try {
      await fan.setBitRate(1_500_000, 'test');
      assert.deepEqual(made.map((m) => m.cbr), [true, false, false]);
      assert.equal(fan.viewers, 1);
    } finally { off(); }
  });
});

describe('the round trip and the consent wait, from a real receiver\'s reports', () => {
  test('a werift viewer\'s reports reach the governor as a round trip, and the pair\'s wait follows it', { timeout: 30_000 }, async (t) => {
    const cap = scriptedCapture(fakeControl());
    const fanout = new H264Fanout(() => cap, { adapt: true });
    // Each report, beside what the agent's ICE pair carried at that instant. The handler stretches the
    // consent wait BEFORE it reports, synchronously, so werift has had no chance to overwrite it.
    const reports: Array<LinkReport & { pairRtt?: number }> = [];
    const pairOf = () => (peer as unknown as { pc?: RTCPeerConnection }).pc?.getTransceivers()[0]
      ?.sender.dtlsTransport?.iceTransport?.connection?.nominated;
    const report = fanout.report.bind(fanout);
    fanout.report = (viewer, r) => { reports.push({ ...r, pairRtt: pairOf()?.rtt }); report(viewer, r); };
    const toBrowser: Array<Record<string, unknown>> = [];
    const peer = new PhoneVideoPeer({
      signal: { onPayload: (p) => toBrowser.push(p as Record<string, unknown>), onClose: () => {} },
      fanout,
      input: new InputMapper({ tap: async () => {}, swipe: async () => {}, key: async () => {}, text: async () => {} },
        { width: 1080, height: 2400 }, { w: 576, h: 1280 }, fanout),
      label: 'phone-rtt', video: { w: 576, h: 1280 },
    });
    const browser = new RTCPeerConnection({
      codecs: { audio: [], video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000,
        parameters: 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1' })] },
    });
    let drain: ReturnType<typeof setInterval> | undefined;
    let feed: ReturnType<typeof setInterval> | undefined;
    t.after(() => { clearInterval(drain); clearInterval(feed); peer.close(); void browser.close(); });
    browser.onicecandidate = (ev) => { if (ev.candidate) peer.send({ type: 'ice-candidate', candidate: ev.candidate.toJSON() }); };
    const waitFor = async (ok: () => boolean, what: string, ms = 20_000) => {
      const end = Date.now() + ms;
      while (!ok()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); }
    };
    peer.send({ type: 'request-offer', ice_servers: [] });
    await waitFor(() => toBrowser.some((p) => p.type === 'offer'), 'the offer');
    await browser.setRemoteDescription({ type: 'offer', sdp: String(toBrowser.find((p) => p.type === 'offer')!.sdp) });
    await browser.setLocalDescription(await browser.createAnswer());
    peer.send({ type: 'answer', sdp: browser.localDescription!.sdp });
    let sent = 0;
    drain = setInterval(() => {
      for (const p of toBrowser.slice(sent)) {
        if (p.type === 'ice-candidate') void browser.addIceCandidate({ sdpMid: p.mid, sdpMLineIndex: p.mLineIndex, candidate: p.candidate } as never);
      }
      sent = toBrowser.length;
    }, 20);
    await waitFor(() => browser.connectionState === 'connected', 'the connection');
    await waitFor(() => cap.starts() === 1, 'the capture to start');
    cap.push(SPS_ONEPLUS_576x1280); cap.push(nal(8, 6)); cap.push(nal(5, 3000));
    // Frames keep the sender reporting, and the receiver answering.
    feed = setInterval(() => cap.push(nal(1, 300)), 33);
    await waitFor(() => reports.some((r) => r.rttMs !== undefined), 'a round trip from a receiver report');
    const r = reports.findLast((x) => x.rttMs !== undefined)!;
    assert.ok(r.rttMs! > 0 && r.rttMs! < 200, `a loopback round trip of ${r.rttMs} ms`);
    assert.ok(pairOf(), 'no nominated pair on a connected peer: the path stretchConsentWait walks has moved');
    // werift's consent wait is computed from this field; it must be the round trip the report gave.
    assert.equal(r.pairRtt, r.rttMs! / 1_000, 'the consent wait does not follow the reports');

    /**
     * BEHIND A QUEUE: A REPORT ECHOING AN OLDER SENDER REPORT. Loopback has no queue, so werift and the
     * agent agree on every real report above, and this is what tells them apart. The sender's clock
     * is read now, which is a time the agent logs exactly as it logs a sender report's. 400 ms later a
     * receiver report echoes it. werift matches only its latest report, so it learns nothing from
     * this; the agent must report about 400 ms.
     */
    const sender = (peer as unknown as { pc: RTCPeerConnection }).pc.getTransceivers()[0].sender;
    const old = lsrOf((sender as unknown as { ntpTimestamp: bigint }).ntpTimestamp);
    await new Promise((res) => setTimeout(res, 400));
    const before = reports.length;
    sender.handleRtcpPacket(new RtcpRrPacket({
      ssrc: 1, reports: [new RtcpReceiverInfo({ ssrc: sender.ssrc, lsr: old, dlsr: 0, highestSequence: 0, packetsLost: 0 })],
    }));
    const queued = reports.slice(before).find((x) => x.rttMs !== undefined);
    assert.ok(queued && queued.rttMs! >= 390 && queued.rttMs! < 700,
      `a report echoing a 400 ms old sender report read as ${queued?.rttMs} ms`);
    assert.equal(queued!.pairRtt, queued!.rttMs! / 1_000);
  });
});
