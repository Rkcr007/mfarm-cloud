# MFARM_CLOUD — state of play

Last updated 2026-08-16. Read this first in a new session.

## What this project is

A mobile device cloud whose entire differentiation is two numbers: **glass-to-glass latency under
100ms** and **cost under $0.02 per device-hour**. Everything else is table stakes that follows once
those hold.

The strategy is in `product_guide_v2.md`. `product_guide.md` is the original (GPT-authored) v1 plan,
kept for reference — v2 supersedes it. `DEVICE_SECOND_THESIS.html` is the market review.

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

## What is built and verified

**102 tests pass, 0 fail**, against a real PostgreSQL 16. No mocks for anything that matters.

```
apps/api/         control plane   80 tests
workers/agent/    worker agent    22 tests
packages/protocol shared contract
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

Every failure path releases the device. Allocation demands the `webdriver` capability, and the
constraints are recorded on the session so `promote_queued()` re-applies them.

### Worker agent — `workers/agent`

Registration with credential persistence, heartbeat, deterministic-id metering, snapshot reset, and
the WebSocket data plane the browser connects to. Two device tiers: Cuttlefish (target, Linux+KVM)
and AVD (fallback, runs on macOS, cannot meet the latency target and says so).

## What is NOT built

- **The Appium server on the worker.** The hub is finished and tested end to end against a real
  upstream, but nothing supervises an actual Appium 2 process next to a device — the agent only
  advertises `AUTOMATION_ENDPOINT`. This needs a real Android device, so it lands with the hardware.
- CLI (`npx mfarm run`) and GitHub Action
- App install / launch outside Appium, logcat streaming, video recording, artifacts
- Web UI (deliberately last — it is the demo surface, not the product)
- **No service entrypoint.** `apps/api` has no `main` — the server is only ever built by tests.
  `buildServer({ reaperIntervalMs })` now schedules `reap()`, but it defaults to off and nothing
  turns it on. A deployment must, or expired sessions are never collected and a queued WebDriver
  session can only time out.
- Rate limiting is in-memory, so per-instance. Redis required before running more than one API process

## Known issues and constraints

1. `devices/cuttlefish.ts` `cvd` flags are **unverified against a real install** — upstream moves.
   Check them against whatever `bootstrap_cuttlefish.sh` installs.
2. The WebDriver hub has never spoken to a real Appium server. Its upstream in the tests is a stub
   that answers correctly; a real driver will disagree about something.
3. `apps/api/docker-compose.yml` mounts Postgres data on tmpfs — fast, non-durable, local only.
4. `mfarm_app` has a local-dev password in `001_init.sql`. Rotate before any deployment.
5. Allocator functions are `SECURITY DEFINER` owned by the superuser. Give them a dedicated owner
   role with minimal grants before launch.
6. Tests run `--test-concurrency=1`: the reaper is fleet-wide by design, so suites cannot share one
   database concurrently.

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

## Suggested next step

Book the bare-metal box and clear the gate. The hub is written but has only ever talked to a stub;
the same box that runs spikes 1 and 2a can run a real Appium 2 server against a Cuttlefish instance
and prove the migration claim end to end with somebody's actual suite.

Parallel work that does not depend on the spikes: the CLI (`npx mfarm run`) and the GitHub Action,
and a service entrypoint for `apps/api` — there is still no `main`, so nothing runs the reaper.
