/**
 * Device profiles — what a virtual device is configured to BE.
 *
 * A profile is a bundle of guest configuration: panel geometry, density, RAM and cores. `cf-3` and
 * `cf-4` boot from one; `cf-1` and `cf-2` deliberately do not, and a device with no profile takes
 * exactly the code path it took before this file existed (ADR-0017).
 *
 * EVERYTHING HERE IS TRUE OF THE DEVICE, and that is the change ADR-0017 made.
 *
 * This file used to carry a second half: `props`, a set of guest build properties that made the
 * device report `ro.product.model = SM-S938B` and `ro.product.manufacturer = samsung`. That was a
 * lie told to the app under test, and it is gone. What remains is honest by construction — the panel
 * really is 1080x2340, the guest really does render at that density, and a layout bug found at 384dp
 * is a real layout bug. Nothing here is a claim that could drift from reality, so nothing here
 * touches ADR-0003.
 *
 * WHY THE SPOOFING WENT, in the order the reasons actually bite:
 *
 *   1. It could not be finished. A Samsung device is Samsung FIRMWARE — Knox, the `Sem*` services,
 *      Samsung's HALs and IME. None of that exists on AOSP and none of it can be added by writing
 *      properties. So an app that branches on `Build.MANUFACTURER === "samsung"` took a Samsung code
 *      path into an AOSP device that could not answer it, and failed for reasons that were the
 *      farm's fault. The profile made the farm WORSE at its actual job.
 *   2. It contradicted the ABI. `Build.MODEL` said SM-S938B while `Build.SUPPORTED_ABIS` said
 *      x86_64, which no handset has ever reported. The identity was the half that made that
 *      combination confusing rather than merely limited.
 *   3. It cost 60 seconds on every reset. The properties live in an overlayfs that `cvd powerwash`
 *      wipes, so every reset had to rewrite them and reboot twice — ~100s against ~40s. The
 *      counterfeit half was also the expensive half.
 *
 * The device is MFARM's own now. An MFARM X1 Pro is a real thing this farm really provides, at a
 * real geometry, and it is not pretending to be a phone somebody else makes.
 *
 * WHAT IS STILL NOT SPOOFED, and never was: the OS version. The guest is whatever the pinned AOSP
 * build actually is, and `ro.build.version.*` is left alone.
 */

export interface DeviceProfile {
  /** Stable key. Travels to the control plane and keys the console's device art. Never displayed. */
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
}

/**
 * THE MFARM DEVICE FAMILY.
 *
 * Two devices separated by DENSITY rather than pixels — 384dp against 360dp on the same 1080x2340
 * panel. That is deliberate, and it is the axis that matters: dp is what a layout bug is expressed
 * in, and two devices with the same dp width differ in nothing a layout can see.
 *
 * THE PANEL IS FHD+ ON BOTH, AND THAT IS A MEASURED CHOICE. The Pro ran at QHD+ 1440x3120 @600 until
 * 2026-08-29, when a render A/B on the lab VM measured what that costs on SwiftShader. Same native
 * scroll, same host, HWUI's own counters:
 *
 *   720x1280  @320   50th 44ms   95th 57ms    99th 61ms    missed vsync 55
 *   1440x3120 @600   50th 65ms   95th 109ms   99th 650ms   missed vsync 127
 *   1080x2340 @480   50th 40ms   95th 53ms    99th 150ms   missed vsync 26
 *
 * 65ms at the median is ~15fps sustained during interaction, with a 650ms worst frame — every
 * timing-sensitive test flaky for reasons that are the farm's fault. FHD+ measured BETTER than the
 * 720p baseline on median, 95th and missed vsyncs, so it is not a climbdown; it is the fast option.
 * Revisit only with a GPU, and only with the A/B re-run rather than by assumption.
 *
 * RAM AND CORES ARE UNCHANGED FROM THE PROFILES THESE REPLACED, on purpose. Those numbers are
 * measured and working, and `--memory_mb` / `--cpus` only take effect on a COLD BOOT — so leaving
 * them alone makes the rename a re-registration rather than a rebuild of every instance. The
 * direction document's larger figures are a deliberate follow-up, gated on a recreate window.
 */
export const DEVICE_PROFILES: Record<string, DeviceProfile> = {
  'mfarm-x1-pro': {
    id: 'mfarm-x1-pro',
    model: 'MFARM X1 Pro',
    label: 'MFARM X1 Pro',
    // 1080 x 160 / 450 = 384dp wide — the roomier of the two layouts.
    screen: { width: 1080, height: 2340, density: 450 },
    diagonalIn: 6.7,
    memoryMb: 8192,
    cpus: 4,
  },

  'mfarm-x1': {
    id: 'mfarm-x1',
    model: 'MFARM X1',
    label: 'MFARM X1',
    // 1080 x 160 / 480 = 360dp wide — the width most Android phones actually report.
    screen: { width: 1080, height: 2340, density: 480 },
    diagonalIn: 6.5,
    memoryMb: 6144,
    cpus: 4,
  },
};

export function profileById(id: string | undefined): DeviceProfile | undefined {
  return id ? DEVICE_PROFILES[id] : undefined;
}

/**
 * Parse `CF_PROFILES` — `cf-3=mfarm-x1-pro,cf-4=mfarm-x1`.
 *
 * KEYED BY LOCAL ID, NOT POSITIONAL, and that is the whole reason the existing devices are safe. A
 * positional list (`,,mfarm-x1-pro,mfarm-x1`) makes cf-1's configuration depend on the ordering of a
 * string cf-1 is not mentioned in, so a typo three fields away silently re-profiles a working
 * device. Here, a local id that does not appear gets nothing, and nothing is exactly what it got
 * before this existed.
 *
 * An unknown profile id THROWS rather than being skipped. A silently-ignored typo would boot the
 * device at the default 720x1280 while every operator involved believed it was an X1 Pro — the kind
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
