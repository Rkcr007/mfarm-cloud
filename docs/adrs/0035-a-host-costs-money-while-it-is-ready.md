# ADR-0035 — a host costs money while it is ready, and the meter cannot see it

**Status:** Accepted · 2026-09-11 · migration 050

## Context

On 2026-09-11 the device host ran for **twenty hours and forty-eight minutes** after a verification
that needed it for about two. At ₹65/hour that is roughly ₹1,350, against a farm whose entire
operational design is *"the device host is ~95% of the bill, so it is stopped between sessions"*
(`docs/STATUS.md` §2).

Nothing in the product said so. The console's status bar read **"4 of 5 ready"** the whole time —
true, useful, and completely silent about the fact that *ready is the expensive state*. The only
signal that the farm was on was knowing you had switched it on.

**The obvious fix would have been the wrong one.** The product review's P2 was "the landing page
promises per-device-minute billing, but the console has no usage view", and building that view is
what this work was picked to do. It would not have helped. `metering_events` records device-seconds
per org and records them *correctly*; across those twenty hours it recorded a few minutes, because
the devices were idle. A per-org usage page would have shown a nearly empty chart while ₹1,350 left
the account.

## Decision

**Report two different things, and never let the page blur them.**

| | what it measures | where it comes from |
|---|---|---|
| **Usage** | device-seconds a session actually held | `metering_events`, per org, already correct |
| **Cost** | host-hours powered on, allocated or not | `hosts.up_since` (new), × a configured rate |

These diverge by twenty hours in the incident above, and a reader who conflated them would conclude
the meter was broken. The Health screen carries both, adjacent, with the distinction in the copy.

### `hosts.up_since`, stamped at registration

A worker registers once per boot. Not on *every* registration, though: ADR-0027 has a host
re-register when its device set changes, which on a laptop with a phone plugged in is routine and
does not restart the machine. Stamping unconditionally would reset the clock whenever somebody
plugged in a handset, and the number people read to decide "should this be off" would quietly always
be small. So it is kept while the host was already `UP` and stamped only when it was `DOWN`,
`QUARANTINED`, or has never reported one.

**Not backfilled.** Every host existing at migration time has been up for an unknown length of time,
and `now()` would state that all of them came up the instant the migration ran — a fact the console
would then display with a straight face.

**Uptime is null for a host that is not running.** `up_since` on a stopped machine is the last time
it came up; subtracting it from now reports a VM switched off on Tuesday as having run for four
days, which is the exact opposite of the fact this exists to report.

### The rate is configuration, never a default

`HOST_HOURLY_COST` and `COST_CURRENCY`. **MFARM is self-hosted**: what a host costs is a fact about
somebody's cloud bill, and a number invented in `config.ts` would be rendered by the console as
though the farm had measured it. Unset means elapsed time with no money in it — which still catches
the incident, because *"host up 20h"* is alarming on its own.

One rate rather than a column per host: the device host is ~95% of this farm's bill, so a single
number is within a rounding error, and a per-host rate is a table, a migration and an admin screen
for a farm with two machines.

### `GET /v1/hosts`, admin-only

`002_rls.sql` revokes `hosts` from `mfarm_app` entirely — hosts are fleet metadata, not tenant data
— so this reads on the system pool and the `WHERE` clause *is* the authorization, the same shape
`account.ts` documents for its own writes. A shared host (`org_id IS NULL`) is visible to any org
admin; a dedicated one only to its owner.

**A known limit, named rather than designed around:** on a farm with more than one tenant, the cost
of a *shared* host is operator information and is not attributable to whoever asked. This farm has
one org and that org is the operator. When an operator role exists, the cost block belongs behind it;
the rest of the payload does not.

### The status-bar segment appears rather than sits at zero

Hidden entirely when nothing is powered on. A permanent "₹0" is a number people stop seeing, and the
whole value of the segment is that its appearance means something. Time first, money second and only
if configured.

## Consequences

**This also closes a gap the review listed separately.** Migration 044 has collected host disk, load
and memory since 2026-09-07 and it reached Prometheus and nothing else; the Health screen carried a
card headed *"What this page cannot see"* whose text read "the API exposes no host read endpoint".
That card is deleted, not softened — it was true the day it was written and false from the moment
this shipped, which is the fifth instance of the *comments as rumour* family in this repo.

**It does not close the "agent version" half.** There is no `agent_version` column on `hosts`; there
is `protocol_version`, which is what the agent *speaks* and moves when the protocol does, not when
somebody ships an agent. Reported as what it is rather than relabelled into the field the review
asked for.

**The gauges are shown with the age of the reading attached.** All five read green on a host that
stopped reporting an hour before its disk filled, which is why migration 044 added `stats_at` in the
first place. A number here without "as of" would be the most confident wrong answer on the page.

## Alternatives considered

**Alerting instead of a display.** `MfarmFarmBehindMain` already shows this farm has Prometheus
alerting, and "host up with no session for N hours" is a legitimate rule. Rejected as the *first*
move: an alert goes to whoever configured Alertmanager, and the person who leaves a farm on is the
person looking at the console. The display is where the behaviour is. The alert is a good second
step and is not built here.

**Auto-stopping an idle host.** Tempting, and refused. The farm cannot tell "idle" from "between two
suites in a CI pipeline", and a control plane that powers off a machine somebody is about to use
turns a cost problem into an availability problem. ADR-0030 already declined to let the timer touch
the device host for a related reason.
