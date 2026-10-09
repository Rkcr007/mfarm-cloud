# ADR-0051 — a retired host can be seen, and put back, from the console

**Status:** Accepted · 2026-10-09 · amends ADR-0038 and migration 056 (who may un-retire a host) ·
closes D74 · no migration

## Context

Migration 056 let an operator retire a host: a timestamp, not a delete, so the machine leaves every
answer about what the fleet is and keeps its history. Two things about it were left undone.

1. **A retired host was on no screen.** Every read of the current fleet filters on `retired_at`, and
   nothing listed the rest. The only trace of a retire was a line in the operations log. The only
   way to undo one was the way 056 defined — the machine registers again — so a mis-click could be
   reversed only by reaching that machine and restarting its agent, and the console could not show
   which machine it had been.
2. **Its devices had not left with it (D74).** `retireHost` quarantines them and leaves the rows,
   for the record. The host list filtered on `retired_at` and three other reads did not: the
   operations centre's device counts (fixed with D73), the tenant's `GET /v1/devices`, and the
   `mfarm_devices` gauges. So a retired machine's devices sat in every tenant's Fleet as
   QUARANTINED, reason "retired: …", with a Recover button that asked a machine nobody would switch
   on again; and one retired host kept `mfarm_devices{state="QUARANTINED"}` above zero for good.

## Decision

1. **The overview lists retired hosts** — `retired[]`: who retired each, when, why, and how many
   devices went with it. Newest first, fifty at most. It is a record: nothing in it is counted,
   costed or alerted on.
2. **An operator can restore one** — `POST /v1/infra/hosts/:id/restore`, audited as `restore-host`,
   behind the same `retire` capability. It clears the `retired_*` columns and lifts the quarantine
   retiring applied, through `release_host_quarantine`, so each device returns to the state it was
   in. This is the same release registration performs for a returning host (D59).
3. **Registration still un-retires.** 056 said "and only registration does"; that is no longer
   true. A beat alone still does not.
4. **A retired host's devices are not in the fleet anywhere.** `GET /v1/devices` leaves them out and
   so do the device gauges. `GET /v1/devices/:id` still answers, because a session that ran on one
   still names it.

## Consequences

- **Restoring does not make a machine answer.** A restored host whose agent is not running is
  quarantined for silence on the reaper's next sweep and reads as not answering, which is true of
  it. The operation's message says when it was last heard from.
- **Restore on a host that is not retired is a no-op**, and in particular does not lift a drain.
- **There is still no way to delete a host.** That is 056's decision and it stands: the cost ledger
  and the device history key on the row.
- **A retired host's device page still offers what any quarantined device's does.** Only the lists
  and the counts changed.

## Alternatives

- **Leave un-retiring to registration.** It is the right evidence that a machine came back and no
  help to the person who retired the wrong row.
- **A separate endpoint for the retired list.** It would keep the overview smaller. The list is one
  indexed read of a handful of rows, and a second fetch would be a second moment in time on a page
  that is built to describe one.
- **Purge.** Deleting the row would tidy the list and throw away what the machine cost and what its
  devices did. Nothing on this farm is short of the space.
