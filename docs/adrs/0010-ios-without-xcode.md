---
id: ADR-0010
title: iOS devices arrive on every host, because WebDriverAgent is built once and installed anywhere
status: Accepted
date: 2026-08-25
authors:
  - Claude Code
tags: [ios, physical-devices, agent, cross-platform, signing]
supersedes: []
extends: [ADR-0008, ADR-0009]
---

## Context

The owner's requirement is that the host operating system stops mattering: a person on Windows may
plug in an iPhone, a person on a Mac may plug in a Pixel, and MFARM should not care.

The reflexive answer is that this is impossible — physical iOS automation needs Appium's XCUITest
driver, which needs WebDriverAgent, which needs Xcode, which is macOS-only. **That answer was given
in this project and it was wrong**, which is the reason this ADR exists rather than a line in a plan:
a conclusion that narrows the product by a quarter should be recorded with its reasoning so it can
be checked, and this one did not survive being checked.

The error was conflating two different things: **building** WebDriverAgent, and **running** it.

## Decision

**iOS is supported on macOS, Windows and Linux hosts. WebDriverAgent is built once by us and
installed anywhere.**

Four pieces cover what Xcode would otherwise do, and each lands on an abstraction the agent already
has — which is why this is ordinary work rather than a second product.

| Need | Tool | Where it fits |
|---|---|---|
| Discover the device, install and launch apps, **run WebDriverAgent** | `go-ios` | Sits where `adb` sits: a device backend behind the existing `DeviceControl` interface |
| Drive the device from a test | WebDriverAgent itself | WDA **is** a WebDriver server. The automation gateway already proxies WebDriver; iOS occupies the slot Appium occupies today |
| See the screen | `quicktime_video_hack` | Emits **raw H.264 NAL units** over USB — exactly what `capture.ts` already consumes |
| Sign WDA for a customer's device | `zsign` | Cross-platform re-signing from a `.p12` and a `.mobileprovision`. New, and the least proven link |

Appium's XCUITest driver is deliberately **not** in that list. It is a convenience layer over WDA
and it drags the macOS assumption back in. Talking to WebDriverAgent directly is less machinery, not
more, because the hub already speaks WebDriver and the gateway already proxies it.

The third row is the happy accident worth naming. The capture layer written for Android under
ADR-0008 — a stateful Annex-B splitter feeding an RTP packetizer measured at under 1% of a core — was
designed for scrcpy with no thought of iOS, and is exactly the right shape for an iPhone. **The live
view is one implementation covering both platforms**, not two.

## What genuinely still requires a Mac

One thing, once, on our side: **building the WebDriverAgent `.ipa`**. That needs Xcode. It does not
need to happen on the user's machine, or per customer, or per device — it is a build artifact
produced by one Mac runner in CI, per release, and re-signed thereafter.

**What the customer needs is an Apple Developer account and their device UDIDs in a provisioning
profile.** That is Apple's rule for installing anything onto a physical iPhone and it applies
identically on a Mac — it is not a Windows penalty. It is also where people will get stuck, so it is
product work rather than setup: the enrollment flow has to walk somebody through it, and the agent
has to say clearly when a profile has expired rather than reporting a device that mysteriously
stopped working.

## Consequences

- **One Mac in CI becomes infrastructure**, and that single machine is what buys every customer the
  freedom to be on Windows. If it goes away, iOS releases stop.
- **A signing step enters enrollment**, which no other platform needs. It is the first place MFARM
  handles a customer's signing identity, and it should be treated with the care that implies —
  a `.p12` is a credential.
- **Signatures expire.** An iOS device that worked last quarter can stop working with no change on
  our side. The agent must detect and explain this, and the console must not report it as a device
  fault.
- **These are third-party tools**, verified from current project documentation in August 2026 rather
  than by running them here. Each is a spike before it is a commitment, and the order matters — see
  below.

## Verification

**Spike signing first, before any iOS work is scheduled.** Build WDA once on a Mac, re-sign it with
`zsign` on a non-Mac, install it onto an iPhone with `go-ios`, and get one WebDriver command through
to the device. Days, not weeks.

It is the only link in this chain nobody has already proven for us — `go-ios` running WDA and
`quicktime_video_hack` streaming H.264 are both documented, used in production device farms, and
not in doubt. If signing holds, iOS is ordinary work. If it does not, the whole shape changes, and
it is far cheaper to learn that in week one than in month three.
