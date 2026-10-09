# ADR-0050 — an enrolled host is not the farm's: no rate, no alarm, no place in the rollup

**Status:** Accepted · 2026-10-09 · amends ADR-0035 (what a host costs), ADR-0038 (the operations
centre) and ADR-0039 (what a run cost) · closes D73

## Context

The product had one model of a host: a cloud VM the farm rents by the hour, which is expected to be
up and whose silence is an incident. ADR-0009 then made the agent a product, and a laptop enrolled
one to share two phones. Every surface applied the first model to the second machine. Read from the
live farm on 2026-10-09:

- **Cost.** The laptop logged 34.4 powered hours in October and was priced at
  `HOST_HOURLY_COST=65`: about ₹2,236 of spend in a month where the device host had not run for
  one hour. While the laptop was awake the page said the farm was burning ₹65 an hour and projected
  the month from it.
- **Health.** With the device host switched off, the overview read DOWN in both of the laptop's
  states. Awake, its unplugged phones made "Device farm" a farm with no usable device and a host
  that was on. Asleep, it was a host not answering, with a CRITICAL alert. The 2026-09-26 rule that
  a switched-off farm reads "off" could not hold while the laptop was in the list.
- **Noise.** The sleeping laptop woke about 85 times a day. In a week that wrote 418 "stopped
  responding" warnings and 834 device-quarantine rows, against 39 for the device host, and real
  events left the feed within hours.
- **Tenants.** A run on the org's own phone was priced at a share of the device host's rate, and
  `GET /v1/hosts` showed the org a cost for its own computer.
- **Alerts.** `MfarmHostSilent` and `MfarmHostIdleAndBilling` fired for the laptop.
- **A wrong control.** "Start host…" beside a phone on the sleeping laptop opened the confirmation
  to start the device host — a different machine, which would not have brought the phone back.

One more count was wrong for a neighbouring reason: the fleet's device totals had no predicate on
`retired_at`, so a retired host's devices stayed in "quarantined" for good.

## Decision

1. **Ownership is the kind.** `hosts.org_id` is set from the credential a host registered with and
   never from what the worker sends. NULL is the fleet's registration token; a value is an org's
   enrollment. So `fleet` and `enrolled` are derived from it (`infra/rates.ts`) and no column is
   added.
2. **A rate is per host.** An enrolled host has none — null, not zero. A fleet host is priced at its
   own instance's rate when `CLOUD_INSTANCE_RATES` names one, through the name mapping
   `MFARM_POWER_INSTANCES` already holds, and at `HOST_HOURLY_COST` otherwise.
3. **The overview sends two lists.** `hosts` is the farm's machines and is everything the page
   counts, costs, alerts on and offers to power. `enrolled` is the rest. The health rollup and the
   cost figures also filter internally, so a caller cannot put an enrolled host back by passing the
   wrong list.
4. **An enrolled host is connected or away.** It raises no alert for silence or for its own disk,
   load and memory. It keeps the two alerts that concern the product: a drain, and a tunnel that is
   down while the agent is up. It is never powerable.
5. **The fleet's device counts are devices on current fleet hosts.** Enrolled devices are reported
   beside them as `enrolledDevices`, and a retired host's devices are counted nowhere.
6. **The events feed is about the farm.** It leaves out an enrolled host's power events and the
   device rows written when its host comes and goes. Anything a person did, and anything else that
   happens to such a device, is still shown.
7. **Tenants are not charged for their own machine.** `GET /v1/hosts` carries `kind` and
   `ratePerHour` per host. A run's cost prices each hold at its host's rate and names the minutes
   that ran on a machine the org enrolled as not charged.
8. **Prometheus exports the farm's hosts only.**
9. **"Start host…" is offered only for a device on a fleet host.** Recover stays withheld for every
   host-off device, enrolled or not: it asks a host that is not answering either way.

## Consequences

- **Nothing about the mechanism changed.** The reaper still withdraws an away host's devices, the
  power ledger still records every machine that beats, and the device log still gets a row per
  device per nap. Only what reads them changed.
- **`mfarm_devices` still counts every device**, including dedicated ones and those on retired
  hosts. The retired half is a known gap, not addressed here.
- **A fleet host that is not a cloud instance is still priced at the default.** A machine registered
  with the fleet's token and not named in `CLOUD_INSTANCE_RATES` gets `HOST_HOURLY_COST`, whatever
  it actually costs. That is wrong for hardware the operator owns outright.
- **A cloud VM dedicated to one org would be unpriced.** It registers with that org's enrollment and
  is therefore `enrolled`. None exists.
- **The churn is still written.** About 85 ledger rows and 170 device-log rows a day for one
  sleeping laptop. Reads are filtered; the tables still grow, and a device's own history page still
  shows the rows.

## Alternatives

- **A `kind` column, set at registration and editable.** It would cover the two cases above. It
  would also be a second statement of a fact the row already holds, and one a person can set wrong.
  Worth adding when a host exists that ownership gets wrong.
- **A rate column an operator edits from the console.** The right answer for owned hardware, and the
  natural next step. Deferred: it needs a migration, an audited operation and a control, and none of
  the four defects above needed it.
- **Zero for an enrolled host's rate.** Sums would need no null handling. A zero is rendered as a
  measurement, and "the farm does not pay for this" is not one.
- **One list with a `kind` on each row.** Every count on the page would have to remember a filter,
  and the one that forgot is this defect again.
- **Stop recording an enrolled host in the power ledger.** It would end most of the churn. The
  ledger is a record of powered time, and time is still a fact about that machine; it would also
  make a later priced, enrolled host impossible without a backfill.
