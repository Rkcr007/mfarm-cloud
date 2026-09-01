---
id: ADR-0020
title: The farm absorbs its own infrastructure retries — one user request is one user attempt
status: Accepted
date: 2026-09-02
authors:
  - Claude Code
tags: [metering, accounting, execution, attempts, reliability]
extends: [ADR-0018]
---

## Context

A user asks for a device once. If the emulator goes unhealthy, adb drops, or a handset falls off the
end of its cable, MFARM recovers and carries on — and nothing anywhere recorded that it happened to
*that request*. Three questions had no answer:

- how many times did a user actually ask for something?
- how many times did MFARM have to try again to serve one of those asks?
- which device made it have to?

`AutomationExecutionPlan.md` §33 and §35 name the shape — `Execution → ExecutionAttempt → Device`,
*"because an execution may require an infrastructure retry without becoming a new user-visible test
run"* — and §34 adds the rule that only infrastructure failures may trigger automatic recovery,
because retrying a failed test manufactures a false green.

Worth stating plainly, because it changes what this ADR is: **MFARM had no double-counting bug.** The
CLI's retries are idempotency-keyed, and reset recovery happens in `CLEANING` after the session has
already ended and stopped metering. The invariant held *by absence*. What was missing was the ledger
that makes it observable and keeps it holding once the farm starts retrying on the user's behalf —
which ADR-0019 has just given it a reason to do.

## Decision

**One logical user request is one user attempt. Every retry MFARM performs to recover its own
infrastructure is a separate attempt that the farm absorbs.**

`session_attempts` (migration 033) holds one row per attempt at serving a session, with `origin`
(`user` | `infra-retry`), the device, the outcome and a reason drawn from migration 024's vocabulary.
A session **is** the execution: it is one user's logical request for a device, so the attempt hangs
off it rather than off a new table duplicating what `sessions` already is.

### The invariant is an index, not a convention

```sql
CREATE UNIQUE INDEX session_attempts_one_user_idx
  ON session_attempts(session_id) WHERE origin = 'user';
```

A second user attempt on one session is not a bug that shows up in a report later — it is a
constraint violation at the moment somebody writes the code that would have caused it. A rule that
lives only in application code is a rule until the second caller.

### This is not billing

`metering_events` and `usage()` are untouched. The tenant is still metered in `device_seconds` for
the time it held a device, which is the right unit and a different question. Nothing in
`session_attempts` is a price, a credit or a charge. `GET /v1/account/usage` returns both, kept
apart, because conflating them is how a diagnostic number becomes an invoice nobody can defend.

### The farm never claims anything about a test

There is deliberately **no `test-failure` outcome**. The farm watches a session drive a device; a
passing test and a failing one look identical from here. Only the suite can classify its own results
and it does, in `test_results` (migrations 021 and 024). `record_infra_retry` raises on any outcome
that is not an infrastructure failure — §34 in code, so a future caller cannot quietly retry a failed
test.

### Closing is a sweep, not a call on each end path

A session ends in at least four places: the tenant's `DELETE`, the TTL, the idle-WebDriver reclaim
from migration 029, and a host quarantine taking the device back. A close bolted onto each is four
things to keep in step plus the fifth somebody adds later without one — and the symptom would be an
attempt that stays open forever, reading as "the farm is still trying" when it stopped hours ago. The
reaper closes any attempt whose session has ended, whatever ended it.

## Consequences

- A device incident during a live session closes the failed attempt and opens an `infra-retry`.
  `userAttempts` does not move; `infraRetries` and `deviceFailures` do.
- Idempotent re-sends do not inflate the count. The agent buffers incidents and flushes on
  reconnect, so one pulled cable arriving thirty times is the designed case; the retry is recorded
  only for an accepted (non-duplicate) incident.
- `deviceReliability` answers "how often does this device fail", tenant-scoped under RLS. The
  fleet-wide view of the same hardware stays on the operator surfaces in `metrics.ts`.
- A `timeout` or `idle_timeout` end is **`succeeded`**, not a failure: the farm delivered a device
  and the lease ran out. Calling those infrastructure failures would make every well-behaved CI run
  look like a farm incident and the device-health numbers would be noise within a day.

## Alternatives rejected

- **Counters on the runs rollup.** Cheaper to query, but loses which device caused which retry — so
  it could not answer the §2 device-health question at all.
- **A meter-level guard only** (assert infra recovery never reaches `metering_events`). Smallest
  change, but "how many user attempts" stays implicit rather than a recorded fact, and nothing stops
  a future retry path from becoming a second user attempt.
- **A separate `executions` table.** Duplicates `sessions`, which is already the execution.
