---
id: ADR-0018
title: An execution is a record MFARM owns, not a suite MFARM runs
status: Accepted
date: 2026-09-01
authors:
  - Claude Code
tags: [execution, automation, product, ci, scope, browserstack]
extends: [ADR-0002]
---

## Context

`AutomationExecutionPlan.md` (repo root, 2026-09-01) specifies a production-grade automation
execution engine. Most of it describes things this repo already has — the allocator, leases and
fencing, idempotency, quarantine, failure classification, queueing, RLS tenancy, metrics. Two
sections do not, and they are the ones that decide the shape of the product:

- **§3** wants a console screen: *Select Project → Select Suite → Select Device → **RUN***.
- **§22** wants `POST /api/v1/executions {project, suite, device, build}`, returning an id to poll.

Both only make sense if **MFARM holds the customer's test code and starts it**. That contradicts
ADR-0002, which decided the CLI is a wrapper and not a test runner, on the grounds that owning the
runner means tracking Appium, Espresso, XCUITest, Detox and Maestro forever, and putting our code
between a customer and their own exit code.

The contradiction cannot be left open. An implementer reading §22 without this ADR builds a runner,
and the first thing a runner does is invalidate ADR-0002's release guarantee — which is the
load-bearing property of `mfarm run` and the thing that stopped the double-billing defect in
ADR-0002 D1.

### What the competition actually does

The direction document names BrowserStack, LambdaTest and Sauce Labs as the experience benchmark, so
it is worth being precise about which model they run. They run **both**, and the split is the
answer.

**Model A — the hub.** The customer's suite runs on the customer's machine. The app is uploaded
once and referenced by an opaque id; the Appium client points at a remote hub. This is the primary
product and the one every migration guide is written for. **There is no RUN button in the
BrowserStack console for an Appium test** — the console is for watching a session and reading
results. This is, close to line for line, what MFARM already has:

| BrowserStack App Automate | MFARM today |
|---|---|
| app upload → `bs://<hash>` | app library upload → build id |
| `app: 'bs://<hash>'` | `mfarm:appId` (uuid, `pkg@1.4.2`, `pkg@latest`) |
| `hub-cloud.browserstack.com/wd/hub` | `farm.mfarm.dev/wd/hub` |
| build name groups sessions | `mfarm:runId` |
| suite reports outcomes | `POST /v1/sessions/:id/result` |

**Model B — the platform runs it.** Exists in two places only. First, **Espresso and XCUITest**,
where it is *forced*: those are on-device instrumentation frameworks, the test code physically
executes on the phone, and there is no remote client to drive it — so the platform takes an app APK
and a test APK and runs them. Second, **orchestration products** such as LambdaTest HyperExecute,
sold separately on sharding and speed, where the customer hands over a YAML config and the platform
clones, installs and runs.

So §3 and §22 do not describe the industry default for Appium. They describe the second product.

*(Confidence: high on the architecture of both models; moderate on current API shapes and feature
naming, which change. Nothing in this decision hangs on a specific endpoint.)*

## Decision

**MFARM builds Model A, and makes the execution record first-class.**

An **execution is a record MFARM owns**. The **test process stays the customer's**. MFARM takes
responsibility for everything around it — validate, queue, allocate, prepare, install, clean, health
check, release, collect, report — and for none of what happens inside it.

Four consequences that are the actual content of this decision:

**1. The end of a run is DECLARED, not derived.** Migration 020 omitted `runs.status` and
`runs.ended_at` because there was no honest signal: a sequential suite ends every session before
starting the next, so "the last session ended" would mark a twenty-test run finished nineteen times
before it was. Model A supplies the missing signal — the suite, or `mfarm run` at child exit, says
it is done. A run with no completion is **INCOMPLETE**, never FAILED, on the same reasoning that
makes an uninstrumented run read "Not reported" rather than green.

**2. Executions are `runs` promoted, not a second table.** The plan's §33 entity list maps onto
what exists: `Execution` → `runs`; `ExecutionEvent` → a new `execution_events` table, which serves
the §4 state machine, the §17 live feed and the §18 timeline at once; `ExecutionAttempt` → `sessions`,
which **already is the attempt** — one session is one device lease. Get-or-create by `mfarm:runId`
stays, because it is the zero-coordination path every current suite depends on; explicit creation is
additive.

**3. MFARM retries DEVICES, never TESTS.** §34 and §35 ask for automatic retry on infrastructure
failure. In Model A the client's runner owns test-level retry and we cannot see an assertion, so the
honest scope is: MFARM may retry *giving the client a healthy device*, bounded by retry count,
backoff and a maximum recovery duration. It must never re-run a test, and it must never collapse the
retry pair that migration 021 deliberately preserves — a test failing then passing under one name
*is* the flakiness signal.

**4. There is no RUN button, and that is not a gap.** The console watches and reports. This is what
BrowserStack does for Appium, and saying so here stops it being re-filed as missing every quarter.

## Alternatives rejected

**The hosted runner (§22 read literally).** Upload a suite or point at a repo; MFARM installs
dependencies and executes the framework in a sandbox. Rejected for now, not forever. It buys the §3
screen and it is genuinely what HyperExecute sells. It costs: an execution sandbox with resource
limits and egress control; per-framework knowledge and version tracking; a dependency cache; custody
of customer source code and CI secrets; and it supersedes ADR-0002's exit-code contract, which is
the thing that makes adopting MFARM a one-line change. That is a multi-month product, and it is the
wrong one to build while the farm has four devices.

**Leaving the conflict unresolved and building "some of both".** Rejected as the worst option
available. The two models disagree about who owns the session lifecycle, and ADR-0002 D1 is the
record of what that specific ambiguity already cost once: `mfarm run` and the hub each allocated a
device, so a suite held two, billed two, and used one. A product that has not decided who owns the
lifecycle re-derives that bug in a new place.

## Consequences

**Positive.** ADR-0002 survives intact and now extends from the CLI to the platform. The supported
framework list stays "all of them" with no work. The customer's exit code stays theirs. Every §4,
§17, §18 and §35 capability in the source document becomes buildable *without* owning the runner —
which was the thing blocking them, not the schema.

**Negative.** No §3 RUN screen, so the console demo stays "watch a run that CI started" rather than
"start a run". Accepted: it is the same demo BrowserStack gives for Appium.

**Negative.** **Espresso and XCUITest are unreachable under Model A**, and this is the real cost. It
is not a preference we can revisit by choosing differently — those frameworks put the test code on
the device, so supporting them *requires* Model B. When that day comes it arrives as an **addition**
alongside the hub, exactly as it does at BrowserStack, and this ADR should be extended rather than
superseded. The execution record designed here is deliberately agnostic about who started the run,
so a Model B execution can slot into it.

**Constraint carried forward.** The live event feed (§17) is server-sent events with an in-memory
subscriber registry, which keeps the single-instance constraint ADR-0001 already imposes for
in-memory rate limiting. It does not make that worse, but it is now a second reason.

## Verification

This ADR is a scope decision; what verifies it is that the things built under it do not smuggle a
runner in. Concretely, at every phase:

- no endpoint accepts test code, a repo URL, or a command to execute;
- no MFARM process spawns a test framework;
- `mfarm run` continues to pass the child's exit code through verbatim
  (`apps/cli/test/run.test.ts` already pins this).

## Related

- `ADR-0002` — the CLI is a wrapper, not a test runner; this extends it to the platform
- `ADR-0001` — the reaper, and the single-instance constraint §17 inherits
- `ADR-0003` — capability honesty; a device advertises `webdriver` only while Appium is ready
- `docs/EXECUTION_MODEL.md` §4.2 — why `runs` has no status or `ended_at`, and what would change it
- `AutomationExecutionPlan.md` — the source document this decision scopes
