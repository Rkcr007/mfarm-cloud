-- 068 — a device back in service carries no quarantine (D63).
--
-- Three functions give a host's devices back after the host itself returns: `clear_silence_quarantine`
-- (the host beat again, 035), `lift_host_down` (a stopped host came back, 058) and
-- `release_host_quarantine` (an operator's Resume, 053 — and since D59, a retired host registering).
-- The first two clear each device's quarantine as they restore it. The third restored the state and
-- left `quarantined_at`, `quarantine_reason` and `quarantine_source` behind, so a phone back in
-- service read AVAILABLE on the Fleet with "its host was quarantined: no heartbeat for 90s" in its
-- holder column, and `GET /v1/devices/:id` returned a `quarantine` object beside a state that was
-- not quarantined. Seen on the farm 2026-10-03, verifying D59.
--
-- It also differed from the other two in two quieter ways, both fixed here by making it the same
-- statement they already are:
--
--   * A device collapsed while it was PREPARING (an operator had authorised its recovery) went back
--     to PREPARING with the recovery clock it had before — so a recovery could time out the moment
--     it resumed, for the time the host spent out. The other two restart the clock.
--   * It restored every quarantined device of the host with a `quarantined_from`, where the others
--     restore only the cascade's own rows (`quarantine_source` 'host', or NULL for rows from before
--     035). `quarantine_device` clears `quarantined_from`, so no device-level quarantine could match
--     today — this makes the rule explicit rather than incidental, the way 035 wrote it.
--
-- REWRITTEN FROM THE LIVE DEFINITION, which is 053's: nothing since has replaced it. Ownership and
-- grants survive CREATE OR REPLACE, so 053's REVOKE still stands; it is repeated anyway so this file
-- says on its own who may call it.

BEGIN;

CREATE OR REPLACE FUNCTION release_host_quarantine(p_host uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE hosts
     SET state = 'UP', quarantined_at = NULL, quarantine_reason = NULL, quarantine_source = NULL
   WHERE id = p_host AND state = 'QUARANTINED' AND quarantine_source = 'operator';
  IF NOT FOUND THEN RETURN -1; END IF;

  UPDATE devices
     SET state = quarantined_from, quarantined_from = NULL,
         quarantined_at = NULL, quarantine_reason = NULL, quarantine_source = NULL,
         recovery_started_at = CASE WHEN quarantined_from = 'PREPARING'
                                    THEN now() ELSE recovery_started_at END,
         updated_at = now()
   WHERE host_id = p_host AND state = 'QUARANTINED' AND quarantined_from IS NOT NULL
     AND (quarantine_source = 'host' OR quarantine_source IS NULL);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
ALTER FUNCTION release_host_quarantine(uuid) OWNER TO mfarm_definer;
REVOKE EXECUTE ON FUNCTION release_host_quarantine(uuid) FROM PUBLIC, mfarm_app;

-- THE ROWS IT ALREADY LEFT BEHIND. A quarantine describes a device that is quarantined; on any other
-- state these three columns are a stale sentence. History is not lost: every quarantine and release
-- is in `device_quarantine_log`, which is what the console's Quarantine history reads.
UPDATE devices
   SET quarantined_at = NULL, quarantine_reason = NULL, quarantine_source = NULL
 WHERE state <> 'QUARANTINED'
   AND (quarantined_at IS NOT NULL OR quarantine_reason IS NOT NULL OR quarantine_source IS NOT NULL);

COMMIT;
