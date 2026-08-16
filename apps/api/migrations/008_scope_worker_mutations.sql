-- SECURITY FIX: host-scope the WORKER-facing mutations.
--
-- 005 fixed the two tenant-facing SECURITY DEFINER functions and stopped there. The same defect was
-- still live on the other side of the fleet boundary, where the caller is a worker rather than a
-- tenant and the missing check is `belongs to this host` rather than `belongs to this org`:
--
--   device_reset_complete(device, fence)
--     Filtered on device id alone. `POST /v1/workers/events` takes the device id straight from the
--     request body and never compares it to the authenticated host, so ANY registered worker could
--     mark ANY other host's device READY. The fence is not a defence: it is a small monotonic
--     integer, known to the worker that last held the device and guessable in a handful of tries.
--     A device moved to READY while its snapshot restore is still running is handed to the next
--     tenant with the previous tenant's data still on it — the exact leak that "reset means snapshot
--     restore, enforced" (v2 decision 5) exists to prevent.
--
--   metering ingest
--     A plain INSERT on the system pool with a worker-supplied org_id, session id and device id.
--     A worker could bill an arbitrary quantity of device-seconds to an arbitrary org, and — because
--     ingest is idempotent by a worker-chosen event id — could also claim an event id ahead of time
--     so the real usage arrived later and was silently absorbed as a duplicate. Nothing about the
--     request was checked against the host that sent it.
--
-- The lesson from 005, restated for this side: authorisation lives inside the function body. Put the
-- caller's identity in the signature so it cannot be forgotten at the call site, and DERIVE anything
-- that decides who gets charged rather than accepting it from the caller.

BEGIN;

-- ---------------------------------------------------------------- device_reset_complete

-- Signature changes, so drop rather than replace (which would leave the unscoped overload callable).
DROP FUNCTION IF EXISTS device_reset_complete(uuid, bigint);

CREATE FUNCTION device_reset_complete(p_host uuid, p_device uuid, p_fence bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE devices
     SET state = 'READY', last_reset_at = now(), updated_at = now()
   WHERE id = p_device
     AND host_id = p_host                     -- the fix
     AND fence = p_fence
     AND state = 'CLEANING';
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------- metering

-- Takes the batch as parallel arrays, matching the single-round-trip unnest INSERT it replaces: a
-- busy host emits continuously, and a statement per event would cost more than the work being
-- measured.
--
-- Two counts come back, not one. The caller used to derive duplicates as `sent - recorded`, which
-- after this change would quietly relabel a REJECTED event as a duplicate — turning an authorisation
-- failure into a line of arithmetic nobody reads. Rejections are counted separately so a worker can
-- be told, loudly, that it sent something it had no business sending.
CREATE FUNCTION record_metering(
  p_host        uuid,
  p_event_ids   uuid[],
  p_session_ids uuid[],
  p_device_ids  uuid[],
  p_kinds       text[],
  p_quantities  numeric[],
  p_occurred    timestamptz[]
)
RETURNS TABLE (o_recorded integer, o_rejected integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total    integer := coalesce(array_length(p_event_ids, 1), 0);
  v_recorded integer;
  v_rejected integer;
BEGIN
  -- The authorisation join, and the whole point of this function:
  --   * the event must name a session that exists;
  --   * that session's device must live on the host that is reporting — a worker may bill only for
  --     work its own hardware did;
  --   * org_id comes from the SESSION, never from the request. A worker has no way to know better
  --     than the control plane which org is paying, so being told is pure attack surface.
  -- Metering flushes after a session ends (the agent buffers across the end), so session state is
  -- deliberately not filtered. Ownership is the only question being asked here.
  WITH incoming AS (
    SELECT * FROM unnest(p_event_ids, p_session_ids, p_device_ids, p_kinds, p_quantities, p_occurred)
      AS t(event_id, session_id, device_id, kind, quantity, occurred_at)
  ),
  authorised AS (
    SELECT i.event_id, s.org_id, i.session_id, s.device_id, i.kind, i.quantity, i.occurred_at
      FROM incoming i
      JOIN sessions s ON s.id = i.session_id
      JOIN devices  d ON d.id = s.device_id
     WHERE d.host_id = p_host
       -- A device id disagreeing with the session's own device is a confused (or lying) worker.
       -- Take the session's, and only when the worker agrees or said nothing.
       AND (i.device_id IS NULL OR i.device_id = s.device_id)
  ),
  inserted AS (
    INSERT INTO metering_events (event_id, org_id, session_id, device_id, kind, quantity, occurred_at)
    SELECT event_id, org_id, session_id, device_id, kind, quantity, occurred_at FROM authorised
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  )
  SELECT (SELECT count(*) FROM inserted)::integer,
         (v_total - (SELECT count(*) FROM authorised))::integer
    INTO v_recorded, v_rejected;

  RETURN QUERY SELECT v_recorded, v_rejected;
END $$;

-- ---------------------------------------------------------------- grants
--
-- Postgres grants EXECUTE on every new function to PUBLIC by default, so a definer function is
-- callable by mfarm_app unless something says otherwise — "we never granted it" is not a control.
-- Revoke from PUBLIC first, then hand back exactly what request handling calls.
--
-- Fleet-wide operations run on the SYSTEM pool, which connects as the owner and needs no grant at
-- all. Every EXECUTE mfarm_app holds is a definer function reachable from a request handler, so the
-- fleet ones are simply not granted: none is called through withTenant today, and a route that
-- wants one later should have to change this file to get it.
REVOKE EXECUTE ON FUNCTION device_reset_complete(uuid,uuid,bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_metering(uuid,uuid[],uuid[],uuid[],text[],numeric[],timestamptz[])
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION expire_sessions()          FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION promote_queued(integer)    FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION quarantine_host(uuid,text) FROM PUBLIC, mfarm_app;

COMMIT;
