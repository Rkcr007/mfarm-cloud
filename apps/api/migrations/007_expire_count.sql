-- expire_sessions() was counting the wrong thing.
--
-- `GET DIAGNOSTICS ROW_COUNT` reports the LAST statement, and the last statement was the UPDATE of
-- the devices belonging to the expired sessions — not the sessions themselves. Those numbers are
-- equal only while every expired session still has a device attached. They diverge exactly when it
-- matters:
--
--   * `sessions.device_id` is `ON DELETE SET NULL`, so a session whose device was removed from the
--     fleet expires while updating zero device rows;
--   * two expired sessions can point at one device row only if the one-live-per-device index has
--     already been violated, but a device deleted mid-flight is routine.
--
-- The failure is silent and in the wrong direction: the reaper does its job and reports that it did
-- nothing, so a monitor watching "sessions expired" sees zero during precisely the fleet churn that
-- makes expiry interesting.

BEGIN;

CREATE OR REPLACE FUNCTION expire_sessions()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  WITH expired AS (
    UPDATE sessions s
       SET state = 'ENDED', ended_at = now(), end_reason = 'timeout'
     WHERE s.state IN ('ALLOCATING','ACTIVE') AND s.expires_at < now()
    RETURNING s.id, s.device_id
  ), cleaned AS (
    UPDATE devices d
       SET state = 'CLEANING', updated_at = now()
      FROM expired e
     WHERE d.id = e.device_id
    RETURNING d.id
  )
  SELECT count(*) INTO v_count FROM expired;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION expire_sessions() TO mfarm_app;

COMMIT;
