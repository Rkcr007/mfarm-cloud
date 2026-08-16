---
id: ADR-0003
title: Capability honesty — a host advertises `webdriver` only while a supervised Appium is actually ready
status: Accepted
date: 2026-08-16
authors:
  - Ruflo swarm (hierarchical) via Claude Code
tags: [worker, appium, webdriver, capabilities, supervision]
---

## Context

The WebDriver hub in `apps/api` is complete and tested. The worker half is not. Today the agent
reads `AUTOMATION_ENDPOINT` from the environment and, if it is set, declares the `webdriver`
capability (`workers/agent/src/agent.ts`). Nothing checks that anything is listening there.

So the capability flag is a **manual promise**. If an operator sets the variable and Appium is not
running — never started, crashed at 3am, wedged — the host keeps advertising `webdriver`, the
allocator keeps routing real tenant sessions to it, and every one of them fails at the proxy hop.
The control plane has no way to know, because from its side an unreachable upstream is
indistinguishable from a slow one.

This is worse than having no automation support at all: allocation consumes a device, the failure
surfaces to the customer as a broken session rather than a queue, and `promote_queued()` will
cheerfully feed the same dead host again.

## Decision

**A capability is a claim about observed present state, not about configuration.**

**1. `AppiumSupervisor` owns the process lifecycle** — spawn, readiness, crash detection, restart,
stop — in `workers/agent/src/appium.ts`.

**2. Readiness is `GET /status` answering, not the process having spawned.** Appium takes seconds to
bind. Reporting ready on spawn means the first session after every start and every restart fails.

**3. `automationEndpoint` is derived from the supervisor's actual bound address, and only once it is
genuinely ready.** When the supervisor is unhealthy the host **withdraws** the `webdriver`
capability rather than advertising a lie. Withdrawal is the entire point of this ADR: the allocator
already respects `requireCapabilities`, so an honest flag routes traffic away from a broken host
automatically, with no new control-plane machinery.

**4. Appium binds 127.0.0.1 only.** An internet-facing Appium port is unauthenticated device
control — a stranger with the address gets a shell-equivalent on the device. The hub is the sole
ingress, and it is the only component that knows about tenants. This is the same reasoning that
justified the hub proxying the data plane at all.

**5. Restart uses exponential backoff with a give-up threshold, after which the supervisor is
permanently unhealthy.** A supervisor that restarts forever converts a broken dependency into an
infinite crash loop that burns the host and never signals. Giving up *is* the signal: the capability
stays withdrawn until a human looks.

**6. Ports are derived per device local id.** One Appium per device, so a multi-device host does not
have every device fighting over 4723.

**7. A manually-set `AUTOMATION_ENDPOINT` remains an escape hatch** for an externally-managed
Appium. It keeps its current unverified semantics — the operator is asserting the promise
themselves, and that is a deliberate, documented choice rather than the default.

## Consequences

**Positive.** The `webdriver` capability becomes trustworthy. A crashed Appium degrades to reduced
capacity — the correct behaviour — instead of a stream of failed sessions. The hub's existing
`no_automation_endpoint` error becomes a rare configuration case rather than the symptom of a dead
process.

**Negative.** The agent now supervises a child process it does not own and whose CLI it does not
control. Appium's flags move between major versions; this is the same class of exposure already
recorded for `cvd` flags in `devices/cuttlefish.ts`.

**Negative — and this paragraph was wrong as first written.** It claimed withdrawal is "only as fast
as the heartbeat that carries it." **The heartbeat carries no capability payload at all.**
`agent.ts` computes capabilities exactly once, at registration, and `heartbeat()` never revisits
them. So decision 3 is implemented only for *permanent* failure, where the agent withdraws by
exiting the process.

For a **transient** crash the supervisor goes `backoff` → `starting` → `ready` with no notification,
and the host keeps advertising `webdriver` throughout. At default settings — failure 3 of 5, 4s
backoff, ~30s cold start — that is roughly **35 seconds** during which the allocator keeps routing
WebDriver sessions to a host with no Appium, each one consuming a device and failing at the proxy
hop.

And "bounded by the give-up threshold" was still too generous. The threshold counts **consecutive**
failures, and `stableAfterMs` (120s) resets the counter — so a host that loses Appium every few
minutes never reaches give-up at all. **The lie was unbounded, not merely minutes long.**

That is the exact failure this ADR was written to prevent, so decision 3 was **not** implemented at
first writing.

### Why re-registration is not the fix

`/workers/register` upserts `capabilities` and `automation_endpoint` on conflict, so it looks like
the obvious withdrawal path. It is a trap: the same statement forces `state = 'UP'` and clears
`quarantined_at` / `quarantine_reason`. An agent that re-registered whenever Appium flapped would
**repeatedly un-quarantine a host the control plane had deliberately taken out of service.** It also
mints a fresh worker token per call and requires keeping `WORKER_REGISTRATION_TOKEN` hot for the
process lifetime, directly against the environment-allowlist hardening. Silently defeating
quarantine is a worse bug than the one being fixed.

### What is implemented, and what the protocol still needs

Implemented: the supervisor fires `onHealthChange` from a single state writer, and a sustained
unhealthy period (`APPIUM_UNHEALTHY_GRACE_MS`, default 60s) makes the agent **drain and exit
non-zero** if it had advertised `webdriver`. The process supervisor restarts it and it re-registers
truthfully. That is a real withdrawal, but it is blunt — it takes the host's interactive sessions
with it — and the grace exists so an ordinary Appium restart does not bounce the agent.

The clean fix is a protocol change, **not yet made**:

1. `packages/protocol` gains
   `WorkerHeartbeat { protocolVersion, capabilities, automationEndpoint? }` — the shape `agent.ts`
   already sends today, where it is inert because the heartbeat route never reads its body.
2. `apps/api` types the heartbeat route to it and updates `hosts.capabilities` /
   `hosts.automation_endpoint` and the per-device capability rows from it — **without touching
   `state` or the quarantine columns.** That separation is the entire point: a capability update
   must never be able to clear a quarantine.

With those, the window becomes one heartbeat interval (~10s) and the drain-and-exit fallback can
relax or disappear.

**Unverified — stated plainly.** No real Appium 2 server, and no real Android device, exists in the
environment where this was written. The supervision *state machine* is tested against a fake that
can answer, hang, and crash on command. What is **not** verified: real Appium's actual startup time,
its flag surface, its `/status` payload, its behaviour under SIGTERM, and whether the hub's proxy
expectations match a real driver's responses. `HANDOFF.md` already records that the hub has only
ever spoken to a stub. **Both halves remain unproven against reality until the hardware gate
clears.** Nothing in this ADR should be read as closing that gap.

## Open blockers found during implementation

Three conflicts between this ADR and the existing hub surfaced only once the supervisor was built.
**All three need a decision before the hardware session, not during it.**

**B1 — RESOLVED by ADR-0004.** The transport is the worker's own listener, authenticated per request
by a short-lived Ed25519 grant the worker verifies offline with the public key it already holds at
registration — not a private network, which would authenticate the packet rather than the request and
let any peer drive any device. Decision 4 stands unchanged: Appium stays on `127.0.0.1`, and only the
agent's gateway may reach it. The control-plane half is implemented and tested; the gateway itself is
the next piece of work on the worker. The original blocker, unedited:

**Loopback binding and hub reachability are in direct conflict.** Decision 4 says Appium binds
`127.0.0.1`. But the hub calls `fetch(automation_endpoint + '/session')` *from the API process*, so a
loopback-bound Appium is unreachable — the control plane would be dialling itself. Both halves are
individually correct and they only compose if something private terminates on the worker and
forwards to loopback: WireGuard, mTLS tunnel, SSH forward. **No such transport exists anywhere in
this repo or in the deployment story.** The implementation binds loopback unconditionally and splits
the advertised address into `APPIUM_ADVERTISE_HOST`, which names that tunnel without loosening the
bind — so the shape is right and the transport is missing. As it stands `APPIUM_ENABLED=1` produces
a host the hub cannot reach. **This is a deployment-architecture decision, and it is now the
critical path for WebDriver on real hardware.**

**B2 — `automationEndpoint` is host-level, so per-device Appium is not expressible.**
`WorkerRegistration` carries exactly one endpoint, `hosts.automation_endpoint` stores one, and
`agent.ts` stamps `webdriver` onto *every* device the moment it is set. On a two-device host both
devices advertise the capability and both route to whichever single server was advertised.
Decision 6 (per-device ports) is implemented and correct in `appium.ts`, but cannot be *advertised*.
The agent therefore **refuses to start Appium when a host has more than one device**, directing the
operator to the manual `AUTOMATION_ENDPOINT` escape hatch — the only shape today's protocol can
describe honestly. The real fix is moving `automationEndpoint` onto the device in the registration
payload, which is a protocol change.

**B3 — `appium:udid` is set to the mfarm local id, which is not an adb serial.**
`webdriver.ts` sets `upstreamCaps['appium:udid'] = target.local_id` (`cf-1`, `avd-1`), but
UiAutomator2 matches `udid` against the adb serial (`emulator-5560`, `0.0.0.0:6520`). Overriding the
capability is right — a client choosing its own udid is choosing another tenant's device — but the
*value* is wrong and a real driver will reject or mis-target it. The worker would need to register
the adb serial alongside the local id. **Expect this to be the first thing that breaks on real
hardware.**

Related: with one Appium fronting multiple devices, concurrent sessions each need a distinct
`appium:systemPort` — UiAutomator2 defaults every session to 8200 and the second one fails. Nothing
sets it, and only the hub knows which device it allocated.

## A gap this ADR does not close

The supervisor detects **process death only.** A live Appium whose driver is wedged keeps answering
`/status` with 200 and stays `ready` forever — so the capability stays advertised and sessions keep
failing, which is precisely the failure this ADR set out to prevent, one level deeper. Catching it
needs a probe beyond `/status` (periodic `GET /sessions`, or an adb liveness check correlated with
the device backend's own `health()`). Deliberately not built: it cannot be calibrated without a real
wedge to observe.

The backoff defaults (1s→60s cap, 5 restarts, 120s stability reset) are likewise guesses. Real
numbers come from watching a real cold start on the bare-metal box.

## Verification

```bash
cd workers/agent && node --test --experimental-strip-types test/appium.test.ts
```

Covers: ready only after `/status` answers; restart after crash; backoff growth; give-up threshold
leaving `healthy()` false and keeping it false; `stop()` killing a hung process; distinct ports per
device.

## Related

- `HANDOFF.md` — "The Appium server on the worker" under What is NOT built, and the spike gate
- `apps/api/src/http/routes/webdriver.ts` — the hub, and its `no_automation_endpoint` path
- `workers/agent/src/agent.ts` — where `automationEndpoint` becomes the `webdriver` capability
- `ADR-0001` — the same "refuse rather than pretend" principle applied to service startup
