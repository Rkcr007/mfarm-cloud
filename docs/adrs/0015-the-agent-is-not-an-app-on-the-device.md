---
id: ADR-0015
title: The agent is not an app on the device under test
status: Accepted
date: 2026-08-28
authors:
  - Claude Code
tags: [agent, android, ios, architecture, rejected-alternatives]
supersedes: []
extends: [ADR-0009]
---

## Context

The agent asks a lot of a new user: download software onto a laptop, install adb and an automation
runtime, plug in a cable. A natural idea for removing all of that is **an MFARM app the user
installs on the phone itself** — it would guide the setup, show the device's own state, and connect
to the console directly, with no laptop and no cable in the picture.

It is a good enough idea that it will be proposed again. This records the answer so it meets a
written one rather than being re-derived, and so the parts of it that ARE right are not thrown out
with the rest.

## Decision

**The thing that drives a device runs on a host, not on the device.** An MFARM mobile app may exist
later as a *console client* — a signed-in view of the fleet — but it is not the agent and it does
not replace the host.

### Why an app cannot be the agent

**1. The sandbox forbids exactly what we do.** Install an APK, grant a permission, tap another app's
UI, read its hierarchy, screenshot it — that list is the product, and it is also the list Android's
app sandbox exists to prevent. Three partial escapes exist and each fails on its own terms:

| Escape | What it gives | Why not |
|---|---|---|
| Accessibility Service | reads the UI tree, performs gestures | cannot install or uninstall anything, and Google removes apps that use it for non-accessibility purposes — a store-policy risk on the critical path |
| MediaProjection | screen capture with a consent dialog | blanked by `FLAG_SECURE`, measured on our own handset. Same blank rectangle as scrcpy |
| Shizuku-style self-pairing over wireless debugging | genuine `shell` privileges, no root | Android 11+, re-pair after reboot, permanent tension with Google, and still cannot survive §2 |

**2. A device cannot host the thing that tests it.** This is the objection that decides it, and it
is not a policy question that could change:

- Android kills backgrounded apps — Doze, battery optimisation, background execution limits. A farm
  agent must stay alive for hours while a *different* app holds the foreground. That is precisely
  what the OS is engineered to prevent.
- A test that wipes app data may wipe the agent. A test that hangs the device takes the agent with
  it, and there is no cable left to recover through. The entire value of a USB host is that it
  outlives whatever happens to the device.
- The agent would itself be installed software on a device whose state we promise to control
  (ADR-0012). It would be inside its own blast radius.

**3. iOS closes the door entirely.** No accessibility-service equivalent for third-party apps, no
self-adb. An app-based agent is Android-only permanently, which contradicts the target ADR-0010 and
the build plan are both written against.

**4. It does not remove the friction it was proposed to remove.** Every one of the setup steps lives
on the host: no artifact, no pairing, Node, adb, the automation runtime, the environment variables.
An app on the phone leaves all of them and adds a second platform to build, sign and take through
App Store and Play review.

**5. Security gets harder, not easier.** A standing accessibility service or `shell`-privileged app
on somebody's personal handset is a far larger request than a USB cable and one revocable *Allow USB
debugging* prompt — and it has no equivalent off-switch. Pulling the cable ends the current model;
nothing ends the other one.

### What is right in the idea, and kept

- **The guide belongs where the device can be observed.** The host can see a phone on USB before adb
  can (ADR-0009's window, extended in M3), so it can say what is wrong. An app on the phone can tell
  the host nothing until adb already works — by which point no guide is needed. This is why the
  prerequisite walkthrough goes in the agent window and not on the handset.
- **A mobile console client is a reasonable product**, later. It is an authenticated REST client
  against an API that already exists, and it needs no server work. It is not on the critical path
  and must not be confused with the agent.
- **Wireless debugging pairing (Android 11+) is worth having** and needs no app of ours — `adb pair`
  already implements it. It stays where spec §9 put it: after USB, with the connection abstraction
  built so adding it does not require a redesign.

## Consequences

- The host requirement stands: a Mac with the agent on it, for now. That is the cost of being able
  to drive a device the OS does not want driven from inside.
- Onboarding effort goes into the desktop agent — the artifact, pairing (ADR-0014), and the guided
  prerequisites — rather than being split across two platforms.
- If Android ever ships a first-class supported path for an on-device automation host, this decision
  is worth revisiting. Shizuku is not that path; it is a clever use of one that was left ajar.
