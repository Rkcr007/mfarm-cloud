# MFARM_CLOUD — state of play

Last updated 2026-08-29. **New here? Read [`docs/INDEX.md`](docs/INDEX.md) — the one curated page:
what is built, every decision and what it rejected, the roads not taken, and every measured number.
For the hands-on path instead, `docs/START_HERE.md` goes from a closed laptop to a device you can
tap in seven steps.** This file is the state of play and every known issue.

**Two machines (ADR-0006): `mfarm-cp` holds the control plane and console at
https://farm.mfarm.dev; `mfarm-lab` holds the devices.**

**As of 2026-08-29 `mfarm-lab` is STOPPED and `mfarm-cp` is RUNNING.** That is deliberate rather
than half-finished: the lab is the ~₹65/hour half and there is no reason to pay it between
sessions, while the control plane is a few rupees an hour and keeping it up means the console, the
API and every link into them still resolve. `./deploy/farm-online.sh` starts both and re-points the
media relay; `./deploy/farm-check.sh` waits for the devices and reports what is actually live.

**Read `## Next session — pick up here` at the very bottom of this file first.** It is the only
section written for someone arriving cold.

**2026-09-01 — THE EXECUTION RECORD IS BUILT AND VERIFIED ON HARDWARE.** Control plane on
`1dbbc2f`, migrations through 031. `AutomationExecutionPlan.md` §4, §17, §18 and §35 are done, and
ADR-0018 is what made them expressible.

The shape that matters: §4 (a persisted state machine), §17 (a live feed) and §18 (a timeline) look
like three features and are **the same rows read three ways**, so they are one append-only table —
`execution_events`, migration 030. §35's "attempt" needed nothing: a `sessions` row already IS one
device lease.

- **`GET /v1/runs/:id/timeline`** — verified against two real sessions joining one run:
  `run-created → device-allocated → session-active → device-allocated → session-active →
  session-ended → session-ended`, in order.
- **`GET /v1/runs/:id/events`** — server-sent events, backlog replayed on connect then live. THE
  FIRST SSE IN THIS CODEBASE. `clientGone` moved to `src/http/clientGone.ts` and is now shared with
  the hub rather than copied, on ADR-0011's rule — and it matters more here, because the wrong
  version passes every `app.inject()` test ever written.
- **`POST /v1/runs/:id/complete`** — migration 031, the declared end that migration 020 said could
  not exist. It could not be DERIVED; ADR-0018 settled that the customer owns the test process, so
  the process can say it. One column, no status: whether the run PASSED is still `test_results`.
  Verified idempotent, and it records one `run-completed` event however many times CI calls it.

**Three sections of that plan turned out to be already built rather than missing** — §32's
stuck-device detection is `mfarm_device_cleaning_age_seconds_max` plus the `MfarmDeviceResetStuck`
alert, and most of §26 and §30 predate the document. See [[mfarm-spec-docs-overstate]].

**`farm-online.sh`'s drift check is confirmed fixed in production**: the first real start since
2026-08-20 that printed no DRIFT, with both addresses matching their names.

**Still not fixed:** `farm-check.sh` reports "no agent tunnel connected" as a false negative when
run straight after a host start — it checks the tunnel at a fixed point that can precede the agent
connecting. Re-running says the farm is live. Recorded, not fixed.

**2026-09-01 — BOTH INJECTION DEFECTS ARE FIXED AND VERIFIED ON HARDWARE.** Control plane is on
`18367e0` (was `bcf757c`), migration 029 applied.

**A lease is no longer spent on a device that cannot automate.** The heartbeat now reconciles
`automation_endpoint` and the `webdriver` capability per device. The agent had ALWAYS sent this on
every beat — the handler parsed the body and read none of it, so the only writer of
`devices.capabilities` was registration, which a healthy agent never performs. Verified with Appium
held at zero processes: the farm answered *"No android device with an automation server is free in
region lab"* instead of allocating one and failing with `automation_unreachable`. It self-healed in
**109.9s** (supervisor gives up at 6 failed starts → incident → systemd restart → cold boot).

**An abandoned client no longer holds its device for thirty minutes.** Migration 029 adds
`expire_idle_webdriver_sessions()` to the reaper, keyed on `last_command_at` — a column written on
every proxied command, with an index built for exactly this in migration 006, that nothing had ever
read. Verified against the REAL 600s production default rather than a tuned-down one: **device
reclaimed 649.8s** after the client vanished.

`WEBDRIVER_IDLE_TIMEOUT_MS` defaults to 600s and must stay above the longest single COMMAND (not the
gap between commands) and above the client's own `appium:newCommandTimeout` — `examples/medishop-suite`
sets 300. It is read from `process.env` inside the sweep, like `HOST_SILENCE_TIMEOUT_MS`, so it does
not appear in the startup config line.

**2026-09-01 — FAILURE INJECTION, and three defects it found in one afternoon (issue 43).**
`deploy/verify-failure.mjs` breaks real things on real hardware and asks whether the farm comes back
clean. `AutomationExecutionPlan.md` §41 asks for this and ranks it 41st of 46; it should be first,
and this is the evidence. **ADR-0018** settles that document's central question first: MFARM owns
the execution RECORD, the customer owns the test PROCESS.

The one that matters: **a lease is spent on a device that cannot automate.** With Appium at zero
processes for 26 seconds, `GET /v1/devices` still reported `webdriver` on every device and
`POST /session` allocated one and then returned **500 `automation_unreachable`**. That is precisely
what ADR-0003 exists to prevent. The agent side is correct — `setAutomationEndpoint(undefined)`
drops the capability from what the agent reports — but its own comment says the rest: *"nothing here
reaches the control plane until the next registration"*, and `capabilityFingerprint()` is only
consulted in `start()`. A RUNNING agent never re-registers, so `devices.capabilities` stays stale and
`requireCapabilities` filters on it.

What is NOT broken, and was measured rather than assumed: the supervisor's bounded recovery is
right. Six consecutive failed starts → `appium-failure` incident → agent exits → systemd restarts →
**the farm is fully back in ~110s**, cold-booting every device. That is §11 working as specified.

Also fixed: **`farm-online.sh`'s address-drift check had been reporting DRIFT on every start since
2026-08-20** and both addresses were correct the whole time. It compared the VM's IP to
`$MFARM_TURN_HOST`, which was an IP literal under sslip.io and became `turn.mfarm.dev` when the
domain landed. A warning that fires every time is one people scroll past, so the run where an
address genuinely moved would have looked identical to the twelve days before it. Now resolves the
name first, and reports an unresolvable name as its own outcome rather than as drift —
`deploy/farm-online.test.mjs` pins all four cases.

**`farm-check.sh` reports "no agent tunnel connected" as a false negative** when run straight after a
host start: it waits for devices but checks the tunnel at a fixed point that can precede the agent
connecting. Re-running says the farm is live. Not fixed; recorded.

**2026-08-24 — on-demand screenshots (§4.5).** `POST /v1/sessions/:id/app-actions
{"kind":"screenshot"}` captures the screen while the suite still holds the device, instead of the
release-time one that shows the launcher because Appium force-stopped the app first. Building it
found that the heartbeat **INNER JOINed `app_builds`**, so a verb naming no app matched nothing and
would have sat PENDING forever with no error anywhere. Migration 022 also converts
`app_actions.kind` from a Postgres enum to `text` + CHECK — 019 wrote down why enums are the wrong
choice here, and this is the migration that paid for it; the next verb is now one line. The
capability check is per-verb too: a tier can capture a screen without being able to install.

**2026-08-24 — outcome reporting: the farm learns whether the test passed (§4.3).** `POST
/v1/sessions/:id/result` takes one test's name, status and failure, from an `afterEach`. Migration
021 stores a row per TEST, not per session, because a suite runs eight tests on one device. The
Runs screen now shows real pass/fail counts and lists every failure with a link to the session that
produced it — which is where its logcat and screenshot live. **A run that reported nothing reads
"Not reported", never as a pass**: a green zero on a run nobody instrumented is the number that
stops people looking, and it is the only way this feature could have made things worse. A retry is
two results on purpose (failed, then passed) because that pair is the flakiness signal, and the
farm cannot tell a retry from a distinct test of the same name. `examples/medishop-suite` reports
through `farmTest`; the README shows the WebdriverIO `afterTest` one-liner for runners whose hooks
carry the outcome.

**2026-08-24 — video is COSTED but still not built,** and the order now matters: recording only
failures is what makes it affordable, and that was not expressible until §4.3 existed. Measured
against production numbers, always-on video is ~12x all other artifacts combined and would exhaust
the control plane's disk in 1.3 days at full utilisation. It also encodes in-guest on a host with
no GPU, competing with SwiftShader for the same CPU on the workload that already has least
headroom. See `docs/EXECUTION_MODEL.md` §4.4 for the arithmetic and the build order.

**2026-08-23 — both new capabilities are VERIFIED ON HARDWARE, and doing so found issue 31.**
`mfarm:appId` failed on every session in production while 634 tests passed, because both of the
hub's long waits mistook "the request body has been read" for "the client hung up". Fixed;
`deploy/verify-runs.mjs` and `deploy/verify-queue.mjs` are the checks that would have caught it.
One open question is now closed: **`appium:appPackage` alone is enough for UiAutomator2** to launch
the app, so no suite needs `appium:appActivity`.

**2026-08-23 — `runs`: twenty tests are one run.** A suite sets `mfarm:runId` to an id its CI
already has — `$GITHUB_RUN_ID`, a Jenkins build number, a uuid per `npm test` — and the FIRST
session to use that name creates the run while every later one joins it. No coordination call, no
create step that can fail, nothing to clean up when a suite dies halfway. `GET /v1/runs` rolls up
per run; `GET /v1/runs/:id` takes the uuid **or the name**, so `/v1/runs/4471` works from a job that
never saw a uuid; the console has a Runs screen and both directions are navigable. The unique index
is `(org_id, external_id)` and that is the whole safety argument for letting clients pick names —
every CI system numbers builds from 1, so a global index would have merged two tenants' runs with no
policy violated. `webdriver_sessions.app_build_id` is now a real foreign key rather than a jsonb
key, which is what makes "what failed on build X" a query. **There is deliberately no `ended_at` and
no run status**: a sequential suite ends every session before starting the next, so "the last
session ended" would mark a twenty-test run finished nineteen times before it was — and WebDriver
has no concept of an assertion, so any pass/fail today would be inference presented as fact. Both
are `docs/EXECUTION_MODEL.md` §4.2; §4.3 (outcome reporting) is what makes them real and is next.

**2026-08-23 — `mfarm:appId`: a suite names its build instead of a path on the device host.** A
WebDriver session can set `mfarm:appId` to a build in the org's app library — a uuid,
`com.acme.app@1.4.2`, `com.acme.app@latest`, or a bare package name — and the farm installs it over
the existing `app_actions` heartbeat pipeline **before** the Appium session opens. The resolved build
id comes back in the returned capabilities and is stored on the session row, so a `@latest` run
records which build it actually ran. `appium:app` still works; setting both is an error rather than a
coin toss. Unknown `mfarm:` keys are now REFUSED — they used to be stripped and forgotten, so
`mfarm:appid` would have run a whole suite against a launcher screen. `examples/medishop-suite` and
its `ci-example.yml` now upload and name a build rather than pointing at `/home/rkcr070707/apks/`.
Design notes in `docs/EXECUTION_MODEL.md` §4.1. **Not yet verified on hardware** — `mfarm-lab` has
been stopped since it shipped, so the chain hub → real worker → `adb install` → Appium has only run
with a test playing the worker.

**2026-08-20 — the farm has its own domain.** `mfarm.dev`, registered through Cloud Domains, Cloud
DNS authoritative, both A records on reserved addresses. `farm.mfarm.dev` (console, API, hub, `/dp`)
and `turn.mfarm.dev` (the relay). The old sslip.io name still answers — Caddy serves both, each with
its own certificate — until `HOSTNAME_LEGACY=` retires it. `deploy/farm.env` holds both names and is
the only place either appears. See issue 29.

**2026-08-19 — the interactive device view is BUILT AND VERIFIED ON HARDWARE** (issue 28, ADR-0007):
a Launch flow, a live device-mirroring cockpit at ~50 fps, touch, logcat and screenshots, plus a
real APK installed and launched from a browser. One constraint came with it and it is a product
decision rather than a bug: a snapshot-restored Cuttlefish publishes no display, so `CF_RESET_MODE`
chooses between a ~10s recycle and a live view.

 Deploys go through a pipeline — `deploy/README.md` "Shipping a change", and known
issue 26. The console header shows the commit it is running. Read this file first in a new session.

**2026-08-19 — `docs/E2E_MVP_PLAN.md` is the ordered plan from here to a teammate using this.** It
audits what the console actually calls (all real endpoints; no mock data anywhere in `public/`),
names the two blocking prerequisites — there is no host, and the console is built for a tailnet
rather than the internet — and sequences the six milestones left. Read it after `docs/MVP_PLAN.md`.

## SCOPE CHANGE 2026-08-17 — read `docs/MVP_PLAN.md` next

The target is now a **self-hosted 2-device Android farm** (Cuttlefish on rented Indian bare metal,
Tailscale access, Appium suites, small team) rather than a multi-tenant SaaS device cloud. The
architecture below is unchanged and reusable; what changed is sequencing and what "done" means.

Three consequences, in full detail in `docs/MVP_PLAN.md`:

1. **The gate below no longer blocks delivery.** Density is a unit-economics number, irrelevant at
   two devices on a box you already pay for; interactive latency is a manual-testing differentiator,
   not an Appium one. Still run the spikes — the same box runs them on day one — but they gate
   *scaling*, not *shipping*.
2. **Cuttlefish snapshot/restore requires `--gpu_mode=guest_swiftshader`, `--enable_virtiofs=false`
   and x86_64.** The reset story in `device.ts` is only available with a *software* GPU. A GPU-less
   rented server lands on SwiftShader regardless, so this costs nothing here — but it must be
   configured deliberately, and Flutter/RN rendering perf needs measuring in Phase 1, not assumed.

   **Measured 2026-08-18 on the lab VM (n2-standard-16, cvd 1.55.1, build 16102939): cold boot 38s,
   snapshot restore 8s, snapshot size 4.0 GB.** So recycling a device is ~4.75x cheaper than
   booting one, which is what the reset story assumed and now has a number for. The verified
   sequence, and the parts that are not guessable from the flags alone:

       cvd suspend                                        # a take on a RUNNING device is refused:
       cvd snapshot_take --snapshot_path=<dir>            # "The device is not suspended"
       cvd resume                                         # non-destructive; boot_completed stays 1

       cvd --group_name=<g> stop
       cvd --group_name=<g> start --snapshot_path=<dir> --daemon

   Three things that cost time to discover. Selector flags go *before* the verb
   (`cvd --group_name=X snapshot_take`), not after. Restore passes no `--gpu_mode` or
   `--enable_virtiofs` — the device configuration is restored from the snapshot. And restore uses
   `start`, not `create`, because `cvd stop` leaves the group in the database as `Stopped` and
   `start` is the verb for an existing group (see issue 11).
3. **Target Android 17 (API 37)**, AOSP tag `android-17.0.0_r1`, released 2026-06-16.

## What this project is

A mobile device cloud whose entire differentiation is two numbers: **glass-to-glass latency under
100ms** and **cost under $0.02 per device-hour**. Everything else is table stakes that follows once
those hold.

The strategy is in `product_guide_v2.md`. `product_guide.md` is the original (GPT-authored) v1 plan,
kept for reference — v2 supersedes it. `DEVICE_SECOND_THESIS.html` is the market review.
Architecture decisions live in `docs/adrs/`.

## THE GATE — nothing downstream is validated until this clears

Three numbers do not exist yet, and the whole plan is a hypothesis until they do:

| Number | From | Decides |
|---|---|---|
| Glass-to-glass p50, untuned | spike 1 | whether "sub-100ms" is a real claim |
| Interactive density | spike 2a | the actual $/device-hour floor |
| automated ÷ interactive ratio | spike 2a pass 2 | one price tier or two |

**Blocked on hardware.** Spikes 1 and 2a need a Linux box with `/dev/kvm` (bare metal — a VPS
without nested virt cannot run Cuttlefish). Spike 2b needs full Xcode. Cost to unblock: roughly a day
and $20–50 on hourly bare metal (Vultr Bare Metal, Latitude.sh, Equinix Metal). A phone shooting
240fps slo-mo is enough for the camera measurement.

Harnesses are written and ready in `spikes/`. Run `spikes/bootstrap_cuttlefish.sh` on a fresh Ubuntu
box first — it preflights, builds, installs, and smoke-tests, resuming across the required reboot.

**Do not let more control-plane work accumulate against an unverified latency assumption.** The
failure mode that kills projects like this is shipping six weeks of code and then discovering the
premise was wrong, at which point sunk cost argues against changing course.

Everything added on 2026-08-16 was deliberately chosen to be **gate-independent** — none of it
validates the premise, and none of it is wasted if the premise changes.

## What is built and verified

**652 tests pass, 0 fail** (2026-08-24, at migration 022), against a real PostgreSQL 16. No mocks for
anything that matters.

```
apps/api/         control plane, app library, console,  424 tests
                  entrypoint, metrics
apps/cli/         mfarm CLI                              63 tests
workers/agent/    worker agent, Appium supervisor,      144 tests
                  automation gateway, Cuttlefish backend
deploy/           deploy scripts and their checks         21 tests
apps/api/public/  the web console (served by the API at /)
apps/api/migrations/  022 of them; 022 is the newest
packages/protocol shared contract
docs/adrs/        architecture decision records
.github/, action.yml   CI and the customer-facing Action
spikes/           week-0 harnesses (unrun — see the gate)
```

Run everything:
```bash
cd apps/api && npm run db:up && npm run migrate    # Docker required
cd ../.. && npm test
npm run typecheck                                  # tsc --noEmit; nothing else checks types
cd apps/api && npm run db:down                     # tear down when finished
```

Node ≥ 22.6 (native TypeScript stripping, no build step). Stripping means types are **erased, never
checked**, so `npm run typecheck` is the only thing standing between the repo and a wrong field name
that runs fine until the branch that touches it. `tsconfig.json` also sets `erasableSyntaxOnly`, so
syntax Node cannot strip (enums, parameter properties) fails the check rather than the runtime.

### Control plane — `apps/api`

`org_id` + row-level security on every tenant table. Postgres allocates devices
(`FOR UPDATE SKIP LOCKED`) atomically with session creation, plus monotonic fencing tokens. Reset
means snapshot restore, enforced: a released device is not allocatable until a worker confirms.
Metering is append-only and idempotent. Two principal types (tenant / worker) that are never
interchangeable, Ed25519 session tokens, `Idempotency-Key` on session creation.

### Service entrypoint — `apps/api/src/main.ts` + `config.ts` (ADR-0001)

`npm start`. Config is parsed once by a pure `parseConfig(env)`, reports **every** problem at once,
and exits **78 (`EX_CONFIG`)** in production on: missing or half a signing keypair, unparseable key
material, a dev-default or committed-password database URL, **`DATABASE_URL == APP_DATABASE_URL`**
(that one means request handling runs as the owner, and owners bypass RLS), a reaper interval of 0
or under 1000ms, a misspelt `NODE_ENV`, a `METRICS_PORT` that collides with `PORT`, or a
non-loopback `METRICS_HOST` with no `METRICS_TOKEN` — that last one is an unauthenticated listener
serving every org's fleet state.

`/health` is liveness — no I/O, never fails while the process lives. `/ready` checks both pools and
returns 503. They must stay separate: an orchestrator restarts on failed *liveness*, so a
DB-touching liveness check turns a brief blip into a restart loop that outlasts it. Both probes are
exempt from the rate limiter, because a 429 is indistinguishable from a dead pod to a kubelet.

Shutdown drains in-flight requests, clears the reaper in `onClose`, then closes pools — in that
order, and the order is load-bearing (see the ADR). The reaper is now actually on.

### Observability — `apps/api/src/metrics.ts`, `deploy/observability/` (Phase 2)

Prometheus metrics on a **second listener** (`METRICS_PORT`, default 9464), never the API port. That
is not tidiness: every gauge is fleet-wide and collected on the **owner** pool — `mfarm_app` is
bound by RLS and with no `app.org_id` set every policy matches zero rows, so the exporter would
report a healthy fleet of nothing on the app pool. It reports every org's devices and sessions on
the owner pool, and the API listener is the one that has to carry the internet-facing WebDriver hub.
`config.ts` refuses a non-loopback `METRICS_HOST` in production without `METRICS_TOKEN`.

No client library — the exposition format is a documented text protocol and encoding it is smaller
than configuring a library to do it. Three properties in there are load-bearing and each fixes a
silent failure:

- **Gauges are zero-filled.** All eight device states are published for every placement, zeros
  included. An absent series is not a zero, `== 0` cannot fire on one, and the alert for "no device
  is allocatable" would be silent exactly when it matters. `metrics.test.ts` reads the enums back
  out of Postgres so the list cannot drift from a migration.
- **The heartbeat is a timestamp, not an age.** A host that registered and never beat reports 0;
  `time() - 0` is enormous, so it alerts. An age gauge must invent a number for "never", and every
  invented number is a false alert or a silent one.
- **A failed fleet query does not fail the scrape.** A 500 reads as "target down" to Prometheus and
  hides the counters that would say why — including the scrape-error counter itself. Stale gauges
  are served, `mfarm_scrape_errors_total` moves, and a rule watches that.

**Reset failure is alerted as a device stuck in CLEANING**, because that is the only signal there
is: a restore that throws never reports completion, and the device stays in CLEANING by design.

15 rules, `promtool`-checked. **Alertmanager ships with no receiver**, so alerts reach its UI and no
human until someone configures one and tests it by stopping the API for three minutes.

### WebDriver hub — `apps/api/src/http/routes/webdriver.ts`

The adoption path (v2 decision 10). An existing Appium suite migrates by changing one URL —
`https://mfk_key@hub.mfarm.dev/wd/hub` — and adding `mfarm:region`. W3C and legacy JSONWP dialects
both work, served at `/wd/hub` and at `/` because clients disagree about the base path. Credentials
travel as HTTP Basic (tenant keys only) since a URL is the only thing a WebDriver client is given.

Commands are proxied to an Appium server on the worker. That is a deliberate exception to "never
proxy the data plane": a WebDriver client pins one base URL for the session's life, so one-hub-URL
and connect-straight-to-the-worker cannot both hold — and an internet-facing Appium port is
unauthenticated device control, so the hub being the sole ingress is the safer half anyway. The hop
costs a few ms on commands already taking tens to hundreds inside the device.

Every failure path releases the device — **when the hub is the one that allocated it.** A caller that
already holds a session can hand it over instead, and then owns the lifecycle itself: the URL carries
it as the HTTP Basic *password* (`https://<key>:<session-id>@hub/wd/hub`), or `mfarm:sessionId` says
it explicitly. `webdriver_sessions.hub_allocated` records which it was, and on the bound path the hub
releases nothing — including on `driver.quit()`, so a suite that quits between tests re-binds the
same device rather than buying another. That is the fix for the double-billing defect (ADR-0002 D1).

Allocation demands the `webdriver` capability, and the constraints are recorded on the session so
`promote_queued()` re-applies them. Every request to the automation server carries a two-minute
Ed25519 grant naming the session, device, org, fence and host (ADR-0004).

### CLI — `apps/cli` (ADR-0002)

`mfarm run --region us-east -- npx appium-test`. A **wrapper, not a runner**: it allocates, injects
coordinates into the child's environment (principally `MFARM_WEBDRIVER_URL`, which now carries the
session id in its Basic password half so the hub drives *this* device rather than allocating a
second one), and passes the child's exit code through **verbatim**. Exit 75 (`EX_TEMPFAIL`) means capacity, not test failure — a device
cloud that cannot distinguish those is one nobody trusts as a merge gate. The device is released on
every exit path, and a failed release never changes the exit code. Zero runtime dependencies.

### GitHub Action — `action.yml`, `.github/`

Wraps the CLI. The API key never reaches argv (it is masked and passed as env), capacity is
annotated `::warning::` while a real failure is `::error::`, and `verdict` is exposed as both an
output and `MFARM_VERDICT` so retry logic does not have to guess at exit codes. `ci.yml` reproduces
the local Postgres role split and then **verifies it** — asserting `mfarm_app` is not a superuser
and has no `BYPASSRLS`, and that every tenant table has both `relrowsecurity` and
`relforcerowsecurity`. Without that guard a misconfigured CI would run the isolation tests green
against a database with isolation switched off. It also asserts that no fleet-wide `SECURITY DEFINER`
function is EXECUTE-able by `mfarm_app` — RLS says nothing about definer functions, and Postgres
grants EXECUTE to PUBLIC by default, so "we never granted it" is not a control.

### Worker agent — `workers/agent`

Registration with credential persistence, heartbeat, deterministic-id metering, snapshot reset, and
the WebSocket data plane the browser connects to. Two device tiers: Cuttlefish (target, Linux+KVM)
and AVD (fallback, runs on macOS, cannot meet the latency target and says so).

`CuttlefishDevice.start()` picks the cheapest correct route — adopt a running group (0s), restore a
stopped one from its snapshot (8s), cold boot (38s) — takes the golden snapshot itself on first
boot, and advertises `snapshot-reset` only once that snapshot exists. See known issue 14 for what
this replaced and why the honesty matters more than the speed.

### Bring-up — `deploy/farm-up.sh`

One command for the whole host: preflight, secrets, compose, the `mfarm_app` password reconcile,
seed, and the worker in tmux. Idempotent, and it re-runs as the normal way to use it. It exists
because the sequence previously lived only as seven copy-paste blocks in the runbook, on a box
billing ~₹65/hour, with three steps that fail silently hours later (empty `regions` table,
unrotated password, device with no snapshot). It deliberately does **not** do Tailscale, TLS, or the
observability stack — each needs a decision from a human, and `deploy/README.md` has them.

### Appium supervisor — `workers/agent/src/appium.ts` (ADR-0003)

Supervises an Appium 2 process per device: spawn, `/status` readiness (not spawn-readiness — Appium
takes seconds to bind), crash restart with exponential backoff, and a give-up threshold after which
it is permanently unhealthy. The point is **capability honesty**: the host advertises `webdriver`
only while a supervised server is genuinely ready, and withdraws it otherwise. Previously
`AUTOMATION_ENDPOINT` being set was an unchecked promise, so a dead Appium still got fed real tenant
sessions.

### Automation gateway — `workers/agent/src/gateway.ts` (ADR-0004)

The worker half of the automation transport, and **the one internet-facing listener whose
correctness is a security boundary**. Appium stays on `127.0.0.1`; this is the only thing that can
reach it. Every request must carry an Ed25519 grant from the hub, verified offline, and the checks
run in a fixed order with no path to the proxy that skips one: signature → audience is this host →
`claims.did` matches the device named in the path → fence is not stale.

Deliberate properties, each of which a plausible implementation gets wrong:

- **The grant is stripped before proxying.** Appium would not check it, and forwarding a bearer token
  to a process that logs requests puts it in a log file.
- **An unknown device and a non-automation path give an identical 404**, or an unauthenticated caller
  can enumerate the host's devices.
- **No redirect following.** A 302 from a compromised Appium would otherwise become a request the
  gateway makes on its behalf, from its network position.
- **The body limit is enforced while streaming**, not after buffering — buffering to measure is the
  exhaustion the limit exists to prevent.
- **There is no unauthenticated path at all**, not one behind a flag, so no configuration mistake can
  produce one.

`AUTOMATION_GATEWAY_PORT` (default 8090), `AUTOMATION_ADVERTISE_BASE` for the public base url (a TLS
deployment sets this), falling back to `APPIUM_ADVERTISE_HOST`/`PUBLIC_HOST`. It refuses to start
without one rather than advertise `127.0.0.1` to the fleet.

## What is NOT built

- Blocker 5 below (multi-instance).
- ~~App install / launch outside Appium~~ — **built 2026-08-19** (issues 21 and 22): upload, install,
  launch, uninstall, over the heartbeat, from the CLI or the console. Never yet run against adb.
- ~~Logcat streaming~~ — **built 2026-08-19 (issue 28, ADR-0007)**, live over the data plane, with a
  filter and level chips in the cockpit. NOT persisted: closing the tab loses it, because there is
  still no artifact store. Screenshots the same — on demand, downloadable, held in the tab only.
- Video recording, and artifacts generally (an `artifacts` table, retention, a blob route). Issue 23
  is now half closed: `logcat` and `screenshot` are implemented and honestly declared, and
  `recording` was REMOVED from the Cuttlefish capability list rather than left as a claim with
  nothing behind it.
- ~~Web UI~~ — **built 2026-08-19** (issue 20 and the v2 design): sign-in, devices, sessions, queue,
  apps, health, and since issue 28 a **Launch** flow and an interactive cockpit — live video, a
  control rail, logcat and screenshots. The code path is complete and the WebRTC half has never met
  a real cvd operator; see issue 28 for exactly what is verified and what is not.
- Publishing. Every package is `"private": true`, so `npx mfarm` does not work yet and the Action's
  `npx --yes mfarm@latest` has nothing to resolve.
- Observability gaps, all of which look covered from the dashboard and are not: **no
  backup-freshness alert** (the sidecar logs failures and nothing scrapes it — backups can stop for
  six weeks without a page), **no host metrics** (a full disk takes the database and the backups
  down and nothing here says so first), and **no worker-side metrics** (cvd health, adb
  responsiveness and a wedged-but-alive Appium are invisible except through device state).
- Phase 2 is **partly** proven on hardware now. `deploy/docker-compose.prod.yml` runs on the lab box
  (api, postgres and the backup sidecar), which `deploy/farm-up.sh` brings up in one command. Still
  never run anywhere: the observability stack (`docker-compose.obs.yml`), `tailscale serve`, and any
  alert delivered to an actual person.

## BLOCKERS — decide these before the hardware session

These came out of building the above. Each is recorded in full in the linked ADR.

**~~1. `mfarm run` double-allocates and double-bills for WebDriver suites.~~ FIXED 2026-08-16.**
(ADR-0002, D1) The hub can now be handed a session that already exists. `MFARM_WEBDRIVER_URL` carries
it as `https://<key>:<session-id>@hub/wd/hub` — the Basic password half, which was empty before — so
no test suite changes; `mfarm:sessionId` is the explicit equivalent for REST callers.
`webdriver_sessions.hub_allocated` records who owns the lifecycle, and on the bound path the hub
releases nothing: not on failure, not on `driver.quit()`. A suite that quits between tests now costs
one device instead of one per test. `POST /v1/sessions` gained `requireCapabilities`, and `mfarm run`
demands `webdriver` unless given `--no-webdriver`.

**~~2. Loopback binding and hub reachability contradict each other.~~ DECIDED 2026-08-16 — ADR-0004.**
(was ADR-0003, B1) The transport is **the worker's own listener plus a signed grant**, not a private
network. Appium stays on `127.0.0.1`; the agent runs a gateway at `/automation/<deviceLocalId>/*`
that proxies to it; every hub request carries a two-minute Ed25519 token naming the session, device,
org, fence and host, which the worker verifies offline with the public key it already gets at
registration. A VPN was rejected because it authenticates the network rather than the request — every
peer on it could drive every device, which is the exposure loopback binding exists to prevent, just
moved inside the perimeter. **BOTH HALVES ARE NOW BUILT (2026-08-17)** —
`workers/agent/src/gateway.ts`, 17 tests, all four spec points. `APPIUM_ENABLED=1` no longer needs an
operator-supplied tunnel. Still never tested against a real Appium.

**~~3. `automationEndpoint` is host-level, so per-device Appium is inexpressible.~~ FIXED 2026-08-17.**
(ADR-0003, B2) Protocol v2 adds `devices[].automationEndpoint`; migration 010 adds
`devices.automation_endpoint`; the hub reads `COALESCE(d.automation_endpoint, h.automation_endpoint)`
so v1 workers are unaffected. `agent.ts` stamps `webdriver` per device, `index.ts` no longer refuses
multi-device hosts, and the `derivePort` collision check is back. Landed with the gateway below —
they wanted the same field.

**~~4. `appium:udid` is set to the mfarm local id, not the adb serial.~~ FIXED 2026-08-17.**
(ADR-0003, B3) Protocol v2 adds `devices[].adbSerial`, `systemPort` and `mjpegServerPort`; migration
011 stores all three; the hub sends the serial as `appium:udid` and the two ports alongside it.

The serial was never missing — `CuttlefishDevice` and `AvdDevice` both computed it and used it for
every adb call, and neither published it to `DeviceInfo`. One field on each backend.

Two decisions worth knowing:
- **A device with no serial is refused** (`no_device_identity`), not guessed at. Sending `local_id`
  is the original bug; omitting `appium:udid` lets the driver pick any attached device, possibly
  another tenant's. Pre-migration rows stay NULL and their hosts must re-register.
- **Three typed columns, not a jsonb capability bag.** A bag would be extensible without a
  migration, and would also let a worker inject arbitrary Appium capabilities — `appium:app`, say —
  into a tenant's session. Migration 008's rule applies: worker input is scoped, never trusted
  wholesale.

**5. Multi-instance is blocked twice over.** (ADR-0001) Rate limiting is in-memory, so per-instance.
And the reaper now runs inside the API process, so N instances run N fleet-wide reaps. Both are
correct at N=1 and both degrade silently rather than failing. **Before a second instance:** Redis
for the limiter, and a single owner for the reaper (leader election, advisory lock, or an external
scheduler).

**~~6. The media path has no reachability story, and it is not the one ADR-0004 settled.~~ DECIDED
2026-08-19 — ADR-0005: media reaches the browser through a coturn TURN relay with per-session
credentials, and the data plane moves off the docker bridge. No client software, no overlay; the
signed grant stays the authorisation. Nothing is built yet.**

Raised 2026-08-18 after the failure in known issue 13. `dataplane.ts` carries control and input;
**media is not proxied** — the browser negotiates WebRTC straight to Cuttlefish's own server. That
works only when the client can route to the addresses the host puts in its ICE candidates. On the lab VM it
could not, and the result was a populated device list over a dead stream.

ADR-0004 rejected a VPN, and that reasoning **does not transfer here**. It rejected a VPN as an
*authorisation* mechanism for the automation gateway, because a network grants every peer access to
every device. Media reachability is a *routing* problem, and the signed grant already answers the
authorisation half. An overlay used purely as a route, with `dataplane.ts` still verifying its token
offline, does not reopen what ADR-0004 closed. Say so explicitly in whichever ADR settles this, or
someone will read the two as contradictory.

The realistic options are an overlay (Tailscale, already chosen for `deploy/` ingress) or a TURN
relay. TURN costs a relay to run and bandwidth to push; an overlay costs client-side enrolment,
which is fine for a self-hosted farm and probably unacceptable for a public product. **Decide this
before building any viewer**, because it determines whether a browser needs client software.

## Known issues and constraints

1. ~~`devices/cuttlefish.ts` `cvd` flags are **unverified against a real install**.~~ **VERIFIED
   2026-08-18** against cvd 1.55.1 on the lab VM (B7), and encoded. Issues 11 and 12 below are what
   that cost. The flags are now also covered by `workers/agent/test/cuttlefish.test.ts`, which runs
   real fake `cvd`/`adb` binaries on a temporary PATH and asserts the exact argv — including that
   selectors come *before* the verb. That test cannot tell you cvd agrees; it can only stop the
   verified invocations drifting.
2. The WebDriver hub has never spoken to a real Appium server, and the Appium supervisor has never
   supervised one. Both are tested against fakes that answer correctly; a real driver will disagree
   about something. The supervisor also detects **process death only** — a wedged-but-alive Appium
   answers `/status` 200 forever and stays advertised.
3. `apps/api/docker-compose.yml` mounts Postgres data on tmpfs — fast, non-durable, **and that is
   correct for what it is**: the test stack. The farm's durable database is
   `deploy/docker-compose.prod.yml` (named volume, `--data-checksums`, restart policy, verified
   backups every 6h). `deploy/README.md` has the standing-up and recovery procedures, and
   `deploy/restore-drill.sh` proves the restore path actually works — it runs in CI.
4. `mfarm_app` has a local-dev password in `001_init.sql`. Rotate before any deployment (`config.ts`
   refuses to boot in production if it sees it). `deploy/README.md` has the exact `ALTER ROLE`.
5. ~~Allocator functions are `SECURITY DEFINER` owned by the superuser.~~ **FIXED 2026-08-17,
   migration 012.** They are owned by `mfarm_definer` — NOLOGIN, NOSUPERUSER, privileges on the
   five tables the bodies touch, plus BYPASSRLS (the tenant tables are FORCE RLS and these
   functions do fleet-wide work by design). The same migration revoked PUBLIC EXECUTE from
   `allocate_device`, `release_device` and `session_activate`, which 008 had missed — their
   explicit grants to `mfarm_app` had been decorative. `ci.yml` now asserts both.
6. Tests run `--test-concurrency=1`: the reaper is fleet-wide by design, so suites cannot share one
   database concurrently. **This also means parallel agents must not run DB-backed suites at the
   same time.**
7. ~~`db.ts` reads its connection URLs independently of `config.ts`.~~ **FIXED 2026-08-17.** Both
   go through `parseDbConfig(env, problems)`; the literals have one definition.
8. ~~`PG_POOL_MAX` / `PG_SYSTEM_POOL_MAX` are unvalidated.~~ **FIXED 2026-08-17.** Bounded via
   `intVar`, so the pool gets an integer or the default and never `NaN`; `parseConfig` reports a
   typo in the same list as everything else and `main` exits 78. Also logged at startup.
9. ~~On the queued path the CLI cannot produce `MFARM_DATA_PLANE_ENDPOINT` / `MFARM_SESSION_TOKEN`,
   because `GET /v1/sessions/:id` returns no `dataPlane` block.~~ **FIXED 2026-08-17.** A live
   session carries coordinates on GET, minted with the claims `POST` would have issued. It was two
   defects behind one symptom: a queued session had no coordinates to inherit, **and** a session
   token lives 120 seconds, so even the immediate path went stale during any run longer than two
   minutes with nowhere to refresh it. Only `ALLOCATING`/`ACTIVE` mint — a device is reassigned the
   moment it is reset, so a token for an ended session is a credential for another tenant's device.
   `mfarm session get --json` returns the block; the human rendering shows the endpoint and never
   the token. (ADR-0002, D2)
10. **`cvd fetch` can no longer discover a device image without a human at a browser.** Google has
    retired anonymous access to the v3 Android build API's *listing* endpoints — `builds?...` and
    `artifacts?...` both return `403 "Rate limit exceeded for legacy API. You must migrate to Build
    API v4"`. Confirmed 2026-08-18 from four separate IPs (laptop, the GCE lab VM, Cloud Shell) and
    across every branch tried, sustained over an hour with no decay — a deprecation, not throttling
    that waiting clears. There is no public v4 endpoint to migrate to; `/v4/builds` is a plain 404.

    *Single-artifact* lookups still work — `artifacts/<name>/url?redirect=true` returns a valid
    signed storage URL. So a build you already know downloads fine; no build can be found. This is
    why `bootstrap_cuttlefish.sh` carries `CF_PINNED_BUILD_ID` (currently `16102939`, verified) and
    why the search is only a fallback. When that build is eventually garbage-collected, the script
    says so and someone must read a fresh id off
    `https://ci.android.com/builds/branches/aosp-android-latest-release/grid?legacy=1` by hand.

    Two related traps found the same day. `ci.android.com` is a JavaScript app: fetching an artifact
    path with `curl` returns a ~4 KB HTML shell named like a zip, not the file. And release branches
    name the target `aosp_cf_x86_64_only_phone-userdebug` — with an `_only_` that `aosp-main` did
    not use — so a correct build id with the old target name still 404s.

11. **Booting a fetched image needs three things `cvd` will not infer.** All three surfaced on
    2026-08-18 against `cvd` 1.55.1 on the lab VM, each with an error that points somewhere other
    than the cause. Anything driving `cvd` — `bootstrap_cuttlefish.sh`, B7, and
    `workers/agent/src/devices/cuttlefish.ts` — has to get all three right.

    - **The verb is `create`, not `start`.** `cvd` 1.x keeps an instance database. `create` builds a
      new instance group from artifacts and boots it; `start` only restarts a group that already
      exists. On a fresh host the database is empty, so `cvd start` fails with ``Command `start...`
      is not applicable: no devices present`` — which reads like a boot failure but happens before
      anything boots. `launch_cvd`-era documentation has no such split.
    - **`--host_path` and `--product_path` are mandatory.** `cvd create` ignores the current
      directory and defaults both to `$HOME`, so it reports `'/home/<user>/bin/' does not contain
      any of '[cvd_internal_start, launch_cvd]'` while the artifacts sit in `~/cf/image`. The
      layout `cvd fetch` writes has moved between versions, so the script locates the roots by
      searching for `bin/launch_cvd` and `super.img` rather than assuming a path.
    - **Boot with the snapshot flags even when not snapshotting.** `--gpu_mode=guest_swiftshader
      --enable_virtiofs=false` (issue 2 above). Without them the cold-boot baseline is measured on a
      different device configuration than the snapshot restore it exists to be compared against.

12. **Ubuntu 24.04 blocks crosvm by default, and every log lies about it.** 24.04 ships
    `kernel.apparmor_restrict_unprivileged_userns=1`, confining unprivileged user namespaces to an
    AppArmor profile that denies `CAP_SYS_ADMIN`. crosvm sandboxes each virtual device in a user
    namespace via minijail, so it is denied mid-setup and dies. Fix, applied by
    `bootstrap_cuttlefish.sh` preflight since 2026-08-18:

        sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # persisted in
                                                                        # /etc/sysctl.d/99-cuttlefish-userns.conf

    Budget real time for this one if it ever recurs on a new host image — it cost most of an
    evening because **no Cuttlefish log mentions AppArmor**. The visible symptoms all point
    elsewhere: crosvm says `the architecture failed to build the vm / failed to create a PCI root
    hub`, which reads like a device-model bug; `kernel.log` and `logcat` are zero bytes, which
    reads like a hung guest; `cvd fleet` reports `"status": "Starting"` indefinitely, which reads
    like a slow boot; and the webRTC and adb helpers log `vsock: No such device` and
    `Connection refused` on a loop, which reads like a networking problem. `cvd create` itself
    exits 0. The single place the truth appears is `sudo dmesg`:

        apparmor="DENIED" operation="capable" profile="unprivileged_userns" \
          comm="crosvm" capability=21 capname="sys_admin"
        traps: crosvm[3266] general protection fault ... in libc.so.6

    Hence the diagnostic rule now baked into the script's timeout message: **check whether `crosvm`
    is in `ps` first.** Alive means a real boot problem, look at `kernel.log`. Absent means the VM
    never existed, go straight to `dmesg` — the Cuttlefish logs will only mislead. The script also
    no longer runs `cvd stop` before reporting a timeout, because that deleted the evidence.

    Note this weakens a host-wide hardening setting (unprivileged userns is a local-privilege-
    escalation surface). Fine on a single-purpose farm host; think before applying it to a shared
    machine.

    **The farm consequence:** every image refresh needs a human, and both devices must stay on one
    pinned build or differences between them become debugging noise. Revisit if upstream opens v4
    or ships an unauthenticated mirror.

13. **An SSH port-forward cannot carry the device stream, and the failure looks like a broken
    device.** Verified 2026-08-18 on the lab VM. The browser reached the Cuttlefish console over
    `ssh -L 1443:localhost:1443`, listed the device correctly, and then showed a black screen with
    *"Connection should have occurred by now"* / *"No connection to the guest device."* Everything
    on the host was healthy at the same moment:

        cvd fleet          -> "status": "Running"
        adb ... getprop sys.boot_completed  -> 1
        pgrep -f webRTC    -> alive, plus operator and adb_connector
        logs/webrtc.log    -> EMPTY — nothing errored, nothing reached it

    The cause is that WebRTC uses two independent connections and a tunnel only carries one.
    **Signaling** is TCP to the operator on 1443 — that is what the forward covers, and it is why
    the device list populates. **Media and input** are a separate peer connection negotiated by
    exchanging ICE candidates, which are literal addresses: the host offers `10.160.0.2` plus a UDP
    port range. `ssh -L` terminates on `localhost`, carries no UDP, and cannot rewrite an address
    embedded in a signaling payload. So signaling succeeds and media never connects.

    The operator states this outright if you ask it. Through the same tunnel, `GET /` returns 200
    and `GET /devices` returns the device with correct metadata — but:

        GET https://localhost:1443/infra_config
        -> {"ice_servers":[{"urls":["stun:stun.l.google.com:19302"]}]}

    **STUN only, no TURN.** STUN merely tells a peer its own public address, which helps only when
    a direct path exists; TURN is the relay used when none does, and Cuttlefish ships without one.
    On a GCE box with no external IP there is then no candidate pair that can connect at all: the
    internal address is unroutable from the client, the bridge addresses are host-local, and there
    is no reflexive candidate to discover. Check `/infra_config` first on any "device listed but
    black screen" report — it turns a guess into arithmetic.

    Forwarding more ports does not help. The candidate still names an address the client resolves
    to the wrong machine. **The client needs a genuine route to the worker**, which means either a
    routable overlay (Tailscale — `deploy/` is already Tailscale-only for ingress, and
    `dataplane.ts` says "a browser reaches this socket over the tailnet") or a TURN relay both
    sides can reach. There is no third option and no tunnel-shaped one.

    The diagnostic rule: **an empty `webrtc.log` alongside a device that appears in the UI means a
    routing problem, not a device problem.** The log is empty because the peer connection never
    arrived to be logged. Confirm the device separately with `adb ... getprop sys.boot_completed`
    before touching anything on the host — the temptation is to restart a device that is fine.

    **The farm consequence, and it is a product one:** `tokens.ts` and `dataplane.ts` both specify
    that the browser connects *directly* to the worker, with the control plane out of the loop.
    That is the right design for input latency, but "directly" is a network precondition, not a
    given — behind NAT or over any TCP-only path it fails in exactly the shape above, with a
    working device list and dead video. Whatever ships must either put clients and workers on one
    overlay or run a TURN relay, and that decision belongs with the WebDriver blockers, not with
    deployment.

    Scope note: **this affects interactive viewing only.** Automated runs go
    `routes/webdriver.ts` -> `appium.ts` -> adb, which is HTTP and TCP end to end and never
    negotiates ICE. A customer running a suite is unaffected. For local "is this device real"
    checks, `scrcpy` over an adb forward works fine and needs none of this.

14. **The snapshot path was dead code in the real agent, and the whole farm would have stalled after
    one session.** Found and fixed 2026-08-18, before the next metered day rather than on it.

    `CuttlefishOptions.snapshotDir` was optional and **nothing ever passed it** — not `index.ts`,
    not `createCuttlefishBackend`. So `snapshotPath()` threw `no snapshotDir configured` on every
    call, which means `resetToSnapshot()` threw, which means `resetAndRelease()` in `agent.ts` never
    reached `device_reset_complete` — and a device whose restore never completes stays in CLEANING
    **by design**. First session on the box: one device permanently unavailable. Two devices, two
    sessions: an empty fleet. The B7 measurement (8s restore vs 38s cold boot) was real and
    unreachable from the product.

    Three fixes, and the second is the one worth remembering:

    - `index.ts` now derives a snapshot directory **per device** (`<CF_IMAGE_DIR>/../snapshots/cf-N`,
      overridable with `CF_SNAPSHOT_DIR`) rather than requiring a fifth environment variable. Per
      device, never shared: two devices pointed at one path restore each other's state, which is the
      tenant leak `snapshot-reset` exists to prevent.
    - **`snapshot-reset` is no longer advertised at construction.** It is added by `start()` only
      once a snapshot actually exists on disk, and an *empty* snapshot directory does not count —
      `cvd snapshot_take` creates the directory before it fills it, so an empty one is the signature
      of a take that failed. This is the `AUTOMATION_ENDPOINT` rule again: a capability is a claim
      about observed state. Consequence to know: `snapshot-reset` is in `REQUIRED_FOR_TENANT_USE`,
      so a device without a snapshot registers and is **not schedulable**. That is the correct
      failure — the alternative is handing a tenant a device carrying the previous one's data.
    - `start()` takes the golden snapshot itself on first boot, so a bootstrapped host becomes a
      usable farm with no manual snapshot step. A failed take is logged and swallowed: the device
      stays up and unschedulable, rather than taking the worker down with it.

    `start()` also now picks the cheapest correct route — **adopt a running group (0s), restore a
    stopped one (8s), cold boot (38s)** — via a tolerant `cvd fleet` parse. Before this, an agent
    restart ran `cvd create` against a host whose device was already up and built a *second* group,
    because `groupName` only ever lived in the process that created it. An unparseable fleet
    document falls back to cold boot, which is exactly the old behaviour, so a shape change upstream
    costs 30 seconds rather than a broken worker.

    **Device boot stays serial** (`index.ts`). Booting two at once is the obvious next optimisation
    and it is deliberately not taken: every `cvd` verb mutates one shared instance database and
    nothing here has verified that concurrent invocations are safe against it. The cost was never
    the serialisation — it was cold booting when a restore would do.

15. **M3 IS DONE. A real WebDriver session drove a real Cuttlefish device end to end on
    2026-08-18** — the first time any part of this project spoke to something that was not a fake.
    `deploy/verify-webdriver.mjs` reproduces it, with no client library, printing the whole exchange
    on failure.

        [1/5] create session      3713ms   udid 0.0.0.0:6520, android 17
        [2/5] page source         2799ms   14591 bytes, com.android.launcher3
        [3/5] screenshot           830ms   709116 bytes, valid PNG
        [4/5] press HOME          1314ms
        [5/5] delete session       353ms
        total 9.0s

    The path was hub -> Ed25519 grant -> worker automation gateway -> real Appium 2 -> UiAutomator2
    -> adb -> Android 17. **B3 holds against a real driver**: `appium:udid` arrived as
    `0.0.0.0:6520`, the actual adb serial, not the local id.

    Four things were wrong, and none of them were findable without hardware. All are fixed:

    - **Compose ignores `uid`/`gid`/`mode` on file secrets.** Those fields are swarm-only; outside
      swarm they parse, validate and do nothing (verified on compose 2.40.3 by declaring them and
      watching the container fail identically). A secret written by the operator at mode 600 is
      unreadable to the API, which runs as `node` (uid 1000), and the only symptom is
      `cat: can't open '/run/secrets/session_signing_key': Permission denied` on a restart loop
      beside a healthy database. `farm-up.sh` now chowns them to the uid it reads back out of the
      image. **Both the README and the runbook had told you to `chmod 600`.**
    - **The containerised hub cannot reach the worker on the host's loopback.** `127.0.0.1` inside
      the API container is the container. A worker advertising
      `http://127.0.0.1:8090/automation/cf-1` stores an address the hub can never dial, and the
      session fails `automation_unreachable: fetch failed` — which reads like a dead Appium. Both
      sides share the compose network's gateway (172.18.0.1 here): the host, as seen from inside the
      containers, and still a host-local interface, so nothing becomes externally reachable and
      Appium keeps loopback with the gateway as its only door.
    - **UiAutomator2 refuses every session without `ANDROID_HOME`/`ANDROID_SDK_ROOT`**, and it
      locates adb through the SDK *layout*, not through PATH. The supervisor was never at fault —
      `ANDROID_` is already an allowed prefix in `appium.ts` — nothing ever set the variable.
      cuttlefish-common ships a real layout at `/usr/lib/android-sdk`, and every adb on the host is
      the same 1.0.41, which matters because two adb versions kill each other's servers.
    - **Ubuntu 24.04's `apt-get install nodejs` gives 18.x**, which has no TypeScript stripping, so
      the worker dies on its first `.ts` import. The runbook had told you to install exactly that.

16. **NOTHING EVER TRIGGERS A DEVICE RESET. `resetAndRelease()` has no caller.** Found 2026-08-18
    while running B8, and it is the largest hole left in the reset story.

    The control plane half is complete and correct: releasing a device puts it in CLEANING, and
    `allocate_device` will not hand out a CLEANING device until a worker confirms the restore
    through `device_reset_complete` (reported via `POST /v1/workers/events` with `resets:[…]`). The
    worker half exists too — `Agent.resetAndRelease()` restores the snapshot and queues the
    confirmation.

    **The two are not connected.** `grep -rn resetAndRelease workers/agent/src` finds the definition
    and nothing else. No heartbeat response, no data-plane event and no route tells a worker that
    one of its devices is now CLEANING, so the restore is never started and the confirmation is
    never sent. Every session therefore takes its device out of the fleet permanently: the farm
    works exactly `N` times, where `N` is the number of devices, and then reports `no_capacity`
    forever. Observed three times in a row on the lab VM during B8.

    Symptom to recognise: `no_capacity` with `available: 0`, and `select local_id,state from devices`
    showing CLEANING with a healthy worker attached. The manual unstick — which is also the shape of
    the fix — is to report the reset as the worker would:

        curl -X POST http://127.0.0.1:3000/v1/workers/events \
          -H "Authorization: Bearer $(worker token from ~/.mfarm/agent-state.json)" \
          -d '{"resets":[{"deviceId":"<uuid>","fence":<n>}]}'

    Note this is also why known issue 14's fix could not have been caught by running the farm: the
    snapshot restore is unreachable from the product for a *second*, independent reason. Both had to
    be fixed for a device to ever be recycled.

    **The fix belongs in the protocol**: the heartbeat response should carry the caller's devices
    that are in CLEANING with their fences, and the agent should restore and confirm each. That is a
    protocol version bump, an API change and an agent change, and it is the next thing to build.

17. **B9 IS DONE: two devices, three consecutive sessions, no human in the loop.** 2026-08-18,
    after issue 16 was fixed. Both devices adopted in **0.1s** each, three `verify-webdriver.mjs`
    runs went green back to back (10.3s, 9.2s, 8.4s), and the fleet returned to `available: 2`
    between each one on its own. That is the first time this project has behaved like a farm rather
    than like a demo.

    Running a *second* device found three more defects that one device could never have shown:

    - **`cvd create`'s group name was scraped out of its output, and the scrape was wrong.**
      Invisible with one device, because an unselected cvd command falls back to the only group
      there is — cf-1 worked all day. cf-2's snapshot then failed with `Multiple groups found.
      Narrow the selection with selector arguments.` The name now comes from `cvd fleet`.
    - **A restored group loses its `--webrtc_device_id`.** After `start --snapshot_path`, cf-1's
      group reported `cvd_1-1-1`, and the fleet document carries `adb_port` rather than the
      `adb_serial` the matcher used — so after the first restore the adopt path stopped recognising
      a running device, cold booted, and cvd answered `New instance conflicts with existing
      instance: cvd_1/1 with id 1`. Devices are now identified by **instance number**, the one
      identifier cvd does not rewrite.
    - **OFFLINE was a one-way door.** Registration deliberately left device state alone — correct
      for SESSION_ACTIVE and CLEANING, which an agent restart must never disturb — but it meant a
      device that registered unschedulable stayed that way forever. cf-2 registered OFFLINE when its
      first snapshot failed, took a good snapshot on the next run, and the control plane went on
      reporting OFFLINE with a healthy device attached. State is now re-asserted, but **only between
      READY and OFFLINE**; the demotion direction matters as much, since a device that has lost
      `snapshot-reset` must leave the pool.

    The pattern in all three: **a fleet of one hides every bug that is about telling devices apart.**
    Nothing here was findable with `CF_INSTANCES=1`, and nothing here was findable without hardware.

18. **A HOST RESTART BRICKED THE FARM, because cvd's instance database outlives the host.** Found
    2026-08-19 by stopping and starting the lab VM under a running farm — the first time this
    project had ever restarted a host that had devices on it.

    After the restart `cvd fleet` still listed both groups, still carrying the `start_time` from
    before the restart, with `"status": "Unreachable"` and zero `crosvm` processes behind them. The
    adopt path had nothing to adopt, and the restore path was refused outright with `Selected
    instance group is already started, use 'cvd create' to create a new one` — so the agent died
    with `fatal: cvd exited 255` and the farm never came back without a human running `cvd reset`.

    Bring-up is now self-healing: a group that cannot be restarted is discarded with **`cvd rm`
    scoped to that group** and cold booted. Measured after the fix: both ghosts cleared and rebuilt
    unattended, 45.6s and 38.3s, fleet back to `available: 2`.

    **`cvd rm`, NOT `cvd reset`**, and the difference is not stylistic:
    - `cvd reset` is host-wide. On a farm it kills every other tenant's session to fix one device.
    - `cvd reset` also cleans the instance runtime dirs, which **destroys the snapshots it looks
      like it is rescuing** (see issue 19). Verified: `create --snapshot_path` afterwards fails on a
      missing `logs/fetch.log`.
    - `cvd rm` leaves other groups running and does **not** delete an image supplied via
      `--host_path` — verified with a second device running throughout, image dir 3.2 GB before and
      after.

    A second shape of the same bug: **a group that exists is not a group that works.** Snapshot
    support is a BOOT-TIME property, so a group booted without those flags restarts, boots, and
    answers adb while being permanently unable to suspend (`cvd suspend` → `LauncherResponse::
    kError`). Every later agent start found that group and restarted into it again, so the device
    was unschedulable forever. A failed snapshot on a group this agent did not build now discards it
    and cold boots **once** — bounded, and never on a group we just created, because a fresh group
    that cannot snapshot is a host problem and rebuilding it would be a boot loop hiding the cause.

19. **A SNAPSHOT IS ONLY VALID FOR THE GROUP IT WAS TAKEN UNDER, and nothing checked.** Found
    2026-08-19, immediately after issue 18's fix, which is what made it reachable.

    `snapshot_meta_info.json` records an **absolute HOME** (`/var/tmp/cvd/<uid>/<id>/home`), cvd
    mints a new `<id>` for every group it creates, and restore copies the snapshot back into the
    HOME **the file names** rather than the one the running group has. So a snapshot that outlives
    its group restores into a directory that is gone:

    ```
    Copy from "/home/…/cf/snapshots/cf-2" to "/var/tmp/cvd/1001/1787069364409736/home/cuttlefish"
    failed to open …/1787069364409736/home/cuttlefish/instances/cvd-2/logs/fetch.log
    ```

    The symptom is the dangerous part: bring-up succeeds, the device registers **READY advertising
    `snapshot-reset`**, the first session runs green, and then every reset fails and the device is
    parked in CLEANING for good. That is the same one-session-per-device failure as issue 16,
    arriving through a different door.

    Two defences, because the group can be replaced by something other than this agent:
    - Discarding a group now discards its snapshot **and drops the `snapshot-reset` capability**,
      at the one place a group stops being the group its snapshot belongs to.
    - Every start compares the snapshot's recorded HOME against the group's current `instance_dir`
      from `cvd fleet`, which catches drift caused by an operator, a `cvd reset`, or an older build
      — the **adopt** path would otherwise re-advertise a stale snapshot without ever touching it.
      Unreadable or absent metadata is never treated as stale: a snapshot is ~4 GB and a false
      positive destroys a good one.

    Proven on the lab VM: the stuck device healed itself with no intervention (the reset request is
    re-sent every heartbeat, so it succeeded the moment a valid snapshot existed), then three
    consecutive sessions ran green across both devices with `available: 2` between each.

    **The rule this leaves:** a capability is a claim about observed state, and `snapshot-reset` is
    the one capability whose truth can be destroyed by something that never touches the device.

20. **THERE IS A WEB CONSOLE, AND WITH IT THE FIRST WAY FOR A PERSON TO AUTHENTICATE.** 2026-08-19.

    `users` and `memberships` have existed since migration 001 and neither carried a credential, so
    until now "logging in" meant holding an org-wide API key — a credential that cannot be
    attributed to a person, cannot be revoked without breaking every other holder, and cannot say
    that one member is an admin and another is not. Migration 013 adds a scrypt password and a
    `user_sessions` table.

    Design points that are load-bearing rather than taste:

    - **A session table, not a stateless signed cookie.** A browser credential has to be revocable
      the instant a password changes or a person leaves; a stateless token stays valid until it
      expires, wherever it was copied to. Four things end a session on the next request: revocation,
      expiry, losing the membership, and a `credential_epoch` bump from a password change.
    - **Scrypt cost is stored inside each digest** (`scrypt$N$r$p$salt$hash`), so N can be raised
      without a flag day — an old digest verifies under its own parameters and is rewritten on the
      next successful login.
    - **`requireTenant` now admits a logged-in member**, which widens the two-principal rule in
      `auth.ts` deliberately: a human member of an org already holds exactly that org's authority,
      and the alternative is handing them an API key, which is strictly worse. The WORKER boundary
      does not widen — a person still cannot register a host.
    - **An `Authorization` header is exclusive.** If one is present it is the only credential
      considered, even when it fails. The first implementation fell back to the cookie, which meant
      a request carrying a wrong or revoked key would silently succeed as whoever the browser
      happened to be signed in as. Caught by its own test, on the VM.
    - **CSRF is a double-submit header plus `SameSite=Strict`**, applied to every unsafe request from
      a cookie principal and to none from an API key — a key is never attached automatically, so
      there is nothing to forge.

    The console is served by the API itself from `apps/api/public/` through an ALLOWLIST of four
    paths, not a static-file plugin: there is no path to traverse and no dependency to trust. It
    ships a CSP with no inline script and no external origin, and nothing from the API is ever
    rendered with `innerHTML`.

    **A trap worth remembering:** `.dockerignore` excluded `*.html` for the repo's docs, which
    silently swallowed the console's `index.html`. The image built cleanly and served a 404 for `/`.
    Fixed with a negation that must stay below the exclusion.

    Two things the console does NOT do, both stated in the UI rather than hidden behind a disabled
    button: ~~there is no interactive device view (media needs ADR-0005's relay, which is not
    deployed)~~ **— built and verified on hardware, issue 28** — and a session cannot be pinned to a
    specific device (the allocator chooses; the Launch screen offers device *profiles*, which is
    what the API accepts). ~~App upload and install are not built.~~ **Built, and the console drives
    them — see issues 21 and 22.**

21. **THE APP LIBRARY EXISTS: UPLOAD A BUILD, INSTALL IT ON A DEVICE YOU HOLD.** 2026-08-19,
    migration 014. Phase 3's first bullet, minus launch and uninstall.

    **Names below are superseded by issue 22, one day later**: the table is `app_actions`, the
    endpoint is `POST /v1/sessions/:id/app-actions`, and the success state is `DONE`. The reasoning
    is unchanged and is the reason this entry stays as written.

    Three decisions carry the design, and each one had an obvious alternative that is worse:

    - **An install is a JOB, not a call.** The control plane cannot dial a worker — traffic only ever
      flows outward from the host, which is what lets the farm sit behind a tailnet with nothing
      listening. So `POST /v1/sessions/:id/installs` writes a row and answers **202**, the heartbeat
      carries it down, and `POST /v1/workers/events` carries the outcome up. This is the same shape
      `resets` took in issue 16, and reusing it means a missed install self-heals on the next beat
      with no retry logic anywhere. The cost is one beat of latency (10s) against an install that
      takes tens of seconds anyway.
    - **The install id is the worker's authorization, not its token.** `GET /v1/apps/:id/blob` needs
      an `installId`, and the query behind it demands an unfinished install of that exact build on a
      device belonging to the calling host. Without that the only question the route could ask is
      "is this a valid worker", and the answer would let any host in the fleet download any org's
      builds. A worker has no route that enumerates or fetches an org's apps.
    - **A build IS its sha256.** Uploading the same file twice is one blob, one row, and a 200
      instead of a 201 — so a CI job can upload unconditionally. The worker verifies the digest
      after downloading AND on a cache hit, because a truncated transfer reaches `adb install` as a
      corrupt archive and the error it produces names the app, sending whoever reads it to look at
      their own build.

    Two traps found while building it, both of the "the default is against you" kind:

    - **001's `ALTER DEFAULT PRIVILEGES` grants `mfarm_app` UPDATE on every future table.** So the
      new tables arrived with a grant that would have let any tenant mark its own install
      `INSTALLED`, or rewrite the error a failed one reported. 014 REVOKEs first and then grants
      exactly `SELECT, INSERT`. Same class as the PUBLIC EXECUTE default migration 012 had to undo,
      and there is now a test that asserts the UPDATE is refused.
    - **A named volume mounted on a path that does not exist in the image is created root-owned**,
      and the API runs as `node`. The Dockerfile creates `/var/lib/mfarm/apps` and chowns it so the
      volume inherits that ownership; without it every upload fails with EACCES on a deployment
      that looked fine until someone used it.

    APK metadata (package, version, minSdk, label) is parsed out of the binary
    `AndroidManifest.xml` by hand — `apps/api/src/apk.ts`, a zip central-directory read plus an AXML
    parse — rather than trusted from the client or shelled out to `aapt2`, which the control plane
    does not have and should not grow. The fixture generator in `apps/api/test/fixtures/apk.ts`
    writes the same two formats, so both encodings, both compression methods and resource-id-only
    attributes are covered without a megabyte of opaque binary in the repo.

    **NOTHING HERE HAS EVER RUN `adb install`.** The device side is two lines per backend and the
    tests drive a fake, so the first real APK on the lab box is the test that matters — expect the
    usual disagreements about exit codes and `Failure [...]` text. The blob store is also a plain
    directory on the API host, not MinIO, and `mfarm_appstore` is NOT covered by the backup sidecar
    (`deploy/README.md`, Known gaps).



22. **THREE VERBS, A CONSOLE THAT CAN USE THEM, AND THREE BUGS THAT ONLY RUNNING IT FOUND.**
    2026-08-19, migration 015.

    `app_installs` became `app_actions` with a `kind` of install, launch or uninstall, and
    `INSTALLED` became `DONE`. Renaming a table a day after shipping it is only available because 014
    had never been deployed anywhere — that window closes the first time it runs on the box, and it
    was worth spending: a row reading `kind = 'uninstall'` in a table called app_installs, or a
    console showing "INSTALLED" against a Launch button, is the kind of thing that reads fine to
    whoever wrote it and confuses everyone after.

    One pipeline for all three, because each is a job the control plane cannot push, so each needs
    the same delivery, host scoping, fence check and sweep. **Exactly one thing differs and it is
    load-bearing:** only `install` moves bytes, so `GET /apps/:id/blob` demands `kind = 'install'`
    alongside everything else. Without that clause a queued LAUNCH — a job carrying a package name
    and nothing else — widens into read access to the build's contents. There is a test that asks
    with a real worker credential and a real pending launch, and expects 404.

    The console got the Apps tab: upload with progress, the library, and the three verbs per build.
    The **held-device strip** above it is the part that matters. Releasing a device snapshot-restores
    it, so an app exists on a device only while the session holding it is alive; "where did my app
    go" and "which device am I holding" are the same question, and showing only the second would make
    the first inexplicable.

    **`workers/agent/scripts/fake-farm.ts` is why the rest of this entry exists.** It registers two
    devices that record what they were asked to do, so the console and the whole job pipeline run on
    a laptop with no Android anywhere. Everything below was found by clicking through it against a
    real control plane, and none of it was found by 441 passing tests:

    - **Work offered on the FIRST heartbeat of a restart was silently dropped.** `start()`
      heartbeated and only then assigned `this.state`, so the localId->uuid map was empty while that
      response was handled and every reset or action it carried was discarded with "unknown device" —
      for devices sitting right there. It self-healed on the next beat, which is exactly why it
      survived: a restart during a restore just left a device CLEANING ten seconds longer. The
      regression test went from a ten-second timeout to 103ms.
    - **`quarantine_host` had existed since migration 003 WITH NO CALLER ANYWHERE.** Kill a worker
      and its devices stayed READY forever, so the allocator kept handing them out and every session
      on them failed at connect time — the farm reporting full capacity while serving none of it. On
      two devices that is half the fleet turned into a trap. The reaper sweeps for it now, throttled
      to 15s because it is the only fleet-wide WRITE the reaper performs; recovery is registration,
      which is why the device state machine had to learn to leave QUARANTINED as well as enter it.
    - **A UI that had been lying quietly.** `POST /v1/sessions` answers `{session: {...}}` and the
      Devices drawer read id, state and deviceId off the top level, so its toast said
      "Session undefine on  is undefined". Pre-existing; nobody had read it closely.

    Two console lessons worth keeping. Upload goes through XMLHttpRequest because **fetch cannot
    report upload progress**, and a button that goes quiet for two minutes on a 200 MB APK is
    indistinguishable from a broken one. And the two-step Release confirmation keeps its armed state
    in `state`, not on the button: the view re-renders every five seconds from the poll and
    `replaceChildren` throws the node away, so the first version could not survive long enough to be
    confirmed. **Anything a user is halfway through has to live somewhere the poll cannot replace.**

    ~~**Still no interactive device view.**~~ **BUILT 2026-08-19 — see issue 28 and ADR-0007.** What
    this paragraph described as missing now exists and has run on hardware: coturn with per-session
    credentials, the split bind, a signalling relay, and a browser driving a real Android 17 device
    at ~50 fps. `adb install` has also met a real device. Kept as written because it is what was
    true here, and because the second gap it names is the one that turned out to matter least — the
    install path worked first time; the live view is what found four silent defects.

23. **`logcat` AND `recording` ARE ADVERTISED CAPABILITIES WITH NO IMPLEMENTATION.** Found by audit,
    2026-08-19, while writing `docs/E2E_MVP_PLAN.md`. **CLOSED the same day by ADR-0007, both
    halves:** `logcat` is implemented (`captureLogcat`, streamed live to the console) and so is
    `screenshot`; `recording` was DELETED from the declaration rather than implemented, which is the
    half that actually restores ADR-0003's rule. `avd.ts` had the same false claim and got the same
    implementation, because it is eight identical lines and it is what makes the console's log dock
    work for anyone developing against an AVD on a laptop.

    `devices/cuttlefish.ts:177` declares `'logcat'` and `'recording'` in its capability list.
    `DeviceControl` in `workers/agent/src/device.ts` has **no method for either** — there is no
    `captureLogcat`, no `startRecording`, no `screenshot` — and nothing in `agent.ts` collects or
    uploads anything of the kind. `avd.ts` declares `'logcat'` too, with the same nothing behind it.

    This is the one place the codebase breaks its own ADR-0003 rule: a capability is a claim about
    observed state, and these two are configuration. Nothing consumes them yet, so nothing is
    currently broken by it — the console offers no logcat or video control because neither has an
    endpoint. But the failure mode if something starts trusting them is the same one issue 13
    produced for media: a populated UI over a path that does not exist.

    **Either implement them (M3 of `docs/E2E_MVP_PLAN.md`) or stop declaring them.** Do not leave a
    third state where the list is aspirational.

24. **THE DISK SNAPSHOT IS NOT A FAST FARM START, BECAUSE RESTORING IT IS A HOST REBOOT.** Found
    2026-08-19, bringing `mfarm-farm-ready` back up for the first time since it was taken.

    `mfarm-farm-ready` contains both device snapshots, ~4 GB each, which is what made the claim
    below this — restore it and `farm-up.sh` brings the farm to `available: 2` — sound like seconds.
    It cannot be. **Restoring a disk image boots a host, and issue 18 is what cvd reports after a
    host boots:** both groups still recorded, `"status": "Unreachable"`, `start` refused with
    `Selected instance group is already started`. Bring-up then does exactly what issues 18 and 19
    taught it to do — `cvd rm` the ghost, and `discardGroup`
    (`workers/agent/src/devices/cuttlefish.ts:370`) deletes the snapshot with it, because a snapshot
    pins the absolute HOME of a group that no longer exists. So **both baked-in snapshots are
    deleted unread**, and every device pays a 38s cold boot plus a ~4 GB re-snapshot before it is
    schedulable.

    No step in that chain is wrong; each is the correct repair for issues 18 and 19. What was wrong
    is the expectation. **The fast path is per-boot state, not per-image state.** What the image
    genuinely saves is the image fetch, the Cuttlefish build and the host install — everything a
    human would otherwise sit through — and that is still most of a day. It does not save the boot.

    **Untested, and worth ten minutes on the next live box:** the only thing tying a snapshot to its
    group is one absolute path in `snapshot_meta_info.json`. If restore just copies the tree into
    the HOME that file names, rewriting that string to the new group's HOME before
    `start --snapshot_path` would make snapshots survive a rebuild — which turns every host reboot
    back into the 8s path and makes the snapshots in the image worth their 8 GB. **Do not build on
    it before it is observed.** A false positive destroys a good snapshot, which is the same reason
    `snapshotIsStale` (`cuttlefish.ts:411`) refuses to act on metadata it has not read and compared.

25. **A REBOOTED HOST CAME BACK AND THE CONTROL PLANE NEVER TOOK IT BACK — `available: 0` FOR AN
    HOUR WITH BOTH DEVICES RUNNING.** Found 2026-08-19 on the lab box, going to install the first
    real APK. Fixed by migration 016.

        hosts:   QUARANTINED | quarantined_at 09:23:52 | reason "no heartbeat for 90s"
                             | last_heartbeat_at 10:33:07     <-- beating for an hour
        devices: cf-1 QUARANTINED   cf-2 QUARANTINED     GET /v1/devices -> "available": 0
        cvd:     both groups Running, both adb-responsive

    **Three correct behaviours composing into a farm that cannot come back.**

    1. The box boots. The API container starts before the worker has any devices to register, the
       reaper reads a `last_heartbeat_at` from before the reboot, and quarantines the host. Right —
       and the entire point of the fix that added the caller (issue 17's `hostsQuarantined`).
    2. Nothing clears a quarantine except `POST /workers/register`. That was a deliberate design
       decision, written down in `index.ts`: an agent that re-registered whenever Appium flapped
       would repeatedly un-quarantine a host an operator had taken out of service.
    3. **A healthy agent never re-registers.** `agent.ts` skips registration when the stored
       capability fingerprint matches and the beat succeeds — which is issue 22's fix working
       exactly as designed. Restarting the agent changes nothing: same file, same fingerprint, same
       skip. The only exit was deleting `~/.mfarm/agent-state.json` by hand.

    So the recovery path assumed a re-registration that the normal case never performs, and the
    trigger is not exotic — **every host reboot reproduces it**, which is to say every restore of
    `mfarm-farm-ready` (issue 24) starts here.

    **THE FIX IS TO SPLIT THE TWO KINDS OF QUARANTINE BY THEIR EXIT CONDITION**, because they are
    not the same claim. A silence quarantine asserts "this host is not beating", and a heartbeat is
    that claim's own disproof — so the beat lifts it. An operator quarantine asserts a judgement no
    packet can refute, and only a human lifts it. Migration 016 records which one it is in
    `hosts.quarantine_source`, and `clear_silence_quarantine` (called from the heartbeat, source
    re-checked inside the function body per migration 005's rule) is the way back.

    **`devices.quarantined_from` is the non-obvious half.** `quarantine_host` collapses READY,
    OFFLINE, BOOTING and CLEANING into QUARANTINED, and restoring them all to READY would hand the
    next tenant a device whose previous session had ended without a snapshot restore — the exact
    leak CLEANING exists to prevent. So the prior state is recorded and put back. Devices
    quarantined before 016 have NULL there and are deliberately left QUARANTINED: their prior state
    is unknown, and guessing it is the failure the column exists to avoid.

    **Upgrading a database that is already in this state needs one manual recovery**, because the
    stuck rows predate the column: stop the worker, move `~/.mfarm/agent-state.json` aside, run
    `deploy/farm-up.sh`. That forces the registration that has always been the documented cure. It
    is the last time it should ever be needed.

    Two smaller things fell out of it, both worth keeping:

    - **The agent logged its quarantine 360 times an hour** and the fact hid in the noise — every
      line looked like news and the one that mattered was an hour old. It now logs host-state
      TRANSITIONS, including the recovery.
    - **A capability fingerprint answers "has anything changed?", not "does the control plane still
      agree with me?"** Issue 22 fixed the first question; this was the second one, unasked. Any
      cache of "I already told them" should be checked against what they say back.

26. **THERE IS A DEPLOY PIPELINE NOW, AND THE FIRST THING IT FOUND WAS THAT CI HAD BEEN RED FOR TWO
    DAYS.** 2026-08-19.

    The problem it solves is not deployment speed, it is **identity**. Deploying used to mean
    getting source onto the box somehow and running `docker compose build`, so nothing tied a
    running container to a commit and "is my fix live?" could only be answered by reading a git log
    over ssh. Two sessions a day apart could not establish whether they were looking at the same
    system, which is most of why this file kept drifting from reality.

        push to main -> CI -> (green) Release builds ghcr.io/rkcr007/mfarm-api:<sha>
                                   -> deploy/mfarm-deploy.sh <sha> on the box
                                   -> migrate, restart api only, then ASK IT WHAT IT IS

    **`/v1/version` is the piece that matters.** It reports the commit baked into the image at build
    time, when it was built, when the process started, and the last migration applied; the console
    shows the short sha in its header. The sha is baked in rather than read from a checkout, because
    a process reporting the git state of the directory it happens to run in reports the deployer's
    intent, not its own contents. The process start time is there because a redeploy that lands the
    same commit is otherwise invisible.

    **The verify step is not ceremony.** Every deployment mechanism that has bitten this project bit
    it by succeeding quietly while changing nothing — issue 14's dead snapshot path, issue 16's
    absent reset caller, issue 25's quarantine. A deploy that cannot confirm its own sha now fails.

    **What running it found, immediately:** CI had been failing on every push since migration 015,
    because the role-verification step still named `app_installs` and 015 renamed it to
    `app_actions`. Two days of the strongest guard in this repo — the one proving RLS is enforced and
    that the app role cannot write action outcomes — checking nothing, unnoticed because nothing
    consumed the result. **A gate nobody reads is not a gate**, and the fix is not vigilance, it is
    making something depend on the answer: `release.yml` builds only on green, so a red CI now means
    nothing is deployable.

    Three supporting changes, each closing a way the farm used to lose its own state:

    - **The worker is a systemd unit**, not a tmux window. It died with whoever started it and never
      came back after a reboot, so a farm could be healthy at the cvd layer with nothing registering
      it. `journalctl -u mfarm-worker -f` replaces "attach to my tmux".
    - **The box has a read-only deploy key**, so `git pull` works there. It had no GitHub credential
      at all, which is why code used to arrive by `git archive | scp` and why the checkout on the
      box was seven commits behind the branch someone thought they were running.
    - **The address is reserved.** Under sslip.io the hostname IS the IP, so an ephemeral address
      expired the console URL and its certificate together on every stop/start.

    **Not automated on purpose.** Deployment is one command a person runs, because the value of the
    manual step is that somebody decides when the farm changes underneath a running session.
    Rollback needs no plan — images are immutable and tagged by commit, so it is the same command
    with an older sha — but **migrations do not roll back**, and moving code back past one it depends
    on is a decision rather than a command.


27. **THE SPLIT, AND THE THREE VERBS FINALLY MEETING REAL adb.** 2026-08-19, ADR-0006.

    The control plane moved to its own always-on machine (`mfarm-cp`, e2-medium) and the device host
    (`mfarm-lab`, n2-standard-16) now runs only Cuttlefish, Appium and the agent. What that bought,
    in order of how much it was worth:

    **The console stopped being a property of the device fleet's cost.** It is up whether or not
    anything can run a test. The trigger was watching a scheduled 19:00 shutdown take the UI down
    mid-upload, with the operator's reasonable first guess being "it crashed".

    **The worker's data plane left the docker bridge.** It binds `10.160.0.2` now — the internal VPC
    address — because a control plane on another host cannot reach `172.18.0.1`. That was ADR-0005's
    outstanding item and it could not be deferred any longer; colocation is what had made the wrong
    address survivable.

    **Verified across the two hosts, in this order:**

    - A full WebDriver session in **6.7s** — hub on the control plane, gateway/Appium/adb on the
      device host, over the VPC. `deploy/verify-webdriver.mjs`, unchanged.
    - **install, launch AND uninstall, all DONE against real adb** (2s / 11s / 11s). Install crosses
      hosts twice: the job arrives on a heartbeat, and the worker fetches the APK blob from the
      control plane over HTTPS. **Uninstall had never run anywhere before this** — issue 22 shipped
      it with only a fake device behind it.

    Things the migration itself taught, all of which cost time:

    - **Compose file secrets are read by uid 1000 inside the image.** `tar` as a non-root user
      cannot preserve ownership, so the copied secrets came out owned by the login user and the API
      restart-looped on `cat: can't open '/run/secrets/session_signing_key'`. The README warned
      about exactly this; it is worth reading before moving a farm, not after.
    - **`ALTER ROLE mfarm_app` is part of standing up a database, not part of `farm-up.sh`.**
      Migrations create the role with the committed development password; only farm-up reconciled it
      to `.env`, so a control-plane-only host came up with a perfect schema and
      `password authentication failed for user "mfarm_app"`.
    - **A firewall rule with `targetTags` follows the tag, not the address.** Moving the reserved IP
      to the new host left `mfarm-web` on the old one, so the console answered on loopback and timed
      out from the internet — which looks exactly like a broken certificate.

Each of these came from a test failure, not from review. They are the ones most likely to be
re-broken by someone who does not know the history.

**SECURITY DEFINER bypasses RLS — re-implement authorization inside the function body.**
`release_device()` originally filtered on session id alone, so any tenant could kill any other
tenant's session. The RLS policies offered zero protection because the function never ran under them.
Fixed in `005_scope_session_mutations.sql`. Any new definer function must scope by org explicitly.

**Never connect the app as a superuser.** Superusers bypass RLS unconditionally, `FORCE` or not, so
every policy reads as enabled while doing nothing. `db.ts` keeps two pools: `appPool` (`mfarm_app`,
no BYPASSRLS) for all request handling, `systemPool` (owner) for migrations and fleet ops. **Tenant
data must go through `withTenant`.**

**Coalesce positional input, queue discrete input.** Dropping a tap that the user has moved past is
correct. Dropping a keypress means typing "hello" yields "hlo". `dataplane.ts` splits the two.

**Claim an idempotency key before doing the work, not after.** The retry that matters arrives while
the first request is still running, so check-then-do-then-record allocates twice and bills twice.

**Hook order decides whether a defence runs at all.** `@fastify/rate-limit` attaches per route, and
route hooks run after every instance-level `onRequest` hook — so rejecting bad credentials in
`onRequest` left every unauthenticated request unlimited. And the limiter *throws* whatever
`errorResponseBuilder` returns, so returning a response body instead of an `Error` turned every 429
into a 500. Both were invisible because nothing tested the limiter.

**Scope every SECURITY DEFINER mutation by the caller's identity, on BOTH sides of the fleet
boundary.** 005 fixed the tenant-facing pair and stopped. `device_reset_complete()` still filtered on
device id alone, so any worker could mark any other host's device READY mid-restore — handing the
next tenant a device with the previous one's data on it. Metering was worse: a plain INSERT with a
worker-supplied `org_id`, so a worker could bill any org, and could claim an event id ahead of time
so the real usage arrived later and was absorbed as a duplicate. Fixed in `008`, which also makes the
rule structural: the caller's id is in the signature, and the paying org is *derived* from the
session rather than accepted from the request.

**Revoke EXECUTE from PUBLIC, or the grant is not a control.** Postgres grants EXECUTE on every new
function to PUBLIC, so a `SECURITY DEFINER` function is callable by `mfarm_app` the moment it is
created. Never granting it does nothing. `008` revokes, and `ci.yml` now checks.

**The privilege a lock needs is not the privilege a write needs.** `allocate_device` runs
`SELECT max_concurrent FROM orgs WHERE id = $1 FOR UPDATE` to serialise the concurrency-cap check.
It writes nothing, so `GRANT SELECT` looked sufficient — and every allocator test failed with
"permission denied for table orgs", because a row lock requires UPDATE on at least one column.
Granted as `UPDATE (max_concurrent)` rather than table-wide: Postgres only asks for one column, and
that is the column the lock exists to protect.

**A backup is not a backup until a restore has been rehearsed.** `pg_dump` captures a database and
nothing else — roles are cluster-wide, so a restore into a fresh cluster dies on the first `GRANT`
against `mfarm_app`, and the tempting fix (restore everything as the owner) hands you request
handling that bypasses RLS. `pg_restore` also defaults to reporting errors and carrying on, so a
half-restored database exits 0 and reads as success. Both are invisible until the day they are not.
`deploy/backup.sh` dumps globals alongside the data, `restore.sh` uses `--exit-on-error` and
deliberately does NOT pass `--no-owner --no-privileges` (ownership decides whether RLS applies at
all), and `restore-drill.sh` destroys and rebuilds a scratch database in CI to prove all of it.

**A capability is a claim about observed state, not about configuration.** `AUTOMATION_ENDPOINT`
being set made a host advertise `webdriver` with nothing checking anything was listening, so a dead
Appium kept receiving real tenant sessions. Anything that advertises capacity must verify it.

**A valid credential is not evidence that the control plane's picture is still right.**
`Agent.start()` reused a stored worker token whenever the heartbeat succeeded and skipped
registration entirely. Since registration is the *only* writer of capabilities, the drain-and-exit
withdrawal in `index.ts` withdrew nothing: the agent restarted, heartbeated, never re-registered, and
the control plane went on believing `webdriver` was live on a device whose Appium was dead. Fixed by
fingerprinting what registration asserted (`AgentState.registered`) and re-registering when it
changes. **Whenever a stored credential lets you skip a write, ask what that write was also saying.**

**A backward-compatibility fallback can re-create the bug it is compatible with.** The host-level
`automationEndpoint` is resolved by the control plane as the default for any device that names none.
Reporting it on a host where only *some* devices had a server therefore stored one device's URL on
the others — B2 exactly, arriving through the compatibility path. It is now withheld unless every
device is covered by the same URL. Caught by a test, not by review.

28. **THE LIVE VIEW, AND THE FOUR THINGS BUILDING IT FOUND.** 2026-08-19, ADR-0007.

    The console now has a **Launch** screen (pick a build, pick a device profile, start) and a
    bring-up screen whose checklist is derived entirely from real state — session row, app-action
    row, socket — with a percentage rather than a spinner. It hands over to a cockpit with a live
    device view, a control rail on the WebRTC data channel, a logcat dock and screenshots.

    How it reaches the device: the browser's WebRTC **signalling** rides the data-plane WebSocket it
    already holds, and the worker relays those frames opaquely to cvd's operator on loopback. Media
    still never touches the worker (ADR-0005); it negotiates directly, through coturn where a direct
    path does not exist. `deploy/setup-turn.sh` deploys the relay; `deploy/setup-ingress.sh` gained a
    `/dp/*` route so the socket is same-origin behind the console's own TLS.

    **What is verified, and it is more than expected.** `fake-farm.ts` now runs the real `DataPlane`,
    so grant verification, the fence check, `signal-open`, batched logcat, screenshots and the honest
    refusal from a tier with no media source were all exercised end to end in a browser. What has NOT
    run is a negotiation against a real operator — that needs the device host, and two things there
    are asserted rather than measured: the operator's port (1080, not the 8443 `CuttlefishMedia` had
    hard-coded from the `launch_cvd` era) and the device id (`--webrtc_device_id` does not survive a
    snapshot restore, so it is discovered from `GET /devices` and REFUSED rather than guessed when
    two candidates are equally plausible).

    Four defects surfaced while building, none of which a test or a review would have found:

    **A browser-started session could never become ACTIVE.** `session_activate` had exactly one
    caller — the WebDriver hub — so a session opened from the console sat in `ALLOCATING` for its
    whole life. `started_at` stayed NULL, so every duration and lease bar was measured from the
    allocation rather than the attach, and the device never showed as in use. Migration 017 adds a
    host-scoped `session_attach` that the WORKER reports on its existing events channel, because the
    data plane is the only party that observes a client attaching.

    **`index.ts` declared a uuid -> backend map for the data plane and never filled it.** The comment
    beside it described a mapping "taught on first use" that nothing taught. At one device the
    single-device fallback hid it completely; at two, every data-plane connection would have been
    refused as `unknown_device`.

    **The CSP blocked the socket, silently.** `connect-src 'self'` does not match a different port,
    and a blocked WebSocket reaches JavaScript as a bare `error` event with no reason — so a console
    that could never connect looked exactly like a worker that was down. `connect-src` now names the
    one configured data-plane origin when it is not same-origin.

    **A device that cannot stream was losing its whole connection.** `signal-error` was treated as a
    connection failure, which took logcat and input down with the missing video. It is now a distinct
    `nostream` state: attached, driveable, no picture.

29. **THE DOMAIN, THE RESERVED ADDRESSES, AND THREE BUGS THAT ONLY A DEPLOYMENT FINDS.** 2026-08-20.

    `mfarm.dev` was registered through Cloud Domains ($12/yr, auto-renew, expires 2027-08-19) with
    Cloud DNS as authoritative. Both records point at RESERVED addresses, so neither name can drift:

        farm.mfarm.dev -> 34.100.138.213 (mfarm-cp)    console, /v1, the hub, /dp
        turn.mfarm.dev -> 34.100.159.34  (mfarm-lab)   coturn, and nothing else

    **The addresses were the more valuable half.** `mfarm-ip` had been sitting RESERVED and unused
    since the single-box era — billed the whole time, at the *higher* rate GCP charges an address
    attached to nothing — so attaching it cost nothing and removed the ugliest failure this project
    has produced: the device host's IP changed on every stop/start, coturn advertised the old one,
    and the console worked perfectly while video silently never arrived, with an empty relay log
    because nobody ever called it.

    **The CSP got simpler, not more complex.** Under the new domain the live-view socket is
    `wss://farm.mfarm.dev/dp` — same origin as the console — so `connect-src` is back to plain
    `'self'` with no external origin named. That is ADR-0007's design working as intended.

    Three bugs, all found by deploying rather than by review:

    **coturn's `external-ip` does not accept a hostname.** `setup-turn.sh` had started defaulting it
    from `MFARM_TURN_HOST`, which had just become `turn.mfarm.dev`. It would have produced a relay
    that starts cleanly and hands every client an unusable address. The name is resolved first now.

    **`docker compose up -d api` silently serves `:latest`.** It does not set `MFARM_IMAGE`, the
    compose file falls back, and the API comes back on an older build having reported success. This
    trap caught the person who documented it, mid-migration. Fixed where it cannot break anything:
    `mfarm-deploy.sh` writes `MFARM_IMAGE` into `deploy/.env`, which compose reads on its own.
    Removing the `:latest` default instead would break `farm-up.sh` on a fresh box.

    **`CF_RESET_MODE=powerwash` governed the reset path and not the boot path.** `restartExisting()`
    still consulted `snapshotOnDisk()`, so a snapshot left from before the mode was set was restored
    on startup — the farm came up restored, published no display, and lost the live view for exactly
    the reason the mode exists. Now `snapshotOnDisk()` returns nothing in powerwash mode.

    Also: `verify-live.sh` was reporting a green "live view available" for a farm with **no devices**,
    because it grepped an empty response. A check that reports success on no data is worse than no
    check. It now also treats "no devices AND /dp with no upstream" as the normal stopped-device-host
    state rather than three failures, and fails if the API is running a floating image tag.

30. **THE RUN, AND THE THREE COLUMNS IT DELIBERATELY DOES NOT HAVE.** 2026-08-23.

    Migration 020 plus `mfarm:runId` (`docs/EXECUTION_MODEL.md` §4.2). A run is four columns — id,
    org, the caller's name for it, created_at — and everything the Runs screen shows is derived from
    the run's sessions. Three columns that the original sketch had are absent on purpose, and each
    one is easy to add back by someone who has not read this:

    **`ended_at`.** There is no signal that a run is over. The obvious substitute — "the last session
    of the run ended" — is wrong in a way that would be believed, because a sequential suite ends
    every test's session before starting the next: a twenty-test run would be marked finished
    nineteen times before it was. The window is derived (`min(created_at)`, `max(ended_at)`) and the
    number of still-live sessions is reported as a count, which is the only honest signal available.

    **`status`.** WebDriver has no concept of an assertion. Any pass/fail on a run today would be
    inference presented as fact. §4.3 is what makes it knowable, and until then the screen says
    nothing about it rather than guessing.

    **`app_build_id` on the run.** A run's sessions can legitimately name different builds — an
    upgrade test, an A/B — so one denormalised column would silently pick a winner. The build lives
    on the session that installed it, and the run reports `buildCount`, naming a build only when
    there is exactly one. The console shows "2 builds" rather than an em-dash for that case, because
    `build: null` alone reads identically to "installed nothing".

    All three follow 019's rule: a column nothing writes is a claim with nothing behind it.

    Two things worth knowing about the implementation:

    **The unique index is `(org_id, external_id)`, and it is load-bearing rather than tidy.** Run
    names are chosen by the client, and every CI system on earth numbers builds from 1 — two tenants
    both running `mfarm:runId: '412'` is the ordinary case, not the adversarial one. A global unique
    index would have merged their runs, with each org reading the other's session list and no policy
    violated, because both would genuinely own the row they were handed.

    **The rollup is a LATERAL, not a `GROUP BY` over a three-way join.** The join form multiplies
    rows before it counts them, so a run whose sessions each hold several artifacts would report its
    session count times its artifact count — the classic shape of a number that is wrong by a factor
    nobody notices until it is quoted in an invoice.

31. **`req.raw.destroyed` DOES NOT MEAN THE CLIENT HUNG UP, AND TWO FEATURES SHIPPED BROKEN ON IT.**
    2026-08-23. Found on the first hardware run of `mfarm:appId`, not by any test.

    `req.raw` is the IncomingMessage. Its readable side is destroyed once the body has been
    consumed — which Fastify does BEFORE the handler runs — so on a perfectly healthy request it is
    false on entry and **true at the first `await`**, while the client is still waiting for its
    response. Measured over a real socket: `destroyed` true after 50 ms, with
    `req.raw.socket.destroyed` and `reply.raw.destroyed` both still false.

    Both of the hub's long waits used it as their "give up, nobody is listening" predicate:

    * `mfarm:appId` abandoned its install wait on the FIRST poll and reported *"still installing
      after 240s"* having waited about a millisecond. It failed on every session. The message named
      240s because that is the configured timeout, not because anything waited that long — which is
      why it read as a slow device rather than as a bug.
    * `mfarm:queueTimeoutSeconds` returned "no device became free" immediately, so the queue
      capability had **never queued**, on any deployment, since it was written.

    **NO TEST COULD HAVE CAUGHT IT**, and that is the part worth keeping. Every hub test drives
    `app.inject()`, whose request object is not socket-backed: `destroyed` stays false forever
    there. 410 lines of new tests, all green, against a feature that worked zero percent of the time
    in production. `test/webdriver.test.ts` now has one test that binds a real port and speaks HTTP
    over a real socket, and it withholds the install for longer than one poll interval — a worker
    that answers on the first beat cannot tell a working wait from one that gave up instantly.

    The fix is `clientGone(reply)`: the RESPONSE is what tracks the connection. `close` on a
    ServerResponse fires when the response completes or when the connection is torn down early, and
    consulted while the handler is still working — before a byte has been sent — it can only mean
    the second.

    **Both halves are now verified on hardware.** `deploy/verify-runs.mjs` drives `mfarm:appId` and
    `mfarm:runId` against real Cuttlefish (session open in 12.1 s including the install), and
    `deploy/verify-queue.mjs` fills the farm and proves a queued request is still waiting five
    seconds later — promoted after 69 s once a device was freed. Run them after any change to the
    hub's waits; neither can be replaced by a test using `app.inject()`.

    **The general rule, applied across the repo 2026-08-24: never quote a configured limit as if it
    were an elapsed time.** An error that reports a budget describes the configuration; only a
    measurement describes what happened. Four messages did the former and all four now report
    measured time — the hub's install wait and capacity wait, `mfarm app install --wait`, and
    `mfarm run`'s queue timeout. Two of them were reachable with a budget of zero, where the old
    wording claimed a wait that provably never occurred.

    The same edit also split the outcome the waits return. `awaitAppAction` used to answer PENDING
    for both "the deadline passed" and "the caller went away", so the caller could not tell them
    apart and reported a timeout either way — which is precisely what let a one-millisecond wait
    announce itself as a four-minute one. `waitForCapacity` now distinguishes four endings for the
    same reason.

    Diagnosis note for next time: the session row said `ended_at` 43 ms after `created_at` with
    `end_reason = session_not_created`, while the client had been handed a message about 240
    seconds. **Trust the timestamps over the error text.** That gap is what identified this in one
    step after the logs had suggested a device problem.

32. **DEVICE PROFILES — what is and is not verified against real hardware.**
    2026-08-29, with ADR-0016. (a) is now closed; (b) and (c) are open and (b) is the dangerous one.

    a. ~~**The cvd display flag spelling is a guess.**~~ **VERIFIED 2026-08-29** against cvd 1.55.1
       on the lab VM. `cvd create --help` documents `--display0` through `--display3`, taking
       `width` (required), `height` (required), `dpi` (default 320) and `refresh_rate_hz`
       (default 60) — exactly the form `coldBoot` emits. `--cpus` and `--memory_mb` are both real
       and spelled as written. `--displays_textproto` does not exist on this build.

    b. ~~**The Samsung build properties may not survive a reset.**~~ **CONFIRMED BROKEN AND FIXED
       2026-08-29.** They did not survive. The overlay's upper directory is on `/mnt/scratch`, and
       `cvd powerwash` wipes it — directly after a powerwash cf-3 reported
       `ro.product.model = Cuttlefish x86_64 phone 64-bit only` and `ro.product.manufacturer =
       Google`, while its geometry was untouched. Re-application now happens inside `powerwash()`
       exactly as ADR-0016 said it would have to, and is verified on hardware: an agent-driven reset
       logs `re-applied galaxy-s25-ultra identity (SM-S938B)`.

       **The cost is real and measured: a powerwash reset on a profiled device takes ~100s instead
       of ~40s**, because `adb remount` needs a reboot before the overlay is writable and `ro.*`
       properties are read once at init, so the write needs another. Unprofiled devices are
       unaffected.

    c. **QHD+ on SwiftShader is unmeasured.** `docs/RENDER_BASELINE.md` measured 60fps for ordinary
       UI at 720×1280 with no GPU; cf-3 is ~4.9× the pixels through the same software rasteriser.
       Keeping cf-1 unprofiled makes this a same-host A/B rather than a comparison across two farm
       states — run `deploy/verify-render.mjs` against both. Gate: ≥55fps on cf-3, else drop the
       Ultra profile to FHD+ 1080×2340 (which is how Samsung ships it anyway).

    Also unmeasured, and new with four devices: **four concurrent live sessions.** SwiftShader
    rasterises on the CPU, so four streams contend on 16 vCPU in a way two never did.

    The specification numbers themselves are from published sources, **not read off a handset**.
    Density is the one worth confirming with `adb shell wm density` on a real S25: Samsung ships a
    default display-size setting that is not the panel's native ppi, and it is the shipped density
    that decides dp — which is what layout bugs are expressed in.

33. **`AppStore.put` leaves a `.part` file behind when an upload is refused for size — PRE-EXISTING,
    and it makes one test flaky.** Noticed 2026-08-29 while working on something else; **not
    introduced by that work**, and confirmed by running `test/apps.test.ts` five times on a clean
    tree, where *an oversized stream is refused without writing it out* failed 4 times out of 5.

    The `unlink` after the failed `pipeline` IS awaited, so the shape of the bug is a race rather
    than a missing cleanup: `createWriteStream` opens lazily and asynchronously, and an open still in
    flight when the transform throws can recreate the file *after* the unlink has run. The leftover
    is harmless to the product — nothing reads `tmp/` — but it is real, and the test is right to
    object. Left alone deliberately as unrelated scope; it wants a `finally` that unlinks after the
    write stream has actually closed.

34. **THE CUTTLEFISH IMAGE ADVERTISES `arm64-v8a` WITH NO TRANSLATION LAYER BEHIND IT.**
    Found on hardware 2026-08-29 while verifying ADR-0016, and it corrected a claim made in that
    ADR, in the PR, and in the code.

    `adb shell getprop ro.product.cpu.abilist` on the lab image (AOSP 17, build 16102939) returns:

        x86_64,arm64-v8a

    Not `x86_64,x86`. Two separate surprises in one line: there is **no 32-bit x86** — it is a
    64-bit-only image, `ro.zygote=zygote64` — and **arm64-v8a is advertised**, which the code had
    hard-coded a denial of.

    That hard-coded list was shipped in the first cut of the install preflight and would have
    **refused arm64 builds the platform's own PackageManager accepts**, which is the precise failure
    the preflight was written to avoid, pointed the other way. Fixed by reading the list off the
    guest (`refreshAbis` in `cuttlefish.ts`) — a capability is observed state, ADR-0003, in the one
    place this file had quietly stopped obeying it.

    **WHETHER arm64 CODE ACTUALLY RUNS IS STILL OPEN, and the evidence points both ways:**

    * for — `ro.product.cpu.abilist` and `abilist64` both list `arm64-v8a`, and that list is exactly
      what PackageManager matches `lib/<abi>/` against, so an arm64-only APK should INSTALL;
    * against — `ro.enable.native.bridge.exec` is `0`, `ro.dalvik.vm.native.bridge` is empty,
      `/proc/sys/fs/binfmt_misc/` is empty, and no `ndk_translation`/houdini libraries are present.
      Nothing found on the device can execute an ARM ELF.

    The likely truth is that an arm64-only APK installs cleanly and then dies at
    `System.loadLibrary` — a mystery failure moved later rather than removed. **Settle it with a
    real arm64-only APK**; the sample on the box (`~/bitbar-sample-app.apk`) is pure bytecode and
    cannot answer it. If it is confirmed, the honest fix is a runtime-capability check, not an
    install-time one, and the preflight's message should say "installs but will not run".

35. **A PLAIN `cvd start` DOES NOT REMEMBER THE DISPLAY, AND THE IDENTITY SURVIVES IT — which is the
    worst possible combination to debug.** Measured on the lab VM 2026-08-29.

    cf-3, booted and running at 1440x3120 @ 600, came back from `cvd start --daemon` at
    **720x1280 @ 320** — the image default. Meanwhile `getprop ro.product.model` still answered
    `SM-S938B`, because the properties live in the guest's own overlay rather than in cvd. So the
    device kept calling itself a Galaxy S25 Ultra while rendering at the size of a 2013 phone, and
    the console would have shown the Samsung name and chrome over a 720p stream.

    This contradicts the standing comment in `cuttlefish.ts` that the device configuration comes
    back out of cvd's instance database. That is true for the SNAPSHOT path and false for the plain
    restart. The restart path is what a host reboot takes, and what a worker restart takes whenever
    it finds the group stopped — so this would have fired on the farm's own boot self-heal.

    Fixed by passing the profile's flags to `cvd start` as well as `cvd create`; `cvd start --help`
    accepts the same `--display0`, `--memory_mb` and `--cpus`. Deliberately NOT added to the
    snapshot branch, where the configuration comes from the snapshot and a disagreeing flag would
    give a device whose framebuffer and guest differ about its own size.

    **The general lesson, and the reason both this and issue 34 exist:** for a profiled device,
    every path that brings it up has to carry the profile, and every path that wipes it has to
    restore the identity. They are different mechanisms with different lifetimes — geometry lives in
    cvd, identity lives in the guest — and neither survives what the other survives:

    | | `cvd create` | `cvd start` (plain) | `cvd powerwash` |
    |---|---|---|---|
    | geometry (cvd instance db) | set | **was lost — now passed** | survives |
    | identity (guest overlay) | absent | survives | **wiped — now re-applied** |

36. **A DEVICE'S SHAPE WAS OUTSIDE THE REGISTRATION FINGERPRINT, so it could never be corrected.**
    2026-08-29. The third instance of the same class of bug, and `capabilityFingerprint()` already
    carried a comment warning about it: *"anything not in this fingerprint can never be corrected on
    a host that already exists — it resumes, heartbeats, and keeps advertising whatever it said the
    first time."*

    `devices.model`, `screen`, `profile` and `abis` are written by the registration upsert and by
    nothing else. Until device profiles they could not change on a running host — `model` was the
    constant `cuttlefish` and the other three did not exist — so nothing noticed. ADR-0016 made all
    four mutable and left them out of the fingerprint.

    The symptom: cf-3 was rebuilt at 1080x2340 @450, the guest agreed, the agent had the right value
    in memory, the worker was restarted, and the console kept showing **1440x3120 @600** for as long
    as the capabilities stayed equal. A device whose reported panel disagrees with the one it draws
    is worse than one that reports nothing — the console divides by it to place a tap, so every
    click would have landed in the wrong place.

    **The general rule, now stated three times in three places:** anything the registration upsert
    writes must be in the fingerprint, or it is write-once for the life of the host row. Worth
    checking against the upsert's column list whenever a field is added to it.

## Working notes for whoever picks this up

**Context is cache; disk is truth.** This file, `docs/adrs/`, and the test suite are the system of
record — not any chat transcript. Write a fact down when you learn it, not at the end of a session,
because a summary written late is written with the detail already lost. This file is what makes a
cold start cheap; keep it current or it stops being worth reading.

**Delegate file-heavy work to subagents.** They have their own context windows, and only their
report comes back. Four agents built this batch in parallel for roughly the cost of reading four
reports.

**Give parallel agents disjoint file ownership and one database owner.** See constraint 6 — a second
agent running a DB-backed suite will corrupt the first's run.

37. **A STRING WHERE `h()` WANTED AN OBJECT KILLED EVERY SESSION IN PRODUCTION, AND 991 TESTS SAID
    IT WAS FINE.** 2026-08-29.

    `paintFrame` drew the side buttons with `h('span', { style: `top:${b.topPct}%;…` })`. `h()`
    writes styles as `Object.assign(node.style, value)`, so a STRING there is spread across the keys
    `0`, `1`, `2`… A real `CSSStyleDeclaration` answers that with

    ```
    TypeError: Failed to set an indexed property [0] on 'CSSStyleDeclaration'
    ```

    thrown out of `paintFrame` -> `stagePanel` -> `screenCockpit` -> `render`. The cockpit therefore
    threw partway through building its tree on EVERY session, on the one screen the product is
    about. The visible symptom was not an error: the page rendered blank, then the live view sat at
    "Negotiating the media connection" forever, and the session stayed `ALLOCATING` for its whole
    life — because `session_attach` (migration 017) is reported by the worker when a client attaches,
    and the client never got far enough to attach. **Three layers of honest-looking status, all
    downstream of a `TypeError` nothing surfaced.**

    Only the side buttons take this path; the cutout and the frame use `setProperty`, which is why
    the panel drew its body and its punch-hole and lost only the code after them.

    **WHY THE SUITE WAS GREEN, which is the part worth keeping.** Two independent blind spots, and
    either one alone would have hidden it:

    a. **`dom-shim.ts` modelled `style` as a plain object**, and `Object.assign({}, 'abc')` succeeds —
       it just produces `{0:'a',1:'b',2:'c'}`. The one CSSOM behaviour that distinguishes a real
       declaration from a bag of properties was the one the shim did not have. It now throws on an
       indexed write. That is not CSSOM support and does not pretend to be; it is a single guard
       against a mistake the shim was previously blind to by construction.

    b. **The profiled-cockpit test set `state.sessionDetail`, a key that appears NOWHERE in
       `console.js`** — the cockpit reads `state.detail`. So the test spread `undefined`, rendered the
       UNPROFILED `dev-1`, and asserted `dev-body` and `dev-cutout`, both of which are built once
       with the panel and exist for every device, profiled or not. It was green because it asserted
       two things that are true of everything, about a device it never loaded.

    **THE GENERAL LESSON, and it is not "add a test".** An assertion that holds for the fallback path
    cannot detect that you are on the fallback path. `dev-body` and `dev-cutout` were the wrong
    things to assert precisely because they always exist; `dev-btn-right` was the right one because
    it exists ONLY when `chromeFor` matched a real profile. When a feature has a graceful fallback,
    at least one assertion has to be false in the fallback — otherwise the test passes hardest
    exactly when the feature is not working.

    Both halves are fixed, and reverting the one-line source bug now fails the suite with the real
    browser's error text.

38. **THE SAMSUNG IDENTITY IS GONE, AND THE RESET GOT 2.5× FASTER BECAUSE OF IT.** 2026-08-29,
    ADR-0017.

    `MFARM_PRODUCT_DIRECTION_AND_DEVELOPMENT_RESET.md` replaced the imitate-a-handset direction with
    an MFARM-owned one. `cf-3` and `cf-4` are now **MFARM X1 Pro** (1080×2340 @450, 384dp) and
    **MFARM X1** (1080×2340 @480, 360dp). Profile ids are `mfarm-x1-pro` and `mfarm-x1`.

    **WHAT WAS DELETED:** `props` and `identityProps` from `profiles.ts`, `applyProfileProps()` from
    `cuttlefish.ts`, `workers/agent/src/bin/profile-props.ts`, `deploy/apply-device-profile.sh`.

    **THE NUMBER THAT MATTERS.** A powerwash reset on a profiled device measured **~100s**; it is now
    **~40s**, the same as an unprofiled one. All of that difference was two reboots spent rewriting
    build properties that `cvd powerwash` had just wiped. Confirmed on hardware before the change —
    the worker logged `[cuttlefish] cf-3: re-applied galaxy-s25-ultra identity (SM-S938B)` 101
    seconds after the reset began.

    **THE RULE THAT SURVIVES THE DELETION, and the reason this entry exists at all:**

    > Anything a profile needs must be a **BOOT FLAG**, never a guest edit.

    Geometry survives a powerwash because it lives in cvd's instance database. Guest edits do not,
    because they live in an overlayfs on `/mnt/scratch` that the wipe clears — and this farm runs
    `CF_RESET_MODE=powerwash`. Any future profile field that cannot be expressed as a `cvd` flag is
    signing up for a re-application step on every single reset. That is what the deleted code was.

    **OPERATIONAL — this WILL bite an existing farm.** `CF_PROFILES` still naming `galaxy-s25-ultra`
    now **fails the agent at startup**. That is deliberate and tested: the alternative is the device
    booting unprofiled at 720×1280 while the console shows it as an X1 Pro, which is only ever
    discovered by someone puzzling over a screenshot. Fix `deploy/.state/worker.env` and restart.

    No migration. `model` and `profile` are both inside `capabilityFingerprint()` (issue 36), so
    every device re-registers on worker restart and the rows correct themselves.

    **WHAT DID NOT CHANGE, deliberately:** geometry, RAM and cores. Those are measured, and
    `--memory_mb`/`--cpus` only apply on a COLD BOOT — so holding them makes this a re-registration
    instead of a rebuild of every instance. The direction document's larger RAM figures need a
    recreate window. Its "120Hz-class display" is not adoptable at all: the render baseline is
    measured against 60Hz vsync, and 120 would report jank belonging to SwiftShader rather than to
    the app under test.

    **The ABI preflight stays** and its justification changed. It was introduced as the counterweight
    that made claiming a Samsung name defensible. The name is gone; the x86_64 wall is not, because
    it was never caused by the name. See issue 34, still open.

---

## Next session — pick up here

Written 2026-08-29, cold-start first. Everything below is verified unless it says otherwise.

### Where things stand

The product direction changed: `MFARM_PRODUCT_DIRECTION_AND_DEVELOPMENT_RESET.md` (repo root)
replaced the imitate-a-Samsung direction with an MFARM-owned one, and **ADR-0017 supersedes
ADR-0016**. The devices are `MFARM X1 Pro` (384dp) and `MFARM X1` (360dp). Nothing pretends to be a
handset somebody else makes.

Four PRs shipped that day, all deployed and hardware-verified: **#43** (the cockpit crash), **#44**
(the MFARM identity), **#45** (runbook), **#46** (the new console). Control plane and worker both on
`1920d2f`. 995 tests green.

### Bring the farm back

```bash
./deploy/farm-online.sh     # starts both machines, re-points the media relay
./deploy/farm-check.sh      # waits for the devices, reports what is actually live
```

`mfarm-cp` is already running, so in practice this is starting `mfarm-lab`. Budget ~3 minutes: the
four devices restart sequentially at ~30s each.

### Do these first, in this order

1. ~~**PUSH THE DEMO APK THROUGH AN INSTALL.**~~ **DONE 2026-08-31 — issue 39.** A real 272 MB
   customer build (`com.alaanpay.spender.staging`) went upload → install → launch → interact with no
   special handling, at `primaryCpuAbi=x86_64` and no native-load failures. **The demo is not
   blocked.** Note what this did and did not prove: the APK is a fat APK carrying x86_64, so issue
   34 was SIDESTEPPED, not fixed — an arm64-only build would still fail. Do not re-run this to
   "check arm64"; it does not test that.

2. **PORT THE LIVE VIEW INTO THE NEW CONSOLE — now the top item.** `/app` currently renders real
   devices at real geometry with an honest empty screen. The next slice is the WebRTC path;
   `apps/api/public/live.js` is the working implementation to port, and it is the one part of the old
   console that holds a socket and a peer connection open rather than being a render function.

   Everything the session screen needs is proven on the old console: 50 fps, 42 ms round trip, a real
   customer app installing, launching and taking accurate taps. This is a port, not a discovery.

3. **Instrument latency in the product.** There is still no number for input-to-photon or for
   capture+encode on the host, and §13 and §24 of the direction document both ask for them. The
   receive path IS measured (below) and is not where the remaining latency lives.

### Numbers measured 2026-08-29, so nobody re-derives them

| | |
|---|---|
| Live stream | 50 fps, 1080×2340, VP8 |
| Network RTT | 30–35 ms, direct (srflx), no TURN relay |
| Jitter buffer | **18.7 ms** |
| Decode | 6.3 ms per frame |
| Frames dropped / lost / freezes | 0 / 0 / 0 |
| Reset (powerwash) | ~40 s, down from ~100 s |
| Data-plane socket open | 124 ms |
| Host | 16 vCPU, 62 GB, 106 GB free, load 0.52 with 4 devices idle |

**`playoutDelayHint` is NOT the lever it looks like.** The expectation was a 100–200ms jitter
buffer; it measured 18.7ms, so that change is worth ~10ms and not the 150 it was budgeted at.

### Traps that cost time on 2026-08-29

- **`systemctl stop mfarm-worker` takes every Cuttlefish instance down with it.** The worker owns
  the device lifecycle. Reset through the product (*Release & reset*), never by stopping the worker
  to reach `cvd`. Full note in `docs/RUNBOOK.md`.
- **`cvd` must run as the user that owns the host config**, and `cvd fleet` on 1.55.1 frequently
  dies in its own gflags XML parser. Neither means the fleet is unhealthy.
- **Navigating to the same `#/hash` URL does not reload the console.** A stale DOM looked exactly
  like a state bug for several minutes. Use a real reload.
- **The devices cannot be pinned by the allocator.** To reset a specific one, allocate every device
  and release them all.
- **The test suite needs Postgres on 5433, not 5432.** `apps/api/docker-compose.yml` maps
  `5433:5432` deliberately, to dodge whatever is on the default port. If it is not running, roughly
  a dozen tests in `account.test.ts` fail with RLS and password assertions that look like a real
  regression and are not — the underlying error is `ECONNREFUSED ::1:5433`, several screens down in
  the output. `npm run db:up --workspace apps/api` then `npm run migrate --workspace apps/api`.
  A container on 5432 belonging to some other project is a red herring; check the PORT, not the
  presence of a Postgres.

### The rule that keeps being paid for

> An assertion that holds on the fallback path cannot detect that you are on the fallback path.

Three separate bugs on 2026-08-29 shared this shape. When a feature has a graceful fallback, at
least one assertion must be **false** in the fallback — otherwise the test passes hardest exactly
when the feature is broken. See issues 37 and 38.

### Still open

- **Issue 34** — arm64 advertised with no translation layer. Item 1 above.
- **Issue 33** — `AppStore.put` leaves a `.part` file on an oversized upload. Pre-existing.
- **Touch accuracy has no test coverage.** Coordinate scaling uses `getBoundingClientRect`, which
  the DOM shim returns as zeroes. It is a P0 requirement in the direction document.
- **A crashed client holds its device for the full 30-minute lease** — reproduced on hardware
  2026-09-01 by `deploy/verify-failure.mjs --only=abandon`, and the cause is now named:
  `webdriver_sessions.last_command_at` is written on EVERY proxied command and migration 006
  builds `webdriver_sessions_idle_idx` over it, but **nothing in the codebase reads either**.
  The signal for an idle sweep is already being recorded, and paid for on every command, for a
  query that was never written. Fix is a sweep in `reap()` using the index that already exists.
  Originally filed as having no recovery path because
  the UI is the thing that crashed. Direction document §14.
- **`recording` is a capability string nothing implements.** The largest genuinely-new build in the
  direction document, and §27 means the button cannot exist until the recorder does.
- **Exploratory testing pays better than building right now.** One hour of using the console as a
  user found five real defects (issue 42) — more than the preceding week of building it. Do a pass
  before starting the next feature, and force `document.hidden = false` first (issue 41).
- **GPU is deferred by decision**, not blocked by engineering. It is a GCP billing-tier conversion.
  Cost of deferring: continuously-painting apps stay at 30fps with ~1.35s frozen frames.

39. **THE ARM64 QUESTION IS ANSWERED FOR A REAL APP, AND ISSUE 34 IS SIDESTEPPED RATHER THAN
    FIXED.** 2026-08-31.

    A real 272 MB customer build — `com.alaanpay.spender.staging`, the Alaan expense app — went
    upload → install → launch → interact on `cf-1` with no special handling:

    | | |
    |---|---|
    | upload | HTTP 201 in 24.7s (11 MB/s) |
    | install | succeeded in 7s |
    | launch | succeeded |
    | on screen | the app's real login screen, interactive |
    | crashes / ANRs | none |

    **WHY IT WORKED, and the distinction that matters.** The APK is a FAT APK: it ships
    `arm64-v8a`, `armeabi-v7a` AND `x86_64`, 15 native libraries each. The platform chose
    `primaryCpuAbi=x86_64`, ART compiled to `oat/x86_64/base.odex`, and Firebase Crashlytics — a
    real native SDK — initialised without an `UnsatisfiedLinkError`.

    **So issue 34 is NOT closed. It was never reached.** The farm still advertises `arm64-v8a` with
    no translation layer behind it, and an arm64-ONLY APK would still install and then die at
    `System.loadLibrary`. What this proves is narrower and more useful than "arm64 works": a
    normally-built Android release carries x86_64 and runs here natively. Most production builds do.
    The ones that do not are the ones the preflight in `apk.ts` exists to refuse by name.

    Do not let a future reader conclude from this entry that arm64 execution was demonstrated. It
    was not. It was avoided, correctly.

40. **`replaceChildren` STRINGIFIES `null`; `add()` SKIPS IT — AND THE SHIM SIDED WITH `add()`.**
    2026-08-31.

    Every session on an unprofiled device (`cf-1`, `cf-2`, any physical handset) drew the literal
    word **`null`** under the device toolbar. `paintToolbar` ends with

    ```js
    hasChrome(device) ? toolBtn('phone', …) : null
    ```

    passed straight into `st.toolbar.replaceChildren(...)`. `add()` filters null; `replaceChildren`
    is a NATIVE method that converts every argument with `String()`, so the conditional child became
    a text node reading `null`.

    **The same shape as issue 37, twice over.** First, a helper that handles the edge case is
    bypassed at one call site — and `paintOverlay` at `console.js:2130` ALREADY carried
    `.filter(Boolean)`, which means somebody hit this before and fixed only the site in front of
    them. Second, `dom-shim.ts` skipped null in `append()` — copying `add()`'s behaviour rather than
    the DOM's — so the suite could not see a null that a browser renders.

    **A shim that is kinder than the platform does not fail safe; it fails silent.** That is now
    two production defects from the same cause: the indexed-style crash in issue 37, and this. The
    shim now stringifies the way the DOM does, and a new test asserts NO screen renders the words
    `null` or `undefined` — across every screen, not just the toolbar, because the next one will be
    somewhere else.

    Found by looking at a real session, not by a test. That is the third time in three sessions.

41. **TWO SCREENS DISAGREED ABOUT ONE DEVICE — AND ONE "DEFECT" I REPORTED WAS MY OWN TEST RIG.**
    2026-08-31, from an exploratory pass.

    **THE REAL ONE.** The Launch picker counted `READY` as free and lumped EVERYTHING ELSE under
    `N busy`. So a QUARANTINED handset — one that failed health checks and is never scheduled —
    displayed as `1 busy`, inviting a tester to wait for a device that was never coming. The Health
    screen, reading the same API, correctly said `Quarantined`. Two screens, same data, different
    stories.

    Fixed by counting what RESOLVES ON ITS OWN (`RESERVED`, `SESSION_ACTIVE`, `CLEANING`, `BOOTING`)
    separately from what needs somebody to intervene (`QUARANTINED`, `OFFLINE`, `EVICTED`). The
    latter now reads `N unavailable`, and the launch caption says "a session would wait forever"
    instead of "you will be queued".

    Worth a test because **the failure is a WORD, not an error**: everything renders, nothing
    throws, and the screen is confidently wrong.

    **THE ONE THAT WAS NOT REAL, recorded because the mistake is instructive.** In the same pass I
    reported that the session badge reads `Allocating` while the API says `ACTIVE` — permanently,
    beside a `LIVE · 50 fps` pill. I measured it for 27 seconds and it never corrected.

    It was my automation. `startPoll` opens with `if (document.hidden || !state.me) return;`, and a
    Chrome window driven by CDP reports `document.hidden === true` even while `hasFocus()` is true
    and screenshots render fine. So the poll never ran and NOTHING on the page refreshed. Proved by
    redefining `document.hidden` to false: the badge corrected to `Active` within four seconds and
    stayed correct.

    **THE LESSON, which is not "be careful".** A headless browser is not a user, and the difference
    is not only timing — it changes the VISIBILITY API, which real code branches on. Anything
    measured through automation that depends on a poll, a timer, `requestAnimationFrame`, or
    `IntersectionObserver` is suspect until it has been checked with visibility forced on. The same
    rig also broke an input-latency probe earlier in the week for the same underlying reason
    (rAF throttling), and I did not connect the two at the time.

    Before reporting a UI defect found by automation, force visibility and re-measure. Two of the
    findings in that exploratory pass survived that check; one did not.

42. **FIVE DEFECTS FROM ONE EXPLORATORY PASS, AND THE THREE THAT SHARE A CAUSE.** 2026-08-31.

    An hour of using the console as a user found more than the previous week of building it. All
    five are fixed; what is worth carrying forward is that three of them are the same mistake.

    **a. Apps had no names.** Every build showed as `com.alaanpay.spender.staging`. `android:label`
    in a normally-built app is `@string/app_name`, a TYPE_REFERENCE into `resources.arsc`, and the
    parser answered null for references with sound reasoning — rendering `@0x7f130023` helps nobody.
    The reasoning was right; the CONSEQUENCE went unexamined. Almost nothing hardcodes its own name,
    so the null branch was not an edge case, it was every real app.

    **b. Rotate never worked.** `/vendor/bin/cuttlefish_sensor_injection` ABORTS on this image —
    the sensors HAL does not implement `DATA_INJECTION` and the tool answers that with a CHECK. Now
    `wm user-rotation lock`. Note the fix does NOT force `fixed-to-user-rotation`: the launcher is
    portrait-locked and a real phone would not turn either, so rotate reads the rotation back and
    explains whose decision it was rather than showing a layout the app never ships.

    **c. A failed command tore down a working stream.** `case 'error'` failed the whole live view on
    every error frame, justified by a comment claiming the worker closes the socket after each one.
    It does not: `device_error` and `input_overrun` both keep it open. Worse than it looks —
    `input_overrun` fires when a device is BUSY, so the harder somebody used the farm the more
    likely it was to drop their video. Fixed by letting the SOCKET decide rather than enumerating
    fatal codes, which is a list that goes stale the moment the worker adds one.

    **d. Two screens disagreed about one device.** The Launch picker called a QUARANTINED handset
    `1 busy` while Health, on the same API, said `Quarantined`. "Busy" tells a tester to wait for
    something that is never coming.

    **e. Raw logcat.** 37% of one real session's lines were a single system service retrying. §17
    says do not dump raw logcat; it was dumping raw logcat.

    ---

    **THE SHARED CAUSE, in (a), (c) and the `SUCCEEDED` fixture below: A COMMENT THAT WAS TRUE WHEN
    WRITTEN AND STOPPED BEING TRUE, WITH NOTHING CHECKING IT.**

    Each of those three has a well-argued comment above it explaining why the code is right. Each
    argument is internally sound. Each describes a world that no longer exists — the parser's "a
    reference is unresolvable" (it is resolvable, with the resource table beside it), the socket's
    "refusals are terminal by construction" (two paths are not). **A confident comment is not
    evidence, and this codebase's comments are good enough to be believed without checking.** When
    one states a fact about ANOTHER component's behaviour, that fact needs a test, or it is a
    rumour with good grammar.

    **A FIXTURE DESCRIBING AN IMPOSSIBLE STATE, found while fixing (e).** The shared console seed
    used `state: 'SUCCEEDED'` for app actions. That value has never been emitted — migration 015
    renamed `INSTALLED` to `DONE`, and the enum is PENDING/DONE/FAILED. So `installedOn()` found
    nothing in every test using that seed, and every assertion about an installed build passed
    against an empty answer. Third occurrence of this shape after `state.sessionDetail` (issue 37):
    **a fixture keyed on something the product does not have is not a weak test, it is a test of
    nothing that reports success.**

    **AND ONE I GOT WRONG.** See issue 41: I reported the session badge as permanently stale. It was
    the automation — CDP-driven Chrome reports `document.hidden === true`, and the console's poll
    returns early on exactly that. Forcing visibility, it corrects in four seconds. Two findings from
    the pass survived that re-check; one did not.

43. **FAILURE INJECTION FOUND WHAT 1022 GREEN TESTS COULD NOT — AND THREE OF THE FOUR MISTAKES WERE
    IN THE CHECKS, NOT THE PRODUCT.** 2026-09-01.

    `deploy/verify-failure.mjs`. Two scenarios built (`abandon`, `appium`), one designed and not yet
    run (`cprestart`). The product findings are in the dated entry at the top of this file. What is
    recorded here is how nearly each one was reported wrong, because the pattern repeated four times
    in a single afternoon and it is the same pattern each time: **an assertion that cannot come out
    both ways.**

    - **`pkill -f appium` kills its own SSH session.** The remote `bash -c` cmdline contains the
      pattern, so pkill matches itself. It surfaces as `ssh exited with return code [255]` and reads
      exactly like a connectivity fault — gcloud even suggests `--troubleshoot`. Use `[a]ppium`, and
      bracket EVERY occurrence in the command, including one in an unrelated `grep` at the end of
      the same script. That second literal cost a second run.

    - **`grep -c` exits 1 when the count is zero,** so `execFile` rejects in exactly the case the
      scenario exists to detect — appium successfully killed. Reported "the injection did not take"
      on runs where the injection had worked perfectly. `|| true` is load-bearing.

    - **Killing Appium once proves nothing.** The supervisor has all four servers back in ~8s and
      the heartbeat is 10s, so the outage closes inside one reporting interval and a poller sees an
      unbroken farm. This produced a confident "ADR-0003 is violated" against a farm behaving
      correctly. An injection must outlast the OBSERVATION interval, not merely happen. The real
      finding was only reachable by holding Appium down across several beats and then asserting on
      the CONSEQUENCE — asking for a session — rather than on the capability.

    - **"Farm recovered" passed in 0.125s** because killing Appium never takes a device out of the
      pool: `available` stayed non-zero throughout, so the check was already true before recovery
      began. Recovery has to be measured on the thing the injection broke. Corrected, it measures
      **109.6s**.

    The rule this repo already had — *an assertion that holds on the fallback path cannot detect
    that you are on the fallback path* — generalises: **an injection test is only as good as its
    ability to fail.** Write the negative assertion first and prove it goes red before trusting the
    green.

    One scenario also **took the farm down for ~2 minutes** (`available: 0`), which is why `appium`
    is classified disruptive and is not in the default set. That is correct behaviour under test,
    not a defect, but it is not something to run against a farm somebody is using.

