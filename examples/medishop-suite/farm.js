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
