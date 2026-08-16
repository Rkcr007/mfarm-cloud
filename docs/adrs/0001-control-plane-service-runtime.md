---
id: ADR-0001
title: Control-plane service runtime — an entrypoint, fail-fast config, split liveness/readiness, and who owns the reaper
status: Accepted
date: 2026-08-16
authors:
  - Ruflo swarm (hierarchical) via Claude Code
tags: [control-plane, runtime, config, health, reaper, deployment]
---

## Context

`apps/api` had no `main`. The Fastify app was only ever constructed by tests, via
`buildServer({ reaperIntervalMs })`. Three things followed from that, none of them visible while the
only consumer was a test suite:

1. **Nothing ran the reaper.** `reaperIntervalMs` defaults to `0` — correct for tests, because the
   reaper is fleet-wide and two suites sharing a database would collect each other's sessions. But
   with no deployment code to override it, `expire_sessions()` would never run in production: a
   crashed client holds its device until a human notices. And `promote_queued()` would never run, so
   a QUEUED session stays queued forever and the WebDriver hub's capacity wait can only time out —
   the queue would be a black hole rather than a queue.
2. **Configuration was read wherever it was needed**, via `process.env.X ?? default` scattered
   across `db.ts`, `tokens.ts`, and `server.ts`. Each default is individually reasonable and
   collectively dangerous: a deployment missing `APP_DATABASE_URL` silently falls back to
   `postgres://mfarm_app:mfarm_app@localhost:5433/mfarm` and either fails at first query or, worse,
   connects to something.
3. **There was one health endpoint** and no articulated difference between "this process is alive"
   and "this process can serve traffic".

## Decision

**1. `apps/api/src/main.ts` is the entrypoint,** started with `npm start`. `buildServer()` stays a
pure factory so tests keep constructing the app without binding a port or scheduling a reaper. The
split is deliberate: composition root separate from composed object.

**2. Configuration is parsed and validated exactly once, at startup, by `apps/api/src/config.ts`.**
`parseConfig(env)` is pure so it can be tested without mutating `process.env`. It reports **every**
problem at once rather than the first — a deploy loop that surfaces one missing variable per restart
costs an hour to get through five of them.

**3. In production the process refuses to start** on any of the following, exiting **78
(`EX_CONFIG`)** so a process supervisor can tell "will never start" apart from "crashed and might
recover":

| Condition | Consequence if allowed |
|---|---|
| Missing `SESSION_SIGNING_KEY` / `SESSION_PUBLIC_KEY` | An ephemeral keypair per process: every restart invalidates every live token, and a second instance cannot verify the first's at all |
| **Half** a keypair | `loadSigningKey()` needs both and silently falls back — the deployed key is not the key in use |
| Unparseable key material | A truncated PEM still has its header, so header-matching validates nothing; parsed with `createPrivateKey` instead |
| `DATABASE_URL` / `APP_DATABASE_URL` at the local-dev default | localhost, committed password, tmpfs data directory |
| A committed password (`mfarm` / `mfarm_app`) on **any** host | Rotating the host does not make it a secret (HANDOFF issue 4) |
| **`DATABASE_URL` == `APP_DATABASE_URL`** | **Request handling runs as the owner. Owners bypass RLS, so every policy reads as enabled while enforcing nothing.** |
| `REAPER_INTERVAL_MS` = 0 | The failure in Context (1) — plus `idempotency_keys` is never purged |
| `REAPER_INTERVAL_MS` < 1000 | Three fleet-wide queries per tick against a 5-connection owner pool |
| Misspelt `NODE_ENV` | Reads as "not production", silently disabling every guard above |

The `DATABASE_URL == APP_DATABASE_URL` check deserves emphasis: it is the startup-time expression of
the most dangerous invariant in this codebase (`db.ts`, and the rule recorded in `HANDOFF.md`). That
misconfiguration produces a system that looks completely correct — policies present, tests passing —
while tenant isolation is off. Catching it at boot is the only cheap place to catch it at all.

Refusing to boot is the correct response to every row. Each is a silent, delayed, hard-to-attribute
failure if allowed through, and a deployment that will not start is a five-minute problem.

`parseConfig(env)` is pure. `loadConfig()` memoises rather than being a module-scope `const`,
because a `const` evaluates at import time — before `main` has a handler to turn a `ConfigError`
into readable sentences.

**4. Liveness and readiness are different endpoints.**

- `/health` — liveness. No I/O. It answers while the process is alive, full stop.
- `/ready` — readiness. Checks both `appPool` and `systemPool`, returns 503 when either is
  unreachable.

The temptation is to have one endpoint that checks the database. That is actively harmful: an
orchestrator restarts a container that fails *liveness*, so a thirty-second database blip becomes a
fleet-wide restart loop that outlasts the blip and turns a degradation into an outage. Readiness
removes an instance from the load balancer and lets it come back. Liveness kills it. They must not
be the same signal.

**5. Graceful shutdown drains before it closes.** On SIGTERM/SIGINT: stop accepting new connections,
let in-flight requests finish up to `SHUTDOWN_GRACE_MS`, clear the reaper interval, then
`closePools()`. Order matters — closing the pools first would fail every request currently in
flight, which is exactly the traffic a graceful shutdown exists to protect. A second signal during
drain forces immediate exit, because an operator sending it twice means it.

**6. The reaper runs in the API process, not as a separate job.** One deployable is worth more right
now than a clean separation, and the reaper is a `setInterval` around idempotent SQL.

## Consequences

**Positive.** `apps/api` is deployable. Misconfiguration is loud and immediate instead of silent and
delayed. The queue actually drains, which makes the WebDriver hub's capacity wait meaningful rather
than a slow path to a timeout.

**Negative, and load-bearing — this is the part to remember.** Decision 6 means that with *N* API
instances, the fleet-wide reaper runs *N* times per interval. The SQL is idempotent so this is
correct, but it is wasteful and it contends. This joins the **already-recorded** constraint that
rate limiting is in-memory and therefore per-instance. Both point at the same gate:

> **Before running more than one API instance:** move rate limiting to Redis, and give the reaper a
> single owner (leader election, an advisory lock, or an external scheduler). Neither is optional at
> N>1, and neither fails loudly — they degrade.

**Negative.** Config validation is now a thing that can itself be wrong, and it sits in front of
every startup. It is covered by tests for exactly that reason.

## Decided during implementation

**Probes are exempt from the rate limiter.** Not in the original brief. Under the global in-memory
limiter `/health` could return 429, which a kubelet cannot distinguish from a dead pod — so one
noisy IP sharing an ingress could restart the fleet. That directly contradicts decision 4's
requirement that liveness never fails while the process lives. No existing test asserted probes were
limited.

**`/ready` returns `{app, system}` up/down only, never the pg error.** A pg failure message carries
host, port, database, and role — a free map of the deployment for anyone curling an unauthenticated
endpoint during an incident. The error is logged, not served. The up/down split is itself a small
disclosure, judged worth it for debuggability; **revisit if `/ready` is ever reachable beyond the
load balancer.**

**Shutdown clears the reaper last, not first.** `app.close()` drains in-flight requests and only
then runs `onClose`, where the interval is cleared. A `reap()` already in flight owns a transaction
on the owner pool and `clearInterval` cannot cancel it, so clearing early would buy nothing and
closing pools early would abort a request that was about to succeed — on session creation, that
leaves a device reserved by a transaction that never committed. A drain that exceeds
`SHUTDOWN_GRACE_MS` logs at error level but still exits **0**: a slow drain is a capacity alert, not
a crash, and exiting non-zero would make every deploy look like a failure.

`unhandledRejection` / `uncaughtException` log and exit 1 **without** attempting a drain — the
shutdown path runs application code, which is precisely what has just proven untrustworthy.

## Known debt this introduces

1. **Config defaults are duplicated.** `server.ts` still reads `LOG_LEVEL` and `RATE_LIMIT_MAX` from
   `process.env`, and `db.ts` reads both connection URLs at module load. `start()` writes resolved
   values back into `process.env` so the logged configuration is the one that runs, but `db.ts`'s
   dev-default URL literals are duplicated in `config.ts` and **will drift silently** if either is
   edited. Collapse by having `db.ts` take its URLs from config.
2. **`PG_POOL_MAX` / `PG_SYSTEM_POOL_MAX` are unvalidated** — read directly by `db.ts`, so a typo
   still becomes `NaN` at pool construction.

## Verification

```bash
cd apps/api && npm run db:up && npm run migrate
cd ../.. && npm test && npm run typecheck
```

`apps/api/test/config.test.ts` asserts each production refusal. `apps/api/test/lifecycle.test.ts`
asserts `/ready` returns 503 on a broken pool, `/health` performs no I/O, and shutdown clears the
reaper and closes pools.

## Related

- `ADR-0002` — the CLI depends on the queue actually draining, and on 202-then-ACTIVE being real
- `HANDOFF.md` — "No service entrypoint" and the in-memory rate-limit constraint this compounds
- `apps/api/src/db.ts` — the two-pool RLS split that `/ready` probes on both sides
