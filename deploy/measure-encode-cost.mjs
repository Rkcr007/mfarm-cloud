// What does recording cost the thing it is recording?
//
// THIS IS THE GATE ON VIDEO. `docs/EXECUTION_MODEL.md` §4.4 costed video and ended with one thing
// still unmeasured:
//
//   > One thing still needs measuring before any of it: what `screenrecord` actually costs on this
//   > hardware, run against the Flutter canvas workload where there is least headroom. That is a
//   > lab-hours experiment, not a design question.
//
// `docs/EXECUTION_ROADMAP.md` S5 then says video does not start until that number exists. This
// produces it.
//
// ---------------------------------------------------------------- why the canvas, and only the canvas
//
// `docs/RENDER_BASELINE.md` measured three workloads on this host. Ordinary UI — native and Flutter
// list scrolling — holds a full 60fps. The Flutter drawing canvas does not: **30fps, 69.9% jank,
// 1.35-second frozen frames**, because the guest renders through SwiftShader in software and a
// canvas paints every frame.
//
// So the canvas is the only workload worth this measurement. If recording is free on a 60fps list
// scroll that tells us nothing — there is headroom there by definition. The question is whether
// adding a software H.264 encoder to the workload that already has none makes it materially worse.
//
// ---------------------------------------------------------------- what is being compared
//
//   A  the canvas, driven, with nothing recording          — reproduces the baseline
//   B  the canvas, driven, with `screenrecord` running     — guest-side encode, the naive path
//
// B is the path `workers/agent/src/devices/capture.ts` already uses for the live view, and the one
// §4.4 suspects. Both scrcpy and `screenrecord` encode ON THE DEVICE; §4.4's proposal to "record on
// the HOST, reusing the encode cvd's WebRTC streamer already does" is a third path that does not
// exist yet, and building it is only worth doing if B is shown to be too expensive.
//
// ---------------------------------------------------------------- how it measures
//
// Reuses `verify-render.mjs`'s own parsers, imported rather than copied, so these numbers are
// directly comparable to `RENDER_BASELINE.md` — a second implementation of the same arithmetic
// would be a second thing to keep correct and a reason to doubt any difference it found.
//
// The instrument is `dumpsys SurfaceFlinger --latency`, NOT `gfxinfo`. Flutter renders with its own
// engine into a SurfaceView, so HWUI's counters are empty for it no matter how badly it performs —
// verify-render.mjs's header documents the false negative that nearly sent the GPU decision the
// wrong way.
//
// Interaction is `adb shell input swipe` rather than WebDriver. The baseline drove through the hub
// because it was also asking "does the automation flake"; this is asking one narrower question, and
// removing Appium removes a variable rather than adding confidence.
//
//   ALTERNATE=1 node deploy/measure-encode-cost.mjs      # A,B,A,B… rather than AAA,BBB
//
// RUNS ON THE DEVICE HOST, where adb can see the devices.
//
// ---------------------------------------------------------------- reused by measure-video-cost.mjs
//
// S5 needed the same experiment against a THIRD arm — cvd's host-side recorder — and the parts
// worth sharing are the gesture, the panel geometry and the round structure, not just the parsers.
// So `round` takes an injected recorder rather than knowing about `screenrecord`, and the pieces
// below are exported. Run directly, this file behaves exactly as it did when it produced the
// numbers in `docs/EXECUTION_MODEL.md` §4.4 — the default recorder IS `screenrecord`, and that is
// what keeps those numbers reproducible rather than merely recorded.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { layerCandidates, parseLatency, frameStats } from './verify-render.mjs';

const exec = promisify(execFile);

const PKG = process.env.APP_PACKAGE ?? 'com.adilhanney.saber';
const APK = process.env.APP_APK ?? `${process.env.HOME}/apks/saber.apk`;
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const SWIPES = Number(process.env.SWIPES ?? 20);
/** Interleave A and B rather than running all of one then all of the other. */
const ALTERNATE = process.env.ALTERNATE === '1';
/** `draw` (the canvas, worst case) or `scroll` (ordinary UI, the common case). */
const GESTURE = process.env.GESTURE ?? 'draw';

const say  = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const note = (m) => console.log(`  \x1b[33m·\x1b[0m ${m}`);
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad  = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const adb = (serial, args, opts = {}) =>
  exec('adb', ['-s', serial, ...args], { maxBuffer: 32 * 1024 * 1024, ...opts });

export async function firstDevice() {
  const { stdout } = await exec('adb', ['devices']);
  const serial = stdout.split('\n').slice(1)
    .map((l) => l.trim()).filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0])[0];
  if (!serial) throw new Error('no adb device is attached — is the farm up?');
  return serial;
}

/** The canvas layer SurfaceFlinger is presenting for this app. */
export async function canvasLayer(serial) {
  const { stdout } = await adb(serial, ['shell', 'dumpsys', 'SurfaceFlinger', '--list']);
  const candidates = layerCandidates(stdout, PKG);
  if (!candidates.length) throw new Error(`no SurfaceFlinger layer for ${PKG} — is it foreground?`);
  return candidates[0];
}

/**
 * One measured round: clear the frame history, drive the canvas, read what happened.
 *
 * The `--latency` buffer is CLEARED FIRST and read once at the end. Reading it repeatedly during
 * the gesture would sample a moving window and make the two arms differ by when they were read
 * rather than by what they did.
 */
export async function round(serial, layer, geometry, { recorder = null } = {}) {
  if (recorder) await recorder.start();

  try {
    /**
     * Host CPU is sampled across THE GESTURE ONLY, not across the whole round.
     *
     * The first version bracketed the entire round, recorder start and stop included — and those
     * add about four seconds of deliberate idle waiting that the no-recording arm does not have.
     * The busy fraction came out LOWER while recording than while not, which reads as "recording
     * makes the host cheaper" and is really "these two windows are not the same window".
     */
    await adb(serial, ['shell', 'dumpsys', 'SurfaceFlinger', '--latency-clear']);
    const cpuBefore = await cpuSnapshot();

    /**
     * TWO GESTURES, because the answer differs by workload and the difference is the whole design.
     *
     * `draw` — diagonal strokes on a DRAWING surface, so every frame repaints. This is
     *   `RENDER_BASELINE.md`'s canvas: 30fps with no headroom, the worst case on this host.
     * `scroll` — a fling on a list. The baseline's other two workloads both hold 60fps, and they
     *   are the COMMON case: ordinary UI is what most suites drive.
     *
     * If recording is only ruinous on the canvas, S5's constraint is narrow and interesting. If it
     * is ruinous on both, guest-side encode is simply not available on this host.
     */
    for (let i = 0; i < SWIPES; i++) {
      const { w, h } = geometry;
      if (GESTURE === 'scroll') {
        // A fling up the middle, from 80% to 25% of the panel.
        await adb(serial, ['shell', 'input', 'swipe',
          String(Math.round(w * 0.5)), String(Math.round(h * 0.8)),
          String(Math.round(w * 0.5)), String(Math.round(h * 0.25)), '120']);
      } else {
        // Diagonal strokes across the middle of the canvas, stepped down the panel so successive
        // strokes do not retrace one line.
        const y0 = Math.round(h * (0.30 + (i % 5) * 0.08));
        await adb(serial, ['shell', 'input', 'swipe',
          String(Math.round(w * 0.20)), String(y0),
          String(Math.round(w * 0.85)), String(y0 + Math.round(h * 0.15)), '260']);
      }
    }

    const hostCpuPct = cpuBusyPct(cpuBefore, await cpuSnapshot());
    const { stdout } = await adb(serial, ['shell', 'dumpsys', 'SurfaceFlinger', '--latency', `'${layer}'`]);
    const { refreshNs, presents } = parseLatency(stdout);
    return { ...frameStats(refreshNs, presents), hostCpuPct };
  } finally {
    if (recorder) await recorder.stop().catch(() => {});
  }
}

/**
 * Host CPU busy fraction between two `/proc/stat` reads.
 *
 * THE WHOLE HOST, not the encoder process. What can hurt a guest is the machine running out of
 * cores; attributing that to one PID would answer a narrower question, and would miss encoder
 * threads that live inside the long-running `cvd_internal_webrtc` process rather than in a child of
 * ours. Null off Linux, where this file's experiments do not run anyway.
 */
export async function cpuSnapshot() {
  const line = await readFile('/proc/stat', 'utf8').then((t) => t.split('\n')[0]).catch(() => null);
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  return { idle: v[3] + (v[4] ?? 0), total: v.reduce((a, b) => a + b, 0) };
}
export const cpuBusyPct = (a, b) => {
  if (!a || !b) return null;
  const dt = b.total - a.total, di = b.idle - a.idle;
  return dt > 0 ? ((dt - di) / dt) * 100 : null;
};

/**
 * The guest-side arm: `screenrecord`, exactly as `capture.ts` runs it for the live view.
 *
 * TO STDOUT AND DISCARDED, not to a file on the device. Writing to the guest's own storage would
 * add I/O the real path does not have — `capture.ts` streams `exec-out` — and would measure the
 * emulated disk rather than the encoder.
 */
export function screenrecordRecorder(serial) {
  let rec = null;
  return {
    async start() {
      rec = spawn('adb', ['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '-'],
        { stdio: ['ignore', 'ignore', 'ignore'] });
      // The encoder takes a moment to start; measuring the ramp-up would flatter the recording arm.
      await sleep(2500);
      if (rec.exitCode !== null) throw new Error('screenrecord exited immediately');
    },
    /**
     * KILLING THE adb CLIENT DOES NOT RELIABLY KILL `screenrecord` IN THE GUEST, and the orphan
     * keeps encoding until the platform's 180-second cap.
     *
     * Found 2026-09-07 by `measure-video-cost.mjs`: a four-arm run reported the HOST-side recorder
     * costing 31% of the frame rate, which an A/C-only run then reproduced as 0.1% across twelve
     * rounds. The difference was this arm's leftovers running through later rounds. A measurement
     * that contaminates the arms after it is worse than no measurement, because the number it
     * produces is confident.
     */
    async stop() {
      if (!rec) return;
      rec.kill('SIGINT'); await sleep(500); rec.kill('SIGKILL'); rec = null;
      await exec('adb', ['-s', serial, 'shell', 'pkill', '-f', 'screenrecord']).catch(() => {});
      await sleep(500);
    },
  };
}

export const median = (xs) => {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

export function summariseArm(rounds) {
  return {
    fps: median(rounds.map((r) => r.fps)),
    jankPct: median(rounds.map((r) => r.jankPct)),
    hostCpuPct: median(rounds.map((r) => r.hostCpuPct)),
    droppedFrames: median(rounds.map((r) => r.droppedFrames)),
    worstMs: median(rounds.map((r) => r.worstMs)),
    frames: median(rounds.map((r) => r.frames)),
  };
}

export const fmt = (v, digits = 1) => (v === null || v === undefined ? '—' : v.toFixed(digits));

/**
 * Get the device to the state a round expects: the workload installed, foreground, and settled,
 * with the panel geometry and the layer to measure resolved from the device rather than assumed.
 *
 * Extracted from `main` so the video arms drive the identical workload. If these two scripts ever
 * launch the app differently, their numbers stop being comparable and nothing says so.
 */
export async function prepareWorkload(serial) {
  const installed = await adb(serial, ['shell', 'pm', 'list', 'packages', PKG])
    .then(({ stdout }) => stdout.includes(PKG)).catch(() => false);
  // A system package (AOSP Settings, for the ordinary-UI arm) is present and has no APK to install.
  if (!installed && APK && !PKG.startsWith('com.android.')) {
    note(`installing ${PKG} from ${APK}`);
    await exec('adb', ['-s', serial, 'install', '-r', APK], { maxBuffer: 32 * 1024 * 1024 });
  }
  ok(`${PKG} is installed`);

  await adb(serial, ['shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1']);
  // Flutter's first frame is well after the process starts; measuring during startup would report
  // the cold start rather than the workload.
  await sleep(9000);

  /**
   * GESTURES ARE DERIVED FROM THE PANEL, not hardcoded.
   *
   * The first version used absolute coordinates from a 1080-wide phone. This farm's unprofiled
   * devices are **720x1280**, so the scroll ran from y=1600 — entirely off-screen — and produced
   * no frames at all, which the script correctly reported as "not enough frames to compare". The
   * draw gesture clipped at the right edge for the same reason.
   *
   * Fixed by reading `wm size`: this now works on the 720x1280 devices and on the profiled
   * 1080x2340 ones (ADR-0016) without a second set of numbers to keep in step.
   */
  const { stdout: sizeOut } = await adb(serial, ['shell', 'wm', 'size']);
  const m = /(\d+)x(\d+)/.exec(sizeOut);
  if (!m) throw new Error(`could not read the panel geometry: ${sizeOut.trim()}`);
  const geometry = { w: Number(m[1]), h: Number(m[2]) };
  ok(`panel ${geometry.w}x${geometry.h}`);

  const layer = await canvasLayer(serial);
  ok(`measuring layer ${layer}`);
  return { geometry, layer };
}

async function main() {
  const serial = await firstDevice();
  say(`Device ${serial}`);
  const { geometry, layer } = await prepareWorkload(serial);
  note(`${ROUNDS} round(s) per arm, ${SWIPES} ${GESTURE} gesture(s) each${ALTERNATE ? ', alternating' : ''}`);

  const arms = { plain: [], recording: [] };
  const order = [];
  if (ALTERNATE) {
    for (let i = 0; i < ROUNDS; i++) order.push('plain', 'recording');
  } else {
    for (let i = 0; i < ROUNDS; i++) order.push('plain');
    for (let i = 0; i < ROUNDS; i++) order.push('recording');
  }

  for (const [i, arm] of order.entries()) {
    process.stdout.write(`  round ${i + 1}/${order.length} (${arm})… `);
    try {
      const stats = await round(serial, layer, geometry,
        { recorder: arm === 'recording' ? screenrecordRecorder(serial) : null });
      arms[arm].push(stats);
      console.log(`${fmt(stats.fps)}fps, ${fmt(stats.jankPct)}% jank, worst ${fmt(stats.worstMs, 0)}ms`);
    } catch (e) {
      console.log(`\x1b[31mfailed: ${e.message}\x1b[0m`);
    }
    // Let the device settle: a round that starts while the previous encoder is still exiting
    // measures the teardown of the arm before it.
    await sleep(2000);
  }

  const A = summariseArm(arms.plain);
  const B = summariseArm(arms.recording);

  say('Result — medians across rounds');
  console.log('');
  console.log('  | arm                | fps  | jank   | dropped | worst frame |');
  console.log('  |--------------------|------|--------|---------|-------------|');
  console.log(`  | no recording       | ${fmt(A.fps).padStart(4)} | ${`${fmt(A.jankPct)}%`.padStart(6)} | ${String(A.droppedFrames ?? '—').padStart(7)} | ${`${fmt(A.worstMs, 0)}ms`.padStart(11)} |`);
  console.log(`  | screenrecord       | ${fmt(B.fps).padStart(4)} | ${`${fmt(B.jankPct)}%`.padStart(6)} | ${String(B.droppedFrames ?? '—').padStart(7)} | ${`${fmt(B.worstMs, 0)}ms`.padStart(11)} |`);
  console.log('');

  if (A.fps && B.fps) {
    const fpsDelta = ((B.fps - A.fps) / A.fps) * 100;
    const jankDelta = (B.jankPct ?? 0) - (A.jankPct ?? 0);
    console.log(`  fps      ${fpsDelta >= 0 ? '+' : ''}${fmt(fpsDelta)}%`);
    console.log(`  jank     ${jankDelta >= 0 ? '+' : ''}${fmt(jankDelta)} points`);
    console.log(`  worst    ${fmt((B.worstMs ?? 0) - (A.worstMs ?? 0), 0)}ms`);
    console.log('');

    /**
     * THE VERDICT, and the thresholds are the decision rather than a style choice.
     *
     * A 10% fps drop on a workload already at 30fps is the difference between 30 and 27, which is
     * inside the run-to-run spread `RENDER_BASELINE.md` measured (18–45% gesture wall-clock spread)
     * and is not a reason to build a host-side encoder that does not exist yet.
     *
     * The baseline's own warning names the risk this has to protect: *"it is not red suites, it is
     * timing-sensitive assertions and screenshot comparisons silently reading a device three frames
     * behind"*. So the failure this looks for is a materially worse device, not a slightly slower
     * one.
     */
    if (fpsDelta < -10 || jankDelta > 10) {
      bad('screenrecord materially perturbs the workload it measures');
      note('S5 must record on the HOST (§4.4 bullet 1), or ship for physical devices only,');
      note('where the encoder is on the phone\'s own hardware and this CPU is not in the loop.');
    } else {
      ok('screenrecord does NOT materially perturb this workload');
      note('S5 can use the guest-side encoder `capture.ts` already runs, which is the cheap path.');
    }
  } else {
    bad('not enough frames to compare — the app may not have been foreground');
  }
}

/**
 * Only when run directly. `measure-video-cost.mjs` imports `round` and the helpers above, and an
 * import that also ran a twenty-minute experiment would be a booby trap.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { bad(e.stack ?? e.message); process.exit(1); });
}
