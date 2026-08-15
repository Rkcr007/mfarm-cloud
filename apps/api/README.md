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

All 39 tests pass against a live PostgreSQL 16.

| Suite | Tests | Covers |
|---|---:|---|
| allocator under concurrency | 6 | v2 decisions 3 and 5 |
| tenant isolation (SQL) | 3 | v2 decision 1 |
| reaper | 1 | "never leave a device permanently locked" |
| metering | 1 | v2 decision 6 |
| worker protocol | 4 | v2 decisions 4 and 7 |
| auth boundary | 6 | credential handling |
| principal separation | 4 | tenant vs worker |
| session creation | 6 | v2 decision 2 |
| idempotency | 3 | retry safety |
| tenant isolation (HTTP) | 2 | v2 decision 1 |
| worker events | 3 | metering + reset reporting |

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

## Three bugs the tests caught

Worth recording, because all three are the kind that ship silently — each one looked correct in
review and only failed under a test that specifically went looking for it.

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

## HTTP layer

`buildServer()` returns a Fastify instance; tests drive it with `inject()` so no port is bound.

| Route | Principal | Notes |
|---|---|---|
| `GET /health` | none | |
| `GET /v1/devices`, `/v1/devices/:id` | tenant | RLS-filtered catalogue |
| `POST /v1/sessions` | tenant | 201 allocated, 202 queued. Honours `Idempotency-Key` |
| `GET /v1/sessions/:id` | tenant | |
| `DELETE /v1/sessions/:id` | tenant | |
| `POST /v1/workers/register` | registration token | issues the worker credential |
| `POST /v1/workers/heartbeat` | worker | |
| `POST /v1/workers/events` | worker | batched metering + reset reports |

**Two principals, never interchangeable.** A worker token cannot read tenant data; a tenant key
cannot post worker events. Authentication is default-on — only paths in `PUBLIC_PATHS` skip it, so
forgetting a guard fails closed.

**Session tokens are Ed25519, not HMAC.** `POST /v1/sessions` returns the worker endpoint plus a
120-second signed token the worker verifies offline — no callback to the API on the hot path
(v2 decision 2). Workers hold only the public key, so a compromised host can verify but never mint.
The token is audience-bound to one host id, so it is not replayable elsewhere.

**Idempotency.** `Idempotency-Key` on session creation replays the stored response. Reusing a key
with a different body is a 409 rather than a silent replay of the wrong thing. Keys are scoped per
org, so two tenants using the same key value do not collide.

## Not yet built

The WebDriver-compatible endpoint, artifacts, and the worker agent itself. The reaper exists as
`reap()` but nothing schedules it. Rate limiting is in-memory, so limits are per API instance —
moving to Redis is required before running more than one.

## Production notes

- `mfarm_app` is created with a local-dev password in `001_init.sql`. Rotate it:
  `ALTER ROLE mfarm_app PASSWORD '<from env or IAM>'`.
- The allocator functions are `SECURITY DEFINER` and owned by the superuser, which is a privilege
  boundary worth tightening before launch — give them a dedicated owner role holding only the grants
  they need. `SET search_path = public` is already pinned on each, which closes the main injection
  vector.
- `docker-compose.yml` mounts the data directory on tmpfs. That is deliberate for test speed and
  makes the database non-durable — it is for local testing only.
