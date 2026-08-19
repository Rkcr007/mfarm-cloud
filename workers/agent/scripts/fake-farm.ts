/**
 * A worker with FAKE devices, for demonstrating and developing everything that is not Android.
 *
 *   node --experimental-strip-types workers/agent/scripts/fake-farm.ts
 *
 * WHAT THIS IS FOR. Cuttlefish needs Linux and /dev/kvm, which rules out every Mac and most
 * laptops, and the AVD tier needs an Android SDK and several gigabytes free. Meanwhile the entire
 * control plane, console, app library and job pipeline are substrate-agnostic — so requiring real
 * hardware to click through them was costing an hour of setup to test a button.
 *
 * This registers a host with two devices that answer every DeviceControl call by recording it. The
 * console then behaves exactly as it does against a real farm: devices appear, a session allocates,
 * an install queues, a heartbeat collects it, and the outcome comes back through
 * `POST /v1/workers/events`.
 *
 * WHAT IT IS NOT. It is not a device. Nothing here runs an APK, and `installApp` is a log line —
 * so a build that would fail on a real device succeeds here. Its honesty is in the capabilities it
 * declares: no `screen-stream` and no `webdriver`, because there is nothing to stream and no Appium,
 * and a fake that claimed either would let someone demonstrate a feature that does not work.
 *
 * The devices are named `fake-1` and `fake-2` and the model reads `FAKE (no Android)`, so nobody
 * mistakes a screenshot of this for a screenshot of the farm.
 *
 * IT DOES RUN A REAL DATA PLANE (ADR-0007). The socket, the offline grant verification, the fence
 * check, the input queue and the logcat stream are the production code paths, unmodified — what is
 * fake is only the device behind them. So a console developed against this exercises the viewer's
 * whole protocol and gets an honest refusal at exactly the one point where a fake cannot follow: it
 * declares no `screen-stream` and provides no `media.signal`, so `signal-open` is answered with the
 * reason rather than with a black rectangle.
 */
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { Agent } from '../src/agent.ts';
import { DataPlane } from '../src/dataplane.ts';
import type { DeviceBackend, DeviceControl, DeviceHealth, DeviceInfo, LogcatHandle } from '../src/device.ts';

const CONTROL_PLANE = process.env.MFARM_API_URL ?? 'http://127.0.0.1:3000';
const REGION = process.env.MFARM_REGION ?? 'lab';
const REGISTRATION_TOKEN = process.env.WORKER_REGISTRATION_TOKEN ?? 'dev-registration-token';
const DEVICE_COUNT = Number(process.env.FAKE_DEVICES ?? 2);
/** Fast by default: the point of the fake farm is to watch a job move, not to wait for a beat. */
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 3000);

class FakeDevice implements DeviceControl {
  readonly info: DeviceInfo;
  private installedPackages = new Set<string>();
  /** Whoever is watching this device's log right now. See `captureLogcat`. */
  private watchers = new Set<(line: string) => void>();

  constructor(localId: string) {
    this.info = {
      localId,
      platform: 'android',
      tier: 'cuttlefish',
      model: 'FAKE (no Android)',
      osVersion: '17',
      // Honest to the point of being unhelpful, deliberately. `snapshot-reset` and
      // `input-datachannel` are required for a device to be schedulable at all, and `app-install`
      // is what this exists to exercise. `screen-stream` and `webdriver` are ABSENT because there
      // is no stream and no Appium — claiming them would make the console offer buttons that
      // cannot work, which is the exact failure the capability system exists to prevent.
      capabilities: ['input-datachannel', 'snapshot-reset', 'app-install', 'logcat'],
      screen: { width: 720, height: 1280, density: 320 },
      adbSerial: `fake:${localId}`,
    };
  }

  async start() { log(this, 'started'); }
  async stop() { log(this, 'stopped'); }

  async resetToSnapshot() {
    // The one behaviour worth modelling faithfully: a reset removes installed apps, which is why
    // releasing a device in the console makes an installed build disappear.
    this.installedPackages.clear();
    log(this, 'restored to snapshot — installed apps are gone');
  }

  async installApp(apkPath: string) {
    const size = await stat(apkPath).then((s) => s.size).catch(() => 0);
    log(this, `install ${apkPath} (${size} bytes) — NOT actually installed, this is a fake device`);
    this.installedPackages.add(apkPath);
  }

  async launchApp(packageName: string) { log(this, `launch ${packageName}`); }
  async uninstallApp(packageName: string) { log(this, `uninstall ${packageName}`); }

  async tap(x: number, y: number) { log(this, `tap ${x},${y}`); }
  async swipe(x1: number, y1: number, x2: number, y2: number, d: number) { log(this, `swipe ${x1},${y1}->${x2},${y2} ${d}ms`); }
  async key(name: string) { log(this, `key ${name}`); }
  async text(v: string) { log(this, `text ${v.length} chars`); }
  async health(): Promise<DeviceHealth> { return { status: 'healthy', inputLatencyMs: 1 }; }

  /**
   * This device's log, which is a real log OF A FAKE DEVICE.
   *
   * The distinction is the whole reason `logcat` may honestly stay in the capability list. Nothing
   * here invents Android output — no ActivityManager lines, no PackageManager lines, nothing that
   * would let someone mistake this for a device booting. What it streams is exactly what this class
   * already records: the calls it received. Every line says FAKE.
   */
  async captureLogcat(onLine: (line: string) => void): Promise<LogcatHandle> {
    this.watchers.add(onLine);
    onLine(this.line('logcat attached — these are this fake device\'s own records, not Android'));
    return { stop: () => { this.watchers.delete(onLine); } };
  }

  private line(message: string): string {
    // `-v threadtime` shaped, because that is what the console's parser splits on and a second
    // format here would only be testing the fallback path.
    const t = new Date().toISOString().slice(5, 23).replace('T', ' ');
    return `${t}     0     0 I FAKE    : ${message}`;
  }

  /** Called by `log()` below, so every recorded call also reaches anyone watching the log. */
  emit(message: string): void {
    for (const w of this.watchers) w(this.line(message));
  }
}

function log(d: DeviceControl, message: string): void {
  console.log(`  [${d.info.localId}] ${message}`);
  (d as FakeDevice).emit?.(message);
}

const backends: DeviceBackend[] = Array.from({ length: DEVICE_COUNT }, (_, i) => ({
  control: new FakeDevice(`fake-${i + 1}`),
  // null, not a plausible-looking url: `dataplane.ts` reports this to the browser verbatim, and a
  // fake endpoint would produce a viewer that fails at connect time instead of a UI that says
  // there is nothing to view.
  media: { async endpoint() { return null; } },
}));

const agent = new Agent({
  controlPlaneUrl: CONTROL_PLANE,
  registrationToken: REGISTRATION_TOKEN,
  hostname: process.env.FAKE_HOSTNAME ?? `fake-farm-${randomUUID().slice(0, 8)}`,
  region: REGION,
  // Reported to the control plane as where a browser would connect for input. Nothing listens
  // there in this script — there is no input to deliver to a device that does not exist.
  endpoint: 'ws://127.0.0.1:8080',
  devices: backends,
  statePath: process.env.FAKE_STATE ?? `${process.env.HOME}/.mfarm/fake-farm-state.json`,
  appCacheDir: process.env.FAKE_APP_CACHE ?? `${process.env.HOME}/.mfarm/fake-apps`,
  cores: 8,
  memoryMb: 16384,
});

console.log(`fake farm -> ${CONTROL_PLANE} (region ${REGION}, ${DEVICE_COUNT} device(s))`);
console.log('THESE ARE NOT REAL DEVICES. Nothing here runs an APK.\n');

const state = await agent.start();
console.log(`registered as host ${state.hostId}`);
for (const b of backends) await b.control.start();

/**
 * The data plane, on the port the registration above advertises.
 *
 * Not a stub. This is `DataPlane` itself, so a console connecting here goes through the same
 * Ed25519 verification, the same audience check and the same fence check it will go through against
 * a real farm — which is the half of the viewer most worth exercising without hardware.
 */
const byUuid = new Map(
  backends
    .map((b) => [agent.deviceIdFor(b.control.info.localId), b] as const)
    .filter((pair): pair is readonly [string, DeviceBackend] => Boolean(pair[0])),
);
const dataPlane = new DataPlane({
  agent,
  backends: new Map(backends.map((b) => [b.control.info.localId, b])),
  resolveDevice: (uuid) => byUuid.get(uuid) ?? (backends.length === 1 ? backends[0] : undefined),
});
const dpPort = await dataPlane.listen(Number(process.env.FAKE_DATA_PLANE_PORT ?? 8080), '127.0.0.1');
console.log(`data plane on ws://127.0.0.1:${dpPort} — real protocol, fake device behind it`);

agent.startHeartbeat(HEARTBEAT_MS);
agent.startMetering(15_000);
console.log(`heartbeat every ${HEARTBEAT_MS}ms — jobs are collected on the beat. Ctrl-C to stop.\n`);

// The agent's own timers are unref'd on purpose — they must never be the reason a worker process
// refuses to exit — so nothing here holds the event loop open and node would return to the shell
// the moment this file finished. One ref'd timer is what makes this a daemon.
const keepAlive = setInterval(() => {}, 1 << 30);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\nshutting down');
    clearInterval(keepAlive);
    void agent.shutdown().finally(() => process.exit(0));
  });
}
