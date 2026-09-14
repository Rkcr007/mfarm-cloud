-- 058: a stopped host is not capacity.
--
-- ---------------------------------------------------------------- what was wrong
--
-- Stopping the device host from the console (ADR-0038) writes `hosts.state = 'DOWN'` and nothing
-- else. Its devices were left exactly as they were — READY — and nothing ever moved them:
--
--   the reaper sweeps only hosts that are `UP` (it exists for a machine that went quiet on its own),
--   so a host we marked DOWN ourselves is never swept;
--   `allocate_device` filters on `d.state = 'READY'` and never looks at the host.
--
-- So on 2026-09-14, with the lab switched off for eight hours, Fleet read "4 of 4 ready", Apps said
-- the same, and the allocator would have handed any of those four to a tenant whose session then
-- failed at connect time — "the farm reports full capacity while serving none of it", the sentence
-- migration 003's reaper comment was written about, back again by a second door.
--
-- ---------------------------------------------------------------- what this does
--
-- A DOWN host collapses its devices the way a silence quarantine does, and a beat restores them the
-- way it restores a silence quarantine. Same columns, same source ('host'), same restore rule —
-- `quarantined_from`, never a guess at READY — so a device whose session ended before the stop
-- comes back to CLEANING and waits for a real restore rather than handing over the last tenant's
-- data.
--
-- The HOST stays DOWN, not QUARANTINED. `DOWN` is what makes the infrastructure card read `stopped`
-- and offer Start; quarantining it here would turn that back into `unknown`.
--
-- Two functions rather than a trigger on `hosts.state`: the heartbeat and registration already call
-- `clear_silence_quarantine` explicitly, and a person reading either route should see the restore
-- happen rather than infer it from a trigger in a migration they have not opened.

BEGIN;

CREATE OR REPLACE FUNCTION mark_host_down(p_host uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE hosts SET state = 'DOWN' WHERE id = p_host AND state <> 'DOWN';

  -- Unconditional on the UPDATE above, so calling it for a host already DOWN still withdraws any
  -- device left READY — which is the repair at the bottom of this file, and also what makes a
  -- second Stop press harmless. The state filter is what keeps it idempotent: a device already
  -- collapsed is QUARANTINED and is not touched again, so `quarantined_from` is never overwritten
  -- with QUARANTINED.
  WITH collapsed AS (
    UPDATE devices
       SET quarantined_from = state, state = 'QUARANTINED',
           quarantined_at = now(),
           quarantine_reason = 'its host was stopped: ' || p_reason,
           quarantine_source = 'host',
           updated_at = now()
     WHERE host_id = p_host AND state IN ('READY','OFFLINE','BOOTING','CLEANING','PREPARING')
    RETURNING id, fence
  ), ins AS (
    INSERT INTO device_quarantine_log (device_id, event, source, reason, fence)
    SELECT c.id, 'quarantined', 'host', 'its host was stopped: ' || p_reason, c.fence
      FROM collapsed c
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM collapsed;

  RETURN v_count;
END $$;

-- The inverse, and the only way out of DOWN. Returns -1 when the host was not DOWN, exactly as
-- `clear_silence_quarantine` does, so a caller can tell "nothing to lift" from "lifted, no devices".
CREATE OR REPLACE FUNCTION lift_host_down(p_host uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE hosts SET state = 'UP' WHERE id = p_host AND state = 'DOWN';
  IF NOT FOUND THEN RETURN -1; END IF;

  UPDATE devices
     SET state = quarantined_from, quarantined_from = NULL,
         quarantined_at = NULL, quarantine_reason = NULL, quarantine_source = NULL,
         recovery_started_at = CASE WHEN quarantined_from = 'PREPARING'
                                    THEN now() ELSE recovery_started_at END,
         updated_at = now()
   WHERE host_id = p_host AND state = 'QUARANTINED' AND quarantined_from IS NOT NULL
     -- Only the cascade's own rows: an operator's or a health check's quarantine is not a packet's
     -- to lift (016, 035).
     AND quarantine_source = 'host';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

ALTER FUNCTION mark_host_down(uuid, text) OWNER TO mfarm_definer;
ALTER FUNCTION lift_host_down(uuid)       OWNER TO mfarm_definer;
REVOKE EXECUTE ON FUNCTION mark_host_down(uuid, text) FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION lift_host_down(uuid)       FROM PUBLIC, mfarm_app;

-- THE REPAIR. Every host already DOWN when this runs was stopped under the old code, so its devices
-- are still READY. A retired host is skipped: its devices went with it (056).
SELECT mark_host_down(id, 'stopped before migration 058')
  FROM hosts
 WHERE state = 'DOWN' AND retired_at IS NULL;

COMMIT;
