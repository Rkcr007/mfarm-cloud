# Running test suites on MFARM — what exists, what does not, and what to build

Written 2026-08-23 as a handoff. Read `HANDOFF.md` and `docs/E2E_MVP_PLAN.md` first for the
platform; this file is only about **suite execution** — how a person submits a run, where it goes,
and how they find out what broke.

---

## 1. What works today, verified on hardware

A stock WebdriverIO suite runs against the farm from a laptop. `examples/medishop-suite` is the
worked example: 8 tests green against real Cuttlefish, and `ci-example.yml` is a GitHub Actions
workflow that needs no MFARM CLI at all.

The path is: `remote()` → hub (`/wd/hub/session`) → `allocate_device()` → Ed25519 grant → worker
gateway → Appium → device. `deleteSession()` releases it, the device powerwashes, and the worker
captures a logcat and a final screenshot as **artifacts** before the wipe.

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

Today `appium:app` takes **a path on the device host**. That is why the example suite passes
`/home/rkcr070707/apks/way2automation.apk` — a real user cannot use that.

The app library already exists and is good: `app_builds` is content-addressed (`POST /v1/apps`,
re-uploading an unchanged build costs one row and no bytes), and install/launch/uninstall run
through `app_actions` over the worker heartbeat. But it is reachable **only from the console and the
CLI**. There is no way for a WebDriver session to say "install build X".

The whole recognised vendor namespace is: `mfarm:region`, `mfarm:tier`, `mfarm:sessionId`,
`mfarm:queueTimeoutSeconds`. That is it.

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

### 4.1 `mfarm:appId` — the smallest change with the largest effect

Let a suite name a build from the library instead of a path on a host:

```js
capabilities: {
  platformName: 'Android',
  'appium:automationName': 'UiAutomator2',
  'mfarm:region': 'lab',
  'mfarm:appId': process.env.APP_ID,        // or 'com.acme.app@1.4.2', or '@latest'
}
```

The hub resolves it against `app_builds` **scoped to the caller's org**, and the worker installs it
from the library before handing the session over — the same content-addressed blob the console
installs, so a build already on the device is a no-op.

This removes the host-path coupling entirely and makes the CI story natural: upload the APK, get an
id, pass the id. It is also the piece the user asked for by name.

Accept a package coordinate too (`com.acme.app@1.4.2`, `com.acme.app@latest`) — an id in a config
file is opaque, and `@latest` is what a nightly wants.

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
| `mfarm:appId` / `mfarm:app` | see 4.1 |
| `mfarm:name` | a human label per session, so the Sessions list reads as test names |
| `mfarm:build` | commit sha / branch, for "which commit broke it" |
| `mfarm:video` | opt in per session, since it costs CPU |
| `mfarm:leaseMinutes` | a long soak test and a 30-second smoke test want different leases |
| `mfarm:shard` / `mfarm:priority` | only meaningful past two devices; design now, build later |

Keep the namespace small and typed, and keep rejecting unknown `mfarm:` keys — a silently ignored
capability is the failure mode the whole vendor prefix exists to prevent.

## 6. Where to start

`mfarm:appId` first: it is self-contained, it unblocks real CI, and it needs no schema change beyond
resolving an existing table. Then `runs` + `mfarm:runId`, then outcome reporting. Those three turn
"I can run tests on the farm" into "our team runs suites and reads results", which is the actual
product.
