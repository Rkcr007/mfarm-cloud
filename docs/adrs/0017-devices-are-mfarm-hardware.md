---
id: ADR-0017
title: The devices are MFARM hardware, not imitations of somebody else's
status: Accepted
date: 2026-08-29
authors:
  - Claude Code
tags: [devices, cuttlefish, console, honesty, profiles, product]
supersedes: [ADR-0016]
extends: [ADR-0003]
---

## Context

ADR-0016 configured two virtual devices to reproduce **Samsung Galaxy S25 Ultra** and **Samsung
Galaxy S25** — panel, density, RAM, cores, and the guest build properties that make an app read
`Build.MODEL = "SM-S938B"` and `Build.MANUFACTURER = "samsung"`. It was shipped, hardware-verified,
and it worked as specified.

It was still the wrong product. `MFARM_PRODUCT_DIRECTION_AND_DEVELOPMENT_RESET.md` says so directly:
the farm competes on **experience** with BrowserStack, LambdaTest and Sauce Labs, and the device
identity, OS presentation and visual design belong to MFARM. The goal is that a user thinks *"this
feels like a real flagship Android phone"* — not that they are shown a counterfeit of a specific one.

Three things settled it, in the order they actually bite:

1. **The imitation could not be finished, and it made the farm worse at its real job.** A Samsung
   device is Samsung *firmware*. The competitor screenshots that prompted this prove it: their device
   logs carry `KnoxMUMContainerPolicy`, `SemWifiUsabilityStatsMonitor`, `EdmStorageProvider`,
   `vendor.samsung.hardware.thermal-service`. None of that exists on AOSP and none of it can be added
   by writing properties. So an app branching on `Build.MANUFACTURER === "samsung"` took a Samsung
   code path into a device that could not answer it, and failed for reasons that were **the farm's
   fault**. ADR-0016 recorded this as an accepted consequence. Under the new direction, where
   application testing is P0 and everything else is secondary, an accepted source of false failures
   in the app under test is not a trade worth making.

2. **It contradicted the ABI, and the name was the half that made it confusing.** `Build.MODEL` said
   SM-S938B while `Build.SUPPORTED_ABIS` said `x86_64` — a combination no handset has ever reported.
   The x86_64 wall is real either way; naming the device after an arm64 phone converted a *limitation*
   into a *contradiction*.

3. **It cost 60 seconds on every reset.** The properties lived in an overlayfs that `cvd powerwash`
   wipes, so every reset rewrote them and rebooted twice: ~100s against ~40s, measured. The
   counterfeit half was also the expensive half.

## Decision

**1. The devices are MFARM's own.** `mfarm-x1-pro` → *MFARM X1 Pro*, `mfarm-x1` → *MFARM X1*. These
are real devices this farm really provides, at a real geometry. Nothing about them is an imitation,
so nothing about them can be caught out.

**2. A profile configures a device; it never makes a claim about one.** `props`, `identityProps` and
the partition-scoped property expansion are deleted, along with `applyProfileProps()`,
`workers/agent/src/bin/profile-props.ts` and `deploy/apply-device-profile.sh`. A profile is now
geometry, density, diagonal, RAM and cores — every field of which is true of the device by
construction.

**This restores ADR-0003 rather than excepting it.** ADR-0016 made a deliberate exception to "a
capability is a claim about observed present state, not about configuration." That exception is
withdrawn. `model` is now configuration that is *accurate*, and there is nothing left that could
drift away from what the device is.

**3. Geometry, RAM and cores are unchanged.** 1080×2340 at 450 and 480 dpi — 384dp and 360dp. Those
numbers are measured (see below) and `--memory_mb`/`--cpus` only take effect on a cold boot, so
holding them makes this change a **re-registration rather than a rebuild of every instance**. The
direction document's larger RAM figures are a deliberate follow-up, gated on a recreate window.

**4. What a profile needs must be a BOOT FLAG, never a guest edit.** This is the general rule the
deleted code paid for. A guest edit has to be re-applied after every reset because this farm runs
`CF_RESET_MODE=powerwash`; a boot flag comes back out of cvd's instance database on its own.

**5. `cf-1` and `cf-2` remain unprofiled**, exactly as ADR-0016 left them, and the whole-argv
equality test that guarantees it is unchanged.

**6. The ABI preflight stays, and its justification changes.** ADR-0016 offered it as the counterweight
that made claiming a Samsung name defensible. The name is gone; the wall is not, because the wall was
never caused by the name. It now exists on its own merits — an arm64-only APK cannot run here, and
saying so in a sentence beats `INSTALL_FAILED_NO_MATCHING_ABIS`.

**7. The VIRTUAL DEVICE tag and the chrome toggle both stay.** They cost nothing and they remain
true.

## Consequences

- **Reset gets ~2.5× faster on profiled devices**: ~100s → ~40s, the same as an unprofiled one. The
  new test asserts a profiled and an unprofiled reset issue *identical* adb calls.
- **Apps stop taking Samsung code paths.** The class of failure ADR-0016 accepted is gone.
- **Every device re-registers.** `model` and `profile` are both in `capabilityFingerprint()`
  (HANDOFF 36), so the worker re-registers on restart and the rows correct themselves. No migration.
- **`CF_PROFILES` must be updated on any deployed farm.** A unit file still reading
  `cf-3=galaxy-s25-ultra` now **fails the agent at startup** rather than silently booting the device
  unprofiled at 720×1280 while the console shows an X1 Pro. That loudness is deliberate and is
  covered by a test.
- **Migration 027's comment is now stale** and is deliberately left alone: it is an applied migration
  and an accurate record of why the column was added at the time. This ADR is the correction.
- **The console's device art is renamed, not redesigned.** `DEVICE_CHROME` keys move to the new ids
  and the bodies are unchanged. Making them *good* is the console work the direction document calls
  for, and it is not this ADR.

## Alternatives considered

**Keep the Samsung profiles and add MFARM ones alongside.** Rejected: it keeps every cost — the false
failures, the ABI contradiction, the 60s reset — to preserve a capability the direction document
explicitly does not want.

**Keep the geometry work but revert the whole profile mechanism.** Rejected. The mechanism was never
the problem; it is what lets a device boot at a real dp width and be drawn correctly, and it is the
foundation the device catalogue is built on. Only the identity spoofing was wrong.

**Adopt the direction document's larger RAM and 120Hz figures now.** Rejected for this change.
120Hz is not representable — the render baseline is measured against 60Hz vsync and 120 would report
jank belonging to the software renderer rather than to the app, which the document's own rule ("do
not invent specifications the runtime cannot represent") forbids. Larger RAM is representable but
needs a cold boot of every instance, and bundling it would turn a re-registration into a rebuild.

**Name the devices after no one, e.g. `virtual-phone-a`.** Rejected: the product needs a device
catalogue a customer can choose from and refer to. "MFARM X1 Pro" is a name and a real thing; it just
is not somebody else's.
