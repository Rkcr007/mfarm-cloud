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

/**
 * Where adb is, resolved PER CALL rather than captured at module load.
 *
 * The constant form — `const ADB = process.env.ADB_PATH ?? …` — reads the environment once, when
 * the module is first imported. That is fine in production, where the environment is set before
 * node starts, and quietly wrong everywhere else: anything that sets `ADB_PATH` after import is
 * ignored with no error, which is a confusing enough failure to be worth the function call. It also
 * makes discovery testable without a phone, which is most of why these functions are separable at
 * all.
 */
function adbPath(): string {
  return process.env.ADB_PATH
    ?? (process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb');
}

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
    // Serial first, everything after it is the state plus optional descriptors.
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const serial = m[1];
    const rest = m[2];

    /**
     * The state is every token before the descriptors begin — and the descriptors are NOT all
     * `key:value`, which is what this used to assume.
     *
     * ON macOS ADB PRINTS THE USB PATH BARE. Linux gives `device usb:1-1 product:x`, so cutting at
     * the first `\w+:` left "device" and worked. Darwin gives `device 1-1 product:x`, with no
     * `usb:` prefix — so the cut happened at ` product:` instead, `stateText` became "device 1-1",
     * matched none of the known states, and the device was classified `unknown` and refused.
     *
     * The effect was total: on macOS NO physical Android device could ever enroll, whatever was
     * wrong or right with it, and the agent told the user their phone was in a state it did not
     * recognise while `adb devices` showed a perfectly ordinary `device`. Found the first time this
     * ran on a Mac, which is the machine ADR-0009's gate is written about.
     *
     * So stop at the first token that is a descriptor by SHAPE — one carrying a colon, or a bare
     * USB path — rather than by a pattern only one platform happens to produce.
     */
    const stateWords: string[] = [];
    for (const token of rest.split(/\s+/)) {
      if (token.includes(':')) break;          // usb:1-1, product:x, transport_id:1
      if (/^[\d][\d.-]*$/.test(token)) break;  // a bare USB path: `1-1` on macOS, `2.4.3` elsewhere
      stateWords.push(token);
    }
    const stateText = stateWords.join(' ').trim().toLowerCase();

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
  const dump = await run(adbPath(), ['-s', serial, 'shell', 'getprop'], 20_000);
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
    run(adbPath(), ['-s', serial, 'shell', 'wm', 'size'], 10_000),
    run(adbPath(), ['-s', serial, 'shell', 'wm', 'density'], 10_000),
  ]);
  const sizes = [...size.matchAll(/(\d+)x(\d+)/g)];
  if (sizes.length === 0) return undefined;
  const chosen = sizes[sizes.length - 1]; // override if present, physical otherwise
  const densities = [...density.matchAll(/(\d+)/g)];
  const d = densities.length > 0 ? Number(densities[densities.length - 1][0]) : 420;
  return { width: Number(chosen[1]), height: Number(chosen[2]), density: d };
}

/**
 * adb itself could not be asked — not installed, or its server refused to start, or the user's own
 * adb server was restarting underneath us.
 *
 * ITS OWN TYPE BECAUSE `[]` WAS AMBIGUOUS, and the ambiguity was a lie the window told. Returning an
 * empty list for this case makes "adb is broken" indistinguishable from "nothing is plugged in", so
 * a phone on the desk and a page saying *No devices yet — plug a phone in* could both be true at
 * once. That is precisely the support ticket this whole file exists to end.
 *
 * It happens for an ordinary reason, too: plugging in a phone can make the user's own adb server
 * restart, and one pass fails with `protocol fault (couldn't read status)` while it does. Observed
 * on hardware the first time somebody plugged a phone into a running agent.
 */
export class AdbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdbUnavailableError';
  }
}

/**
 * One discovery pass: what is plugged in, and what each one is.
 *
 * THROWS when adb could not be reached at all, and returns `[]` only when adb answered and there
 * was genuinely nothing there. Callers must tell those apart — see `AdbUnavailableError`.
 */
export async function discover(): Promise<DiscoveredDevice[]> {
  let stdout: string;
  try {
    stdout = await run(adbPath(), ['devices', '-l'], 20_000);
  } catch (e) {
    throw new AdbUnavailableError((e as Error).message);
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

/**
 * Watch USB for phones appearing, and call back when the usable set CHANGES (spec §6).
 *
 * WHY THIS IS A POLL AND NOT `adb track-devices`. The tracking socket is a lower-level protocol
 * that reports raw device states and requires speaking adb's own framing over a socket the server
 * owns — a second adb client implementation in this repo, to save a `adb devices -l` every ten
 * seconds. The poll costs one short-lived process per interval and reuses the exact parser that
 * discovery already has to have. If USB latency ever matters here, that trade is worth revisiting;
 * plugging in a phone is a human action measured in seconds, so today it is not.
 *
 * ONLY THE USABLE SET IS COMPARED. A phone sitting at `unauthorized` flips to `device` the moment
 * somebody taps Allow, and that IS an arrival — it is the most common one, in fact. Comparing every
 * state instead would fire on `offline` -> `unauthorized` churn from a failing cable, which is not
 * a fleet change and would restart the agent in a loop.
 */
export function watchForChanges(
  known: readonly string[],
  onChange: (added: string[], removed: string[]) => void,
  intervalMs = Number(process.env.PHYSICAL_DISCOVERY_INTERVAL_MS ?? 10_000),
  /**
   * How to look. Defaults to `discover`, and is a parameter so the change detection can be tested
   * against a scripted sequence of worlds instead of a scripted `adb` on PATH.
   *
   * That seam is worth naming because the alternative was tried and is worse: a fake adb has to be
   * a real executable in a real temp directory selected by a process-wide environment variable, so
   * the tests cannot run concurrently, they leak a directory if one fails, and a probe still in
   * flight when the directory is removed logs an alarming error from a test that has already
   * passed. None of that was testing this function.
   */
  probe: () => Promise<DiscoveredDevice[]> = discover,
  /**
   * Every pass's full result, whether or not the usable set changed.
   *
   * `onChange` above is deliberately narrow — it fires only on an arrival or a departure, because
   * its caller drains and restarts the agent and must not do that over cable churn. The window
   * needs the opposite: the WHOLE list, including the phone sitting at `unauthorized` that
   * `onChange` is right to ignore, on every tick, so a row can update the moment somebody taps
   * Allow.
   *
   * A second caller rather than a second poller. `discover()` spawns adb several times, and a
   * window that ran its own timer would double that load on the USB stack — which on a bad day is
   * the thing being diagnosed.
   */
  onPass?: (found: DiscoveredDevice[]) => void,
): { stop: () => void } {
  let current = new Set(known);
  let stopped = false;
  /**
   * One pass at a time.
   *
   * `discover()` spawns adb several times and a slow or wedged USB stack can make one pass outlast
   * the interval. Without this guard the next timer tick starts a second pass over the same
   * hardware, both finish out of order, and `current` is updated by whichever lost — so a steady
   * fleet can report a phantom arrival, which drains and restarts the agent. Rare at a ten-second
   * interval and not rare at all on the box where adb is already unhappy, which is the worst
   * possible time to start bouncing the host.
   */
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await pass();
    } finally {
      inFlight = false;
    }
  };

  const pass = async (): Promise<void> => {
    if (stopped) return;
    let found: DiscoveredDevice[];
    try {
      found = await probe();
    } catch (e) {
      // adb hiccupped. Returning without touching `current` means the next tick compares against
      // the same baseline — a transient failure must not read as "every phone was unplugged".
      //
      // AND WITHOUT CALLING `onPass`, which is the same rule applied to the window: the last good
      // picture is a better answer than a blank one, because a blank one says "no phone here" about
      // a phone that is sitting right there. One line, not a stack — this runs on a timer.
      console.error(`[discovery] adb did not answer: ${(e as Error).message}`);
      return;
    }
    // Before the change comparison and outside it: a pass that finds nothing new still carries a
    // state a person is waiting on, and a throw from a listener must not skip the fleet update.
    if (onPass) {
      try { onPass(found); } catch (e) { console.error(`[discovery] pass listener threw: ${(e as Error).message}`); }
    }
    const usable = new Set(found.filter((d) => d.state === 'device').map((d) => d.serial));
    const added = [...usable].filter((s) => !current.has(s));
    const removed = [...current].filter((s) => !usable.has(s));
    if (added.length === 0 && removed.length === 0) return;
    current = usable;
    onChange(added, removed);
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
