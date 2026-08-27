---
id: ADR-0009
title: The agent is one signed binary with a loopback window, not an installer and a daemon
status: Accepted
date: 2026-08-25
authors:
  - Claude Code
tags: [agent, distribution, security, ux, physical-devices]
supersedes: []
extends: [ADR-0008]
---

## Context

ADR-0008 made a physical handset a third backend behind the existing agent, and that agent is now
good at its job: it enrolls, holds an outbound tunnel through NAT, discovers phones on USB, watches
their health, files infrastructure incidents, and serves WebDriver. All of it verified on hardware.

None of it is a *product*. Today the agent is a headless Node process started from a git checkout
with environment variables and supervised by systemd. It is `private: true` with no executable
entry point — not something you install, a directory you run from a clone. It has no window, no
sign-in, and no way to tell a person whether the phone on their desk is working.

That gap is the whole distance between "our team runs a farm" and "a tester plugs in a phone". This
ADR decides the shape that closes it.

The constraint that shapes everything below: **the people who will run this are on locked-down
corporate laptops.** A device farm lives in a QA org, and QA orgs do not hand out administrator
rights. Any design whose first step is "run the installer as an administrator" fails for most of
its intended users before it starts.

## Decision

**One signed binary per platform. No installer. No administrator rights. A local web window.**

Download it, run it, sign in, tick the phone to share. The same binary becomes a permanent farm node
with `--install-service`, which is the only path that touches system state and the only one that
ever asks for elevation.

One artifact, two lifetimes: a thing a tester runs for an afternoon, and a thing that survives a
reboot on the machine in the corner with six phones on a powered hub. Tailscale, ngrok and
cloudflared all converged on this shape; it is not novel and that is the point.

### 1. The window is a page on loopback, not a desktop app

The agent serves a small web app on `127.0.0.1` and opens the browser at it. Not Electron, not
Tauri — a page.

It renders identically on every platform, adds nothing to the download, reuses the console's own
design system, and is the third HTTP server in a process that already runs two. A desktop framework
would be a hundred megabytes and a second UI toolchain to buy the same information.

Everything the window shows is **already computed inside the agent**: device metadata, adb state,
the human remedy for each unusable state, lease countdowns, tunnel status, health transitions. This
is presentation work over existing machinery, which is why it is small.

### 2. Discovered is not shared

A new concept in the agent, and the one behavioural change this ADR makes to existing code. Today
every device discovery finds is registered. That is correct for an operator-owned box and wrong for
a laptop: plugging a personal phone into a work machine must not silently offer it to colleagues.

Discovery stays a read. Sharing becomes a per-device decision, reversible instantly, never inferred
from the fact that something was plugged in.

### 3. The loopback window is the security surface, and is treated as one

A server on `127.0.0.1` is **not** private. Every process on the machine can reach it, and so can
any website the user visits — the vulnerability class that has repeatedly embarrassed desktop
software that assumed otherwise. Three mitigations, and all three are required:

- bind loopback only, never `0.0.0.0`;
- require a session token minted at start-up, passed in the URL the agent opens, never persisted;
- validate `Origin` **and** `Host` on every request, so a rebound DNS name cannot pose as localhost.

The rest of the model is inherited and worth stating because it is unusually good already: nothing
listens on the network (the agent dials out, so there is no inbound port to find), every command to
drive a device carries a short-lived signature the agent verifies **offline** against a key it
holds, and the per-machine credential is org-scoped and revocable from the console. Credentials move
into the OS keychain — Keychain, Credential Manager, libsecret — with a `0600` file only where none
exists.

Uninstalling is deleting a file. No installer means no service, no login item, no kernel extension
and no system-wide state, unless somebody explicitly asked for service mode.

### 4. Node, and Node SEA

The agent stays Node and ships as a Single Executable Application, stable since Node 22.

Not because Node is the best language for a device agent — Go would produce a smaller binary and
matches `go-ios` — but because **Appium is Node**, and the agent has to host it. Bundling a runtime
we then do not use for the largest thing we run would be the wrong trade. The automation runtime is
fetched on first use rather than bundled, so somebody who only wants to look at a device does not
download a couple of hundred megabytes of driver.

## Consequences

Deliberately accepted:

- **Code signing becomes a hard dependency and a lead time.** An unsigned binary is blocked outright
  by Gatekeeper and warned about by SmartScreen, which for a tool asking for USB access is a fatal
  first impression. Apple Developer ID plus notarisation, and Windows Authenticode. Certificates
  take weeks to obtain; this starts before the code is ready or it becomes the critical path.
- **A platform installer is still needed eventually**, for MDM fleet deployment onto the dedicated
  machines. It is a second path, not the first one.
- **The agent must not fight the user's own `adb`.** Two adb servers of different versions kill each
  other, and our users are Android developers who always have one running — their IDE would stop
  seeing the device and they would be right to blame us. The agent detects a running server and uses
  it, starting its own only when there is none.

Rejected, with reasons, because each looks correct until examined:

- **A container.** The obvious answer for "runs anywhere", and it fails on the one thing this
  product does: USB passthrough into Docker on macOS and Windows is not supported, because both run
  a Linux VM the devices are not attached to. It works on Linux with elevated privileges — the
  platform that needed it least.
- **Browser-only, over WebUSB.** Genuinely install-free and worth wanting. But it cannot run Appium
  or WebDriverAgent, which are processes; it claims the USB interface exclusively, so it fights the
  user's own tooling; permission is re-granted per device per session; and iOS is out of reach.
- **A platform installer as the primary path.** Respectable, and it needs administrator rights,
  which is precisely what the intended user does not have.

## Verification

The gate for this ADR is not a test suite. It is: **a person who has never seen MFARM, on a machine
we do not control, plugs in a phone and sees it in the console inside two minutes, without typing a
command or entering a password.** Anything short of that has not closed the gap this ADR exists for.
