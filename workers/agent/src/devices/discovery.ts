import { execFile } from 'node:child_process';
import type { Screen } from '../device.ts';

/**
 * Which phones are on this machine's USB right now (spec §6).
 *
 * WHY THIS IS A SEPARATE FILE FROM `physical.ts`. A `PhysicalDevice` is one handset and knows
 * nothing about the others; this knows the set and nothing about driving any of them. Keeping them
 * apart is what lets discovery be tested without a phone, and it is the seam where a future
 * `WirelessAdbConnection` (§9) plugs in — `adb devices` already lists a Wi-Fi target the same way,
 * so the connection kind is a property of the serial, not a second discovery mechanism.
 *
 * WHAT `adb devices` ACTUALLY RETURNS, because the states are the whole design here:
 *
 *   <serial>  device        usable
 *   <serial>  unauthorized  plugged in, but nobody has tapped "Allow USB debugging" on the screen
 *   <serial>  offline       adb sees it and cannot talk to it — mid-reboot, or a bad cable
 *   <serial>  no permissions  the host's udev rules do not let this user open the USB device
 *
 * Only `device` is usable, and the other three are the ones a person can FIX — which is why they
 * are reported rather than filtered away. A phone that is plugged in and missing from the console
 * with no explanation is the single most common physical-farm support ticket, and every one of
 * these states has a specific instruction attached to it.
 */

const ADB = process.env.ADB_PATH ?? (process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb');

export type AdbState = 'device' | 'unauthorized' | 'offline' | 'no permissions' | 'unknown';

export interface DiscoveredDevice {
  serial: string;
  state: AdbState;
  /** Present only for `state: 'device'` — the others cannot answer `getprop`. */
  props?: DeviceProps;
  /** What a person should do about a device that is not usable. Absent when it is. */
  remedy?: string;
}

export interface DeviceProps {
  model?: string;
  manufacturer?: string;
  osVersion?: string;
  sdkVersion?: number;
  screen?: Screen;
}

function run(bin: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${bin} ${args.join(' ')}: ${stderr.trim() || err.message}`));
      resolve(stdout.trim());
    });
  });
}

/**
 * The instruction that actually unblocks each unusable state.
 *
 * Written as something a person can DO, not as a restatement of the state. "unauthorized" tells
 * someone nothing; "unlock the phone and tap Allow" tells them where to walk.
 */
function remedyFor(state: AdbState): string | undefined {
  switch (state) {
    case 'device':
      return undefined;
    case 'unauthorized':
      return 'Unlock the phone and tap "Allow USB debugging" (tick "Always allow from this computer").';
    case 'offline':
      return 'The device is not responding to adb — it may be rebooting or on a failing cable. Replug it, and try a different cable before anything else.';
    case 'no permissions':
      return 'This user cannot open the USB device. Install udev rules for the vendor and re-plug, or add the user to the plugdev group.';
    default:
      return 'adb reported a state this agent does not recognise. Run `adb devices -l` on the host to see it.';
  }
}

/**
 * Parse `adb devices -l`. Exported for tests — the states above are the contract, and a parser that
 * quietly reclassifies one of them is how a plugged-in phone goes missing.
 */
export function parseAdbDevices(stdout: string): DiscoveredDevice[] {
  const out: DiscoveredDevice[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    // The header, blank lines, and adb's own startup chatter ("* daemon started successfully").
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;

    // `no permissions` contains a space, so splitting on whitespace and taking [1] mislabels it.
    // Serial first, everything after it is the state plus optional `key:value` descriptors.
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const serial = m[1];
    const rest = m[2];
    // Descriptors like `usb:1-1 product:x model:Pixel_9` follow the state; cut at the first of them.
    const stateText = rest.split(/\s+\w+:/)[0].trim().toLowerCase();

    let state: AdbState;
    if (stateText === 'device') state = 'device';
    else if (stateText === 'unauthorized') state = 'unauthorized';
    else if (stateText === 'offline') state = 'offline';
    else if (stateText.startsWith('no permissions')) state = 'no permissions';
    else state = 'unknown';

    out.push({ serial, state, remedy: remedyFor(state) });
  }
  return out;
}

/**
 * Read the metadata the console shows and the device model needs (spec §4, §22).
 *
 * ONE `getprop` CALL, not six. Each adb round trip over USB is tens of milliseconds and this runs
 * for every device on every discovery pass; six calls per phone across four phones is most of a
 * second spent re-reading values that change when the OS is updated, which is to say never.
 *
 * Every field is optional on purpose — §4: "Do NOT assume every field is available on every
 * device." An OEM that omits `ro.product.manufacturer` must still enroll.
 */
export async function readProps(serial: string): Promise<DeviceProps> {
  const dump = await run(ADB, ['-s', serial, 'shell', 'getprop'], 20_000);
  // getprop prints `[key]: [value]`, one per line.
  const props = new Map<string, string>();
  for (const line of dump.split('\n')) {
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]$/.exec(line.trim());
    if (m) props.set(m[1], m[2]);
  }
  const sdkRaw = props.get('ro.build.version.sdk');
  const sdkVersion = sdkRaw && /^\d+$/.test(sdkRaw) ? Number(sdkRaw) : undefined;

  return {
    model: props.get('ro.product.model') || undefined,
    manufacturer: props.get('ro.product.manufacturer') || undefined,
    osVersion: props.get('ro.build.version.release') || undefined,
    sdkVersion,
    screen: await readScreen(serial).catch(() => undefined),
  };
}

/**
 * Physical resolution and density.
 *
 * `wm size` reports "Physical size: 1080x2400" and, when an app or the user has overridden it, an
 * additional "Override size:" line. The OVERRIDE is what is actually on screen, so it wins — a
 * console that maps a click against the physical size while the device renders at an override puts
 * every tap in the wrong place.
 */
async function readScreen(serial: string): Promise<Screen | undefined> {
  const [size, density] = await Promise.all([
    run(ADB, ['-s', serial, 'shell', 'wm', 'size'], 10_000),
    run(ADB, ['-s', serial, 'shell', 'wm', 'density'], 10_000),
  ]);
  const sizes = [...size.matchAll(/(\d+)x(\d+)/g)];
  if (sizes.length === 0) return undefined;
  const chosen = sizes[sizes.length - 1]; // override if present, physical otherwise
  const densities = [...density.matchAll(/(\d+)/g)];
  const d = densities.length > 0 ? Number(densities[densities.length - 1][0]) : 420;
  return { width: Number(chosen[1]), height: Number(chosen[2]), density: d };
}

/** One discovery pass: what is plugged in, and what each one is. */
export async function discover(): Promise<DiscoveredDevice[]> {
  let stdout: string;
  try {
    stdout = await run(ADB, ['devices', '-l'], 20_000);
  } catch (e) {
    // adb not installed, or its server refused to start. One line, not a stack: this runs on a
    // timer and a crash loop would bury everything else in the log.
    console.error(`[discovery] adb unavailable: ${(e as Error).message}`);
    return [];
  }

  const found = parseAdbDevices(stdout);
  for (const d of found) {
    if (d.state !== 'device') continue;
    try {
      d.props = await readProps(d.serial);
    } catch (e) {
      // It was `device` a moment ago and is not answering now — a cable pulled mid-pass. Treat it
      // as offline for this round rather than enrolling a device with no metadata.
      d.state = 'offline';
      d.remedy = remedyFor('offline');
      console.warn(`[discovery] ${d.serial} stopped answering during discovery: ${(e as Error).message}`);
    }
  }
  return found;
}

/**
 * A stable, human-readable local id for a handset.
 *
 * `localId` is the name the control plane, the metering rows and the gateway path use, so it must
 * be stable across a replug and across an agent restart — which rules out an index (`phone-1`
 * becomes a different phone when someone unplugs the first one) and rules out anything random.
 *
 * The serial is stable and unique, so it is the identity. It is only lightly cleaned: adb serials
 * are alphanumeric in practice, but a Wi-Fi target is `10.0.0.4:5555`, and a colon in a gateway
 * path segment is a percent-encoding question nobody should have to think about.
 */
export function localIdForSerial(serial: string): string {
  return `phone-${serial.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}
