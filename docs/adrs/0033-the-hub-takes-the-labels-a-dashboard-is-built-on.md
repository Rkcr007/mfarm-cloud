---
id: ADR-0033
title: The hub takes the labels a dashboard is built on, and the outcome through the driver
status: Accepted
date: 2026-09-09
authors:
  - Claude Code
tags: [webdriver, hub, capabilities, execution, allocator, adoption]
extends: [ADR-0011, ADR-0025, ADR-0029]
---

## Context

Open the Runs screen while a suite is running and it showed sessions by uuid. **Which of the two
phones is on *search and view pending expenses*, and which is stuck on an OTP screen?** That is the
first question anybody asks, and the console could not answer it.

The farm HAD the name. `test_results.name` carries it — but only once the suite POSTs a result, which
is after the test finished, and never at all for a test that passed. So for the entire window in
which somebody would act on the answer, every session was anonymous, and a passing test's name was
written down and shown to nobody.

Three more things were missing from the same contract, and they share a cause: **the hub's vendor
namespace had been designed around what the ALLOCATOR needs, not around what a suite already has.**

- The allocator has accepted a device **class** since migration 037, and `POST /v1/sessions` has
  passed `profile` / `matchProfile` since ADR-0025. The hub never did. A WebDriver client could ask
  for a *tier* (`physical`) and not for a *class* (`mfarm-x1-pro`) — invisible on a fleet of one
  kind, and on a mixed one it means a suite pinned to a screen geometry gets whatever was free.
- A run could be joined by id but not labelled, so `mfarm:runId` had to be *either* the CI join key
  *or* the readable name, never both.
- Reporting an outcome required `POST /v1/sessions/:id/result`. That is the better API and can carry
  a stack trace, a duration and a classification. It is also an API a Cucumber `@After` cannot call
  without a new HTTP client, a new dependency and somewhere to put the key — while it already holds
  a driver connected to us.

The comparison that made this concrete: a Java/TestNG/Cucumber suite on LambdaTest sets
`lt:options.name` and `lt:options.build` in its `@Before` and sends `lambda-status` in its `@After`.
Migrating it to MFARM meant losing the labels that made its dashboard readable and rewriting the
teardown. **The hub was asking a customer to give up the two things they already had.**

## Decision

**Four additions to the `mfarm:` namespace, and one script hook. Nothing else about the contract
changes.**

### `mfarm:name` — the test, at session creation

Written to `sessions.name` (migration 048) **before** the app install and before the upstream
`createSession`, deliberately: the session somebody wants named is the one that is hanging, and a
name written after the device answered would be missing from every session worth naming.

### `mfarm:runName` — the readable half of a run, beside `mfarm:runId`

**Two fields, because both are wanted at once and they disagree.** `runId` is the join key back to
CI (`$GITHUB_RUN_ID` — a number, and the only thing that will match the Actions run); the name is
what somebody scans a list for (`Android_UAE_Expenses_08_09_2026_06_53_38`). One field forced to be
both means choosing which of "click through to the CI job" and "find this morning's expenses run"
the customer keeps.

The **first** session of a run sets the name; later ones do not change it. A label that moves under a
reader partway through a run is worse than no label. (`runId` keeps first-stamp-wins for its own,
stronger reason: two ids on one session would file a lease and its cost under a run that did not
incur it.)

**It is not called `mfarm:build`**, which is what `EXECUTION_MODEL.md` §5 had on its wish list. In
MFARM a *build* is an APK in the app library — the word on the Apps screen and a column header on the
Runs table — and a second meaning for it on the same page would be unreadable. §5's row is reassigned
to `mfarm:commit` / `mfarm:branch`, which is what it was actually asking for.

### `mfarm:deviceClass` — ask for a class, not a device

Passes straight through to `AllocationRequest.profile` / `matchProfile`. **Two fields, not one
nullable value**, for ADR-0025's reason: `null` means "an unprofiled device, specifically" — a real
thing to want on this farm — and one nullable field cannot distinguish it from "any device at all".

Refused beside `mfarm:sessionId`, like `tier` and `ttlMinutes` and for their reason: the device was
chosen when that session was allocated, and accepting an instruction to an allocator that already ran
would mean silently doing something other than what the capability says. `mfarm:name` is **not**
refused there — it labels the session rather than choosing the device, and under `mfarm run` it is
the only way a suite can say what it is.

A class the farm has none of now fails **naming the class**, because that changes what the reader
should do: waiting works for a busy class and never for an absent one.

### `executeScript("mfarm-status=passed|failed|skipped")`, and `mfarm-name=`

**The same report, through the door the suite already has open.** This is `lambda-status` renamed,
and that is the entire point — a teardown porting across changes one string.

It writes the **same row, through the same function** as the REST endpoint (`recordTestResult`,
extracted from the route for this): same evidence request, same `test-failed` timeline event, same
clamping. A farm where the outcome depends on which door you used is a farm whose numbers cannot be
trusted.

Three rules:

- **Anything that is not `mfarm-…` is proxied untouched.** Every `executeScript` a suite makes for
  its own purposes — `mobile: shell`, a scroll helper, a deep link — passes through this code. A hook
  that threw on an unfamiliar payload would break ordinary automation to serve a convenience.
- **A malformed hook is refused, not forwarded.** `mfarm-status=pased` is unambiguously aimed here
  and unambiguously wrong; forwarding it would answer a typo in a status word with Appium's "unknown
  command", which sends the reader to the wrong place entirely.
- **It is recorded as a step** (ADR-0029). It is a command the suite issued, it took time, and a
  timeline that hid it would leave a gap at the interesting moment.

The hook carries **no stack trace**, because an `executeScript` payload has nowhere to put one. That
is not a gap to close by encoding JSON into the script string — it is the reason the REST endpoint
stays the documented path for a failing test.

## Consequences

**A suite migrating from LambdaTest changes a hub URL, a credential and four capabilities.**
`examples/java-testng/` is that file, with the mapping table. It is a file to copy and edit, not a
library: sixty lines of `setCapability` is not worth a jar to publish, version and trust, and the one
thing a customer must be able to do is read every line that touches their driver.

**Labels are never derived.** A session that sent no name has `NULL`, and the console shows the id.
An invented name ("session 3 of 8") would be a label the suite never wrote, and this table's whole
value is that its labels came from the person who knew. The one exception is inside the status hook,
where a result row needs a name and the session has none — it falls back to a string that is honestly
about the *session* rather than pretending to be a test somebody chose.

**Both CHECK constraints in migration 048 are recorded in `rollback.test.ts`'s
`ACCEPTED_NEW_CHECKS`.** They are safe in the direction that guard asks about: new nullable columns
the previous release does not know exist, so a rolled-back API writes NULL and `name IS NULL` is the
first disjunct of each. The bound is in the schema rather than in a handler because there are two
writers — the capability parser and the script hook — and a bound enforced in the application holds
only until somebody adds a third.

**This does not close test-level debugging.** A run still lists only its FAILURES as test rows, so
every passing test's name is now recorded and rendered nowhere. That is the next slice. Naming it
here so the ADR is not read as more than it is.
