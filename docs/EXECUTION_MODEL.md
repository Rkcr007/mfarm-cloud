# Running test suites on MFARM — what exists, what does not, and what to build

Written 2026-08-23 as a handoff, and updated the same day when §4.1 shipped. Read `HANDOFF.md` and
`docs/E2E_MVP_PLAN.md` first for the platform; this file is only about **suite execution** — how a
person submits a run, where it goes, and how they find out what broke.

**Status: §4.1 (`mfarm:appId`), §4.2 (`runs` + `mfarm:runId`) and §4.3 (outcome reporting) are all
built. "What failed on build 4471?" is a query, a screen, and a link to the logcat and screenshot
from the session that failed. What is left is §4.4 (video) and §4.5 (on-demand screenshots), and
video should stay unbuilt until it can record only failures — see the note there.**

---

## 1. What works today, verified on hardware

A stock WebdriverIO suite runs against the farm from a laptop. `examples/medishop-suite` is the
worked example: 8 tests green against real Cuttlefish, and `ci-example.yml` is a GitHub Actions
workflow that needs no MFARM CLI at all.

The path is: `remote()` → hub (`/wd/hub/session`) → `allocate_device()` → **`mfarm:appId` install,
if asked for** → Ed25519 grant → worker gateway → Appium → device. `deleteSession()` releases it,
the device powerwashes, and the worker captures a logcat and a final screenshot as **artifacts**
before the wipe.

**One WebDriver session = one device lease.** That is the whole execution model right now.

## 2. The central gap: CLOSED (2026-08-23), except for the outcome

**This section described the defect that shaped everything below it, and half of it is now fixed.**

Nothing in the schema grouped sessions: no `test_run` table, no `build_id`, no tag. A suite of
twenty tests created twenty rows in `sessions` with **no relationship between them**, and the
console's Sessions screen was a flat chronological list — so *"what failed on build 4471?"* was not
slow to answer, it was unanswerable.

Migration 020 and `mfarm:runId` close the grouping half (§4.2). A run is now a row, sessions belong
to it, the build each session ran is an indexed column rather than a jsonb key, and the console has
a Runs screen.

**The word "failed" is now real too (§4.3, 2026-08-24).** The farm still cannot observe an
assertion and never will — but the suite reports, and a run that does not report reads as
"Not reported" rather than as a pass. The gap this section described is closed.

## 3. Answering the specific questions

### Which app gets installed?

**Answered by `mfarm:appId` — built 2026-08-23, see §4.1.** A suite names a build in the app library
and the farm installs it before the session opens. `appium:app` still works and still takes a path
on the device host; the two are mutually exclusive and the hub refuses both rather than picking one.

The recognised vendor namespace is now: `mfarm:region`, `mfarm:tier`, `mfarm:ttlMinutes`,
`mfarm:sessionId`, `mfarm:queueTimeoutSeconds`, `mfarm:appId`, `mfarm:runId`. Anything else under
the `mfarm:` prefix is **refused** — that rule was documented below before it was true, and is now
enforced.

### Which sessions belong together?

**Answered by `mfarm:runId` — built 2026-08-23, see §4.2.** A suite stamps every session with an id
its CI already has, and the farm creates the run on first use and joins it thereafter.

### Where are sessions stored, and how are they viewed?

`sessions` (per lease) plus `artifacts` (migration 019) — logcat and one screenshot per session,
content-addressed on disk, 14-day retention, visible in the console under the session's **Evidence**
card and downloadable.

### Video recordings?

**Not built.** `recording` was deliberately removed from the Cuttlefish capability list rather than
left as a claim with nothing behind it. `artifacts.kind` is `('logcat', 'screenshot')`.

### Ten or a hundred executions?

The allocator is sound under contention — `FOR UPDATE SKIP LOCKED`, a monotonic fence, a per-org
concurrency cap, and `promote_queued()` — and `mfarm:queueTimeoutSeconds` turns "no capacity" into a
queue rather than an instant failure. A hundred requests will queue and drain correctly.

They will drain **two at a time**, because the farm has two devices. There is no sharding, no
priority, and no fair share between people. Correct, and slow.

## 4. What to build, in order

### 4.1 `mfarm:appId` — DONE (2026-08-23)

A suite names a build from the library instead of a path on a host:

```js
capabilities: {
  platformName: 'Android',
  'appium:automationName': 'UiAutomator2',
  'mfarm:region': 'lab',
  'mfarm:appId': process.env.APP_ID,        // or 'com.acme.app@1.4.2', or 'com.acme.app@latest'
}
```

The hub resolves it against `app_builds` **scoped to the caller's org** (RLS, so another org's build
id is indistinguishable from one that never existed), then queues an ordinary `app_actions` install
and blocks until the worker reports it done. Four forms resolve:

| `mfarm:appId` | resolves to |
|---|---|
| a uuid | that exact build — the reproducible form |
| `com.acme.app@1.4.2` | the newest build with that `versionName` |
| `com.acme.app@latest` | the newest build of the package |
| `com.acme.app` | the same as `@latest` |

Six things that were decided while building it and are not obvious from the capability alone:

- **Resolution happens before allocation.** A typo must not spend a device lease, or on a busy farm
  a queue wait, to say "no such build".
- **The install goes before `POST /session` upstream.** Appium's `createSession` is what launches
  the app, so a session opened first would have run its first command against the launcher.
- **`app-install` joins `webdriver` in `requireCapabilities`,** so a device that cannot install is
  never allocated for a session that needs one — and the no-capacity message says which requirement
  went unmet, instead of making the farm look full.
- **The resolved build id comes back** as `mfarm:appId` in the returned capabilities, and is stored
  on the `webdriver_sessions` row. `@latest` is deliberately not reproducible; recording what it
  resolved to is what keeps a nightly's result explicable. This is also the first column that will
  matter to the Runs screen in §4.2.
- **The hub sets `appium:appPackage`** to the resolved package so Appium foregrounds it, and does
  not set `appium:appActivity` — the driver resolves the launchable activity, and guessing at the
  caller's manifest would be worse than letting it. An explicit `appium:appPackage` from the suite
  wins, because preloading a build is not the same as launching it.
- **It costs up to one heartbeat (10 s) plus the install, on every session.** Nothing is ever already
  installed: a device is powerwashed between leases. The control plane cannot dial a worker, so the
  job goes down on the next beat — reusing that pipeline is what buys the fence re-check at delivery,
  the host-scoped blob authorisation and the worker's digest verification for free. If the latency
  starts to hurt, the fix is a shorter beat or a nudge on the automation endpoint, **not** a second
  install path.

### 4.2 `mfarm:runId` and a `runs` table — DONE (2026-08-23)

A suite stamps every session it opens with an id its CI already has:

```js
capabilities: {
  'mfarm:region': 'lab',
  'mfarm:appId': process.env.APP_ID,
  'mfarm:runId': process.env.GITHUB_RUN_ID,   // or a uuid per `npm test`
}
```

The FIRST session to use a name creates the run; every later one joins it. That is what makes it a
one-line change with no coordination call, no run-create step that can fail, and nothing left to
clean up when a suite dies halfway. Migration 020:

```sql
runs(id, org_id, external_id, created_at)      -- UNIQUE (org_id, external_id)
sessions.run_id             → runs(id)
webdriver_sessions.app_build_id → app_builds(id)
```

`GET /v1/runs` rolls up per run, `GET /v1/runs/:id` takes either the uuid **or the name** — so
`/v1/runs/4471` works from a CI job that never saw a uuid — and the console has a Runs screen with
both directions navigable: a run lists its sessions, a session names its run.

Five things decided while building it that are not obvious from the capability:

- **The unique index is `(org_id, external_id)`, and that is the whole safety argument for
  client-chosen names.** Every CI system on earth numbers builds from 1, so two tenants both running
  `mfarm:runId: '412'` is the ordinary case. A global index would have merged them — each org
  reading the other's session list with no policy violated, because both genuinely own the row.
- ~~**There is no `ended_at` and no `status`, deliberately.**~~ **Changed 2026-09-01 by ADR-0018 and
  migration 031 — see §4.7.** The reasoning below was that a run has no *derivable* end. It does not,
  and that still rules out every derived substitute. What it can have is a **declared** one, from the
  suite or from `mfarm run` at child exit, and a declared end is not an inference. The original
  reasoning, which is why the column is `completed_at` and not a status: "the last session ended" would mark a
  sequential twenty-test run finished nineteen times before it was. The window is derived from the
  sessions and the live count is reported as a count; §4.3 is what makes a real end knowable. Same
  reasoning as 019 removing `video` from the artifact kinds.
- **No `app_build_id` on the run.** A run's sessions can legitimately name different builds — an
  upgrade test, an A/B — so one denormalised column would silently pick a winner. The build is
  recorded on the SESSION that installed it, and the run reports `buildCount`, naming a build only
  when there is exactly one.
- **`webdriver_sessions.app_build_id` is now a column, not just a jsonb key.** §4.1 already recorded
  the resolved build, but inside `capabilities`, which is stored for support. "What failed on build
  X" is the query this whole section exists for, and against jsonb it is a scan with a cast in the
  predicate and no referential integrity. Migration 020 adds the column and backfills it, joined
  through `app_builds` on org — the blob is tenant-influenced, so a value in it is a string that
  looks like a build id until a real row confirms it.
- **`mfarm:runId` is allowed beside `mfarm:sessionId`, unlike tier and ttl.** Those are instructions
  to an allocator that has already run, so they are refused. A run id is a label and changes nothing
  about which device was chosen, so `mfarm run` and an explicit run id compose. Two DIFFERENT run
  ids on one session is refused: the lease and its cost belong to one run or the other.

What is still missing is the outcome — see §4.3. A run today reports how many sessions it had and
which build they ran, not how many passed.

### 4.3 Outcome reporting — DONE (2026-08-24)

WebDriver has no concept of an assertion. The farm sees a session open and close; whether the test
passed is invisible to it. There were only two honest options, and the first was right:

```js
// one line in an afterEach
POST /v1/sessions/:id/result { status: 'failed', name: 'checkout applies a promo', failure: '...' }
```

Anything else is inference dressed up as fact — and it is wrong in both directions: a suite can fail
assertions and exit zero, and a session can end dirtily because CI was cancelled.

Migration 021 adds `test_results`, one row per TEST rather than per session — `examples/medishop-suite`
runs eight tests on one device, which is the shape the economics force. `GET /v1/runs` now carries
outcome counts, `GET /v1/runs/:id` lists every failure with the session that produced it, and the
console's Runs screen shows both.

Five decisions in it that are not obvious from the endpoint:

- **A run that reported nothing is UNMEASURED, not passing.** The rollup carries
  `tests.sessionsReporting` alongside the counts, and the console renders zero-reports as
  "Not reported". A green zero on a run nobody instrumented is precisely the number that stops
  people looking, and it is the only way this feature could make things worse than having none.
- **`(session_id, name)` is not unique.** A retry reports the same name twice — failed, then passed —
  and that pair IS the flakiness signal, which is the most valuable thing this table can eventually
  show. Deduplicating would discard it and would break parameterised tests that share a name. The
  cost is that a retried test contributes two results, and the API says so rather than guessing
  which attempt was "real".
- **A result is accepted for a session in any state, including one that has ended.** The case where
  a session ended *unexpectedly* is exactly the one whose result is most worth having; refusing it
  would drop data precisely when a test crashed.
- **An over-long failure is truncated, not rejected** — with the cut marked in the text, because a
  stack that silently stops gets debugged as if it were complete. Rejecting would cost the caller
  the one thing they called to report.
- **The rollup uses a SECOND lateral.** Sessions and results are independent one-to-many branches
  off a run; counting both in one join multiplies them, so a run of 3 sessions with 8 results each
  would report 24 sessions. Same trap §4.2 documents, one level down.

The link that makes it worth having: each failure carries its `sessionId`, which is what the logcat
and screenshot hang off. "What failed on build 4471, and what did the screen look like" is now one
query and one click.

### 4.4 Video — costed 2026-08-24, and deliberately still not built

`adb shell screenrecord` during the session, uploaded as an artifact on release. The three concerns
below were vague when this section was written; they have now been measured, and two of them are
worse than they sounded.

**It perturbs the thing it measures.** The lab host has no GPU (the account's free tier blocks
accelerators), so Cuttlefish renders through SwiftShader in software and `screenrecord` encodes
H.264 in the guest on the same CPU. `docs/RENDER_BASELINE.md` already measures a Flutter drawing
canvas at 30 fps with 1350 ms frozen frames; adding a software encoder makes that worse on exactly
the workload with least headroom. The baseline's own warning is that the risk "is not red suites, it
is timing-sensitive assertions and screenshot comparisons silently reading a device three frames
behind" — recording makes that more likely, not less.

**The storage arithmetic, against real numbers.** 28 sessions of production artifacts average
2.55 MB of logcat and 0.59 MB of screenshot — 3.1 MB per session. A 5-minute recording at a modest
1 Mbps is **37.5 MB**, about 12x everything else combined. Against `mfarm-cp`'s 24 GB free at the
current 14-day retention:

| Load | Video/day | Disk exhausted in |
|---|---|---|
| 50 sessions/day | 1.9 GB | ~13 days |
| two devices saturated (~480/day) | 18 GB | **~1.3 days** |

`ARTIFACT_MAX_UPLOAD_BYTES` is 64 MB, so at 1 Mbps any session over ~8.5 minutes is rejected
outright, and `screenrecord` caps a single recording at 3 minutes so anything longer needs
segmenting and stitching. Content addressing does not help: no two recordings are byte-identical.

**What makes it affordable is §4.3, which is why the order matters.** Video's value is explaining a
red test; recording every session and discarding 95% pays full CPU, disk and upload for nothing. Now
that a suite reports outcomes, "record only failures" is expressible — and that is the difference
between a feature that fills a disk in a day and one that costs almost nothing. Build it in this
order:

1. record on the HOST, reusing the encode cvd's WebRTC streamer already does at 49–53 fps, rather
   than a second encoder inside the guest competing with the app under test;
2. keep only recordings for sessions that reported a failure;
3. 10–15 fps at ~500 kbps — UI testing does not need 60 fps, and this roughly quarters both costs;
4. retention in days, not the fortnight logcat gets.

One thing still needs measuring before any of it: what `screenrecord` actually costs on this
hardware, run against the Flutter canvas workload where there is least headroom. That is a
lab-hours experiment, not a design question.

### 4.5 On-demand screenshots — DONE (2026-08-24)

The release-time screenshot is taken **after Appium force-stops the app**, so the artifact a person
opens to see why a test failed reliably shows the launcher. `examples/medishop-suite` worked around
it by screenshotting locally inside `withDevice()` — which works, and which every other suite would
have had to reinvent.

`POST /v1/sessions/:id/app-actions {"kind":"screenshot"}` captures one while the suite still holds
the device, and it lands in the artifact store beside the logcat. It inherits heartbeat delivery,
host scoping, the fence re-check at delivery and the orphan sweep from the pipeline migration 015
generalised for exactly this.

Four things it turned up:

- **The heartbeat INNER JOINed `app_builds`.** A screenshot names no app, so as written it matched
  nothing: the row would stay PENDING, be re-offered on every beat, and be swept as an orphan when
  the session ended — with no error anywhere, and a worker that is never offered a job looking
  exactly like a farm that is merely slow. Now a LEFT JOIN, pinned by a test.
- **`app_action_kind` was a Postgres enum,** which is the trap 019 wrote down before this migration
  needed it: `ALTER TYPE ... ADD VALUE` cannot be used in the transaction that adds it, so a new
  verb plus a constraint mentioning it takes two migrations. 022 converts `kind` to `text` + CHECK,
  so the next verb is one line. Doing it at the fourth verb cost one rewrite of a small table.
- **The capability a verb needs depends on the verb.** The precondition demanded `app-install` for
  everything; a tier can capture a screen without being able to install anything, so a screenshot
  now requires `screenshot` and the error names whichever is missing.
- **The worker needs the session id.** An artifact is filed against a session, and a worker that
  inferred it from the device it holds would attach evidence to the wrong tenant the moment a device
  changed hands mid-beat. `AppActionRequest` carries `sessionId` now.

The local workaround in `examples/medishop-suite` stays, deliberately: it needs no round trip and no
capability, and a suite that wants a screenshot at an exact instant is better served by taking one
itself. This exists for everything that cannot — CI with no tab open, and the console.

### 4.6 The execution timeline — BUILT (2026-09-01)

`AutomationExecutionPlan.md` asks for an explicit state machine whose transitions are persisted
(§4), a live event feed (§17) and a per-run timeline (§18). They are the same rows read three ways,
so migration 030 adds one table, `execution_events`, and `GET /v1/runs/:id/timeline` reads it.

The gap it closes is the same shape as the one §4.2 closed. A run's rollup is DERIVED at read time
from `sessions` and `test_results`, which answers *what ran* and *what failed* but not *what
happened*: a session that waited four minutes for capacity and one allocated instantly leave
identical rows behind, so "why was this run slow" was not a slow question, it was unanswerable.

Five things decided while building it:

- **Append-only, and `mfarm_app` has no UPDATE or DELETE.** A timeline that can be rewritten is not
  evidence, and the entire value of this table is explaining a run that has already gone wrong. The
  revoke is the point rather than the tidy-up it was in 014, 023 and 024.
- **`run_id` is NOT NULL, so a session naming no run writes nothing.** This is the timeline OF A
  RUN; a lease taken by somebody poking at a device from the console is not one. It is expressed as
  an `INSERT ... SELECT` that matches no rows, rather than as a branch a caller could forget.
- **No `state` column on the event.** A transition is `kind` plus `occurred_at`, and deriving the
  current state from the last event cannot disagree with the history — whereas a denormalised state
  can, and eventually does.
- **A queued session emits BOTH `session-queued` and `device-allocated`.** One combined event would
  make "how much did anything queue last week" a scan of a jsonb key instead of a count of a kind.
- **An event never fails the thing it describes.** Every write is wrapped and swallowed. A timeline
  is diagnostic; a session is the product, and failing a customer's session to protect a chart is
  the wrong trade in a way that is only obvious afterwards.

The events today are the farm's own actions — `run-created`, `session-queued`, `device-allocated`,
`session-active`, `session-ended` — plus install and incident kinds the schema allows and the hub
does not yet emit. **Nothing here is ever a claim about the test.** Per ADR-0018 that is the
customer's to report, and §4.3 is where it lives.

Still to come on top of this: the declared end (§4.2's note above), and SSE so the console can watch
a run progress rather than poll (§17).

---

### 4.7 The declared end of a run — BUILT (2026-09-01)

`POST /v1/runs/:id/complete`, from an `after` hook or a CI `always` step. Migration 031 adds one
column, `runs.completed_at`.

This is the section §4.2 said could not be written. It still cannot be *derived* — "the last session
ended" would mark a twenty-test run finished nineteen times before it was — but ADR-0018 settled that
the customer owns the test process, and a process can SAY when it is done. That is the whole
difference between this and the inference §4.2 refused.

Four decisions:

- **One column, not a status.** Whether the run PASSED is already answered by `test_results`, from
  the only party that can observe an assertion (§4.3). A status here would either duplicate that —
  two numbers that can disagree, and eventually will — or invite a caller to declare an outcome the
  farm cannot check. Completion says exactly one thing: **nobody is going to add more to this run.**
- **That one thing is what the rollup was missing.** `tests.failed = 0` on a live run means "so
  far"; on a completed run it means "none". Same number, and only the second is safe to gate a merge
  on.
- **A run with no completion is INCOMPLETE, never FAILED.** A killed suite, a timed-out CI job, a
  laptop that slept — none is evidence about the product. Rendering them as failure is the same
  manufactured claim 021 refuses when it declines to infer pass/fail from an exit code.
- **Completing twice is not an error.** The natural caller is an `after` hook or an `always` step,
  both of which run more than once when a suite retries or a job is re-run. A 409 would turn a green
  pipeline red for doing the right thing twice, so the first completion stands, the timestamp does
  not move, and the timeline records one `run-completed` rather than one per call.

The rollup comes back in the same response, so CI can close the run and read its final result in one
call instead of completing and then polling what it just closed.

---

### 4.8 The live event stream — BUILT (2026-09-01)

`GET /v1/runs/:id/events`, server-sent events. The §17 half of the same table §4.6 added.

**Why SSE and not a WebSocket.** This is one-way — the farm tells the viewer what happened and the
viewer says nothing back. SSE is a plain HTTP response, so it inherits the bearer auth, the rate
limiter, the tenant hook and Caddy's TLS unchanged, and `EventSource` reconnects on its own. The data
plane already carries the one thing that genuinely needs a socket (ADR-0007); a second socket
protocol here would be another thing to keep alive for no new capability.

Four things it gets right, three of which are only testable over a real socket:

- **The backlog is sent on connect, before any live event.** A viewer that fetched `/timeline` and
  then subscribed would lose anything that happened in between, and the hole is invisible: the
  stream looks healthy and the run merely appears to skip a step. History first, then live, no
  second call to race against.
- **Disconnects use `clientGone`, never `req.raw.destroyed`.** That flag flips true at the first
  `await` on a healthy request. It is now shared code (`src/http/clientGone.ts`) rather than copied,
  on ADR-0011's rule that a check existing twice eventually disagrees with itself — and it matters
  more here than that rule usually implies, because the wrong version passes every `app.inject()`
  test ever written.
- **The subscription is always released**, through one idempotent teardown. A listener holding a
  dead socket is a leak that surfaces weeks later as an OOM in a process that looks idle.
- **The registry is bounded** — 500 runs, 20 watchers each — and drops new subscriptions rather
  than evicting existing ones, so a viewer already watching keeps working and the one who cannot
  connect is told immediately.

**Single instance only, and this is the SECOND reason rather than a new one.** ADR-0001 already
blocks a second control-plane process because rate limiting is in memory. If that is ever lifted,
both must move together: a viewer connected to instance B silently missing every event produced on
instance A is a far quieter failure than a doubled rate limit.

The tests run over a real listening socket, and each was **mutation-checked** — the leak assertion
was confirmed to go red when the unsubscribe is removed, and the backlog assertion when the replay
is removed. An injection test is only as good as its ability to fail; see HANDOFF issue 43.

---

## 5. Other capabilities worth having

| capability | why |
|---|---|
| `mfarm:runId` | see 4.2 — the one that matters |
| ~~`mfarm:appId`~~ | built, see 4.1 |
| `mfarm:name` | a human label per session, so the Sessions list reads as test names |
| `mfarm:build` | commit sha / branch, for "which commit broke it" |
| `mfarm:video` | opt in per session, since it costs CPU |
| `mfarm:leaseMinutes` | a long soak test and a 30-second smoke test want different leases |
| `mfarm:shard` / `mfarm:priority` | only meaningful past two devices; design now, build later |

Keep the namespace small and typed, and keep rejecting unknown `mfarm:` keys — a silently ignored
capability is the failure mode the whole vendor prefix exists to prevent. (That rejection did not
actually exist until `mfarm:appId` shipped; an unrecognised `mfarm:` key was stripped and forgotten.
`mfarm:appid` would have started a session on a device with no app on it and reported whatever the
launcher showed.)

## 6. Where to start

~~`mfarm:appId`~~, ~~`runs` + `mfarm:runId`~~, ~~outcome reporting~~ — **all three done.** Together
they turn "I can run tests on the farm" into "our team runs suites and reads results", which is the
actual product. The first two made a run findable and named the build it ran; the third is what
lets it say whether anything passed.

`examples/medishop-suite` and its `ci-example.yml` are the worked example of all three: upload the
APK in a CI step, pass the id it returns, pass `github.run_id` as `MFARM_RUN_ID`, and let `farmTest`
report each outcome. Nothing in the workflow reaches the device host; the eight tests arrive as one
run with real pass/fail counts and each failure linked to its own logcat and screenshot.

**What to build next, and it is no longer in this section's list.** §4.5 (on-demand screenshots) is
small, useful and unblocked — the release-time screenshot still shows the launcher. §4.4 (video) is
now costed above and should stay unbuilt until it records only failures, which §4.3 has just made
possible. Beyond those, the honest next question is not another capability: it is whether a
two-device farm with a working execution model is worth putting in front of a second team.

**Hardware verification found a real bug, 2026-08-23 — see HANDOFF issue 31.** `mfarm:appId`
failed on every session because both of the hub's long waits took `req.raw.destroyed` to mean "the
client hung up", when it actually means "the request body has been read". `mfarm:queueTimeoutSeconds`
had never queued for the same reason. Fixed with `clientGone(reply)` and a test that uses a real
socket, since `app.inject()` cannot reproduce it.

**BOTH ARE NOW VERIFIED ON HARDWARE (2026-08-23), against two real Cuttlefish devices.**
`deploy/verify-runs.mjs` reproduces it: a build resolved from the library, installed over the
heartbeat, and a session opened on it in **12.1 s including the install**; two sessions joining one
run; the run resolving by the name the suite gave it. And the open question is answered —
`current_package` came back as the app under test, so **`appium:appPackage` alone is enough for
UiAutomator2** to bring it up. No `appium:appActivity` is needed and the doc note that was drafted
for it is not.

`deploy/verify-queue.mjs` covers the other half of issue 31: fill the farm, ask for one more with a
timeout, and prove the request is still open five seconds later. It was promoted onto the freed
device after 69 s. `mfarm-lab` has been stopped since before §4.1 shipped, so
the install chain (hub queues → real worker → `adb install` → Appium session) and the run stamping
on top of it have only ever run against the real heartbeat and events endpoints with a test playing
the worker. The specific thing to watch on the first hardware run is whether UiAutomator2 resolves
the launchable activity from `appPackage` alone; if it does not, suites need one line of
`appium:appActivity` and the fix is a note here, not code.
