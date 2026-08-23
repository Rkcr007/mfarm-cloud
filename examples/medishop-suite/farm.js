import { remote } from 'webdriverio';

/**
 * Connect a stock Appium client to the farm.
 *
 * THIS FILE IS THE WHOLE ADOPTION CLAIM. Everything else in this suite is ordinary WebdriverIO that
 * would run against a local emulator unchanged; this is the part that points it at MFARM, and it is
 * a hostname, a credential and one extra capability.
 *
 *   hostname   the farm, instead of 127.0.0.1
 *   user       your API key — the hub takes it as HTTP Basic, because a URL is the only thing some
 *              clients let you configure. `MFARM_WEBDRIVER_URL` embeds it the same way.
 *   mfarm:region   which pool to allocate from. The allocator picks the device; there is no way to
 *              ask for a specific one, so nothing here pretends otherwise.
 *   mfarm:appId    which build to put on the device, named from the farm's app library rather than
 *              by a path on the host it happens to run on.
 *   mfarm:runId    which RUN these sessions belong to. Eight tests otherwise arrive as eight
 *              unrelated device leases; with this they are one row in the console's Runs screen,
 *              and "what happened on build 4471" is a question with an answer.
 *
 * The device is ALLOCATED by `remote()` and RELEASED by `deleteSession()`. A suite that forgets the
 * second one holds a device until the lease expires, which on a two-device farm is half the fleet —
 * so `withDevice` below always releases, on every path.
 */

const HUB = new URL(process.env.MFARM_HUB ?? 'https://farm.mfarm.dev');
const KEY = process.env.MFARM_API_KEY;
const REGION = process.env.MFARM_REGION ?? 'lab';
/** A build in the farm's app library: an id, `com.example.app@1.4.2`, or `com.example.app@latest`. */
const APP_ID = process.env.MEDISHOP_APP_ID;
/**
 * The id of this run, from whatever the CI system already calls it.
 *
 * Nothing has to be created first and nothing has to be cleaned up: the farm creates the run when
 * the first session names it and every later session joins it. Locally there is usually no such
 * variable, and that is fine — a session with no run id simply belongs to no run.
 */
const RUN_ID = process.env.MFARM_RUN_ID ?? process.env.GITHUB_RUN_ID;
/** A path on the DEVICE HOST. Works, and is why the library exists — see `appCapabilities` below. */
const APP = process.env.MEDISHOP_APK;

if (!KEY) throw new Error('MFARM_API_KEY is required. Mint one in the console under Settings → API keys.');

export const CREDENTIALS = { email: 'trainer@way2automation.com', password: 'way2automation' };
export const PACKAGE = 'com.way2automation.medishop';

export function connect() {
  return remote({
    protocol: HUB.protocol.replace(':', ''),
    hostname: HUB.hostname,
    port: HUB.port ? Number(HUB.port) : (HUB.protocol === 'https:' ? 443 : 80),
    path: '/wd/hub',
    /**
     * The credential as an explicit header, NOT WebdriverIO's `user` / `key`.
     *
     * Those two only become an Authorization header for hostnames WebdriverIO recognises as cloud
     * providers — point them at your own hub and they are silently dropped, and the farm answers
     * "Missing or invalid credentials" for a request that looked correct. Worth knowing before
     * spending an afternoon on it.
     *
     * The shape is the one the hub documents: the API key is the username and the password half
     * stays empty, which is also what `https://<key>@host/wd/hub` produces.
     */
    headers: { authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}` },
    logLevel: 'error',
    // A device is a shared resource: waiting a couple of minutes for one to free up is normal and
    // failing instantly is not. `mfarm:queueTimeoutSeconds` is what turns `no_capacity` into a queue.
    connectionRetryTimeout: 180_000,
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:newCommandTimeout': 300,
      'appium:autoGrantPermissions': true,
      ...appCapabilities(),
      'mfarm:region': REGION,
      'mfarm:queueTimeoutSeconds': 120,
      // Spread rather than set, because an undefined capability value is still a key, and the hub
      // refuses a `mfarm:runId` that is not a non-empty string. Omitting it is the local case.
      ...(RUN_ID ? { 'mfarm:runId': String(RUN_ID) } : {}),
    },
  });
}

/**
 * Where the app under test comes from. Three answers, best first.
 *
 * Devices are POWERWASHED between tenants, so anything installed by hand beforehand is gone before
 * your suite starts. The build has to arrive with the session that uses it, one way or another.
 *
 *   mfarm:appId    the app library. Upload once (`POST /v1/apps`, or `mfarm app upload`), then name
 *                  the build — by id for a pinned run, or `com.example.app@latest` for a nightly.
 *                  The farm installs it before the session opens. Nothing in your CI needs to be
 *                  able to reach the device host, which is the point.
 *   appium:app     a path on the DEVICE HOST. Fine for a fixed demo app that somebody put there by
 *                  hand; useless for a build that changes every commit.
 *   appPackage     nothing is installed at all — for an app already baked into the device image.
 *
 * The two app forms are mutually exclusive and the hub says so rather than picking one, so this
 * prefers the library and never sends both.
 */
function appCapabilities() {
  if (APP_ID) return { 'mfarm:appId': APP_ID };
  if (APP) return { 'appium:app': APP };
  return { 'appium:appPackage': PACKAGE };
}

/**
 * Tell the farm how a test went.
 *
 * THE FARM CANNOT WORK THIS OUT. WebDriver has no concept of an assertion: the hub watches a
 * session open, drive a device and close, and that looks identical whether every test passed or
 * every one failed. So this call is not a nicety on top of something the farm already knows — it is
 * the entire mechanism, and a run that never calls it shows "Not reported" rather than a green tick.
 *
 * The session id is `driver.sessionId`, and it is deliberately the SAME id the farm uses: the hub
 * hands back its own session id rather than Appium's, so one id spans the test log, the API, the
 * artifact index and the invoice. No correlation step, no bookkeeping.
 *
 * Failures here are SWALLOWED, and that is a real decision rather than laziness. This runs inside
 * the suite's own error path; a farm that is briefly unreachable must not convert a red test into a
 * confusing crash inside the reporter, nor a green one into a failure. The result is telemetry, and
 * telemetry that can break the build is worse than telemetry you sometimes lose.
 */
export async function reportResult(driver, { name, status, failure, durationMs }) {
  const sessionId = driver?.sessionId;
  if (!sessionId) return;
  try {
    const res = await fetch(`${HUB.origin}/v1/sessions/${sessionId}/result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        status,
        // Bounded here as well as server-side. The server truncates and says so; sending 5 MB of
        // stack over a metered link to have it cut is just waste.
        ...(failure ? { failure: String(failure).slice(0, 8000) } : {}),
        ...(Number.isFinite(durationMs) ? { durationMs: Math.round(durationMs) } : {}),
      }),
    });
    if (!res.ok && process.env.MFARM_DEBUG) {
      console.error(`mfarm: reporting "${name}" failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    if (process.env.MFARM_DEBUG) console.error(`mfarm: reporting "${name}" failed: ${err.message}`);
  }
}

/**
 * `test()`, plus the one line that tells the farm what happened.
 *
 * A wrapper rather than an `afterEach` because `node:test` does not hand a hook the outcome of the
 * test that just ran. Runners that DO — WebdriverIO's `afterTest(test, ctx, { passed, error,
 * duration })` is the common one — want the hook form instead, and the README shows it: there the
 * whole integration really is one line.
 *
 * The error is re-thrown untouched. A reporter that changes whether the suite fails is a reporter
 * nobody can trust.
 */
export function farmTest(getDriver, test) {
  return (name, fn) => test(name, async (t) => {
    const startedAt = Date.now();
    try {
      const out = await fn(t);
      await reportResult(getDriver(), { name, status: 'passed', durationMs: Date.now() - startedAt });
      return out;
    } catch (err) {
      await reportResult(getDriver(), {
        name, status: 'failed', durationMs: Date.now() - startedAt,
        failure: err?.stack || String(err),
      });
      throw err;
    }
  });
}

/**
 * Run `fn` against a device, and give the device back whatever happens.
 *
 * On failure it captures a screenshot FIRST, before anything unwinds — the farm takes its own
 * screenshot when the device is released, but by then Appium has already force-stopped the app, so
 * that one shows the launcher. The failure state only exists right here.
 */
export async function withDevice(fn) {
  const driver = await connect();
  try {
    return await fn(driver);
  } catch (err) {
    try {
      const shot = await driver.takeScreenshot();
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir('artifacts', { recursive: true });
      const name = `artifacts/failure-${Date.now()}.png`;
      await writeFile(name, Buffer.from(shot, 'base64'));
      console.error(`\n  screenshot of the failure: ${name}`);
    } catch { /* a device that cannot answer must not mask the real error */ }
    throw err;
  } finally {
    await driver.deleteSession().catch(() => {});
  }
}
