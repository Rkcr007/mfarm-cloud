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
import { NalSplitter, connectWhenServing } from '../src/devices/capture.ts';

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
