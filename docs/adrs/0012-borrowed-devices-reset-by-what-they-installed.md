---
id: ADR-0012
title: A borrowed phone is reset by undoing what the session installed, never by sweeping the owner's apps
status: Accepted
date: 2026-08-26
authors:
  - Claude Code
tags: [physical-devices, safety, tenancy, reset, agent, byo]
supersedes: []
extends: [ADR-0008, ADR-0009]
---

## Context

ADR-0008 gave a physical handset a reset: `resetToSnapshot` runs `pm clear` on every package
`pm list packages -3` returns, minus a keep list. It is named after the interface method, and its own
comment is careful to say what it is not — the device declares `session-reset`, never
`snapshot-reset`, and is pinned to one org for exactly that reason.

That design is correct for the fleet it was written about: a phone bought to sit in a farm, on a
powered hub, owned by the company running the tests. `pm list packages -3` on such a device returns
almost nothing.

**ADR-0009 then changed who owns the phone.** Its gate is "a person who has never seen MFARM, on a
machine we do not control, plugs in a phone" — a tester's own handset, borrowed for an afternoon.
On that device the same code is a different act.

Phase 0 measured it on 2026-08-26, on the first handset ever enrolled. `pm list packages -3`
returned **134 packages**: `net.one97.paytm`, `in.gov.uidai.facerd`, `com.Slack`, `com.ubercab`,
banking, authenticators, everything. `pm clear` on that list logs the owner out of all of it, and
nothing about it is recoverable.

Three findings from that run make this an ADR rather than a bug:

1. **The destructive path runs on the unhappy path first.** A session that FAILS still allocates a
   device and still releases it, and release resets. Two Play-Protect failures each fired a reset
   before any session had ever succeeded. The wipe does not wait for the product to work.
2. **The only guardrail was an environment variable, set by the wrong person.**
   `PHYSICAL_KEEP_PACKAGES` is opt-**out**, lives on the agent's command line, and is typed by an
   operator. The person whose data is at risk is the device's owner, who never sees it.
3. **The probe that checks the guardrail did not read it.** `deploy/verify-physical.mjs` filtered
   only the hardcoded `NEVER_CLEAR` while printing "are not on the keep list", so an operator who
   set the variable and re-ran the probe to confirm was told it had done nothing. Fixed in the same
   session, and it is the reason this ADR does not leave safety to a flag: a flag needs a checker,
   and the checker was wrong for as long as the flag existed.

A default that is safe only when somebody remembers a variable is not a safe default. On a borrowed
phone the failure is unrecoverable, un-undoable, and lands on someone who never ran a command.

## Decision

**Reset scope is a property of the device, it defaults to undoing only what the session installed,
and the sweep is something the device's owner opts into after being shown what it would clear.**

### 1. Two modes, named for what they do

| Mode | What a release does | Default for |
|---|---|---|
| `install-scoped` | Uninstalls exactly the packages this session installed, in reverse order, then HOME | **Every device, always, unless changed** |
| `full-sweep` | Today's behaviour: `pm clear` across third-party packages minus the keep list | A device whose owner has explicitly chosen it |

The agent keeps a **session install ledger**: `installApp` records the package it landed, and
release undoes that list. Nothing else on the phone is touched.

Uninstall rather than `pm clear`, and the difference matters here: the session installed the app, so
removing it returns the phone to the state it was lent in. `pm clear` would leave the tester's APK
sitting on somebody's home screen after they unplugged.

**The inversion also fixes finding 1 for free.** A session that failed before installing anything
has an empty ledger, so its release resets nothing. The destructive path stops being the one that
runs first.

### 2. Installing over an app the owner already has is refused, not resolved

If a session installs a package that was already present, the ledger cannot undo it: uninstalling
takes the owner's copy and their data, and there is no version to put back.

**On an `install-scoped` device this install is refused and the session fails**, naming the package
and saying that the owner must either remove their copy or switch the device to `full-sweep`. A
failed test is recoverable. Silently replacing somebody's banking app is not.

**Refusing requires knowing the package name BEFORE the install, and that needs `aapt2`.** Found
while implementing this, and recorded because it changes what the guarantee is worth. `aapt2` ships
in the Android SDK's build-tools, which the farm already treats as a dependency — `appium:app` needs
it to read a manifest — and the agent finds it under `ANDROID_HOME` rather than asking for a fifth
variable. Where it is present, this is a refusal: nothing touches the device.

Where it is absent the agent cannot know what is in the APK until it is installed, and the only
signal left is that the install added no new package. By then the owner's app is already gone. So
the degraded path **reports** rather than prevents: the session fails, loudly, naming the remedy.
Refusing every install on a machine without build-tools was considered and rejected — it would make
the safe default unusable on a stock laptop, which is how safe defaults get turned off.

### 3. The capability says which, because the promise is different

`install-reset` joins `session-reset` and `snapshot-reset` as a third alternative in the same group
of `REQUIRED_FOR_TENANT_USE`. Three names because there are three different promises, and the
project's existing rule holds: a name that means two things eventually disagrees with itself.

**What `install-reset` does not promise, stated plainly because the console has to repeat it.** An
app the owner already had, which a session drove, keeps whatever state that session left in it. The
next session — same org, because a physical device is pinned to one — can see it. That is not a
weakness introduced here; it is the irreducible property of lending a personal phone, and the only
alternative is wiping the phone, which is the thing this ADR exists to stop.

So the honesty lands in the product: a device shared from somebody's laptop is marked as theirs, and
the person sharing it is told what colleagues in their org will be able to see. That sentence belongs
next to the sharing toggle, not in a document.

### 4. Consent lives at the sharing decision, and it shows the blast radius

`full-sweep` is chosen by the device's owner, in the agent's window, at the moment they share the
device — the same screen and the same trust decision as ADR-0009 §2's per-device toggle.

Choosing it shows the list first. The logic already exists: `deploy/verify-physical.mjs` computes
exactly this, names the packages that would break the device, and clears nothing. It moves into the
agent so a person sees "this will wipe the data of 134 apps, including these" before agreeing, rather
than an operator reading it in a terminal on a different machine.

`PHYSICAL_KEEP_PACKAGES` stays, unchanged, for dedicated farm devices provisioned from a script. It
stops being the only thing between a borrowed phone and its owner's data.

## Consequences

Deliberately accepted:

- **A `full-sweep` device is strictly cleaner between sessions than an `install-scoped` one**, and
  most devices will now be the weaker kind. That is the right trade: the fleet's dedicated phones
  can opt in, and the borrowed ones are the reason the product exists.
- **The ledger is state the agent must not lose, so it is written to disk** — one small file per
  device serial. An in-memory ledger was the first design and it is wrong on exactly the machine
  this ADR is about: a phone replug restarts the agent, and forgetting mid-session would leave the
  tester's APK on somebody's personal phone with nothing that would ever remove it. A file costs one
  write per install. An unreadable or corrupt one reads as "this device has nothing recorded",
  because the failure direction that matters is never uninstalling something we did not install.
- **`install-scoped` cannot clean up what a test wrote through an app it did not install** — files
  in shared storage, a signed-in account. Named here so nobody discovers it as a surprise.

Rejected, with reasons:

- **Keep the sweep and make the keep list mandatory.** The first thing tried, and it is what phase 0
  actually ran with. It works, and it is still a default that is safe only when configured, checked
  by a probe that was itself wrong for months. The failure mode is unrecoverable, so the default has
  to be safe when nobody does anything.
- **Refuse physical devices that are not dedicated.** Honest, and it deletes ADR-0009's gate — the
  tester plugging in their own phone is the product.
- **A factory reset with the owner's consent.** §17 already forbids it, and the agent could not
  re-authorize adb afterwards, so the device would leave the farm by resetting.
- **Snapshot the phone and restore it.** There is no such mechanism on a stock handset, which is why
  `session-reset` exists at all.

## Verification

`deploy/verify-reset.mjs` runs the three cases below against a real handset, and puts the device
back exactly as it found it:

1. Run a session that installs an APK, drives it, and releases. **The APK is gone; `pm list
   packages -3` returns the same 134 packages it did before, with the same data.**
2. Run a session that fails at creation. **Nothing is uninstalled and nothing is cleared.**
3. Attempt an install of a package the phone already has. **The session fails, naming it.**

The first of those is the one that matters: it is the run that, before this ADR, would have logged
the owner out of everything on their phone.

**Status on 2026-08-28: all three cases pass on hardware.** A release after a session that installed
nothing left all 138 packages untouched; an APK installed through a real session on the deployed
farm was ledgered, removed on release, and left the owner's 138 apps intact; and installing over a
package the device already had was refused by name. The device was left exactly as it was found.

They were unrunnable for two days because Play Protect refuses every APK pushed over adb on this
handset — its own product problem, and the one that became M1 of the build plan. The consented,
reversible opt-in M1 added is what let this gate close, which is the argument for that milestone
sitting first: it was not merely blocking a test, it was blocking the product's core loop.
