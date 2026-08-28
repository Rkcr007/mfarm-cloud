# Building the MFARM Agent — plan and verification

**The target, in one sentence: a Mac, any Android or iPhone on the cable, and it appears in the
console — in its own place, with a live screen — without anybody typing a command.**

**Read first:** [ADR-0008](adrs/0008-physical-devices-behind-the-existing-agent.md) (physical devices
behind the existing agent), [ADR-0009](adrs/0009-the-agent-is-a-product.md) (one binary, loopback
window, security model), [ADR-0010](adrs/0010-ios-without-xcode.md) (iOS on every host — **narrowed
by this plan, see below**), [ADR-0011](adrs/0011-automation-over-the-tunnel.md) (automation rides the
tunnel).

**Re-scoped 2026-08-26.** The previous version of this plan sequenced Windows before iOS and treated
iOS signing as the gating unknown. The owner's target is now macOS-first: one host platform, both
device platforms. That single change reorders everything below and deletes the riskiest item.

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

## Dropping Windows collapses the iOS problem — this is the whole reason the plan got shorter

ADR-0010's architecture — `go-ios` running WebDriverAgent, `zsign` re-signing a pre-built `.ipa`,
`quicktime_video_hack` for the screen — exists for exactly one reason: **to escape Xcode, because
Xcode is macOS-only and the host might be Windows.**

If the host is a Mac, there is nothing to escape. Xcode is right there. Appium's XCUITest driver —
which `workers/agent/src/appium.ts` already supervises for Android — builds, signs, installs and runs
WDA by itself against a paid team ID. The `.p12` handling, the CI Mac that produces a release `.ipa`,
and the cross-platform re-signing spike that ADR-0010 says *gates all iOS work* all leave the
critical path.

**ADR-0010 stays Accepted and stays right — for the day Windows comes back.** It is not being
reversed, it is being deferred. That belongs in an ADR of its own (proposed **ADR-0013:
`ios-on-macos-first`**), written in S1 below, so nobody re-derives this in three months and nobody
mistakes "we didn't need zsign" for "ADR-0010 was wrong".

What does **not** go away, on any host: the customer needs an Apple Developer account and their
device UDIDs in a provisioning profile. That is Apple's rule, it applies identically on a Mac, and
**it is product work, not setup** — profiles expire, and an expired profile must be explained rather
than reported as a broken device.

---

## Where the code already is

Built, and **not** to be rebuilt:

- **Enrollment** — single-use, expiring, revocable, org-scoped tokens; devices inherit the host's org
  and never enter the shared pool.
- **The outbound tunnel** — the agent dials the control plane and holds one socket; the console
  multiplexes onto it. Works through NAT with nothing listening on the host. Hardware-verified.
- **Automation over that same tunnel** (ADR-0011) — `APPIUM_ENABLED=1` now starts on a NAT'd laptop,
  the gateway binds loopback, and the existing farm stays on its direct path. 822 tests green,
  **not yet run on hardware.**
- **Android device control** — USB discovery, hot-plug, metadata, battery/storage health,
  package-level reset, APK install, launch, logcat, screenshots, UI hierarchy.
- **The scheduling gate accepts phones** — `session-reset` sits beside `snapshot-reset` in
  `REQUIRED_FOR_TENANT_USE`, so a handset is no longer silently dropped from `schedulable`.
- **Capture** — an Annex-B NAL splitter and two H.264 sources (scrcpy, `screenrecord`). RTP
  packetization measured at p99 0.36 ms, 0.8% of one core (spike 3, PASS).
- **The console already distinguishes real from virtual** — `REAL DEVICE` / `VIRTUAL DEVICE` tag plus
  an All/Virtual/Real filter, derived from `tier` rather than stored alongside it.
- **The protocol already has iOS** — `platform: 'android' | 'ios'`, `tier: … | 'physical'`. No schema
  change is needed to represent an iPhone.

Known-unverified, and P0 exists to fix it: **the physical backend has never completed a round trip
against a real handset.**


---

## What is now done, and the measurement that reshaped the rest

**P0 is closed and shipped.** A Samsung SM-S918B on a macOS laptop, behind NAT, appears in
`farm.mfarm.dev`, takes a WebDriver session in 9.0s, serves its data plane through the console's
ingress, and returns to `READY` — over a socket the laptop dialled out. Deployed as `d4c4172`.

Three items from the previous ordering are gone: the physical backend was already built, automation
over the tunnel shipped (ADR-0011), and the data-plane endpoint it had left behind was fixed on
hardware. The reset default was inverted (ADR-0012), and the console's hardware buttons were unstuck
from a video stream they never needed.

**And one measurement changed the shape of everything after it.** The owner's own app — the reason
this farm exists — sets `FLAG_SECURE`. Measured on the handset, same device, seconds apart:

| Capture path | Alaan staging | Settings |
|---|---|---|
| `adb screencap` | 27 KB, blank | 213 KB, real |
| `scrcpy` (display mirroring) | **blank** | real |

`scrcpy` was the hope: it mirrors the display rather than reading a surface, and on some devices that
sees through a secure window. On this one it does not — only the status bar, a system window,
survives. **So a finished WebRTC live view would render a black rectangle on every screen of the app
this was built for.**

What is *not* blanked is the accessibility tree. The passcode screen reads back completely: every
label, every clickable node, real bounds. **The way to operate a secure app is its hierarchy, not its
pixels** — and that is far cheaper to build than WebRTC.

---

## Priority order

Ordered by what a user hits first, not by what is architecturally interesting.

| # | Milestone | Why here | Est. |
|---|---|---|---|
| ~~M1~~ | ~~Installing an app actually works~~ | **Done** — shipped as `4cdb6a5`, verified on the handset. | — |
| ~~M2~~ | ~~The window~~ | **Done** — see below for what it does and does not do. | — |
| **M3** | Pairing + per-device sharing | The other half of "somebody else can use this". | 3–5 d |
| **M4** | Operate a device without video | Works on secure apps, where video never will. | 4–6 d |
| **S1** | Spike: iPhone on this Mac | Days, gates a quarter of the product. Run it alongside. | 1–2 d |
| **M5** | The signed binary | Makes M2 and M3 a download instead of a checkout. | 3–5 d |
| **M6** | Live video | Known to be useless for secure apps; still right for most. | 5–8 d |
| **M7** | iOS as a first-class device | The big surface, de-risked by S1. | 8–12 d |

---

## M1 — Installing an app actually works

**Found by trying it, planned by nobody.** Every `adb install` on the test handset is refused —
`INSTALL_FAILED_VERIFICATION_FAILURE`, with Play Protect showing *"Harmful app blocked"*. It blocked
all three Appium helpers and a sample APK. The product's core loop — install my app, drive it, throw
it away — **does not work on a stock Android phone**, and it surfaces as `upstream_rejected` after a
60-second adb timeout, several hops from the cause.

**Build:**
- **Detect it.** A verification failure is a known state with a known remedy, not an unknown error.
  File it as an infrastructure incident (§18), never as a test failure.
- **Explain it before it happens.** The window says plainly that Android will warn about a testing
  helper, and what that helper is — a beat before the phone shows the dialog, not 90 seconds into
  somebody's first run.
- **Offer the device-prep step, with consent.** `verifier_verify_adb_installs 0` is the standard
  device-farm answer and it is the owner's decision about their own phone: shown, never done
  silently, restored on unpair.
- **Pre-install the automation helpers at pairing**, so prompts happen once during setup.

**Gate:** on a phone that has never seen MFARM, a session installs an APK, drives it, and the release
removes it — with no dialog appearing mid-test.

**It closes ADR-0012's open hardware gap for free.** Cases 1 and 3 are unrun purely because no APK
can be installed; `deploy/verify-reset.mjs` is written and waiting.

---

## M2 — The window — **built**

The single largest gap between "a farm" and "a product", and it needed no new device support.

`workers/agent/src/window.ts` serves one self-contained page on `127.0.0.1`. All three of ADR-0009
§3's mitigations are in the first commit rather than retrofitted, and each is tested for the exact
bypass it exists to stop:

| Mitigation | What it stops | Verified |
|---|---|---|
| Loopback bind, no override variable | The window answering another machine | `lsof` on the running agent: `127.0.0.1:7317 (LISTEN)` |
| 32-byte token in the URL, compared in constant time, never persisted | A website that can reach loopback but cannot guess it | `401` with no token, with a wrong token of the same length, and with a prefix |
| `Origin` **and** `Host` on every request | A page on another site; a DNS name rebound to 127.0.0.1 | `403` and `421` against the live agent |

`Origin` is required on a write and optional on a read, because browsers omit it on the same-origin
GET that loads the page — and a `Host` check without an `Origin` check would leave rebinding open,
which is why both are there.

Three things beyond the plan turned out to be part of the milestone:

- **The agent now stays up with no devices.** `PHYSICAL_ENABLED=1` with nothing plugged in used to
  fall through to the AVD tier and exit on `AVD_NAME is required` — so the gate below, which starts
  with "with the window open", could not be performed at all. It registers with an empty device list
  and waits.
- **M1's other half landed here**, where the plan said it should: the Play Protect remedy is a
  sentence beside the device and the opt-in is a button, not `PHYSICAL_ALLOW_INSTALL_VERIFICATION_OFF`.
  The env var stays for scripted provisioning.
- **`server.close()` waits for keep-alive sockets.** Four seconds added to every drain, found by a
  test suite that took 4.2s to run 29 tests that each took a millisecond. `closeAllConnections()`.

**Gate:** plug a phone in with the window open and watch the row appear. Unplug it, watch it go.
Leave it unauthorised and read the line that tells you to tap Allow.

**Not done, and named rather than left to be discovered:**

- **A registration failure still exits the process.** The window comes up before `agent.start()` on
  purpose — the moment it is worth most is when the control plane cannot be reached — but a 401 from
  a spent enrollment token kills the agent anyway, so the "not registered yet" notice is only ever
  visible while a registration is in flight. Retrying a *transient* failure (connection refused,
  5xx) while a 4xx stays fatal is the right shape and is not built.
- **A phone arriving still drains and restarts the agent**, which is invisible under systemd and
  very visible in a terminal. That is ADR-0003's registration-only capability write, and it closes
  in M5 with the service, not here.
- **The window shows; it does not yet share.** Every discovered device is listed, and the per-device
  sharing toggle that decides which of them the org can reach is M3.

---

## The shape the rest of the plan is written against

Agreed 2026-08-28. Everything below serves these three steps and nothing else:

1. **Download** — one signed file from the console's own domain.
2. **Run it** — a window opens showing `XXXX-XXXX`; type that into the console; paired.
3. **Plug the phone in** — the agent sees it on USB *whether or not adb can*, walks the
   prerequisites with live state and a remedy per step, confirms when it becomes usable, and shows
   the device. Tick **share** and it is in the console.

**The prerequisites become guided rather than documented.** That is the whole difference between
what exists and what is wanted, and it is why step 3 is a milestone rather than a paragraph.

### What a new user faces today — the gap this closes

| # | Step | Status |
|---|---|---|
| 1 | Get the code | **no artifact exists** — `@mfarm/agent` is `private: true`, no `bin`, no build; Release publishes only the API image |
| 2 | Install Node ≥ 22.6 | manual |
| 3 | `npm install` at the repo root | manual |
| 4 | Install adb | 26 MB, manual |
| 5 | Install Appium 2 + UiAutomator2 | **~400 MB**, manual, minutes |
| 6 | Install scrcpy, aapt2 | manual |
| 7 | Get an enrollment token | **admin logs in by curl with a cookie jar and a CSRF header** — no console screen |
| 8 | Set 6–11 environment variables | manual |
| 9 | `npm start -w @mfarm/agent` | ✅ |
| 10 | Press the Play Protect button | ✅ M2 |
| 11 | Phone appears in the console | ✅ works, through NAT |

Steps 9–11 are the product. Steps 1–8 are a developer setup guide. **The hard engineering is already
behind us** — the outbound tunnel, NAT traversal, a browser reaching a laptop's data plane through
the console's ingress, automation over that same socket, all verified on a real handset. What
remains is onboarding.

### The one item with a queue

**Apple Developer ID and notarisation. Start it before anything else.** Unsigned, Gatekeeper blocks
the binary outright, which for a tool asking for USB access is a fatal first impression. ADR-0009
warned this becomes the critical path if left to the end. It gates M5 and nothing else, so it should
be in flight while M3 is built.

---

## M3 — Pairing, sharing, and the guided prerequisites

The milestone that turns the table above into three steps. **No certificate needed**, which is why
it comes first.

### 3a. Pairing — [ADR-0014](adrs/0014-pairing-is-a-device-authorization-grant.md) — **built**

Verified end to end on a real control plane 2026-08-28: an agent with no credential of any kind
showed `RSMB-MR9J`, an admin inspected it (seeing hostname, platform and agent version), approved
it, and the agent registered — then a restart paired nothing, because the host now carries its own
`mwk_`.

**The console screen is built too** — *Organisation → Agents*. Enter the code, see which machine is
asking, confirm. Approval is deliberately two presses: the flow's one genuine weakness is somebody
talked into typing a code that was sent to them, and the only defence is showing them what they are
about to admit before they admit it.

**Still to build here:** credentials into the Keychain (they are in `~/.mfarm/agent-state.json` at
`0600` today), and unpair.

The agent shows `XXXX-XXXX`; the user types it into the console they are already signed into; the
agent polls and receives the `mae_` token the API already mints. This is RFC 8628's device
authorization grant — the flow that signs a television into a streaming account.

**The code goes agent → console, not the reverse**, and that direction is the security argument: the
console is the authenticated side, so the code carries exactly one claim — *possession of the agent
in front of you* — and identity comes from the session. The reverse would put a bearer credential
back in a text field, which is the thing being removed.

Credentials into the macOS Keychain. **Unpairing ships with it**, not after: *forget this machine*
clears the keychain entry and revokes the host. A flow with an entrance and no exit is one people
are right to hesitate over installing.

The `curl` path and `WORKER_REGISTRATION_TOKEN` both survive — a scripted fleet rollout should not
have to drive a GUI.

### 3b. Discovered is not shared — **built**

A per-device toggle, **off by default**, reversible instantly (ADR-0009 §2). Plugging a personal
phone into a work laptop must not silently offer somebody's banking and 2FA apps to their
colleagues. This is the guardrail every other promise in this product rests on, and it is the one
behavioural change ADR-0009 makes to code that already worked.

| | |
|---|---|
| Where the choice lives | `~/.mfarm/shared.json`, `0600`, an **allow list** — a lost or corrupt file means *nothing is shared*, never *everything* |
| Default | off for `tier: 'physical'`, on for everything else. Nobody accidentally has a Cuttlefish instance on their desk, and defaulting the whole fleet off would take the existing farm out of service to fix a problem it does not have |
| Keyed by | adb serial, **not** local id — an unshared phone has no local id, and requiring one would mean the only devices you could share are the ones already shared |
| A withheld phone | still appears in the window, with a toggle. It simply never becomes a backend, so registration never mentions it |
| What made that true | registration now takes devices ABSENT from its payload out of the pool. It did not, so "stop sharing" removed the device from the agent and left the control plane advertising it — found by verifying the deploy |
| Applying a change | drains and re-registers, exactly like a hot-plug — capabilities travel only at registration. A live session finishes first, so un-sharing never yanks a device out from under somebody's suite |

**The reset mode is chosen on the same screen** (ADR-0012 §4) — same trust decision, same person,
with the blast radius shown before anyone picks the sweep. **Not built yet**; it is still
`PHYSICAL_RESET_MODE` in the environment.

### 3c. The agent gets a second sense — the part that makes step 3 possible

**A phone with USB debugging off is invisible to `adb devices`.** It is not `unauthorized`; it is
absent. So the window cannot show a row, cannot walk a checklist against a real device, and cannot
confirm anything — the guide is blind exactly when it is needed.

`system_profiler SPUSBDataType` returns in **0.15 s measured** and lists USB devices independently
of adb. That gives the agent the state adb cannot report — *a Samsung is on this cable and it is not
offering debugging* — and turns the prerequisites into a live walkthrough:

| What the agent can see | What it says |
|---|---|
| USB device, no adb interface | Developer Options and USB debugging are off — here is where to tap |
| adb `unauthorized` | Unlock the phone and tap *Allow USB debugging* |
| adb `device`, verification on | Play Protect will refuse test builds (✅ M2) |
| adb `device`, ready | Confirm, show the device, offer **share** |

**Gate:** on a machine that has never seen MFARM, with a phone that has never had Developer Options
enabled — download, pair with a code, follow the agent from a dark screen to a shared device, and
see exactly that one phone in the console.

---

## M4 — Operate a device without video

**The phase the `FLAG_SECURE` measurement created**, and for this customer it is worth more than M6.

A tester needs to find an element, tap it, and know what it is called. None of that needs pixels. The
console already receives the full hierarchy from a secure app; what it lacks is a way to show it and
a way to touch it.

**Build:**
- Render the hierarchy as boxes — the inspector, unstuck from the video backdrop it requires today
  (`streaming` gates it).
- Tap and swipe by coordinate over the data plane, which already carries both verbs.
- A screenshot backdrop where the app permits one, and an honest empty frame where it does not.
- Selector suggestions, which `selectorsFor` already computes.

**Gate:** open the Alaan staging build in the console and tap "Forgot Passcode?" without ever seeing
a pixel of it.

---

## S1 — Spike: an iPhone on this Mac

Plug the iPhone in, get one WebDriver command through Appium's XCUITest driver against the paid team
ID, and check whether `ffmpeg -f avfoundation` enumerates the device. Deliverable besides the answer:
**ADR-0013**, recording the macOS-first narrowing of ADR-0010 and what would un-narrow it.

**Run it alongside M1–M3.** It is days, and it decides whether a quarter of the product is ordinary
work or a re-plan.

---

## M5 — The signed binary, and where it is downloaded from

Node SEA (stable since Node 22 — ADR-0009 §4), signed with Developer ID and notarised.
`--install-service` behind a flag.

**Three things here are routinely under-estimated:**

- **SEA needs one JavaScript file, and the agent runs from TypeScript** via
  `--experimental-strip-types`. So this needs a bundler step (esbuild) *before* it needs a
  certificate. It is not "run a packager".
- **The automation runtime is ~400 MB** (Appium 168 MB plus 233 MB of drivers, measured) and adb is
  another 26 MB. Fetched on first use with visible progress, never bundled — and **the device should
  appear in the console without waiting for it.** Look-only lands in seconds; the `webdriver`
  capability arrives when the runtime does. `agent.ts` already advertises capabilities per device
  based on what is actually ready, so this is honest rather than special-cased.
- **Everything installs under `$HOME`.** ADR-0009's founding constraint is the locked-down corporate
  laptop: no administrator rights, so no `brew`, no `/usr/local`, no installer. An installer that
  writes outside the home directory fails for exactly the people this is built for.

**Publishing:** serve it from `farm.mfarm.dev/download` with a published SHA-256. Zero new
infrastructure — the console already has TLS and a real domain — and the binary is not a secret, so
it need not sit behind the login. A bucket and a CDN when there are numbers worth measuring. GitHub
Releases is the obvious alternative and does not fit: the repo is private, so downloads would need
auth.

**Version skew becomes real the moment strangers hold a binary.** Minimum: the agent reports its
version, and both the console and the window say when it is out of date. Otherwise every protocol
change becomes a support queue.

**An interim worth shipping while the certificate is in flight:** a `curl … | sh` installer that
checks Node, fetches a tarball, installs adb and the runtime under `$HOME` with visible progress,
and launches the window. It removes six of the eight bad steps, needs no signing, and can go out in
days rather than weeks.

**Gate — the one that matters:** someone who has never seen MFARM, on a machine we do not control,
plugs in a phone and sees it in the console **inside two minutes, without typing a command or
entering a password**.

---

## M6 — Live video

Still worth building, and no longer the centrepiece. Right for most apps, useless for secure screens
— a sentence that now has to appear in the product, not only in this document.

`werift` is the peer (pure TypeScript, no native build, which is the whole point on a stranger's
laptop). The capture layer, the Annex-B splitter and the RTP packetizer exist and are measured at
p99 0.36 ms. **Spike SRTP and the actual send before committing the phase** — that is the half spike
3 explicitly did not cover.

**Gate:** open a non-secure app in the console, interact with it, and publish the latency rather than
calling it responsive.

---

## M7 — iOS as a first-class device

`go-ios` sits where `adb` sits; WDA is supervised the way `appium.ts` supervises UiAutomator2; the
WebDriver proxy goes into the existing gateway, which is platform-agnostic since ADR-0011. The live
view, where it applies, is the implementation M6 already built. **Provisioning-profile expiry is
product work** — explained, never reported as a broken device.

**Gate:** an iPhone and the Samsung, on the *same* Mac, both in the console, both running a suite.

---

## If a demo is needed sooner than the whole plan

**M1 → M2 → M3**, roughly two weeks: run the agent, a real window opens, sign in with a pairing code,
tick one of two phones, and it appears in the console and installs and runs your app. No live screen,
no signed binary — the demo is a terminal launch of a GUI, which is a different thing from a terminal
free product, but it is the shortest path to something a stranger can be shown.

---

## What is deliberately not here

- **Windows.** Out of scope by decision. ADR-0010 is the plan for the day it returns, and nothing in
  P1–P6 should make it harder — `go-ios` is cross-platform, the window is a web page, and Node SEA
  builds for three platforms.
- **iOS simulators.** macOS-only and a different product from a real device.
- **Wireless ADB.** §9 is explicit: USB first, and the connection abstraction should not need
  redesigning to add it later.
- **Video recording of sessions.** Costed and deliberately unbuilt until it can record only failures.
- **An MDM/platform installer.** A second path for fleet deployment, never the first one.
- **An MFARM app on the device under test.** Proposed and rejected in
  [ADR-0015](adrs/0015-the-agent-is-not-an-app-on-the-device.md): the sandbox forbids what the
  product does, a device cannot host the thing that tests it, iOS has no path at all, and it would
  remove none of the setup friction — which all lives on the host. A mobile *console client* is a
  reasonable product later and is not the agent.

---

## Traps worth reading before starting

| Trap | Why it bites |
|---|---|
| The user's own `adb` | Version mismatch kills one server. Our users are Android developers; they always have one. Detect and reuse theirs. |
| A localhost server is not private | Any local process, and any website the user visits, can reach it. ADR-0009 §3. |
| `pm clear` on a personal phone | `resetToSnapshot` clears third-party packages — banking, 2FA, WhatsApp. Never point it at a daily driver. |
| A sleeping phone grades everything | Both capture verifiers once reported 2.2 fps; awake and unlocked the same phone gave 110 fps. Nothing checks the prerequisites. |
| Signatures expire | An iPhone that worked last quarter stops, with no change on our side. Explain it; do not report a fault. |
| `node --test` catches `unhandledRejection` | A production-fatal crash can pass as a test. The tell is a suspiciously short duration. |
| `app.inject()` sees no sockets | A feature that works 0% of the time can be fully green. Anything socket-shaped needs a real server. |
