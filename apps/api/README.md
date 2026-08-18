# Phase 1 control plane

The parts of v2 that are expensive to retrofit and independent of the device substrate. None of this
depends on the week-0 spike results, so it is safe to build before the gate clears — if the spikes
come back badly the media path changes, this does not.

```bash
npm install
npm run verify     # db:up + migrate + test
```

Requires Node ≥ 22.6 (native TypeScript stripping — no build step) and Docker.

## Status

All 116 tests pass against a live PostgreSQL 16.

| Suite | Tests | Covers |
|---|---:|---|
| allocator under concurrency | 6 | v2 decisions 3 and 5 |
| tenant isolation (SQL) | 3 | v2 decision 1 |
| reaper | 3 | "never leave a device permanently locked" |
| metering | 1 | v2 decision 6 |
| worker protocol | 5 | v2 decisions 4 and 7 |
| auth boundary | 6 | credential handling |
| principal separation | 4 | tenant vs worker |
| session creation | 6 | v2 decision 2 |
| idempotency | 6 | retry safety |
| tenant isolation (HTTP) | 2 | v2 decision 1 |
| rate limiting | 4 | abuse and error shape |
| worker events | 3 | metering + reset reporting |
| capability negotiation | 7 | v2 decision 10 |
| WebDriver hub | 24 | v2 decision 10 |
| configuration | 27 | what production refuses to start on |
| lifecycle | 9 | probes, reaper scheduling, graceful shutdown |

`npm run typecheck` runs `tsc --noEmit` over the workspace. Node strips types at runtime and never
checks them, so without it nothing here is type-checked at all.

Test files run with `--test-concurrency=1`: `expire_sessions()` and `promote_queued()` operate
fleet-wide by design, which is correct for production and means two suites cannot share one database
concurrently.

## What is implemented

**Tenancy** — `org_id` on every tenant-owned table, RLS enabled *and* forced, default deny. Tenant
identity travels as a transaction-local setting so it cannot leak across pooled connections.

**Allocation** — `allocate_device()` picks and claims a device with `FOR UPDATE SKIP LOCKED` and
creates the session in the same transaction. Concurrent callers take different rows rather than
queueing behind each other. A partial unique index (`sessions_one_live_per_device`) enforces the
one-live-session-per-device invariant at the database level, so an application-layer regression fails
the transaction instead of handing one device to two tenants.

**Fencing** — every allocation bumps a monotonic counter on the device. The token travels with each
worker command; a client that was partitioned and reconnects presents a stale fence and is rejected.

**Reset** — release sends a device to `CLEANING`, never straight to `READY`. It becomes allocatable
only when a worker confirms a snapshot restore with a matching fence.

**Metering** — append-only, idempotent by a worker-generated `event_id`, so retries do not
double-count.

**Worker protocol** — versioned with capability negotiation. Newer workers are accepted and
downgraded rather than rejected, because workers upgrade first during a rollout. A device that cannot
`snapshot-reset` registers and is monitorable but is never schedulable — it would leak the previous
tenant's state.

## Bugs the tests caught

Worth recording, because these are the kind that ship silently — each one looked correct in review
and only failed under a test that specifically went looking for it.

**1. `RETURNS TABLE` column names shadow table columns in plpgsql.** `allocate_device` originally
returned columns named `state` and `fence`, which plpgsql resolved to the OUT parameters instead of
`sessions.state` / `devices.fence`, raising `column reference "state" is ambiguous` — but only at
call time, not at `CREATE FUNCTION` time. OUT columns are now `o_`-prefixed.

**2. Superusers bypass RLS unconditionally.** The first run had every policy defined correctly and
`FORCE ROW LEVEL SECURITY` set, and org B could still read org A's sessions — because the app was
connecting with the migration role, which is a superuser, and `rolbypassrls` overrides everything.
Policies read as enabled while doing nothing.

**3. A cross-tenant authorization hole in `release_device()`.** SECURITY DEFINER functions execute as
the owner, so RLS does not apply to them — and `release_device()` filtered on session id alone. Any
authenticated tenant could end any other tenant's session given only its UUID, and the RLS policies
on `sessions` offered no protection because the function never ran under them. `session_activate()`
had the same shape. Both are now org-scoped explicitly (`005_scope_session_mutations.sql`).

The general rule this implies, for every SECURITY DEFINER function added from here on: **bypassing
RLS is the entire point of the marker, so authorisation has to be re-implemented inside the function
body.** There is no ambient protection to fall back on.

This is why `db.ts` keeps two pools: `appPool` (role `mfarm_app`, no superuser, no BYPASSRLS) for all
request handling, and `systemPool` (owner) for migrations and fleet operations only. **If you add a
code path that touches tenant data, it must use `withTenant`.** A tenant query on `systemPool` is
unprotected and will look fine in every test that does not specifically check isolation.

**4. The rate limiter never returned a 429.** `@fastify/rate-limit` *throws* whatever
`errorResponseBuilder` returns, and ours returned a plain response body. An unrecognised throwable
falls through to the generic branch of the error handler, so every rate-limited request came back as
`500 Internal error` and was logged as an unhandled crash — on the one path whose job is to protect
the service under abuse. The builder now returns an `ApiError`, and any client error the framework
raises with a status attached (413 from `bodyLimit`, 415, 429) is rendered with that status instead
of being flattened into a 500.

**5. Unauthenticated requests were never rate limited.** The auth hook rejected an unknown credential
in `onRequest`, and `@fastify/rate-limit` attaches per route — route hooks run *after* every
instance-level `onRequest` hook — so the request was dead before the limiter counted it. Key guessing
against `/v1/*` and registration-token guessing against `/v1/workers/register` were unlimited, at one
database round trip each. Auth is now split: resolve the principal in `onRequest`, let the limiter
count, then fail closed in `preParsing` (after route hooks, still before any body is read).

**6. Concurrent retries of one `Idempotency-Key` allocated two devices.** Check-then-do-then-record
only protects a retry that arrives *after* the first request finished, and the retry that matters is
the one sent because the first is taking too long. Both missed the check, both allocated, and the
customer was billed twice for one session. The key is now claimed before the work starts; the loser
gets a 409 `idempotency_in_flight`, and a failed request releases its claim so the next retry is not
locked out.

**7. `expire_sessions()` counted devices, not sessions.** `GET DIAGNOSTICS ROW_COUNT` reports the last
statement, which was the device update. `sessions.device_id` is `ON DELETE SET NULL`, so a session
whose device left the fleet expired while updating zero device rows — and the reaper reported that it
had done nothing, during exactly the fleet churn that makes expiry interesting
(`007_expire_count.sql`).

## HTTP layer

`buildServer()` returns a Fastify instance; tests drive it with `inject()` so no port is bound.

| Route | Principal | Notes |
|---|---|---|
| `GET /health` | none | liveness. No I/O, cannot fail while the process lives |
| `GET /ready` | none | readiness. Queries both pools, 503 when either is down |
| `GET /v1/devices`, `/v1/devices/:id` | tenant | RLS-filtered catalogue |
| `POST /v1/sessions` | tenant | 201 allocated, 202 queued. Honours `Idempotency-Key` |
| `GET /v1/sessions/:id` | tenant | |
| `DELETE /v1/sessions/:id` | tenant | |
| `POST /v1/apps` | tenant | APK upload, streamed to disk. 201 new, 200 already in the library |
| `GET /v1/apps`, `/v1/apps/:id` | tenant | the org's build library |
| `GET /v1/apps/:id/blob` | worker | **only** with an `installId` this host is holding |
| `POST /v1/sessions/:id/installs` | tenant | 202 — queues an install for the session's device |
| `GET /v1/sessions/:id/installs`, `/v1/installs/:id` | tenant | outcome, with the worker's own error text |
| `POST /v1/workers/register` | registration token | issues the worker credential |
| `POST /v1/workers/heartbeat` | worker | also carries down pending resets and app installs |
| `POST /v1/workers/events` | worker | batched metering + reset + install reports |
| `GET /wd/hub/status` | none | WebDriver readiness probe |
| `POST /wd/hub/session` | tenant | W3C or JSONWP new session |
| `GET /wd/hub/sessions` | tenant | this org's live WebDriver sessions |
| `DELETE /wd/hub/session/:id` | tenant | quit |
| `ANY /wd/hub/session/:id/*` | tenant | proxied to the device's automation server |

Every `/wd/hub/...` route is also served at the root (`POST /session`, …): Appium 2 clients default
to `/`, Selenium Grid and Appium 1.x to `/wd/hub`, and the migration has to be one URL change either
way.

**Two principals, never interchangeable.** A worker token cannot read tenant data; a tenant key
cannot post worker events. Authentication is default-on — only paths in `PUBLIC_PATHS` skip it, so
forgetting a guard fails closed.

**Session tokens are Ed25519, not HMAC.** `POST /v1/sessions` returns the worker endpoint plus a
120-second signed token the worker verifies offline — no callback to the API on the hot path
(v2 decision 2). Workers hold only the public key, so a compromised host can verify but never mint.
The token is audience-bound to one host id, so it is not replayable elsewhere.

**Idempotency.** `Idempotency-Key` on session creation replays the stored response. The key is
claimed *before* the allocation runs, so a retry sent while the first request is still in flight gets
a 409 `idempotency_in_flight` instead of a second device; a failed request releases its claim.
Reusing a key with a different body is a 409 rather than a silent replay of the wrong thing. Keys are
scoped per org, so two tenants using the same key value do not collide, and the reaper drops them
after 24 hours.

## The app library

Upload a build once, install it onto a device a session holds — outside Appium, so the interactive
path can get an app onto a phone without a test suite (MVP plan flow 5).

**A build is its digest.** `POST /v1/apps` streams the body to a content-addressed store under
`APP_STORE_DIR` and answers 200 rather than 201 when the org already had those exact bytes, so a CI
job that uploads on every run costs one row and one copy. The package name, version and label are
parsed out of the APK's own binary `AndroidManifest.xml` (`src/apk.ts`) rather than taken from the
client — everything downstream acts on the package name, so a caller that could set it could claim
someone else's package.

**An install is a job, not a call.** The control plane cannot dial a worker; traffic only ever goes
the other way. So `POST /v1/sessions/:id/installs` returns **202** and writes an `app_installs` row,
the next heartbeat carries it down to the host that owns the device, and the worker confirms through
`POST /v1/workers/events` — the same shape resets use, which makes a missed install self-healing and
bounds the delay at one beat (10s).

**The install id is the worker's authorization.** `GET /v1/apps/:id/blob` refuses without one, and
the query behind it requires an unfinished install of that exact build on a device belonging to the
calling host. There is no route by which a worker can enumerate or fetch an org's builds.

Three states, and no `INSTALLING`: a worker reports the outcome, never the start, so a worker that
dies mid-install leaves the row `PENDING` and the next beat re-delivers it (`adb install -r` is
repeatable). An install whose session ends before delivery is swept to `FAILED` by the reaper, so
nothing polls a job that will never run.

## The WebDriver hub

v2 decision 10, and the adoption path: a team migrates by changing one URL and adding two
capabilities. Their suite, their client library and their CI config are untouched.

```python
driver = webdriver.Remote(
    "https://mfk_your_key@hub.mfarm.dev/wd/hub",
    options=UiAutomator2Options().load_capabilities({
        "platformName": "android",
        "mfarm:region": "eu-central",
        "appium:app": "https://builds.example.com/app.apk",
    }),
)
```

The key rides in the URL because that is the only thing a WebDriver client is given. It arrives as
HTTP Basic, in either field, and only tenant keys are accepted that way — a worker credential has no
business in a URL. `Authorization: Bearer` works too for clients that can set headers.

**Vendor capabilities.** `mfarm:region` (required unless `MFARM_DEFAULT_REGION` is set, or a session
is being bound), `mfarm:tier`, `mfarm:ttlMinutes`, `mfarm:queueTimeoutSeconds` (0 = fail immediately
when the fleet is full; anything higher holds the request open until a device frees up), and
`mfarm:sessionId`. Non-standard capabilities
without a vendor prefix are rejected with a message naming the key, which is exactly what Appium 2
does — a suite that works there works here.

**Binding: driving a session you already hold.** By default `POST /session` allocates its own
device. A caller that already has one — `mfarm run`, or anything using `POST /v1/sessions` — passes
the session id instead, either as `mfarm:sessionId` or in the URL:

```
https://mfk_your_key:<session-id>@hub.mfarm.dev/wd/hub
```

The password half of the Basic credential is otherwise unused, and it is the only carrier a WebDriver
client offers that needs no change to the suite. Both forms mean the same thing and must agree if
both are present.

A bound session belongs to its caller: the hub drives the device but releases nothing, not on failure
and not on `driver.quit()`. Quit ends the WebDriver session only, so a suite that quits between tests
re-binds the same device instead of allocating a new one for each. Without this the hub allocated a
*second* device for every `mfarm run` and billed for it (ADR-0002 D1). The allocation capabilities
above are refused alongside a binding rather than ignored — the device was chosen when the session
was created, and `mfarm:region` is checked against it rather than obeyed.

**The session id is the mfarm session id.** Not Appium's. One id in the test log, the API, the
artifact index and the invoice, instead of a correlation exercise during an incident.

**This endpoint proxies, which is a deliberate exception to "never proxy the data plane."** A
WebDriver client resolves one base URL and uses it for the session's whole life — there is no
redirect in the protocol — so "one hub URL" and "connect straight to the worker" cannot both be true,
and the hub URL is the thing customers are buying. It is also the safer half: an exposed Appium port
is unauthenticated device control, so the automation server stays on the internal network with the
hub as its only ingress. The cost is one hop of a few milliseconds on commands that already take tens
to hundreds inside the device, and it never touches the glass-to-glass number.

**Failure paths give the device back.** Appium refusing the session, the host being unreachable, the
client quitting: each releases the allocation. A device stuck in `RESERVED` against a session that
never existed is capacity billed to nobody and usable by nobody, and it is the way this endpoint
would quietly eat a fleet.

**Allocation is capability-aware.** A WebDriver session demands a device declaring `webdriver`, which
a host advertises by registering an `automationEndpoint`. The constraints are recorded on the session
(`sessions.constraints`) so `promote_queued()` re-applies the same ones — previously it matched on
region alone, so a queued Android session could be promoted onto an iOS device.

## Not yet built

Artifacts and logcat streaming. App **launch** and **uninstall** outside Appium are not here either —
only upload and install are — and the device-side seam for them is the same optional-method pattern
`installApp` uses. Rate limiting is in-memory, so limits are per API instance; moving to Redis is
required before running more than one.

## Running it

`npm start` (`node --experimental-strip-types src/main.ts`). `buildServer()` still defaults the
reaper to off because that is right for tests; `main.ts` is what turns it on, from
`REAPER_INTERVAL_MS`.

`src/config.ts` reads the environment once and refuses to start with every problem listed at once,
rather than one per restart. In production it additionally refuses:

| Refusal | Because |
|---|---|
| no `SESSION_SIGNING_KEY` / `SESSION_PUBLIC_KEY` | the ephemeral fallback changes on every restart and every replica, so tokens in flight stop verifying |
| half a signing keypair | `loadSigningKey()` needs both and silently falls back, so the deployed key is not the key in use |
| `DATABASE_URL` still the local-dev default | localhost, a committed password, and a tmpfs data directory |
| a committed password on any host | rotating the host does not make it a secret |
| `DATABASE_URL` == `APP_DATABASE_URL` | the app would handle requests as the owner, and owners bypass RLS |
| `REAPER_INTERVAL_MS` of 0 (or under 1s) | nothing expires sessions, promotes queued ones, or purges `idempotency_keys` |

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | `0.0.0.0` because binding loopback in a container is a healthy, unreachable process |
| `DATABASE_URL` | local dev | owner role; migrations and fleet ops |
| `APP_DATABASE_URL` | local dev | `mfarm_app`; every request handler |
| `SESSION_SIGNING_KEY` / `SESSION_PUBLIC_KEY` | ephemeral (dev only) | |
| `REAPER_INTERVAL_MS` | `30000` | |
| `RATE_LIMIT_MAX` | `120` | per org per minute, per instance |
| `LOG_LEVEL` | `info` | validated here because pino throws on an unknown level |
| `SHUTDOWN_GRACE_MS` | `15000` | fits inside Kubernetes' default 30s grace |

Shutdown on SIGTERM/SIGINT: stop accepting connections, drain in-flight requests up to
`SHUTDOWN_GRACE_MS`, clear the reaper interval (an `onClose` hook, so a `reap()` already in flight
finishes its transaction), then `closePools()` — pools last, because ending one while a handler
still holds a client turns a request that was about to succeed into a rolled-back transaction. A
second signal exits immediately. An `uncaughtException` or `unhandledRejection` logs and exits
non-zero rather than serving from a state nobody has reasoned about.

## Production notes

- `mfarm_app` is created with a local-dev password in `001_init.sql`. Rotate it:
  `ALTER ROLE mfarm_app PASSWORD '<from env or IAM>'`.
- The allocator functions are `SECURITY DEFINER` and owned by the superuser, which is a privilege
  boundary worth tightening before launch — give them a dedicated owner role holding only the grants
  they need. `SET search_path = public` is already pinned on each, which closes the main injection
  vector.
- `docker-compose.yml` mounts the data directory on tmpfs. That is deliberate for test speed and
  makes the database non-durable — it is for local testing only.
