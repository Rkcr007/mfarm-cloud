# ADR-0052 — a device can be forgotten

**Status:** Accepted · 2026-10-09 · migration 069 · the device-level counterpart of migration 056

## Context

A device that registers once stays in `devices` for good. On the live farm a handset plugged in for
one afternoon on 2026-08-27 was still in the Fleet six weeks later: OFFLINE, and counted in every
"N devices" the product states. With agents on people's laptops that is the ordinary case — phones
are borrowed, sold and replaced — and there was no way to say "that one is gone".

Migration 056 answered the same question for a host by retiring it. Retiring a host takes all of
its devices with it, which is the wrong tool for one phone on a laptop that is still in use.

## Decision

1. **Forget, not delete.** `devices.retired_at`, `retired_by` and `retired_reason`. Sessions,
   metering, the quarantine log and run history all point at a device id; deleting the row would
   leave a failing test unable to say which phone it ran on. `GET /v1/devices/:id` still answers.
2. **Only a device that is not there.** `OFFLINE`, or quarantined by a person or a health check.
   Everything else is refused with its own sentence: its agent can see it; somebody is using it; it
   is out only because its host is away; the farm is in the middle of resetting it.
3. **Hidden is never allocatable.** The predicate every read uses is
   `retired_at IS NULL OR state NOT IN ('OFFLINE', 'QUARANTINED')`, never `retired_at` alone
   (`forgotten.ts`). If any path moves a forgotten device into a state where it could be handed
   out, the same change makes it visible again. No arrangement of the two columns is both.
4. **It comes back by itself.** The heartbeat that gives an away device back, and a registration
   that lists the device as present, clear the columns. A registration that names it as away, or
   does not name it at all, leaves it forgotten. Neither lifts a quarantine: a broken phone that is
   plugged back in returns to the list still quarantined.
5. **A person can restore it** — `POST /v1/devices/:id/restore`. It returns in the state it was in.
6. **Whose device it is decides who may.** A device dedicated to an org: that org's owners and
   admins. A shared device: a fleet operator (migration 053), because removing a device every tenant
   can see is a decision about the fleet.
7. **A forgotten device is in none of the counts.** The fleet list (which reports the forgotten
   ones separately, so they can be found), the operations centre's totals and per-host counts, the
   tenant's host list, the device gauges, and the divisor a run's cost is shared across.
8. **A recovery is refused on a forgotten device.** Restore it first.

## Consequences

- **`POST /v1/devices/:id/forget` answers 200 with `forgotten: false` and a sentence when it
  refuses**, as the quarantine routes beside it do. A caller has to read the flag, not the status.
- **A device forgotten while its host is up and then quarantined with its host stays hidden** — it
  moves between OFFLINE and QUARANTINED, both hidden states — and returns when its agent sees it.
- **Forgetting writes no event.** Who, when and why are on the row; the device's own timeline and
  the operations log do not record it. Adding it means rewriting two CHECK constraints, and nothing
  yet needs to read it.
- **`operatorOn` is unchanged.** Any org admin can still quarantine a shared device, which that
  function's own comment calls a known limit of a one-org farm. Forget does not inherit it.
- **A forgotten device on a retired host is listed nowhere.** Restoring the host brings it back to
  the forgotten list.

## Alternatives

- **Delete the row.** Tidy, and it throws away which device a session ran on.
- **Hide on `retired_at` alone, and trust every path to clear it.** Simpler to read. One missed
  path — a release, a recovery, a function written next year — would then leave a device the
  allocator can hand out and no screen shows.
- **A CHECK constraint that a forgotten device must be OFFLINE or QUARANTINED.** It would make the
  host-level release functions fail with a 500 on a whole host's heartbeat rather than let one
  device become visible.
- **Filter inside `allocate_device`.** The strongest guarantee, and it means rewriting the core
  definer function from its live definition to protect against a state the predicate above already
  makes harmless.
- **Stay forgotten until a person restores it.** A phone plugged back in would then be driven by
  nobody and shown nowhere. The agent seeing it is better evidence than the click that hid it.
