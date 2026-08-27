// Spike — can Node packetize a phone's H.264 stream into RTP fast enough to be the live view?
//
//   node spikes/scrcpy_rtp_throughput.mjs
//   node spikes/scrcpy_rtp_throughput.mjs --fps 60 --seconds 20 --bitrate 8
//
// WHY THIS EXISTS. ADR-0008 names exactly one unmeasured risk in the physical-device design:
//
//   "The agent becomes a WebRTC peer for the first time. Cuttlefish publishes its own stream and
//    the agent relays opaque signalling; a phone publishes nothing. Packetizing scrcpy's
//    already-hardware-encoded H.264 into RTP is neither a decode nor an encode, so device.ts's
//    'the agent never touches frames' invariant — which forbids a transcode — is intact.
//    Throughput in Node is UNMEASURED and is the largest open risk."
//
// Everything else about the live view is plumbing. This is the part that could turn out to be
// impossible, and building the feature before measuring it would be building on the one assumption
// nobody has checked. So: measure first, then decide.
//
// ---------------------------------------------------------------- what this DOES measure
//
// The CPU-bound work that happens per frame, forever, on the agent host:
//
//   1. Splitting an Annex-B byte stream into NAL units (scrcpy's raw output shape).
//   2. Fragmenting each NAL into MTU-sized RTP packets — FU-A for anything over the MTU.
//   3. Building the 12-byte RTP header for each packet: sequence, timestamp, marker bit.
//
// That is the code that would ship, run against frames the size a real phone produces, at the rate
// a real phone produces them, with the wall-clock pacing a real stream imposes.
//
// ---------------------------------------------------------------- what it does NOT measure
//
// Stated plainly, because a spike that overstates its coverage is worse than no spike:
//
//   - **Reading from scrcpy.** A socket read of ~1 MB/s is not a plausible bottleneck, and treating
//     it as one would pad this number with something that cannot fail.
//   - **SRTP encryption and the send.** That happens inside whichever WebRTC library is chosen and
//     is mostly native code. It is a REAL cost this does not include, and it is why the threshold
//     below leaves most of the frame budget unspent rather than merely fitting inside it.
//   - **A real device.** No handset was harmed. Frame sizes are modelled (see `syntheticFrame`),
//     which is fair for CPU cost — the packetizer's work scales with bytes and NAL count, and both
//     are modelled from a real bitrate — but a device that stalls, bursts, or emits unusual NAL
//     structures is not represented.
//
// So a PASS here means "Node is not the reason this cannot work". It does not mean the live view
// works, and the next step after a pass is the same harness against a real phone.
//
// ---------------------------------------------------------------- the threshold
//
// At 60fps the frame budget is 16.67ms. Packetization must be a rounding error against it, not a
// tenant of it, because the same event loop is also serving the data plane, the heartbeat and every
// other device on the host.
//
//   PASS  p99 per-frame packetize < 2ms
//         AND  worst single frame < the frame budget      (nothing blocks past its own slot)
//         AND  event-loop delay no worse than a CONTROL run that packetizes nothing
//         AND  keeps real time
//
// 2ms is 12% of the budget, chosen so that the unmeasured SRTP+send half can be several times more
// expensive than this half and still fit. If this fails, the fallback ADR-0008 anticipates is a
// bounded-rate screenshot channel that is honestly NOT called `screen-stream`.
//
// THE CONTROL RUN IS NOT OPTIONAL, and the first version of this spike proved why by failing on it.
// `monitorEventLoopDelay` measures how late timers fire, and this harness paces itself with
// `setTimeout` — whose granularity on a laptop, plus a GC pause, produces ~19ms spikes with no
// packetizer running at all. Reported alone it says "the packetizer stalls the loop"; measured
// against a control doing nothing, it says "this machine's timers are lumpy", which is true and
// irrelevant. An absolute loop-delay threshold here measures the harness, not the subject.

import { performance } from 'node:perf_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const FPS = Number(args.get('fps') ?? 60);
const SECONDS = Number(args.get('seconds') ?? 15);
const MBPS = Number(args.get('bitrate') ?? 8);          // scrcpy's default is 8 Mbps
const MTU = Number(args.get('mtu') ?? 1200);            // conservative for WebRTC over UDP

const FRAME_BUDGET_MS = 1000 / FPS;
const P99_LIMIT_MS = 2;

/* ------------------------------------------------------------------ the packetizer under test */

/**
 * Split an Annex-B stream into NAL units.
 *
 * Scans for 3- and 4-byte start codes. This is the shape scrcpy writes: raw Annex-B with no
 * container, so there is no length prefix to trust and the boundaries have to be found.
 */
function splitNals(buf) {
  const nals = [];
  let start = -1;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    let codeLen = 0;
    if (buf[i + 2] === 1) codeLen = 3;
    else if (i + 3 < buf.length && buf[i + 2] === 0 && buf[i + 3] === 1) codeLen = 4;
    if (codeLen === 0) continue;
    if (start >= 0) nals.push(buf.subarray(start, i));
    start = i + codeLen;
    i += codeLen - 1;
  }
  if (start >= 0 && start < buf.length) nals.push(buf.subarray(start));
  return nals;
}

let seq = 0;

/** The 12-byte RTP header. Payload type 96 (dynamic), SSRC fixed — neither affects cost. */
function rtpHeader(marker, timestamp) {
  const h = Buffer.allocUnsafe(12);
  h[0] = 0x80;                                  // version 2, no padding, no extension, no CSRC
  h[1] = (marker ? 0x80 : 0) | 96;              // marker bit + payload type
  h.writeUInt16BE(seq & 0xffff, 2);
  seq = (seq + 1) & 0xffff;
  h.writeUInt32BE(timestamp >>> 0, 4);
  h.writeUInt32BE(0x4d464152, 8);               // SSRC
  return h;
}

/**
 * One NAL to RTP packets (RFC 6184).
 *
 * Small NALs go out whole as a single-NAL-unit packet. Anything over the MTU is fragmented FU-A:
 * a 2-byte header replaces the 1-byte NAL header, with start and end bits on the first and last
 * fragments. A 1080p keyframe is ~150 KB, so it becomes ~130 packets — which is where the per-frame
 * cost actually lives, and why keyframe cadence matters to this measurement.
 */
function packetize(nal, timestamp, isLastNalOfFrame) {
  const packets = [];
  const maxPayload = MTU - 12;

  if (nal.length <= maxPayload) {
    packets.push(Buffer.concat([rtpHeader(isLastNalOfFrame, timestamp), nal]));
    return packets;
  }

  const nalHeader = nal[0];
  const nri = nalHeader & 0x60;
  const type = nalHeader & 0x1f;
  const body = nal.subarray(1);
  const maxFragment = maxPayload - 2;

  for (let off = 0; off < body.length; off += maxFragment) {
    const chunk = body.subarray(off, off + maxFragment);
    const first = off === 0;
    const last = off + maxFragment >= body.length;
    const fu = Buffer.allocUnsafe(2);
    fu[0] = nri | 28;                                          // FU-A indicator
    fu[1] = (first ? 0x80 : 0) | (last ? 0x40 : 0) | type;     // S/E bits + original type
    packets.push(Buffer.concat([
      rtpHeader(last && isLastNalOfFrame, timestamp), fu, chunk,
    ]));
  }
  return packets;
}

/* ------------------------------------------------------------------------ the synthetic source */

/**
 * A frame shaped like what a phone's hardware encoder emits.
 *
 * Sizes come from the bitrate rather than being invented: at N Mbps and F fps the average frame is
 * N*1e6/8/F bytes. Keyframes are modelled at 10x the average and delta frames scaled down to keep
 * the mean honest — that ratio is typical for a screen-content stream and, more to the point, it is
 * the ratio that decides the WORST frame, which is what p99 is measuring.
 *
 * Content is incompressible noise with start codes inserted, so `splitNals` does real scanning work
 * over real bytes. Zero-filled buffers would let the branch predictor make this look faster than it is.
 */
const avgFrameBytes = Math.round((MBPS * 1e6) / 8 / FPS);
const KEYFRAME_EVERY = FPS * 2;                 // scrcpy's default keyframe interval is ~2s

const noise = Buffer.allocUnsafe(4 << 20);
for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) & 0xff;

function syntheticFrame(n) {
  const isKey = n % KEYFRAME_EVERY === 0;
  const size = isKey ? avgFrameBytes * 10 : Math.round(avgFrameBytes * 0.9);
  // A keyframe carries SPS and PPS ahead of the IDR slice; a delta frame is one slice.
  const parts = [];
  const push = (bytes, nalType) => {
    parts.push(Buffer.from([0, 0, 0, 1]));
    const body = Buffer.allocUnsafe(bytes);
    noise.copy(body, 0, (n * 7919) % (noise.length - bytes), ((n * 7919) % (noise.length - bytes)) + bytes);
    body[0] = 0x60 | nalType;
    parts.push(body);
  };
  if (isKey) {
    push(24, 7);        // SPS
    push(8, 8);         // PPS
    push(size, 5);      // IDR
  } else {
    push(size, 1);      // non-IDR slice
  }
  return Buffer.concat(parts);
}

/* -------------------------------------------------------------------------------- the measurement */

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/**
 * The pacing loop, with or without the work under test.
 *
 * ONE function for both, so the control differs from the measured run in exactly one thing: whether
 * the packetizer is called. Any other difference between them would be a confound, and the whole
 * value of the control is that it isolates this machine's own timer noise.
 */
async function runLoop(totalFrames, frames, doWork) {
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();

  const perFrameMs = [];
  const keyframeMs = [];
  let packets = 0;
  let bytesOut = 0;
  let timestamp = 0;
  let behind = 0;

  const startedAt = performance.now();
  for (let n = 0; n < totalFrames; n++) {
    // Pace to real time. A packetizer measured in a tight loop answers a question nobody asked —
    // the real one arrives 60 times a second and must be done before the next.
    const due = startedAt + n * FRAME_BUDGET_MS;
    const slack = due - performance.now();
    if (slack > 0) await new Promise((r) => setTimeout(r, slack));
    else if (slack < -FRAME_BUDGET_MS) behind += 1;

    if (!doWork) continue;

    const frame = frames[n % frames.length];
    const t0 = performance.now();

    const nals = splitNals(frame);
    for (let i = 0; i < nals.length; i++) {
      const pkts = packetize(nals[i], timestamp, i === nals.length - 1);
      packets += pkts.length;
      // Touch every packet, so V8 cannot eliminate the work as dead. This stands in for handing
      // each one to the WebRTC stack.
      for (const pk of pkts) bytesOut += pk.length;
    }

    const took = performance.now() - t0;
    perFrameMs.push(took);
    if (n % KEYFRAME_EVERY === 0) keyframeMs.push(took);
    timestamp = (timestamp + Math.round(90000 / FPS)) >>> 0;   // 90kHz video clock
  }
  const elapsed = (performance.now() - startedAt) / 1000;
  loopDelay.disable();
  return { perFrameMs, keyframeMs, packets, bytesOut, behind, elapsed, maxLoopMs: loopDelay.max / 1e6 };
}

async function main() {
  const totalFrames = FPS * SECONDS;
  console.log('scrcpy -> RTP packetization, in Node');
  console.log(`  ${FPS} fps · ${MBPS} Mbps · MTU ${MTU} · ${SECONDS}s (${totalFrames} frames)`);
  console.log(`  average frame ${(avgFrameBytes / 1024).toFixed(1)} KB, keyframe every ${KEYFRAME_EVERY}`);
  console.log(`  frame budget ${FRAME_BUDGET_MS.toFixed(2)}ms, threshold p99 < ${P99_LIMIT_MS}ms\n`);

  // Pre-generate, so buffer allocation for the SOURCE is not charged to the packetizer. The real
  // source is a socket read, which is not this cost.
  const frames = [];
  for (let n = 0; n < Math.min(totalFrames, FPS * 4); n++) frames.push(syntheticFrame(n));

  // CONTROL FIRST: the same pacing, packetizing nothing. Whatever loop delay this machine produces
  // on its own is the floor the measured run has to be judged against.
  process.stdout.write('control (no packetization) … ');
  const control = await runLoop(totalFrames, frames, false);
  console.log(`event-loop max ${control.maxLoopMs.toFixed(2)}ms`);

  process.stdout.write('measured (packetizing)     … ');
  const r = await runLoop(totalFrames, frames, true);
  console.log(`event-loop max ${r.maxLoopMs.toFixed(2)}ms\n`);

  const { perFrameMs, keyframeMs, packets, bytesOut, behind, elapsed, maxLoopMs } = r;

  const sorted = [...perFrameMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const max = sorted[sorted.length - 1];
  const cpuShare = (perFrameMs.reduce((a, b) => a + b, 0) / (elapsed * 1000)) * 100;

  console.log('per-frame packetization');
  console.log(`  p50 ${p50.toFixed(3)}ms   p95 ${p95.toFixed(3)}ms   p99 ${p99.toFixed(3)}ms   max ${max.toFixed(3)}ms`);
  console.log(`  one core spent ${cpuShare.toFixed(1)}% of wall clock in the packetizer`);

  console.log('\nstream');
  console.log(`  ${packets} packets, ${(bytesOut / 1e6).toFixed(1)} MB out over ${elapsed.toFixed(1)}s`);
  console.log(`  ${((bytesOut * 8) / 1e6 / elapsed).toFixed(1)} Mbps · ${(packets / elapsed).toFixed(0)} packets/s`);

  const kfSorted = [...keyframeMs].sort((a, b) => a - b);
  console.log('\nkeyframes (the worst case — ~10x the bytes, so ~10x the packets)');
  console.log(`  n=${kfSorted.length}  p50 ${percentile(kfSorted, 50).toFixed(3)}ms  max ${(kfSorted[kfSorted.length - 1] ?? 0).toFixed(3)}ms`);

  console.log('\nevent loop — judged against the control, never against an absolute');
  console.log(`  control ${control.maxLoopMs.toFixed(2)}ms   measured ${maxLoopMs.toFixed(2)}ms   `
    + `attributable to packetizing: ${Math.max(0, maxLoopMs - control.maxLoopMs).toFixed(2)}ms`);
  console.log(`  frames that fell a whole budget behind: ${behind} (control: ${control.behind})`);

  // A margin over the control absorbs run-to-run variance in timer granularity and GC without
  // absorbing a real regression — the packetizer's own worst frame is measured directly above.
  const loopOk = maxLoopMs <= Math.max(control.maxLoopMs * 1.2, control.maxLoopMs + 2);
  const pass = p99 < P99_LIMIT_MS && max < FRAME_BUDGET_MS && loopOk && behind === 0;

  console.log(`\n${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} — p99 ${p99.toFixed(3)}ms vs ${P99_LIMIT_MS}ms, `
    + `worst frame ${max.toFixed(3)}ms vs ${FRAME_BUDGET_MS.toFixed(2)}ms budget, `
    + `loop ${loopOk ? 'no worse than control' : 'WORSE than control'}, ${behind} frames behind`);
  console.log(
    pass
      ? '\nNode is not the reason this cannot work. The open questions are now the WebRTC library\'s\n'
        + 'SRTP+send cost, and this same harness against a real phone.'
      : '\nPacketizing in Node does not fit the budget. ADR-0008\'s fallback applies: a bounded-rate\n'
        + 'screenshot channel, honestly NOT advertised as `screen-stream`.',
  );
  process.exit(pass ? 0 : 1);
}

await main();
