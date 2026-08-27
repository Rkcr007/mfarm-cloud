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
| **M1** | Installing an app actually works | "Test your app on a real device" fails at step one today. | 2–4 d |
| **M2** | The window | Turns a terminal command into something a person runs. | 3–5 d |
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

## M2 — The window

The single largest gap between "a farm" and "a product", and it needs no new device support.

**Build:** an HTTP server on `127.0.0.1` serving a small web app. **Security in the first commit, not
retrofitted:** loopback bind, a session token minted at start-up and passed in the URL, and `Origin`
**and** `Host` validated on every request — all three, for the reasons in ADR-0009 §3. The device
list with the human remedy for every unusable adb state. Live updates.

Everything it shows is already computed inside the agent. This is presentation over existing
machinery, which is why it is small.

**Gate:** plug a phone in with the window open and watch the row appear. Unplug it, watch it go.
Leave it unauthorised and read the line that tells you to tap Allow.

---

## M3 — Pairing, and per-device sharing

**Build:** a pairing code from the console, exchanged for the `mae_` token the API already mints —
retiring the two-step `curl` with a session cookie and a CSRF header that is the only way to enroll a
host today. Credentials into the macOS Keychain. **Discovered is not shared**: a per-device toggle,
off by default, reversible instantly.

**The reset mode is chosen here too** (ADR-0012 §4) — same screen, same trust decision, with the
blast radius shown before anyone picks the sweep.

**Gate:** on a machine that has never seen MFARM, pair, tick one of two phones, and see exactly that
one in the console.

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

## M5 — The signed binary

Node SEA (stable since Node 22 — ADR-0009 §4), signed with Developer ID and notarised. The automation
runtime is fetched on first use with visible progress, not bundled. `--install-service` behind a flag.

**The scheduling risk here is already retired:** ADR-0009 warned certificates would become the
critical path if left to the end, and the Apple account is paid and active, so a Developer ID
certificate is self-service.

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
