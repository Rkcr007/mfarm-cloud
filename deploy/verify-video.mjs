// Does a failed session actually leave a video a person can open?
//
// `deploy/measure-video-cost.mjs` proved the recorder is free for the guest. That is the ENGINEERING
// gate and it says nothing about the chain: allocation queues `video-start`, the beat delivers it,
// the worker starts `record_cvd`, the suite reports a failure, the reset offer carries `keepVideo`,
// the worker stops the recorder and uploads the `.webm`, and the console can seek it.
//
// EVERY LINK IN THAT CHAIN IS UNIT-TESTED AND THE CHAIN IS NOT. This repo's register says a defect
// leaves DEFECTS.md when it is verified on the deployed farm, not when CI is green — and the first
// real handset found six defects that 197 green tests could not. This is that check for S5.
//
//   MFARM_API_KEY=$(cat ~/mfarm/deploy/.state/api_key) node deploy/verify-video.mjs
//
// RUNS ON THE CONTROL PLANE, like verify-execution.mjs: it needs the hub on loopback and the API
// key that lives there, and it never touches the device host.
//
// It is self-cleaning — one session, one deliberate failure, released on every exit path — and it
// asserts on a KEPT recording, so it also leaves one behind on purpose. That artifact expires on
// VIDEO_RETENTION_HOURS like any other.

const HUB = process.env.HUB ?? 'http://127.0.0.1:3000';
const REGION = process.env.REGION ?? 'lab';
const KEY = process.env.MFARM_API_KEY;
if (!KEY) { console.error('MFARM_API_KEY is required'); process.exit(2); }

/** How long to drive the device before failing it, so the recording has something in it. */
const DRIVE_MS = Number(process.env.DRIVE_MS ?? 20_000);

const bearer = `Bearer ${KEY}`;
const RUN_ID = `verify-video-${Date.now()}`;

let passed = 0, failed = 0;
const ok   = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad  = (m) => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const say  = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const note = (m) => console.log(`  \x1b[33m·\x1b[0m ${m}`);
const check = (cond, m, detail = '') => (cond ? ok(m) : bad(`${m}${detail ? ` — ${detail}` : ''}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${HUB}${path}`, {
    ...init,
    headers: { authorization: bearer, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json; the caller decides */ }
  return { status: res.status, body, text, headers: res.headers };
}

async function until(label, fn, { timeoutMs = 90_000, everyMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) { note(`gave up waiting for ${label}`); return null; }
    await sleep(everyMs);
  }
}

let hubSession = null;

async function main() {
  say(`Opening a WebDriver session (run ${RUN_ID})`);
  const opened = await api('/wd/hub/session', {
    method: 'POST',
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          platformName: 'android',
          'appium:automationName': 'UiAutomator2',
          'mfarm:region': REGION,
          'mfarm:runId': RUN_ID,
        },
      },
    }),
  });
  if (opened.status !== 200) {
    bad(`could not open a session: ${opened.status} ${opened.text.slice(0, 300)}`);
    return;
  }
  hubSession = opened.body.value.sessionId;
  ok(`session ${hubSession} on a real device`);

  // ---------------------------------------------------------------- the recording is requested

  say('The control plane asks for a recording at allocation');

  /**
   * VISIBLE AS AN ACTION, not inferred from the artifact appearing later. If this is missing the
   * failure is `VIDEO_RECORDING` unset or the device not declaring `recording`, and both are
   * configuration — a check that only looked at the end would report "no video" for four different
   * causes and distinguish none of them.
   */
  const requested = await until('the video-start action to be queued', async () => {
    const r = await api(`/v1/sessions/${hubSession}/app-actions`);
    return (r.body?.actions ?? []).find((a) => a.kind === 'video-start') ?? null;
  }, { timeoutMs: 30_000 });
  check(Boolean(requested), 'a video-start action was queued for this session');
  // `id`, not `actionId`. The BEAT calls it `actionId` (that is the worker's protocol) and this
  // READ API calls it `id` — the first version printed "action undefined", which is exactly how
  // much a log line is worth when nobody checks it against the response it claims to be reading.
  if (requested) note(`action ${requested.id} is ${requested.state}`);

  const performed = await until('the worker to perform it', async () => {
    const r = await api(`/v1/sessions/${hubSession}/app-actions`);
    const a = (r.body?.actions ?? []).find((x) => x.kind === 'video-start');
    return a && a.state === 'DONE' ? a : null;
  }, { timeoutMs: 60_000 });
  check(Boolean(performed), 'the worker started the recorder', 'the action never reached DONE');

  // ---------------------------------------------------------------- give it something to record

  say(`Driving the device for ${Math.round(DRIVE_MS / 1000)}s so the recording is not empty`);
  const until_ = Date.now() + DRIVE_MS;
  while (Date.now() < until_) {
    // A screenshot round trip is the cheapest command that is guaranteed to exist on every device,
    // and it does not change what is on screen — which is fine: an idle Cuttlefish still publishes
    // its cached frame, and this is measuring the chain, not the picture.
    await api(`/wd/hub/session/${hubSession}/screenshot`).catch(() => {});
    await sleep(1500);
  }
  ok('the device was driven');

  // ---------------------------------------------------------------- fail it, on purpose

  say('Reporting a failure, which is what makes the recording worth keeping');
  const reported = await api(`/v1/sessions/${hubSession}/result`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'failed', name: 'verify-video', failure: 'deliberate failure, so the video is kept',
    }),
  });
  check(reported.status === 201, 'the failure was recorded', `status ${reported.status}`);

  // Quitting releases the device, which parks it in CLEANING — the only universal "a session ended"
  // signal the worker gets, and where the recorder is stopped and the artifact uploaded.
  await api(`/wd/hub/session/${hubSession}`, { method: 'DELETE' });
  ok('the session was released');

  // ---------------------------------------------------------------- the artifact

  say('The recording arrives as an artifact');

  /**
   * GENEROUS, because this waits on the beat AND on a powerwash. The worker collects on the reset
   * request, which arrives on the next ten-second heartbeat, and the upload follows the logcat and
   * the screenshot.
   */
  const video = await until('the video artifact', async () => {
    const r = await api(`/v1/sessions/${hubSession}/artifacts`);
    return (r.body?.artifacts ?? []).find((a) => a.kind === 'video') ?? null;
  }, { timeoutMs: 180_000 });

  if (!video) {
    bad('no video artifact was uploaded for a failed session');
    return;
  }
  ok(`video artifact ${video.id}, ${(video.sizeBytes / 1024).toFixed(0)} KB`);
  check(video.contentType === 'video/webm', 'it is typed as WebM', video.contentType);
  check(video.sizeBytes > 1024,
    'it contains more than an empty container',
    `${video.sizeBytes} bytes — an idle device with no display publishes ~110`);

  /**
   * THE ANCHOR, which is the whole difference between a video and a video you can use. Without it
   * the console can play the recording and cannot point at the moment the test went red.
   */
  const startedAt = video.context?.startedAt;
  check(Boolean(startedAt), 'it carries the start instant every seek is relative to');
  if (startedAt) {
    const result = await api(`/v1/sessions/${hubSession}/results`);
    const failure = (result.body?.results ?? []).find((r) => r.status === 'failed');
    if (failure?.reportedAt) {
      const offset = (Date.parse(failure.reportedAt) - Date.parse(startedAt)) / 1000;
      check(offset > 0 && offset < 600,
        `the failure locates inside the recording (${offset.toFixed(1)}s in)`,
        `${offset.toFixed(1)}s is outside any plausible session`);
    }
  }
  check(video.context?.partial !== true, 'the recording stopped cleanly');

  // ---------------------------------------------------------------- it is watchable

  say('A browser can actually play it');

  const whole = await fetch(`${HUB}/v1/artifacts/${video.id}/blob`, { headers: { authorization: bearer } });
  check(whole.status === 200, 'the blob downloads', `status ${whole.status}`);
  check(whole.headers.get('accept-ranges') === 'bytes',
    'range requests are advertised',
    'without this Chrome will not seek a <video> at all');

  const head = Buffer.from(await whole.arrayBuffer()).subarray(0, 4);
  // EBML magic. cvd writes Matroska through mkvmuxer, and a file that is not one plays nowhere —
  // which a size check alone would not notice.
  check(head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3,
    'the bytes are a real Matroska/WebM container',
    `starts with ${[...head].map((b) => b.toString(16)).join(' ')}`);

  const ranged = await fetch(`${HUB}/v1/artifacts/${video.id}/blob`, {
    headers: { authorization: bearer, range: 'bytes=0-99' },
  });
  check(ranged.status === 206, 'a range request is served as a 206', `status ${ranged.status}`);
  check(ranged.headers.get('content-range') === `bytes 0-99/${video.sizeBytes}`,
    'the content-range names the whole file',
    ranged.headers.get('content-range') ?? 'absent');
}

main()
  .catch((e) => bad(e.stack ?? e.message))
  .finally(async () => {
    if (hubSession) {
      await fetch(`${HUB}/wd/hub/session/${hubSession}`, {
        method: 'DELETE', headers: { authorization: bearer },
      }).catch(() => {});
    }
    console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
    process.exit(failed ? 1 : 0);
  });
