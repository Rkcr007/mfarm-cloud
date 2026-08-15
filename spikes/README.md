# Week-0 Spikes

Two spikes decide whether the v2 positioning is reachable. Both have numeric pass/fail thresholds.
Neither can be run on a macOS laptop — see "Where these must run" below.

---

## Status

| Spike | Threshold | Status |
|---|---|---|
| 1 — Glass-to-glass latency | < 120 ms untuned, camera-measured | **BLOCKED** — needs Linux + KVM host, and a camera |
| 2a — Android density | ≥ 12 instances on a 128 GB box | **BLOCKED** — needs Linux + KVM host |
| 2b — iOS density | ≥ 6 simulators on a 24 GB Mac | **BLOCKED** — needs full Xcode |

### What *was* measured on 2026-08-15

Run on the dev laptop (Apple M1, 8 cores, **8 GB RAM**, macOS 15.6.1) using the Android Emulator
(AVD, `Pixel_3a_API_34 arm64-v8a`, headless, `-gpu swiftshader_indirect`). This is **not** the
reference hardware and these are **not** spike results — they are single-instance measurements that
validate or correct specific v2 assumptions.

| Measurement | Result | Bearing on v2 |
|---|---:|---|
| Cold boot → `sys.boot_completed` | **35.5 s** | Confirms the 30–60 s cold-boot assumption |
| Snapshot restore → `boot_completed` | **2.88 s** | Confirms the 1–3 s claim. **12.3× faster than cold boot** — the per-second billing premise holds |
| Snapshot save | 4.9 s, 983 MB on disk | Storage cost per snapshot is real; budget for it |
| `adb shell input tap` | **p50 121 ms, p95 418 ms, min 77 ms** | **Confirms L3, worse than estimated.** One tap exceeds the entire 100 ms budget |
| `adb shell true` (transport baseline) | p50 77 ms | The cost is the *shell round trip*, not the `input` binary |
| `adb shell getprop` (no binder call) | p50 57 ms | Floor for any per-call adb shell |
| Persistent shell + `input tap` | **p50 39 ms, p95 70 ms** | The fix works: 3.1× on p50, 6× on p95 — but 39 ms is still too much for the budget |
| Idle RSS (guest RAM 1536 MB) | 0.8–1.3 GB | Lower than the 2–4 GB assumed |
| Idle CPU, doing nothing | ~100% of one core — **but see the caveat below; this figure is unreliable** | Raises a question spike 2 now answers directly |

### Two corrections to `product_guide_v2.md` from these numbers

**1. `input` is not the problem — the shell round trip is.** On Android 34, `/system/bin/input` is a
one-line wrapper around `cmd input` (a binder call), not the old `app_process` JVM spawn. The 121 ms
decomposes as ~57–77 ms of adb-shell round trip plus ~44 ms of binder. So the rule is stronger and
simpler than v2 stated: **never do a per-event `adb shell` round trip at all**, regardless of which
command you run. Even a held shell costs 39 ms. Only an in-guest agent writing to the input layer
over a persistent socket (Cuttlefish's WebRTC data channel, scrcpy's control socket) is fast enough.

**2. CPU may bind density before RAM — but the measurement that suggested it was flawed.** v2's cost
model assumed RAM limits instances-per-box. The laptop run showed an *idle* emulator apparently
burning a full core while using only ~1 GB.

> **Caveat, and it is a big one.** That figure came from `ps -o pcpu`, which reports CPU **averaged
> over the process's entire lifetime**, not instantaneously. The emulator had just spent 35 seconds
> booting at high CPU, and that boot is permanently baked into the average. The real idle figure is
> very likely lower — possibly much lower. **Treat "an idle instance burns a core" as an open
> question, not a finding.**

`spike2_android_density.sh` now measures CPU correctly, by reading `/proc/<pid>/stat` jiffies and
taking a delta over a real 5-second window, and it resolves the question directly by ramping twice:

| Pass | Config | Represents |
|---|---|---|
| `interactive` | `--gpu_mode=guest_swiftshader`, WebRTC on | what a human session costs |
| `automated` | `--gpu_mode=none`, no WebRTC | what a CI run costs |

The script reports density for each, CPU per idle instance, and the ratio between them, then draws
the conclusion for you:

- **ratio ≥ 1.5** — idle rendering is a real cost. Extend v2's "no encoder unless a viewer is
  attached" rule to *rendering*, and price the automated tier separately. This is a live pricing lever.
- **ratio ≤ 1.15** — rendering is not the binding cost. The laptop CPU figure was the `pcpu` artifact
  described above. Drop the two-tier idea and keep one price.
- **in between** — re-run at a higher `MAX` before deciding.

Override the modes with `GPU_INTERACTIVE=` / `GPU_AUTOMATED=` if Cuttlefish on your image rejects
`none` (some builds require a display device to boot at all — if pass 2 fails to boot, that is itself
the answer: the automated tier is not available on that image).

> Note: the laptop was under memory pressure (8 GB, 34% free) throughout, so absolute latencies are
> pessimistic. The *ratios* — 12.3× boot, 3.1× input — are the durable findings.

---

## Where these must run

- **Spike 1 and 2a:** a Linux host with KVM (`/dev/kvm` present, user in the `kvm` group). Cuttlefish
  does not run on macOS at all — no KVM, no `cvd`. Bare metal, not a nested VM.
- **Spike 2b:** a Mac with **full Xcode**, not just Command Line Tools. This laptop has only CLT, so
  `simctl` is absent and no simulator can be booted.
- **Spike 1's authoritative measurement needs a camera.** See below — this is not optional.

---

## Running them

```bash
# On the Linux/KVM box
./spike1_latency.sh            # boots Cuttlefish with WebRTC, prints the URL
./spike2_android_density.sh    # ramps instances until the cliff, writes density.csv

# On a Mac with full Xcode
./spike2_ios_density.sh        # ramps simulators until the cliff, writes ios_density.csv
```

## Spike 1: how to measure honestly

`latency_probe.js` (paste into DevTools on the Cuttlefish WebRTC page) reports a **pipeline lower
bound** from `getStats()` and `requestVideoFrameCallback`. It is useful for tuning and useless as a
pass/fail number, because it cannot see capture-side delay or display latency.

**The authoritative measurement is the camera protocol:**

1. Open a millisecond stopwatch app on the virtual device.
2. Place the browser window showing the stream directly beside a second display showing the same
   stopwatch — or simply film the device's own reported time against the streamed frame.
3. Film both with a phone at 240 fps.
4. Step through the footage. Glass-to-glass = (time shown in the real stopwatch) − (time shown in the
   streamed frame), in the same video frame.
5. Take 20 samples. Report p50 and p95, not the best one.

Anything measured with `Date.now()` on either end measures your instrumentation, not your product.
