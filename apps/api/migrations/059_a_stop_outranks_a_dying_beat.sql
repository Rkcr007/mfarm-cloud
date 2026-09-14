-- 059: a stop outranks the beats of the machine it is switching off.
--
-- ---------------------------------------------------------------- what 058 got wrong
--
-- Watched on the real farm minutes after 058 deployed. Stop was pressed at 08:56:28; the four
-- devices were withdrawn with "its host was stopped: stopped from the console", exactly as intended
-- — and then they were READY again seconds later, until the reaper re-quarantined them at 08:58:12
-- with "no heartbeat for 90s".
--
-- **A GCE stop takes about ninety seconds to silence the agent.** The worker beats every ten
-- seconds throughout, and ADR-0038 made a beat lift `DOWN` — so each beat undid the withdrawal.
-- 058 turned "devices stay READY until the reaper notices" into "devices come back for ninety
-- seconds", which is better and still not the thing the ADR claims.
--
-- A beat is the disproof of DOWN in general: a machine that came back on its own must not be stuck.
-- It is NOT the disproof of a stop that is still in progress — those packets were in flight before
-- the machine went away, and treating them as evidence it is staying is reading the last gasp as a
-- heartbeat.
--
-- ---------------------------------------------------------------- the rule
--
-- For a grace window after a stop was ASKED FOR, a beat does not lift DOWN. Past the window it does,
-- unchanged — so a stop that silently failed to take effect self-heals on the next beat, a couple of
-- minutes later, instead of stranding a running machine.
--
-- The window is a PARAMETER, not a constant in here: a test that cannot wind it down cannot tell
-- this rule from the bug it fixes (the seam every timing in this feature now has).
--
-- `result` is checked too. A stop the provider REFUSED is not a stop in progress, and a beat after
-- one is ordinary evidence about an ordinary running machine.

BEGIN;

CREATE OR REPLACE FUNCTION lift_host_down(p_host uuid, p_stop_grace interval DEFAULT interval '3 minutes')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  -- A STOP THIS CONTROL PLANE ASKED FOR, RECENTLY ENOUGH THAT THE MACHINE MAY STILL BE DYING.
  -- Read from the audit log rather than a new column: `infra_operations` already records who asked
  -- for what and when, and a second copy of that fact is one more thing that can disagree.
  IF EXISTS (
    SELECT 1 FROM infra_operations
     WHERE target_kind = 'host' AND target_id = p_host::text
       AND action = 'stop-host' AND result IN ('accepted', 'succeeded')
       AND requested_at > now() - p_stop_grace
  ) THEN
    RETURN -1;
  END IF;

  UPDATE hosts SET state = 'UP' WHERE id = p_host AND state = 'DOWN';
  IF NOT FOUND THEN RETURN -1; END IF;

  UPDATE devices
     SET state = quarantined_from, quarantined_from = NULL,
         quarantined_at = NULL, quarantine_reason = NULL, quarantine_source = NULL,
         recovery_started_at = CASE WHEN quarantined_from = 'PREPARING'
                                    THEN now() ELSE recovery_started_at END,
         updated_at = now()
   WHERE host_id = p_host AND state = 'QUARANTINED' AND quarantined_from IS NOT NULL
     AND quarantine_source = 'host';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- THE GRANT THIS RULE NEEDS, and without it the function throws `permission denied for table
-- infra_operations` on EVERY BEAT from a stopped host — a 500 on the busiest route on the farm, in
-- the exact state this feature exists for. `mfarm_definer` is least-privileged and owns no table it
-- has not been given; ADR-0038 has the same note about the power ledger, found the same way.
--
-- SELECT ONLY. The audit log is written by the API as the owner and nothing in a definer function
-- has any business appending to it.
GRANT SELECT ON infra_operations TO mfarm_definer;

ALTER FUNCTION lift_host_down(uuid, interval) OWNER TO mfarm_definer;
REVOKE EXECUTE ON FUNCTION lift_host_down(uuid, interval) FROM PUBLIC, mfarm_app;

-- The one-argument form 058 created is gone: leaving it would mean two functions with the same name
-- where the shorter one silently skips the guard — and the call sites pass the window explicitly.
DROP FUNCTION IF EXISTS lift_host_down(uuid);

COMMIT;
