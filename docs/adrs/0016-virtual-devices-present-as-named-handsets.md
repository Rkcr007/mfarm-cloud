---
id: ADR-0016
title: Virtual devices present as named real handsets
status: Accepted
date: 2026-08-28
authors:
  - Claude Code
tags: [devices, cuttlefish, console, honesty, apk, profiles]
supersedes: []
extends: [ADR-0003, ADR-0008]
---

## Context

The farm's virtual devices boot at **720×1280 @ 320dpi** and register as `model: 'cuttlefish'`.
Nobody owns that phone. The console draws them in a deliberately generic bezel, and the CSS said why:
"a thin bezel, not a phone illustration … no speaker grille, no camera dot, no chrome pretending to
be hardware this farm does not have."

That was right while every device was a nameless rectangle. It has two costs that have become the
binding ones:

1. **A tester cannot tell what a result means.** 720×1280 at 320dpi is 360dp × 640dp — a 2013 phone.
   A layout that passes there says nothing about a layout on a 384dp panel with a punch-hole and a
   gesture bar, which is what the customer ships to.
2. **A prospect does not believe it.** The farm's whole claim is "test on the device you ship." A
   grey rectangle labelled `cuttlefish` is the moment that claim stops being felt.

The decision is to configure two devices to reproduce specific handsets — **Samsung Galaxy S25 Ultra**
and **Samsung Galaxy S25** — in panel geometry, density, RAM, cores and reported build identity, and
to draw them in the console as those phones.

This was a considered choice against a more conservative option, which was to match the geometry but
keep `model` honest and the chrome generic. It went the other way deliberately. What follows records
the cost of that, because the cost is real and is not visible from the code.

## Decision

**1. A profile is a bundle of guest configuration**, defined once in
`workers/agent/src/devices/profiles.ts`: panel, density, RAM, cores, and the build properties the
guest reports about itself.

**2. The profiled devices are NEW devices. `cf-1` and `cf-2` are not touched.** The farm goes from
two devices to four. A device with no profile produces a **byte-identical** cvd command line to the
one this codebase produced before profiles existed — asserted as a whole-string equality in
`cuttlefish.test.ts`, not as a subset match, so a flag added to the shared path fails the test rather
than silently re-configuring a working device.

`CF_PROFILES` is keyed by local id (`cf-3=galaxy-s25-ultra`), never positional. A positional list
makes `cf-1`'s configuration depend on the ordering of a string `cf-1` is not mentioned in.

**3. Geometry is honest; the model string is not, and the two are not the same kind of claim.**
The panel really is 1440×3120 — `coldBoot` passes those exact numbers to cvd, the console divides by
them to map a click, and a profile that lied here would make the device untappable. `ro.product.model`
is different in kind: an AOSP guest on x86_64 reporting `SM-S938B` is a **deliberate exception to
ADR-0003's rule that a claim is observed state, not configuration.**

**4. The exception is bounded by three counterweights.** They are the entire reason it is
defensible, and removing any one of them should take the Samsung name with it:

- **The console still tags every one of these `VIRTUAL DEVICE`.** The name and the tag appear
  together on the card, and a test asserts both in one breath.
- **`devices.profile` records that the model was configured rather than discovered.** Without it
  nothing distinguishes a name read off hardware from a name written into a config file.
- **The install preflight refuses an APK this device cannot execute** — see decision 6.

**5. The OS version is NOT spoofed.** `ro.build.version.*` stays whatever the AOSP image is. Telling
an app it is on Android 15 while it runs on 17 changes which API-level-conditional branch it takes,
so the app under test would exercise code that never runs on the device it claims to be. An
obviously-wrong version string is a smaller lie than a silently-wrong code path.

**6. A device publishes its ABIs and an install that cannot work is refused by name.** Cuttlefish
here is x86_64; every real Galaxy is arm64-v8a; most real APKs ship arm64-only native libraries.
Without this, the first customer upload dies inside `adb install` with
`INSTALL_FAILED_NO_MATCHING_ABIS` **on a device named after the exact phone they build for** — a
worse outcome than never having claimed the name.

The check's default is to ALLOW. An APK with no native code and a device that never reported its
ABIs both fall through to the old behaviour. It exists to turn one known-impossible install into a
clear sentence, not to be an authority on what can run.

**7. The console draws the body, and the punch-hole is allowed over the screen.** This reverses the
rule at `console.css` that nothing is drawn on top of the device screen. On a real Galaxy the camera
IS in the display, so a body that puts it in the bezel draws a phone nobody makes. It is bounded:
the cutout takes no pointer events, it is the only thing permitted over the video, and a toolbar
toggle removes all chrome so the status bar underneath is one click away. **Nothing else may cite
this as precedent** — the keyboard hint is still rendered outside the frame, for the reasons written
there.

Chrome is presentation-only and lives in `apps/api/public/profiles.js`. Geometry is drawn from the
device's own reported `screen` and never from that table. If the two disagree, the device is right.

## Consequences

**An app that branches on `Build.MANUFACTURER == "samsung"` will take a Samsung code path that AOSP
does not implement** — Knox, the Samsung IME, One UI APIs. Failures down that branch are the farm's
fault, not the app's. This is the first thing to check when a test passes on a real Samsung and fails
here, and it is the single largest ongoing cost of decision 3.

**Build properties may not survive a reset, and this is UNVERIFIED.** `adb remount` gives an
overlayfs whose backing store may live on `/data`, and the lab runs `CF_RESET_MODE=powerwash`, which
wipes `/data`. If they do not survive, every profiled device silently reverts to `Cuttlefish x86_64`
at the first reset, mid-session, with nothing in any log saying so. **Check this before relying on
the feature.** If it reverts, re-application moves from `deploy/apply-device-profile.sh` into
`powerwash()` in `cuttlefish.ts`.

**QHD+ may not be affordable.** `docs/RENDER_BASELINE.md` measured 60fps for ordinary UI at 720×1280
on SwiftShader with no GPU. 1440×3120 is ~4.9× the pixels through a software rasteriser. Keeping
`cf-1` makes this a same-host A/B rather than a comparison across two farm states. If the gate misses,
the Ultra profile drops to FHD+ 1080×2340 — which is how Samsung ships it anyway, since Ultra models
default to FHD+ with QHD+ as an opt-in.

**Guest RAM sets snapshot size roughly 1:1.** Today's 4.0 GB snapshot restores in 8s. Four devices at
these profiles is ~22 GB of snapshots on the host; check free disk before creating them, because a
snapshot that fails to write silently costs the `snapshot-reset` capability.

**Four devices is a concurrency question the farm has never answered.** SwiftShader rasterises on the
CPU, so four simultaneous live sessions contend on the lab VM's 16 vCPU in a way two never did.

**A profile only applies on cold boot.** `restoreSnapshot` and `restartExisting` pass no
device-configuration flags — configuration comes back out of cvd's instance database. Editing
`profiles.ts` does nothing to a device that already exists; it has to be created again, as a new
instance group, **never via `cvd reset`**.

**The specification numbers are from published sources, not read off a handset.** Density in
particular is worth confirming with `adb shell wm density` on a real device: Samsung ships a default
display-size setting that is not the panel's native ppi, and it is the shipped density that decides
dp — which is what layout bugs are expressed in.

## Alternatives considered

**Keep `model` honest and label the card "Galaxy S25 Ultra profile."** Would have preserved ADR-0003
without exception and cost nothing technically. Rejected as a product decision: the demo impact of
the real name was judged to outweigh the honesty cost, given the three counterweights in decision 4.
This is the alternative to revisit first if the Samsung-code-path consequence above starts producing
false failures.

**Convert `cf-1` and `cf-2` rather than adding devices.** Rejected: they work, the render baseline
was measured on them, and converting would have required `cvd reset` — taking down the whole farm to
change devices nobody asked to change.

**Spoof the OS version too.** Rejected outright; see decision 5.
