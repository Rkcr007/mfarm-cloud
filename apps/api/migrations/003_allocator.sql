-- The allocator. This is the file to review most carefully — it is the only place where two tenants
-- can end up on one device, and the bug would be invisible until a customer sees someone else's app.
--
-- v2 decision 3: Postgres allocates, not Redis. Allocation and session creation happen in ONE
-- transaction, so there is no window where a device is claimed but no session exists (or vice versa).

BEGIN;

-- ---------------------------------------------------------------- allocate
--
-- Returns a row with device_id set (allocated) or NULL (queued). Never blocks on another
-- allocator's chosen device: SKIP LOCKED means concurrent callers take different rows instead of
-- queueing behind each other, which is what keeps p99 allocation flat as the fleet grows.
CREATE OR REPLACE FUNCTION allocate_device(
  p_org       uuid,
  p_user      uuid,
  p_region    text,
  p_platform  text,
  p_tier      text     DEFAULT NULL,
  p_ttl       interval DEFAULT '30 minutes',
  p_requested jsonb    DEFAULT '{}'::jsonb
)
-- OUT columns are o_-prefixed on purpose. plpgsql resolves a bare `state` or `fence` to the OUT
-- parameter before the table column, so unprefixed names here produce "column reference is
-- ambiguous" at runtime — a failure that only appears once the function is actually called.
RETURNS TABLE (o_session_id uuid, o_device_id uuid, o_fence bigint, o_state session_state)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_max    integer;
  v_active integer;
  v_dev    uuid;
  v_fence  bigint;
  v_sess   uuid;
BEGIN
  -- Lock the org row first. Without this, two concurrent allocations for the same org can both read
  -- active_count = max-1 and both proceed, overshooting the cap. Org-level contention is low, so
  -- serialising here costs nothing real and makes the quota exact rather than approximate.
  SELECT max_concurrent INTO v_max FROM orgs WHERE id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown org %', p_org USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT count(*) INTO v_active
    FROM sessions s
   WHERE s.org_id = p_org AND s.state IN ('ALLOCATING','ACTIVE');

  IF v_active >= v_max THEN
    INSERT INTO sessions (org_id, user_id, state, region, requested)
    VALUES (p_org, p_user, 'QUEUED', p_region, p_requested)
    RETURNING id INTO v_sess;
    RETURN QUERY SELECT v_sess, NULL::uuid, NULL::bigint, 'QUEUED'::session_state;
    RETURN;
  END IF;

  -- Pick and claim in one statement.
  --   FOR UPDATE SKIP LOCKED : concurrent allocators take different devices
  --   fence = fence + 1      : monotonic token, so a stale client that reconnects after a network
  --                            partition presents an old fence and the worker rejects it
  WITH candidate AS (
    SELECT d.id
      FROM devices d
     WHERE d.state = 'READY'
       AND d.region = p_region
       AND d.platform = p_platform
       AND (p_tier IS NULL OR d.tier = p_tier)
       AND (d.org_id IS NULL OR d.org_id = p_org)
     -- dedicated devices first, so the shared pool is preserved for orgs that have nothing else;
     -- then least-recently-touched, which spreads wear and surfaces stuck devices sooner
     ORDER BY (d.org_id IS NULL), d.updated_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE devices d
     SET state = 'RESERVED', fence = d.fence + 1, updated_at = now()
    FROM candidate c
   WHERE d.id = c.id
  RETURNING d.id, d.fence INTO v_dev, v_fence;

  IF v_dev IS NULL THEN
    -- capacity exists for this org, but no matching device is free right now
    INSERT INTO sessions (org_id, user_id, state, region, requested)
    VALUES (p_org, p_user, 'QUEUED', p_region, p_requested)
    RETURNING id INTO v_sess;
    RETURN QUERY SELECT v_sess, NULL::uuid, NULL::bigint, 'QUEUED'::session_state;
    RETURN;
  END IF;

  INSERT INTO sessions (org_id, user_id, device_id, state, fence, region, requested, expires_at)
  VALUES (p_org, p_user, v_dev, 'ALLOCATING', v_fence, p_region, p_requested, now() + p_ttl)
  RETURNING id INTO v_sess;

  RETURN QUERY SELECT v_sess, v_dev, v_fence, 'ALLOCATING'::session_state;
END $$;

-- ---------------------------------------------------------------- activate

-- Worker confirms the stream is live. Fence must match, otherwise this is a stale worker reporting
-- on an allocation that has since been superseded.
CREATE OR REPLACE FUNCTION session_activate(p_session uuid, p_fence bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_dev uuid;
BEGIN
  UPDATE sessions s
     SET state = 'ACTIVE', started_at = now()
   WHERE s.id = p_session AND s.state = 'ALLOCATING' AND s.fence = p_fence
  RETURNING s.device_id INTO v_dev;

  IF v_dev IS NULL THEN RETURN false; END IF;

  UPDATE devices SET state = 'SESSION_ACTIVE', updated_at = now()
   WHERE id = v_dev AND fence = p_fence;
  RETURN true;
END $$;

-- ---------------------------------------------------------------- release

-- Ends a session and sends the device to CLEANING — never straight to READY. The device only
-- becomes allocatable again once a worker reports a completed snapshot restore (v2 decision 5).
CREATE OR REPLACE FUNCTION release_device(p_session uuid, p_reason text DEFAULT 'client_disconnect')
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_dev uuid;
BEGIN
  UPDATE sessions s
     SET state = 'ENDED', ended_at = now(), end_reason = p_reason
   WHERE s.id = p_session AND s.state IN ('QUEUED','ALLOCATING','ACTIVE')
  RETURNING s.device_id INTO v_dev;

  IF NOT FOUND THEN RETURN false; END IF;
  IF v_dev IS NULL THEN RETURN true; END IF;   -- was queued, never held a device

  UPDATE devices SET state = 'CLEANING', updated_at = now() WHERE id = v_dev;
  RETURN true;
END $$;

-- Worker reports the snapshot restore finished. Fence check stops a worker that was partitioned
-- during a previous allocation from marking a now-reallocated device as free.
CREATE OR REPLACE FUNCTION device_reset_complete(p_device uuid, p_fence bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE devices
     SET state = 'READY', last_reset_at = now(), updated_at = now()
   WHERE id = p_device AND fence = p_fence AND state = 'CLEANING';
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------- reaper

-- v1's rule "never leave a device permanently locked" implemented as an actual mechanism rather
-- than an intention. Run on a schedule.
CREATE OR REPLACE FUNCTION expire_sessions()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  WITH expired AS (
    UPDATE sessions s
       SET state = 'ENDED', ended_at = now(), end_reason = 'timeout'
     WHERE s.state IN ('ALLOCATING','ACTIVE') AND s.expires_at < now()
    RETURNING s.device_id
  )
  UPDATE devices d
     SET state = 'CLEANING', updated_at = now()
    FROM expired e
   WHERE d.id = e.device_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- ---------------------------------------------------------------- quarantine

-- v2 decision 8. A host failing health checks is drained, not silently retried into a user session.
-- Devices in use are left alone; the reaper collects them when their sessions end.
CREATE OR REPLACE FUNCTION quarantine_host(p_host uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE hosts
     SET state = 'QUARANTINED', quarantined_at = now(), quarantine_reason = p_reason
   WHERE id = p_host;

  UPDATE devices
     SET state = 'QUARANTINED', updated_at = now()
   WHERE host_id = p_host AND state IN ('READY','OFFLINE','BOOTING','CLEANING');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- ---------------------------------------------------------------- queue promotion

-- Gives the QUEUED state meaning. Oldest first, and only for orgs currently under their cap.
CREATE OR REPLACE FUNCTION promote_queued(p_limit integer DEFAULT 20)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_dev uuid; v_fence bigint; v_promoted integer := 0;
BEGIN
  FOR r IN
    SELECT s.id, s.org_id, s.region, s.requested, o.max_concurrent
      FROM sessions s JOIN orgs o ON o.id = s.org_id
     WHERE s.state = 'QUEUED'
     ORDER BY s.created_at
     LIMIT p_limit
  LOOP
    CONTINUE WHEN (SELECT count(*) FROM sessions
                    WHERE org_id = r.org_id AND state IN ('ALLOCATING','ACTIVE')) >= r.max_concurrent;

    WITH candidate AS (
      SELECT d.id FROM devices d
       WHERE d.state = 'READY' AND d.region = r.region
         AND (d.org_id IS NULL OR d.org_id = r.org_id)
       ORDER BY (d.org_id IS NULL), d.updated_at
       FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE devices d SET state = 'RESERVED', fence = d.fence + 1, updated_at = now()
      FROM candidate c WHERE d.id = c.id
    RETURNING d.id, d.fence INTO v_dev, v_fence;

    CONTINUE WHEN v_dev IS NULL;

    UPDATE sessions SET state = 'ALLOCATING', device_id = v_dev, fence = v_fence,
                        expires_at = now() + interval '30 minutes'
     WHERE id = r.id;
    v_promoted := v_promoted + 1;
    v_dev := NULL;
  END LOOP;
  RETURN v_promoted;
END $$;

GRANT EXECUTE ON FUNCTION allocate_device(uuid,uuid,text,text,text,interval,jsonb) TO mfarm_app;
GRANT EXECUTE ON FUNCTION session_activate(uuid,bigint)      TO mfarm_app;
GRANT EXECUTE ON FUNCTION release_device(uuid,text)          TO mfarm_app;
GRANT EXECUTE ON FUNCTION device_reset_complete(uuid,bigint) TO mfarm_app;
GRANT EXECUTE ON FUNCTION expire_sessions()                  TO mfarm_app;
GRANT EXECUTE ON FUNCTION quarantine_host(uuid,text)         TO mfarm_app;
GRANT EXECUTE ON FUNCTION promote_queued(integer)            TO mfarm_app;

COMMIT;
