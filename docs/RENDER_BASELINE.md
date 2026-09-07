# Rendering baseline — what SwiftShader can and cannot test

Measured **2026-08-23** on the lab box (`mfarm-lab`, n2-standard-16, asia-south1-c), Cuttlefish
1.55.1, Android 17, `CF_RESET_MODE=powerwash`, via `deploy/verify-render.mjs`. Three workloads,
five iterations each, ten flings per iteration, driven through the real hub as real WebDriver
sessions.

Reproduce with `deploy/verify-render.mjs`; the harness is unit-tested in `deploy/verify-render.test.mjs`.

## The renderer under test

```
ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 16.0.0)), SwiftShader driver-5.0.0),
OpenGL ES 3.1 (ANGLE 2.1)
```

Worth noting for its own sake: the guest has **Vulkan 1.3 via SwiftShader**, so Flutter's Impeller
backend runs. The question was never "does it run" but "how well".

## Results

| Workload | Renderer path | fps | jank (mean / worst) | dropped vsyncs | worst frame | completed |
|---|---|---|---|---|---|---|
| Native list scroll (AOSP Settings) | HWUI | **60** | 8.0% / 17.5% | 27 | 50ms | 5/5 |
| Flutter list scroll (Saber settings) | Impeller → SurfaceView | **60** | 19.4% / 29.0% | 91 | 133ms | 5/5 |
| Flutter drawing canvas (Saber whiteboard) | Impeller → SurfaceView | **30** | 69.9% / 81.0% | 1847 | **1350ms** | 5/5 |

`jank` is the share of frame intervals longer than 1.5 refresh periods. The 5% budget the script
enforces is Play-vitals-strict for a *shipping consumer app*; for deciding whether a farm can run a
test suite it is deliberately conservative, and the fps and worst-frame columns matter more.

## What this means

**Ordinary UI runs fine, in both native and Flutter.** Lists, navigation, forms and transitions hold
a full 60fps. Flutter costs roughly 2.4× the jank of a native app on the same device and the same
gesture, and still holds 60fps with a 133ms worst case. That is comfortably good enough for
functional, navigation and regression testing.

**Continuous custom rendering collapses.** The drawing canvas halved the frame rate and produced
**1.35-second frozen frames**. Anything that paints every frame — a canvas, a game, a chart that
animates, a video surface, a heavy custom `CustomPainter`/`SurfaceView` — is not testable here in a
way that reflects real-device behaviour.

**The automation itself did not flake.** 15/15 iterations across all three workloads ran to
completion, and gesture wall-clock spread stayed at 18–45%. Poor rendering did NOT show up as
Appium failures. This matters: the risk is not that suites go red, it is that timing-sensitive
assertions and screenshot comparisons silently measure a device that is three frames behind.

## Consequence for the GPU decision

This does **not** on its own justify moving to `gfxstream` and a GPU host. It scopes the question:

- If the apps under test are ordinary UI — the common case — SwiftShader is adequate, and a GPU buys
  CPU headroom and therefore *density*, which `ChangeInArch.md` §16 says is not this phase.
- If an app under test paints continuously, SwiftShader is not adequate for it, and no amount of
  platform work changes that.

Re-run this against the actual app before spending anything. That is the whole point of the harness.

## Two host findings this work turned up

1. **The device host had no JDK and no Android build-tools.** Sessions naming an already-installed
   package worked; anything shipping its own APK (`appium:app`) failed at session creation, because
   UiAutomator2 needs `aapt2` for the manifest and `apksigner` for the signature. Fixed by
   `deploy/install-build-tools.sh`; `farm-up.sh` now warns when they are missing. **Appium caches
   the SDK layout at startup, so the worker must be restarted afterwards.**
2. **Powerwash reset wipes pre-installed APKs.** `adb install` before a run is gone the moment the
   previous session is released, so an APK must be installed *by the session* (`appium:app`). This
   is not a bug — it is what `CF_RESET_MODE=powerwash` means (ADR-0007) — but it silently turns a
   measurement into a measurement of the launcher.

## Three traps in the measurement itself

Recorded because each produced a confident, wrong, healthy-looking answer:

- **`dumpsys gfxinfo` cannot see Flutter.** Flutter renders into a SurfaceView and bypasses HWUI
  entirely, so gfxinfo reported `Total frames rendered: 1` for a foreground app after twelve seconds
  of use. Measure the compositor (`dumpsys SurfaceFlinger --latency`), which sees every layer.
- **With zero frames, gfxinfo prints every percentile as `4950ms`** — the top histogram bucket used
  as a not-a-number sentinel — beside a reassuring `Janky frames: 0 (0.00%)`. Read literally that is
  a perfect score attached to a 4.95-second frame.
- **Which layer holds the frames depends on how the app renders.** Flutter's frames are on the
  `(BLAST)` SurfaceView layer; a native app has no BLAST layer at all and its frames are on the
  `VRI-` (ViewRootImpl) child, while its window layer reports zero. Probe candidates, do not assume.

## Geometry A/B — what a bigger panel costs (2026-08-29)

Measured on the same lab box, same native workload (AOSP Settings, 28 swipes), HWUI's own counters
via `dumpsys gfxinfo`. Three devices differing only in panel, so the delta is geometry and nothing
else — which is the reason `cf-1` and `cf-2` were kept unprofiled rather than converted.

| Device | Panel | 50th | 95th | 99th | Missed vsync |
|---|---|---|---|---|---|
| cf-1 (unprofiled) | 720×1280 @320 | 44ms | 57ms | 61ms | 55 |
| cf-3 (X1 Pro, then QHD+) | 1440×3120 @600 | **65ms** | **109ms** | **650ms** | **127** |
| cf-4 (X1) | 1080×2340 @480 | 40ms | 53ms | 150ms | 26 |

> The devices were named *Samsung Galaxy S25 Ultra* / *S25* when these numbers were taken; they
> are *MFARM X1 Pro* / *X1* since ADR-0017. Only the names changed — the panels, densities and
> therefore every measurement below are the same devices.

**QHD+ does not hold.** 65ms at the median is roughly 15fps sustained during interaction, with a
650ms worst frame — on the farm's headline device. Every timing-sensitive test on
it would be flaky for reasons that are the farm's fault.

**FHD+ is free.** 1080×2340 measured BETTER than the 720×1280 baseline on median, 95th and missed
vsyncs. So the S25 Ultra profile moved to 1080×2340 @450 — which is also how Samsung ships it, with
QHD+ as an opt-in — and the two Samsung profiles are now separated by density rather than pixels:
384dp against 360dp. dp is what a layout bug is expressed in; pixel count is not.

Note these numbers are NOT comparable to the table above: different driver (adb `input swipe`
rather than WebDriver flings), different app, fewer samples. The A/B between rows is the finding;
the absolute values are not a re-baseline.

---

## What recording costs the thing it records (2026-09-07)

**This is the measurement `EXECUTION_MODEL.md` §4.4 ended by asking for, and the gate on video.**
§4.4 costed video and stopped with one thing unmeasured: *"what `screenrecord` actually costs on
this hardware, run against the Flutter canvas workload where there is least headroom. That is a
lab-hours experiment, not a design question."* `EXECUTION_ROADMAP.md` S5 then made video wait on it.

`deploy/measure-encode-cost.mjs` produces it. It imports `verify-render.mjs`'s own parsers rather
than reimplementing the arithmetic, drives the device with `adb shell input swipe`, and runs the two
arms **interleaved** so neither can be measuring the device warming up.

| Workload | arm | fps | jank | dropped | worst frame |
|---|---|---|---|---|---|
| Flutter canvas (Saber whiteboard) | nothing recording | **29.9** | 100% | 87 | 51ms |
| Flutter canvas | `screenrecord` running | **19.9** | 100% | 145 | 68ms |
| Native list (AOSP Settings) | nothing recording | 30.2 | 55.6% | 36 | 35ms |
| Native list | `screenrecord` running | 29.5 | **96.8%** | 87 | 54ms |

**The canvas loses a third of its frame rate: −33%.** Reproduced three times — sequentially,
interleaved, and again after the gesture coordinates were corrected — with a run-to-run spread of
0.2fps. It is not noise and it is not thermal drift.

**Ordinary UI keeps its frame rate and loses its smoothness.** −2.5% fps looks survivable and is the
wrong column to read: jank goes from 56% to 97% and **dropped frames multiply by 2.4**, with one
round of six collapsing to 21fps. This page's own warning is what that means — *"the risk is not red
suites, it is timing-sensitive assertions and screenshot comparisons silently reading a device three
frames behind"*. Doubling dropped frames is precisely that risk, arriving quietly.

**Jank saturates on the canvas and says nothing there.** At 30fps on a 60Hz panel every interval is
longer than 1.5 refresh periods, so both canvas arms read 100% and the column is uninformative.
fps, dropped frames and worst frame are the ones carrying the finding.

### The conclusion, and what it changes

**Guest-side H.264 encode is not available on Cuttlefish on this host.** Both `screenrecord` and
scrcpy encode *on the device*, so both are this measurement — which means the encoder
`workers/agent/src/devices/capture.ts` already runs for the live view is fine to point at a screen
somebody is watching, and not fine to run under a suite whose timing is being asserted.

That leaves S5 two honest paths, and the measurement chooses between them rather than leaving it
open:

1. **Record on the host** — §4.4's own first bullet, reusing the encode `cvd`'s WebRTC streamer
   already performs at 49–53fps. The farm's CPU does the work either way, but *outside* the guest,
   so it does not compete with the app under test for the same virtual cores. This does not exist
   yet and is the real S5.
2. **Ship video for physical devices only** — where the encoder is dedicated silicon on the phone
   and this host's CPU is not in the loop at all. Available immediately, and honest, but it is video
   for the part of the fleet that is currently not serving.

### Two caveats on these numbers

**The scroll rows are not comparable to the table at the top of this page.** That one measured 60fps
for a native list scroll driven by WebDriver flings; these are `adb input swipe` at 120ms, which is
a different gesture producing a different frame rate. **The A/B within each pair is the finding; the
absolute values are not a re-baseline** — the same caveat the geometry section above carries.

**The first run of this measured nothing at all** and said so. The gesture coordinates were written
for a 1080-wide phone and this farm's unprofiled devices are 720×1280, so the scroll ran from
y=1600 — entirely off-screen. The script reads `wm size` now. A harness that had silently reported
zero difference instead of "not enough frames to compare" would have sent this decision the wrong
way, which is the same class of false negative the `gfxinfo` note above describes.
