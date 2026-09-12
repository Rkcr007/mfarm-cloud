# ADR-0038 — operating the farm is a capability, not a role

**Status:** Accepted · 2026-09-12 · migrations 053, 054

## Context

Everything an operator needs to run this farm lives somewhere a person cannot reach from the
product. Host state, disk, load and memory reach Prometheus behind a token. Service state is
`journalctl` on a box. Power is `deploy/farm-online.sh`, run from a laptop with somebody's personal
`gcloud` credentials. What the product itself showed was two segments in the console's top bar —
`4 of 5 ready` and, since ADR-0035, `host up 20h · ~₹410` — following the reader around every screen
while answering almost nothing.

So the routine operating loop was: open the cloud console, find the VM, SSH in, run commands, read
service status, restart something. Six steps outside the product for work the product is about.

Two things had to be decided before any of that could move inside.

### Who is allowed

Every authorization decision in this codebase is made against `memberships.role`, which is scoped to
**one org**. The machines are not tenant data: `hosts.org_id IS NULL` for a shared host, and
`002_rls.sql` revokes the table from `mfarm_app` entirely for that reason. `routes/hosts.ts` has said
so in prose since the day it shipped — *"when an operator role exists, the cost block belongs behind
it"*.

On today's single-tenant farm, org admin and fleet operator are the same three people. That is
exactly why it had to be written down now rather than later: the day a second tenant arrives,
"org admin" would silently come to mean "may stop the production device host", and nobody would be
re-reading this line.

### What a cost page can honestly say

`hosts.up_since` (050) is a single timestamp, so it describes only the **current** power-on. The
moment a host stops, the twenty hours it ran yesterday are gone. Every question a cost surface
actually needs — what did today cost, what has the month cost, what will it cost, which host is on
and idle — was unanswerable, and `metering_events` cannot stand in: it records what a **tenant
consumed**, and across the twenty-hour incident that produced ADR-0035 it recorded a few minutes,
correctly, because the devices were idle.

## Decision

### 1. A fleet operator capability, orthogonal to org role

`users.operator` (053). Not a fourth value in `memberships.role`: a membership is a relationship
between a person and one org, and operating the fleet is a relationship between a person and the
**farm**. As a membership role the grant would have to be repeated per tenant and would vanish when
somebody was removed from an org for unrelated reasons.

- `requireOperator` gates every `/v1/infra` route. **An API key can never hold it** — the bit exists
  only on the user principal, so there is no shape of credential in a CI runner that reaches it.
- The grant is **re-read on every request**, like `credential_epoch`. A revoke at 10:00 stops working
  at 10:00, not whenever that person's session expires.
- Granted by `src/bin/grant-operator.ts` and by nothing else. An endpoint that can promote somebody
  to fleet operator is an endpoint one authorization bug away from handing over every machine; an
  operator with a shell on the control plane is already the trust root, the same argument
  `create-user.ts` makes about itself.

### 2. Every operation is written down before it is attempted

`infra_operations` (053). One row per attempt, inserted **before** dispatch, settled exactly once.

This inverts the rule `commandLog.ts` lives by, and the inversion is the point. That module is
explicit that a WebDriver command must never be slower or less reliable because it was recorded — a
lost row costs somebody a nicer debugging screen. Here a lost row is a production VM that stopped
with nothing in the system knowing who did it, so the write is synchronous, on the request path, and
a failure to log **cancels the operation**.

Five outcomes, and the two unusual ones carry the weight:

| | |
|---|---|
| `noop` | it was already in that state. Starting a running VM is not a failure and must not be recorded as one, or the log stops answering "did anything actually change". |
| `unknown` | we asked and never found out. **Not a failure.** Reporting failure for an operation that may well have succeeded is how somebody presses Start on a machine that is already starting. |

Append-only is enforced by a **trigger**, not by grants. The API writes on the system pool, which is
the table owner, and an owner can UPDATE and DELETE whatever it likes — a GRANT-based rule would be
the kind of check that cannot come out both ways. The trigger applies to the owner; only a
deliberate `DISABLE TRIGGER` from a psql prompt gets past it.

### 3. Cost is measured from a power ledger, derived by trigger

`host_power_intervals` (054): when each host was on, closed at the **last beat** rather than at the
moment the control plane noticed.

**Derived by trigger from `hosts.up_since` and `hosts.state`, never written by a route.** The obvious
implementation — the start/stop endpoints write a row — undercounts exactly the hours nobody was
watching, because most power transitions do not come from an endpoint and never will: a laptop
script, a GCP maintenance event, somebody in the cloud console, or the machine rebooting itself. A
trigger cannot be forgotten by a new route.

Three rules in it are load-bearing:

- **Only a reaper quarantine closes an interval.** An *operator* quarantine is a drain: the machine
  is switched on, doing nothing, and costing exactly what it cost yesterday. Treating the two alike
  would make draining a host silently stop its meter, and the cost page would report its best
  numbers on its worst days.
- **A beat reopens a closed interval.** The reaper acts at 90 seconds of silence; the heartbeat only
  moves `up_since` after two minutes. A host quiet for 100 seconds trips neither rule, and the first
  implementation recorded it as powered off *forever* while it ran and billed.
- **Silence under-counts rather than over-counts.** A silent host may be off, or may be a running VM
  behind a broken network. The interval closes at the last beat and the row says `ended_by =
  'silence'`, so the ambiguity is on the record rather than resolved by a guess.

### 4. Four freshness values, never two

Every measurement on the Infrastructure page travels with its own age, and every status is `live`,
`stale`, `unavailable` or `unknown`.

This is the specific defect migration 044 needed a paragraph to explain: all five host gauges read
green on a machine whose disk filled an hour after it stopped reporting. So **`machine.status` ages
independently of the heartbeat** — a host beating perfectly with a wedged stats collector shows its
gauges greyed, with how old they are, and raises no disk alert on an hour-old reading.

The one genuinely real-time fact is `TunnelRegistry.has(hostId)`: a socket that either is or is not
connected as the request is served. Its own comment had been asking for this caller since ADR-0011.
It separates `live` from `stale`, and it raises `tunnel-down` — the failure that reads healthiest
while being broken, where a host beats over plain HTTPS while every live view and automation command
fails.

### 5. Named operations only, and the browser never talks to a machine

```
Admin UI ──▶ control plane ──▶ (agent heartbeat | cloud provider API)
```

No generic terminal, no command field, no parameter that reaches a shell. The operations that exist
are enumerated in code, validated server-side, and each one is a row in the log before it is
attempted. The console renders its controls from a `capabilities` block the **server** sends, so a
deployment with no cloud driver cannot draw a Stop button that returns 501 — the shape this repo has
shipped seven times under the name "a control on a false premise".

## Consequences

- The top bar loses its infrastructure segments. `#/infra` gains them, with everything around them
  that makes them actionable.
- A second tenant can arrive without their admins inheriting the fleet.
- Cost answers cover history rather than the current power-on, from the day 054 applies: currently-up
  hosts are backfilled from `up_since`, and nothing earlier is invented.
- `mfarm_definer` needs SELECT/INSERT/UPDATE on the ledger, because the trigger is invoker-rights and
  fires inside `quarantine_host`. Found by a test; without it every reaper sweep would have failed
  with `permission denied`, taking down the mechanism that withdraws a silent host's devices for the
  sake of a cost-bookkeeping detail.

## Alternatives rejected

**A fourth `memberships.role` value.** Cheapest change, and it models the wrong relationship — see
Context. It also makes the grant per-tenant, which is precisely backwards for a farm-wide capability.

**A `fleet_operators` join table.** The shape that looks more correct. It adds a LEFT JOIN to the
hottest query in the product to express one boolean, and the provenance it would have carried is kept
as columns beside the flag.

**An `infra_events` table every writer appends to.** A fourth copy of facts that `infra_operations`,
`device_quarantine_log` and `host_power_intervals` already hold correctly. The first writer to forget
its second write produces a feed that is silently incomplete — worse than no feed, because it looks
complete. The events endpoint reads those three instead.

**Computing cost from `metering_events`.** It measures the right thing for billing a tenant and the
wrong thing for operating a farm. ADR-0035 made this argument already; 054 is its data.
