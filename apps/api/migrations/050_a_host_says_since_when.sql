-- 050: a host says since WHEN it has been up.
--
-- ---------------------------------------------------------------- what is wrong today
--
-- On 2026-09-11 the device host ran for **twenty hours and forty-eight minutes** after a check that
-- needed it for about two minutes. Nothing anywhere said so. The console's header read "4 of 5
-- ready" the whole time, which is true, useful, and completely silent about the fact that being
-- ready is the expensive state: `docs/STATUS.md` opens by saying the device host is ~95% of the
-- bill and is stopped between sessions, and there is no surface in the product that could have
-- caught it being left on.
--
-- **THE WASTE WAS NOT USAGE, AND THAT IS THE WHOLE DESIGN POINT.** `metering_events` records
-- device-seconds per org and records them correctly; over those twenty hours it recorded a few
-- minutes, because the devices were idle. A per-org usage view — the thing the product review asked
-- for — would have shown almost nothing and prevented nothing. What costs money is the HOST being
-- powered on, whether or not anybody allocates a device on it. Those are two different questions and
-- only one of them had any data behind it.
--
-- ---------------------------------------------------------------- what this adds
--
-- One column. `hosts.up_since` is stamped when a host registers — which a worker does once per boot,
-- from its systemd unit — and cleared when the control plane concludes the host is gone.
--
-- WHY NOT `created_at`. That is when the machine first ever registered, which on this farm is
-- several weeks ago; it answers "how long have we had this host", not "how long has it been costing
-- money". Both are reasonable questions and one column cannot be both.
--
-- WHY NOT DERIVE IT from the oldest heartbeat, or from a gap in them. Heartbeats are not retained —
-- `last_heartbeat_at` is a single moving timestamp — so there is no history to derive from, and
-- adding one to answer this would be a table of beats kept forever to compute a subtraction.
--
-- NULLABLE, and null is honest rather than a gap to backfill. Every host that exists when this
-- migration runs has been up for an unknown length of time: the control plane genuinely does not
-- know, because nothing was recording it. Backfilling `now()` would state that every host came up
-- the instant the migration ran, which is a fact the farm would then display with a straight face.
-- A host reports its own uptime from its next registration onward and says "unknown" until then.
--
-- ---------------------------------------------------------------- what it deliberately does NOT add
--
-- A PRICE. There is no rate column here and no currency, because MFARM is self-hosted: what a host
-- costs is a fact about somebody's cloud bill, not about this schema, and a number invented here
-- would be displayed as though the farm knew it. The hourly rate is operator configuration
-- (`HOST_HOURLY_COST`), and where it is unset the console shows elapsed time with no money in it —
-- which is still the sentence that would have caught this, because "up 20h" is alarming on its own.
BEGIN;

ALTER TABLE hosts ADD COLUMN IF NOT EXISTS up_since timestamptz;

COMMENT ON COLUMN hosts.up_since IS
  'When this host last came up, stamped at registration (once per worker boot). NULL means the '
  'control plane does not know -- a host that has not registered since migration 050. Never '
  'backfilled: an invented boot time would be displayed as a measurement.';

COMMIT;
