# Running test suites on MFARM — what exists, what does not, and what to build

Written 2026-08-23 as a handoff, and updated the same day when §4.1 shipped. Read `HANDOFF.md` and
`docs/E2E_MVP_PLAN.md` first for the platform; this file is only about **suite execution** — how a
person submits a run, where it goes, and how they find out what broke.

**Status: §4.1 (`mfarm:appId`) and §4.2 (`runs` + `mfarm:runId`) are both built and tested. "What
failed on build 4471?" is now a query and a screen. What is still missing is the OUTCOME — §4.3 —
so a run reports how many sessions it had and which build they ran, not how many passed.**

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

**What remains is the word "failed".** WebDriver has no concept of an assertion — the farm sees a
session open and close and cannot tell a passing test from a failing one — so a run reports its
sessions, its window and its build, and says nothing at all about pass or fail. Making that real is
§4.3, and it is now the one that matters most.

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
- **There is no `ended_at` and no `status`, deliberately.** A run has no end signal, and the obvious
  substitute is wrong in a way that would be believed: "the last session ended" would mark a
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

### 4.3 Outcome reporting — the farm cannot know a test failed

WebDriver has no concept of an assertion. The farm sees a session open and close; whether the test
passed is invisible to it. There are only two honest options, and the first is right:

```js
// one line in an afterEach
POST /v1/sessions/:id/result { status: 'failed', name: 'checkout applies a promo', failure: '...' }
```

Anything else is inference dressed up as fact. With this plus 4.2, the Runs screen shows real
pass/fail counts and links each failure to its own logcat and screenshot.

### 4.4 Video

`adb shell screenrecord` during the session, uploaded as an artifact on release. Three things to
settle before building it: it costs device CPU on a software renderer, 3-minute segments need
stitching, and retention must be shorter than logcat's or the disk conversation arrives quickly.

### 4.5 On-demand screenshots

The release-time screenshot is taken **after Appium force-stops the app**, so it shows the launcher,
not the failure. `examples/medishop-suite` works around this by screenshotting locally in
`withDevice()`. The fix is a `screenshot` kind on `app_actions`, which inherits heartbeat delivery,
host scoping and the fence check for free (migration 015 generalised the pipeline for exactly this).

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

~~`mfarm:appId` first~~ — **done**. ~~`runs` + `mfarm:runId`~~ — **done**. **Outcome reporting
(§4.3) is next**, and it is the last of the three that turn "I can run tests on the farm" into "our
team runs suites and reads results", which is the actual product.

The reason it is last and not optional: the two that shipped make a run findable and tell you which
build it ran, and then stop exactly where a person's question starts. A Runs screen that cannot say
how many tests passed is a table of device leases with better grouping.

`examples/medishop-suite` and its `ci-example.yml` are the worked example of both: upload the APK in
a CI step, pass the id it returns, and pass `github.run_id` as `MFARM_RUN_ID`. Nothing in the
workflow reaches the device host, and the eight tests arrive as one run.

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
