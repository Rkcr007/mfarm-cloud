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

## S1 — Queue fairness: one org can starve every other

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

**Verify on the farm.** Two orgs, four devices, a suite from each. The second org's first session
starts while the first org's backlog is still draining.

---

## S2 — The failure evidence is captured at the wrong moment

**The defect.** `captureArtifacts()` (`workers/agent/src/agent.ts:1044`) runs when the device enters
`CLEANING` — that is, at teardown, after Appium has force-stopped the app under test. So:

- **the screenshot reliably shows the launcher**, not the failing screen. `EXECUTION_MODEL.md` §4.5
  admits this and `examples/medishop-suite` works around it by screenshotting locally, which every
  customer would then also have to do;
- **the logcat is a whole-session dump** with no marker for when the failure happened. At 2.55 MB
  average that is a haystack shipped in place of a needle.

Evidence has to be triggered by the failure, not by the release.

**Schema — migration 040.** Two changes.

1. `test_results` gains `occurred_at timestamptz` — when the *suite* says the test failed, distinct
   from `reported_at`, which is when the row reached us. Every later step (the log window, the video
   offset, the red step) needs the failure's position on the session's clock, and `reported_at` is
   the wrong clock: a reporter that batches its POSTs collapses ten failures onto one instant.
2. `artifacts` gains `captured_at timestamptz` and `context jsonb` — what the artifact is *of*.
   `{"testResultId": ...}` on a failure capture, `{}` on the release sweep. Without it a session
   with six screenshots is six unlabelled PNGs.

**Code.**

- `apps/api/src/http/routes/results.ts` — on a `failed` result, record a
  `test-failed` execution event (new `kind`, see S4) carrying the result id and `occurred_at`.
- `apps/api/src/http/routes/workers.ts` — the beat's existing `actions` channel gains a
  `capture` action: `{deviceId, fence, sessionId, kind: 'screenshot'|'logcat', context}`. The
  control plane already knows a test just failed; the beat is already the way it asks a worker for
  work. No new endpoint and no new direction of travel — ADR-0006 still holds.
- `workers/agent/src/agent.ts` — handle `capture` by calling the same `control.screenshot()` and
  `control.dumpLogcat()` that `captureArtifacts()` calls, with the same swallow-and-log discipline.
  A capture that fails must never block a release.

**The honest limit.** The beat is ten seconds, so a failure-triggered screenshot lands up to ten
seconds after the assertion — by which time a good suite may have navigated on. This is worth
shipping anyway (ten seconds late beats "after force-stop") and it is why S3 exists: the command
trace is what makes a *late* screenshot readable, because it says what happened in between.

**Test.** `apps/api/test/artifacts.test.ts` — a failed result produces a pending capture action on
the next beat, and the uploaded artifact carries the `testResultId` in `context`.

---

## S3 — There is no step trace, so nothing can be highlighted

**The gap.** The hub deliberately does not model WebDriver commands
(`apps/api/src/http/routes/webdriver.ts:670`): *"the automation server is the authority on what
exists, and a hub that enumerates commands is a hub that breaks when a driver adds one."* That rule
is correct and this step does not break it.

What BrowserStack and LambdaTest show as a step list is not a semantic model. It is method, path,
HTTP status, duration and timestamp, logged as the bytes go past. A proxy that records
`POST /element/:id/click → 200 in 84ms` has not modelled anything — it has written down what it
already forwarded. If Appium adds a command tomorrow, this logs it correctly without knowing what it
is, which is exactly the property §670 is protecting.

**Schema — migration 041.**

```sql
CREATE TABLE session_commands (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id)     ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          integer NOT NULL,          -- ordinal within the session; the step number a person sees
  method       text NOT NULL,
  path         text NOT NULL,             -- upstream path, session id stripped
  status       integer,                   -- NULL when the proxy never got an answer
  duration_ms  integer,
  started_at   timestamptz NOT NULL,
  error        text,                      -- WebDriver error name only, never the body
  UNIQUE (session_id, seq)
);
```

Append-only, same revoke as `execution_events`. **No request or response bodies** — a body carries
the customer's selectors, their test data and, on a `POST /element/value`, their passwords. The
shape is worth keeping and the contents are not ours to store.

`bigserial`, not `uuid`: a saturated four-device farm writes a few hundred of these a minute and this
is the one table in the schema with that write rate.

**Retention is mandatory, not optional.** Same reasoning as `artifacts.expires_at` — a 500 GB disk
and unbounded capture is an outage with a date on it. A sweep in `allocator.ts` alongside
`expire_artifacts`.

**Code.**

- `apps/api/src/http/routes/webdriver.ts` — the command proxy already times every hop to `touch()`
  the session. Write one row per command on the way back, fire-and-forget: **a failed insert must
  never fail the customer's command.** That is the one rule this step lives or dies by.
- `GET /v1/sessions/:id/commands` — paged, RLS-scoped, newest-last.

**The cost, stated before it is paid.** One insert per WebDriver command on a path whose whole
justification is that it adds "a few milliseconds". Batch the writes — accumulate per session in
memory, flush every 250 ms or 50 commands, flush on quit. Measure the proxy hop before and after and
put both numbers in the PR; if the added latency is not under a millisecond at the median, this ships
behind a per-org flag instead of on by default.

---

## S4 — The timeline learns about tests, and gets a screen

`execution_events`' nine kinds cover what the *farm* does and nothing about what the *test* does, so
the timeline can tell you the device was allocated at 10:30:04 and not that the test failed at
10:31:43 — the line the user came for.

**Schema — migration 042.** Four kinds onto the `CHECK`, which is one line because 019 chose
`text + CHECK` over an enum precisely so it could be:

`'test-started'`, `'test-failed'`, `'artifact-created'`, `'command-failed'`.

`command-failed` is emitted by S3's proxy on a non-2xx, and it is the join between the two tables:
the timeline entry a person clicks, the command row it came from.

**Code.**

- `apps/api/src/http/routes/results.ts` and `artifacts.ts` emit their kinds.
- `apps/api/public/console.js` — a **Timeline** card on the run detail screen, between the failures
  card and the session table. `timeline()` already exists (`console.js:690`) with `ok` / `warn` /
  `bad` / `info` / `accent` tones and is used by three other screens; this is the fourth caller, not
  a new component.
- Red is `bad`, and it is reserved for `test-failed` and `command-failed`. An `incident` stays
  `warn` — the farm having a problem is not the test failing, and the run screen already refuses to
  conflate those two. Repeating that refusal here is the point.
- Live via the existing SSE at `/runs/:id/events` while the run is open; the poll endpoint after.

**Test.** `apps/api/test/console-screens.test.ts` renders the run screen against a fixture with a
failure and asserts the red entry is the failure and the incident is not red.

---

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

1. **S1 fairness** — a live bug, a contained fix, and the first thing a second org would hit.
2. **S2 evidence at failure time** — fixes the artifact people already open and find useless.
3. **S3 command trace** — what makes a late screenshot readable, and the only source a step list can
   have that does not require every customer to instrument their suite.
4. **S4 timeline + screen** — makes S2 and S3 visible; nothing renders any of it today.
5. **S5 video** — affordable only after S2/S4 make "record only failures" expressible, and gated on
   one measurement.
6. **S6 queue visibility** — smaller than it sounds, and it is most of what "graceful queuing" means
   to a person watching a CI log.
7. **S7 ceilings** — deploy, then a second host, then the rate limiter.

Each step ships as its own PR with its own migration, and each is verified on a running farm before
the next starts — not when CI is green. `DEFECTS.md` states the reason: twice this month a fix was
reasoned, unit-tested, merged and completely inert.
