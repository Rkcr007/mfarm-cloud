# ADR-0042 — a stopped host is not capacity

**Status:** Accepted · 2026-09-15 · migrations 058, 059 · amends ADR-0038 (power) and ADR-0041 (console)

## Context

Two things were seen on the deployed farm with the device host switched off.

**Fleet and Apps counted a stopped host's devices as ready.** A console Stop (ADR-0038) wrote
`hosts.state = 'DOWN'` and nothing else. Nothing else ever moved the devices: the reaper sweeps only
hosts that are `UP` — it exists for a machine that went quiet on its own — and `allocate_device`
filters on `d.state = 'READY'` without looking at the host. So after an eight-hour stop the console
read "4 of 4 ready", and the allocator would have handed any of those devices to a tenant whose
session then failed at connect time. That is the failure migration 003's reaper was written to end,
back again through a second door.

A stop made OUTSIDE the console did not show it: the host was still `UP`, went silent, and the reaper
quarantined it and its devices at 90 seconds. The bug lived only on the path the product itself
offers.

**Start had no in-progress state.** The request waits up to 25 seconds for the provider and the
agent's first beat is a boot later. For all of that the host was still `DOWN`, so the card kept
offering Start. Pressing it again was the natural response to a button that visibly did nothing.

A read-only walkthrough of the console with the lab off then found that **every screen which noticed
the problem was a dead end**: Fleet offered Recover on each device (a recovery asks the host that is
not answering), Apps said "none are ready — Go to the Fleet", the device page said to wait for the
host, the Infrastructure alert was plain text, and "Hosts off" in the top bar opened Farm health. The
one Start button in the product was two clicks deep, on Infrastructure › Hosts.

## Decision

1. **A DOWN host withdraws its devices, and the beat that disproves DOWN restores them.**
   `mark_host_down(host, reason)` sets the host DOWN and collapses its devices exactly as a silence
   quarantine does: same columns, source `host`, `quarantined_from` recorded, a row in
   `device_quarantine_log`. `lift_host_down(host)` is its inverse. The heartbeat and registration
   call it when the host is DOWN. It restores `quarantined_from`, never a guess at READY, so a
   device whose session ended before the stop comes back to CLEANING rather than handing over the
   last tenant's data. It lifts only the cascade's own rows, never an operator's or a health check's.
2. **The host stays DOWN, not QUARANTINED.** DOWN is what makes the card read `stopped` and offer
   Start; quarantining it would put it back to `unknown`, which ADR-0038 already had to fix once.
3. **The migration repairs what the old code left.** Every non-retired host already DOWN when 058
   runs has its devices withdrawn.
4. **`power: 'starting'`** in `/v1/infra/overview`: the host's LATEST power operation is a start or
   restart, `accepted` or `succeeded`, inside the reconciler's give-up window, and no beat has
   arrived since it was requested. The beat ends it by being newer; a Stop ends it by becoming the
   latest operation; a failed or `unknown` settle ends it by no longer matching; the horizon ends a
   start that never lands. While it holds, the `host-silent` CRITICAL is replaced by a `host-starting`
   warning — a critical "no heartbeat for 9 hours" beside a spinner reads as a failed start.
5. **The console is busy in two layers.** While a host operation is in flight in this browser, that
   host's controls are ONE disabled button with a spinner ("Starting…") — client-side, because
   nothing on the server says "somebody pressed it" until it answers. After it answers,
   `power: 'starting'` holds the same control, which survives a reload and is what a second operator
   sees. The pending mark is dropped only AFTER the overview is re-read, so the Start button does not
   flash back in between.
6. **Every screen that notices a host is off offers the way forward.** A device out because its host
   is not running gets **Start host…** (operators) instead of Recover on Fleet and Health, and on its
   own page; Fleet and Apps show one banner — "The device host is off, so nothing can be allocated" —
   when nothing is ready and something is host-off, telling a member to ask an operator; the
   Infrastructure alert carries the host card's power control; and the host segment of the top-bar
   pill opens Infrastructure › Hosts. All of them open the same confirmation from the same snapshot,
   so the money sentence and the busy state cannot differ by where it was pressed.
7. **Stopped is not quarantined, in words.** The device reason written by `mark_host_down` begins
   "its host was stopped", and the console says "Its host is stopped" rather than "Its host was
   quarantined".

## Consequences

- A started farm's devices return on the host's first beat — before its Cuttlefish instances may
  have finished booting — which is exactly what the silence-quarantine path has always done. Not
  changed here.
- The allocator still does not look at the host. The invariant is held by the writers (every path to
  a non-running host withdraws its devices) rather than by a join in `allocate_device`, which would
  mean rewriting the hottest definer function for a fact two functions now keep.

## Correction, the same day — migration 059

058 was deployed and the button pressed on the real farm. Stop at 08:56:28 withdrew the four devices
with "its host was stopped: stopped from the console", exactly as decided above — and they were READY
again seconds later, until the reaper re-quarantined them at 08:58:12 with "no heartbeat for 90s".

**A GCE stop takes about ninety seconds to silence the agent, which beats every ten throughout, and
ADR-0038 made a beat lift `DOWN`.** Each beat undid the withdrawal. 058 turned "READY until the
reaper notices" into "READY for ninety seconds" — better, and still not what this ADR claims.

**A beat is the disproof of `DOWN` in general; it is not the disproof of a stop still in progress.**
Those packets were in flight before the machine went away.

1. **`lift_host_down` takes a grace window** and refuses while a `stop-host` operation for that host
   was requested inside it (`accepted` or `succeeded` — a refused stop is not one in progress). Past
   the window a beat lifts `DOWN` as before, so a stop that silently failed self-heals in minutes
   rather than stranding a running machine. Default three minutes, `INFRA_STOP_GRACE_MS`.
2. **Registration passes zero.** A worker registers once per boot, so a registration inside the
   window is a machine that has *booted* since the stop — the same asymmetry 056 draws between a
   registration and a beat.
3. **`power: 'stopping'`**, the mirror of `starting`: a recent stop while the host is still audible.
   The card shows a disabled "Stopping…" instead of reading RUNNING and offering Stop again.
4. **`mfarm_definer` needed `SELECT` on `infra_operations`.** Without it the new guard throws
   `permission denied` on every beat from a stopped host — a 500 on the busiest route on the farm, in
   the exact state this feature exists for. Caught by a test; ADR-0038 has the same note about the
   power ledger, found the same way.

**Consequence accepted:** a stopping host is not counted in "hosts powered on", so the burn headline
understates by one host for up to three minutes while a machine finishes switching off.

## Alternatives rejected

**Sweep DOWN hosts in the reaper.** `quarantine_host` sets the host QUARANTINED, which turns the card
back to `unknown` and reopens the defect ADR-0038's hardware verification closed.

**A trigger on `hosts.state`.** It would work, and it would hide the restore from anybody reading the
heartbeat or registration route — both already call `clear_silence_quarantine` explicitly, and this
follows that shape.

**Disable Start for a fixed time after pressing it.** A timer is a guess about GCE; the operation log
and the heartbeat are facts the control plane already has.
