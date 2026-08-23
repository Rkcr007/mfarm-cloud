// Measure whether THIS graphics mode is good enough to test GPU-heavy apps on.
//
// WHY THIS EXISTS. `verify-webdriver.mjs` proves a session works. It says nothing about whether the
// device renders well enough that a Flutter or React Native suite passes *consistently*, and that
// is the open question the whole GPU argument turns on:
//
//   docs/MVP_PLAN.md flags GPU-heavy renderers as the risk that would justify leaving SwiftShader.
//   ADR-0007 measured 49 fps of WEBRTC on a cold-booted device. That is the transport, not the
//   guest. A device can stream 49 fps of a guest that is itself dropping every third frame.
//
// So this measures the guest, with Android's own frame-timing counters, while a real WebDriver
// session flings a real list. If jank is low and the pass rate is 100%, SwiftShader is sufficient
// and a GPU is a density optimisation to defer. If jank is high or iterations fail at random, that
// is the evidence that buys gfxstream — and everything it costs.
//
// TWO INSTRUMENTS, DELIBERATELY SEPARATE:
//
//   interaction   W3C WebDriver, through the hub — the real product path, every hop included
//   measurement   local `adb shell dumpsys SurfaceFlinger --latency` — out of band
//
// THE MEASUREMENT IS THE COMPOSITOR, NOT HWUI, AND THAT IS THE WHOLE POINT. The obvious instrument
// is `dumpsys gfxinfo`, and for a Flutter app it is silently, catastrophically wrong: measured here
// on 2026-08-23, a foreground Saber 1.35 reported `Total frames rendered: 1` after twelve seconds of
// use. Flutter does not draw through HWUI. It renders with its own engine into a SurfaceView —
// `SurfaceView[com.adilhanney.saber/...MainActivity](BLAST)` in SurfaceFlinger's layer list — so
// HWUI's counters are empty for it no matter how badly it is performing. gfxinfo would have
// reported 0% jank on a device dropping every other frame, which is precisely the false negative
// that would have sent this decision the wrong way.
//
// SurfaceFlinger sees every layer regardless of who rendered it, so it works for Flutter, for a
// native HWUI app, and for a game — and `--latency` gives per-frame present timestamps, from which
// missed vsyncs are arithmetic rather than inference.
//
// The measurement does NOT go through Appium. `mobile: shell` needs `--allow-insecure adb_shell`,
// and workers/agent/src/appium.ts argues at length that an Appium port is already a
// shell-equivalent on the device and must not be given more. Enabling an insecure feature to
// benchmark is exactly the kind of "temporary" change that outlives the benchmark. Reading the
// counters beside the path also keeps the instrument from perturbing what it measures.
//
// CONSEQUENCE: run this ON THE DEVICE HOST, where adb can see the device. That is the same place
// verify-webdriver.mjs already expects to run.
//
//   MFARM_API_KEY=mfk_... node deploy/verify-render.mjs
//   MFARM_API_KEY=mfk_... APP_APK=/home/rkcr070707/apks/gallery.apk \
//     APP_PACKAGE=io.flutter.demo.gallery ITERATIONS=5 node deploy/verify-render.mjs
//
// Zero dependencies, for the reasons verify-webdriver.mjs gives: a WebDriver client would hide the
// layer under test, and another npm install on a metered box is another thing to go wrong.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

const HUB = process.env.HUB ?? 'http://127.0.0.1:3000';
const REGION = process.env.REGION ?? 'lab';
const KEY = process.env.MFARM_API_KEY;
const ITERATIONS = Number(process.env.ITERATIONS ?? 5);
const FLINGS = Number(process.env.FLINGS ?? 12);

// The app under measurement. Defaults to whatever is already in the foreground, which makes the
// script runnable with no setup at all as a wiring check — but a launcher is NOT a rendering
// workload, so that path reports its own verdict as inconclusive rather than pretending otherwise.
const APP_APK = process.env.APP_APK;
const APP_PACKAGE = process.env.APP_PACKAGE;
const APP_ACTIVITY = process.env.APP_ACTIVITY;

/**
 * Taps to run once before measuring, as `x,y x,y` — how the run reaches a screen worth measuring.
 *
 * Needed because an app's first screen is usually its least interesting. Saber opens on an empty
 * "Welcome, tap + to create a note" state with nothing to scroll, and flinging it produced fifteen
 * frames in six seconds — not because rendering was slow but because nothing was moving. Measuring
 * that and calling it a verdict is the same error as measuring the launcher.
 */
const WARMUP_TAPS = (process.env.WARMUP_TAPS ?? '').trim();

/**
 * Below this many presented frames, an iteration reports NO DATA instead of a number.
 *
 * The guard exists because every degenerate case in this script so far — wrong app foregrounded,
 * app bypassing HWUI, nothing on screen moving — presented as a small, confident, excellent-looking
 * sample. A run that cannot see enough frames must say so.
 */
const MIN_FRAMES = Number(process.env.MIN_FRAMES ?? 20);

// Thresholds. Deliberately conservative and deliberately named, because the point of this script is
// to produce a decision, and a decision needs a line drawn before the data arrives rather than
// after. Android's own jank bar is the 16.7ms frame budget; Google's Play vitals treats >5% janky
// frames as "bad behaviour" for a user-facing app, so 5% is not an arbitrary number.
const JANK_BUDGET_PCT = Number(process.env.JANK_BUDGET_PCT ?? 5);
// A suite that fails one run in twenty is a suite nobody trusts. Anything under 100% here is worth
// investigating before it is worth explaining away.
const PASS_RATE_FLOOR_PCT = Number(process.env.PASS_RATE_FLOOR_PCT ?? 100);

const basic = 'Basic ' + Buffer.from(`${KEY}:`).toString('base64');
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function call(method, path, body) {
  const url = `${HUB}/wd/hub${path}`;
  const started = Date.now();
  const res = await fetch(url, {
    method,
    headers: { authorization: basic, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not every error page is JSON */ }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.detail = text.slice(0, 2000);
    throw err;
  }
  return { json, text, ms: Date.now() - started };
}

/**
 * `adb shell` against one device, by serial.
 *
 * Serial, never "the only device": a farm host runs two, and `adb shell` with no -s on a two-device
 * host errors out rather than guessing — which is the good outcome. The bad outcome is a host with
 * ONE device where it silently succeeds, so the measurement quietly attributes another tenant's
 * frames to this run the day a second device appears. Always -s.
 */
async function adb(serial, ...args) {
  const { stdout } = await exec('adb', ['-s', serial, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/**
 * Parse `dumpsys gfxinfo <pkg>`.
 *
 * Tolerant on purpose. This output has changed shape across Android releases and this repo has been
 * bitten by assuming a tool's format before (see findFleetInstance in devices/cuttlefish.ts). Every
 * field is optional; a missing one reports as null and the caller says so rather than reporting a
 * confident zero. A confident zero is the worst possible output for a script whose entire job is to
 * decide whether to spend money.
 */
export function parseGfxinfo(text) {
  const num = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  const total = num(/Total frames rendered:\s*(\d+)/);
  const janky = num(/Janky frames:\s*(\d+)/);

  // NO FRAMES MEANS NO DATA, NOT A PERFECT SCORE.
  //
  // With nothing rendered, Android still prints every percentile — as `4950ms`, the top histogram
  // bucket, used as a not-a-number sentinel. Read literally that is a 4.95-SECOND frame beside a
  // reassuring `Janky frames: 0 (0.00%)`. The first run of this script reported exactly that and
  // concluded the graphics mode was fine. Refuse to answer instead.
  if (total === 0) {
    return {
      totalFrames: 0, jankyFrames: null, jankPct: null,
      p50Ms: null, p90Ms: null, p95Ms: null, p99Ms: null,
      missedVsync: null, slowUiThread: null, slowDrawCommands: null, highInputLatency: null,
      noData: 'the app rendered no HWUI frames (expected for Flutter, which bypasses HWUI)',
    };
  }
  // The percentage Android prints itself, when it prints one — preferred over recomputing, because
  // which frames count as janky is its definition to make, not ours.
  let jankPct = num(/Janky frames:\s*\d+\s*\(([\d.]+)%\)/);
  if (jankPct === null && total && janky !== null) jankPct = (janky / total) * 100;
  return {
    totalFrames: total,
    jankyFrames: janky,
    jankPct,
    p50Ms: num(/50th percentile:\s*(\d+)ms/),
    p90Ms: num(/90th percentile:\s*(\d+)ms/),
    p95Ms: num(/95th percentile:\s*(\d+)ms/),
    p99Ms: num(/99th percentile:\s*(\d+)ms/),
    missedVsync: num(/Number Missed Vsync:\s*(\d+)/),
    slowUiThread: num(/Number Slow UI thread:\s*(\d+)/),
    slowDrawCommands: num(/Number Slow issue draw commands:\s*(\d+)/),
    highInputLatency: num(/Number High input latency:\s*(\d+)/),
  };
}

/**
 * The layers that might carry this app's frames, best guess first.
 *
 * WHICH LAYER HOLDS THE FRAMES DEPENDS ON HOW THE APP RENDERS, and getting it wrong returns an
 * empty table that reads as a flawlessly smooth device. Measured on the lab box 2026-08-23:
 *
 *   Flutter (draws into a SurfaceView)   `… SurfaceView[pkg/activity](BLAST)#117`   45 frames
 *   Native HWUI (Settings)               `VRI-pkg/activity#128`                     62 frames
 *                                        `… pkg/activity#94`                         0 frames
 *
 * A native app has NO `(BLAST)` layer at all, and its window layer carries nothing — the frames are
 * on the ViewRootImpl child. So this returns candidates rather than an answer, and the caller picks
 * whichever actually has frames. Empirical beats clever: the next Android release can move them
 * again and the caller still finds them.
 *
 * The obvious decorations are excluded because they never carry frames and each one costs a probe:
 * the background fill, the input sink, the ActivityRecord and the bounds placeholder.
 */
export function layerCandidates(listOutput, pkg) {
  const rows = listOutput.split('\n')
    .map((l) => l.replace(/^RequestedLayerState\{/, '').replace(/ parentId=.*$/, '').replace(/\}$/, '').trim())
    .filter((l) => l.includes(pkg))
    .filter((l) => !/^Background for |ActivityRecordInputSink|^ActivityRecord\{|^Bounds for /.test(l));
  const rank = (l) => (l.includes('(BLAST)') ? 0 : l.startsWith('VRI-') ? 1 : 2);
  return [...new Set(rows)].sort((a, b) => rank(a) - rank(b));
}

/** INT64_MAX — SurfaceFlinger's "this frame has not been presented" marker. Compared as a string,
 *  because the value does not survive a round trip through a JS number. */
const PENDING = '9223372036854775807';

/**
 * Parse `dumpsys SurfaceFlinger --latency <layer>`.
 *
 * Line 1 is the display refresh period in nanoseconds. Every line after it is one frame:
 * `desiredPresentTime actualPresentTime frameReadyTime`. Rows that are zero or INT64_MAX are frames
 * the compositor has not presented yet and carry no timing — dropping them is not sampling bias,
 * they genuinely have no timestamp.
 */
export function parseLatency(text) {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const refreshNs = lines.length ? Number(lines[0]) : NaN;
  if (!Number.isFinite(refreshNs) || refreshNs <= 0) return { refreshNs: null, presents: [] };
  const presents = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length < 3) continue;
    const actual = cols[1];
    if (actual === '0' || actual === PENDING) continue;
    const n = Number(actual);
    if (Number.isFinite(n) && n > 0) presents.push(n);
  }
  return { refreshNs, presents };
}

/**
 * Turn present timestamps into the numbers the decision needs.
 *
 * `jankPct` is the share of frame INTERVALS longer than 1.5 refresh periods — that is, frames that
 * missed at least one vsync. The 1.5 rather than 1.0 is deliberate: presentation timestamps jitter
 * by a fraction of a period even on a perfectly smooth device, and counting those as jank would
 * report a healthy device as broken.
 *
 * `droppedFrames` counts how many vsyncs were missed in total, which is the number a person
 * actually perceives — one 100ms stall is worse than five 20ms ones and this separates them.
 */
export function frameStats(refreshNs, presents) {
  if (!refreshNs || presents.length < 2) {
    return { frames: presents.length, intervalsMs: [], jankPct: null, droppedFrames: null, fps: null, worstMs: null };
  }
  const sorted = [...presents].sort((a, b) => a - b);
  const intervalsMs = [];
  let dropped = 0, janky = 0;
  for (let i = 1; i < sorted.length; i++) {
    const ns = sorted[i] - sorted[i - 1];
    intervalsMs.push(ns / 1e6);
    if (ns > refreshNs * 1.5) janky++;
    dropped += Math.max(0, Math.round(ns / refreshNs) - 1);
  }
  const med = [...intervalsMs].sort((a, b) => a - b)[Math.floor(intervalsMs.length / 2)];
  return {
    frames: presents.length,
    intervalsMs,
    jankPct: (janky / intervalsMs.length) * 100,
    droppedFrames: dropped,
    fps: med > 0 ? 1000 / med : null,
    worstMs: Math.max(...intervalsMs),
  };
}

/** Median and p95 of a small sample, for gesture wall-clock times. */
export function summarise(values) {
  if (!values.length) return { p50: null, p95: null, max: null, spreadPct: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const p50 = at(0.5);
  // Spread is the flakiness signal. A device that renders consistently produces gestures that take
  // consistent wall-clock time; one that stalls under load produces a long tail, and a long tail is
  // what an Appium suite experiences as an intermittent timeout.
  const spreadPct = p50 ? ((at(0.95) - p50) / p50) * 100 : null;
  return { p50, p95: at(0.95), max: s[s.length - 1], spreadPct };
}

/**
 * One fling, as a real W3C pointer action through the hub.
 *
 * A fling rather than a slow drag, because a fling is what produces jank: it hands the list to the
 * platform's own animator and asks it to render frames as fast as it can with no further input.
 * A slow drag is paced by the driver and measures the driver.
 */
function flingAction(w, h, up) {
  const x = Math.floor(w / 2);
  // Both endpoints stay inside the middle band, 30%–70%. A downward drag that STARTS near the top
  // edge is the system gesture for the notification shade, not a scroll — the first run of this
  // script spent three iterations flinging the shade open and down over the app, and the frames it
  // measured were SystemUI's. Staying off both edges keeps the gesture inside the app.
  const yFrom = up ? Math.floor(h * 0.70) : Math.floor(h * 0.30);
  const yTo = up ? Math.floor(h * 0.30) : Math.floor(h * 0.70);
  return {
    actions: [{
      type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x, y: yFrom },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 50 },
        { type: 'pointerMove', duration: 120, x, y: yTo },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

/** A single tap, used only to navigate to the screen worth measuring. */
function tapAction(x, y) {
  return {
    actions: [{
      type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, x, y },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 60 },
        { type: 'pointerUp', button: 0 },
      ],
    }],
  };
}

const capabilities = {
  alwaysMatch: {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:newCommandTimeout': 300,
    'mfarm:region': REGION,
    ...(APP_APK ? { 'appium:app': APP_APK } : {}),
    ...(APP_PACKAGE ? { 'appium:appPackage': APP_PACKAGE } : {}),
    ...(APP_ACTIVITY ? { 'appium:appActivity': APP_ACTIVITY } : {}),
    // Attach to an app that is ALREADY installed, rather than reinstalling it.
    //
    // Deliberately NOT set when an APK is given. `noReset` alongside `appium:app` can leave the
    // driver deciding it has nothing to do and launching nothing at all — and this script would
    // then measure the launcher while reporting the app's package name, which is the single most
    // misleading thing it could do. When an APK is supplied, let the driver install and launch it.
    //
    // AND ON THIS FARM, `APP_APK` IS ALMOST ALWAYS THE RIGHT ANSWER. Devices reset by powerwash
    // (CF_RESET_MODE, ADR-0007), which is a factory reset: an APK pushed with `adb install` before
    // the run is GONE the moment the previous session was released. Pre-installing looks like it
    // works right up until the first reset, and then silently measures the launcher instead.
    //
    // OFF BY DEFAULT, opt in with APP_NO_RESET=1. With `noReset`, UiAutomator2 attaches to an app it
    // considers already running and does NOT start the activity — measured here on 2026-08-23, a
    // package-only session for `com.android.settings` sat on the launcher for the full 30s
    // foreground wait while Settings ran in the background. `am start` for the same component
    // foregrounded it instantly. A deterministic foreground is worth more to a measurement than
    // preserved app data.
    ...(APP_PACKAGE && !APP_APK && process.env.APP_NO_RESET === '1' ? { 'appium:noReset': true } : {}),
  },
  firstMatch: [{}],
};

async function main() {
  if (!KEY) {
    console.error('MFARM_API_KEY is required (deploy/.state/api_key after farm-up.sh)');
    return 2;
  }

  console.log(`hub        ${HUB}`);
  console.log(`region     ${REGION}`);
  console.log(`iterations ${ITERATIONS} x ${FLINGS} flings`);
  console.log(`app        ${APP_APK ?? APP_PACKAGE ?? '(foreground — wiring check only)'}\n`);

  let sessionId;
  let exitCode = 0;
  try {
    console.log('[setup] creating a session…');
    const created = await call('POST', '/session', { capabilities, desiredCapabilities: capabilities.alwaysMatch });
    sessionId = created.json?.value?.sessionId ?? created.json?.sessionId;
    const caps = created.json?.value?.capabilities ?? created.json?.value ?? {};
    if (!sessionId) throw new Error('no sessionId in response:\n' + created.text.slice(0, 1000));

    const serial = caps['appium:udid'] ?? caps.udid;
    if (!serial) throw new Error('session reported no udid — B3 regression; cannot address adb safely');
    console.log(`        session ${sessionId} on ${serial} (${created.ms}ms)`);

    // Screen size from the driver, so the flings land on the device's real geometry rather than a
    // hard-coded 1080x1920 that silently flings off-screen on a differently-shaped profile.
    const rect = (await call('GET', `/session/${sessionId}/window/rect`)).json?.value ?? {};
    const w = rect.width ?? 1080, h = rect.height ?? 1920;
    console.log(`        screen  ${w}x${h}`);

    // Whose frames are we counting? ASK THE DEVICE, never the capabilities. `appium:appPackage` is
    // what we requested; the foreground is what we got, and a driver that quietly declined to launch
    // makes those differ. Counting the launcher's frames under the app's name is the most
    // misleading output this script could produce, so it is checked rather than assumed.
    //
    // No pipe into grep here, deliberately: `adb shell` joins its arguments into one command string
    // without quoting, so a regex containing `|` is re-split by the DEVICE's shell — and a grep that
    // matches nothing exits non-zero, which would take the whole run down. Pull the text, match here.
    const readForeground = async () => {
      const focus = await adb(serial, 'shell', 'dumpsys', 'window');
      return /mCurrentFocus=[^}\n]*?\s([a-zA-Z][\w.]*)\/[\w.]+/.exec(focus)?.[1] ?? null;
    };

    // Wait for the app to actually reach the foreground, rather than sampling once and hoping.
    // A cold Flutter start on a software renderer is seconds, and the driver returns from `POST
    // /session` before the first frame.
    let foreground = null;
    for (let waited = 0; waited < 30_000; waited += 1_000) {
      foreground = await readForeground();
      if (!APP_PACKAGE || foreground === APP_PACKAGE) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    const pkg = APP_PACKAGE ?? foreground;
    if (!pkg) throw new Error('could not determine the foreground package from dumpsys window');
    console.log(`        package ${pkg}`);

    // FAIL WHEN THE FOREGROUND IS UNREADABLE, not just when it disagrees.
    //
    // The earlier version only threw when `foreground` was non-null AND different, so a focus it
    // could not parse skipped the check entirely and the run proceeded. That is exactly what
    // happened on the first run: focus was `Window{… NotificationShade}`, which has no
    // `package/activity` to match, so the guard saw null, stayed quiet, and three iterations
    // measured a notification shade. An unreadable foreground is not a pass.
    if (APP_PACKAGE && foreground !== APP_PACKAGE) {
      throw new Error(
        `asked for ${APP_PACKAGE} but the foreground is ${foreground ?? 'unreadable'} — the app did `
        + "not launch, and measuring anyway would attribute another process's frames to it");
    }
    if (!APP_APK && !APP_PACKAGE) {
      console.log('\n        NOTE: no app given, so this run measures whatever was already on screen.');
      console.log('        A launcher is not a rendering workload — treat the verdict as a wiring');
      console.log('        check and re-run with APP_APK=… APP_PACKAGE=… for a real answer.\n');
    }

    // Graphics mode, recorded beside the numbers. Without it the results are unattributable six weeks
    // later, and "was this the SwiftShader run or the gfxstream run?" is the only question that will
    // be asked of them.
    let renderer = '(unknown)';
    try {
      const sf = await adb(serial, 'shell', 'dumpsys', 'SurfaceFlinger');
      renderer = /GLES:\s*(.+)/.exec(sf)?.[1]?.trim() ?? renderer;
    } catch { /* a device that will not answer still produces valid frame counters */ }
    console.log(`        renderer ${renderer}\n`);

    // Navigate to the screen worth measuring, once, before any iteration.
    if (WARMUP_TAPS) {
      for (const point of WARMUP_TAPS.split(/\s+/)) {
        const [x, y] = point.split(',').map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bad WARMUP_TAPS point "${point}"`);
        await call('POST', `/session/${sessionId}/actions`, tapAction(x, y));
        await new Promise((r) => setTimeout(r, 1_500));
      }
      console.log(`        warmup  tapped ${WARMUP_TAPS}`);
    }

    /**
     * Read the compositor's frame table for this app.
     *
     * The layer is re-resolved every time. Its name carries a session id and a layer number
     * (`24e6b7c …#117`) that change when the app recreates its surface — on rotation, on a
     * navigation that swaps the SurfaceView, sometimes on resume. A cached name silently starts
     * returning an empty table, which reads as a flawlessly smooth device.
     *
     * The name also contains `[`, `]`, `(`, `)` and `#`, and `adb shell` passes its arguments to the
     * DEVICE's shell without quoting — unquoted, the device shell fails with
     * `syntax error: unexpected '('`. Hence the explicit single quotes. No layer name can contain a
     * single quote, so this is safe rather than merely convenient.
     */
    const sampleFrames = async () => {
      const candidates = layerCandidates(
        await adb(serial, 'shell', 'dumpsys', 'SurfaceFlinger', '--list'), pkg);
      let best = { layer: null, ...frameStats(null, []) };
      for (const layer of candidates) {
        const { refreshNs, presents } = parseLatency(
          await adb(serial, 'shell', `dumpsys SurfaceFlinger --latency '${layer}'`));
        const stats = { layer, refreshNs, ...frameStats(refreshNs, presents) };
        if (stats.frames > best.frames) best = stats;
      }
      return best;
    };

    const runs = [];
    for (let i = 1; i <= ITERATIONS; i++) {
      process.stdout.write(`[${i}/${ITERATIONS}] `);
      const gestureMs = [];
      let ok = true, failure = null, stats = {};
      try {
        // Clear the compositor's rolling buffer by reading it and discarding the result, so this
        // iteration's numbers cannot be inherited from the previous one.
        await sampleFrames();

        for (let f = 0; f < FLINGS; f++) {
          const started = Date.now();
          await call('POST', `/session/${sessionId}/actions`, flingAction(w, h, f % 2 === 0));
          gestureMs.push(Date.now() - started);
          // Let the gesture animate to a stop before the next one. Without the pause we would
          // measure back-to-back input handling and never the settle, and the settle is where a
          // software renderer falls behind.
          await new Promise((r) => setTimeout(r, 400));
        }

        // Immediately, while the frames are still in the buffer: `--latency` keeps only the last
        // 128 presented frames, and an idle Flutter app renders nothing, so waiting does not lose
        // the frames to overwriting — it loses them to the app going quiet.
        stats = await sampleFrames();
      } catch (e) {
        ok = false;
        failure = e.message + (e.detail ? `\n${e.detail}` : '');
      }

      // Too small a sample is NO DATA. Every wrong answer this script has produced so far looked
      // like a small, confident, excellent sample.
      const thin = ok && (stats.frames ?? 0) < MIN_FRAMES;
      runs.push({ ok, thin, failure, stats, gesture: summarise(gestureMs) });
      console.log(
        !ok ? `FAILED  ${failure?.split('\n')[0]}`
        : thin ? `NO DATA  only ${stats.frames ?? 0} frames presented (need ${MIN_FRAMES}) — nothing on screen was moving`
        : `ok  jank ${stats.jankPct?.toFixed(1)}%  ${stats.frames} frames  ${stats.fps?.toFixed(0)} fps  dropped ${stats.droppedFrames}  worst ${stats.worstMs?.toFixed(0)}ms  gesture p50 ${summarise(gestureMs).p50}ms`);
    }

    // ---------------------------------------------------------------- verdict

    // A "measured" iteration is one that both completed AND saw enough frames to mean anything.
    // Keeping those two ideas apart is the difference between "the automation is reliable" and
    // "the device renders well", which are separate findings that this run reports separately.
    const completed = runs.filter((r) => r.ok);
    const measured = completed.filter((r) => !r.thin);
    const passRate = (completed.length / runs.length) * 100;

    const jank = measured.map((r) => r.stats.jankPct).filter((v) => v !== null && v !== undefined);
    const worstJank = jank.length ? Math.max(...jank) : null;
    const meanJank = jank.length ? jank.reduce((a, b) => a + b, 0) / jank.length : null;
    const fps = measured.map((r) => r.stats.fps).filter(Boolean);
    const meanFps = fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : null;
    const dropped = measured.reduce((a, r) => a + (r.stats.droppedFrames ?? 0), 0);
    const worstFrame = measured.length ? Math.max(...measured.map((r) => r.stats.worstMs ?? 0)) : null;
    const spreads = completed.map((r) => r.gesture.spreadPct).filter((v) => v !== null);
    const worstSpread = spreads.length ? Math.max(...spreads) : null;

    console.log(`\n${'─'.repeat(72)}`);
    console.log(`renderer        ${renderer}`);
    console.log(`package         ${pkg}`);
    console.log(`completed       ${passRate.toFixed(0)}%  (${completed.length}/${runs.length} iterations ran to the end)`);
    console.log(`measured        ${measured.length}/${runs.length} iterations saw >= ${MIN_FRAMES} frames`);
    console.log(`frame rate      ${meanFps?.toFixed(0) ?? '—'} fps sustained during interaction`);
    console.log(`jank            mean ${meanJank?.toFixed(1) ?? '—'}%   worst ${worstJank?.toFixed(1) ?? '—'}%   budget ${JANK_BUDGET_PCT}%`);
    console.log(`dropped vsyncs  ${measured.length ? dropped : '—'}   worst single frame ${worstFrame?.toFixed(0) ?? '—'}ms  (16.7ms is one frame at 60Hz)`);
    console.log(`gesture spread  ${worstSpread?.toFixed(0) ?? '—'}%  (p95 over p50; a long tail is what a suite feels as a flaky timeout)`);
    console.log(`${'─'.repeat(72)}`);

    const problems = [];
    if (passRate < PASS_RATE_FLOOR_PCT) problems.push(`only ${passRate.toFixed(0)}% of iterations completed (floor ${PASS_RATE_FLOOR_PCT}%)`);
    if (worstJank !== null && worstJank > JANK_BUDGET_PCT) problems.push(`worst-iteration jank ${worstJank.toFixed(1)}% exceeds the ${JANK_BUDGET_PCT}% budget`);

    if (!APP_APK && !APP_PACKAGE) {
      console.log('\nINCONCLUSIVE by construction: no app was given, so this measured the foreground.');
      console.log('The harness works. Re-run against a real Flutter/RN build for a real answer.');
    } else if (!measured.length) {
      // The most important branch in the file. Refusing to answer is a result; inventing one is not.
      exitCode = 1;
      console.log('\nINCONCLUSIVE: no iteration presented enough frames to measure.');
      console.log('This is NOT a finding about the graphics mode — it means nothing on screen was');
      console.log('animating. Point WARMUP_TAPS at a screen that actually moves (a long list, a');
      console.log('canvas, a media view) and run again.');
    } else if (problems.length) {
      exitCode = 1;
      console.log('\nThis graphics mode is NOT sufficient for this app:');
      for (const p of problems) console.log(`  - ${p}`);
      console.log('\nThat is the evidence for gfxstream. Before spending it, re-run with ITERATIONS');
      console.log('raised — a single bad run is weather, a consistent one is climate.');
    } else {
      console.log('\nThis graphics mode IS sufficient for this app: every iteration completed and');
      console.log('jank stayed inside budget. A GPU would buy CPU headroom and therefore density —');
      console.log('not correctness — and §16 of the plan says density is not this phase.');
    }

    for (const [i, r] of runs.entries()) {
      if (!r.ok) console.log(`\n--- iteration ${i + 1} failure ---\n${r.failure}`);
    }
  } catch (e) {
    console.error(`\nFAILED after ${since()}: ${e.message}`);
    if (e.detail) console.error(e.detail);
    exitCode = 1;
  } finally {
    // Always. An orphaned session holds a device until the reaper's TTL, and on a two-device farm
    // that is half the fleet — the same invariant apps/cli/src/run.ts is built around.
    if (sessionId) {
      try {
        await call('DELETE', `/session/${sessionId}`);
        console.log(`\nsession released (${since()})`);
      } catch (e) { console.error(`\nWARNING: could not release the session: ${e.message}`); }
    }
  }
  return exitCode;
}

// Run only when invoked as a script. Imported (by the test below, or anything else), this file is
// just its parsers — which are the half worth testing without a farm attached.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
