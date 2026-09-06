# MFARM_CLOUD — state of play

Last updated **2026-09-06**, at `303585f` / migration 038 / ADR-0027.

**New here? There are three documents and this is not one of them.**
[`docs/STATUS.md`](docs/STATUS.md) — what the product is, what works, what is pending, what it costs.
[`docs/DEFECTS.md`](docs/DEFECTS.md) — everything wrong with it.
[`docs/DIRECTION.md`](docs/DIRECTION.md) — what changed and why.
For the hands-on path, `docs/START_HERE.md` goes from a closed laptop to a device you can tap.

**READ THE NUMBERED LOG, NOT THIS HEADER, WHEN THE TWO DISAGREE.** The entries at the bottom are
dated and have held up under two audits; the summary sections at the top are written in the present
tense and decay — seventeen stale claims were found here on 2026-09-02 and the note on that is kept
below because the pattern recurs. A dated entry cannot rot; a present-tense one does.

**Two machines (ADR-0006): `mfarm-cp` holds the control plane and console at
https://farm.mfarm.dev; `mfarm-lab` holds the devices.**

**As of 2026-09-06 `mfarm-lab` is STOPPED and `mfarm-cp` is RUNNING**, which is the normal resting
state rather than something half-finished: the lab is the ~₹65/hour half and the control plane is a
few rupees an hour, so keeping the second up means the console, the API and every link into them
still resolve. `./deploy/farm-online.sh` starts both and re-points the media relay;
`./deploy/farm-check.sh` waits for the devices and reports what is live. **`./deploy/check-deployed.sh`
answers the question that must come first — is this farm running `main`** — for the serving image and
both checkouts, because an hour spent verifying against a farm running something else is an hour
spent measuring nothing.

**Where things stand, 2026-09-06.** The console has been used hard and its register is empty:
twenty-five defects recorded, twenty-five closed, and **not one of them was found by the 1441-test
suite** — every single one came from clicking through a real farm. The fleet is four Cuttlefish
devices plus one physical handset that is quarantined behind a machine which stopped beating on
2026-08-29; `npx @mfarm/agent` on that machine is the whole fix and it is not something this repo
can do. The largest open gap is that **deploy is manual** (D18): a released commit reaches the farm
when somebody runs `mfarm-deploy.sh`, and that is now reported rather than silent — which is not the
same as closed. Priorities in `docs/INDEX.md` §11.

**Read `## Next session — pick up here` at the very bottom of this file first.** It is the only
section written for someone arriving cold.

**2026-09-04 — A QUARANTINED HANDSET NOW HAS A WAY BACK, AND IT IS GATED (ADR-0024). DEPLOYED AND
HARDWARE-VERIFIED** on `1782257`, migrations through 035, PR #81.** Migrations
034 and 035. `QUARANTINED` had been a state devices could enter and, at the device level, never
deliberately leave: nothing recorded WHY one was quarantined, there was no way to quarantine a
single handset, and §30's `[Recover Device]` had nowhere to land. The one-line version of that
button — `UPDATE devices SET state = 'READY'` — puts a broken phone back in the pool on an
operator's optimism, so releasing a quarantine now moves the device to a new `PREPARING` state and
**only a completed reset plus a passing health check, reported by the host that owns it, reaches
`READY`.** A failure returns it to `QUARANTINED` carrying the NEW reason. Everything is in
`device_quarantine_log`: who released it, when, what it was recovering from, and what the health
check said. Details in issue 44.

**2026-09-02 — THIS FILE WAS AUDITED FOR STALE CLAIMS, AND SEVENTEEN WERE FOUND.** Not typos: claims
that were true when written, were fixed later, and were never unwritten — so the top of the file
contradicted the bottom. Three of them ("nothing reads `last_command_at`", the `.part` leak, the
`recording` capability) had a numbered entry recording the fix **elsewhere in this same document**.
The record-holder said the hub had never spoken to a real Appium; that had been false for two weeks.
The counts said 652 tests at migration 022; it is 1100 at 033.

**The pattern, so it can be caught earlier next time:** this file appends a numbered entry when
something is fixed, but the summary sections at the top — *What is built*, *What is NOT built*,
*BLOCKERS*, *Known issues* — are written in the present tense and nothing forces a re-read. **A
present-tense claim decays; a dated entry does not.** When you close something, grep this file for
the sentence you are making false. Every correction below is dated and says what it replaced, rather
than being silently overwritten, so the decay itself stays visible.

**2026-09-01 — two checks that lied, and a flake that turned CI red.** All three were the same
shape: an answer that depends on when you happened to look.

- **`verify-live.sh`'s tunnel count** — sampled once, asserted on minutes later. Fixed and verified
  on a cold start; details below where it used to be listed as open.
- **The hub recorded nothing for a bound-path allocation.** `mfarm run` allocates the session and
  hands the hub its id, so the device was claimed minutes before the hub saw it, and stamping it
  `now()` would date somebody else's allocation wrong. That reasoning stands — but the objection was
  only ever about the TIME, and `sessions.created_at` was in the row being read anyway. It is now
  recorded honestly, `detail.allocatedBy` says `hub` or `client`, and a `mfarm run` timeline no
  longer mysteriously begins at `session-active`. **A bound run can show `device-allocated` BEFORE
  `run-created`** — which looks odd and is exactly what happened.
- **`lifecycle.test.ts` flaked in CI**, and the flake was in the assertion. "Nothing carries on after
  the pools are gone" inserted its expired session BEFORE the shutdown — it had to, since
  `insertExpiredSession()` uses the pool the close ends — while the reaper still ticked every 100ms
  through the drain. A tick in that window ended the row legitimately and failed a perfectly good
  shutdown (`'ENDED' !== 'ACTIVE'`). The row is now created AFTER the close through the independent
  `verifier` pool, so it cannot have been reaped by the drain. **The first fix written for it
  compared the state against itself, which passes vacuously in exactly the case the race produces** —
  the same trap as everything else in issue 43.

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

**`farm-check.sh`'s false-negative tunnel line is FIXED and verified on hardware (2026-09-01).**
`$TUNNELS` was sampled once, up with the control-plane checks, and asserted on after a fleet wait
that can run for minutes — so on a cold start it was always a snapshot from before the agent
existed. It now re-reads with a short wait of its own (`TUNNEL_WAIT_SECONDS`, default 60), gated on
there being devices so the common control-plane-only run does not gain a minute. Verified on a cold
start: `✓ 1 agent tunnel(s) connected` and **`Farm is live.`** on the FIRST run, where the two
previous starts that day both needed a re-run. `deploy/verify-live.test.mjs` pins all three cases,
including the one that matters — a tunnel that never arrives must still fail.

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

**`farm-check.sh` reported "no agent tunnel connected" as a false negative** when run straight after
a host start. FIXED the same day and verified on a cold start — see the 2026-09-01 entry above.

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

**The hardware is no longer the blocker — the spikes simply never ran.** Updated 2026-09-02; the
paragraph this replaces still said "blocked on hardware… $20–50 on hourly bare metal (Vultr,
Latitude.sh, Equinix Metal)", which has been wrong since the lab box existed. `mfarm-lab` is an
`n2-standard-16` on GCP with nested virt, it runs Cuttlefish, and it has been running real devices
since 2026-08-18. Nothing needs renting.

**What actually happened is that the numbers got answered by a different route, and one still is
not.** `spikes/` has no results directory and `spike1_latency.sh` / `spike2_android_density.sh` have
never been run. Instead:

* **Interactive density and the $/device-hour floor** — answered in practice by running the farm.
  `docs/RENDER_BASELINE.md` measures the real workload on the real box (2026-08-23, cvd 1.55.1).
* **Glass-to-glass p50 is STILL MISSING**, and it is the one that decides whether "sub-100ms" is a
  real claim. The receive half is measured — 50 fps, 30–35 ms RTT, direct (srflx) — but nothing
  measures input-to-photon. That is item 3 of "Do these first" at the bottom of this file, and a
  phone shooting 240fps slo-mo is still the cheapest way to get it.

So read this table as **one open number, not three**, and do not re-provision hardware to close it.

`spikes/bootstrap_cuttlefish.sh` is still the fresh-Ubuntu path and still carries the pinned build id
(see known issue 10) — but the lab box is already past that step.

**Do not let more control-plane work accumulate against an unverified latency assumption.** The
failure mode that kills projects like this is shipping six weeks of code and then discovering the
premise was wrong, at which point sunk cost argues against changing course.

Everything added on 2026-08-16 was deliberately chosen to be **gate-independent** — none of it
validates the premise, and none of it is wasted if the premise changes.

## What is built and verified

**1100 tests pass, 0 fail** (2026-09-02, at migration 033), against a real PostgreSQL 16. No mocks
for anything that matters.

```
apps/api/         control plane, app library, console,  651 tests
                  entrypoint, metrics
apps/cli/         mfarm CLI                              63 tests
workers/agent/    worker agent, Appium supervisor,      345 tests
                  automation gateway, Cuttlefish backend,
                  physical devices, tunnel
deploy/           deploy scripts and their checks         41 tests
apps/api/public/  the web console (served by the API at /)
apps/console/     the React console at /app — NO TESTS, no `test` script at all
apps/api/migrations/  033 of them; 033 is the newest
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

20 rules, `promtool`-checked. **Alertmanager ships with no receiver**, so alerts reach its UI and no
human until someone configures one and tests it by stopping the API for three minutes.

### WebDriver hub — `apps/api/src/http/routes/webdriver.ts`

The adoption path (v2 decision 10). An existing Appium suite migrates by changing one URL —
`https://mfk_key@farm.mfarm.dev/wd/hub` — and adding `mfarm:region`. W3C and legacy JSONWP dialects
both work, served at `/wd/hub` and at `/` because clients disagree about the base path. Credentials
travel as HTTP Basic (tenant keys only) since a URL is the only thing a WebDriver client is given.

**That URL used to read `hub.mfarm.dev`, which DOES NOT RESOLVE — corrected 2026-09-02.** It is the
illustrative SaaS hostname and is spelled that way deliberately in ADR-0002, `apps/api/README.md`
and `src/auth.ts`, which is fine for those. It was not fine *here*, in the state-of-play document,
where it read as the address of a farm that exists — anyone following it got a DNS failure. This
deployment serves everything from one origin (ADR-0007 as amended, `test/single-origin.test.ts`),
and `farm.mfarm.dev/wd/hub/status` was verified answering 200.

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
the WebSocket data plane the browser connects to. **Three** device backends, not two: Cuttlefish
(target, Linux+KVM), AVD (fallback, runs on macOS, cannot meet the latency target and says so), and
**physical handsets** (`devices/physical.ts`, ADR-0008) — added after this line was written and
missing from it until 2026-09-02. `devices/discovery.ts` picks between them.

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

The worker half of the automation transport. Appium stays on `127.0.0.1`; this is the only thing
that can reach it. Every request must carry an Ed25519 grant from the hub, verified offline, and the
checks run in a fixed order with no path to the proxy that skips one: signature → audience is this
host → `claims.did` matches the device named in the path → fence is not stale.

**This used to read "the one internet-facing listener whose correctness is a security boundary",
and ADR-0011 made that conditional — corrected 2026-09-02.** On a **tunnelled** host the gateway is
NOT internet-facing at all: automation rides the socket the agent already dialled out, and the agent
replays each request against its own gateway on loopback, so the four checks above still run in full
but nothing outside the box can reach the listener. `automationIsTunnelled()` decides, and it is read in
two places that must not disagree — what gets advertised and which interface is bound — because a
host advertising `mfarm+tunnel:` while binding `0.0.0.0` publishes the private answer and exposes
the public one.

The existing farm sets `PUBLIC_ENDPOINT` / `APPIUM_ADVERTISE_HOST` and stays on the direct path it
was verified on, so **for that deployment the original sentence is still true**. Know which one you
are looking at before hardening or exposing anything.

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
  filter and level chips in the cockpit. ~~NOT persisted: closing the tab loses it, because there
  is still no artifact store. Screenshots the same — on demand, downloadable, held in the tab
  only.~~ **Both persist now — corrected 2026-09-02.** Migration 019's `kind` CHECK is exactly
  `('logcat', 'screenshot')`, workers upload them per session, and 28 sessions of real production
  artifacts have been measured at 2.55 MB of logcat and 0.59 MB of screenshot each. A release is
  never blocked on an upload: a device that cannot ship its logcat is still a device to hand back.
- ~~Video recording, and artifacts generally (an `artifacts` table, retention, a blob route).~~
  **Artifacts are BUILT — corrected 2026-09-02.** Migration 019 adds the table, content-addressed
  blobs are served from `GET /v1/artifacts/:id/blob`, and `reap()` expires them on
  `ARTIFACT_RETENTION_HOURS` (default 14 days) in two steps, deleting rows before blobs so a crash
  between them orphans a file rather than stranding a row pointing at nothing.

  **Only VIDEO is still missing**, and deliberately — see the "Still open" entry near the bottom and
  `docs/EXECUTION_MODEL.md` §4.4 for the cost model. Issue 23 is fully closed: `logcat` and
  `screenshot` are implemented and honestly declared, and `recording` was REMOVED from the
  Cuttlefish capability list rather than left as a claim with nothing behind it.
- ~~Web UI~~ — **built 2026-08-19** (issue 20 and the v2 design): sign-in, devices, sessions, queue,
  apps, health, and since issue 28 a **Launch** flow and an interactive cockpit — live video, a
  control rail, logcat and screenshots. The code path is complete and the WebRTC half has never met
  a real cvd operator; see issue 28 for exactly what is verified and what is not.
- ~~Publishing. Every package is `"private": true`, so `npx mfarm` does not work yet and the
  Action's `npx --yes mfarm@latest` has nothing to resolve.~~ **PREPARED 2026-09-03 — ADR-0023, and
  this bullet was wrong twice over.** The Action does not run `npx --yes mfarm@latest`; it runs
  `npx --yes --package "@mfarm/cli@${MFARM_CLI_VERSION:-0.1.0}" mfarm` — scoped and pinned,
  deliberately, and `action.yml` carries the reasoning. And `npx mfarm` is not the story to unblock:
  the unscoped name is not ours, so the fix was to stop telling people to type it.

  **`@mfarm/cli@0.1.0` IS PUBLISHED — 2026-09-03, MIT, owner `rkcr007`.** Verified against the live
  registry, not the local tarball: a clean `npm install @mfarm/cli` into an empty project runs, and
  **the exact command `action.yml` executes** — `npx --yes --package "@mfarm/cli@0.1.0" mfarm` —
  resolves and reports `0.1.0`. The engine guard survived the round trip: the published build on
  Node 16.17 prints `mfarm needs Node 20.3.0 or newer` and exits 1. **The adoption path works for
  someone who is not us, which had never been true before.**

  **The unscoped `mfarm` CANNOT be published, and does not need to be.** npm refuses it: *"Package
  name too similar to existing package charm"* (`charm@1.0.2` is real). **The same 403 blocks
  everyone**, so the registry already enforces what the placeholder was going to — `packages/mfarm-name`
  was deleted rather than kept as a package that can never ship. The durable fix was always removing
  `npx mfarm` from the README, which is done. Near misses like `mfarm-cli` are still registrable by
  anyone; nothing points at them.

  **Publishing needs a 2FA code, so it is the owner's command to run, never an agent's.** The first
  attempt failed `EOTP` and a later one failed at a browser-auth step, both leaving nothing on the
  registry — so verify from the registry (`npm view @mfarm/cli version`) rather than from a
  "published" report.

  The private root package is named `mfarm-cloud` (renamed from `mfarm` while the placeholder
  workspace existed, and kept because it matches the GitHub repository).

  The other three packages stay private; nobody installs the API, the worker or the console.
- Observability gaps. **The backup-freshness half of this bullet was STALE and is corrected
  2026-09-03 — the eighteenth such claim found in this file.** There IS a backup-freshness alert,
  and there has been for some time: `mfarm_backup_age_seconds` and
  `mfarm_backup_offsite_age_seconds` are exported by `apps/api/src/metrics.ts` from a `:ro` mount of
  `BACKUP_DIR`, and `alerts.yml` carries four rules over them. **Measured on the live control plane
  on 2026-09-03: age 3620s against a 46800s threshold, offsite 13s against 3600s, 26 files
  retained.** Backups are running, verified and leaving the box.

  **What is actually missing is an EVALUATOR and a RECEIVER, and that is a much shorter list than
  this bullet used to describe.** `docker-compose.obs.yml` has never been run anywhere, so nothing
  evaluates those rules; and `alertmanager.yml` ships with no integrations, which its own header
  says plainly — alerts would group in a UI nobody looks at. So the six-week claim is still TRUE, but
  for a different reason, and the fix is deployment plus one webhook rather than building an alert.

  Still genuinely absent: **no host metrics** (a full disk takes the database and the backups down
  and nothing here says so first), and **no worker-side metrics** (cvd health, adb responsiveness
  and a wedged-but-alive Appium are invisible except through device state).
- Phase 2 is **partly** proven on hardware now. `deploy/docker-compose.prod.yml` runs on the lab box
  (api, postgres and the backup sidecar), which `deploy/farm-up.sh` brings up in one command.
  **The observability stack is no longer in this list — corrected 2026-09-03, it runs on `mfarm-cp`;
  see the dated entry above.** Still never run anywhere: `tailscale serve`, and **any alert
  delivered to an actual person** — `alertmanager.yml` still ships with no integrations, which its
  own header states plainly.

**2026-09-03 — A TEST THAT PASSES IN THE SUITE AND FAILS ALONE.** Found while verifying the CLI
packaging change, and it is NOT caused by it: `apps/api/test/attempts.test.ts` →
*"the usage endpoint reports both numbers, kept apart"* fails **3 runs out of 3 in isolation on
clean `main`** (`body.attempts.userAttempts` is 0, expected 1), while the full `apps/api` suite
passes 651/651.

So it depends on state some earlier test leaves behind, despite calling `reset()` first. It also
surfaces intermittently in a full run — two different tests failed across three full-suite runs, and
one run failed on `EADDRINUSE` instead, which is a separate port-collision flake in the same suite.

**This is the shape issue 43 keeps recording**: an assertion whose outcome depends on when you
happened to look. Nothing is known to be wrong in the PRODUCT here — the failure is a test reading
state it did not establish — but until that is confirmed rather than assumed, a green suite is not
evidence that attempt accounting works, which is the one thing this file exists to prove. To
reproduce: `cd apps/api && node --test --experimental-strip-types test/attempts.test.ts`.

**2026-09-03 — THE OBSERVABILITY STACK IS RUNNING ON `mfarm-cp` FOR THE FIRST TIME.** Prometheus,
Alertmanager and Grafana, started alongside the production stack. `docker-compose.obs.yml` had never
run anywhere; the line in "What is NOT built" saying so is now false and is corrected there.

**It works: 20 rules evaluated (`health: ok`), both scrape targets up, real data.** Measured
immediately after: `mfarm_backup_age_seconds` 960, `mfarm_backup_offsite_age_seconds` 866,
`mfarm_backup_files` 27. Prometheus reaches Alertmanager at `http://alertmanager:9093/api/v2/alerts`,
and a synthetic alert pushed at Alertmanager was accepted, grouped and routed to the `default`
receiver — so every hop except the last one is proven end to end.

**IT CAME UP BROKEN IN A WAY THAT LOOKED FINE, AND THIS IS THE PART TO REMEMBER.** The first start
had Prometheus healthy, its UI serving, all 20 rules loaded and every one of them `inactive` — while
the control-plane target was DOWN with `unable to read file /run/secrets/metrics_token: permission
denied`, and Grafana restart-looped on the same error. `farm-up.sh` chowns every secret to the API
container's uid at mode 640 (deliberately: the signing key's private half is in there and must never
be world-readable), and **the obs stack runs as different users** — Prometheus 65534, Grafana 472.
**A farm with no data is indistinguishable at a glance from a farm with no problems.** Fixed in
`farm-up.sh` and `deploy/README.md` so a fresh farm cannot reproduce it; the README's own runbook
told you to start the obs stack immediately after the chmod that breaks it.

**BOTH CALLS MADE 2026-09-03: `MfarmHostSilent` is now `warning`, and the receiver is Slack.** The
severity change is recorded in the rule itself and pinned by a test that fails if it drifts back —
raise it to `critical` again the day the farm runs continuously, and add the real fix at that point,
which is a maintenance silence created when the lab is stopped on purpose. The Slack webhook is read
from `/run/secrets/slack_webhook_url`; `farm-up.sh` creates that file empty if absent so the stack
still starts, and warns in yellow that alerts will reach nobody.

**The original reasoning, kept because it is the thing to re-read before changing the severity
back:**

**BEFORE A RECEIVER IS ADDED, DEAL WITH `MfarmHostSilent`.** Two rules are firing on the live farm
right now — `MfarmDeviceQuarantined` (the pre-existing physical SM-S918B) and `MfarmHostSilent`,
because **`mfarm-lab` is deliberately stopped between sessions**, which is the documented cost
posture. `MfarmHostSilent` is `severity: critical`, and critical repeats hourly. Attaching a webhook
today would page critically, every hour, for ever, about a state that was chosen on purpose — and
train whoever receives it to ignore the channel the backup alert depends on. **Alerting that cries
wolf is worse than no alerting**, because the second one does not give false confidence. Decide the
silence story first.

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
operator-supplied tunnel. ~~Still never tested against a real Appium.~~ **Superseded 2026-08-18 by
issue 15** — the full path ran end to end: hub → Ed25519 grant → gateway → real Appium 2 →
UiAutomator2 → adb → Android 17, in 9.0s. This sentence stayed wrong here for two weeks.

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
signed grant stays the authorisation. ~~Nothing is built yet.~~**

**BUILT AND VERIFIED ON HARDWARE the same day (issue 28); the "nothing is built yet" clause was
corrected 2026-09-02.** `deploy/setup-turn.sh` deploys the relay, `setup-ingress.sh` gained the
signalling route, and a browser has driven a real Android 17 device at ~50 fps. Measured since:
30–35 ms RTT on a **direct (srflx)** path — so coturn is the fallback it was designed to be rather
than the hot path, and the numbers below describe a decision that has already been executed.

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
2. ~~The WebDriver hub has never spoken to a real Appium server, and the Appium supervisor has never
   supervised one.~~ **Both false since 2026-08-18 (issue 15); corrected 2026-09-02.** A real
   WebDriver session drove a real Cuttlefish device through a real Appium 2 / UiAutomator2 end to
   end, and the supervisor has since restarted a real Appium under failure injection — six
   consecutive failed starts → `appium-failure` incident → systemd restart → **farm fully back in
   ~110s**, measured, not assumed.

   **The half of this that is still true, and is the live issue:** the supervisor detects **process
   death only**. A wedged-but-alive Appium answers `/status` 200 forever and stays advertised. That
   has not been fixed and no test covers it.
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

Rewritten **2026-09-06**, cold-start first. Everything below is verified unless it says otherwise.

### Where things stand

`303585f` / migration 038 / ADR-0027. **1441 tests green.** Both boxes and the serving image are on
`main` — `./deploy/check-deployed.sh` is what says so, and it is the first thing to run.

**The console's defect register is empty**: twenty-five recorded, twenty-five closed. Read that as a
statement about the list rather than about the console — every one was found by USING it, none by
the suite, and the next hour of use is what says whether it is really empty.

**The fleet is four Cuttlefish devices plus one physical `SM-S918B`, which is quarantined** behind a
machine that has not beaten since 2026-08-29. Nothing is wrong with the code path;
`npx @mfarm/agent` on that machine re-registers it. That machine is not something this repo reaches.

**The direction, unchanged:** `MFARM_PRODUCT_DIRECTION_AND_DEVELOPMENT_RESET.md` replaced the
imitate-a-Samsung direction with an MFARM-owned one, and **ADR-0017 supersedes ADR-0016**. The
devices are `MFARM X1 Pro` (384dp) and `MFARM X1` (360dp). Nothing pretends to be a handset somebody
else makes.

**What to pick up**, in order, is `docs/INDEX.md` §11. The short version: whether a four-device farm
goes in front of a second team is still the only question that matters; deploy is still manual and
is the largest operational gap; and the handset is one command away from being back in the fleet.

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

2. ~~**PORT THE LIVE VIEW INTO THE NEW CONSOLE.**~~ **DONE 2026-09-02 — ADR-0022.** `/app` now
   streams. Start a session on a device and the screen inside the chassis is the real device, with
   working taps, drags and keyboard.

   **It was not ported. It is SHARED.** `live.js` says of itself that it is the only place in the
   repo that knows Cuttlefish's signalling vocabulary, so the React console imports that exact file
   rather than reimplementing it — Vite bundles it, the old console keeps loading it unbuilt, and
   the two cannot drift apart. `live.d.ts` became a real declaration to make that possible; it used
   to type every method as `unknown` via an index signature.

   What React owns is only WHEN the connection exists, in `liveController.ts`, because effects run
   twice in development, re-run on any dependency change, and do not run when a tab closes. That is
   a leak per device opened, against `MAX_CHANNELS_PER_HOST` = 32.

   **Two things this found that were not in the plan:**

   * A refused grant reported "Disconnected." instead of the worker's actual reason. Closing the
     dying session on the retry path delivered `live.js`'s synchronous `onState('closed')` back into
     the live callback and overwrote the `failed` detail. Found by the real-socket test, invisible
     to a fake, mutation-checked.
   * `pagehide` now closes the channel. ADR-0021 pinged both ends of the AGENT tunnel and
     deliberately left browser channels unpinged; the old console got away with it because a page
     navigation tears its socket down. A single-page app has no such backstop.

   **A THIRD THING, found only by measuring on hardware:** the stage was letterboxing the video
   inside its own element, so taps were off by the crop. `stage.css` put the aspect ratio on the
   device BODY and then inset a uniform bezel — 360×640 minus 10px is 340×620, which is ratio 0.5484
   against the panel's 0.5625. Its comment claimed the opposite ("the bezel is a padding so the
   screen box inside it stays exactly the panel's aspect ratio — a border would eat into it"), and
   padding does precisely what that sentence says a border would. Fixed by moving the ratio onto the
   SCREEN; re-measured on the live stream at 349×620, ratio 0.562903 vs 0.5625.

   **The check that catches it, because no unit test can:** on a live stream, compare
   `videoWidth/videoHeight` against `offsetWidth/offsetHeight`. A delta over ~0.001 means every tap
   is wrong by the crop. `aspectRatio()` was correct throughout — the distortion is in the CSS box
   model, downstream of every number a Node test can reach.

   **Measured 2026-09-02 on `farm.mfarm.dev/app`:** 49–50 fps, 2520 kbit/s, 35 ms, direct `host`
   path, **zero console messages** across load, negotiation, streaming, taps and release. Gallery
   opened from a tap on its icon; the navigation bar went back.

   **Still on the old console:** logcat, the inspector, screenshots, the app workflow. A cutover is
   still one line in `ui.ts`'s allowlist, and it should not happen until those land.

   **Read "port" as a verb.** A 2026-09-02 brief read this line as a port *number* collision and
   asked for the console and live view to be put behind one external origin. They already are, and
   the audit that established it found a different, real bug — see item 31 below.

31. **THE LIVE VIEW WAS OFF BY DEFAULT, AND THE INGRESS DISAGREED WITH THE API.** 2026-09-02,
    ADR-0007 amended.

    `browserEndpoint()` returned null unless `DATA_PLANE_PUBLIC_BASE` named an absolute `wss://`
    origin. Two deploy scripts disagreed with that: `setup-ingress.sh` proxies `/dp/*` on the
    console's own TLS name and has since ADR-0007, while `docker-compose.prod.yml` passes the
    variable through with an **empty default**. So the ingress was routing the live view while the
    API told the browser no route existed — and on a **tunnelled** host it went further and refused
    the session outright, releasing the device. The one configuration the deploy scripts actually
    produce was the one that could not allocate.

    The fix is a same-origin relative path: `new WebSocket('/dp/<id>')` on an HTTPS page resolves to
    `wss://<this console>/dp/<id>`, which is the exact url the ingress already listens for. No
    configuration, `connect-src 'self'` unchanged, no second port. `DATA_PLANE_PUBLIC_BASE` still
    wins where set and keeps its one real use — reaching a worker **directly** on its own host and
    port, which is what a laptop running the API and a fake farm has.

    **There was never a port collision.** One external listener (Caddy :443), one origin. That was
    audited before anything was changed; `test/single-origin.test.ts` now pins it, including that
    `/dp/*` answers 426 rather than 404 and takes no credential.

32. **A RESET THAT COULD NEVER SUCCEED RETRIED FOREVER.** 2026-09-02, ADR-0019, migration 032.

    The heartbeat re-offers every `CLEANING` device on every beat — the thing that makes a missed
    reset self-healing, and an unbounded retry loop. A device whose reset always throws was offered
    again ten seconds later for the life of the process, silently out of the pool.

    Now bounded: three counted attempts, then an **ESCALATED** condition that stops the offers and
    needs an owner or admin to clear (`POST /v1/devices/:id/clear-reset-escalation`).

    **An attempt is not a heartbeat**, and that is the whole design. Counting per offer would make
    the budget a function of beat frequency — six beats a minute burns three attempts in thirty
    seconds, and a slow-but-working powerwash (40–80s measured) would escalate mid-success. An
    attempt is counted when a reset has been *outstanding too long*, on the reaper's clock.

    **Escalated is NOT quarantined**, and this is the part most likely to get "fixed" wrongly later.
    `CLEANING` already means unallocatable, which is what an escalated device must stay. Quarantining
    would also stop the resets that are the only thing which could fix it — a state the device could
    never leave.

33. **ONE USER REQUEST IS ONE USER ATTEMPT.** 2026-09-02, ADR-0020, migration 033.

    There was **no double-counting bug**: the CLI's retries are idempotency-keyed and reset recovery
    happens after the session stopped metering, so the invariant held by absence. What was missing
    was the ledger — `session_attempts`, one row per attempt, `origin` of `user` or `infra-retry`.

    The invariant is a **partial unique index**, not a convention: a second `origin = 'user'` row on
    one session is a constraint violation at the moment somebody writes the code that would cause
    it. `test/attempts.test.ts` asserts the *refusal*, because a test that only checked the counter
    would pass against an implementation that never wrote a second row for an unrelated reason.

    **Not billing.** `metering_events` and `usage()` are untouched; `device_seconds` is still what a
    tenant consumed. `GET /v1/account/usage` returns both, kept apart.

    **No `test-failure` outcome exists**, deliberately. The farm cannot see an assertion fail, so it
    may not claim one, and `record_infra_retry` raises on anything that is not an infrastructure
    failure — §34 in code, so nobody can quietly retry a failed test into a false green.

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
- ~~**Issue 33** — `AppStore.put` leaves a `.part` file on an oversized upload.~~ **CLOSED** —
  `appstore.ts` unlinks the temp file in the `catch` around the pipeline, which is the path a
  `BlobTooLargeError` takes, and again on the empty-upload and already-stored branches.
  `test/apps.test.ts` → *“an oversized stream is refused without writing it out”* asserts the `tmp`
  directory is **empty** afterwards rather than asserting the rejection alone — the rejection was
  always there; the leak was the bug. Worth keeping that assertion: this path is reachable by
  anyone holding a key, so a leak here is a disk-fill primitive.
- ~~**Touch accuracy has no test coverage.**~~ **COVERED 2026-09-02** by
  `apps/console/test/tap-mapping.test.ts`, which drives `live.js`'s real `attachInput` with a fake
  element whose geometry the test sets, so the zeroed `getBoundingClientRect` in the old DOM shim is
  no longer in the way. 18 tests: scaling up and down, truncation, the far corner, a tap before the
  first frame (sent at the origin, deliberately, rather than dropped), multi-touch, drag capture and
  inspect mode. Mutation-checked — making `scale()` consult `offsetHeight` fails 8 of them.

  **What is still uncovered:** the mapping is verified, the LAYOUT feeding it is not. The scale is
  only right while the element does not letterbox, which is why the stage draws the panel the worker
  reports (ADR-0022); nothing tests that in a real browser. Hardware verification is what covers it.
- ~~**A crashed client holds its device for the full 30-minute lease.**~~ **CLOSED 2026-09-01 by
  migration 029** (`63bed33`), and verified on hardware the same day — see *“An abandoned client no
  longer holds its device for thirty minutes”* near the top of this file for the measurement
  (device reclaimed **649.8s** after the client vanished, against the real 600s production
  default). The fix was the sweep this bullet asked for: `reap()` now calls
  `expire_idle_webdriver_sessions()` every tick, keyed on the `last_command_at` that migration 006
  had been indexing for a query nobody had written.

  Three properties to preserve if this is ever touched, all pinned by `test/allocator.test.ts`
  → *“idle WebDriver sweep”*:

  * **It runs BEFORE `promote_queued`.** Ending the session is what lets the org's concurrency cap
    fall, and the cap is what gates promotion — sweeping afterwards leaves the queue blocked for an
    extra tick.
  * **The device goes to CLEANING, never straight to READY.** This path exists for sessions that
    ended badly, which are the ones most likely to have left data behind.
  * **A session with no `webdriver_sessions` row is left alone.** `mfarm run --no-webdriver`
    produces no commands at all, so every such lease looks permanently idle and would be swept
    instantly; its lifecycle belongs to the CLI (ADR-0002 decision 4).

  `WEBDRIVER_IDLE_TIMEOUT_MS` defaults to 600s and must stay above the longest single COMMAND — not
  the gap between commands — and above the client's own `appium:newCommandTimeout`. Direction
  document §14.

  **This bullet outlived its fix and sat here contradicting the entry above it.** If an item in this
  list names the migration that would fix it, check whether that migration shipped before believing
  the item.
- **Video recording is not built** — still the largest genuinely-new build in the direction
  document, and §27 means the button cannot exist until the recorder does. **Reworded 2026-09-02:
  this used to read “`recording` is a capability string nothing implements”, which is no longer the
  defect.** The string is gone — `cuttlefish.ts` advertises `screen-stream`, `input-datachannel`,
  `app-install`, `logcat`, `screenshot`, `ui-hierarchy` and nothing else, with a comment saying it
  “comes back when `startRecording` does”. That was ADR-0003 being applied correctly: a capability
  is observed state, so an unimplemented one is removed rather than left as a claim. The gap is the
  recorder itself. `docs/EXECUTION_MODEL.md` §4.4 has it costed — record on the HOST reusing cvd's
  existing WebRTC encode, keep only sessions that reported a failure, 10–15 fps at ~500 kbps — and
  names the one thing still unmeasured: what `screenrecord` costs against the Flutter canvas
  workload. Recording everything fills `mfarm-cp`'s disk in **~1.3 days** at two devices saturated.
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

44. **A QUARANTINE A PERSON MAKES IS NOT THE FARM'S TO UNDO — AND RELEASING ONE IS NOT MARKING IT
    AVAILABLE.** 2026-09-04. ADR-0024, migrations 034 + 035.

    `AutomationExecutionPlan.md` §30 asks for a `[Recover Device]` action. The implementation that
    writes itself is one statement, and it is the whole reason this entry exists:

    ```sql
    UPDATE devices SET state = 'READY' WHERE id = $1;
    ```

    That hands a device that failed its health checks to the next tenant on the strength of somebody
    having clicked a button. **Release now means "I am authorising this device to attempt
    recovery".** It moves the device to `PREPARING`; the heartbeat starts offering it a reset again;
    the agent restores it and then probes `control.health()`; and only a passing result reaches
    `READY`. Anything else — a reset that throws, a health probe that says the handset is still
    offline, a host that never answers inside `RECOVERY_TIMEOUT_MS` — puts it back in `QUARANTINED`
    with the new failure recorded.

    **Five things worth keeping, in the order they were found:**

    - **`PREPARING` had to be a state, which is where ADR-0019 is amended rather than contradicted.**
      019 chose a *condition* over a state because `CLEANING` already meant everything an escalated
      device needed to mean, and because quarantining stops the reset offers that are the only thing
      that could fix the device. Both still hold — and neither `QUARANTINED` (not offered resets)
      nor `CLEANING` (means "a tenant's session ended") can carry a recovery. What makes a
      device-level `QUARANTINED` safe to enter *at all* is that there is now a way out of it.

    - **Registration and the withdrawal sweep would each have laundered a quarantine.** The upsert
      promotes `QUARANTINED` → `READY` for a re-registering host (correct, for the host cascade), and
      the withdrawal demotes a missing device to `OFFLINE`, from which the next good registration
      promotes it anyway. So **unplugging a quarantined phone and plugging it back in returned it to
      the pool.** Both paths now check `quarantine_source`: `host` still self-clears, `operator` and
      `health` do not. This is migration 016's rule about hosts, one level down, and it is the part
      most likely to be "fixed" wrongly later.

    - **A completed reset is not evidence a device is fit,** which is what makes an older agent
      interesting rather than merely unsupported. Such an agent performs the reset it was offered
      and confirms it through `resets`; `device_reset_complete` matches on `CLEANING` and rejects it.
      Without a branch for that, the device sat in `PREPARING` until the reaper reported "the host
      did not confirm a recovery" — untrue, and it would send somebody to look at the network. It now
      fails the recovery closed with a reason naming the agent version.

    - **The audit log needed an append order, and `occurred_at` is not one.** Two rows written in one
      transaction share it to the microsecond, so `ORDER BY (occurred_at, id)` fell back to a random
      uuid and rendered a device as released *before* it was quarantined — intermittently. Found by a
      flaking test at the end of a full-suite run, not by review. `device_quarantine_log.seq`.

    - **`mfarm_definer` cannot read `users`,** and both write paths copy the actor's email into the
      audit row so the record outlives the account. `GRANT SELECT (id, email)` — column-level, because
      `users` is the table a password hash lives beside and a blanket grant would hand every definer
      function in the schema a read of everything on that row.

    **What is deliberately NOT in this change.** §30's automatic trigger — quarantine after N
    device-health incidents — needs a threshold and a window and is its own decision; this gives that
    policy somewhere to land (`quarantine_device(..., 'health')`) when it is made. Reset escalation
    (019) is untouched: an ordinary post-session reset that exhausts its budget still stays `CLEANING`
    with the escalated condition, and only a *recovery* returns to quarantine. The two could be
    unified behind one "authorise an attempt" action later.

    25 new tests (22 control plane, 3 agent). Suite is 1206 green at migration 035.

45. **`GET /account/usage` CAN OMIT AN EVENT THAT JUST HAPPENED, AND THE TEST FOR IT FLAKES ON
    macOS.** 2026-09-04. **Found while shipping ADR-0024; NOT caused by it and NOT fixed here.**

    `attempts.test.ts` → *the usage endpoint reports both numbers, kept apart* failed once in a full
    local run with `infraRetries` 0 instead of 1, and passed on its own and in three runs before it.
    The cause is not a race in the product's own logic:

    - `session_attempts.started_at` defaults to `now()` — **the database's clock** (migration 033);
    - the route defaults its window to `to = new Date()` — **the API process's clock** — and
      `attempts.counts()` filters `started_at < to`.

    Measured on this laptop: the Postgres container's clock is **4–5 ms ahead** of the Node process.
    So a row written less than ~5 ms before the read is dated *after* the window's own upper bound
    and is filtered out. The test creates the infra-retry immediately before the GET, which is why
    that number goes missing and `userAttempts` — written at session creation, tens of ms earlier —
    does not.

    **CI is not exposed to it.** There Postgres is a service container on the same kernel as the
    Node process, so the two clocks are the same one; the skew is a Docker-Desktop-on-macOS artifact.
    That also means this will keep flaking locally and never in CI, which is the shape most likely to
    be dismissed as "just re-run it".

    The product bug is real but tiny: refresh usage in the same instant an incident lands and the
    number is briefly absent. The fix is NOT a fudge factor on the window — it is for an unsupplied
    `to` to mean *no upper bound*, or to come from the same clock the rows do. Left alone
    deliberately: it is unrelated to the change that found it, and it touches `usage()`,
    `counts()` and `deviceReliability()` together.

46. **HARDWARE VERIFICATION OF ADR-0024, INCLUDING A PATH NOBODY PLANNED TO TEST.** 2026-09-04,
    control plane and worker both on `1782257`.

    **The happy path, on a real Cuttlefish device**, from the worker's own journal:

    ```
    22:56:36  [agent] recovering cf-1 (fence 59): reset, then health check
    22:56:50  crosvm: vcpu requested reset          <- the actual snapshot restore
    22:56:51  crosvm: exiting with reset
    22:57:14  [agent] recovery of 523581b7… passed
    22:57:15  [agent] recovery for 523581b7… finished: device is READY
    ```

    39 seconds, offer to READY. The audit row carries what the device actually reported:
    `{"health":{"status":"healthy","inputLatencyMs":55.67},"probes":5,
    "automation":"http://10.160.0.2:8090/automation/cf-1","hadAutomation":true}` — so the
    automation-came-back check fired against a real Appium rather than being theory.

    **THE INTERRUPTED RECOVERY WAS VERIFIED BY ACCIDENT, AND IT IS THE MORE INTERESTING RESULT.**
    The verification ran too early: the wait loop before it polled `count(*) WHERE state='READY'`,
    which was still true of the PRE-RESTART rows, so it returned immediately while the worker was
    still bringing devices up. The host was therefore silent past 90s mid-recovery, and:

    1. `quarantine_host` collapsed the recovering device with `quarantined_from = 'PREPARING'`;
    2. the host beat again and `clear_silence_quarantine` restored it **to PREPARING**, with
       `recovery_from_reason` intact and a fresh clock — not to READY, and not lost;
    3. the agent then picked the offer up and completed the recovery normally.

    That is exactly the path migration 035's `CASE WHEN quarantined_from = 'PREPARING'` exists for,
    exercised on hardware under a real interruption rather than a backdated timestamp. **The wait
    condition was the bug**: "N devices READY" is not evidence that a restarted worker has
    re-registered, because the rows survive the restart. Assert on the host's `last_heartbeat_at`.

    **The HTTP layer, on the deployed build.** `available` 4 → 3 on quarantine; the device carries
    `quarantine: {at, reason, source}`; release returns `state: PREPARING`; and the pre-035
    `SM-S918B` correctly carries **no** quarantine object at all rather than an invented reason.

    **Metrics, scraped from the box:** `mfarm_devices{state="PREPARING",…} 0` for both tiers (the
    explicit zero, so the series exists before it is ever non-zero),
    `mfarm_device_preparing_age_seconds_max 0`, `mfarm_device_recoveries_total{outcome="recovered"} 2`.

    **What was NOT checked.** The console was verified by asserting its shipped asset contains the
    new code (`Release quarantine` in `console.js`, `Recovering from quarantine` in the React
    bundle) and by the render tests — **not by opening it in a browser on the farm**. And the
    physical `SM-S918B` was deliberately left quarantined: `resetToSnapshot` on a handset is
    `pm clear` across the owner's third-party packages, so releasing one is a decision for whoever
    owns the phone. It now HAS a way back, which it did not before.

    `mfarm-lab` was stopped afterwards.

47. **THE FIRST REAL SUITE RAN ON THE FARM, PASSED 8/8, AND FOUND TWO DEFECTS THAT FOUR MONTHS OF
    `verify-*` RUNS COULD NOT.** 2026-09-04, control plane `1782257`.

    `examples/medishop-suite` — an ordinary WebdriverIO suite, from a laptop, against
    `farm.mfarm.dev` — **8 tests, 8 passed, 59.9s**, two device leases (`cf-1`, `cf-4`), run
    `medishop-first-real-1788478376`. Everything downstream recorded it: 8 result rows with real
    per-test durations, two `install DONE` app-actions for `com.way2automation.medishop@1.0`, and
    **2 screenshots (2.0 MB) + 2 logcats (4.5 MB)** captured at release.

    **Why this was worth doing even though the path was already "hardware-verified".** Every run
    that had ever reached this farm was named `verify-*` — `deploy/verify-runs.mjs`, which drives
    the real hub, gateway, Appium and device but is OUR code asserting OUR contract. The distinct
    test names in `test_results` before today were `a pending case`, `flaky thing`,
    `checkout applies a promo`. A customer-shaped suite had never touched it, and the two defects
    below are both invisible to the synthetic driver because it never calls `driver.quit()` the way
    a suite does.

    ---------------------------------------------------------------- **1. A RUN FORGETS WHICH BUILD
    IT TESTED, AND ONLY FOR SUITES THAT BEHAVE CORRECTLY.**

    `GET /v1/runs` reported `"build": null, "buildCount": 0` for a run whose every session installed
    `com.way2automation.medishop@1.0`.

    `webdriver_sessions.app_build_id` (migration 020) is the ONLY place a run's build identity
    lives, and the rollup in `routes/runs.ts` reads it through
    `LEFT JOIN webdriver_sessions w ON w.session_id = s.id` — while `routes/webdriver.ts` runs
    `DELETE FROM webdriver_sessions WHERE session_id = $1` on `driver.quit()`. **So the row carrying
    the answer is deleted by the correct client behaviour**, and *"what failed on build 4471?"* —
    the exact question migration 020 and `EXECUTION_MODEL.md` §4.2/§4.3 exist to answer — is
    unanswerable for every suite that quits properly. It survives only for sessions that LEAKED;
    the two stale `webdriver_sessions` rows in this database are the only ones that ever reported a
    build.

    **The data is not lost, only unread.** `app_actions` keeps `session_id` + `app_id` + `DONE` for
    every install, which is how the build was recovered above. The fix is a read change.

    ---------------------------------------------------------------- **2. FOUR OF THE TIMELINE'S
    NINE EVENT KINDS ARE DECLARED AND NEVER EMITTED.**

    Migration 030's CHECK admits `run-created`, `session-queued`, `device-allocated`,
    `session-active`, `build-install-started`, `build-install-finished`, `session-ended`,
    `device-released`, `incident`. Only the first four plus `session-ended` are ever written;
    `build-install-started`, `build-install-finished`, `device-released` and `incident` exist solely
    as union members in `executionEvents.ts`.

    The timeline for this run is therefore `device-allocated → session-active → session-ended` —
    **the install, which is most of the session-open latency and the thing `mfarm:appId` exists to
    do, is invisible**, and so is any incident. This is ADR-0003's own rule inverted: a schema
    claiming a vocabulary the system does not speak.

    ---------------------------------------------------------------- **3. The example suite does not
    demonstrate run completion.**

    `POST /v1/runs/:id/complete` exists (§4.7) and `examples/medishop-suite` never calls it, so the
    run reads `"status": "incomplete"` forever. Not a defect in the product — but the example IS the
    adoption template, so the feature is effectively undiscoverable.

    ---------------------------------------------------------------- **what this cost to find**

    One suite run, sixty seconds, on a farm that was already green. **Run the customer-shaped thing,
    not only the verifier** — a driver written from the same contract as the server only proves one
    reading of that contract agrees with itself, which is the same argument `action-test.yml`
    already makes for the CLI seam and did not have for the hub.

48. **BOTH DEFECTS FROM ENTRY 47 ARE FIXED, DEPLOYED AND HARDWARE-VERIFIED.** 2026-09-04.
    Migration 036, control plane `e2304a3`, PR #82. The reason the tests missed them is the more
    useful half.

    **1. A run remembers what it tested.** `sessions.app_build_id` is the durable home for the fact;
    `webdriver_sessions.app_build_id` is kept and still written, because dropping a column the
    previous release's INSERT names would break a rollback. `routes/runs.ts` reads the session's
    column in both the rollup and the detail. Historical rows are backfilled from `app_actions` —
    the earliest successful install per session, which is what the hub queues before the session
    opens — so the runs already on the farm recover their build rather than staying blank.

    **WHY 634 GREEN TESTS COULD NOT SEE IT.** `runs.test.ts` had two tests that open a session with
    a build and read the run back. Neither of them called `quit`. The bug was *in the quit path*, so
    every assertion ran before the row was deleted and passed against an implementation that lost
    the answer a second later. The new test asserts the same fact **twice** — once before the quit,
    which is what the old ones did, and once after — and reverting 036 fails only the second.

    That generalises past this bug: **a test that never performs the teardown cannot see a defect in
    the teardown.** The same shape as issue 43's rule about assertions that cannot come out both
    ways, one step further along the lifecycle.

    **2. The timeline speaks the vocabulary its schema admits.** `build-install-started`,
    `build-install-finished`, `device-released` and `incident` are all emitted now.

    - The install carries `packageName`, `outcome` and a MEASURED `durationMs`, on the failing path
      too — an install that took 90s and then failed is a different story from one that failed at
      once, and `outcome` alone cannot tell them apart.
    - **`device-released` is deliberately not a duplicate of `session-ended`.** On the hub path they
      are one instant. On the BOUND path (`mfarm run`) `driver.quit()` ends the WebDriver session
      and releases nothing, because the caller still owns the device — so a timeline showing one
      without the other is how a reader learns their device is still held. There is a test that
      drives exactly that sequence rather than a comment asserting it.
    - `incident` inherits the insert's idempotency, pinned by a test that sends one fault three
      times and expects one event. The agent flushes its buffer on reconnect by design; thirty
      copies of one pulled cable would be worse than none.

    **STILL OPEN, and said plainly rather than left to be discovered:** the reaper's own release
    paths — `expire_sessions`, `expire_idle_webdriver_sessions`, a host quarantine — take devices
    back with no event, because they are set-based SQL returning counts rather than ids. A run
    reclaimed by the farm still ends its timeline at `session-active`. That gap predates this change
    and is not closed by it.

    Also still open from entry 47: `examples/medishop-suite` never calls
    `POST /v1/runs/:id/complete`, so every run it produces reads `"status": "incomplete"`. Not a
    product defect — but the example IS the adoption template, so §4.7 is undiscoverable from it.

49. **THE SAME SUITE, RE-RUN AGAINST THE FIX.** 2026-09-04, control plane `e2304a3`.

    `examples/medishop-suite` again: **8/8, 65.8s**, run `medishop-after-036-1788482936`.

    **The run now names what it tested**, after both sessions quit cleanly —
    `buildCount: 1, com.way2automation.medishop@1.0`, where the identical scenario reported
    `build: null, buildCount: 0` the night before.

    **The backfill recovered the history**, and was DRY-RUN against the farm's real rows before the
    migration was ever applied there — the same query, read-only, over ssh. It predicted exactly
    what it then did: every `verify-*` run and `medishop-first-real-1788478376` recovered
    `com.way2automation.medishop@1.0`, and `verify-1787507543857` stayed NULL because it never had
    a successful install. **A backfill is a write you can rehearse; rehearsing it is cheaper than
    discovering it guessed.**

    **The timeline is whole, and the install carries the number that was missing:**

    ```
    run-created
    device-allocated
    build-install-started      com.way2automation.medishop
    build-install-finished     DONE, durationMs 9588
    session-active
    session-ended              webdriver_quit
    device-released            webdriver_quit
    ... and the same seven again for the second lease (install 8578ms)
    ```

    **~9.5s of a ~10s session open is the install**, which is what "most of the session-open latency
    was invisible" meant in entry 47 — now a measured field rather than a claim. `device-released`
    sits beside `session-ended` here because this is the hub path; on the bound path it is absent
    until the CLI gives the device back, which is the whole reason the two are separate kinds.

    **A CI note worth keeping.** The tarball job's `timeout-minutes: 10` had 5-9 minute runtimes
    under it and started failing on DURATION: it took down PR #82 once and then CI on `main`,
    which skipped the Release and blocked the deploy. Re-running the single failed job cleared it.
    Measured across recent runs: 1.3m to 9.6m against a 10m wall. A commit raising it to 20 exists
    on this machine, **unpushed** — see the note in the next-session section.

    `mfarm-lab` was stopped afterwards.

50. **DESIGN STAGES 1–4, SHIPPED AND VERIFIED ON THE FARM.** 2026-09-04. Control plane `7b8f5a9`,
    migration 037, PRs #85 and #86. Two laps through the chain, because the first lap shipped a
    defect that only the live farm could show.

    The design package in `Farm_app_design_exploration/` (docs 00–08) landed stages 1–4 on the
    **vanilla console at `/`**, not the React one at `/app`. Not a preference — 01's token names ARE
    `console.css`'s, the twenty Unicode glyphs were only in `console.js`, and every copy-deck string
    lives there. The React console has no fleet/apps/runs/health screens, so stages 2 and 4 would
    have meant *building the missing screens*.

    **What is live:** `design-tokens.css` shared by both consoles; three self-hosted faces served
    ONCE at `/fonts/*` (vite was bundling a second copy into `/app/fonts/` while the old console had
    no webfonts at all); a generated Lucide sprite replacing the Unicode glyphs; `frame.js`, one
    device-frame component drawn at the cockpit, cards, picker and palette; and the copy deck.

    **THE ALLOCATOR DID NOT KEEP THE PROMISE THE COPY MADE.** The card's button became
    `Start MFARM X1 Pro`, and `allocate_device` had never matched on profile — region, platform,
    tier, capabilities, and nothing else. On a farm whose devices share a tier, that button could
    hand you an X1 or an unprofiled 720×1280 device and say nothing. The label it replaced named the
    tier and was at least ACCURATE. The design package's stated assumption, "allocation is
    class-only", was not a description of the code: allocation was TIER-only, a coarser grain.

    Migration 037 and ADR-0025 fix it. **Two parameters, not one,** because "no profile" is a class
    somebody can ask for — this farm has two unprofiled devices and the picker offers them; with a
    single nullable value that request is indistinguishable from "any device", so
    `Start Unprofiled device` would have allocated an X1 Pro. Nicer than asked for, still wrong, and
    never reported. `promote_queued` honours the same constraint, because a constraint dropped at
    promotion time holds only while you are watching.

    **THREE DEFECTS CAUGHT BEFORE THE FARM SAW THEM,** each by a different thing:

    - **CI caught a security regression the local suite could not.** Postgres grants EXECUTE to
      PUBLIC on every new function; `CREATE OR REPLACE` keeps the ACL but a DROP-then-CREATE does
      not, so migration 012's `REVOKE ... FROM PUBLIC` silently stopped applying and the explicit
      grant beside it became decorative. That assertion lived ONLY in `ci.yml`.
      `definer-acl.test.ts` is now the same checks where they fail in two seconds.
    - **Reading `mfarm-deploy.sh` before running it caught a worse one.** It migrates then restarts,
      so the old API briefly serves the new schema — calling the 8-arg signature 037 had dropped.
      And the script promises "rollback is this same command with an older sha" while migrations do
      not roll back, so a dropped signature turns any rollback into a farm that cannot allocate. The
      8-arg form survives as a forwarder.
    - **Running the console caught two more.** `stageState` tested for the LiveSession OBJECT rather
      than the state machine, so the frame's depth-as-a-state never fired; and `idle` was drawn as
      an 80% progress ring for a negotiation that had never been attempted.

    **AND THE ONE ONLY THE DEPLOYED PAGE COULD SHOW.** After the first deploy, asking production
    what it had loaded:

    ```
    ["Instrument Sans Variable loaded",
     "Bricolage Grotesque Variable unloaded",     ← shipped, wired to nothing
     "JetBrains Mono Variable loaded"]
    ```

    Stage 1 self-hosted the display face, allowlisted it, added the CSP directive and deployed it
    without a single rule referencing it. 41 KB in the image, never a glyph rendered, every heading
    falling back to Instrument Sans. **727 tests green. `verify-console.sh` green — the file serves,
    the bytes are intact woff2, the content type is right. The screenshot looked correct**, because
    a working fallback is what a fallback is for. PR #86 puts the face on the six selectors that
    already carry headings.

    The guard is two tests, and **the obvious one is false comfort**: "every family is referenced by
    a rule" passes on the unused `.t-display-*` classes, which is exactly the bug. Only the second —
    the display selectors appear in markup the console renders — goes red when reverted.

    **VERIFIED ON THE FARM, not in tests:** `verify-console.sh` 18/18 (it was 10/1 before the
    deploy, failing on "no stylesheet names any asset" — a check that had to flip rather than one
    already green); `verify-allocation.mjs` 4/4 against real devices — asked for `mfarm-x1` and got
    MFARM X1, asked for the unprofiled class and got a device with no profile, and the unconstrained
    call returned the X1 Pro, which is incidental proof the ordering was not handing back the X1 by
    luck; `farm-check.sh` green end to end; and `document.fonts` on production now reporting all
    three faces `loaded` with `.headline` computing to Bricolage Grotesque.

    **A BELIEF THAT TURNED OUT WRONG, recorded so it is not repeated.** The suite's order-dependent
    failures DO fire in CI, despite CI getting a fresh Postgres — PR #86 went red on
    `apps.test.ts`'s blob-store test, whose entire diff was a stylesheet and a test file, alongside
    an `EADDRINUSE`. I had reasoned that a clean database was the condition under which they pass.
    A red X here needs two questions — can my diff reach that code, and does the file pass alone —
    before `gh run rerun --failed`.

    **Still open:** stage 5 removes two rail controls entirely when a capability is absent, where 04
    and `RailControl` both require them visible and struck through. Stages 6 and 8 unbuilt; stage 7
    has its decision (direction B) and needs `user_id` and `expires_at` on the sessions payload.

    `mfarm-lab` was stopped afterwards.

51. **THE FLEET SURFACE — STAGE 7, SHIPPED AND VERIFIED.** 2026-09-04. Control plane `30f371b`,
    PR #87. The change that actually makes the console look like the design.

    **WHY IT WAS NEEDED, and it is a correction to entry 50 rather than a continuation.** Rakesh
    looked at the deployed fleet and said it did not match the design. He was right, and the reason
    matters: stages 1–4 are a SYSTEM layer — tokens, icons, one frame component, the words — applied
    to the layouts that were already there. None of them moves an element. I described them
    accurately and never said "the screens will look structurally the same", which is the sentence
    that was missing.

    **A HOLE IN THE PACKAGE'S OWN BUILD ORDER, found while answering him.** Document 05 — sign-in,
    catalogue, device detail, apps, runs, health, organisation — has NO STAGE. The eight stages in
    07 cover only "catalogue", buried inside stage 7. I had taken 07's build order as the complete
    scope and had not opened 05 at all until that moment. Read all eight documents before
    sequencing, not the five the build order points at.

    **WHAT SHIPPED.** Devices, Sessions and Queue answered one question between them — can I get a
    device right now, and if not, why not — with the free count on one page, the wait on another,
    and who was holding what on a third. One `Fleet` route now, four lenses: Capacity, Catalogue,
    Live, Waiting. One data source, one poll.

    `#/devices`, `#/sessions` and `#/queue` each resolve onto the lens that used to be that page,
    and `G D` / `G R` / `G Q` still work because they go through the same resolver. `parseHash` is
    exported and takes its input so the redirect table is testable — a promise nothing can test is a
    promise somebody tidies away. Live and Waiting SPLIT the existing screens rather than
    reimplementing them.

    `GET /v1/sessions` gained `expiresAt` and `holder`. "In use" tells somebody to go away; "in use
    by priya, 12 minutes left" tells them whether to wait.

    **THREE THINGS THE SCREENSHOT CAUGHT AFTER THE TESTS WERE GREEN:** the device frame in a table
    row is a fourteen-pixel sliver that reads as a smudge (it earns its place on a card at 108px,
    where the chassis and punch-hole are visible, and not at a row's height); the HOLDER column said
    "Allocatable now", restating the pill one column to its left; and the capacity lens had a rail
    whose queue card repeated the headline verbatim.

    **AND ONE CORRECTNESS BUG.** A class with every device QUARANTINED offered "Join the queue". The
    allocator only promotes onto a READY device, so that queue is never served — the button buys a
    session that waits forever and looks entirely reasonable doing it. The launch picker has drawn
    this busy-versus-unavailable distinction for months; the new surface missed it because the DATA
    was carried across and the REASONING was not. Verified fixed on the live farm: the quarantined
    class renders one button, "Full specification", and says why there is no queue.

    A test also caught the catalogue's prose claiming the Pro had "live view, UI inspection and
    screenshots" — capabilities the card's own intersection logic can contradict. No blurb names a
    capability now.

    **VERIFIED ON THE FARM:** `verify-console.sh` 22/22, including three new checks that the merged
    routes still resolve in the DEPLOYED source (a hash router's redirects never reach the server,
    so curl cannot observe them any other way); `verify-allocation.mjs` 4/4; `farm-check.sh` green;
    and the console read at `farm.mfarm.dev` with the real five-device fleet — the two unprofiled
    devices correctly collapsing into ONE catalogue card reading "2 of 2 free", which is the class
    abstraction from ADR-0025 doing its job on real data.

    **A PROCESS MISTAKE THAT COST A RELEASE CYCLE, and it is worth the space.** I merged #87 as
    `3a06f7e`, then pushed a `deploy/verify-console.sh` tweak straight to `main` minutes later.
    `ci.yml` sets `cancel-in-progress: true` on the ref, so that push CANCELLED `3a06f7e`'s CI run —
    and `release.yml` only builds on `conclusion == 'success'`, so the Fleet commit got a skipped
    Release and can never be deployed by its own sha. The way out was to deploy the later head,
    which contained both. Branch and PR for everything, including docs and deploy scripts; and never
    push to `main` while a merged commit is still waiting on its Release.

    **STILL OPEN.** Launch keeps its nav item, though direction B says it should not — it is the only
    place that can preinstall a build before handover, and no Fleet row offers that yet; removing it
    first would delete a capability rather than relocate one. No ETA on the headline: `expiresAt`
    exists now, but the soonest expiry is only an upper bound, since a holder can release early and
    a queued session ahead of you takes the device first. Stage 5's rail still REMOVES two controls
    when a capability is absent where 04 requires them struck through. Stages 6 and 8 unbuilt, and
    the six screens in document 05 that have no stage.

    `mfarm-lab` was stopped afterwards.

52. **STAGE 5 — A CONTROL THE DEVICE CANNOT HONOUR IS VISIBLE AND INERT.** 2026-09-04. Control
    plane `92c757e`, PRs #89 and #90.

    The session rail used to REMOVE a control when the device did not declare its capability.
    Document 04 requires the opposite: visible, struck through, and saying why. A missing button is
    indistinguishable from a button you have not found, and the person most likely to be looking for
    it is the one on the device that cannot do it.

    Two appearances now, because there are two facts and they had collapsed into one:

    | | appearance | what it says |
    |---|---|---|
    | waiting on the stream | dimmed, solid | "not available until the live view is connected" |
    | the device cannot honour it | dashed **and** struck | "does not declare `screen-stream`. That is a property of the device, not a fault." |

    **AND A REGRESSION I INTRODUCED IN THE FIX, caught before it mattered.** Zoom in, zoom out and
    fit were gated on the transport only, so on a device with no `screen-stream` they claimed "not
    available until the live view is connected" — which is *not yet* for a thing that is *not ever*.
    Found by re-reading my own verification plan against the deployed source rather than by a test:
    the assertion I had written counted the gated controls and I had written the number from memory.
    Five, not two. `verify-console.sh` now counts them in the deployed file.

    Verified live on `farm.mfarm.dev`: 22/22 console checks, and the deployed `console.js` grepped
    for all five `requires: 'screen-stream'` call sites.

53. **DEVICE DETAIL — DOCUMENT 05 §03, AND A COLD LOAD THAT NEVER FETCHED.** 2026-09-05.

    The operator's page, built to the design: a class badge and `<short id> · tier · region` under
    the title; the quarantine gate as a red card headed "Out of the pool since 2 September" naming
    who took it out and their note; the consequence list promoted ONTO the page; Screen, Reset story
    and Host last seen in Metadata; the WebDriver endpoint as its own card that says when it works.

    **THE CONSEQUENCE LIST IS THE POINT.** One arrow and three crosses — *permits one attempt* /
    *does not return it to the pool* / *does not clear the note* / *if the check fails it stays
    out*. It used to live only behind the confirm dialog, which is read by somebody who has already
    decided; the page is read by somebody deciding. Every one of the three crosses is a thing a
    person reasonably expects a "release" button to do, and none of them is true (ADR-0024). The
    button keeps `--bad-solid` in both themes and is not softened.

    **THE DEFECT THE SCREENSHOT FOUND, AND IT WAS NOT MINE.** `boot()` fetches for `cockpit`, `run`
    and `launching` on a cold load. `device` was in the `hashchange` listener and MISSING FROM
    `boot`, and `hashchange` does not fire on load — so the quarantine history said "Loading…"
    forever for anybody who opened a device link, hit refresh, or came back to a bookmark. It worked
    on exactly one path: clicking through from the Fleet, which is the path a developer always
    takes. It has been shipped that way for as long as the screen has existed.

    No test could see it. Every console test seeds `state` and renders — which is the right shape
    for "does this screen say the correct thing" and structurally blind to "does anything ever fill
    that state", because the test performs by hand the work it should be checking happened. This is
    the `app.inject()` blindspot in a different costume.

    Fixed by making the list of per-route fetches ONE function, `loadForRoute()`, called by both.
    Two copies of a list is what let one drift. It is exported so a test can assert what each route
    asks for, against a recording `fetch`.

    **TWO MORE FOUND THE SAME WAY, both only visible in a render.** The state pill was drawn twice —
    in the page head and again inside the gate — and the gate's headline read "Out of the pool since
    02/09/2026, 02:03:48", asking a reader to parse a timestamp to learn a three-day-old fact. Added
    `day()` for headline dates; dropped the second pill and kept its relative age.

    **A COPY DEFECT STAGE 5 CREATED.** The capabilities caption ended "it is why a control that needs
    it is missing" — which described the rail BEFORE stage 5, and stage 5 made those controls visible
    and struck instead of removing them. A caption about another screen is a claim about another
    screen, and it goes stale silently when that screen changes. Same species as issue 47.

    **`Host last seen`, and NOT `Host`** — ADR-0026. The design shows `Host lab-host-02`, and that
    field is deliberately unimplemented: migration 002 revokes `hosts` from the tenant pool
    entirely, and a hostname is a stable identifier that lets a tenant map the farm's topology and
    confirm, permanently, which of their devices sit beside somebody else's. A heartbeat sharpens a
    fact they already read off the device's state; a hostname discloses one they cannot act on. The
    timestamp is read on the system pool AFTER the tenant read has decided the device is visible —
    the ordering `/devices/:id/reset-attempts` already documents — and a test asserts the hostname
    is absent from the whole serialised body, not from a named key.

    **AND THE SCREEN WAS READING THE WRONG ENDPOINT.** It drew from `state.devices`, the 5s fleet
    poll, whose projection has never carried `last_reset_at` — so "Last reset" read "not reported"
    for every device in the fleet, forever, and looked like a farm that had never reset anything. It
    now merges `GET /devices/:id` over the poll row, so it paints immediately and fills in.

54. **THE FARM ITSELF CORRECTED THE PAGE I HAD JUST VERIFIED.** 2026-09-05. Control plane
    `06cf349` deployed and checked 34/34 and 6/6 — and then the SCREENSHOT of a real device showed
    two things no fixture could have.

    **THE SENTENCE THAT RESTATED ITSELF.** `quarantine_host` writes the reason and the source from
    the same fact, so the X1 Pro read: *"Its host was quarantined. It comes back on its own when the
    host beats again. The note reads 'its host was quarantined: no heartbeat for 90s'."* My local
    fixture had an operator's note, which adds information; a machine's note beside its own source
    sentence does not. The rule is about WHO WROTE IT rather than about matching strings — a health
    check has no actor either, and its detail ("device did not answer adb within 30s") is worth
    every character.

    **AND THE BUTTON THAT COULD ONLY MAKE THINGS WORSE.** The same card printed "it comes back on
    its own" and then offered **Authorise one recovery attempt** above a list explaining that only a
    passing health check can return the device. Two true sentences that contradict each other, one
    of them attached to a red button — and the button is worse than redundant: releasing sets the
    device PREPARING and asks the host to reset it, which is the same host that is not answering.
    Migration 035's timeout then quarantines it again with a new reason. An operator would have
    turned "waiting for a host" into "failed a recovery" and learned nothing.

    A host quarantine now gets its own list — *returns automatically / authorising does not speed
    that up / an unanswered attempt times out and lengthens the history* — with **when the farm last
    heard from that host** beside it, which is the fact the decision turns on and which only exists
    because of ADR-0026. The action stays, demoted out of `--bad-solid` and renamed "Ask for a
    recovery attempt anyway": an admin may know the host is coming back, and deleting a control an
    admin might need is the mistake stage 5 exists to correct.

    **THIS IS THE THIRD TIME THE SAME SHAPE HAS SHIPPED** — a control offered on a premise that is
    false in that state. Entry 51's quarantined class offering "Join the queue" the allocator would
    never serve; stage 5's rail claiming "not yet" for "not ever"; and now this. Each was found by
    LOOKING AT REAL DATA, never by a test, because in every case the code was internally consistent
    and the fixture agreed with it. The farm is the only place that disagrees.

55. **STAGE 5, ACTUALLY FINISHED — AND THE BAR THAT CONTRADICTED THE SENTENCE ABOVE IT.**
    2026-09-05.

    I had been calling stage 5 done since entry 52. Its spec is *"four states from 04, the new
    StreamPanel, and the capability-driven rail"*, and I had built only the rail. Correcting that in
    the log because the mislabel is what nearly let stage 6 start on an unfinished foundation.

    **THE DEFECT WORTH THE ENTRY.** `actionStatusStrip` drew `.bar.indet` — a 32% sliver sweeping
    left to right — for a queued app action, TWO LINES underneath its own caption promising *"You
    will see the outcome, not a progress bar"*. The page contradicted itself and the bar was the
    half that was lying: the control plane cannot dial a worker, so an app verb has exactly two
    reportable states, queued and finished. Document 04 says it outright — *"A filling bar here
    would be the one lie that discredits the other five."* Replaced with a mark that breathes on the
    2.2s system loop: a pulse has no extent, so it cannot be read as 40% done. The rule is not "no
    bars" — a real byte count brings one back, and is legitimate the moment it is measuring
    something.

    **WAITING IS NOT ENDING, in two places.** `live` is false for a QUEUED session because it has no
    device, and both the stage overlay and the Tools rail used that to mean "ended" — so somebody
    waiting in the queue was told their session had finished. Third and fourth instances of the
    false-premise family in two days.

    **AND A BLUR OVER MY OWN EXPLANATION.** The queued frame is deliberately unresolved (blurred,
    dim, flat, per document 04) and I put the sentence explaining that INSIDE it. `filter: blur()`
    applies to every descendant. The design had always drawn that copy as a block beside the frame,
    for the reason that only became obvious in a screenshot: there is nothing on the panel to
    annotate until a device is claimed.

    Also built: the cockpit is titled by the DEVICE with the uuid moved to an identity strip beside
    the OS and geometry (S1); S4's accounting — held for, actions, artifacts, and the reset the
    device actually declares, never an assumed "from snapshot"; and "Start another <class>",
    withheld when the class has nothing free, because offering it would queue somebody who has just
    finished.

    **A STALE REASON, FOUND ON THE WAY.** The queue card explained its missing ETA with *"the API
    does not report other sessions' lease times"*. It does now — `expiresAt` shipped in entry 51. The
    answer is unchanged and the reason is not: the soonest expiry is only an upper bound. Three
    surfaces now carry that sentence and they must not drift.

    `attempts.test.ts` failed once in three full runs (`the usage endpoint reports both numbers`),
    which is the order-dependent family issue 43 records. Nothing here can reach metering.

56. **STAGE 6 — THE BRING-UP CHOREOGRAPHY, AND THE THIRD INVENTED PERCENTAGE.** 2026-09-05.

    **THE ONE CONTINUITY RULE, which the console was breaking.** Document 04: *"The stage element is
    never unmounted between bring-up and session. If it reloads, the illusion that you watched THIS
    device arrive is gone, and with it most of the value of the sequence."* The bring-up screen drew
    its own `.phone.big` div — a rounded rectangle with a fixed 236×470 screen — and mounted the
    cockpit's `<video>` inside it once a stream arrived. A different element, a different shape, and
    a hard cut into the cockpit at the exact moment the sequence was supposed to pay off. The frame
    is now built once in `ensureStage()` and both screens append the SAME node; appending moves an
    element rather than recreating it, so the decoder never restarts. The old illustration and its
    CSS are deleted rather than left as a second, parallel way to draw a device.

    **SIX BEATS, EACH KEYED TO A CONFIRMED EVENT** — `data-beat` 0–6 on the frame, resolved from the
    checklist the console already derives from session state, socket state and action rows. Nothing
    is on a timer.

    **BEAT 3 MOVED, and that is a fix rather than a port.** Depth used to land on
    `data-state="live"` — the video — so a device declaring no `screen-stream` never became a
    physical object at all, and one with a slow negotiation stayed flat while it was already
    attached and fully driveable. The socket is what makes a session real (migration 017); the
    video is a nicety on top of it.

    **THE THIRD INVENTED PERCENTAGE.** After the cockpit's indeterminate bar (entry 55), two more:
    the bring-up stage drew a ring at `done / steps`, and the socket handshake drew one at a
    hardcoded **25 / 55 / 80**. Neither measures anything — acquiring takes a second and installing
    takes minutes, and a WebRTC negotiation has no extent to be a fraction of. `progressRing` is
    deleted. Its own comment claimed *"The percentage is real — steps completed over steps that
    apply — so it is worth showing"*, which is issue 46's comments-as-rumour exactly: true about the
    arithmetic, false about what the number was being read as.

    **BEAT 5 SHIPS ITS FALLBACK, DELIBERATELY.** The document travels the build's tile into the
    screen as bytes arrive and states its own fallback for having none: *"the tile waits outside the
    frame and lands on confirmation"*. No worker reports install bytes, so the fallback IS the
    design here — a travel animation with nothing to map travel to would be the bar again.

    **AND `undefined` IN A HEADER.** `loadSessionDetail` stores `{ id, missing: true }` on a 404 and
    `screenLaunching` accepted it as a session because the id matched, rendering "Session d946ed62 ·
    undefined". The bring-up screen is the one people are SENT a link to, so that is the screen a
    stale link lands on. It now names the session and says it is not visible.

57. **STAGE 8 — THE LIGHT THEME, AND THE BOUNDARY IT KEPT CROSSING.** 2026-09-05. The design
    package's last stage, and the one whose work is described as "mechanical". It was, and
    mechanical is exactly where the silent mistakes were.

    **THE PALETTE WAS NEVER THE PROBLEM.** `[data-theme='light']` has redefined every colour since
    stage 1. What the console did was **bypass it**: 73 colour literals painted outside any token —
    `#fff` on hovers, `rgba(255,255,255,.035)` on nav items, near-black grounds, the four log-level
    colours. The light block could redefine forty tokens and the page would still paint white text
    on a white card, because those values never went through a variable at all.

    **THE RULE THAT SPLITS THEM IS DOCUMENT 01'S ONE IDEA:** *"The console is a neutral desk. The
    device is the warm object sitting on it."* The desk changes when the lights come on; the phone
    does not. Thirty-odd chrome literals became tokens; every literal from `.mf-device` down stayed,
    because a powered-off panel is near-black in any room.

    **AND THE BOUNDARY BROKE WHILE I WAS DRAWING IT.** `.dev-overlay` is a sibling of the video
    INSIDE `.mf-glass` — the device's screen showing a message — and it read `--s-inset`. In light
    theme the phone's screen turned white. Only a screenshot could find that: the source line is
    identical to the correct one on a card.

    **THREE MORE FROM THE SAME PASS, all mine, all caught by looking:**
    - A blanket replacement of `color: #EDEDED` landed on `.avatar` instead of the rule I meant, so
      the user's initial vanished in light theme.
    - A substitution keyed on `rgba(16,16,18,.92)` assumed a floating tooltip and hit `.signin-card`
      — which would have put a permanently dark card on a bright page. There is no tooltip in this
      console; every "tooltip" is a native `title`.
    - `.empty` took a literal meant for `.mf-nosignal`, because `replace(old, new, 1)` takes the
      first match in the FILE, not the first in the section.

    **TWO TOKENS THAT WERE NEVER DEFINED AT ALL.** `--s-line` and `--s-4` are read by four rules and
    declared in neither theme, so their fallbacks have always won — and `rgba(255,255,255,.10)` as a
    hairline is invisible on a white card. Found by the guard rather than by eye.

    **`data-density` AND `data-liveness` HAD NO CONTROLS EITHER.** Both have driven the token scales
    since stage 1 and nothing in the console could set them. Settings now carries an Appearance card
    with all three. Theme is a THREE-way choice — system, dark, light — because a two-way toggle
    converts "I have not decided" into a decision on first click with no way back, and because only
    "system" can keep following an OS that changes at sunset (it does, live, via `matchMedia`).
    The stored value is the CHOICE, never the resolved theme.

    And I offered a **Dense** density, which does not exist — the three are comfortable, compact and
    **airy**. A button setting an attribute no rule matches, written by the person who has spent two
    days deleting exactly that. Caught before it shipped, by reading `design-tokens.css` rather than
    trusting the name.

    **`theme.test.ts` GUARDS THE RULE, not the colours.** Five assertions: no token is dark-only, no
    rule in the frame's namespace reads a chrome token, the overlay is painted with literals,
    `--bad-solid` is identical in both themes, and the chrome carries at most 16 hand-painted
    colours. It cannot judge contrast — that stays a screenshot's job — but it keeps the screenshots
    comparable. Its own first two versions were wrong in instructive ways: it sliced the file at
    `.mf-glass` and swept up every chrome rule below, and it matched `[data-theme='light']` inside a
    COMMENT and reported all 48 colour tokens as missing. A guard that fails loudly against correct
    code gets deleted, so both now parse instead of slicing.

    Verified in light on seven screens: fleet, device detail with the gate, cockpit, bring-up,
    settings, health and sign-in.

58. **THE RENDER PATH, MEASURED — AND A CHECK THAT FAILED AGAINST ITS OWN FIX.** 2026-09-05.
    Control plane `97f5c8a`: stages 5, 6 and 8 all deployed together, `verify-console.sh` 63/63.

    **THE CHECK THAT CRIED WOLF.** `verify-console.sh` grepped the deployed `console.js` for
    `progressRing` and reported "the progress ring is back". The only occurrence was the COMMENT
    explaining why the function had been deleted — a guard failing against the very change it was
    written to protect. It now matches `function progressRing` and `.ring-fill`, which is what its
    own neighbour two sections down warns about: a guard that cries wolf gets deleted.

    **THE RENDER PATH HAD NEVER BEEN MEASURED** and "it feels fine" is not evidence, particularly
    with a frame system, six beats and a shared stage element newly in the tree. Measured through
    `performance` in the page, at **4× CPU throttle**, against a seeded 40-device fleet with 12
    sessions and 25 actions — 30 samples each:

    | screen | nodes | build p50 / p95 | +forced layout p50 / p95 |
    |---|---|---|---|
    | fleet (capacity) | 873 | 3.1 / 7.9 ms | 16.8 / 27.1 ms |
    | catalogue | 450 | 2.1 / 5.4 ms | 11.9 / 26.9 ms |
    | cockpit | 418 | 2.7 / 6.7 ms | 11.5 / 24.4 ms |
    | health | 417 | 1.6 / 4.4 ms | 8.2 / 23.6 ms |

    Worst case is **27ms p95 at 4× throttle** — roughly 7ms on an unthrottled machine, against a
    16.7ms frame budget. One dropped frame, at most, on a heavily loaded laptop.

    **AND THE POLL ALREADY DOES THE RIGHT THING**, which the measurement is what proved. `startPoll`
    compares `pollSignature()` before and after and only calls `render()` when the fetch actually
    brought something new — so an idle farm leaves the DOM untouched entirely. A probe that waited
    seven seconds on a quiet farm saw no rebuild at all; forcing a device state change in Postgres
    underneath the page produced one immediately, and **scroll position survived it** (`<html>` is
    the scroller and the content height is stable across a rebuild).

    That first probe is worth recording as a method note: it called `mod.refreshAll?.()`, which is
    NOT exported, got `undefined`, and reported a scroll position nothing had disturbed. A sentinel
    `data-` attribute on the first row is what caught it — without something proving the render
    happened, the measurement was of nothing.

59. **DOCUMENT 05 CLOSED — APPS, AND A NAME THE COPY PASS MISSED SIX TIMES.** 2026-09-05.

    Auditing §04–§06 against the running console found §05 (Runs) and §06 (Health, organisation)
    already satisfied: the runs disclaimer, Health's "what this page cannot see" panel, the
    shown-once key rendered inline rather than as a modal, and Team's "there is no email on this
    farm" are all there. Recording that rather than re-deriving it next time.

    **A BUILD THAT FAILED TO INSTALL SAID "NOT INSTALLED" AND OFFERED "INSTALL".** The failure WAS
    on the page — in `failureCard`, deliberately scoped to the last thirty minutes so an old one
    does not sit at the top of Apps forever. The consequence nobody had followed through: after
    thirty minutes the failure vanished and the row beneath it looked exactly like a build nobody
    had ever tried. "Not installed" and "tried, and the worker refused it" are different facts, and
    only one of them tells you to read the error before pressing the button again. The row is the
    right home for it because the row is per-build and survives; the card is per-event and should
    not. The button now reads **Retry**.

    **AND THE COPY DECK'S NAMING RULE WAS BEING BROKEN IN SIX PLACES.** `session.device` is the
    WORKER'S LOCAL ID — `dd-cf-1`, `cf-2` — and it was going into the sidebar, the Apps hold strip,
    the sessions table, a toast and the bring-up title. The top bar resolved it correctly, which is
    exactly why it took a screenshot to notice: "MFARM X1 Pro" in the header and "dd-cf-1" under
    "YOUR SESSION" in the sidebar, on the same screen, at the same time. One `deviceLabel()` now,
    including the call site that was already right, so it cannot drift from the ones that were not.

    **A HAZARD WORTH RECORDING.** The full suite failed 8 tests across `reaper`, the idle WebDriver
    sweep and `allocating a device class` — because the 40 devices and 12 sessions I had seeded into
    the LOCAL database for the render measurement were still there, and those suites count rows. The
    next run was clean, because the suites delete on setup. Seeding the dev database breaks the
    suite until it self-cleans, and the failure looks like a real regression in the allocator.

60. **THE FLAKE WAS A REAL BILLING BUG, AND IT WAS NEVER ABOUT TEST ORDER.** 2026-09-05.

    Issue 43 and my own notes have recorded `attempts.test.ts` as an ORDER-DEPENDENT flake for
    weeks — "fails in a full run, passes in isolation, reproduces on `main`". Every part of that
    description was wrong except the last.

    Run in ISOLATION, eight times, it fails about one run in four. There is no ordering involved.

    **THE CAUSE IS TWO CLOCKS.** `session_attempts.started_at` and `metering_events.occurred_at` are
    written by **Postgres's** `now()`. `GET /v1/account/usage` bounded its window with
    `to = new Date()` — the **API server's** clock. Measured on this machine, the database's clock
    runs **1–2ms ahead**. A row written moments ago therefore has `started_at > to`, falls outside
    `started_at < $2`, and is not counted.

    The test asks for usage microseconds after creating a session, which is precisely the window the
    bug lives in — so it lost the race about a quarter of the time. Across two machines the skew can
    be tens of milliseconds or worse, and this is a count **used to bill**: a tenant who starts a
    session and immediately opens their usage page can be told it did not happen. They would
    refresh, see the right number, and never report it.

    **THE FIX IS AN OPEN UPPER BOUND.** Absent an explicit `to`, there is now no upper bound at all
    — "up to now" means "everything so far", and the honest way to express that is to not compare
    against a clock. `counts`, `deviceReliability` and `usage` take `Date | null` and guard with
    `($2::timestamptz IS NULL OR ...)`. An explicit `to` from a caller is still honoured exactly;
    that one is their clock and their intent. `window.to` reports `null` rather than inventing a
    timestamp — no consumer outside the tests reads it.

    **A DETERMINISTIC TEST REPLACES A STATISTICAL ONE.** Racing a 2ms skew is not a test. The new
    one stamps an attempt five seconds into the future — the same relationship a leading database
    clock produces, at a size that cannot be lost in noise — and requires it to be counted. Verified
    both ways: it fails against the old code every time, and passes against the new one. A second
    test holds the other half, that an explicit bound still excludes what falls after it.

    **BEFORE: 1 failing run in 4, in isolation. AFTER: 8/8 clean in isolation, and three consecutive
    full-suite runs at 807/807.**

    The lesson worth keeping is about the DIAGNOSIS, not the bug. "Order-dependent" was a guess
    written down once and then quoted for weeks, including by me, in a memory file. Nobody had run
    the file alone in a loop — which takes four minutes and would have falsified it immediately.

61. **THE FLEET, AGAINST THE PICTURE INSTEAD OF AGAINST MY OWN LIST.** 2026-09-05.

    Rakesh looked at the deployed console and said the overall UI had not changed — that a few
    things had, not the whole. He was right, and the reason is the entry: **I had been checking the
    design package off against my own list of stages rather than against the mockups in it.** Eight
    stages "complete" and I had never once rendered document 03's Fleet frame beside the live one.

    Doing that takes four minutes with headless Chrome and a `file://` URL. It found:

    | document 03 | what shipped |
    |---|---|
    | a device frame on every row | no frame — removed in entry 51 as "a fourteen-pixel sliver" |
    | four nav items under FARM, three under ORGANISATION | five under FARM, a lone OPERATIONS group, and Launch |
    | `Open cockpit`, primary, in the session card | `Cockpit`, ghost |
    | the waiting clause set apart in amber | one flat grey sentence |
    | `450dpi · 384dp` | `450DPI · 384 DP` — `.micro` uppercases |
    | one button per row | the action **and** a Details button on every row |
    | a substitution notice under the table | nothing |

    **THE THUMBNAIL REMOVAL WAS THE INSTRUCTIVE ONE.** Entry 51's reasoning was sound about the size
    I had given it — at 14px a device frame is a dark smudge. The conclusion did not follow. The
    answer to "too small to read" is a taller row, and at 40px with one hairline on the chassis the
    silhouette reads: a 720×1280 row is visibly stubbier than a 1080×2340 one, which is a fact you
    can see before you have read anything. It is what makes the table a rack of devices rather than
    a spreadsheet about devices.

    **THE SUBSTITUTION NOTICE IS BUILT**, and it was the one piece document 03 calls the reason for
    a single Fleet surface. Three clauses, all required: something is free, the class you have been
    working on is not, and the free device is a different SHAPE. The third is what keeps it honest —
    two classes with the same geometry are interchangeable for a layout that will not match, so
    warning about them is the noise that teaches people to dismiss the notice that is real. No ETA,
    because the document's own CONFIRM note says that line needs lease-expiry data we do not have.

    **LAUNCH IS OUT OF THE NAV, and its capability moved rather than died.** Document 06 says the
    palette is *"the reason Launch does not need to be a route"*. The objection that kept the item
    for three weeks was real — nothing else can preinstall a build before handover — so the palette
    now carries "Start a device with a build installed" and the `#/launch` route still works.

    **TWO FIXTURE BUGS FOUND WRITING THE TESTS, both worth the space.** `seed()` did not reset
    `state.lens`, so a test rendering `#/fleet` inherited whichever lens the previous test left and
    asserted against the CATALOGUE while believing it was looking at the capacity table. And my
    substitution fixture spread one device into both slots, so they were the same shape and the
    notice correctly stayed silent — which looks exactly like the feature being broken. A fixture
    that cannot produce the condition proves nothing about the code that detects it.

    And the suite failed one test on two consecutive runs, in two different files, because of the
    fleet I had seeded locally for the screenshots. Second time today; it is in
    [[mfarm-seeding-breaks-the-suite]] and I still walked into it.

62. **THE ANIMATION WAS MOSTLY FAKE, AND DOCUMENT 08 HAD A PANEL WITH NO DATA BEHIND IT.**
    2026-09-05.

    Rakesh: the screenshot inside the frame does not matter — the device that spawns fills it. What
    matters is the FRAMES AND THE ANIMATION, the multiple states of a device coming up, in sync with
    the steps, so it feels like a real device arriving.

    **THREE OF THE SIX BEATS DID NOTHING.** They had a `transition` declared for a property and no
    rule that ever changed it: beat 02's wake glow, beat 04's cross-fade, beat 06's settle. A
    transition with nothing to transition reads as correct code and moves nothing, and no static
    screenshot can see it — I had only ever taken static screenshots.

    Fixed by making every beat a real state change on `data-beat`, and VERIFIED by stepping the
    beats on the real element and capturing a frame **260ms into each transition**, where a settled
    frame would look identical whether or not anything moved. `theme.test.ts` now asserts each beat
    changes a property, which is the failure with no other symptom.

    **AND THE BEAT FOLLOWED THE ELEMENT INTO THE COCKPIT** — the cost of the continuity rule.
    Because the frame is deliberately never unmounted, a leftover `data-beat="2"` held the chassis
    flat and the contact ellipse at zero on a fully attached session: the device arrived in the
    cockpit looking like it had not finished arriving.

    **DOCUMENT 08's HANDOVER PANEL IS BUILT.** *"You asked for an X1 Pro. You have an unprofiled
    device."* It is the other half of the substitution story — the Fleet's notice fires BEFORE you
    start, when you still have a choice; this fires after, when a session already holds the wrong
    class. It needed an API field: `constraints->>'profile'`, which migration 006 already stores so
    `promote_queued` can re-apply it, now returned as `requestedProfile`.

    **AND IT IS HONEST ABOUT WHEN IT CAN FIRE.** Since ADR-0025 the console always constrains, so a
    console-started session cannot land here — the allocator queues rather than substituting. What
    can: a session started by the CLI or a WebDriver suite that named a class and accepted a
    substitute, then opened in the console. `matchedProfile` gates the whole panel, because a caller
    that named no class asked for nothing in particular and cannot have been disappointed.

    Also checked: **document 02's geometry table matches `frame.js` exactly** — all four kinds,
    every ratio, chassis radius derived rather than picked. That is the one document I built from
    the prose and got right, because the prose WAS the numbers.

    The SQL comment cost a TS1005 on a line of prose, from a backtick inside a template literal.
    Third time; it is in [[mfarm-sql-comment-backticks]] and I still wrote it.

63. **THE UI REVAMP, VERIFIED ON REAL HARDWARE — AND WHAT USING IT FOUND.** 2026-09-05. Control
    plane `886cb47`, lab up for 14 minutes.

    Rakesh asked for an exploratory pass with a user's eye, then a real bring-up. Both were worth
    more than the assertions that preceded them.

    **CLICKING EVERY CONTROL ON EVERY SCREEN** found four defects no test could see, because they
    are about what a control DOES rather than what a screen says: a session's length rendered as
    `mm:ss` so "Released by you at 14:29, after 20:00" read as two clock times (S1); "Find machine"
    with an empty field returning in silence (S2); every in-use fleet row carrying two controls to
    one destination; and an empty state pointing at a surface by its pre-IA name.

    **AND ONE THAT COST ME AN HOUR.** I explored against the wrong tenant without noticing, because
    a person in more than one org cannot tell which they are in — the org name is in the avatar's
    `title` and nowhere else. Their sessions, keys and apps silently belong to an org they did not
    choose. That is D8 and it is the most user-visible gap in the register.

    **ON REAL HARDWARE, the choreography works.** A live Cuttlefish device streams into the frame at
    1080x2340 / 50fps / 35ms, the punch-hole over its own reserved status-bar region. A full Launch
    ran acquire → ready → attach → stream → install → open, the worker confirming the install in
    about 8 seconds, and the beat cleared on handover. The build's tile waited outside the frame
    exactly as document 04's no-byte-progress fallback says.

    **THE CHOREOGRAPHY IS ALSO ALMOST UNREACHABLE**, which is the finding that matters. Pressing
    Start on a Fleet row goes STRAIGHT to the cockpit — `startSession` jumps as soon as a device
    comes back — so the six beats only play from `#/launch` or when the request queues. On a warm
    farm, which is the normal state, nobody ever watches the device arrive. That is D14 and it is
    the gap between "the animation is correct" and "the animation is seen".

    **THE LAB'S BOOT SELF-HEAL HAS BEEN DEAD SINCE 3 SEPTEMBER.** `mfarm-farm.service` exits in one
    second on every boot: a preflight refuses to continue while `BACKUP_BUCKET` is empty. The guard
    is right and the consequence is invisible — devices recover anyway because `mfarm-worker.service`
    is a separate unit. My own memory that "both VMs come back to a working 2-device farm on a plain
    `instances start`" had been stale for two days and I quoted it while starting the lab.

    `docs/DEFECTS.md` now holds all seventeen, with severity by what each costs a person.

64. **THE TWO S2s, AND A GUARD I ALMOST SHIPPED BLIND FOR THE FOURTH TIME.** 2026-09-05.
    Control plane `2390d7f`.

    **D14 — PRESSING START WENT STRAIGHT TO THE COCKPIT.** `startSession` jumped to
    `#/sessions/<id>` the moment the allocator returned a device, which on a farm of pre-booted
    devices is almost always. So every one of the six beats played only from `#/launch` or when a
    request queued: on a warm farm nobody ever saw the device arrive. The animation was correct and
    unseen, which is the whole distance between building a thing and shipping it. Start now routes
    through the bring-up screen, and it is not a delay — `bringupDone` hands over the moment the
    session is ACTIVE and the socket has settled.

    **D8 — WHICH TENANT AM I IN.** The org name lived in the avatar's `title` and nowhere else, so a
    person with two memberships had their sessions, keys and builds silently belong to a tenant they
    did not choose. `/v1/auth/me` now returns every membership — always, not only when there are
    several, because a caller who has to ask "is this longer than one" will forget to — and the
    header names the org with "1 of N orgs" where a choice is being made for them.

    **D13 — THE DEVICE HOST'S BOOT UNIT.** It failed on every boot from 3 to 5 September, exiting in
    one second on "BACKUP_BUCKET is empty" — a control-plane backup policy that a machine with no
    database has no business having an opinion about. The check for "which machine is this" already
    existed in `farm-up.sh`, four sections too late. It now runs early, and a device host stops
    before the control-plane work entirely.

    **AND THE FOURTH TIME TODAY I WROTE A GUARD THAT COULD NOT SEE ITS OWN SUBJECT.** The first
    version of that check sat ABOVE `. "$ENV_FILE"` and read `CONTROL_PLANE_URL` before anything had
    defined it — so it would have been dead code protecting against dead code. Caught by asking
    where the variable comes from before committing. The other three today: a grep for
    `progressRing` matching the comment explaining its deletion; a theme test slicing the stylesheet
    and reporting eighteen correct rules as violations; and an empty-fleet guard counting passing
    assertions instead of attempted allocations. `deploy/farm-up.test.mjs` now asserts the ORDER of
    the guard against the source line, which is the only part that was ever wrong.

    Suite: 1374 tests across every workspace. One unidentified failure in five full runs, name not
    captured, three clean runs after it — recorded in `docs/DEFECTS.md` rather than called resolved.

65. **"THE ONLY PART THAT WAS EVER WRONG" WAS THE WRONG PART.** 2026-09-05. Control plane
    `c5f0af5` → `dc7299c`.

    Entry 64 ends: *"`deploy/farm-up.test.mjs` now asserts the ORDER of the guard against the source
    line, which is the only part that was ever wrong."* It was not. **The D13 fix did not work, and
    a watched boot was the only thing in the system capable of saying so.**

    **WHAT THE BOOT SAID.** Lab started, checkout moved to `c5f0af5`, rebooted.
    `mfarm-farm.service`: failed 13:11:42 → 13:11:43, `status=1/FAILURE`. The same one-second exit
    on the same `BACKUP_BUCKET` message as before the fix, now with the fix in it.

    **WHY.** The guard read `CONTROL_PLANE_URL` out of `$ENV_FILE` — `deploy/.env`. That file has
    never contained the key. `install-worker-service.sh:79` writes it to
    `deploy/.state/worker.env`, which is the **worker unit's `EnvironmentFile`**: a different file,
    read by a different process, for a different unit. On the lab it holds
    `CONTROL_PLANE_URL=https://34-100-138-213.sslip.io`. The guard read the right variable from the
    wrong file, so on the only machine it exists for it always saw empty and fell through to the
    control plane's backup policy.

    **THE TEST AGREED WITH THE BUG.** It asserted the guard appeared on a line below
    `. "$ENV_FILE"`. That is a true statement about the text of the script, it stayed true, and it
    is compatible with the variable being absent from every file on the machine. Entry 64 called
    the ordering "the only part that was ever wrong" — the ordering was the part that was *right*.
    Guard and test were built on one premise nobody checked against the box, so they confirmed each
    other. This is [[mfarm-false-premise-controls]] with a test attached, and the test made it
    worse: it converted an unverified claim into a green one.

    **THE FIX IS A FUNCTION, BECAUSE A GUARD YOU CANNOT EXECUTE HAS ONLY BEEN REVIEWED.**
    `deploy/lib/host-role.sh` takes the deploy directory and the kvm node as arguments, so a test on
    a laptop with no `/dev/kvm` can put the lab's real file shape behind it and watch it decide.
    Eight tests run it. Proved non-vacuous with a negative control: the shipped logic answers "not a
    device host" on that fixture; the new logic answers "device host". Loopback is rejected **by
    value**, so a single-host farm keeps its own control plane — not by the absence of `worker.env`,
    because reasoning from a file's absence is what produced the first fix.

    **AFTER `dc7299c`:** `active (exited)`, `status=0/SUCCESS` at 13:22:09, printing
    `==> Device host … a control plane at https://34-100-138-213.sslip.io that is not here`. First
    clean boot of that unit since 3 September. `verify-live.sh`: 3 devices READY, screen-stream
    declared, `farm.mfarm.dev` serving, coturn answering. `verify-console.sh` 62/62.

    **TWO THINGS THE LAB WINDOW FOUND THAT NOBODY WAS LOOKING FOR.**

    **D18 — RELEASED IS NOT DEPLOYED.** The farm was serving
    `ghcr.io/rkcr007/mfarm-api:886cb47` while `main` was two merges further on. PR #102's D14 and D8
    merged at 11:28 and released at 11:34, and the farm went on serving the previous image until I
    deployed at 13:08 — ninety minutes in which `docs/DEFECTS.md` claimed they were "in the deployed
    build". Found by reading `docker ps` for an unrelated reason. The console's build badge reports
    what IS serving; nothing anywhere reports what SHOULD be.

    **D19 — THE CHECKOUTS ON BOTH BOXES HAD DRIFTED.** `mfarm-cp` was on a **detached HEAD at
    `886cb47`** — a state a memory explicitly records as fixed. `mfarm-lab` was **66 commits
    behind**, on PR #81. That one is not cosmetic: the lab's boot unit and worker unit both
    `ExecStart` out of that working tree, so the farm had been running agent code from 66 commits
    ago while the control plane ran today's.

    **AND THE DISCIPLINE THAT ACTUALLY CAUGHT THIS**, which is worth more than the fix: D13 was
    written down as *"reasoned and unit-tested, not watched boot — needs one lab start to confirm"*
    instead of being filed with the other fixes. Had it been recorded as fixed, the boot unit would
    have stayed dead and green.

66. **THE SEVEN UI DEFECTS, AND A TEST FILE WRITTEN AGAINST THE LESSON FROM ENTRY 65.** 2026-09-05.
    Console `db8f2fa` → this change.

    All seven of the console-only defects in `docs/DEFECTS.md`, implemented in
    `apps/api/public/console.js` and `console.css`. Not D1, D2 or D4: those need data the API and
    the worker do not send — the last health-check outcome and its age, `screen` on a physical
    handset, and a lease-derived ETA — and building the UI for absent data is how a console starts
    depicting things nobody reported.

    **THE CONSOLE PEOPLE USE IS THE VANILLA ONE**, checked before a line was written rather than
    assumed. `https://farm.mfarm.dev/` loads `/console.js`; `apps/console/` is a React app whose
    build output is served at `/app/` and is not what the Fleet, the cockpit or the bring-up screen
    render from. Asking the deployed page what it LOADED is [[mfarm-unused-asset-looks-fine]], and
    it would have been an easy day's work in the wrong file.

    **D3 (S2) — THE BUILD, FROM WHERE THE DEVICE IS CHOSEN.** Preinstall lived only behind
    `#/launch`, so somebody on the Fleet looking at the device they wanted had to leave the surface
    they were choosing on and re-pick the same class from a picker. `startSession` takes a build
    now, and sets `state.bringup` BEFORE navigating — after would race `watchBringup`, which treats
    a missing bringup as "somebody followed a link" and rejoins with `appId: null`, silently
    dropping the build on exactly the fast path this was added for. Offered on the fleet row, the
    catalogue card and device detail; never on an empty library and never on a busy device.

    **D9 — HEALTH NAMED A DEVICE AND GAVE NO WAY TO REACH IT.** The name is now the same
    `fleet-open` control the Fleet uses. `Recover` carries both of its gates: admin, because the
    route is admin-only and a member would get a 403; and NOT on a host-sourced quarantine, which is
    entry 54's defect — that device returns on its own, and authorising a recovery asks the host
    that is not answering.

    **D10 and D11 — the ended cockpit**, which is one screen and document 04 S4. A third stage mode:
    the rail is EMPTIED rather than disabled (none of it will ever work again for that session,
    which is a different thing from a capability the device lacks), the frame shrinks, flattens and
    dims instead of being replaced, and the four numbers move beside it. QUEUED is explicitly not
    ENDED — the same conflation `paintOverlay` already had to be corrected for.

    **D15 — the tile was anchored to the wrong box.** `top: 6px` measured from the STAGE, whose
    height is the viewport's, so how far the frame's top edge sat below it varied: roomy on a short
    screen, about twenty pixels on a tall one, at which point the tile overlapped the bezel it was
    waiting above. It is a child of `.dev-fit` now at `bottom: 100%`, so "outside the frame" is a
    fact in every viewport and the landing travel is measured from the same edge. Also found while
    in there: the tile never got hidden on handover, so the cockpit could inherit it.

    **D16 — the two beats a worker answers for.** Document 04: *"Steps 5 and 6 are different, and
    look different… There is nothing to fill, so these beats breathe — the amber mark pulses on the
    2.2s system loop. A filling bar here would be the one lie that discredits the other five."* They
    were a spinning purple ring, which is a depiction of travel toward a destination on the two
    steps where nothing is travelling and the wait is longest.

    **D17 — two unprofiled devices.** NOTHING IS INVENTED, because there is nothing to invent: no
    serial, no instance number, and ADR-0026 keeps the host off tenant surfaces deliberately. The id
    IS the distinguishing fact, so it stops being styled as caption grey — the console's word for
    "you may skip this" — on exactly the rows where it is the whole answer, and the title says why.
    Rows whose name is unique keep the quiet caption, or the emphasis would mean nothing.

    **AND THE TESTS, WHICH ARE THE POINT.** Twenty new assertions, every one of them rendering the
    screen and reading the tree rather than reading the source. Then the thing entry 65 says to do:
    **a negative control**. Reverted `console.js` and `console.css` to `main`, ran the same file, and
    16 of the 20 fail. The four that pass either way are absence assertions — an empty library, a
    busy row, a host-sourced quarantine, a member without the admin route — which correctly hold in
    both directions and are worth having for the day somebody removes a gate.

    That control also caught a bad test while it was being written. `assert.doesNotMatch(sheet,
    /\.dev-tile\s*{[^}]*top:\s*6px/)` failed against the FIXED stylesheet, because the rule's new
    comment explains why `top: 6px` was the wrong anchor — and a regex over a file cannot tell an
    explanation from a declaration. The helper strips comments now. It is the same shape as the
    `progressRing` grep in `verify-console.sh` that matched the comment describing its own deletion,
    and as entry 65's line-number assertion: **a test that reads text will eventually read prose
    about the bug and call it the bug.**

67. **THE SEVEN, WATCHED ON THE FARM — INCLUDING THE TWO THAT ONLY EXIST WHILE A WORKER IS BEING
    WAITED ON.** 2026-09-05. Console `45683f9`.

    Deployed and verified in one window. Signed in to `https://farm.mfarm.dev` in a real browser as
    the farm's own `admin@mfarm.local` (the account `farm-up.sh` provisions; password in
    `deploy/.state/console_password`), with the build badge asserted on every capture — a
    screenshot that cannot name its own build proves nothing, and a cached bundle looks exactly
    like a fix that landed.

    **D3, D9, D10, D11, D12, D15, D16, D17 all closed.** The static ones were read off the page.
    The two that could not be: D15 and D16 exist only while a worker is being waited on, which no
    fixture and no static route produces — so "With a build…" was pressed for real, the dialog
    allocated an MFARM X1, queued Alaan staging, and the worker confirmed the install about twelve
    seconds later. That single run verified D3 end to end and both bring-up defects at once.

    **The tall viewport was the point for D15.** Captured at 1500×1500 deliberately: the tile's
    overlap was viewport-dependent and a short window was the case that always looked fine. It
    waits clearly above the frame while queued, and lands inside the screen, green, on
    confirmation. **D16 is visible as two different marks in one list** — "Installing Alaan
    staging" amber while "Device ready" above it keeps the purple ring, then "Opening …" turning
    amber as it becomes the beat being waited on. Document 04's "steps 5 and 6 are different, and
    look different", which is the sort of claim only a photograph settles.

    **D12 was confirmed by eye for the first time** on the way past — "ran 1 minute", "Released by
    you at 18:51, after 1 minute". It shipped in `f632e86` and had been suite-covered only.

    **TWO THINGS THE HARNESS GOT WRONG FIRST, both of which produced a plausible artefact.**

    Injecting the session cookie into headless Chrome gave three screenshots of the SIGN-IN PAGE.
    They were real PNGs of the right size and would have been filed as evidence by anybody who did
    not open them. The cause: `curl`'s cookie jar writes an HttpOnly cookie with a `#HttpOnly_`
    prefix on the domain, and the parser skipped every line starting with `#` as a comment. Filling
    the login form is what the harness does now — it exercises the real path and has no cookie
    plumbing to get wrong. **The general form: a capture that succeeded is not a capture of the
    thing you asked for.** Same family as [[mfarm-unused-asset-looks-fine]].

    And the CSS assertion in the new tests failed against the FIXED stylesheet, because
    `/\.dev-tile\s*{[^}]*top:\s*6px/` matched the COMMENT explaining why `top: 6px` was the wrong
    anchor. A regex over a file cannot tell an explanation from a declaration. The helper strips
    comments now. Third instance of this exact shape: entry 65's line-number assertion, the
    `progressRing` grep in `verify-console.sh` that matched the comment describing its own
    deletion, and this.

    **Left behind, deliberately:** the session created for the verification (`1c2e67f0`) was not
    released. Cookie-authenticated `DELETE` needs a CSRF token the script did not carry, and by
    then the lab was stopped — firing a reset at a host that no longer exists is worse than letting
    the 30-minute lease expire, which the control-plane reaper handles on its own.

    **Not D1, D2 or D4**, which need data the API and worker do not send. Lab up ~35 minutes, stopped.

68. **D1 AND D4 BUILT; D2 WAS NOT A DEFECT.** 2026-09-05/06. Control plane `08fa8a0` → this change.

    The three that were "waiting on data". Two of them genuinely were. The third was waiting on
    somebody checking.

    **D1 — WHAT THE FARM LAST CONFIRMED, AND WHEN.** Document 05 §06 puts an outcome and an age on
    every Health row; the list projection carried neither, so a row could only repeat its own state
    pill. `GET /v1/devices` now sends `lastResetAt` and the page says "reset confirmed 4m ago",
    "check failed 2d ago", "host stopped beating 90s ago", or "no check recorded".

    **AND NOT THE JOIN THE DEFECT ASKED FOR**, which is the part worth keeping. `docs/DEFECTS.md`
    proposed a lateral join onto `device_reset_attempts`. That table is written by migration 032
    only when a reset has been outstanding too long or has been escalated — outcomes
    `timed-out | succeeded | escalated` — so **a healthy device has no rows in it at all**. The join
    would have answered "nothing recorded" for exactly the devices that are fine, on most of the
    fleet, and it would have looked like a working feature. `last_reset_at` is the column that means
    what the design is reaching for: stamped both by a worker confirming a snapshot restore and by
    `complete_recovery` when a released quarantine passes its check. There is a test whose whole job
    is to assert the attempt ledger is EMPTY for a confirmed device, so the join cannot come back.

    The words are not the design's and that is deliberate. "Check passed" would overclaim: this farm
    runs a health check in one place only — the recovery gate — not on a sweep of healthy devices.
    The failing side IS the design's verbatim, because there it is exactly true.

    **D4 — "AT MOST", NOT "ABOUT".** Document 03 wants "the next X1 Pro frees in about 12 minutes"
    and its CONFIRM note says it needs lease-derived data. The data was always there. What was
    missing was a form of words the data supports: `expiresAt` is an UPPER bound, because a holder
    can release early and because somebody ahead of you takes the device first. Both objections are
    about the word "about". Neither touches what the bound does support — the device WILL be free by
    then, since the reaper enforces the lease. So the line reads "frees in at most 12 minutes": a
    fact rather than an estimate, and about the DEVICE rather than about your wait.

    **D2 — THE CLAIM WAS FALSE, AND IT TOOK FOUR READS AND ONE QUERY.**

    It said "the worker registers no `screen` for real devices". The agent has read a handset's
    panel with `wm size` / `wm density` since `c00114f`, **2026-08-24 — twelve days before the
    defect was written down**. `physical.ts` falls back to a real geometry when that read fails, so
    the field cannot be empty. `agent.ts` sends `info.screen` for every tier, on the same line the
    two Cuttlefish devices arrive through. The API upsert stores it and re-asserts it. And
    `physical.test.ts:99` has been asserting the backend reports a usable geometry the whole time.

    The contradiction that had to be resolved before calling it stale: the row was CREATED
    2026-08-27, after the screen code landed, and still has NULL screen. One query settled it —
    `last_heartbeat_at` for that device's host is `2026-08-29 01:30`, and the device row's
    `updated_at` is `01:32` the same morning. **The host has been silent for eight days**; nothing
    with the current agent has ever registered that phone. Most likely it ran an older published
    agent, which is [[mfarm-released-is-not-deployed]] wearing a third hat.

    So D2 stays open and is NOT a code change. What it needed was the guard nobody had written:
    `device-health-fields.test.ts` registers a handset with a panel through the real route and
    asserts it comes back out of the tenant list. **That test passes against unmodified code** — it
    is a guard, not a fix, and saying so is the difference between closing a defect and hiding one.
    Closing it for real needs the handset plugged into a host running a current agent.

    **THE SHAPE TO REMEMBER**: a defect register decays exactly like a memory or a comment does. Two
    of these three entries named a cause, and one of the two causes was wrong. Grep the VERB before
    building against the noun — [[mfarm-spec-docs-overstate]] said this about specs, and it is just
    as true of a bug list I wrote myself yesterday.

    Suite 1415 green, typecheck clean. Typecheck caught two implicit `any`s in the new test helpers
    that `node --test` had happily stripped and run — step 3 of the definition of done, doing its job.

69. **D1 AND D4 WATCHED, AND D1 CAUGHT SOMETHING ON ITS FIRST DAY.** 2026-09-06. Console `0141e8e`.

    **D4, with the farm deliberately filled.** Four sessions taken through the API until
    `available` hit 0, one of which queued — the design's own scenario. The headline read: *"Every
    device is in use. One person is waiting — the next Unprofiled device frees in at most 25
    minutes."* Document 03's structure, its amber emphasis on the waiting clause, and "at most"
    where it says "about".

    **D1, and the row that earned the feature.** The Health page showed MFARM X1 as
    **`RESTORING` — "reset gave up 12m ago"**, in red. That was not a fixture. The session I left
    un-released at the end of entry 67, on a lab I then stopped mid-reset, had exhausted its reset
    budget (migration 032). **The state pill said the device was busy restoring; only the new line
    said the restore had given up twelve minutes earlier.** That gap — between "not allocatable"
    and "not allocatable and nobody is coming" — is the whole reason document 05 §06 puts an
    outcome on the row, and it took one deploy to demonstrate it on a real device.

    Cleared with `clear-reset-escalation` and the X1 was READY in 80 seconds. Which also closes the
    loose end entry 67 recorded: letting that lease expire was the cheap choice at the time, and it
    cost a device an escalation. **A session on a host you are about to stop is worth releasing
    before you stop it**, even when the reaper would eventually cope.

    The handset read "reset confirmed 9d ago" — D2's staleness, rendered on the page, without
    anybody having to run a query.

    **TWO AUTH SHAPES, LEARNED BY GETTING THEM WRONG.** `DELETE /v1/sessions/:id` takes a tenant API
    key on `authorization: Bearer` and needs no CSRF; `POST /v1/devices/:id/clear-reset-escalation`
    is an ADMIN USER route and refuses an API key outright — "This endpoint requires a signed-in
    user session". Cookie plus `x-mfarm-csrf`, from the login response's `csrfToken`. Entry 67's
    un-released session was a CSRF failure on the first of those two; it was the wrong credential
    for the route, not a missing token.

    Lab up ~25 minutes, farm left at 4 READY + 1 quarantined, lab stopped.

70. **AN EXPLORATORY PASS OVER THE WHOLE CONSOLE — FIVE DEFECTS, AND ONE OF THEM IS THE FARM.**
    2026-09-06. Console `034b1dd`.

    Rakesh asked for exploratory testing after the integration, on the reasonable suspicion that
    nine changes across three layers verified in isolation might not hold together. **They did.**
    Every one of D1, D3, D4, D9, D10, D11, D15, D16 and D17 behaved on a live farm, in both themes,
    with **zero console exceptions and zero failed requests across every surface**. The full
    journey — Fleet → "With a build…" → bring-up → cockpit → install → launch → release → ended —
    ran end to end with the app visibly on screen at 50fps.

    What the pass found was five defects that had nothing to do with the integration, which is what
    exploratory testing is for.

    **D21 (S2) — an escalated device is invisible and unrecoverable in the console.**
    `resetEscalation` has been on both API projections since migration 032. The console renders it
    in exactly ONE place: the Health line I added yesterday for D1. Not on the device's own page —
    the page a person opens to act on it. And `clear-reset-escalation` has **no UI at all**;
    recovering MFARM X1 twice today needed `curl`. Yesterday's feature is currently the only thing
    in the product that can see this state.

    **D22 (S2) — the Fleet's "Live" lens lists ended sessions.** 50 of 50 rows read ENDED, under a
    tab whose badge counts only live ones — so the tab shows no number above a full table.
    `screenSessionsBody()` renders all of `state.sessions`; nothing filters to the states the badge
    is computed from. Two numbers on one screen derived from different sets.

    **D23 (S2) — the cockpit's default log filter hides everything.** "This app" matched **0 of 270
    lines** on a session where the build was installed, launched and visibly on screen. Every tag on
    this device class is a system one — `adbd`, `logd`, `WifiService` — and there is no
    `ActivityManager` line at all, which is precisely the fallback `visibleLog`'s own comment says
    the name-match relies on: *"catches the framework's own lines about the app (`ActivityManager`,
    `JobInfo`, install and launch)"*. It does not, here. [[mfarm-comments-as-rumour]] again, and the
    comment is one I wrote.

    **D24 (S3) — releasing leaves a live rail on screen for ~7–12 seconds.** `releaseSession`
    refreshes `devices` and `sessions` and calls `render()` immediately, but never `state.detail` —
    and `screenCockpit` PREFERS `state.detail`. So the confirm actively repaints a stale live
    cockpit: fourteen enabled controls aimed at a device that is being wiped. Measured across a
    fresh session: `mode=session` at t+2s and t+7s, `mode=ended` at t+12s, when the poll's 10s
    staleness rule finally re-reads the detail.

    **D25 (S4) — "after 7 seconds" beside "00:06 held for"** on one card, because `lengthInWords`
    rounds and `clock` floors.

    **AND THE FARM ONE, which is the most serious.** `cf-4` burned two full reset budgets in thirty
    minutes. The worker log has the cause: Appium for cf-4 exited at `19:51:23`, the agent logged
    `incident on cf-4: appium-failure` and announced it would drain the device — and **no
    `resetting cf-4` line appears in that window at all**. The control plane offered a reset three
    times, the worker never performed one, and migration 032 escalated the device out of the pool.
    Two recovery mechanisms fighting: the agent withdraws a device because its AUTOMATION server is
    unhealthy, the control plane escalates it because its RESET did not happen. A reset is a
    `cvd`/adb operation with nothing to do with Appium — a device that cannot take a WebDriver
    session can still be restored, and should be.

    **THE INSTRUMENTATION IS WHY THIS PASS WAS WORTH RUNNING.** Console exceptions, page exceptions
    and every response ≥400 were collected for the whole session and printed whether or not
    anything looked wrong. That is what makes "zero errors" a finding rather than an absence of
    looking — and it is what let me state plainly that the integration held, instead of hedging.

71. **THE FIVE THE EXPLORATORY PASS FOUND, AND THE FARM ONE UNDERNEATH THEM.** 2026-09-06.

    **MIGRATION 038 — A RESET NOBODY WAS THERE TO ATTEMPT IS NOT A STALLED RESET.** `cf-4` escalated
    itself out of the pool twice in thirty minutes with nothing wrong with it. The agent drains and
    EXITS to withdraw a capability, which stops every backend on the host and cold-boots them on the
    way back; that took thirteen minutes, during which the host sent no heartbeats and performed no
    resets, and the reaper counted three attempts against a device that had never been offered one.

    `count_stalled_resets` now requires the host to have beaten inside the same window the reset is
    judged over. **The two mechanisms were both firing on one outage, and only one of them heals** —
    a silence quarantine is undone by the next heartbeat (016's whole point is that its evidence is
    falsifiable), while a reset escalation is deliberately terminal and waits for a human. Letting a
    host outage produce the non-self-healing one meant every agent restart permanently cost a device.
    It is not a forgiving budget: a host that is beating and failing to reset burns it exactly as
    before, and there is a test whose only job is that contrast.

    **AND THE SECURITY TESTS CAUGHT WHAT THE MIGRATION LOST.** `DROP FUNCTION` + `CREATE` resets
    ownership and grants. A SECURITY DEFINER function recreated by the migration runner is owned by
    `mfarm` — a superuser — so every caller would have run as one with RLS off; and Postgres grants
    EXECUTE to PUBLIC on every new function, so `mfarm_app` could reach a fleet-wide write. 032 had
    set both; recreating it silently undid them. `definer-acl.test.ts` failed on both halves, by
    name. **A migration that recreates a definer function must re-assert `OWNER TO mfarm_definer`
    and `REVOKE EXECUTE … FROM PUBLIC, mfarm_app`** — that is now written into 038 with the reason.

    **D21 — an escalated device can finally be seen and resumed.** Device detail carries its own
    amber panel: what gave up, when, how many attempts, and why the device still reads CLEANING
    rather than QUARANTINED (032 is explicit that quarantining would also stop the offers that are
    the only thing which could fix it). Admin-gated **Resume recovery** behind the same confirm shape
    the quarantine release uses. The Fleet row stops saying "Snapshot restore in progress" about a
    restore that gave up.

    **D22 — one predicate.** `liveSessions()` now feeds BOTH the Live badge and the Live table, so
    they cannot describe different sets again. `#/sessions` keeps every row; it is the history.

    **D23 — the default cannot be a filter that hides everything.** Scope defaults to `all`. The
    scope remains as a narrowing you turn on, and an empty pane says why it is empty, naming the
    package — the counter already admitted it was filtering ("260 hidden") and that was not enough,
    because the thing a person looks at is the pane.

    **D24 — `releaseSession` awaits the detail before rendering.** It refreshed devices and sessions,
    called `render()`, and never touched `state.detail`, which `screenCockpit` PREFERS. The confirm
    repainted a live cockpit with fourteen enabled controls aimed at a device being wiped.

    **D25 — both forms floor now**, so "after 6 seconds" and "00:06 held for" agree.

    **AND A TEST OF MY OWN THAT WAS VACUOUS TWICE.** First
    `mod.lengthInWordsForTest?.(…) ?? '6 seconds'` — an optional call with the expected value as its
    fallback passes whether or not the function exists. Deleted. Then
    `assert.equal(mod.state.log.scope, 'all')`, which reads a SHARED MUTABLE SINGLETON that earlier
    tests in the same file have already written to — it passed against the unfixed console, which is
    how it got caught. Rewritten to import the module fresh under a query string, since ESM caches
    by URL and a new URL gives pristine state. **The negative control is what found both**: 7 of the
    new assertions fail against `main`, and any that did not had to be explained.

    Suite 1430 green, typecheck clean.

72. **ALL FIVE WATCHED, INCLUDING THE ONE THAT NEEDED A FAULT TO EXIST FIRST.** 2026-09-06.
    Console `1eba6c6`.

    D22 and D23 were visible the moment the deploy landed — the Live lens went from fifty ENDED rows
    to "No sessions", and the log pane from empty to 600 lines on a fresh session. D24 re-measured
    the way it was found: `mode=ended`, rail 0, at **t+2s**, against `session`/14 buttons at t+7s
    before.

    **D21 could not be verified by waiting**, because it needs a device whose reset budget is spent
    and the farm had just healed itself. So I induced one — set `reset_escalated_at` on `523581b7`
    directly, watched the whole path, and cleared it: the Fleet row read *"its reset gave up · 12m
    ago — open it to resume"* instead of "Snapshot restore in progress", the panel explained why the
    device still reads CLEANING rather than QUARANTINED, the dialog authorised it, the escalation
    cleared, and the device was READY again eighty seconds later. Inducing the fault is the only way
    to see a recovery path, and it is worth doing deliberately rather than waiting for the farm to
    break on its own.

    **AND THE DRIVER CAUGHT A NAMING SLIP OF MINE.** Clicking "Resume recovery" hit the PANEL's
    button rather than the dialog's confirm, because I had given both the same label. A human is
    protected by the scrim, so this would have gone unnoticed — but it also breaks the convention
    device detail already follows: the quarantine dialog's confirm says "Authorise recovery" rather
    than repeating its panel's button, because **a confirm should name what is being granted**. Mine
    now says **"Queue a reset"**, which is exactly what it authorises.

    Farm left at 4 available, lab stopped.

73. **THE PROTOCOL CHANGE HAD ALREADY SHIPPED — THE FIX WAS DELETING WHAT IT REPLACED.** 2026-09-06.

    Asked to make the protocol change that would let the agent withdraw a capability without
    restarting. **It was made on 2026-09-01.** `POST /workers/heartbeat` reconciles the per-device
    automation map the agent had always been sending — endpoint gone, `webdriver` stripped; endpoint
    back, `webdriver` restored; host-scoped; never touching `state` — and `http.test.ts` has covered
    every branch of it since.

    What nobody removed was the mechanism it replaced. `index.ts` still read: *"capabilities are
    written at registration only, so one device's `webdriver` cannot be withdrawn without
    re-registering the host… That needs the heartbeat to carry capabilities."* It carried them
    already. **The comment outlived the constraint by five days and cost a thirteen-minute farm
    outage** — and I quoted that comment back to Rakesh as the reason a protocol change was needed,
    which is [[mfarm-comments-as-rumour]] doing it to me twice in one week.

    So the fix was deletion: the withdraw timer, the grace window, the drain-and-exit, and a warning
    telling people to restart the agent to pick up a recovery that is now automatic. ADR-0027
    records it and marks ADR-0003's implementation note superseded. **What still drains, and must: a
    device ARRIVING** — the heartbeat reconciles devices it knows and cannot create one.

    `agent.test.ts` gains the assertion the deletion rests on, end to end against a real control
    plane: withdraw an endpoint at runtime, and the next beat strips `webdriver` from that device
    only, leaves the sibling advertised, leaves the device READY, and restores it later.

    **D18/D19 — "is this farm running main?" now has an answer.** `deploy/check-deployed.sh` reports
    the serving image, the control plane's checkout and the device host's, and `verify-live.sh` —
    the script already run after every `instances start` — asks it too. The assertion that matters
    is that **`unknown` never scores as up to date**: every gatherer is an ssh that can fail, and a
    check going green on a farm it never reached is worse than no check.

    **D20 — the boot unit is in the repo**, without the `CF_INSTANCES` it had no business declaring.

    **D2 — the console stops reporting a stale row as a fact about the device.** The list carries
    `hostLastSeenAt` now, so a blank geometry reads "last heard from this device 9d ago" where the
    host is silent and a bare "not reported" where it is beating. Those call for opposite actions.

    **TWO THINGS THE EXISTING TESTS CAUGHT THAT REVIEW DID NOT.**

    `definer-acl.test.ts` failed because migration 038's `DROP` + `CREATE` reset the function's owner
    to a superuser and re-granted EXECUTE to PUBLIC — see entry 71 and architecture rule 5.

    And `device-health-fields.test.ts` returned **500** because I joined `hosts` inside `withTenant`.
    Migration 002 revokes `hosts` from `mfarm_app` entirely; the correct shape is the one
    `/devices/:id` already uses — the tenant read is the authorisation, and only the ids that
    survived RLS are carried into a system-pool read. The code comment explaining that was four rows
    from where I was typing.

    Also: TS1005 on a line of prose, because a SQL comment inside a template literal contained
    backticks. [[mfarm-sql-comment-backticks]], exactly as written down.

    **The open register is empty for the first time** — twenty-five recorded, twenty-five closed.
    Which says the last pass found everything it found, and nothing more.

74. **ALL FOUR WATCHED, AND THE INSTALLER GOT ONE WRONG IN A WAY ONLY RUNNING IT SHOWED.**
    2026-09-06. Control plane `c588ee2`.

    **ADR-0027, on hardware.** Killed Appium for `cf-4` on the lab and read the journal:

    ```
    10:41:28  no automation endpoint is serving cf-4; `webdriver` dropped for it
    10:41:28  Appium for cf-4 is no longer ready — withdrawing `webdriver` for that device on the
              next heartbeat. Every other device on this host, and every live session, is unaffected.
    10:41:31  automation endpoint for cf-4 is http://…; `webdriver` advertised for it
    10:41:31  Appium for cf-4 is ready — `webdriver` advertised again on the next beat
    ```

    **`MainPID` 9173 before and 9173 after.** Withdrawn and restored in THREE SECONDS, one device,
    no restart, no cold boot, the other three untouched. The same sequence used to start a 60s timer
    and then take the host down for thirteen minutes.

    **D18/D19 earned their keep on the first run.** `check-deployed.sh` immediately reported the lab's
    checkout at `6c1202e` against a `main` of `c588ee2` — the tree the worker and the boot unit both
    `ExecStart` from, behind, and nothing else would have said so. Brought forward, and it now reads
    "The farm is running main."

    **D2 on the real handset**: `SM-S918B … not reported · last heard from this device 8d ago`, and
    it is the ONLY row carrying that note — the four Cuttlefish devices, whose host is beating, keep
    a bare "not reported". That is the whole distinction: one is fixed by plugging a machine in, the
    other by looking at the device.

    **AND THE INSTALLER WROTE THE WRONG USER INTO THE UNIT.** `RUN_USER="${SUDO_USER:-$USER}"` looks
    obviously right and is wrong through a nested sudo: `gcloud compute ssh` as one account, then
    `sudo -u rkcr070707`, and `SUDO_USER` is the OUTER login. The unit installed as
    `User=rakeshkumarbarik` on a farm whose devices belong to `rkcr070707` — and cvd's instance
    database is per-uid, so that unit would have found no devices and built a second set. Worse, as
    the wrong user it could not read `deploy/.state/worker.env`, so `CONTROL_PLANE_URL` would be
    empty, the device-host guard would not fire, and it would die on `BACKUP_BUCKET` — **D13, exactly,
    re-created by the fix for D20.**

    It now resolves `stat -c '%U' "$REPO_ROOT"`: the owner of the checkout is the account that owns
    the cvd database, the snapshots and `deploy/.state`, and it is a fact about the machine rather
    than about how somebody happened to invoke the script. Caught by installing it for real and
    reading the file back — `bash -n` passes either way, and so would any test that did not install.

    Also fixed: the unit's `Documentation=` carried a hardcoded `/opt/mfarm` that no substitution
    touched.

    Lab stopped, farm at 4 READY.

75. **THE DOCS, BROUGHT INTO SYNC — AND SEVEN CLAIMS THAT WERE FALSE WHEN CHECKED.** 2026-09-06.

    Asked to get every document in sync and to say where each part stands, what is working, what is
    not, and in what order to pick things up. Done by RE-DERIVING rather than editing, because the
    thing being fixed was exactly the habit of editing around a stale claim.

    **`docs/INDEX.md` — the declared "one page" — was pinned at `95f6701` / migration 022, thirteen
    days and sixteen migrations behind.** Its §11 "What is next" carried four claims that were false:

    - *"bounded escalation for a stuck reset — today it is re-offered on every heartbeat forever"* —
      built as migration 032 / ADR-0019.
    - *"publishing is blocked because every package is private"* — `@mfarm/cli` is published
      (ADR-0023); the three that are private are private on purpose.
    - *"observability has no host metrics"* — `mfarm_host_last_heartbeat_timestamp_seconds` and
      `mfarm_tunnel_hosts_connected` both exist.
    - *"Milestone 0 … has never run on hardware"* — the physical path is built and was verified.

    One claim in that section WAS still true and is kept: rate limiting is in-memory, so the API is
    single-instance. That is the value of checking rather than assuming in either direction.

    **New: `INDEX.md` §4a, "Where each part actually stands"** — console, API, hub, virtual devices,
    physical devices, agent, deploy, observability, video, timeline — each with its state and its
    honest caveat. And §11 rewritten as an ordered priority list with the reasoning, headed by the
    only question that is not a capability: whether a four-device farm goes in front of a second
    team.

    **`HANDOFF.md`'s own header was four days and twelve entries stale**, which is the failure it
    documents. It now says to read the numbered log when the two disagree, and why: a dated entry
    cannot rot, a present-tense one does.

    **Also corrected**, each verified first: `START_HERE.md` (a dead commit and "two Cuttlefish"
    where there are four), `RUNBOOK.md` and `EXECUTION_MODEL.md` (the same count),
    `E2E_MVP_PLAN.md` (a historical doc, so corrected IN PLACE with a date rather than rewritten),
    and `AGENT_BUILD_PLAN.md` (a stale test count, and a hardware claim I deliberately did NOT
    upgrade — nobody has been able to exercise that path since the handset's host went quiet).

    **NO NEW STATUS PAGE, deliberately.** The obvious move was `docs/STATUS.md`. This repo already
    has four documents that claim some part of that role, and adding a fifth adds a surface that
    decays without adding a fact. The status went into the page that already says it is the one to
    read.

76. **THREE DOCUMENTS, AND THE REASON THE ONE PAGE HAD TO STOP BEING ONE.** 2026-09-06.

    Rakesh asked for exactly three: progress/status, defect management, and what changed and what we
    have — so that opening the repo tells you what it does, what is done, what is pending and what it
    costs. I had argued one turn earlier AGAINST adding a status page, on the grounds that a fifth
    document is a fifth surface to decay. He asked anyway, and he is right for a reason my objection
    missed.

    **The objection was about count; the real problem was MIXTURE.** `INDEX.md` carried status,
    decisions and roadmap in one file, and those three things decay at completely different rates —
    status weekly, defects on their own lifecycle, decisions never. Keeping them together meant the
    parts that never change dragged the part that changes constantly out of date, and nothing forced
    a re-read. That is exactly how it ended up thirteen days behind with four "pending" items already
    built. **Splitting by rate of change is not more surface; it is less, because each file now has
    one reason to be edited.**

    - **`docs/STATUS.md`** — what the app is, the cost table (the ₹65/hour device host is 95% of the
      bill and shapes every operational decision in the repo), where each part stands with its
      honest caveat, what is pending in priority order, the measured numbers, and how to verify any
      of it. Opens with the three-document map.
    - **`docs/DEFECTS.md`** — unchanged as a register, with a preamble that makes it a management
      document: the rule for when a defect closes (fixed AND verified on the farm, because twice
      this month a merged fix was inert), and where they come from — **all 25 found by using it,
      none by the 1441-test suite.**
    - **`docs/DIRECTION.md`** — the four pivots with dates and what each reversed, what we have as
      capabilities, and the decisions/roads-not-taken/invariants/lessons carried over VERBATIM from
      INDEX rather than retyped, because that content was correct and re-typing it is how a
      transcription error gets in.

    **`INDEX.md` is now four lines and a signpost.** Kept at that filename because a lot of things
    link to it, and it says why it shrank — a page that stops being the answer should explain
    itself rather than quietly redirect. README, HANDOFF's header and START_HERE all retarget to the
    three, and every internal link in all five files was checked to resolve.
