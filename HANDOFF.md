# MFARM_CLOUD — state of play

Last updated 2026-08-17. Read this first in a new session.

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

**289 tests pass, 0 fail**, against a real PostgreSQL 16. No mocks for anything that matters.

```
apps/api/         control plane + service entrypoint   172 tests
apps/cli/         mfarm CLI                             48 tests
workers/agent/    worker agent, Appium supervisor,      69 tests
                  automation gateway
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
or under 1000ms, or a misspelt `NODE_ENV`.

`/health` is liveness — no I/O, never fails while the process lives. `/ready` checks both pools and
returns 503. They must stay separate: an orchestrator restarts on failed *liveness*, so a
DB-touching liveness check turns a brief blip into a restart loop that outlasts it. Both probes are
exempt from the rate limiter, because a 429 is indistinguishable from a dead pod to a kubelet.

Shutdown drains in-flight requests, clears the reaper in `onClose`, then closes pools — in that
order, and the order is load-bearing (see the ADR). The reaper is now actually on.

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

- Blockers 4 and 5 below.
- App install / launch outside Appium, logcat streaming, video recording, artifacts
- Web UI (deliberately last — it is the demo surface, not the product)
- Publishing. Every package is `"private": true`, so `npx mfarm` does not work yet and the Action's
  `npx --yes mfarm@latest` has nothing to resolve.

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

**4. `appium:udid` is set to the mfarm local id, not the adb serial.** (ADR-0003, B3)
`webdriver.ts` sends `cf-1` / `avd-1`; UiAutomator2 matches against `emulator-5560` /
`0.0.0.0:6520`. Overriding the capability is right, the value is wrong. **Expect this to be the
first thing that breaks on real hardware.** Related: concurrent sessions on one Appium each need a
distinct `appium:systemPort` or the second fails, and nothing sets it.

**5. Multi-instance is blocked twice over.** (ADR-0001) Rate limiting is in-memory, so per-instance.
And the reaper now runs inside the API process, so N instances run N fleet-wide reaps. Both are
correct at N=1 and both degrade silently rather than failing. **Before a second instance:** Redis
for the limiter, and a single owner for the reaper (leader election, advisory lock, or an external
scheduler).

## Known issues and constraints

1. `devices/cuttlefish.ts` `cvd` flags are **unverified against a real install** — upstream moves.
   Check them against whatever `bootstrap_cuttlefish.sh` installs.
2. The WebDriver hub has never spoken to a real Appium server, and the Appium supervisor has never
   supervised one. Both are tested against fakes that answer correctly; a real driver will disagree
   about something. The supervisor also detects **process death only** — a wedged-but-alive Appium
   answers `/status` 200 forever and stays advertised.
3. `apps/api/docker-compose.yml` mounts Postgres data on tmpfs — fast, non-durable, local only.
4. `mfarm_app` has a local-dev password in `001_init.sql`. Rotate before any deployment. (`config.ts`
   now refuses to boot in production if it sees it.)
5. Allocator functions are `SECURITY DEFINER` owned by the superuser. Give them a dedicated owner
   role with minimal grants before launch.
6. Tests run `--test-concurrency=1`: the reaper is fleet-wide by design, so suites cannot share one
   database concurrently. **This also means parallel agents must not run DB-backed suites at the
   same time.**
7. `db.ts` reads its connection URLs independently of `config.ts`, so the dev-default literals now
   exist in two files and will drift silently. Collapse by having `db.ts` take them from config.
8. `PG_POOL_MAX` / `PG_SYSTEM_POOL_MAX` are unvalidated — a typo becomes `NaN` at pool construction.
9. On the queued path the CLI cannot produce `MFARM_DATA_PLANE_ENDPOINT` / `MFARM_SESSION_TOKEN`,
   because `GET /v1/sessions/:id` returns no `dataPlane` block. (ADR-0002, D2)

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

Blockers 1, 2 and 3 are closed. What is left, in this order:

1. **Blocker 4 — `appium:udid`.** The highest-value thing buildable without hardware, and the one
   most likely to break first on real Cuttlefish. The worker has to register the adb serial
   alongside the local id — another `devices[]` field, the same shape as the endpoint that just
   landed — and the hub has to send that instead of `cf-1`. `appium:systemPort` needs a distinct
   value per concurrent session at the same time, and nothing sets it.
2. **A metered day on nested-virt hardware** (see `docs/MVP_PLAN.md` Tier 1). Verify the `cvd` flags,
   prove snapshot/restore under `guest_swiftshader`, run spikes 1 and 2a, and finally point a real
   Appium 2 at a real Cuttlefish instance. The gateway and the supervisor have only ever spoken to
   fakes that answer correctly; a real driver will disagree about something.
3. **Phase 2 onward** in `docs/MVP_PLAN.md` — durable Postgres before anything else, since
   `docker-compose.yml` still mounts data on tmpfs.
