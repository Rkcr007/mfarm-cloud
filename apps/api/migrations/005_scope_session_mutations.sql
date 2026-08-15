-- SECURITY FIX: org-scope the session mutation functions.
--
-- release_device() and session_activate() are SECURITY DEFINER, which means they execute as the
-- owner and RLS does not apply to them. Both filtered on session id alone, so any authenticated
-- tenant could end (or activate) ANY other tenant's session given only its UUID — the RLS policies
-- on `sessions` provided no protection here at all, because the function never ran under them.
--
-- The general lesson, worth remembering for every future SECURITY DEFINER function: bypassing RLS
-- is the entire point of the marker, so authorisation has to be re-implemented explicitly inside
-- the function body. There is no ambient protection left to fall back on.

BEGIN;

-- Signature changes, so replace rather than CREATE OR REPLACE (which would leave an overload).
DROP FUNCTION IF EXISTS release_device(uuid, text);
DROP FUNCTION IF EXISTS session_activate(uuid, bigint);

CREATE FUNCTION release_device(p_org uuid, p_session uuid, p_reason text DEFAULT 'client_disconnect')
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_dev uuid;
BEGIN
  UPDATE sessions s
     SET state = 'ENDED', ended_at = now(), end_reason = p_reason
   WHERE s.id = p_session
     AND s.org_id = p_org                      -- the fix
     AND s.state IN ('QUEUED','ALLOCATING','ACTIVE')
  RETURNING s.device_id INTO v_dev;

  IF NOT FOUND THEN RETURN false; END IF;
  IF v_dev IS NULL THEN RETURN true; END IF;

  UPDATE devices SET state = 'CLEANING', updated_at = now() WHERE id = v_dev;
  RETURN true;
END $$;

CREATE FUNCTION session_activate(p_org uuid, p_session uuid, p_fence bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_dev uuid;
BEGIN
  UPDATE sessions s
     SET state = 'ACTIVE', started_at = now()
   WHERE s.id = p_session
     AND s.org_id = p_org                      -- the fix
     AND s.state = 'ALLOCATING'
     AND s.fence = p_fence
  RETURNING s.device_id INTO v_dev;

  IF v_dev IS NULL THEN RETURN false; END IF;

  UPDATE devices SET state = 'SESSION_ACTIVE', updated_at = now()
   WHERE id = v_dev AND fence = p_fence;
  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION release_device(uuid,uuid,text)      TO mfarm_app;
GRANT EXECUTE ON FUNCTION session_activate(uuid,uuid,bigint)  TO mfarm_app;

COMMIT;
