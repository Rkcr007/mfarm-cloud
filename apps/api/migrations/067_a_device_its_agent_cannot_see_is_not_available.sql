-- 067 — a device its agent cannot see is not available (D62).
--
-- A device's state reached the control plane only at registration and through leases. The agent's
-- health checks filed incidents and changed nothing a scheduler reads, so a phone that was rebooting
-- — or simply unplugged — read AVAILABLE on the Fleet with a Start button and counted in "1 of 6
-- ready", while the agent beside it knew it was gone. WebDriver refused it correctly (the agent
-- withdraws `webdriver` for a phone that is away); a session started by hand from the console was
-- allocated to a phone that was not on its cable.
--
-- So the agent says which of its devices are AWAY, on every heartbeat and at registration, and the
-- control plane moves them READY -> OFFLINE with the reason, and back.
--
-- `away_since` IS THE MARK OF WHO DID IT. OFFLINE has other meanings — a device that lacks a
-- capability the scheduler requires registers OFFLINE, and one missing from a registration is set
-- OFFLINE — and the heartbeat must never promote those. It only gives back what it took: a device
-- is returned to READY only while `away_since` is set. Nothing else writes these columns.
--
-- ONLY READY IS EVER TAKEN. A device in a lease, a reset or a quarantine is left exactly as it is;
-- its own machinery owns it. A quarantine that collapses an away device keeps the mark, so the
-- release that restores OFFLINE leaves something the next beat can give back.

BEGIN;

ALTER TABLE devices
  ADD COLUMN away_since  timestamptz,
  ADD COLUMN away_reason text;

COMMENT ON COLUMN devices.away_since IS
  'Set when the device''s own agent reports it is not there (not on USB, not answering) and the heartbeat took it from READY to OFFLINE. Cleared when the agent stops saying so, which returns it to READY. Only the heartbeat and registration write it (067).';
COMMENT ON COLUMN devices.away_reason IS
  'What the agent said, verbatim and short — "it is not on USB". Shown on the Fleet beside OFFLINE.';

-- The beat's "give back" reads exactly these rows, six times a minute per host, and they are rare.
CREATE INDEX devices_away_idx ON devices (host_id) WHERE away_since IS NOT NULL;

COMMIT;
