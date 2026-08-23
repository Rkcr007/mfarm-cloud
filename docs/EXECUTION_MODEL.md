# Running test suites on MFARM — what exists, what does not, and what to build

Written 2026-08-23 as a handoff, and updated the same day when §4.1 shipped. Read `HANDOFF.md` and
`docs/E2E_MVP_PLAN.md` first for the platform; this file is only about **suite execution** — how a
person submits a run, where it goes, and how they find out what broke.

**Status: §4.1 (`mfarm:appId`) is built and tested. §4.2 (`runs` + `mfarm:runId`) is next, and it is
still the one that matters most — there is no "run", so "what failed on build 4471?" remains
unanswerable.**

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

## 2. The central gap: there is no "run"

Nothing in the schema groups sessions. No `test_run` table, no `build_id`, no tag. A suite of
twenty tests creates twenty rows in `sessions` with **no relationship between them**, and the
console's Sessions screen is a flat chronological list.

So the question *"what failed on build 4471?"* is not slow to answer — it is **unanswerable**. You
can find sessions by time and squint.

Everything else below is downstream of this.

## 3. Answering the specific questions

### Which app gets installed?

**Answered by `mfarm:appId` — built 2026-08-23, see §4.1.** A suite names a build in the app library
and the farm installs it before the session opens. `appium:app` still works and still takes a path
on the device host; the two are mutually exclusive and the hub refuses both rather than picking one.

The recognised vendor namespace is now: `mfarm:region`, `mfarm:tier`, `mfarm:ttlMinutes`,
`mfarm:sessionId`, `mfarm:queueTimeoutSeconds`, `mfarm:appId`. Anything else under the `mfarm:`
prefix is **refused** — that rule was documented below before it was true, and is now enforced.

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

### 4.2 `mfarm:runId` and a `runs` table — makes a hundred executions legible

A client-supplied id (a CI run number, a UUID per `npm test`) stamped on every session it creates.

```sql
runs(id, org_id, external_id, app_build_id, started_at, ended_at, meta jsonb)
sessions.run_id → runs(id)
```

That alone buys:

- a **Runs** screen: one row per run, with the build under test, duration, and device count
- "what failed on build X" as a query rather than an archaeology exercise
- artifacts rolled up per run instead of per lease
- retention and cost attribution per run

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

~~`mfarm:appId` first~~ — **done**. `runs` + `mfarm:runId` is next, then outcome reporting. Those
three turn "I can run tests on the farm" into "our team runs suites and reads results", which is the
actual product.

`examples/medishop-suite` and its `ci-example.yml` are the worked example of the first one: upload
the APK in a CI step, pass the id it returns. Nothing in the workflow reaches the device host any
more.
