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

## Priority order

| # | Phase | Why here | Est. |
|---|---|---|---|
| **P0** | Prove Android end-to-end | Everything below assumes it works. Nothing is built. | ~1 day |
| **S1** | Spike: iPhone on this Mac | Cheapest possible answer to the biggest product claim. | 1–2 days |
| **S2** | Spike: the WebRTC peer | The last unmeasured engineering risk in the tree. | 1–2 days |
| **P1** | The window | Largest change in how the product *feels*; needs no new device support. | 3–5 days |
| **P2** | Pairing + per-device sharing | Turns "run this command" into "sign in and tick a box". | 3–5 days |
| **P3** | Live view — Android | One implementation; iOS inherits it in P4 for almost nothing. | 5–8 days |
| **P4** | iOS as a first-class device | The big surface, now de-risked by S1. | 8–12 days |
| **P5** | The devices tab | Makes sense of a fleet that is now two platforms and two owners. | 2–4 days |
| **P6** | The signed binary | Cert lead time is *already paid* — this is now a short phase. | 3–5 days |

Estimates are engineering days for a focused single track, not calendar. Roughly **5–7 weeks** end to
end.

---

## P0 — Prove what exists

Nothing is built in this phase. It de-risks every phase after it, and it is the one gate in this
document that has been open the longest.

**Do:**

```bash
node deploy/verify-capture.mjs                 # H.264 off the device, no jar needed
PHYSICAL_ENABLED=1 CONTROL_PLANE_URL=… WORKER_REGISTRATION_TOKEN=mae_… APPIUM_ENABLED=1 \
  npm start -w @mfarm/agent
MFARM_API_KEY=mfk_… node deploy/verify-webdriver.mjs
```

**Also:** commit the ADR-0011 work sitting uncommitted on `feat/physical-device-backend`. It is
822-tests green and it is the thing that makes a NAT'd laptop work at all — it should not be
uncommitted while six phases are built on top of it.

**Gate:** the phone appears in the console, takes a WebDriver session, installs an APK, and returns
to `READY` after a reset — **through the tunnel**, with no `APPIUM_ADVERTISE_HOST` set.

**Expect to find things.** Last contact with this handset produced six defects that 197 green tests
had missed, one of which meant no phone could enroll on macOS at all. `resetToSnapshot` has never
run against a real phone in a real session; `deploy/verify-physical.mjs` reports its blast radius
without clearing anything, and **it must not be pointed at a daily driver.**

---

## S1 — Spike: an iPhone on this Mac

Days, and it replaces ADR-0010's signing spike outright.

**Do:** plug the iPhone in, trust the Mac, and get one WebDriver command through it via Appium's
XCUITest driver against the paid team ID. Then check whether `ffmpeg -f avfoundation` enumerates the
device and emits H.264 — a plugged-in iPhone is an AVFoundation capture source on macOS, which is
what QuickTime's screen recording uses, and it is the same subprocess-and-NAL shape `capture.ts`
already consumes from scrcpy.

**Deliverable besides the answer:** ADR-0013, recording the macOS-first narrowing and what
un-narrows it.

**Gate:** the WebDriver command returns, and `ffmpeg` produces NALs. If the second half fails,
`quicktime_video_hack` is the fallback and P4's live view grows by a couple of days — it does not
change the shape of anything.

---

## S2 — Spike: can the agent be a WebRTC peer?

Spike 3 proved Node can *packetize* fast enough (0.8% of a core). It explicitly did **not** cover
SRTP encryption, the actual send, or a real handset. That is what remains unproven.

**Do:** `werift` — pure TypeScript, no native build, which is the entire point on a stranger's
laptop — fed by the existing splitter from a real scrcpy stream, rendered in a `<video>` in Chrome.

**Gate:** a moving phone screen in a browser, with the glass-to-glass latency **measured and written
down**, not described as "responsive".

---

## P1 — The window

**Build:**
- An HTTP server on `127.0.0.1` in the agent, serving a small web app. Third server in the process;
  `gateway.ts` is the pattern. Reuse `console.css` — the design system already exists.
- **Security, in the first commit, not retrofitted:** loopback bind; a session token minted at
  start-up, passed in the URL the agent opens, never persisted; `Origin` **and** `Host` validated on
  every request. All three, for the reasons in ADR-0009 §3 — a localhost server is reachable by every
  process on the machine *and* by every website the user visits.
- The device list: everything discovery and the health monitor already know — model, OS, serial,
  state, and the human remedy for each unusable adb state. **None of this is new computation.**
- Live updates. SSE or poll; somebody watching a device boot should not have to refresh.

**Gate:** plug a phone in with the window open and watch the row appear. Unplug it, watch it go.
Leave it unauthorised and read the instruction that tells you to tap Allow.

---

## P2 — Pairing, and per-device sharing

**Build:**
- **Sign-in:** a pairing code shown in the console, exchanged by the agent for the `mae_` enrollment
  token the API already mints. The credential model does not change — this is a front end onto
  something already correct. It also retires the two-step `curl` with a session cookie and a CSRF
  header that is the only way to enroll a host today.
- Credentials into the macOS Keychain, `0600` file fallback.
- **Discovered is not shared** (ADR-0009 §2). The one behavioural change to existing code: today
  everything discovery finds is registered. A per-device toggle, **off by default**, reversible
  instantly.

**Gate:** on a machine that has never seen MFARM, pair, tick the Android and leave the iPhone
unticked, and see exactly one device in the console. Untick it and watch it leave.

---

## P3 — Live view, Android

Half-built: capture exists, throughput is cleared, and S2 has proved the peer. What remains is
wiring and the viewer.

**Build:** the werift peer in the agent; signalling over the data-plane socket the browser already
holds (ADR-0007 built that relay and it passes frames through opaque); `screen-stream` and
`input-datachannel` advertised for physical devices; the viewer reusing `live.js`.

**Note what this unlocks beyond the screen:** those two capabilities are what make a physical device
*interactive* rather than automation-only. Today the console tells the truth — a real device shows no
screen and takes no taps.

**Gate:** open the Samsung in the console, tap something, and have it respond. Publish the latency.

---

## P4 — iOS as a first-class device

**Build:**
- An iOS backend behind the existing `DeviceControl` interface — `go-ios` sits exactly where `adb`
  sits. Discovery, metadata, hot-plug.
- App install and launch; WDA lifecycle supervised the way `appium.ts` supervises UiAutomator2.
- The WebDriver proxy into the existing automation gateway. The hub already speaks WebDriver and
  ADR-0011's tunnel path is platform-agnostic.
- The live view, via the capture source S1 chose. **One implementation, already built in P3.**
- **Provisioning profiles as product work.** Expiry is explained, never reported as a device fault.

**Gate:** an iPhone and the Samsung, on the *same* Mac, both in the console, both running a suite,
both showing a live screen.

---

## P5 — The devices tab

The console's device list was designed for a homogeneous pool of virtual devices. After P2 and P4 it
is showing two platforms, two tiers, and two kinds of ownership — devices in the shared pool, and
devices somebody is lending from the laptop in front of them.

**Build:** physical devices grouped by their agent host; which host, and whether it is online;
sharing state, changeable from the console as well as the window; entry to the live screen;
provisioning-profile status for iOS. The REAL/VIRTUAL tag and filter already exist and stay.

**Gate:** somebody who did not build this can look at the page and say which phone is on whose desk.

---

## P6 — Ship it

**Build:** a single executable via Node SEA (stable since Node 22 — ADR-0009 §4), signed with
Developer ID and notarised. Automation runtime fetched on first use with visible progress, not
bundled — somebody who only wants to *look* at a device should not download a couple of hundred
megabytes of driver. `--install-service` behind a flag.

**The scheduling risk here is already retired.** ADR-0009 warned that certificates take weeks and
would become the critical path if started at this phase. The paid Apple account is active, and a
Developer ID Application certificate is self-service — so this is a short phase rather than a wall.

**Gate — the one that matters, unchanged from ADR-0009:** someone who has never seen MFARM, on a
machine we do not control, plugs in a phone and sees it in the console **inside two minutes, without
typing a command or entering a password.**

---

## If you need a demo sooner than the whole plan

**P0 → S1 → P1 → P2**, roughly two weeks, gives: download nothing, run the agent, a real window
opens, sign in with a pairing code, tick one of two phones, and it appears in the console and runs a
suite. No live screen, no iOS automation depth, no signed binary — the demo is a terminal launch of a
GUI, which is a very different thing from a terminal *product*.

That is the shortest path to something a stranger can be shown. Everything after it is the
difference between a demo and a product.

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
