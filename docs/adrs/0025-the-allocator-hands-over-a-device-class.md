---
id: ADR-0025
title: The allocator hands over a device class, and "no profile" is one of them
status: Accepted
date: 2026-09-04
authors:
  - Claude Code
tags: [allocator, devices, scheduling, console, honesty, queue]
extends: [ADR-0016, ADR-0017]
---

## Context

The console's primary action on a device card used to read:

> Start a session on tier cuttlefish

Ugly, and accurate. `POST /v1/sessions` sent `{ region, platform, tier }`, and `allocate_device`
matched on region, platform, tier, org and declared capabilities. A tier is what you asked for and a
tier is what you got.

The design package's copy deck replaced it with:

> Start MFARM X1 Pro

That is a much better sentence and, as shipped, it was false. `allocate_device` has never had a
profile in its candidate query — not in migration 003, not in 006 which last replaced it. On a farm
whose devices are all `tier: cuttlefish` in one region, that button could allocate an MFARM X1, or
an unprofiled 720×1280 device, and the console would say nothing about the difference.

The design package states its own assumption as **"allocation is class-only"** — you are promised a
class, never a particular unit. That is a fair description of what the product should do. It was not
a description of the code: allocation was **tier-only**, which is a strictly coarser grain.

The distinction is not pedantic. A tier is a virtualisation technology. A class is a device somebody
chose. Two devices can share a tier and differ in the one property that made a person pick one of
them, which is the screen — and screen shape is usually the entire reason a tester chose a device
(ADR-0016). Handing over a different panel silently produces a bug report filed against the wrong
geometry, and the farm gets blamed for it.

## Decision

**`allocate_device` takes the device class as scheduling input, and honours it on both the immediate
path and the queue.** The console asks for the class its button names, so the button is true.

```
p_profile       text     DEFAULT NULL     -- which class
p_match_profile boolean  DEFAULT false    -- whether the caller is constraining at all
```

```sql
AND (NOT COALESCE(p_match_profile, false) OR d.profile IS NOT DISTINCT FROM p_profile)
```

### Two parameters, because "no profile" is a class

A single nullable parameter cannot express the three real intents:

| intent | who asks for it |
|---|---|
| any device I can drive | the CLI, the WebDriver hub |
| a named class | the console starting an MFARM X1 Pro |
| **the unprofiled devices** | the console starting one of this farm's plain devices |

The third is the one that decides the shape. Two of this farm's four devices are deliberately
unprofiled, every physical handset is unprofiled, and the console offers them by name. With one
nullable field, "give me an unprofiled device" is indistinguishable from "give me anything" — so
**Start Unprofiled device** would allocate an X1 Pro. A nicer device than was asked for, still not
the one the button named, and the kind of wrong that never generates a complaint and therefore never
gets fixed.

`IS NOT DISTINCT FROM` is NULL-safe equality, so one predicate serves all three once a separate flag
says whether to apply it. A sentinel string would also have worked and would have been a trap for
whoever read it next.

### The queue is the other half

`promote_queued` re-runs the allocation decision minutes later from `sessions.constraints`, which is
where migration 006 already records platform, tier, required capabilities and TTL for exactly this
reason. `profile` and `matchProfile` join them.

A constraint honoured at allocate time and dropped at promotion time would be **worse than no
constraint**: it holds while you are watching the page and breaks once you have walked away — and
the queue is, by definition, the path somebody is waiting on. The two functions stay in step by
construction, because one writes the blob the other reads.

### Defaults preserve every existing caller

`matchProfile` defaults to false and the predicate collapses to `TRUE`. The CLI, the WebDriver hub
and every suite that has never heard of a profile allocate byte-for-byte what they allocated before.
That is asserted by a test rather than assumed, and it is what makes the migration safe to deploy
ahead of the console that uses it.

## Consequences

**A class request that cannot be met queues rather than substituting.** This is the behaviour the
copy already promises — *"The farm picks a free MFARM X1 Pro. If none is free when you press this,
you will be queued."* On a small farm it means a person can now wait where previously they would
have been handed something immediately. That is the correct trade: a device with the wrong screen is
not a faster answer, it is a different answer, and the tester finds out after the test run rather
than before it.

**The substitution flow becomes opt-in rather than the default.** The design package's
`SubstitutionNotice` describes a handover that says *"you asked for an X1 Pro, you have an unprofiled
device"*. With the allocator constrained, that path is only reached when a caller deliberately
allows a substitute — which is the only form in which it is a feature rather than an apology. It is
not built yet.

**Only geometry has been promised, not a unit.** The picker still cannot promise a specific device,
and nothing here changes that. ADR-0016's rule holds: the console draws geometry from the device's
own report, never from the profile table, so a class that ever disagreed with its members would
still be visible on the frame.

**The predicate can only narrow.** Row-level security and the existing
`d.org_id IS NULL OR d.org_id = p_org` clause still decide visibility; a caller naming a profile can
reach nothing it could not reach before.

## Alternatives considered

**Revert the button copy to name the tier.** Cheapest, no migration. It gives up the naming rule the
whole copy deck rests on — that a device is addressed by what it is, and `cuttlefish` is an
implementation the reader did not choose — and leaves the substitution problem exactly where it was.

**Allow the mismatch and disclose it at handover.** Build `SubstitutionNotice` now and keep the
allocator coarse. Honest, but it means routinely handing people the wrong screen and apologising for
it, when queueing them for the right one is both available and what they asked for. Better as the
opt-in path above.

**Carry the class inside `requested`.** It is already a passthrough jsonb stored on the session, so
this needed no signature change at all. Rejected because `requested` is documented in
`routes/sessions.ts` as an opaque tenant blob explicitly distinct from scheduling input, and
`requireCapabilities` is the precedent for what scheduling input looks like. Overloading the blob
would have saved a `DROP FUNCTION` and cost the distinction.

**Match on geometry rather than on profile.** `d.screen->>'width'` is closer to what a tester
actually cares about, and the design package hints at it: *"a class plus a guarantee about
geometry"*. Deferred rather than rejected — it is the right shape for the opt-in substitution path
("accept any device with the same screen"), and it is a second predicate on the same query when that
is built. Profile is the correct grain for the promise the picker makes today, because the picker
offers named classes.
