/**
 * Device profiles — what a virtual device is configured to LOOK LIKE.
 *
 * A profile is a bundle of guest configuration: panel geometry, density, RAM, cores, and the build
 * properties the guest reports about itself. `cf-3` and `cf-4` boot from one; `cf-1` and `cf-2`
 * deliberately do not, and a device with no profile takes exactly the code path it took before this
 * file existed (ADR-0016).
 *
 * WHAT A PROFILE IS AND IS NOT
 *
 * The geometry half is honest by construction: the panel really is 1440x3120, the guest really does
 * render at that density, and a layout bug found at 384dp is a real layout bug. Nothing here is a
 * claim about state that could drift from reality, so it does not touch ADR-0003.
 *
 * The `props` half IS a lie the guest tells the app under test, and it is a deliberate one made with
 * eyes open (ADR-0016). Two consequences a reader will eventually hit:
 *
 *   1. The ABI is still x86_64. `Build.MODEL` says SM-S938B and `Build.SUPPORTED_ABIS` says x86_64,
 *      which no real handset has ever reported. An arm64-only APK does not install here, and the
 *      preflight in `apps/api/src/apk.ts` exists to say so in those words rather than let it fail as
 *      a mystery on a device calling itself a Galaxy.
 *   2. An app that branches on `Build.MANUFACTURER === "samsung"` takes a Samsung code path — Knox,
 *      the Samsung IME, One UI APIs — that AOSP does not implement. Failures from that branch are
 *      the farm's fault, not the app's. This is the first place to look when a test passes on a real
 *      Samsung and fails here.
 *
 * WHAT IS DELIBERATELY NOT SPOOFED: the OS version. The guest is whatever the pinned AOSP build
 * actually is, and `ro.build.version.*` is left alone. Telling an app it is on Android 15 while it
 * runs on 17 changes which API-level-conditional branch it takes, so the app under test would be
 * exercising code that never runs on the device it claims to be — a false result in both directions,
 * which is worse than an obviously-wrong version string.
 */

export interface DeviceProfile {
  /** Stable key. Travels to the control plane and keys the console's bezel art. Never displayed. */
  id: string;
  /** `DeviceInfo.model`, and what the console shows as the device's name. */
  model: string;
  /** Marketing name, for docs and operator-facing messages. */
  label: string;
  screen: { width: number; height: number; density: number };
  /** Panel diagonal in inches. The console draws true physical scale from it. */
  diagonalIn: number;
  /** Guest RAM. Also sets snapshot size roughly 1:1 — see the note in cuttlefish.ts. */
  memoryMb: number;
  cpus: number;
  /** Guest build properties, applied by `deploy/apply-device-profile.sh`. */
  props: Record<string, string>;
}

/**
 * Partitions Android composes `ro.product.model` from, in the order `ro.product.property_source_order`
 * usually lists them.
 *
 * Setting the bare `ro.product.model` alone is NOT enough and is the mistake to avoid here: since
 * Android 10 the bare properties are derived, and a getprop that still shows `Cuttlefish x86_64`
 * after an edit almost always means only the legacy key was written.
 */
const PARTITIONS = ['system', 'system_ext', 'product', 'vendor', 'odm'] as const;

interface Identity {
  brand: string;
  manufacturer: string;
  model: string;
  /** Codename, e.g. `e3q`. Cosmetic here; almost nothing an app does reads it. */
  device: string;
  name: string;
  fingerprint: string;
}

/** Expand one identity into every property Android actually consults. */
function identityProps(id: Identity): Record<string, string> {
  const out: Record<string, string> = {};
  const fields = {
    brand: id.brand, manufacturer: id.manufacturer, model: id.model,
    device: id.device, name: id.name,
  };
  for (const [field, value] of Object.entries(fields)) {
    // The legacy bare key, still read by older apps and by some analytics SDKs.
    out[`ro.product.${field}`] = value;
    for (const part of PARTITIONS) out[`ro.product.${part}.${field}`] = value;
  }
  out['ro.build.fingerprint'] = id.fingerprint;
  out['ro.vendor.build.fingerprint'] = id.fingerprint;
  out['ro.system.build.fingerprint'] = id.fingerprint;
  return out;
}

/**
 * THE NUMBERS BELOW ARE FROM PUBLISHED SPECIFICATIONS AND HAVE NOT BEEN READ OFF A HANDSET.
 *
 * Panel and diagonal are straightforward. The two worth checking against a real device with
 * `adb shell wm density` before anyone trusts a layout result are:
 *
 *   - `density`, because Samsung ships a default display-size setting that is NOT the panel's native
 *     ppi, and it is the SHIPPED density that decides dp — which is what actually finds layout bugs.
 *     The values here are chosen so the dp width lands where a real device lands:
 *       Ultra  1440 x 160 / 600 = 384dp
 *       S25    1080 x 160 / 480 = 360dp
 *   - `device` / `name` codenames and the fingerprint build ids, which are plausible rather than
 *     verified. Nothing functional reads them; they are here so a fingerprint is not obviously
 *     malformed.
 *
 * Both profiles run at FHD+ 1080x2340, which is what Samsung ships on both. QHD+ was tried on the
 * Ultra and measured too expensive on SwiftShader — the numbers and the reasoning are on that
 * profile's `screen` field. What separates the two devices is DENSITY, not pixels: 384dp against
 * 360dp, which is the difference a layout actually sees.
 */
export const DEVICE_PROFILES: Record<string, DeviceProfile> = {
  'galaxy-s25-ultra': {
    id: 'galaxy-s25-ultra',
    model: 'Samsung Galaxy S25 Ultra',
    label: 'Galaxy S25 Ultra',
    // FHD+ AT THE ULTRA'S DENSITY — measured, and it is how the phone actually ships.
    //
    // This profile was QHD+ 1440x3120 @ 600 until 2026-08-29, when the render A/B on the lab VM
    // measured what that costs on SwiftShader. Same native scroll, same host, HWUI's own counters:
    //
    //   720x1280  @320   50th 44ms   95th 57ms    99th 61ms    missed vsync 55
    //   1440x3120 @600   50th 65ms   95th 109ms   99th 650ms   missed vsync 127
    //   1080x2340 @480   50th 40ms   95th 53ms    99th 150ms   missed vsync 26
    //
    // 65ms at the median is ~15fps sustained during interaction, with a 650ms worst frame. A
    // "Galaxy S25 Ultra" that scrolls like that is less convincing than an honest 720p device at
    // 60, and it would make every timing-sensitive test flaky for reasons that are the farm's fault.
    //
    // FHD+ is not a climbdown. Samsung SHIPS Ultra models defaulting to FHD+ with QHD+ as an opt-in,
    // so this is the out-of-box device. And the thing that actually distinguishes it from the plain
    // S25 survives, because that was never the pixel count:
    //
    //   Ultra  1080 x 160 / 450 = 384dp wide
    //   S25    1080 x 160 / 480 = 360dp wide
    //
    // Same panel, different density, different dp — and dp is what layout bugs are expressed in.
    // The 1080x2340 row above was measured on a real profiled device and beat the 720p baseline.
    screen: { width: 1080, height: 2340, density: 450 },
    diagonalIn: 6.9,
    memoryMb: 8192,
    cpus: 4,
    props: identityProps({
      brand: 'samsung',
      manufacturer: 'samsung',
      model: 'SM-S938B',
      device: 'pa3q',
      name: 'pa3qxxx',
      fingerprint: 'samsung/pa3qxxx/pa3q:15/AP3A.240905.015.A2/S938BXXU1AYA1:user/release-keys',
    }),
  },

  'galaxy-s25': {
    id: 'galaxy-s25',
    model: 'Samsung Galaxy S25',
    label: 'Galaxy S25',
    screen: { width: 1080, height: 2340, density: 480 },
    diagonalIn: 6.2,
    memoryMb: 6144,
    cpus: 4,
    props: identityProps({
      brand: 'samsung',
      manufacturer: 'samsung',
      model: 'SM-S931B',
      device: 'pa1q',
      name: 'pa1qxxx',
      fingerprint: 'samsung/pa1qxxx/pa1q:15/AP3A.240905.015.A2/S931BXXU1AYA1:user/release-keys',
    }),
  },
};

export function profileById(id: string | undefined): DeviceProfile | undefined {
  return id ? DEVICE_PROFILES[id] : undefined;
}

/**
 * Parse `CF_PROFILES` — `cf-3=galaxy-s25-ultra,cf-4=galaxy-s25`.
 *
 * KEYED BY LOCAL ID, NOT POSITIONAL, and that is the whole reason the existing devices are safe. A
 * positional list (`,,galaxy-s25-ultra,galaxy-s25`) makes cf-1's configuration depend on the
 * ordering of a string cf-1 is not mentioned in, so a typo three fields away silently re-profiles a
 * working device. Here, a local id that does not appear gets nothing, and nothing is exactly what it
 * got before this existed.
 *
 * An unknown profile id THROWS rather than being skipped. A silently-ignored typo would boot the
 * device at the default 720x1280 while every operator involved believed it was a Galaxy — the kind
 * of mismatch that is only discovered by someone puzzling over a screenshot.
 */
export function parseProfileAssignments(spec: string | undefined): Map<string, DeviceProfile> {
  const out = new Map<string, DeviceProfile>();
  for (const entry of (spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    if (eq < 1) {
      throw new Error(`CF_PROFILES entry "${entry}" is not <localId>=<profileId>`);
    }
    const localId = entry.slice(0, eq).trim();
    const profileId = entry.slice(eq + 1).trim();
    const profile = DEVICE_PROFILES[profileId];
    if (!profile) {
      throw new Error(
        `CF_PROFILES names unknown profile "${profileId}" for ${localId}; known: ${Object.keys(DEVICE_PROFILES).join(', ')}`,
      );
    }
    out.set(localId, profile);
  }
  return out;
}
