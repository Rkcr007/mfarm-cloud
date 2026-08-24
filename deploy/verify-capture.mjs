// Does a real phone actually give us an H.264 stream, and is it good enough to be a live view?
//
//   node deploy/verify-capture.mjs                       # first device adb sees
//   node deploy/verify-capture.mjs --serial 39121FDH…    # a specific one
//   node deploy/verify-capture.mjs --seconds 30 --bitrate 4000000
//
//   SCRCPY_SERVER_PATH=/path/scrcpy-server.jar SCRCPY_SERVER_VERSION=2.4 node deploy/verify-capture.mjs
//
// WHY THIS EXISTS. `workers/agent/src/devices/capture.ts` was written from the protocol and has
// never touched a handset. Its NAL reassembly is unit-tested and its process management is not,
// because process management against a phone cannot be. This is the thing that finds out.
//
// It is deliberately NOT a test of the live view. There is no WebRTC here, no browser and no
// viewer — this answers the one question underneath all of that: can the agent get a well-formed,
// timely H.264 stream off this device at all. If this fails, nothing built on top of it can work,
// and the failure will be much harder to see once there are three more layers above it.
//
// WHAT IT REPORTS, and why each one is here rather than just "it worked":
//
//   time to first frame   how long a viewer stares at nothing after pressing Open.
//   frame interval p50/p95 whether the stream is actually smooth or merely averages out.
//   keyframe interval     how long a viewer who joins mid-stream waits for a decodable picture —
//                         this is the number that decides whether the live view feels broken.
//   bitrate               against what was asked for; a device that ignores the request is common.
//   SPS/PPS present       without these a browser decoder has nothing to configure itself with,
//                         and the symptom is a permanently black rectangle rather than an error.
import { spawn, execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const SECONDS = Number(args.get('seconds') ?? 20);
const BITRATE = Number(args.get('bitrate') ?? 8_000_000);
const MAX_SIZE = args.get('maxSize') ? Number(args.get('maxSize')) : 1080;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
let failures = 0;
const ok = (m, d = '') => console.log(`  ${green('✓')} ${m}${d ? dim(` — ${d}`) : ''}`);
const bad = (m, d = '') => { failures++; console.log(`  ${red('✗')} ${m}${d ? dim(` — ${d}`) : ''}`); };

const adb = process.env.ADB_PATH
  ?? (process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb');

function run(bin, argv, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout.trim());
    });
  });
}

/** Percentile from an unsorted array of numbers. */
function pct(values, p) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function pickSerial() {
  const explicit = args.get('serial');
  if (explicit) return explicit;
  const out = await run(adb, ['devices']);
  const usable = out.split('\n').slice(1)
    .map((l) => l.trim()).filter(Boolean)
    .filter((l) => /\tdevice$/.test(l))
    .map((l) => l.split('\t')[0]);
  if (usable.length === 0) {
    console.error(red('\nNo usable device.') + ' `adb devices` shows nothing in state `device`.');
    console.error('If a phone is plugged in, unlock it and tap "Allow USB debugging".\n');
    console.error(out);
    process.exit(2);
  }
  if (usable.length > 1) console.log(dim(`  (${usable.length} devices; using ${usable[0]} — pass --serial to choose)`));
  return usable[0];
}

const HERE = dirname(fileURLToPath(import.meta.url));

async function main() {
  const serial = await pickSerial();

  // Read the module under test straight from source, so this verifies the code that ships rather
  // than a copy of its logic that could drift from it.
  const capturePath = join(HERE, '..', 'workers', 'agent', 'src', 'devices', 'capture.ts');
  const { createCapture } = await import(pathToFileURL(capturePath).href);

  const model = await run(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.model']).catch(() => '?');
  const release = await run(adb, ['-s', serial, 'shell', 'getprop', 'ro.build.version.release']).catch(() => '?');

  const capture = createCapture({ serial, maxSize: MAX_SIZE, bitRate: BITRATE });

  console.log(`\ndevice   ${model} · Android ${release} · ${serial}`);
  console.log(`source   ${capture.kind}${capture.kind === 'screenrecord'
    ? dim('  (no SCRCPY_SERVER_PATH — expect worse latency and a hitch every ~175s)') : ''}`);
  console.log(`asking   ${(BITRATE / 1e6).toFixed(1)} Mbps, long edge ${MAX_SIZE}px, for ${SECONDS}s\n`);

  const frameAt = [];       // arrival time of each frame's FIRST NAL
  const nalTypes = new Map();
  const keyframeAt = [];
  let bytes = 0;
  let sawSps = false, sawPps = false;
  let lastFrameTs = 0;

  const started = Date.now();
  try {
    await capture.start((nal, at) => {
      bytes += nal.length;
      const type = nal[0] & 0x1f;
      nalTypes.set(type, (nalTypes.get(type) ?? 0) + 1);
      if (type === 7) sawSps = true;
      if (type === 8) sawPps = true;
      if (type === 5) keyframeAt.push(at);
      // A frame is a slice NAL (1 = non-IDR, 5 = IDR). Parameter sets are not frames, and counting
      // them as such would flatter the frame rate by exactly the keyframe rate.
      if (type === 1 || type === 5) {
        if (at !== lastFrameTs) { frameAt.push(at); lastFrameTs = at; }
      }
    });
  } catch (e) {
    console.error(red(`\ncapture could not start: ${e.message}\n`));
    if (capture.kind === 'scrcpy') {
      console.error('For scrcpy this is almost always the version pair. SCRCPY_SERVER_VERSION must');
      console.error('match the jar EXACTLY (the string scrcpy itself passes, e.g. "2.4").\n');
    }
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  await capture.stop();
  const elapsed = (Date.now() - started) / 1000;

  console.log('Stream');
  if (capture.stats.frames > 0) ok('the device produced a stream', `${capture.stats.frames} NALs`);
  else bad('no NALs arrived at all', 'the device produced nothing this code could read');

  if (capture.stats.firstFrameMs !== undefined) {
    const t = capture.stats.firstFrameMs;
    // 2s is generous. It is how long somebody stares at an empty rectangle after pressing Open, and
    // past a couple of seconds people assume it is broken and click again.
    (t < 2000 ? ok : bad)('time to first frame', `${t}ms`);
  } else {
    bad('no first frame', 'nothing ever arrived');
  }

  const intervals = [];
  for (let i = 1; i < frameAt.length; i++) intervals.push(frameAt[i] - frameAt[i - 1]);
  const fps = frameAt.length / elapsed;
  console.log(`\nFrames  ${dim(`${frameAt.length} frames in ${elapsed.toFixed(1)}s`)}`);
  if (fps >= 10) ok('frame rate', `${fps.toFixed(1)} fps`);
  else bad('frame rate is too low to look live', `${fps.toFixed(1)} fps`);

  if (intervals.length > 0) {
    const p50 = pct(intervals, 50), p95 = pct(intervals, 95), worst = Math.max(...intervals);
    console.log(`  ${dim(`interval p50 ${p50}ms · p95 ${p95}ms · worst ${worst}ms`)}`);
    // An average frame rate hides stutter completely: 30fps with a 500ms freeze every second still
    // averages well and looks broken. p95 is what a person actually perceives.
    (p95 < 200 ? ok : bad)('smoothness (p95 between frames)', `${p95}ms`);
  }

  console.log('\nDecodability');
  // Without SPS/PPS a browser decoder cannot configure itself, and the symptom is a black rectangle
  // with no error anywhere — the single most confusing way this can fail.
  (sawSps && sawPps ? ok : bad)('SPS and PPS present',
    `SPS ${sawSps ? 'yes' : 'NO'}, PPS ${sawPps ? 'yes' : 'NO'}`);

  if (keyframeAt.length >= 2) {
    const gaps = [];
    for (let i = 1; i < keyframeAt.length; i++) gaps.push(keyframeAt[i] - keyframeAt[i - 1]);
    const worst = Math.max(...gaps);
    console.log(`  ${dim(`${keyframeAt.length} keyframes, gap p50 ${pct(gaps, 50)}ms, worst ${worst}ms`)}`);
    // This is how long a viewer who opens mid-stream waits for a picture. Beyond ~4s it reads as
    // broken rather than as loading.
    (worst < 4000 ? ok : bad)('a late viewer gets a picture quickly', `worst keyframe gap ${worst}ms`);
  } else if (keyframeAt.length === 1) {
    bad('only one keyframe in the whole capture', 'anyone joining late waits indefinitely');
  } else {
    bad('no keyframes', 'nothing can start decoding');
  }

  const mbps = (bytes * 8) / 1e6 / elapsed;
  console.log(`\nBitrate ${dim(`${mbps.toFixed(1)} Mbps against ${(BITRATE / 1e6).toFixed(1)} asked`)}`);
  // Devices routinely ignore the request; that is not a failure, but a wild overshoot is a
  // bandwidth problem for anyone watching over a network and is worth saying out loud.
  if (mbps <= (BITRATE / 1e6) * 1.5) ok('bitrate is near what was requested');
  else bad('the device is ignoring the bitrate request', `${mbps.toFixed(1)} Mbps`);

  const types = [...nalTypes.entries()].sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}:${n}`).join(' ');
  console.log(dim(`\nNAL types seen (type:count)  ${types}`));

  console.log(failures === 0
    ? green('\nThis phone can feed a live view. The transport is the remaining question.\n')
    : red(`\n${failures} check(s) failed — fix these before building a viewer on top.\n`));
  process.exit(failures === 0 ? 0 : 1);
}

await main();
