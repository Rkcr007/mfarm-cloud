-- The W3C WebDriver hub (v2 decision 10).
--
-- Migration from an incumbent has to be one hub URL and two capabilities, which means an existing
-- Appium suite points at us and keeps working. Two things have to exist in the schema for that:
--
--   1. somewhere to send the commands. `hosts.endpoint` is the DATA plane (wss, browser-facing);
--      the automation server is a different protocol on a different port, and a host may have one
--      without the other. It gets its own column rather than a derived port, because "guess the
--      port" is the kind of convention that survives until the first host that cannot honour it.
--   2. a mapping from OUR session id to the upstream automation session id, so a proxied command
--      can be rewritten. Keyed by sessions.id so the WebDriver session id a customer sees in their
--      test log is the same id as in the API, the artifact index and the invoice — one id, not a
--      correlation exercise at 2am.

BEGIN;

-- Base URL of the automation (Appium) server that fronts this host's devices, e.g.
-- http://10.0.3.14:4723. Reachable from the control plane on the internal network ONLY: exposing an
-- Appium port to the internet hands out unauthenticated device control, so the hub is the sole
-- ingress and enforces the tenant boundary in front of it.
ALTER TABLE hosts ADD COLUMN automation_endpoint text;

CREATE TABLE webdriver_sessions (
  session_id          uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  device_id           uuid REFERENCES devices(id) ON DELETE SET NULL,
  -- The id the upstream automation server knows this session by. Opaque text: it is Appium's, not
  -- ours, and nothing here should assume it is a uuid.
  upstream_session_id text NOT NULL,
  upstream_base_url   text NOT NULL,
  -- What the upstream actually granted, which is not always what was asked for. Returned to the
  -- client verbatim, and worth keeping for support ("it picked API 34, you assumed 35").
  capabilities        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_command_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webdriver_sessions_org_idx ON webdriver_sessions(org_id);
-- Supports finding sessions a client has stopped driving without deleting.
CREATE INDEX webdriver_sessions_idle_idx ON webdriver_sessions(last_command_at);

ALTER TABLE webdriver_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdriver_sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY webdriver_sessions_own_org ON webdriver_sessions
  USING (org_id = current_org()) WITH CHECK (org_id = current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON webdriver_sessions TO mfarm_app;

-- ---------------------------------------------------------------- capability-aware allocation
--
-- A WebDriver session needs a device with an automation server attached, and "allocate anything,
-- then discover it cannot drive Appium, then hand it back" is not an algorithm — on a mixed fleet it
-- is a loop. The allocator has to be able to say what it needs.
--
-- The constraints go in their own column rather than into `requested`, which is a tenant-supplied
-- opaque blob: mixing scheduler input with customer input in one document means a customer who
-- happens to send {"platform":"ios"} is editing our scheduling decisions.
ALTER TABLE sessions ADD COLUMN constraints jsonb NOT NULL DEFAULT '{}'::jsonb;

DROP FUNCTION IF EXISTS allocate_device(uuid,uuid,text,text,text,interval,jsonb);

CREATE FUNCTION allocate_device(
  p_org          uuid,
  p_user         uuid,
  p_region       text,
  p_platform     text,
  p_tier         text     DEFAULT NULL,
  p_ttl          interval DEFAULT '30 minutes',
  p_requested    jsonb    DEFAULT '{}'::jsonb,
  -- Capabilities the device MUST declare, e.g. '["webdriver"]'. Matched with @>.
  p_require_caps jsonb    DEFAULT '[]'::jsonb
)
RETURNS TABLE (o_session_id uuid, o_device_id uuid, o_fence bigint, o_state session_state)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_max         integer;
  v_active      integer;
  v_dev         uuid;
  v_fence       bigint;
  v_sess        uuid;
  v_constraints jsonb;
BEGIN
  -- Everything a promotion will need to re-run this decision later, recorded at queue time. The TTL
  -- is included because promotion happens minutes after the request that chose it, and a session
  -- that asked for four hours should not silently come back with thirty minutes.
  v_constraints := jsonb_build_object(
    'platform', p_platform, 'tier', p_tier,
    'requireCaps', COALESCE(p_require_caps, '[]'::jsonb),
    'ttlSeconds', EXTRACT(epoch FROM p_ttl)::bigint);

  SELECT max_concurrent INTO v_max FROM orgs WHERE id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown org %', p_org USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT count(*) INTO v_active
    FROM sessions s
   WHERE s.org_id = p_org AND s.state IN ('ALLOCATING','ACTIVE');

  IF v_active >= v_max THEN
    INSERT INTO sessions (org_id, user_id, state, region, requested, constraints)
    VALUES (p_org, p_user, 'QUEUED', p_region, p_requested, v_constraints)
    RETURNING id INTO v_sess;
    RETURN QUERY SELECT v_sess, NULL::uuid, NULL::bigint, 'QUEUED'::session_state;
    RETURN;
  END IF;

  WITH candidate AS (
    SELECT d.id
      FROM devices d
     WHERE d.state = 'READY'
       AND d.region = p_region
       AND d.platform = p_platform
       AND (p_tier IS NULL OR d.tier = p_tier)
       AND (d.org_id IS NULL OR d.org_id = p_org)
       AND d.capabilities @> COALESCE(p_require_caps, '[]'::jsonb)
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
    INSERT INTO sessions (org_id, user_id, state, region, requested, constraints)
    VALUES (p_org, p_user, 'QUEUED', p_region, p_requested, v_constraints)
    RETURNING id INTO v_sess;
    RETURN QUERY SELECT v_sess, NULL::uuid, NULL::bigint, 'QUEUED'::session_state;
    RETURN;
  END IF;

  INSERT INTO sessions (org_id, user_id, device_id, state, fence, region, requested, constraints, expires_at)
  VALUES (p_org, p_user, v_dev, 'ALLOCATING', v_fence, p_region, p_requested, v_constraints, now() + p_ttl)
  RETURNING id INTO v_sess;

  RETURN QUERY SELECT v_sess, v_dev, v_fence, 'ALLOCATING'::session_state;
END $$;

-- Promotion has to honour the SAME constraints the original request was queued under. Previously it
-- matched on region and org only, so a queued Android session could be promoted onto an iOS device
-- and the client would find out from a confused Appium server rather than from the scheduler.
CREATE OR REPLACE FUNCTION promote_queued(p_limit integer DEFAULT 20)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_dev uuid; v_fence bigint; v_promoted integer := 0;
        v_platform text; v_tier text; v_caps jsonb; v_ttl interval;
BEGIN
  FOR r IN
    SELECT s.id, s.org_id, s.region, s.constraints, o.max_concurrent
      FROM sessions s JOIN orgs o ON o.id = s.org_id
     WHERE s.state = 'QUEUED'
     ORDER BY s.created_at
     LIMIT p_limit
  LOOP
    CONTINUE WHEN (SELECT count(*) FROM sessions
                    WHERE org_id = r.org_id AND state IN ('ALLOCATING','ACTIVE')) >= r.max_concurrent;

    v_platform := r.constraints->>'platform';
    v_tier     := r.constraints->>'tier';
    v_caps     := COALESCE(r.constraints->'requireCaps', '[]'::jsonb);
    v_ttl      := make_interval(secs => COALESCE((r.constraints->>'ttlSeconds')::bigint, 1800));

    WITH candidate AS (
      SELECT d.id FROM devices d
       WHERE d.state = 'READY' AND d.region = r.region
         AND (v_platform IS NULL OR d.platform = v_platform)
         AND (v_tier IS NULL OR d.tier = v_tier)
         AND (d.org_id IS NULL OR d.org_id = r.org_id)
         AND d.capabilities @> v_caps
       ORDER BY (d.org_id IS NULL), d.updated_at
       FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE devices d SET state = 'RESERVED', fence = d.fence + 1, updated_at = now()
      FROM candidate c WHERE d.id = c.id
    RETURNING d.id, d.fence INTO v_dev, v_fence;

    CONTINUE WHEN v_dev IS NULL;

    UPDATE sessions SET state = 'ALLOCATING', device_id = v_dev, fence = v_fence,
                        expires_at = now() + v_ttl
     WHERE id = r.id;
    v_promoted := v_promoted + 1;
    v_dev := NULL;
  END LOOP;
  RETURN v_promoted;
END $$;

GRANT EXECUTE ON FUNCTION allocate_device(uuid,uuid,text,text,text,interval,jsonb,jsonb) TO mfarm_app;
GRANT EXECUTE ON FUNCTION promote_queued(integer) TO mfarm_app;

COMMIT;
