// Drive one real WebDriver session end to end, through every hop the product actually has.
//
// WHY THIS EXISTS. `npm test` proves 352 things against fakes. It cannot prove the one thing that
// matters: that the hub, the signed grant, the worker's automation gateway, a real Appium 2 with
// UiAutomator2, and a real Cuttlefish device agree with each other. Every one of those hops has
// only ever spoken to something written to answer correctly. This is milestone M3.
//
// The path exercised, in order:
//
//   this script --> POST /wd/hub/session          apps/api/src/http/routes/webdriver.ts
//               --> allocate_device()             Postgres, atomically with the session
//               --> Ed25519 grant, 2 min          apps/api/src/tokens.ts
//               --> /automation/<localId>/session workers/agent/src/gateway.ts (verifies offline)
//               --> 127.0.0.1 Appium              workers/agent/src/appium.ts
//               --> adb -s <serial>               the device
//
// Zero dependencies on purpose — a WebDriver client would hide exactly the layer being tested, and
// installing one on the box is another thing to go wrong. This speaks the wire protocol.
//
// ON FAILURE it prints the full request and response. That is deliberate: HANDOFF.md's standing
// instruction for this step is to capture the exact exchange rather than work around it on a
// metered box, because a disagreement here is a repo bug worth fixing properly.
//
//   MFARM_API_KEY=mfk_... node deploy/verify-webdriver.mjs
//   MFARM_API_KEY=mfk_... HUB=http://127.0.0.1:3000 REGION=lab node deploy/verify-webdriver.mjs

const HUB = process.env.HUB ?? 'http://127.0.0.1:3000';
const REGION = process.env.REGION ?? 'lab';
const KEY = process.env.MFARM_API_KEY;
if (!KEY) {
  console.error('MFARM_API_KEY is required (deploy/.state/api_key after farm-up.sh)');
  process.exit(2);
}

// The hub takes tenant credentials as HTTP Basic, because a URL is the only thing a WebDriver client
// is ever given. The password half carries an existing session id when there is one; here there is
// not, so the hub allocates and owns the lifecycle (`hub_allocated`), and DELETE releases the
// device. That is the plain path — `mfarm run` uses the bound one.
const basic = 'Basic ' + Buffer.from(`${KEY}:`).toString('base64');

let failed = false;
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
  const ms = Date.now() - started;
  if (!res.ok) {
    console.error(`\n--- FAILED ${method} ${url}  (${res.status}, ${ms}ms, ${since()} in) ---`);
    if (body) console.error('request body:\n' + JSON.stringify(body, null, 2));
    console.error('response headers: ' + JSON.stringify(Object.fromEntries(res.headers), null, 2));
    console.error('response body:\n' + text.slice(0, 4000));
    console.error('--- end ---\n');
    failed = true;
    return { res, json, text, ms };
  }
  return { res, json, text, ms };
}

// A deliberately ordinary session. Nothing here is mfarm-specific except `mfarm:region` — the whole
// adoption claim is that an existing suite changes one URL and adds one capability.
const capabilities = {
  alwaysMatch: {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:newCommandTimeout': 120,
    'mfarm:region': REGION,
  },
  firstMatch: [{}],
};

console.log(`hub    ${HUB}`);
console.log(`region ${REGION}`);
console.log(`key    ${KEY.slice(0, 12)}…\n`);

console.log('[1/5] creating a session (allocates a device, mints a grant, starts UiAutomator2)…');
const created = await call('POST', '/session', { capabilities, desiredCapabilities: capabilities.alwaysMatch });
if (failed) process.exit(1);

// W3C returns {value:{sessionId,capabilities}}; JSONWP returns {sessionId,value}. The hub serves
// both dialects, so read both rather than assuming which one came back.
const sessionId = created.json?.value?.sessionId ?? created.json?.sessionId;
const caps = created.json?.value?.capabilities ?? created.json?.value ?? {};
if (!sessionId) {
  console.error('no sessionId in the response:\n' + created.text.slice(0, 2000));
  process.exit(1);
}
console.log(`      ok in ${created.ms}ms — session ${sessionId}`);
console.log(`      udid        ${caps['appium:udid'] ?? caps.udid ?? '(none — B3 regression if blank)'}`);
console.log(`      deviceName  ${caps['appium:deviceName'] ?? caps.deviceName ?? '?'}`);
console.log(`      platform    ${caps.platformName ?? '?'} ${caps['appium:platformVersion'] ?? caps.platformVersion ?? ''}`);

let exitCode = 0;
try {
  console.log('\n[2/5] reading the page source (proves adb reaches a booted device)…');
  const source = await call('GET', `/session/${sessionId}/source`);
  if (!failed) {
    const xml = source.json?.value ?? '';
    console.log(`      ok in ${source.ms}ms — ${xml.length} bytes of hierarchy`);
    const pkg = /package="([^"]+)"/.exec(xml)?.[1];
    console.log(`      foreground package ${pkg ?? '(none parsed)'}`);
  }

  console.log('\n[3/5] taking a screenshot (proves the display pipeline, not just adb shell)…');
  const shot = await call('GET', `/session/${sessionId}/screenshot`);
  if (!failed) {
    const b64 = shot.json?.value ?? '';
    const bytes = Buffer.from(b64, 'base64');
    const isPng = bytes.subarray(1, 4).toString() === 'PNG';
    console.log(`      ok in ${shot.ms}ms — ${bytes.length} bytes, ${isPng ? 'valid PNG' : 'NOT A PNG'}`);
    if (!isPng) exitCode = 1;
  }

  console.log('\n[4/5] pressing HOME (proves the input path through the driver)…');
  const key = await call('POST', `/session/${sessionId}/appium/device/press_keycode`, { keycode: 3 });
  if (!failed) console.log(`      ok in ${key.ms}ms`);
} finally {
  // Always, including after a failure above: an orphaned session holds the device until the reaper
  // times it out, and on a two-device farm that is half the fleet.
  console.log('\n[5/5] deleting the session (releases the device, triggers snapshot reset)…');
  const gone = await call('DELETE', `/session/${sessionId}`);
  if (!failed) console.log(`      ok in ${gone.ms}ms`);
}

if (failed || exitCode) {
  console.error(`\nFAILED after ${since()}. Capture the exchange above verbatim — it is a repo bug, not something to work around here.`);
  process.exit(1);
}
console.log(`\nM3: a real WebDriver session drove a real Cuttlefish device end to end, in ${since()}.`);
