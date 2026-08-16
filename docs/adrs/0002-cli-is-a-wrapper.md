---
id: ADR-0002
title: The CLI is a wrapper, not a test runner — env injection, verbatim exit codes, and a release guarantee
status: Accepted
date: 2026-08-16
authors:
  - Ruflo swarm (hierarchical) via Claude Code
tags: [cli, adoption, ci, github-action, exit-codes]
---

## Context

v2 decision 10 makes adoption cost the product's main competitive surface: an existing suite should
migrate by changing one URL. The WebDriver hub delivers that for Appium clients already
(`https://mfk_key@hub.mfarm.dev/wd/hub`). The CLI and the GitHub Action are the same promise for CI.

There are two ways to build a device-cloud CLI, and the choice is not reversible cheaply:

- **A runner.** `mfarm test --spec ./tests` — the CLI knows about test frameworks, parses their
  output, reports pass/fail, and produces its own report format.
- **A wrapper.** `mfarm run -- <their command>` — the CLI allocates a device, hands coordinates to
  the child through the environment, and gets out of the way.

A runner is a bigger product surface and a better demo. It is also a commitment to track Appium,
Espresso, XCUITest, Detox, Maestro, and every reporter each of them has, forever — and it puts our
code between a customer and their own test output on the day something breaks.

## Decision

**The CLI is a wrapper.** `mfarm run --region us-east -- npx appium-test`.

**1. Coordinates are passed through the child's environment**, principally `MFARM_WEBDRIVER_URL`.
That one variable is the entire migration: a suite that already points at an Appium server reads it
and needs no other change. This is the same adoption claim as the hub, expressed for CI.

**2. The child's exit code is passed through verbatim.** Never remapped, never normalised. CI reads
that number and nothing else, and a device cloud that rewrites a customer's test result — in either
direction — is one nobody will trust with a merge gate.

**3. Capacity is distinguishable from failure.** Exit `75` (`EX_TEMPFAIL`) when the queue wait
expires without a device. A test failure and "we had no phones" are different events: one should
block the merge, the other should retry the job. Collapsing them into `1` is what makes teams stop
believing a device cloud's red builds, and the GitHub Action annotates the two differently
(`::warning::` vs `::error::`) for the same reason.

| Exit | Meaning |
|---|---|
| child's own | the child ran; this is their result, untouched |
| `1` | mfarm failed before the child started (auth, config, allocation) |
| `75` | capacity — queue wait exceeded; retryable |
| `130` | interrupted |

**4. The device is released on every exit path.** Child exit, child crash, SIGINT, SIGTERM,
post-allocation error, unhandled rejection. One idempotent release function, installed once, proven
by tests. A leaked device is billed time the customer did not use and capacity nobody can reclaim.

**5. A failed release never changes the exit code.** It logs to stderr and moves on. The server-side
reaper (ADR-0001) is the real backstop, and turning a green test run red because cleanup hiccuped
would be a worse bug than the leak it reports.

**6. Zero runtime dependencies.** `node:util`'s `parseArgs` and global `fetch`. Something teams
`npx` on every CI run should not drag a dependency tree — for install latency, and because every
transitive dependency in a tool that holds an API key is supply-chain surface.

**7. Progress to stderr, results to stdout.** `--json` output stays pipeable.

## Consequences

**Positive.** The CLI cannot break a customer's test output, because it never touches it. The
supported-framework list is "all of them" and stays that way with no work. The Action is thin
because the CLI already has the semantics.

**Negative.** No native reporting, no per-test retry, no sharding, no "rerun only the failures" —
all of which a runner would give us and all of which are real demo asks. If they are wanted later
they must be built *on top of* the wrapper contract, not by breaking it.

**Negative.** `MFARM_WEBDRIVER_URL` embeds the API key, because HTTP Basic in a URL is the only
credential a WebDriver client accepts. It is in the child's environment and must be masked
everywhere it could be logged. The Action masks it and passes the key as an env var rather than an
argument, since argv is visible in process listings.

**Dependency.** Decision 3 is only honest if the queue actually drains, which requires the reaper to
run — see ADR-0001. Without a service entrypoint, exit 75 would be the *normal* outcome rather than
the rare one, and the retry advice would be wrong.

## Defect in this ADR, found during implementation

**D1 — RESOLVED 2026-08-16.** The preferred fix below was taken: the hub can now be handed a session
that already exists, and `mfarm run` hands it one. Three things changed.

- **The carrier is the URL, not a capability.** `MFARM_WEBDRIVER_URL` became
  `https://<key>:<session-id>@hub/wd/hub` — the key in the Basic username half, the session in the
  password half, which carried nothing before. A capability would have meant editing every customer's
  suite, and decision 1 of this ADR says that one variable *is* the migration. `mfarm:sessionId` also
  exists, documented, for anything driving the REST API directly; if both are present they must agree.
- **The hub records who owns the lifecycle.** `webdriver_sessions.hub_allocated` (migration 009). On
  the bound path the hub drives the device and releases nothing — not on failure, not on
  `driver.quit()` — because this CLI is holding it. That keeps decisions 4 and 5 true, and it makes a
  suite that quits between tests cost one device instead of one per test.
- **`POST /v1/sessions` learned `requireCapabilities`.** Without it the CLI allocated any device and
  binding then failed at the hub with "no automation server". `mfarm run` demands `webdriver` by
  default; `--no-webdriver` opts out for suites that only speak the raw data plane. Narrowing the
  pool trades a rarer exit 75, which CI knows how to retry, for a mid-run failure, which it does not.

The alternative (the CLI not pre-allocating) was rejected for the reason given below: it trades away
the release guarantee, which is the load-bearing part of this ADR.

The original defect, kept because the shape of it is worth remembering:

**`mfarm run` double-allocates for WebDriver suites, and bills twice. This ADR as originally
written is wrong.**

`mfarm run` allocates a session via `POST /v1/sessions`, then hands the child a bare
`<origin>/wd/hub`. But the hub allocates *its own* session from the W3C capabilities on
`POST /session` — it has no way to bind to a session the caller already holds. So an Appium suite
run under `mfarm run` holds **two** devices, bills for **two**, and never touches the one the CLI
allocated. Decision 1 (env injection) and the hub's existing design are incompatible as specified.

This is the most expensive kind of bug in a metered product: it does not fail, it overcharges, and
the customer discovers it on the invoice.

Two possible fixes, and the choice had to be made before the CLI was used against a real hub:

- **Preferred — the hub accepts an existing session.** Add an `mfarm:sessionId` capability (or carry
  it in the URL). `mfarm run` allocates once, the hub binds to that session instead of allocating.
  Keeps a single lifecycle owner (the CLI), so `--ttl`, release-on-crash, and the exit-code contract
  all continue to mean what they say. Requires a change in `apps/api`.
- **Alternative — `mfarm run` does not pre-allocate** when the child is a WebDriver suite, and lets
  the hub own allocation. Cheaper, but it guts decisions 4 and 5: the CLI no longer holds the
  session, so it cannot guarantee release, and exit 75 stops being distinguishable because the wait
  now happens inside the hub.

**Recommended: the first.** The release guarantee is the load-bearing part of this ADR and the
second option trades it away.

**D2 — the queued path cannot produce `MFARM_DATA_PLANE_ENDPOINT` / `MFARM_SESSION_TOKEN`.**
`GET /v1/sessions/:id` returns no `dataPlane` block, and no route mints a token for an
already-created session. So on the 202→poll→ACTIVE path those two variables are simply **absent** —
anything speaking the raw data plane silently loses its coordinates exactly when the fleet is busy.
The implementation deletes them rather than setting empty strings, so the failure is at least loud.
Fix belongs in `apps/api`: return `dataPlane` from `GET` when the caller is the owning tenant and
the session is ACTIVE.

**D3 — `--json` and `stdio: 'inherit'` conflict for `run`.** Decision 7 wants one machine-readable
object on stdout; decision 1 wants the child's output untouched. The child inherits stdout, so they
interleave. Current behaviour emits the summary as the last line, which means
`mfarm run --json | jq` only works when the suite is quiet. `--quiet` does not help — it only
affects stderr. A `--json-file <path>` would resolve it cleanly. `devices` and `session get` are
unaffected.

**D4 — `POST /v1/sessions` returns `ALLOCATING`, not `ACTIVE`, on the 201 path**, so "poll until
ACTIVE" is only meaningful for 202. The implementation accepts `ACTIVE` *or* `ALLOCATING` with a
non-null `deviceId`, and treats `ENDING`/`ENDED`/`FAILED` as a hard error rather than polling to the
deadline.

**D5 — `session rm` on an already-released session exits 0, not 1.** Not specified by this ADR. A CI
cleanup step that fails because the reaper won the race is a cleanup step people delete.

**Packaging note.** `apps/cli/package.json` is `"private": true`, matching every other package in
the repo. That blocks the `npx mfarm` story in decision 6 until publishing is set up.

## Verification

```bash
cd apps/cli && node --test --experimental-strip-types test/*.test.ts
```

Tests run against a real ephemeral `node:http` control plane, not mocks: exit-code passthrough,
release-on-crash, release-on-SIGINT, the 202→ACTIVE poll path, `--wait 0` failing fast with 75,
no-retry-on-4xx, retry-on-5xx.

## Related

- `ADR-0001` — the reaper that makes the queue real
- `apps/api/src/http/routes/webdriver.ts` — the hub this mirrors for CI
- `docs/ci.md` — the customer-facing snippet
