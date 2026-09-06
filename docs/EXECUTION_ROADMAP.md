# The execution engine, from here to production

**What this is.** A sequenced plan for the seven things standing between MFARM's execution path and
one a stranger's CI can lean on. Each step names the schema change, the code change, the test that
proves it, and how it is verified on the farm. They are ordered so that each one is useful alone and
each one makes the next cheaper.

Derived 2026-09-07 at `011a620` / migration 038 by reading the code, not the specs — both
`AutomationExecutionPlan.md` and `docs/EXECUTION_MODEL.md` describe some of this as absent when it is
built, and one of them describes as built a thing that is only half true. Where they disagree with
this page, check the file.

---

## Where the execution path actually stands

**The record is solid.** `sessions` moves `QUEUED → ALLOCATING → ACTIVE → ENDED` under fence tokens,
`session_attempts` (033) counts tries, and `sweep()` in `apps/api/src/allocator.ts` is a real
reconciliation loop — idle-WebDriver expiry, queue promotion, stuck-install escalation, bounded reset
recovery (032), gated quarantine release (035), host-silence quarantine (038).

**The timeline exists in the database and over the wire, and nowhere else.** `execution_events` (030)
is append-only with nine kinds and no UPDATE or DELETE granted to `mfarm_app`. `GET /runs/:id/timeline`
polls it and `GET /runs/:id/events` streams it. No screen renders either.

**Failure reporting works for what the suite reports.** `test_results` (021) carries the message and
stack, `failure_class`/`failure_reason` (024) carries the taxonomy, and the run screen puts failures
above the session list with the farm's own incidents in a *separate* card — so a cable glitch is never
counted as a test failure. That separation is the thing most farms get wrong and it is right here.

**CI works.** `action.yml` plus `@mfarm/cli`, exit codes classified into `pass` / `test-failure` /
`setup-failure` / `capacity` / `interrupted`, device released on every exit path including a
double-^C. Any runner with Node 22 works through the CLI; only GitHub has a wrapper.

What follows is what is missing, in the order to build it.

---

## S1 — Queue fairness: one org can starve every other — **BUILT (2026-09-07)**

**The defect.** `promote_queued` reads the twenty oldest `QUEUED` sessions *globally*, ordered by
`created_at`, then skips each one whose org is at `max_concurrent`
(`037_allocate_by_class.sql:181-189`). An org holding twenty or more queued sessions at its cap fills
that entire window with rows that all `CONTINUE`. **A second org's session is never considered, with
devices sitting `READY`.** The sweep repeats the same window every ten seconds and produces the same
nothing, until the first org's backlog drains — which happens only at its cap rate, one session at a
time, as sessions end.

Invisible today because the farm has one org. It surfaces on the first day of the second team, which
is the pending decision in `STATUS.md` §4. `AutomationExecutionPlan.md` §20 asks by name for this not
to happen: *"If ten users submit tests, don't let one user monopolize the device forever."*

**Schema — migration 039.** Replace `promote_queued(integer)` so the candidate window is fair rather
than chronological:

```sql
SELECT s.id, s.org_id, s.region, s.constraints, o.max_concurrent
  FROM (SELECT s.*, row_number() OVER (PARTITION BY org_id ORDER BY created_at) AS rank
          FROM sessions WHERE state = 'QUEUED') s
  JOIN orgs o ON o.id = s.org_id
 ORDER BY s.rank, s.created_at
 LIMIT p_limit
```

Round-robin *across* orgs, strict FIFO *within* one. Every org's oldest session is considered before
any org's second, so the window can no longer be monopolised. `ORDER BY` still tie-breaks on
`created_at`, so with a single org the behaviour is byte-for-byte what it is today — which is what
makes this safe to ship to a live farm.

The cap check stays where it is. It bounds what an org *runs*; the rank bounds what an org *occupies
in the queue*, and the two were being asked of one mechanism.

**Code.** None. `allocator.ts` calls `promote_queued($1)` and does not care how it chooses.

**Test.** `apps/api/test/allocator.test.ts` — org A queues 25 sessions at cap 1, org B queues one
afterwards, one device is free. Today B waits forever; after this B is promoted. Assert on the
promoted org, not on a count, so the test states the fairness property rather than an arithmetic
coincidence.

**Verified.** The test was run against a live Postgres with the **037 function restored**, watched go
red, then green against 039 — the fix was not taken on trust. The FIFO-within-an-org test is green
under both, so it states a property rather than agreeing with the change. Migration 039, ADR-0028.

The first draft of the test had the wrong shape: org A released the device that freed, which drops A
under its cap and makes A legitimately first in line. The shipped version pins A *at* cap with a
second device — the production situation, where one team's CI queues a hundred jobs and every other
team stops.

**Still to verify on the farm.** Two orgs, four devices, a suite from each. The second org's first
session should start while the first org's backlog is still draining.

---

## S2 — The failure evidence is captured at the wrong moment — **BUILT (2026-09-07)**

**The defect.** `captureArtifacts()` (`workers/agent/src/agent.ts`) runs when the device enters
`CLEANING` — at teardown, after Appium has force-stopped the app under test. So the screenshot
reliably shows the launcher, and the logcat is a whole-session dump (2.55 MB average) with no marker
for when the failure happened.

**What it turned out to be, which is smaller than this section first said.** The plan proposed a new
`capture` action on the beat. It was not needed: migration 022 had already added a `screenshot` verb
to the `app_actions` pipeline **for this exact reason**, and its own header says so. The work was to
add the second verb, and to make the control plane request both **on its own** off a signal it had
been receiving and ignoring since migration 021 — the result POST.

**Schema — migration 040.**

- `app_actions.kind` gains `'logcat'`, and `app_actions_app_required` learns that two verbs name no
  app rather than one. Both are one line each because 022 converted that column from an enum to
  `text + CHECK` in anticipation.
- `app_actions.context jsonb` and `artifacts.context jsonb` — *why* something was captured, carried
  from the request to the artifact. A failure capture holds
  `{"source": "test-failure", "testResultId": …, "test": …}`. Without it, a session that fails six
  tests leaves six unlabelled files with adjacent timestamps.
- `request_capture(org, session, kind, context)`, `SECURITY DEFINER`, holding the three rules that
  keep this from making things worse: **coalesce** to one `PENDING` capture per kind per session,
  **require the capability** so a device that cannot capture never collects an action that fails,
  and **check the fence** so a late result cannot photograph the next tenant.
- `artifact_record` gains a tenth argument, with the nine-argument form kept as a forwarder — 037's
  deploy-window and rollback reasoning, unchanged.

**Code.** `results.ts` requests both captures on a `failed` result, wrapped so it can never fail the
report — a result must be recorded whether or not evidence can be taken. `workers.ts` carries
`context` on the beat, omitted when empty so an older agent's payload is unchanged. The agent gained
a `logcat` handler and passes `context` through to the upload, reading it and never interpreting it,
so a new capture source needs no agent release.

**What was deliberately NOT built.** `test_results.occurred_at` was in the plan and is not here:
nothing populates or reads it yet. It belongs with S4, where the timeline consumes it.

**Verified.** Seven API tests for the bounds (coalescing, the capability rule, a passing test asking
for nothing, an ended session, malformed context), and two end-to-end tests in
`workers/agent/test/install.test.ts` running a **real agent against a real control plane** — a
failure is reported, and both artifacts come back with bytes and the right `testResultId` without
the test ever asking the worker for anything. The first draft of that test read the artifact list
straight after `heartbeat()` and saw one of the two; the beat hands work over and returns, so it now
waits for both actions to settle. That was a race in the test, and it would have read as a flaky
product.

**The honest limit, unchanged from the plan.** The beat is ten seconds, so a failure-triggered
capture lands up to ten seconds after the assertion. Ten seconds late beats after-force-stop, and
S3 is what makes a late screenshot readable — the command trace says what happened in between.

## S3 — There is no step trace, so nothing can be highlighted — **BUILT (2026-09-07)**

**The gap.** The hub deliberately does not model WebDriver commands: *"the automation server is the
authority on what exists, and a hub that enumerates commands is a hub that breaks every time Appium
adds one."* That rule is correct, and ADR-0029 keeps it: what a step list needs is not a semantic
model but method, path, status, duration and time — what the proxy had in its hands one line before,
because it had just forwarded it.

**Schema — migration 041.** `session_commands`, append-only, RLS'd, `bigserial` (the only table in
the schema written once per command rather than once per session). `record_session_commands()` for
the batched write and `expire_session_commands()` for the sweep.

**What is deliberately not stored: bodies and headers.** A WebDriver body carries the customer's
selectors, their test data, and on `POST /element/:id/value` their passwords. The stored `error` is
the W3C code only — the message beside it quotes the selector. This is the single most important
line in the migration.

**Code.** `apps/api/src/commandLog.ts` — a synchronous, bounded, batched recorder that swallows and
counts every database error, so a control plane whose command log is broken still runs suites. The
proxy calls it without awaiting; the only awaited flush is on `driver.quit()`, because a CI job
reads its own trace the instant the suite finishes. `GET /v1/sessions/:id/commands` pages the
result and derives `failed` rather than storing it.

**The latency question this step was gated on is answered and pinned.** `record()` costs well under
0.05 ms per command, asserted as a test so it cannot quietly regress into an awaited write.

**Two real bugs found while verifying, neither of which a green test would have shown:**

1. `SELECT COALESCE(MAX(seq),0) … FOR UPDATE` — Postgres refuses `FOR UPDATE` beside an aggregate.
   The recorder's swallow-and-count then hid it as a *silently empty trace*: the module's designed
   failure mode working exactly as intended, and a reminder that "it did not crash" is not "it
   worked". Replaced with a transaction-scoped advisory lock, which is also the only thing that can
   serialise the first batch of a session, since there is no row yet to lock.
2. **A cross-tenant write.** The function derived the org by selecting the session, on the reasoning
   that `sessions` is FORCE ROW LEVEL SECURITY. `mfarm_definer` has **BYPASSRLS** — migration 012
   gave it that so `promote_queued` can read every org's queue — so RLS is not present inside any
   definer function. A test written to *confirm* the reasoning found org B writing a forged step
   into org A's session, filed under A. Now `p_org` is passed and named in the `WHERE`, which is the
   shape `request_capture` already had. **The general rule: RLS will not scope a definer function;
   the function must scope itself.**

**Verified.** Eleven tests in `apps/api/test/webdriver.test.ts` — ordering and numbering, the error
code without the message, no request body, no upstream session id, quit as the last step, the
awaited drain, cross-org read and write isolation, paging, the latency bound, and a database that
refuses the write not breaking the suite.

## S4 — The timeline learns about tests, and gets a screen — **BUILT (2026-09-07)**

**Schema — migration 042.** `test-failed` and `artifact-created` on the `execution_events` CHECK,
plus `test_results.occurred_at` — when the *suite* says the test finished, as against when we heard.
A reporter that flushes in an `after()` hook posts ten results in one burst, and a timeline built on
arrival time then claims the suite failed everything simultaneously, minutes after the session
ended. Optional, defaulted, and **clamped to the session's own lifetime**: a timestamp from a caller
is a claim, not a fact.

**`command-failed` is deliberately not a kind.** An implicit wait polls `findElement` until it
succeeds, so one successful step produces a dozen `no such element` responses. Those belong in the
session's step list, not on the run timeline — the run timeline stays a summary and the two link
rather than merge.

**Code.** `results.ts` emits `test-failed` before requesting evidence, so a live run shows the
failure and then its evidence arriving, in that order. `artifacts.ts` emits `artifact-created`
carrying the artifact id, so the entry is a *link to the picture* rather than a note that a picture
exists. The console gained a **What happened** card on the run screen and a **Steps** card on the
session screen.

**Red is reserved.** `test-failed` is `bad`; an `incident` is `warn`. The run screen already refuses
to conflate a test failing with the farm having a problem — its two cards are side by side for that
reason — and a timeline painting both red would undo it in the place a reader scans fastest.

**A shipped defect found on the way, and the reason no test could see it (D26).** `loadRunDetail`
spread `run` and `sessions` and **dropped `failures` and `incidents`**, so the Failures card — whose
own comment calls it "the whole payoff of runs plus outcomes" — has never rendered for anybody. The
optional chaining made it silent: the card did not throw, it was simply absent, and the screen
looked finished.

229 console-screen tests were green throughout because the fixture seeds `failures` **straight into
state**. *A test that seeds state tests the renderer, never the loader.* The fix ships with a test
that drives `loadRunDetail` against a stubbed `fetch`, verified by reverting the loader and watching
it go red.

**Verified.** Eight console tests (the loader, a timeline whose secondary fetch fails, the red/amber
reservation, an unknown kind rendering as itself rather than vanishing, the step table's failed-row
class, "no answer", the privacy note, and the empty state) and four API tests (the event and its
one-line headline, a passing test leaving no mark, the timestamp clamp against a 2020 and a 2099
claim, and evidence landing as a link).

## S5 — Video, recorded only for failures

**Why this is fifth and not first.** `EXECUTION_MODEL.md` §4.4 measured it: 37.5 MB for a five-minute
recording against 3.1 MB for everything else combined, and two saturated devices fill the control
plane's disk in **1.3 days**. Recording everything is not a feature, it is a scheduled outage. What
makes it affordable is knowing which sessions failed — which S2 and S4 have just made a fact the
control plane holds *during* the session rather than after it.

**The encoder already exists.** `workers/agent/src/devices/capture.ts` produces a bare H.264 Annex-B
elementary stream at 49–53 fps for the live view, from scrcpy where the jar is present and
`screenrecord` otherwise. This step does not add an encoder — §4.4's first bullet — it adds a
subscriber to one that is already running.

**Schema — migration 043.** One line, as 019 promised:

```sql
ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE artifacts ADD  CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('logcat', 'screenshot', 'video'));
```

Plus `artifacts.duration_ms` and `artifacts.started_at`, so a video can be seeked to a command's
timestamp. Video gets its own retention — days, not the fortnight logcat gets — via a second
`expires_at` policy rather than a second column.

**Code.**

- `workers/agent/src/devices/capture.ts` — a `RingRecorder` that subscribes to the existing stream
  and holds the last N seconds on disk (not memory: 500 kbps × 300 s is 18 MB per device and the
  agent runs on customer hardware), keyed by keyframe boundaries so a discarded prefix still decodes.
  Default 300 s at 10–15 fps, §4.4 bullet 3.
- The beat's `resets` entry gains `keepRecording: boolean`. The control plane sets it when the
  ending session has a `failed` test result. The agent muxes the ring to MP4 and uploads on that
  flag, discards otherwise. `packages/protocol/src/protocol.ts:235` is the type to change.
- Everything else — content addressing, retention, the RLS'd blob endpoint — already exists and is
  reused unchanged.

**The measurement that gates this step.** §4.4 ends with the one thing still unknown: what host-side
encode costs against the `RENDER_BASELINE.md` Flutter-canvas workload, where there is least headroom.
That is lab hours, not a design question, and **S5 does not start until that number exists.** If it
perturbs the workload it is measuring, video ships for physical devices only, where the encoder is on
the phone's dedicated hardware and the farm's CPU is not in the loop at all.

---

## S6 — A queued caller is told nothing

`POST /v1/sessions` answers a queued caller with `"No device is free right now. The session is queued
and will start automatically."` (`sessions.ts:186`) — no position, no estimate. `mfarm run` then
prints *"waiting up to 300s"* and either starts or exits 75. For fifteen minutes, in a CI log, that
is indistinguishable from a hang.

**Schema.** None. Everything needed is already stored: `sessions.created_at` gives position,
`sessions.expires_at` on the leases ahead of you gives the estimate, and the sessions list read
already carries the lease for exactly this reason (`sessions.ts:331`).

**Code.**

- A `queuePosition(orgId, sessionId)` in `allocator.ts`: rank among `QUEUED` for the matching device
  class, plus the earliest `expires_at` among the leases that could free a matching device.
- `POST /v1/sessions` and `GET /v1/sessions/:id` return `{position, ahead, estimatedStartAt}` while
  `QUEUED`. `estimatedStartAt` is **nullable and often null** — a lease that ends early makes it
  pessimistic and a suite that renews makes it optimistic. A null is honest; a confident wrong number
  is the thing that makes people stop trusting a queue.
- `apps/cli/src/run.ts` — the progress line becomes `queued: 3rd of 7, a device frees up in ~4m`,
  refreshed on the poll it already makes.
- The console gains a queue depth line on the Runs screen.

---

## S7 — The reliability ceilings

Not execution-engine work, and named because "as reliable as the big farms" is false while any of
them stands:

| | what it costs |
|---|---|
| **Single API instance** — rate limiting is in-memory (`apps/api/src/http/server.ts`) | a second process silently multiplies every limit; there is no HA and no rolling deploy |
| **One device host** | a host outage is a farm outage. ADR-0027 and 038 reduce the blast radius; they do not remove it |
| **Deploy is manual** | a released commit reaches the farm when a human runs `mfarm-deploy.sh`. It went unnoticed for ninety minutes once |
| **No worker-side metrics** | the agent reports incidents, not gauges, so queue depth and capacity are unobservable from Grafana |

S1 and S6 are what a second team hits first, so they come before all of these. But S7 is what a
second *customer* hits, and the honest order after S6 is: deploy automation, then a second device
host, then the rate limiter.

---

## The order, and why

1. ~~**S1 fairness**~~ — **done**, migration 039 / ADR-0028.
2. ~~**S2 evidence at failure time**~~ — **done**, migration 040.
3. ~~**S3 command trace**~~ — **done**, migration 041 / ADR-0029.
4. ~~**S4 timeline + screen**~~ — **done**, migration 042.
5. **S5 video** — affordable only after S2/S4 make "record only failures" expressible, and gated on
   one measurement.
6. **S6 queue visibility** — smaller than it sounds, and it is most of what "graceful queuing" means
   to a person watching a CI log.
7. **S7 ceilings** — deploy, then a second host, then the rate limiter.

Each step ships as its own PR with its own migration, and each is verified on a running farm before
the next starts — not when CI is green. `DEFECTS.md` states the reason: twice this month a fix was
reasoned, unit-tested, merged and completely inert.
