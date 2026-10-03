/**
 * Annex-B reassembly (ADR-0008, spec §20).
 *
 * WHY THIS IS THE PART WITH TESTS. Everything else in `capture.ts` is process management that needs
 * a phone; this is pure, and it is where a wrong answer is worst. A splitter that loses a NAL every
 * few seconds does not fail — it produces a picture that occasionally tears and recovers, which
 * looks like a flaky network, gets blamed on the device, and is close to impossible to diagnose
 * after the fact.
 *
 * The case that matters is the one a naive splitter gets wrong: a start code STRADDLING a chunk
 * boundary. A socket hands over arbitrary chunks, so `00 00 | 00 01` arriving as two reads is not
 * an edge case, it is Tuesday.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  NalSplitter, ScrcpyFramer, splitAnnexB, startsAnnexB, connectWhenServing,
  encodeTouch, encodeKey, encodeText, ScrcpyControl,
} from '../src/devices/capture.ts';
import type { ScrcpyPacket } from '../src/devices/capture.ts';

/** Collect everything a sequence of chunks produces. */
function feed(chunks: Buffer[]): Buffer[] {
  const s = new NalSplitter();
  const out: Buffer[] = [];
  for (const c of chunks) s.push(c, (n) => out.push(Buffer.from(n)));
  return out;
}

const START4 = Buffer.from([0, 0, 0, 1]);
const START3 = Buffer.from([0, 0, 1]);
const nal = (type: number, body: number[]) => Buffer.from([0x60 | type, ...body]);

describe('NalSplitter', () => {
  test('two NALs in one chunk', () => {
    const a = nal(7, [1, 2, 3]);
    const b = nal(5, [4, 5, 6, 7]);
    const out = feed([Buffer.concat([START4, a, START4, b])]);
    // The last NAL is still open — nothing after it proves where it ends — so only `a` is emitted.
    assert.deepEqual(out.map((n) => [...n]), [[...a]]);
  });

  test('the trailing NAL is emitted once the next start code arrives', () => {
    const a = nal(7, [1, 2, 3]);
    const b = nal(5, [4, 5, 6]);
    const c = nal(1, [8, 9]);
    const out = feed([
      Buffer.concat([START4, a, START4, b]),
      Buffer.concat([START4, c]),
    ]);
    assert.deepEqual(out.map((n) => [...n]), [[...a], [...b]]);
  });

  /**
   * THE ONE THAT MATTERS. `00 00 | 00 01` split across two reads. A stateless splitter sees no
   * start code in either half and silently drops the boundary — losing one NAL, forever, every
   * time the socket happens to break there.
   */
  test('a 4-byte start code straddling a chunk boundary is not lost', () => {
    const a = nal(7, [1, 2, 3]);
    const b = nal(5, [4, 5, 6]);
    const whole = Buffer.concat([START4, a, START4, b, START4, nal(1, [0])]);
    // Cut squarely inside the second start code.
    const cut = 4 + a.length + 2;
    const out = feed([whole.subarray(0, cut), whole.subarray(cut)]);
    assert.deepEqual(out.map((n) => [...n]), [[...a], [...b]]);
  });

  test('a 3-byte start code straddling a boundary is not lost either', () => {
    const a = nal(7, [1, 2, 3]);
    const b = nal(5, [4, 5, 6]);
    const whole = Buffer.concat([START3, a, START3, b, START3, nal(1, [0])]);
    const cut = 3 + a.length + 1;
    const out = feed([whole.subarray(0, cut), whole.subarray(cut)]);
    assert.deepEqual(out.map((n) => [...n]), [[...a], [...b]]);
  });

  test('3- and 4-byte start codes mixed in one stream', () => {
    const a = nal(7, [1, 2]);
    const b = nal(8, [3]);
    const c = nal(5, [4, 5, 6]);
    const out = feed([Buffer.concat([START4, a, START3, b, START4, c, START3, nal(1, [0])])]);
    assert.deepEqual(out.map((n) => [...n]), [[...a], [...b], [...c]]);
  });

  /**
   * A big NAL arriving in many small reads is the normal case for a keyframe: ~150 KB over dozens
   * of socket reads. It must come back out as ONE NAL, byte-identical.
   */
  test('a large NAL spread over many chunks reassembles byte-for-byte', () => {
    const big = Buffer.alloc(50_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    big[0] = 0x65;                       // an IDR NAL header
    // Make sure no accidental start code exists inside the payload.
    for (let i = 0; i + 2 < big.length; i++) {
      if (big[i] === 0 && big[i + 1] === 0 && (big[i + 2] === 1 || big[i + 2] === 0)) big[i + 2] = 2;
    }
    const whole = Buffer.concat([START4, big, START4, nal(1, [0])]);

    const chunks: Buffer[] = [];
    for (let i = 0; i < whole.length; i += 997) chunks.push(whole.subarray(i, i + 997));

    const out = feed(chunks);
    assert.equal(out.length, 1);
    assert.equal(out[0].length, big.length);
    assert.ok(out[0].equals(big), 'a keyframe reassembled wrong is a picture that tears');
  });

  test('byte-at-a-time delivery still reassembles correctly', () => {
    const a = nal(7, [1, 2, 3]);
    const b = nal(5, [4, 5, 6]);
    const whole = Buffer.concat([START4, a, START4, b, START4, nal(1, [0])]);
    const out = feed([...whole].map((byte) => Buffer.from([byte])));
    assert.deepEqual(out.map((n) => [...n]), [[...a], [...b]]);
  });

  test('leading bytes before the first start code are discarded, not emitted as a NAL', () => {
    const a = nal(7, [1, 2, 3]);
    const out = feed([Buffer.concat([Buffer.from([0xff, 0xfe]), START4, a, START4, nal(1, [0])])]);
    assert.deepEqual(out.map((n) => [...n]), [[...a]]);
  });

  test('an empty NAL between two start codes is not emitted', () => {
    const a = nal(7, [1]);
    const out = feed([Buffer.concat([START4, START4, a, START4, nal(1, [0])])]);
    assert.deepEqual(out.map((n) => [...n]), [[...a]]);
  });

  /**
   * `screenrecord` relaunches every ~175s and the next segment opens with its own SPS. A carried
   * partial NAL from the dead segment prepended to it would be garbage the decoder chokes on, so
   * the relaunch resets — this pins that the reset actually clears the carry.
   */
  test('reset drops a partial NAL rather than gluing it to the next segment', () => {
    const s = new NalSplitter();
    const out: Buffer[] = [];
    s.push(Buffer.concat([START4, nal(5, [1, 2, 3])]), (n) => out.push(Buffer.from(n)));
    s.reset();
    const a = nal(7, [9, 9]);
    s.push(Buffer.concat([START4, a, START4, nal(1, [0])]), (n) => out.push(Buffer.from(n)));
    assert.deepEqual(out.map((n) => [...n]), [[...a]], 'nothing from before the reset survives it');
  });

  test('an empty chunk changes nothing', () => {
    const a = nal(7, [1, 2]);
    const out = feed([
      Buffer.concat([START4, a]),
      Buffer.alloc(0),
      Buffer.concat([START4, nal(1, [0])]),
    ]);
    assert.deepEqual(out.map((n) => [...n]), [[...a]]);
  });
});

/**
 * Readiness (ADR-0008, spec §20).
 *
 * WHY THIS NEEDS A REAL SERVER. `app.inject()` has already shipped one feature in this codebase
 * that worked 0% of the time while the suite was green, because a fake cannot see socket lifecycle.
 * This is the same shape of bug: the first hardware run of `capture.ts` reported a working capture,
 * resolved `start()`, and delivered zero frames — because `adb forward` succeeds against nothing
 * and adb accepts a TCP connection before it discovers the device end is not listening.
 *
 * So these tests bind an actual TCP server and make it behave the way adb does: accept, then close
 * having sent nothing, until it is ready. A mock would have agreed with the broken code.
 */
/** scrcpy's frame header: PTS with the config and key flags in its top bits, then the length. */
const framed = (data: Buffer, ptsUs: number, flags: { config?: boolean; key?: boolean } = {}) => {
  const head = Buffer.alloc(12);
  let pts = BigInt(ptsUs);
  if (flags.config) pts |= 1n << 63n;
  if (flags.key) pts |= 1n << 62n;
  head.writeBigUInt64BE(pts, 0);
  head.writeUInt32BE(data.length, 8);
  return Buffer.concat([head, data]);
};

describe('scrcpy frames', () => {
  const sc = Buffer.from([0, 0, 0, 1]);
  const sps = Buffer.from([0x67, 1, 2, 3]);
  const pps = Buffer.from([0x68, 4, 5]);
  const idr = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(3000, 0xab)]);

  test('a whole frame splits into every NAL in it, the last one included', () => {
    const nals = splitAnnexB(Buffer.concat([sc, sps, sc, pps, Buffer.from([0, 0, 1]), idr]));
    assert.deepEqual(nals.map((n) => n[0]), [0x67, 0x68, 0x65]);
    assert.deepEqual(nals[2], idr, 'the last NAL is the one a bare stream held back');
  });

  test('headers and frames are read across any chunking, flags and timestamps intact', () => {
    const stream = Buffer.concat([
      framed(Buffer.concat([sc, sps, sc, pps]), 0, { config: true }),
      framed(Buffer.concat([sc, idr]), 16_666, { key: true }),
      framed(Buffer.concat([sc, Buffer.from([0x41, 9, 9])]), 33_333),
    ]);
    for (const step of [stream.length, 1, 7, 13, 500]) {
      const f = new ScrcpyFramer();
      const got: ScrcpyPacket[] = [];
      for (let i = 0; i < stream.length; i += step) f.push(stream.subarray(i, i + step), (p) => got.push({ ...p, data: Buffer.from(p.data) }));
      assert.deepEqual(got.map((p) => [p.config, p.key, p.ptsUs, p.data.length]),
        [[true, false, 0, 15], [false, true, 16_666, 3005], [false, false, 33_333, 7]], `chunks of ${step}`);
    }
  });

  /**
   * What the OnePlus showed: scrcpy 4.1 did not know `send_codec_meta`, so its 12-byte stream header
   * ('h264', width, height) came first and was read as a frame header. The packets after it are
   * garbage — and the tell is that they do not begin with a start code.
   */
  test('a leftover stream header shows up as packets that are not video', () => {
    const header = Buffer.alloc(12);
    header.write('h264', 0, 'latin1');
    header.writeUInt32BE(576, 4);
    header.writeUInt32BE(40, 8);
    const f = new ScrcpyFramer();
    const got: ScrcpyPacket[] = [];
    f.push(Buffer.concat([header, framed(Buffer.concat([sc, sps, sc, pps]), 0, { config: true }), Buffer.alloc(64)]), (p) => got.push(p));
    assert.ok(got.length > 0);
    assert.equal(startsAnnexB(got[0].data), false, 'a misaligned packet looked like video');
    assert.equal(startsAnnexB(Buffer.concat([sc, sps])), true);
    assert.equal(startsAnnexB(Buffer.from([0, 0, 1, 0x65])), true);
  });

  test('a frame is emitted the moment its last byte arrives, not when the next one starts', () => {
    const f = new ScrcpyFramer();
    const got: number[] = [];
    f.push(framed(Buffer.concat([sc, idr]), 5, { key: true }), (p) => got.push(p.ptsUs));
    assert.deepEqual(got, [5], 'the frame waited for its successor');
  });
});

describe('connectWhenServing', () => {
  /** A server that hangs up on its first `closeFirst` callers, then serves `payload`. */
  function flakyServer(closeFirst: number, payload: Buffer) {
    let seen = 0;
    const server = createServer((sock) => {
      seen++;
      // Exactly what adb does when the device-side abstract socket is not there yet.
      if (seen <= closeFirst) { sock.destroy(); return; }
      sock.write(payload);
    });
    return {
      server,
      listen: () => new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      }),
      get attempts() { return seen; },
    };
  }

  test('a connection that closes without data is retried, not mistaken for success', async () => {
    const payload = Buffer.from([0, 0, 0, 1, 0x67, 0x42]);
    const f = flakyServer(3, payload);
    const port = await f.listen();
    try {
      const { socket, first } = await connectWhenServing({ port, retryMs: 10 });
      assert.equal(f.attempts, 4, 'should have kept trying until bytes actually arrived');
      assert.deepEqual([...first], [...payload]);
      socket.destroy();
    } finally { f.server.close(); }
  });

  test('the first chunk is handed back, because it carries SPS and PPS', async () => {
    // Losing it is not a dropped frame — a decoder with no parameter sets shows a black rectangle
    // and reports no error, which is the most confusing way this can fail.
    const payload = Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 3]);
    const f = flakyServer(0, payload);
    const port = await f.listen();
    try {
      const { socket, first } = await connectWhenServing({ port, retryMs: 10 });
      assert.deepEqual([...first], [...payload]);
      socket.destroy();
    } finally { f.server.close(); }
  });

  test('a server that never serves fails loudly instead of resolving', async () => {
    const f = flakyServer(Number.MAX_SAFE_INTEGER, Buffer.alloc(0));
    const port = await f.listen();
    try {
      await assert.rejects(
        () => connectWhenServing({ port, timeoutMs: 250, retryMs: 10, describe: 'test-device' }),
        /no data within 250ms over \d+ attempt\(s\) on test-device/);
    } finally { f.server.close(); }
  });

  test('a dead server is reported as dead rather than waited out', async () => {
    // Without this the connect loop burns its whole deadline against a process that already exited,
    // and reports a timeout instead of the exit that caused it.
    await assert.rejects(
      () => connectWhenServing({
        port: 1, timeoutMs: 5_000, retryMs: 10,
        exited: () => 'scrcpy server exited (code 1, signal null)',
      }),
      /scrcpy server exited \(code 1, signal null\); check the version string/);
  });

  test('the returned socket still reports a mid-stream death', async () => {
    // The failure listeners are removed on success; the caller's own must survive, or a stream that
    // dies goes silent with nobody told — which is how it behaved before.
    const f = flakyServer(0, Buffer.from([1]));
    const port = await f.listen();
    try {
      const { socket } = await connectWhenServing({ port, retryMs: 10 });
      const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
      f.server.close();
      socket.destroy();
      await closed;
    } finally { f.server.close(); }
  });
});

/**
 * scrcpy's control socket. The byte layouts are checked against the 4.1 server's own parser, read
 * out of the jar (`ControlMessageReader`): a touch is a byte, a byte, a long, two ints, two shorts, a
 * short and two ints. A layout that is off by one field is not an error on the phone — the server
 * reads a different touch, or a different message, and carries on.
 */
describe('scrcpy control messages', () => {
  const video = { w: 576, h: 1280 };

  test('a touch is 32 bytes in the server\'s order', () => {
    const b = encodeTouch('down', 7, 288, 640, video);
    assert.equal(b.length, 32);
    assert.equal(b[0], 2, 'INJECT_TOUCH_EVENT');
    assert.equal(b[1], 0, 'ACTION_DOWN');
    assert.equal(b.readBigInt64BE(2), 7n);
    assert.equal(b.readInt32BE(10), 288);
    assert.equal(b.readInt32BE(14), 640);
    assert.equal(b.readUInt16BE(18), 576, 'the size the touch was aimed at — the server drops one that is not its own');
    assert.equal(b.readUInt16BE(20), 1280);
    assert.equal(b.readUInt16BE(22), 0xffff, 'a finger down presses fully');
    assert.equal(b.readInt32BE(24), 0, 'no action button: a finger is not a mouse');
    assert.equal(b.readInt32BE(28), 0);
    assert.equal(encodeTouch('move', 7, 1, 1, video)[1], 2, 'ACTION_MOVE');
    const up = encodeTouch('up', 7, 1, 1, video);
    assert.equal(up[1], 1, 'ACTION_UP');
    assert.equal(up.readUInt16BE(22), 0, 'a lifted finger presses with nothing');
  });

  test('a key is 14 bytes: type, action, keycode, repeat, meta', () => {
    const b = encodeKey('down', 66);
    assert.equal(b.length, 14);
    assert.deepEqual([b[0], b[1], b.readInt32BE(2), b.readInt32BE(6), b.readInt32BE(10)], [0, 0, 66, 0, 0]);
    assert.equal(encodeKey('up', 66)[1], 1);
  });

  test('text is a 4-byte length and UTF-8, cut between characters at 300 bytes', () => {
    const [one] = encodeText('héllo');
    assert.equal(one[0], 1, 'INJECT_TEXT');
    assert.equal(one.readUInt32BE(1), 6);
    assert.equal(one.subarray(5).toString('utf8'), 'héllo');
    const long = 'é'.repeat(200);                     // 400 bytes
    const parts = encodeText(long);
    assert.equal(parts.length, 2);
    for (const p of parts) assert.ok(p.readUInt32BE(1) <= 300 && p.length === 5 + p.readUInt32BE(1));
    assert.equal(parts.map((p) => p.subarray(5).toString('utf8')).join(''), long, 'a character was split');
    assert.deepEqual(encodeText(''), []);
  });

  test('written to the socket as they come, and refused once it is gone', async () => {
    const got: Buffer[] = [];
    let peer: import('node:net').Socket | undefined;
    const server = createServer((s) => { peer = s; s.on('data', (d) => got.push(d)); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { createConnection } = await import('node:net');
    const sock = createConnection({ port: (server.address() as AddressInfo).port, host: '127.0.0.1' });
    await new Promise((r) => sock.once('connect', r));
    try {
      const c = new ScrcpyControl(sock);
      assert.ok(c.touch('down', 1, -5, 2000, video), 'outside the picture is clamped to it, not dropped');
      assert.ok(c.key(4));
      assert.ok(c.text('a'));
      assert.ok(c.resetVideo());
      const expected = Buffer.concat([
        encodeTouch('down', 1, 0, 1279, video), encodeKey('down', 4), encodeKey('up', 4), ...encodeText('a'), Buffer.from([17]),
      ]);
      const end = Date.now() + 2000;
      while (Buffer.concat(got).length < expected.length && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(Buffer.concat(got), expected);
      peer!.destroy();
      await new Promise((r) => sock.once('close', r));
      assert.equal(c.open, false);
      assert.equal(c.touch('up', 1, 0, 0, video), false, 'a dead socket must send the caller to adb, not swallow the input');
      assert.equal(c.resetVideo(), false);
    } finally { sock.destroy(); server.close(); }
  });
});
