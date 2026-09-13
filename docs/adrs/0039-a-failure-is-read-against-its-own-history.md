# ADR-0039 — a failure is read against its own history, and a run against what it held

**Status:** Accepted · 2026-09-14 · no migration

## Context

The run screen answers "what failed on this run" and stops there. The two questions a person asks
next are not answerable from it:

1. **Is this new, or does it always do this?** A red row on a run is read completely differently
   when the same test failed on four of the last five runs. Without that, every failure is triaged as
   though it were the first, and a known flake costs somebody an hour on every run it lands on.
2. **What did this run cost?** ADR-0035 put host cost on the Health screen and deliberately kept it
   apart from usage. A run is where usage is attributable — it is the unit a team budgets CI in — and
   the rate already exists in configuration.

Console v2 draws both on the run detail. This ADR is the backend half: `GET /v1/runs/:id` gains
`run.deviceMinutes`, `run.cost` and `failures[].history`.

## Decision

### A test is its name, within the org

`history` lists, for each failing test, the last **20** runs *in the same org* that reported a result
with the **same name** — this run included, oldest first, each marked `current` or not.

**Name is the only identity there is.** The suite sends a name (`POST /v1/sessions/:id/result`) and
nothing else, so "the same test" cannot mean anything more exact without a test id the protocol does
not carry. Two consequences, both accepted:

- **Parameterised tests that share a name share a history.** The same trade `runs.test.ts` already
  makes the other way: a retry is two results, because deduplicating by name would lose the pair.
- **A renamed test starts a new history.** Correct rather than merely tolerable — a rename is usually
  a change to what the test does.

**One dot per run, and a failure wins.** A run that failed a test and then passed it on retry is the
flakiness signal; folding it to "passed" would hide exactly the pattern the strip exists to show.
Skipped results are not an outcome and contribute no dot.

**The run being viewed is always present.** For a run opened weeks later, when twenty newer runs have
reported the same test, it takes the oldest slot rather than dropping out — a history that omitted
the run you are looking at could not say where that run sits in it.

**Scoped by RLS, not by a WHERE clause.** The query runs under the tenant's own role, where
`test_results`, `sessions` and `runs` are all `org_id = current_org()`. Architecture rule 7 is why it
is not a definer function: `mfarm_definer` bypasses RLS, so a definer version would have been scoped
by nothing but its own predicate — and every suite has a test called "login". A test proves another
org's runs never appear. It is one statement for every failing test on the run, not one per failure.

`runId` in each entry is the run's **external** id, matching what `runJson` calls `runId` and what the
console routes by.

### Device-minutes are what sessions held

`started_at → coalesce(ended_at, now())`, summed over the run's sessions and rounded. `started_at` is
stamped when a session goes ACTIVE, so a session that queued and gave up contributes nothing, and a
live one counts to now.

### Cost is a share of the host, not the host

**`HOST_HOURLY_COST` is a per-host rate and a host carries several devices.** Multiplying
device-minutes by it would price one hour on a four-device host at four times what that host costs for
the hour — a number wrong by exactly the factor nobody checks, on the screen somebody quotes in a
budget.

So each session is priced at **the rate divided by the number of devices its host carries**:

```
inr = Σ over sessions  (seconds / 3600) × HOST_HOURLY_COST / devices_on_that_host
```

That is what the hour costs when every device on the host is busy — the fair share of a machine whose
cost does not depend on how many sessions it runs. `note` states the basis in one sentence the
console renders verbatim: *"≈ share of ₹65/hr across 4 devices"*, or *"…split across each host's 1–4
devices"* when a run spans hosts of different sizes.

Three choices inside that, each with its honest error:

- **The divisor is the host's devices now, not at the time.** Nothing records how many devices a host
  carried last Tuesday. A farm whose device count changes is rare, and inventing that history would be
  less honest than stating the rule.
- **The count is read on the system pool.** Under the tenant's RLS, a host that also carries another
  org's dedicated devices would count only the devices this org can see, shrinking the divisor and
  overstating the share — the exact error the division exists to prevent. The host ids come from the
  tenant-scoped read, so nothing widens what the caller can name. **What it does disclose is a device
  count per host**, which on a multi-tenant farm hints at co-tenancy (the signal ADR-0026 kept off the
  device page). This farm has one org; ADR-0035 already names shared-host cost as operator information
  on a multi-tenant farm, and this is the same limit.
- **A session whose device has since been removed is counted and not priced.** Its minutes are real;
  its host is unknown. The note says how many minutes were left out, because a cost silently lower
  than the minutes imply is the same misstatement pointed the other way.

**`cost` is null when no rate is configured**, never zero — ADR-0035's rule that a number invented in
config would be rendered as though the farm had measured it. The field is named `inr` by the console
contract; the amount is in whatever `COST_CURRENCY` is, and the note prints that symbol.

## Alternatives considered

**Whole-host rate × device-minutes.** Simplest, and overstates ~4× on this farm's four-device host.

**Rate × host-hours the run overlapped.** Honest for a run that had the farm to itself, and double
counts every hour two runs shared. Cost is not additive across runs under it, so the per-run numbers
would sum to more than the bill.

**Divide by devices *busy* at the time.** Attributes idle capacity to whoever happened to be running,
so a lone nightly run pays for the whole host. Idle cost is real — ADR-0035 exists because of it — and
it belongs to the farm, on the Health screen, not to a run.

**A test id.** The right long-term identity, and a protocol change on every reporter. Name is what
exists, and the day an id arrives the history query changes one predicate.

## Consequences

- `test_results` has no `(org_id, name)` index. The history is a scan of the org's own results — a
  deliberate trade at this size, named in the query's comment as the first thing to add when a run
  page gets slow.
- The failures list stays capped at 200, so a run failing more than 200 tests carries history only for
  those listed.
