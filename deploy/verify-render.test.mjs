// Unit tests for the parsers in verify-render.mjs.
//
// Only the pure half is testable without a farm, and it is the half most likely to break silently:
// `dumpsys gfxinfo` output has changed shape across Android releases, and this repo has already
// been bitten once by trusting a tool's format (findFleetInstance, HANDOFF issues 11/12). The
// failure mode being defended against is NOT a crash — it is a confident zero. A parser that
// reports 0% jank because it stopped recognising the line would tell us SwiftShader is fine and
// send the GPU decision the wrong way.
//
//   node --test deploy/verify-render.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGfxinfo, summarise, layerCandidates, parseLatency, frameStats } from './verify-render.mjs';

// Real-shaped output from a recent Android. Note `Janky frames (legacy)` — a second line that also
// begins "Janky frames" and carries a DIFFERENT number.
const MODERN = `
Applications Graphics Acceleration Info:
Uptime: 883746 Realtime: 883746

** Graphics info for pid 4821 [io.appium.android.apis] **

Stats since: 883746123456ns
Total frames rendered: 1289
Janky frames: 63 (4.89%)
Janky frames (legacy): 51 (3.96%)
50th percentile: 7ms
90th percentile: 13ms
95th percentile: 19ms
99th percentile: 47ms
Number Missed Vsync: 2
Number High input latency: 0
Number Slow UI thread: 41
Number Slow bitmap uploads: 1
Number Slow issue draw commands: 18
`;

test('parses a modern gfxinfo dump', () => {
  const g = parseGfxinfo(MODERN);
  assert.equal(g.totalFrames, 1289);
  assert.equal(g.p50Ms, 7);
  assert.equal(g.p95Ms, 19);
  assert.equal(g.p99Ms, 47);
  assert.equal(g.missedVsync, 2);
  assert.equal(g.slowUiThread, 41);
  assert.equal(g.slowDrawCommands, 18);
});

test('takes the real Janky frames line, not the legacy one', () => {
  // The legacy line reports 51/3.96%. Reading it would understate jank by a fifth and could sit
  // just under the 5% budget while the true number sits just over it — the exact spot where this
  // script's verdict flips.
  const g = parseGfxinfo(MODERN);
  assert.equal(g.jankyFrames, 63);
  assert.ok(Math.abs(g.jankPct - 4.89) < 0.001, `jankPct was ${g.jankPct}`);
});

test('prefers the percentage Android printed over recomputing it', () => {
  // 63/1289 is 4.888…%, which rounds differently from the 4.89 Android prints. Which frames count
  // as janky is the platform's definition to make; if it ever disagrees with the naive ratio, the
  // platform is right.
  const g = parseGfxinfo(MODERN);
  assert.equal(g.jankPct, 4.89);
});

test('recomputes the percentage when Android does not print one', () => {
  const g = parseGfxinfo('Total frames rendered: 200\nJanky frames: 50\n');
  assert.equal(g.jankPct, 25);
});

test('missing fields are null, never zero', () => {
  // The whole point. A zero here reads as "perfectly smooth" and would argue against buying a GPU.
  const g = parseGfxinfo('** Graphics info for pid 1 [com.example] **\nStats since: 1ns\n');
  assert.equal(g.totalFrames, null);
  assert.equal(g.jankyFrames, null);
  assert.equal(g.jankPct, null);
  assert.equal(g.p95Ms, null);
  assert.equal(g.missedVsync, null);
});

test('unrecognisable output yields nulls rather than throwing', () => {
  // A device that answers with an error page must not take the harness down mid-run; the iteration
  // records a failure and the suite carries on to the next one.
  for (const junk of ['', 'Error: could not find package', '<html>502</html>']) {
    const g = parseGfxinfo(junk);
    assert.equal(g.totalFrames, null);
    assert.equal(g.jankPct, null);
  }
});

test('a genuinely janky device is reported as janky', () => {
  // The SwiftShader-is-not-enough case, which is the outcome that would justify the GPU spend.
  const g = parseGfxinfo('Total frames rendered: 900\nJanky frames: 405 (45.00%)\n95th percentile: 88ms\n');
  assert.equal(g.jankPct, 45);
  assert.equal(g.p95Ms, 88);
});

test('summarise reports spread, the flakiness signal', () => {
  // Steady gestures: a short tail.
  const steady = summarise([100, 102, 98, 101, 99, 100, 103, 97, 100, 101]);
  assert.ok(steady.spreadPct < 10, `steady spread was ${steady.spreadPct}`);

  // One long stall in ten is what an Appium suite experiences as an intermittent timeout, and the
  // median alone hides it completely — both samples have a median near 100ms.
  const stalling = summarise([100, 102, 98, 101, 99, 100, 103, 97, 100, 900]);
  assert.equal(stalling.p50, steady.p50);
  assert.ok(stalling.spreadPct > 100, `stalling spread was ${stalling.spreadPct}`);
});

test('summarise tolerates an empty sample', () => {
  assert.deepEqual(summarise([]), { p50: null, p95: null, max: null, spreadPct: null });
});

// ---------------------------------------------------------------- SurfaceFlinger

// Verbatim `dumpsys SurfaceFlinger --list` rows for a running Flutter app, captured from the lab
// device 2026-08-23. An app owns several layers and only one of them carries frames.
const LIST = `RequestedLayerState{Background for 24e6b7c SurfaceView[com.adilhanney.saber/com.adilhanney.saber.MainActivity]#118 parentId=116 relativeParentId=110 z=-2147483648}
RequestedLayerState{24e6b7c SurfaceView[com.adilhanney.saber/com.adilhanney.saber.MainActivity](BLAST)#117 parentId=116}
RequestedLayerState{ActivityRecord{131666017 u0 com.adilhanney.saber/.MainActivity t9}#104 parentId=103}
RequestedLayerState{Bounds for - com.adilhanney.saber/com.adilhanney.saber.MainActivity#115 parentId=110}
RequestedLayerState{b3d27c8 ActivityRecordInputSink com.adilhanney.saber/.MainActivity#108 parentId=104 z=-2147483648}
RequestedLayerState{VRI-com.adilhanney.saber/com.adilhanney.saber.MainActivity#110 parentId=109}`;

test('ranks the Flutter SurfaceView layer first and strips the wrapper', () => {
  const [first] = layerCandidates(LIST, 'com.adilhanney.saber');
  assert.ok(first.includes('(BLAST)'), first);
  assert.ok(first.includes('SurfaceView['), first);
  assert.ok(!first.startsWith('RequestedLayerState{'), 'the wrapper must be stripped');
  assert.ok(!first.includes('parentId='), 'trailing fields must be stripped');
});

test('drops decoration layers that never carry frames', () => {
  // Each surviving candidate costs an adb round trip per sample, and none of these can ever answer.
  const all = layerCandidates(LIST, 'com.adilhanney.saber').join('\\n');
  assert.ok(!all.includes('Background for'), all);
  assert.ok(!all.includes('ActivityRecordInputSink'), all);
  assert.ok(!all.includes('Bounds for'), all);
  assert.ok(!/^ActivityRecord\\{/m.test(all), all);
});

// Verbatim rows for a NATIVE HWUI app — note there is no (BLAST) layer anywhere. Measured on the
// lab device: the VRI- layer had 62 frames, the window layer had 0.
const NATIVE_LIST = `RequestedLayerState{5508336 ActivityRecordInputSink com.android.settings/.homepage.SettingsHomepageActivity#97 parentId=91 z=-2147483648}
RequestedLayerState{ActivityRecord{218530359 u0 com.android.settings/.Settings t9}#91 parentId=90}
RequestedLayerState{a5cc8f0 com.android.settings/com.android.settings.Settings#94 parentId=91}
RequestedLayerState{VRI-com.android.settings/com.android.settings.Settings#128 parentId=94}`;

test('ranks the ViewRootImpl layer first for a native app with no BLAST layer', () => {
  // The regression this guards: requiring (BLAST) found nothing for a native app, so the run
  // reported zero frames — indistinguishable from a device that rendered nothing.
  const cands = layerCandidates(NATIVE_LIST, 'com.android.settings');
  assert.ok(cands.length >= 1);
  assert.ok(cands[0].startsWith('VRI-'), cands.join(' | '));
});

test('returns no candidates when the package owns no layer, rather than guessing', () => {
  assert.deepEqual(layerCandidates(LIST, 'com.someone.else'), []);
  assert.deepEqual(layerCandidates('', 'com.adilhanney.saber'), []);
});

// Verbatim `--latency` output from the same device, taken immediately after six swipes.
const LATENCY = `16666666
76891261646	76911808021	76891452423
76924388056	76948075856	76933418419
76953431784	76962786826	76953528548
76973982239	76994779393	76974096872
76998442711	77011368154	76998559430`;

test('parses the refresh period and present timestamps', () => {
  const { refreshNs, presents } = parseLatency(LATENCY);
  assert.equal(refreshNs, 16666666);        // 60Hz
  assert.equal(presents.length, 5);
  assert.equal(presents[0], 76911808021);
});

test('skips frames the compositor has not presented', () => {
  // 0 and INT64_MAX both mean "no timestamp yet". Treating them as real would manufacture an
  // enormous interval and report catastrophic jank on a healthy device.
  const withPending = LATENCY + '\n77020000000\t9223372036854775807\t77020000000\n77030000000\t0\t77030000000';
  assert.equal(parseLatency(withPending).presents.length, 5);
});

test('empty or malformed latency output yields no frames rather than throwing', () => {
  for (const junk of ['', '\n', 'Layer not found', '0']) {
    const { presents } = parseLatency(junk);
    assert.equal(presents.length, 0);
  }
});

test('computes jank from real captured frames', () => {
  // Intervals here are 36.3, 14.7, 32.0 and 16.6ms against a 16.67ms vsync — two of the four
  // missed a vsync. This is the real device under SwiftShader, so the expected answer is NOT zero.
  const { refreshNs, presents } = parseLatency(LATENCY);
  const s = frameStats(refreshNs, presents);
  assert.equal(s.frames, 5);
  assert.equal(s.jankPct, 50);
  assert.equal(s.droppedFrames, 2);
  assert.ok(s.worstMs > 36 && s.worstMs < 37, `worstMs was ${s.worstMs}`);
  assert.ok(s.fps > 25 && s.fps < 35, `fps was ${s.fps}`);
});

test('a smooth 60fps stream reports no jank', () => {
  // The control case. Without it, a parser that always reports jank would look correct above.
  const refresh = 16666666;
  const presents = Array.from({ length: 60 }, (_, i) => 1_000_000_000 + i * refresh);
  const s = frameStats(refresh, presents);
  assert.equal(s.jankPct, 0);
  assert.equal(s.droppedFrames, 0);
  assert.ok(Math.abs(s.fps - 60) < 1, `fps was ${s.fps}`);
});

test('jitter within half a vsync is not counted as jank', () => {
  // Presentation timestamps wobble even on a healthy device; a 1.0x threshold would flag it all.
  const refresh = 16666666;
  const presents = [0];
  for (let i = 1; i < 40; i++) presents.push(presents[i - 1] + refresh + (i % 2 ? 3e6 : -2e6));
  assert.equal(frameStats(refresh, presents).jankPct, 0);
});

test('too few frames to compute anything is reported, not invented', () => {
  const s = frameStats(16666666, [1000]);
  assert.equal(s.frames, 1);
  assert.equal(s.jankPct, null);
  assert.equal(s.fps, null);
});

// ---------------------------------------------------------------- the zero-frame trap

test('gfxinfo reporting zero frames is NO DATA, not a perfect score', () => {
  // Verbatim from the lab device: with nothing rendered, Android prints every percentile as 4950ms
  // — the top histogram bucket used as a sentinel — beside a reassuring "Janky frames: 0 (0.00%)".
  // The first run of this script read that as a healthy device and concluded SwiftShader was fine.
  const g = parseGfxinfo(`** Graphics info for pid 4337 [com.adilhanney.saber] **
Total frames rendered: 0
Janky frames: 0 (0.00%)
50th percentile: 4950ms
95th percentile: 4950ms
99th percentile: 4950ms
Number Missed Vsync: 0`);
  assert.equal(g.totalFrames, 0);
  assert.equal(g.jankPct, null, 'zero frames must not report 0% jank');
  assert.equal(g.p95Ms, null, 'the 4950ms sentinel must never surface as a frame time');
  assert.match(g.noData, /no HWUI frames/);
});
