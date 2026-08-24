# Building the MFARM Agent — plan and verification

The agent a person installs so the phone on their desk shows up in the console. Any host, any
device.

**Read first:** [ADR-0008](adrs/0008-physical-devices-behind-the-existing-agent.md) (physical devices
behind the existing agent), [ADR-0009](adrs/0009-the-agent-is-a-product.md) (one binary, loopback
window, security model), [ADR-0010](adrs/0010-ios-without-xcode.md) (iOS on every host).

---

## The rule this plan runs on

**Every phase ends with something a person can watch happen.** Not a passing test — those are
necessary and they are not the gate. The gate is a device, a screen, and somebody who can see
whether it worked.

This is not a style preference. Three times in this codebase, work that was green in the suite was
broken in production: `app.inject()` cannot see socket lifecycle, so a feature shipped that worked
0% of the time; `node --test` catches `unhandledRejection`, so a fatal crash passed as a test;
`DeviceControl.health()` was implemented by every backend and called by nothing for months. The
suite is blind in specific, known ways. A phone on a desk is not.

---

## Where the code already is

Built and hardware-verified, and **not** to be rebuilt:

- Enrollment: single-use, expiring, revocable, org-scoped tokens; devices inherit the host's org and
  never enter the shared pool.
- The outbound tunnel: the agent dials the control plane and holds one socket; the console
  multiplexes onto it. Works through NAT with nothing listening on the host.
- Android: USB discovery, hot-plug, metadata, battery and storage health, package-level reset, APK
  install, launch, logcat, screenshots, UI hierarchy.
- Failure classification (§18): infrastructure and device-health incidents recorded separately from
  test results, never overwriting what the suite reported.
- Automation: Appium + UiAutomator2 adjacent to the device; the WebDriver hub allocates a real phone
  exactly as it allocates a virtual one.
- Capture: an Annex-B NAL splitter and two H.264 sources (scrcpy, `screenrecord`). RTP packetization
  measured at p99 0.36ms, under 1% of one core.

Known-unverified, and phase 0 exists to fix it: **the physical backend has never touched a real
handset.** Everything below assumes it works.

---

## Phase 0 — Prove what exists

Nothing is built in this phase. It de-risks every phase after it.

**Do:** enroll one Android handset against the running farm. Run a suite. Watch the reset.

```bash
node deploy/verify-capture.mjs                 # H.264 off the device, no jar needed
PHYSICAL_ENABLED=1 CONTROL_PLANE_URL=… WORKER_REGISTRATION_TOKEN=mae_… npm start -w @mfarm/agent
MFARM_API_KEY=mfk_… node deploy/verify-webdriver.mjs
```

**Gate:** the phone appears in the console, takes a WebDriver session, installs an APK, and returns
to `READY` after a reset. Any failure here is worth more than a week of the phases below.

**Expect to find things.** `resetToSnapshot` clears third-party packages on a real handset for the
first time; `pm clear` behaviour varies by OEM. The held adb shell has only ever run against an
emulator and Cuttlefish.

---

## Phase 1 — The window

The largest change in how the product *feels*, and it needs no new device support.

**Build:**
- An HTTP server on `127.0.0.1` in the agent, serving a small web app. Third server in the process;
  `gateway.ts` is the pattern.
- **Security, in the first commit, not retrofitted:** loopback bind; a session token minted at
  start-up, passed in the URL the agent opens, never persisted; `Origin` **and** `Host` validated on
  every request. See ADR-0009 §3 for why all three are needed.
- The device list: everything discovery and the health monitor already know — model, OS, serial,
  state, and the human remedy for each unusable adb state.
- Live updates. Poll or SSE; a person watching a device boot should not have to refresh.

**Gate:** plug a phone in with the window open and watch the row appear. Unplug it and watch it go.
Leave it unauthorised and read the instruction that tells you to tap Allow.

---

## Phase 2 — Pairing, and per-device sharing

**Build:**
- Sign-in: a pairing code from the console exchanged for the enrollment token the API already mints.
  The credential model does not change — this is a front end onto something already correct.
- Credentials into the OS keychain (Keychain / Credential Manager / libsecret), `0600` file fallback.
- **Discovered is not shared** (ADR-0009 §2). This is the one behavioural change to existing code:
  today everything discovery finds is registered. A per-device toggle, off by default, reversible.

**Gate:** on a machine that has never seen MFARM, pair, tick one of two connected phones, and see
exactly that one in the console. Untick it and watch it leave.

---

## Phase 3 — Windows, Android only

Ported *and run*. Node and adb both work on Windows; the agent has never executed there once.

**Expect:** `SIGTERM` does not mean on Windows what it means elsewhere; there is no systemd; adb
resolution and path handling differ; the held-open adb shell's pipe behaviour is unverified.

**And handle the trap:** the user already runs `adb`. Two servers of different versions kill each
other, their IDE stops seeing the device, and they blame us correctly. Detect a running server and
use it; start our own only when there is none.

**Gate:** the same phone, from a Windows laptop, running a suite.

---

## Phase 4 — Ship it

**Build:** a single executable per platform (Node SEA, stable since Node 22 — see ADR-0009 §4),
signed and notarised. Automation runtime fetched on first use with visible progress, not bundled.
`--install-service` behind a flag, wrapping what the systemd unit already does.

**Start the certificates now.** Apple Developer ID and Windows Authenticode take weeks to obtain. If
this begins in phase 4 it becomes the critical path.

**Gate — this is the one that matters:** someone who has never seen MFARM, on a machine we do not
control, plugs in a phone and sees it in the console **inside two minutes, without typing a command
or entering a password.**

---

## Phase 5 — Spike iOS signing

Days, and it gates everything iOS. See ADR-0010.

Build WDA once on a Mac → re-sign with `zsign` on a non-Mac → install with `go-ios` → one WebDriver
command reaches the device.

**Gate:** that command returns. If it does not, stop and re-plan iOS before writing any of it.

---

## Phase 6 — iOS, on every host

Built once, runs on macOS, Windows and Linux, because `go-ios` does not care which.

**Build:** device discovery and metadata; app install and launch; WDA lifecycle; the WebDriver proxy
into the existing automation gateway. Treat provisioning profiles as product work — expiry must be
explained, not reported as a broken device.

**Gate:** an iPhone and an Android phone, on the *same* Windows machine, both in the console, both
running a suite.

---

## Phase 7 — Live view, both platforms at once

Half-built: the capture layer exists and the throughput risk is measured and cleared. What remains
is transport and viewer.

Android arrives as H.264 from scrcpy; iOS arrives as H.264 from `quicktime_video_hack`. **One
implementation covers both.** `werift` is the chosen WebRTC peer (pure TypeScript — no native build,
which is the whole point on a stranger's laptop).

**Gate:** open a device in the console and interact with it. Measure the latency and publish the
number rather than describing it as "responsive".

---

## What is deliberately not here

- **Wireless ADB.** §9 is explicit: USB first, and the connection abstraction should not need
  redesigning to add it later.
- **iOS simulators.** They are macOS-only and are a different product from a real device.
- **Video recording of sessions.** Costed and deliberately unbuilt until it can record only failures.

---

## Traps worth reading before starting

| Trap | Why it bites |
|---|---|
| The user's own `adb` | Version mismatch kills one server. Our users are Android developers; they always have one. |
| iOS on Windows needs Apple's driver | `usbmuxd` comes from Apple Mobile Device Service (iTunes / Apple Devices). Detect and say so, don't report "no device". |
| A localhost server is not private | Any local process, and any website the user visits, can reach it. ADR-0009 §3. |
| Unsigned binaries | Blocked by Gatekeeper, warned by SmartScreen. Fatal first impression for a tool asking for USB access. |
| `node --test` catches `unhandledRejection` | A production-fatal crash can pass as a test. The tell is a suspiciously short duration. |
| `app.inject()` sees no sockets | A feature that works 0% of the time can be fully green. Anything socket-shaped needs a real server. |
