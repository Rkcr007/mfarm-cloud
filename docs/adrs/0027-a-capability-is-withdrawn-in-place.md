---
id: ADR-0027
title: A capability is withdrawn in place, and only an arriving device re-registers
status: Accepted
date: 2026-09-06
authors:
  - Claude Code
tags: [agent, appium, capabilities, protocol, availability]
extends: [ADR-0003]
---

## Context

ADR-0003 decision 3 says an unhealthy Appium supervisor must withdraw `webdriver`, so that a device
never advertises what it cannot serve. Its "What is implemented, and what the protocol still needs"
section then records how that was achieved *at the time*:

> a sustained unhealthy period (`APPIUM_UNHEALTHY_GRACE_MS`, default 60s) makes the agent **drain
> and exit non-zero** if it had advertised `webdriver`. […] That is a real withdrawal, but it is
> blunt — it takes the host's interactive sessions with it […]
> The clean fix is a protocol change, **not yet made**.

**The protocol change was made on 2026-09-01.** `POST /workers/heartbeat` began reading the
per-device automation map the agent had always been sending: an endpoint that disappears from
`devices` strips `webdriver` from that device, one that appears puts it back, and a device the beat
does not mention at all is treated as unfronted. It never touches `state` and it is host-scoped.
`http.test.ts`'s "heartbeat: per-device automation is reconciled on every beat" covers all of it.

**Nothing removed the blunt withdrawal, and the comment justifying it outlived the constraint.**
`index.ts` went on reading "capabilities are written at registration only, so one device's
`webdriver` cannot be withdrawn without re-registering the host. […] That needs the heartbeat to
carry capabilities." It carried them already.

### What that cost, on 2026-09-05

Appium for `cf-4` exited. The grace window expired. The agent drained — which stops **every** backend
on the host and cold-boots all of them — and took thirteen minutes to come back. During that window
the host sent no heartbeats and performed no resets, so the control plane counted three stalled
reset attempts against a device nobody had offered one to and **escalated it out of the pool**, where
it needed a human to clear it. Twice in thirty minutes.

Three mechanisms interacted, each individually reasonable: an availability guard (ADR-0003), a
liveness guard (migration 016) and a retry budget (migration 032).

## Decision

**An unhealthy automation server withdraws its device's capability in place, and the agent does not
restart for it.**

1. `onHealth` calls `setAutomationEndpoint(localId, undefined)` — which it always did — and stops
   there. The next beat, at most ten seconds away, strips `webdriver` from that device alone.
2. **No grace window.** `APPIUM_UNHEALTHY_GRACE_MS` is removed. A window was only ever a hedge
   against the cost of withdrawing; withdrawal now costs one field in a beat that was being sent
   anyway. A device whose Appium is restarting genuinely cannot serve WebDriver for those seconds,
   and ADR-0003 exists to say so rather than to round it down.
3. **A permanent Appium failure does not drain either.** The device keeps install, launch, logcat,
   screenshot, the live view and the data plane — none of which need Appium. Removing the whole host
   because one device's automation server will not return is a larger outage than the capability it
   was protecting.
4. **Recovery needs no restart.** A device that registered *without* `webdriver` because its Appium
   was slow now gains it on the beat that carries its endpoint. The old "restart the agent to start
   taking WebDriver sessions on it" warning is deleted; it described a constraint that no longer
   exists.

**What still drains and exits, deliberately: a device ARRIVING.** `hosts.capabilities` and the device
list are written by `POST /workers/register` and by nothing else — the heartbeat reconciles devices
it already knows, it cannot create one — so a newly plugged phone still becomes visible by
re-registering. The USB hot-plug path is unchanged, as is the drain for a sharing change.

## Consequences

- One device's Appium failure now costs that device's `webdriver` for as long as it is down, and
  nothing else. No cold boot, no interrupted sessions on sibling devices, no gap in resets.
- Withdrawal is faster and more honest: ~10s rather than 60s, and per device rather than per host.
- The reset-budget interaction that migration 038 guards against becomes rare rather than routine.
  038 stays: it is the correct rule regardless of how often a host goes quiet.
- `agent.test.ts` gains the end-to-end assertion this deletion rests on — an endpoint withdrawn at
  runtime strips `webdriver` from that device only, the sibling is untouched, the device stays
  READY, and it all comes back on a later beat.

### Rejected

**Keeping a short grace window.** It would re-introduce a period in which the fleet advertises a
capability it cannot serve, to save a few seconds of correct unavailability. ADR-0003's whole
argument is that the second thing is not a cost worth paying for the first.

**Leaving the drain as a fallback for the permanent case.** "Permanent" is the supervisor's own
judgement after five restarts; it is not evidence that the DEVICE is unusable, and every other
capability on it still works.

**A new ADR superseding ADR-0003.** Its decision — capability honesty, enforced by the agent — is
unchanged and correct. Only the mechanism its implementation notes describe is obsolete, so this
extends it rather than replacing it.
