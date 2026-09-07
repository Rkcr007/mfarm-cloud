// Does HOST-SIDE recording perturb the device the way guest-side recording does?
//
// THIS IS THE GATE ON S5. `deploy/measure-encode-cost.mjs` answered the first half — guest-side
// `screenrecord` costs the Flutter canvas a third of its frame rate — and `docs/VIDEO_EVIDENCE.md`
// proposes the alternative: `record_cvd`, which drives Cuttlefish's own `RecordingManager` on the
// HOST, tee'd off the same frame source the live stream uses.
//
// The obvious claim is that this is free for the guest, because nothing was added inside the guest.
// THAT CLAIM IS NOT OBVIOUSLY TRUE HERE and must not be assumed. `mfarm-lab` has no GPU: crosvm,
// SwiftShader's software rendering, Appium and now a software VP8 encoder all contend for the same
// sixteen cores. Host CPU starvation reaches the guest perfectly well without any guest-side code.
//
// ---------------------------------------------------------------- the arms
//
//   A  workload, nothing recording                    the baseline
//   B  workload, guest `screenrecord`                 the known-bad control, so the scale is anchored
//   C  workload, `record_cvd` on THIS device          what S5 proposes
//   D  workload, `record_cvd` on EVERY device         the contention case, which is production
//
// B is included even though its answer is known. Without it a small regression in C has nothing to
// be small COMPARED TO, and "C looks fine" would rest on the reader remembering another script's
// numbers.
//
// D is the arm that can actually fail. One extra encoder on sixteen cores is unlikely to matter;
// four of them, beside four software renderers, might. A farm records every session, so D is the
// normal state of a busy farm and not a stress test.
//
// ---------------------------------------------------------------- how it measures
//
// Imports `round`, the gesture, the panel geometry and the workload launch from
// `measure-encode-cost.mjs`, which in turn imports its parsers from `verify-render.mjs`. Three
// scripts, one implementation of the arithmetic and one of the workload — so these numbers are
// directly comparable to `RENDER_BASELINE.md` and to §4.4's table, and a change to the gesture
// cannot silently apply to one of them and not the others.
//
// Guest frames come from `dumpsys SurfaceFlinger --latency`, NOT `gfxinfo`, which cannot see
// Flutter at all. Host CPU comes from `/proc/stat` deltas across the round.
//
//   node deploy/measure-video-cost.mjs                 # A,B,C,D interleaved, 3 rounds each
//   ROUNDS=1 ARMS=A,C node deploy/measure-video-cost.mjs
//
// RUNS ON THE DEVICE HOST, as the user that owns the cvd instance database (`rkcr070707`) — cvd's
// database is per-uid and another user sees no devices at all.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  round, screenrecordRecorder, firstDevice, prepareWorkload,
  summariseArm, median, fmt, sleep,
} from './measure-encode-cost.mjs';

const exec = promisify(execFile);

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const ARMS = (process.env.ARMS ?? 'A,B,C,D').split(',').map((a) => a.trim().toUpperCase());
const IMAGE_DIR = process.env.CF_IMAGE_DIR ?? join(homedir(), 'cf', 'image');
const RECORD_CVD = join(IMAGE_DIR, 'bin', 'record_cvd');

const say  = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const note = (m) => console.log(`  \x1b[33m·\x1b[0m ${m}`);
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad  = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

/**
 * adb serial -> cvd instance number.
 *
 * `cuttlefish.ts` builds the serial as `0.0.0.0:${6519 + instanceNum}`, so this is that arithmetic
 * inverted rather than a lookup. Derived rather than parsed out of `cvd fleet` because the fleet
 * JSON's shape has changed across versions — `findFleetInstance` exists to work around exactly that
 * — and this direction cannot be wrong without the serial itself being wrong.
 */
function instanceOf(serial) {
  const port = Number(serial.split(':')[1]);
  if (!Number.isFinite(port)) throw new Error(`not a cuttlefish adb serial: ${serial}`);
  return port - 6519;
}

/** Every attached cuttlefish device, as {serial, instance}. */
async function allDevices() {
  const { stdout } = await exec('adb', ['devices']);
  return stdout.split('\n').slice(1)
    .map((l) => l.trim()).filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0]).filter((s) => s.includes(':'))
    .map((serial) => ({ serial, instance: instanceOf(serial) }));
}

/**
 * Where cvd writes this instance's recordings.
 *
 * `RecordingManager` uses `PerInstancePath("recording/")`, and the per-instance path lives under
 * cvd's OWN per-group HOME (`/var/tmp/cvd/<uid>/<group>/home/...`), not the user's — which is why
 * this globs rather than joining onto `$HOME`. A group id changes every time a group is recreated,
 * so caching it across a reset would silently point at a dead directory.
 */
async function recordingDirs(instance) {
  const root = `/var/tmp/cvd/${process.getuid()}`;
  const groups = await readdir(root).catch(() => []);
  const dirs = [];
  for (const g of groups) {
    const dir = join(root, g, 'home', 'cuttlefish', 'instances', `cvd-${instance}`, 'recording');
    if (await stat(dir).then(() => true).catch(() => false)) dirs.push(dir);
  }
  return dirs;
}

/**
 * Newest `.webm` for an instance, with its size — or null.
 *
 * Searches EVERY group directory that has a `cvd-<n>/recording`, not the first one found. The first
 * version returned the first match and reported nothing for arm C while six real recordings sat on
 * disk — a broken instrument that reads exactly like a recorder which did not run, which is the
 * most expensive way for a measurement to be wrong.
 */
async function newestRecording(instance) {
  let best = null;
  for (const dir of await recordingDirs(instance)) {
    const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.webm'));
    for (const n of names) {
      const p = join(dir, n);
      const st = await stat(p).catch(() => null);
      if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, bytes: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

/**
 * The host-side arm.
 *
 * Deletes what it produced. A measurement that leaves four `.webm` files per round behind fills the
 * device host's disk over a long run, and a stale file would also make `newestRecording` report the
 * previous round's artifact as this one's.
 */
function recordCvdRecorder(instances, measured) {
  const produced = [];
  let measuredBytes = null;
  return {
    instances,
    async start() {
      for (const i of instances) {
        await exec(RECORD_CVD, ['start', `--instance_num=${i}`], { timeout: 60_000 });
      }
      // Let the encoder threads spin up, mirroring the 2.5s `screenrecordRecorder` waits, so the
      // two recording arms are not separated by when they were measured.
      await sleep(2500);
    },
    async stop() {
      for (const i of instances) {
        await exec(RECORD_CVD, ['stop', `--instance_num=${i}`], { timeout: 60_000 }).catch(() => {});
      }
      // AFTER every stop, not interleaved with them: mkvmuxer finalizes on stop and the size read
      // immediately after the call caught a file mid-flush, reporting 110 bytes for a recording
      // that turned out to be 300 KB.
      await sleep(1500);
      for (const i of instances) {
        const file = await newestRecording(i);
        if (!file) continue;
        produced.push(file);
        if (i === measured) measuredBytes = file.bytes;
      }
    },
    /** Bytes the MEASURED device produced this round, and cleanup of every file this arm wrote. */
    async harvest() {
      const bytes = measuredBytes;
      for (const f of produced) await rm(f.path, { force: true }).catch(() => {});
      produced.length = 0; measuredBytes = null;
      return bytes;
    },
  };
}

const ARM_LABEL = {
  A: 'no recording',
  B: 'screenrecord (guest)',
  C: 'record_cvd (host, 1 device)',
  D: 'record_cvd (host, all devices)',
};

async function main() {
  if (!(await stat(RECORD_CVD).then(() => true).catch(() => false))) {
    throw new Error(`${RECORD_CVD} not found — set CF_IMAGE_DIR to the unpacked cvd host package`);
  }
  const serial = await firstDevice();
  const devices = await allDevices();
  const measured = instanceOf(serial);
  say(`Device ${serial} (cvd-${measured}); host has ${devices.length} device(s)`);

  const { geometry, layer } = await prepareWorkload(serial);
  note(`${ROUNDS} round(s) per arm, arms ${ARMS.join(',')}, interleaved`);

  const arms = Object.fromEntries(ARMS.map((a) => [a, []]));
  const sizes = Object.fromEntries(ARMS.map((a) => [a, []]));

  const order = [];
  for (let i = 0; i < ROUNDS; i++) order.push(...ARMS);

  for (const [i, arm] of order.entries()) {
    process.stdout.write(`  round ${i + 1}/${order.length} (${arm} — ${ARM_LABEL[arm]})… `);
    let recorder = null;
    if (arm === 'B') recorder = screenrecordRecorder(serial);
    if (arm === 'C') recorder = recordCvdRecorder([measured], measured);
    if (arm === 'D') recorder = recordCvdRecorder(devices.map((d) => d.instance), measured);

    try {
      const stats = await round(serial, layer, geometry, { recorder });
      arms[arm].push(stats);
      if (recorder?.harvest) {
        const bytes = await recorder.harvest();
        if (bytes !== null) sizes[arm].push(bytes);
      }
      const kb = sizes[arm].length ? sizes[arm][sizes[arm].length - 1] / 1024 : null;
      console.log(`${fmt(stats.fps)}fps, ${fmt(stats.jankPct)}% jank, ${stats.droppedFrames} dropped` +
        (kb === null ? '' : `, ${kb.toFixed(0)}KB recorded`));
    } catch (e) {
      console.log(`\x1b[31mfailed: ${e.message}\x1b[0m`);
      await recorder?.harvest?.().catch(() => {});
    }
    // Let the device settle: a round that starts while the previous encoder is still exiting
    // measures the teardown of the arm before it.
    await sleep(2500);
  }

  say('Result — medians across rounds');
  console.log('');
  console.log('  | arm | what                            | fps  | jank   | dropped | host cpu | artifact |');
  console.log('  |-----|---------------------------------|------|--------|---------|----------|----------|');
  const summary = {};
  for (const arm of ARMS) {
    const s = summariseArm(arms[arm]);
    summary[arm] = s;
    const kb = median(sizes[arm]);
    console.log(
      `  | ${arm}   | ${ARM_LABEL[arm].padEnd(31)} | ${fmt(s.fps).padStart(4)} | ` +
      `${`${fmt(s.jankPct)}%`.padStart(6)} | ${String(s.droppedFrames ?? '—').padStart(7)} | ` +
      `${`${fmt(s.hostCpuPct)}%`.padStart(8)} | ` +
      `${(kb === null ? '—' : `${(kb / 1024).toFixed(0)} KB`).padStart(8)} |`);
  }
  console.log('');

  const A = summary.A;
  if (!A?.fps) { bad('arm A produced no frames — the workload was probably not foreground'); return; }

  /**
   * THE VERDICT, with the same thresholds `measure-encode-cost.mjs` uses, for the same reason: a
   * 10% move on a 30fps workload is inside the run-to-run spread `RENDER_BASELINE.md` measured, and
   * the failure being looked for is a materially worse device rather than a slightly slower one.
   *
   * Applied to C and D SEPARATELY. C failing means host-side recording is not viable at all. D
   * failing while C passes means it is viable with a cap on concurrent recordings — a different
   * decision with a different fix, so reporting one number for both would hide the useful half.
   */
  for (const arm of ['B', 'C', 'D']) {
    const s = summary[arm];
    if (!s?.fps) continue;
    const fpsDelta = ((s.fps - A.fps) / A.fps) * 100;
    const jankDelta = (s.jankPct ?? 0) - (A.jankPct ?? 0);
    const line = `${arm} vs A: fps ${fpsDelta >= 0 ? '+' : ''}${fmt(fpsDelta)}%, ` +
      `jank ${jankDelta >= 0 ? '+' : ''}${fmt(jankDelta)} points`;
    if (fpsDelta < -10 || jankDelta > 10) bad(`${line} — materially perturbs the workload`);
    else ok(`${line} — no material perturbation`);
  }

  console.log('');
  if (summary.C?.fps && summary.D?.fps) {
    const cOk = ((summary.C.fps - A.fps) / A.fps) * 100 >= -10;
    const dOk = ((summary.D.fps - A.fps) / A.fps) * 100 >= -10;
    if (cOk && dOk) note('S5 may record every session on this host.');
    else if (cOk) note('S5 may record, but concurrent recordings must be capped — see docs/VIDEO_EVIDENCE.md §7.');
    else note('Host-side recording is NOT free on this host. Do not ship S5 on these numbers.');
  }
}

main().catch((e) => { bad(e.stack ?? e.message); process.exit(1); });
