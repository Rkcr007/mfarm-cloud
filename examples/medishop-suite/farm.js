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
 *
 * The device is ALLOCATED by `remote()` and RELEASED by `deleteSession()`. A suite that forgets the
 * second one holds a device until the lease expires, which on a two-device farm is half the fleet —
 * so `withDevice` below always releases, on every path.
 */

const HUB = new URL(process.env.MFARM_HUB ?? 'https://farm.mfarm.dev');
const KEY = process.env.MFARM_API_KEY;
const REGION = process.env.MFARM_REGION ?? 'lab';
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
      // Ship the build with the session. Devices are powerwashed between tenants, so anything
      // installed by hand beforehand is gone — the APK has to arrive with the session that uses it.
      ...(APP ? { 'appium:app': APP } : { 'appium:appPackage': PACKAGE }),
      'mfarm:region': REGION,
      'mfarm:queueTimeoutSeconds': 120,
    },
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
