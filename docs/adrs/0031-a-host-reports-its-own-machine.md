---
id: ADR-0031
title: A host reports its own machine on the beat, and an unmeasured number emits no series
status: Accepted
date: 2026-09-07
authors:
  - Claude Code
tags: [observability, metrics, worker, alerting]
extends: [ADR-0003]
---

## Context

Every gauge MFARM publishes is sampled from Postgres by the control plane at scrape time: devices by
state and placement, sessions by state, queue depth, queue age, host heartbeat age, pool
connections, backup freshness. They describe the **fleet**.

All of them are green on a device host whose disk is 98% full.

That host runs four Cuttlefish instances with a 4 GB snapshot each, an app cache `fetchApk` has
never pruned, and every logcat dump the agent has captured, on one volume. When it fills, snapshot
restores fail, devices sit in `CLEANING`, and the farm degrades in a way that reads as a *device*
fault for as long as it takes somebody to ssh in and run `df`. That is the shape of D18: a fact
nobody was measuring, discovered by hand.

`docs/EXECUTION_ROADMAP.md` S7 named the wrong gap. It said queue depth and capacity were
unobservable from Grafana; `collectFleet()` has exported both for weeks, the dashboard graphs them,
`alerts.yml` fires on them, and `metrics.test.ts` has a case called *"queue depth and queue age are
reported"*. The real gap is that nothing observes the **machine**.

It matters more now than it did last week. `docs/RENDER_BASELINE.md` and the encode measurement that
closed S5's gate both concluded the same thing: on this farm the **host's CPU** is the binding
constraint on rendering. A farm whose limiting resource is invisible is a farm nobody can size.

## Decision

**The host's own numbers ride the heartbeat.** Disk free and total, one-minute load, core count,
`MemAvailable` and `MemTotal`, added to the beat body and stored on `hosts` by migration 044.

The beat is the right carrier for the same reasons `resets` and the capability payload are already
on it: it runs every ten seconds, it already carries the worker credential, a missed one costs
nothing because the next is ten seconds away, and it needs no new route, no new auth and no new
failure mode. ADR-0003 made exactly this argument for capabilities.

**Memory is `MemAvailable`, never `os.freemem()`.** `freemem()` is `MemFree`, which excludes the
page cache and therefore sits near zero on any healthy long-running Linux box. A metric like that
pages constantly and is then turned off, which is worse than not having it. On a platform with no
`/proc/meminfo` the field is `null` rather than a substitute, so a developer's macOS box never
publishes a number that means something different from production's under the same name.

**Disk free is `bavail`, not `bfree`.** The difference is the root reserve, and the agent does not
run as root. `bfree` would report space right up until writes started failing.

**An unmeasured value emits no series at all — and this deliberately inverts the rule the rest of
`metrics.ts` follows.** `DEVICE_STATES` is enumerated precisely so that `mfarm_devices{state="READY"}
== 0` keeps firing when the fleet empties, because an alert on a series that vanishes is silent
exactly when it matters. Here the opposite holds: **a zero disk gauge does not read as "unmeasured",
it reads as a full disk.** Zero-filling would have manufactured a critical page for every host
running an agent older than migration 044, on the first scrape after deploy. So `NULL` produces
nothing, and staleness is carried by `mfarm_host_stats_age_seconds` instead — the honest way to say
"these numbers may be old" without inventing a value for them.

**`stats_at` is not `last_heartbeat_at`.** An agent too old to send stats beats perfectly happily,
so reading freshness from the heartbeat column would present a week-old disk reading as current — a
stale number wearing a fresh timestamp, which is worse than no number.

**Liveness outranks observability, enforced by ordering rather than by comment.** The agent measures
*before* the heartbeat's `try` and swallows failures separately. A stats read inside that `try`
would be caught by it and returned as a failed beat, and migration 038 quarantines a host that stops
beating — so a bug in a metric would take the whole machine out of service. On the control-plane
side, a malformed stats block is dropped and the beat still succeeds, for the same reason.

**The worker is authenticated but not trusted to be correct.** Every field is coerced to
null-or-finite-number; a string, a `NaN` or an `Infinity` is stored as `NULL`. Values are *not*
checked for plausibility: a disk reporting more free than total is a bug worth **seeing in a graph**,
not one worth refusing a heartbeat over.

## Consequences

**Four new alert rules, and none of them can fire for a host that has never reported.** That follows
directly from the no-zero-fill decision, and it is asserted from the alerting side as well as the
collector side: a host with only a heartbeat series produces no disk, no load and no staleness
alert. The upgrade is therefore silent on an old fleet rather than noisy.

**Load is judged per core.** A load average of 20 is unremarkable on 32 cores and dire on 4.
`mfarm_host_load1 / mfarm_host_cores` is the expression, which matters immediately: S7.2 is a second
device host, and a raw threshold would be correct for exactly one machine size.

**The beat writes a second row only when stats arrive.** The heartbeat runs six times a minute per
host forever; an unconditional second `UPDATE` would double the write rate of the busiest route on
the farm to carry numbers an older agent does not send.

**A deleted host stops reporting a disk.** These gauges reset with the other fleet gauges on every
collection. Without that, a decommissioned machine's last reading would sit on the dashboard
indefinitely, indistinguishable from one that is still there and still nearly full — an alert nobody
can ever clear.

**This does not measure `cvd` or `adb` health.** Those are also known to the agent and also
unreported, and they are a different kind of measurement: a probe with a timeout rather than a read
of a counter. Disk, CPU and memory are the three that end a farm without anybody noticing, and they
are what this covers.
