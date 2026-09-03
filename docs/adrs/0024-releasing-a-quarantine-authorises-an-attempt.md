---
id: ADR-0024
title: Releasing a quarantine authorises an attempt, not an availability
status: Accepted
date: 2026-09-04
authors:
  - Claude Code
tags: [lifecycle, recovery, quarantine, devices, operations, reliability]
extends: [ADR-0019]
---

## Context

`QUARANTINED` has been a device state since migration 001, and at the device level it has only ever
been something that *happens to* a device. `quarantine_host` collapses a silent host's fleet into it
(migrations 003, 016); the only ways out are the host beating again or a worker re-registering.
There was no way to quarantine one handset, nothing recorded **why** a device was quarantined —
`quarantine_reason` existed on `hosts` and never on `devices` — and no operator action of any kind.

So `AutomationExecutionPlan.md` §30's `[Recover Device]` had nowhere to land, and the obvious
implementation of it is one statement:

```sql
UPDATE devices SET state = 'READY' WHERE id = $1;
```

That is a button which puts a broken handset back into the allocation pool on an operator's
optimism. The device failed its health checks. A human deciding to look at it is not evidence that
anything about it has changed, and the next tenant discovers the difference.

There is a second problem underneath it. ADR-0019 rejected "quarantine after N failures" for a
reason that was correct at the time: **quarantining stops the heartbeat offering the device a
reset, which is the only thing that could fix it.** A device-level quarantine was therefore a state
a device could never leave, which is why escalation became a condition on `CLEANING` instead.

## Decision

**Release means "I am authorising this device to attempt recovery". Only a completed reset *and* a
passing health check, reported by the host that owns the device, earns `READY`.**

```text
QUARANTINED --(operator releases)--> PREPARING --(reset + health check)--> READY
                   ^                                    |
                   +-------------(either fails)---------+
```

### PREPARING is a state, not a condition — and this is where ADR-0019 is amended

ADR-0019 chose a condition over a state because `CLEANING` already meant everything an escalated
device needed to mean. Here it does not. A device recovering has to be in a state that **is** offered
resets and **is not** allocatable, and no existing value is both. `QUARANTINED` fails the first,
`CLEANING` fails the second only by accident and would make one word mean two things — "a tenant's
device is being restored" and "an operator's recovery is running" — on every screen, metric and
alert that reads it.

`device_state` is a Postgres enum, so the value is added in migration 034 and used in 035: a new
value cannot be added and used in the same transaction (invariant 6). That is the whole cost of the
workaround, and it is a second file.

**This also makes a device-level `QUARANTINED` safe to enter at all**, which is what changes ADR-0019's
objection rather than contradicting it. There is now a way out, and it runs through `PREPARING`.

### The preparation flow is the one that already exists

Nothing in this change drives a device. The recovery runs down the path that is already the farm's
only tested way to make a device fit for a tenant: the heartbeat offers a reset to the owning host,
the agent restores it, the host reports back. The offer is flagged `recovery: true`, and a recovery
is confirmed through `recoveries` on `POST /v1/workers/events` rather than through `resets`.

A parallel recovery pipeline would be a second, less-exercised way to prepare a device, which is how
the two drift.

### The verdict is a health result, never "the reset returned"

`resetToSnapshot()` resolving means the restore ran. It says nothing about whether the device can be
driven afterwards, and a handset whose USB has gone will fail in exactly that shape. So the agent
probes `control.health()` — the readiness check every backend already implements and the health
monitor already trusts (spec §18) — and, if an automation server was fronting the device *before*
the reset, requires it to be back: `webdriver` is a claim about the present (ADR-0003), and a device
that lost its Appium fails at connect time after a lease is spent.

Probed with a small budget rather than once. A device that has just been restored is legitimately
unresponsive for a moment.

**An agent that predates this gate fails the recovery closed.** It performs the reset it was offered
and confirms it through `resets`; `device_reset_complete` matches on `CLEANING` and rejects it, and
the control plane records a recovery failure whose reason names the agent version. A completed reset
is not evidence a device is fit — that is the entire claim — so the fail-closed answer is the honest
one, and the reason says what to do about it rather than blaming the device.

### Three ways in, and only one of them self-clears

`devices.quarantine_source` splits the exits, the way migration 016 split them for hosts:

| source | meaning | exit |
| --- | --- | --- |
| `host` | cascaded from `quarantine_host` | clears when the host beats again |
| `operator` | a person took it out of service | release only |
| `health` | it failed a health check, or failed a recovery | release only |

The registration upsert and the withdrawal sweep in `routes/workers.ts` are both taught to leave
`operator` and `health` alone. Without that, **unplugging a quarantined phone and plugging it back in
would return it to the pool**: registration promotes `QUARANTINED` to `READY`, and the withdrawal
demotes it to `OFFLINE`, from which the next good registration promotes it anyway.

### A recovery nobody finishes ends by itself

`expire_stalled_recoveries` is §11's terminal state reached without anybody reporting anything: a
host asked to recover a device and then powered off would otherwise leave it `PREPARING` for the life
of the database — precisely the state ADR-0019 refused to build.

One window (`RECOVERY_TIMEOUT_MS`, 600s), not a counted budget. In 032 an attempt was one offer among
many on a device that might yet succeed alone; here the whole recovery is a single authorised attempt
with a person behind it. The heartbeat re-offers the reset every beat inside the window, so the
retries are real, and when it closes the honest report is "nobody confirmed this" rather than
"attempt 3 of 3 timed out".

### Every transition is written down

`device_quarantine_log` is append-only and answers, for any device: who released it, when, what it
was quarantined for, what the preparation and health check reported, and where it ended up. The
actor's **email is copied into the row**, not joined at read time — an audit record that says
"user 3f2a…, since deleted" has lost the fact it existed to keep.

It carries a `seq`, because `occurred_at` is not an append order: rows written in one transaction
share it to the microsecond, and a uuid tiebreaker renders a device as released *before* it was
quarantined, intermittently. Found by a flaking test, not by review.

## Consequences

- An operator cannot accidentally return a broken handset to the pool. The console dialog states
  what the release does before the confirm, and the route's response names the resulting state
  (`PREPARING`) rather than only saying `released: true`.
- A quarantined device now says **why**, and which of the two problems it is. The console previously
  described every one of them as "Failed health checks; never scheduled", including a handset whose
  host had simply stopped beating — a sentence that sends somebody to the lab to look at a phone
  that is fine.
- Quarantining ends any live session on the device (`end_reason = 'device_quarantined'`). Removing it
  from *future* allocation is not enough while somebody is still driving hardware that just failed.
- `mfarm_device_preparing_age_seconds_max` is its own series, and `MfarmDeviceRecoveryStuck` watches
  it above the timeout — so the alert means "the reaper has stopped", not "a recovery is slow".
- **A rollback loses judgements, not writes.** The previous release's registration path does not know
  to leave an operator quarantine alone, so a rolled-back farm returns such a handset to the pool on
  the host's next registration. The new CHECK constraint is rollback-safe (recorded in
  `rollback.test.ts`); this is not, and the fix is to roll forward.
- **Reset escalation (ADR-0019) is unchanged and now sits beside this.** An ordinary post-session
  reset that exhausts its budget still stays `CLEANING` with the escalated condition. Only a
  *recovery* — a device already released from quarantine — returns to `QUARANTINED` on failure. The
  two could be unified behind one "authorise an attempt" action later; doing it in this change would
  have altered a shipped endpoint's semantics for no new capability.
- **A hosted fleet still needs a fleet-operator role.** Shared devices belong to no org, so any org's
  admin can quarantine or release one. Honest for a self-hosted farm where the tenant *is* the
  operator; ADR-0019 said the same and it is still the one thing here that does not generalise.

## Alternatives rejected

- **Release sets `READY`.** The button this ADR exists to refuse. It makes the quarantine a pause.
- **A `recovering` condition on `QUARANTINED`, following ADR-0019.** `QUARANTINED` stops the reset
  offers, which are the entire preparation flow, so the device could not recover from inside it.
- **A `recovering` condition on `CLEANING`.** Works mechanically, and makes `CLEANING` mean two
  things on every screen, metric and alert — including `MfarmDeviceResetStuck`, whose text would
  then be wrong for half the devices it fired on.
- **Health-check every reset, not just recoveries.** Better farm, wider blast radius: it changes the
  hot path for every session teardown to fix a problem only the recovery path has. Worth revisiting
  on its own.
- **Let the worker release its own devices.** Turns the quarantine into a pause, one indirection
  further away. Same reasoning as ADR-0019's refusal to let the heartbeat clear an escalation.
- **Automatic quarantine after N device-health incidents (§30's trigger).** Deliberately not built
  here: it needs a threshold and a window, which is its own decision. This change gives that policy
  somewhere to land — `quarantine_device(..., 'health')` — when it is made.
