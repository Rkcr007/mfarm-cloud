---
id: ADR-0028
title: The queue is round-robin across orgs and first-in-first-out within one
status: Accepted
date: 2026-09-07
authors:
  - Claude Code
tags: [allocator, scheduling, queue, fairness, multi-tenancy]
extends: [ADR-0025]
---

## Context

`promote_queued` has, since migration 003, chosen who gets a freed device by reading a **window** of
candidates — the twenty oldest `QUEUED` sessions in the fleet, `ORDER BY created_at LIMIT p_limit` —
and skipping each one whose org is already at `max_concurrent`.

Each half is defensible. A window bounds the work one sweep does, which matters because the sweep
runs six times a minute forever. FIFO is the fairest ordering anybody agrees on without an argument.
The cap stops one tenant from taking the whole farm.

Together they stop the queue. An org holding twenty or more queued sessions fills the entire window
by itself; if that org is at its cap, every row in the window hits the `CONTINUE`, and the loop ends
having promoted nothing — **with devices sitting `READY`**. Ten seconds later the sweep computes the
same window and does the same nothing. A second org's session is not deprioritised or made to wait
its turn. It is never read. It sits `QUEUED` until the first org's backlog falls below twenty, which
happens only at that org's cap rate, one ended session at a time.

This survived thirty-eight migrations because it is invisible on a one-org farm, and this farm has
one org. It surfaces on the first day the farm is put in front of a second team — which is the
pending decision in `docs/STATUS.md` §4, and the thing this repo is closest to doing.

`AutomationExecutionPlan.md` §20 asks for exactly this not to happen, by name: *"If ten users submit
tests, don't let one user monopolize the device forever."* It also asks for "a clean FIFO scheduler
with architecture that allows future scheduling policies" in V1.

## Decision

**The candidate window is ranked per org, not globally by age.** Each org's queued sessions are
numbered by `row_number() OVER (PARTITION BY org_id ORDER BY created_at)`, and candidates are taken
in `(rank, created_at)` order.

Every org's oldest session is considered before any org's second; every org's second before any
org's third. **Round-robin across orgs, strict FIFO within one.**

Three things follow, and each is a deliberate choice rather than a consequence:

**The cap check does not move and does not change.** `max_concurrent` bounds what an org *runs*. The
rank bounds what an org *occupies in the queue*. Those are two different questions, and the old
query was asking one mechanism to answer both — which is the whole defect, stated precisely.

**A single-org farm is unchanged, byte for byte.** One partition means the ranks are `1..n` in
`created_at` order and the tie-break keeps them there. That is what makes this safe to apply to a
running farm: the farm it is applied to has one org, so the fix for the two-org case cannot disturb
the one-org case it is landing in.

**The ordering key is the extension point.** §20 also lists priority, team quotas, org quotas,
reserved devices and dedicated pools as things a scheduler should eventually support. None is built
here. A priority scheme is a column added ahead of `queue_rank` in that `ORDER BY`; a quota is a
second `CONTINUE`. Adding either now would be a policy knob with one customer and no evidence behind
its default.

## Consequences

**A ranked window costs a full read of the queued rows.** The old query could walk `created_at` and
stop after twenty; this one must rank every `QUEUED` session before it can name the first candidate.
That is the correct cost of the question, and migration 039 adds `sessions_queued_idx` —
`(org_id, created_at) WHERE state = 'QUEUED'` — which is the window's `PARTITION BY` and `ORDER BY`
in that order, so the ranking comes out of the index without a sort. The table is overwhelmingly
`ENDED` rows, so the partial index stays small enough to live in cache.

**A large org's throughput is unchanged; its queue *position* is not.** An org at its cap was never
going to have a session promoted anyway — that is what the cap means. What changes is that its
backlog no longer hides everyone else's first session. No org loses a device it was entitled to.

**Fairness is per org, not per user.** Ten engineers in one org still contend with each other by
`created_at` alone. That is the right grain for the billing boundary MFARM has today; a per-user
rank is a second `PARTITION BY` if a single org ever grows large enough to need one.

**The reaper still calls this on the system pool.** `promote_queued` remains `SECURITY DEFINER`,
owned by `mfarm_definer`, and revoked from **both** `PUBLIC` and `mfarm_app` — it is a fleet-wide
mutation that moves devices belonging to every org, and RLS says nothing about a definer function.
The first draft of migration 039 granted it to `mfarm_app` by copying the pattern from
`allocate_device`, which is called from a request handler and must be. `test/definer-acl.test.ts`
caught it, which is what that test's fleet-wide list exists for.
