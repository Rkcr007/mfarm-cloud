-- 016: a host that starts beating again gets its fleet back.
--
-- Found on the lab box 2026-08-19, an hour after a host reboot, with both Cuttlefish devices
-- running and adb-responsive:
--
--     hosts:   state QUARANTINED | quarantined_at 09:23:52 | reason "no heartbeat for 90s"
--                                | last_heartbeat_at 10:33:07   <-- beating for an hour
--     devices: cf-1 QUARANTINED   cf-2 QUARANTINED       GET /v1/devices -> "available": 0
--
-- Three correct behaviours composing into a farm that never comes back:
--
--   1. The box boots. The API container starts, the reaper runs against a `last_heartbeat_at` from
--      before the reboot and quarantines the host — right, and the whole point of the fix that
--      introduced it, because a silent host's devices must leave the allocatable pool.
--   2. The worker finishes bringing devices up and starts beating. Nothing clears the quarantine:
--      the only writer that ever did is `POST /workers/register`.
--   3. The agent does not re-register, because its stored capability fingerprint is unchanged and
--      its heartbeat succeeds (`workers/agent/src/agent.ts`). Restarting it changes nothing, for
--      the same reason. The refusal is deliberate — an agent that re-registered on every wobble
--      would repeatedly un-quarantine a host an operator had taken out of service.
--
-- So the recovery path assumed a re-registration that a healthy agent never performs, and the farm
-- sits at `available: 0` until a human deletes the agent's state file.
--
-- THE FIX IS TO SPLIT THE TWO KINDS OF QUARANTINE, because they have different exit conditions. A
-- silence quarantine asserts "this host is not beating" and a heartbeat FALSIFIES it — the evidence
-- that put the host away is gone, so it comes back. An operator quarantine asserts a judgement no
-- packet can refute, and only a human lifts it. Recording which one it is makes the difference
-- checkable instead of guessable, and it is why this is a column rather than a match on the reason
-- text: `quarantine_reason` is a human-readable sentence and inferring policy from prose is how you
-- get a farm that self-heals out of a deliberate quarantine because someone reworded a log line.

BEGIN;

ALTER TABLE hosts ADD COLUMN quarantine_source text
  CHECK (quarantine_source IS NULL OR quarantine_source IN ('reaper', 'operator'));

COMMENT ON COLUMN hosts.quarantine_source IS
  'reaper = quarantined for silence, cleared by the next heartbeat; operator = deliberate, only a human lifts it. NULL when the host is not quarantined.';

-- WHAT THE DEVICE WAS DOING BEFORE, because coming back is not the same as coming back READY.
--
-- `quarantine_host` collapses READY, OFFLINE, BOOTING and CLEANING into QUARANTINED, and CLEANING is
-- the one that matters: it means a session ended on that device and no worker has confirmed the
-- snapshot restore yet. Promoting it to READY on recovery would hand the next tenant a device still
-- carrying the last one's data — the exact leak the CLEANING state exists to prevent. So the prior
-- state is kept and restored rather than assumed.
--
-- Rows quarantined before this migration have NULL here and are deliberately left QUARANTINED by
-- the clear below: their prior state is genuinely unknown, and guessing it is the failure this
-- column exists to avoid. Registration remains their recovery, as it is today.
ALTER TABLE devices ADD COLUMN quarantined_from device_state;

COMMENT ON COLUMN devices.quarantined_from IS
  'The state this device held when its host was quarantined, restored when the quarantine clears. NULL means it was not quarantined by quarantine_host, or predates migration 016.';

-- ---------------------------------------------------------------- quarantine_host, with a source
--
-- Dropped and recreated rather than overloaded: an `(uuid,text)` and an `(uuid,text,text DEFAULT)`
-- side by side make every existing two-argument call ambiguous, and Postgres reports that at call
-- time rather than at migration time. The default is 'operator' so that a future caller which does
-- not think about this gets the conservative answer — a quarantine that stays until a human lifts
-- it — instead of one that quietly clears itself.
DROP FUNCTION quarantine_host(uuid, text);

CREATE FUNCTION quarantine_host(p_host uuid, p_reason text, p_source text DEFAULT 'operator')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF p_source NOT IN ('reaper', 'operator') THEN
    RAISE EXCEPTION 'quarantine_host: p_source must be reaper or operator, got %', p_source;
  END IF;

  UPDATE hosts
     SET state = 'QUARANTINED', quarantined_at = now(), quarantine_reason = p_reason,
         quarantine_source = p_source
   WHERE id = p_host;

  -- RESERVED and SESSION_ACTIVE are left alone, as they always have been: a device with a tenant on
  -- it is not idle capacity to withdraw, and its session is expired by its own path.
  --
  -- `state <> 'QUARANTINED'` in the predicate is what makes a second quarantine harmless: without
  -- it, quarantining an already-quarantined host would overwrite `quarantined_from` with
  -- QUARANTINED and the device could never be restored to anything meaningful.
  UPDATE devices
     SET quarantined_from = state, state = 'QUARANTINED', updated_at = now()
   WHERE host_id = p_host AND state IN ('READY','OFFLINE','BOOTING','CLEANING');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- ---------------------------------------------------------------- and the way back
--
-- Returns the number of devices restored, or -1 when there was nothing to clear — the host is not
-- quarantined, or it is quarantined by an operator and a heartbeat has no standing to argue.
--
-- The source check is repeated here rather than trusted to the caller. The heartbeat route reads
-- the host row and only calls this when it looks clearable, which saves a write on every one of the
-- six beats a minute a host sends; that is an optimisation, not the authorisation. A worker's own
-- credential reaches this path, so the rule that an operator quarantine survives contact with the
-- host it is about has to hold inside the function body (migration 005's lesson).
CREATE FUNCTION clear_silence_quarantine(p_host uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE hosts
     SET state = 'UP', quarantined_at = NULL, quarantine_reason = NULL, quarantine_source = NULL
   WHERE id = p_host AND state = 'QUARANTINED' AND quarantine_source = 'reaper';
  IF NOT FOUND THEN RETURN -1; END IF;

  UPDATE devices
     SET state = quarantined_from, quarantined_from = NULL, updated_at = now()
   WHERE host_id = p_host AND state = 'QUARANTINED' AND quarantined_from IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Both are fleet-wide mutations called on the system pool, so they follow 008's split and 012's
-- ownership rule: owned by mfarm_definer (never a superuser, or they would execute as one), and
-- unreachable from the app pool. Postgres grants EXECUTE to PUBLIC by default and says nothing
-- about it, which is what the REVOKE is for.
ALTER FUNCTION quarantine_host(uuid,text,text)   OWNER TO mfarm_definer;
ALTER FUNCTION clear_silence_quarantine(uuid)    OWNER TO mfarm_definer;
REVOKE EXECUTE ON FUNCTION quarantine_host(uuid,text,text) FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION clear_silence_quarantine(uuid)  FROM PUBLIC, mfarm_app;

COMMIT;
