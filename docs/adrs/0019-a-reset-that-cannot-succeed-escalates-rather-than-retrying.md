---
id: ADR-0019
title: A reset that cannot succeed escalates, and escalated is not quarantined
status: Accepted
date: 2026-09-02
authors:
  - Claude Code
tags: [lifecycle, recovery, reset, devices, reliability]
extends: [ADR-0012]
---

## Context

A device goes to `CLEANING` when its session ends and leaves only when a worker confirms the
restore. The heartbeat re-offers every `CLEANING` device on **every beat**, which is what makes a
missed or failed reset self-healing — and is also an unbounded retry loop. When the agent's reset
throws it logs and reports nothing, so the device stays `CLEANING` and is offered again ten seconds
later, forever. A device that can never reset silently leaves the pool and the farm keeps trying
until somebody notices the capacity is gone.

`AutomationExecutionPlan.md` §11 is explicit that every recovery mechanism needs a retry count, a
timeout, a backoff and a terminal state. This one had none of the four.

The obvious fix — quarantine the device after N failures — is wrong in a way worth writing down.

## Decision

**A reset gets a bounded budget of counted attempts (default 3). Exhausting it sets an ESCALATED
condition on the device, which stops the offers and requires a human to clear.**

Three parts, each of which was a decision:

### An attempt is not a heartbeat

The counter is **not** incremented by the offer. Counting per offer would make the budget a function
of how often the host beats — six beats a minute burns a three-attempt budget in thirty seconds —
and a slow-but-succeeding reset would escalate while it was still working. A powerwash measured
40–80s on real hardware.

So an attempt is counted when a reset has been **outstanding longer than it should take**, observed
by the reaper on its own clock (`RESET_ATTEMPT_TIMEOUT_MS`, default 180s). The timeout must elapse
*again* from the last counted attempt before another is counted, which is §11's backoff expressed as
the thing it actually means. The heartbeat carries on offering while budget remains, so the
self-healing that made re-offering worth having is unchanged.

### Escalated is a condition, not a state

Exhausting the budget does **not** set `state = 'QUARANTINED'`, and does not add a `device_state`
enum value either.

- `device_state` is a Postgres enum from migration 001, so a new value cannot be added and used in
  the same transaction (the trap 019 wrote down and 022 paid for).
- More importantly, **`CLEANING` already means "not allocatable"**, which is exactly what an
  escalated device must remain. It is dirty, it may still hold the last tenant's data, and the one
  thing that must never happen is handing it to somebody.
- Quarantining would **also stop the heartbeat offering it a reset**, which is the only thing that
  could ever fix it. A quarantine here would be a state a device could never leave.

So the device stays `CLEANING`, stops being offered, and carries why and when.

### Clearing it is a deliberate act by a person

`POST /v1/devices/:id/clear-reset-escalation` requires a signed-in **owner or admin**, following the
role check `routes/account.ts` already established. Deliberately not the worker and not a bare API
key: the heartbeat is what exhausted the budget, so letting that path clear it would rebuild the
unbounded loop one indirection further away, where nobody would find it. A CI key clearing it on
every run would turn a terminal state back into an infinite retry with extra steps.

The budget is **per recovery, not per lifetime**: a successful reset zeroes it. Carrying the count
forward would retire a healthy device after three bad days spread over a month.

## Consequences

- A device that cannot reset costs the farm its capacity **once**, visibly, instead of consuming a
  reset attempt every ten seconds for the life of the process.
- `device_reset_attempts` records every counted attempt with its outcome and time, which is what
  makes "how often does this device fail" answerable (§2).
- The console shows the condition on `/v1/devices` and `/v1/devices/:id`, and the history on
  `/v1/devices/:id/reset-attempts`. A healthy fleet's payload is unchanged — the field is absent
  rather than null — so no existing reader gains a shape to handle.
- **A hosted fleet would need a fleet-operator role.** Shared devices belong to no org, so any org's
  admin can clear one. That is honest for a self-hosted farm where the tenant *is* the operator, and
  it is the one thing here that does not generalise. Do not infer a fleet-operator model from it.

## Alternatives rejected

- **Quarantine after N failures.** Stops the only mechanism that could recover the device. See above.
- **Count an attempt per heartbeat offer.** Makes the budget a function of beat frequency.
- **Let the worker clear its own escalation.** Rebuilds the unbounded loop.
- **No bound at all (the status quo).** Violates §11, and the failure is silent capacity loss.
