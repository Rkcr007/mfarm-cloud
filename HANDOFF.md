# MFARM_CLOUD — state of play

Last updated 2026-08-18. Read this first in a new session.

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

**352 tests pass, 0 fail**, against a real PostgreSQL 16. No mocks for anything that matters.

```
apps/api/         control plane, entrypoint, metrics   211 tests
apps/cli/         mfarm CLI                             50 tests
workers/agent/    worker agent, Appium supervisor,      91 tests
                  automation gateway, Cuttlefish backend
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
- App install / launch outside Appium, logcat streaming, video recording, artifacts
- Web UI (deliberately last — it is the demo surface, not the product)
- Publishing. Every package is `"private": true`, so `npx mfarm` does not work yet and the Action's
  `npx --yes mfarm@latest` has nothing to resolve.
- Observability gaps, all of which look covered from the dashboard and are not: **no
  backup-freshness alert** (the sidecar logs failures and nothing scrapes it — backups can stop for
  six weeks without a page), **no host metrics** (a full disk takes the database and the backups
  down and nothing here says so first), and **no worker-side metrics** (cvd health, adb
  responsiveness and a wedged-but-alive Appium are invisible except through device state).
- Nothing in Phase 2 has run on real hardware. The images have never been pulled on a box,
  `tailscale serve` has never been run, and no alert has ever been delivered to a person.

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

**6. The media path has no reachability story, and it is not the one ADR-0004 settled.** Raised
2026-08-18 after the failure in known issue 13. `dataplane.ts` carries control and input; **media is
not proxied** — the browser negotiates WebRTC straight to Cuttlefish's own server. That works only
when the client can route to the addresses the host puts in its ICE candidates. On the lab VM it
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

## Rules earned the hard way

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

## Suggested next step

Blockers 1, 2 and 3 are closed; the `cvd` flags and snapshot/restore are verified (B7). What is
left, in this order:

1. **Start the lab VM and take the disk snapshot immediately** — runbook step B10, five minutes.
   As of 2026-08-18 `gcloud compute snapshots list` is empty, so the one-to-two hours of Cuttlefish
   bootstrap and the pinned device image exist on exactly one 150 GB disk that bills ~₹42/day. That
   is one accidental delete away from being redone, and `cvd fetch` can no longer find a build
   without a human at a browser (issue 10).
2. **B8 — real Appium against a real device.** The milestone the whole exercise exists for, and
   still not attempted. `deploy/farm-up.sh` should get the host from cold to a registered device
   without typing the runbook out. The hub has only ever spoken to a stub and the supervisor has
   only ever supervised a fake; **expect a real driver to disagree about something**, and capture
   the exact request and response when it does rather than working around it on a metered box.
3. **B9 — two devices**, which is the first honest look at what the box holds under SwiftShader.
4. **Settle blocker 6 (media routing) in an ADR before any viewer work.** It decides whether a
   browser needs client software, and no code written before that decision is safe from it.
   Interactive video is the *only* thing it blocks — automation is HTTP and TCP end to end.
