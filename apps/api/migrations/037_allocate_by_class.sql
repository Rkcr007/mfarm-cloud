-- 037: the console promises a device class the allocator has never been able to keep.
--
-- FOUND BY READING THE ALLOCATOR AGAINST THE CONSOLE, 2026-09-04, while implementing the design
-- package's copy deck. The device card's primary action now reads:
--
--     Start MFARM X1 Pro
--
-- and `POST /v1/sessions` is called with `{ region, platform, tier }` and nothing else. The
-- candidate query in migration 006 matches on region, platform, tier, org and capabilities — there
-- is no profile in it and never has been. On a farm whose devices are all `tier: cuttlefish` in one
-- region, that button can hand you an MFARM X1, or an unprofiled 720x1280 device, and say nothing.
--
-- The old label was `Start a session on tier cuttlefish`. It was ugly and it was ACCURATE. The new
-- one is neither, and that is the wrong direction for this product to move in: a console whose
-- claim is that it never misrepresents the machine cannot have its most-pressed button naming a
-- thing it does not deliver.
--
-- ---------------------------------------------------------------- what the design assumed
--
-- The design package states its assumption as "allocation is CLASS-ONLY" — you are promised a
-- class, never a particular unit. That is a fair description of what the product should do, and it
-- is not what the code does: allocation is TIER-only, which is a strictly coarser grain. A tier is
-- a virtualisation technology; a class is a device somebody chose. Two devices can share a tier and
-- differ in the one property that made someone pick one of them, which is the screen.
--
-- This migration makes the documented assumption true.
--
-- ---------------------------------------------------------------- why two parameters, not one
--
-- `p_profile` alone cannot express the three intents, because one of them is "no profile":
--
--     match nothing      the CLI and the WebDriver hub, which want any device that can be driven
--     match 'mfarm-x1'   the console starting a named class
--     match no profile   the console starting one of the farm's UNPROFILED devices
--
-- With a single nullable parameter the third is indistinguishable from the first, so pressing
-- "Start Unprofiled device" would allocate an X1 Pro — a nicer device than was asked for, and still
-- not the one the button named. A sentinel string would work and would be a trap for whoever reads
-- it next. `p_match_profile` says plainly that the caller is constraining, and `IS NOT DISTINCT
-- FROM` is the NULL-safe comparison that then does the right thing for all three.
--
-- DEFAULT false, so every existing caller keeps its exact behaviour. The CLI, the hub and any suite
-- that has never heard of a profile allocate precisely what they allocate today.
--
-- ---------------------------------------------------------------- the queue is the other half
--
-- `promote_queued` re-runs the allocation decision minutes later, off `sessions.constraints`, and
-- it has to honour the same constraint or the promise breaks on the slower path — which is the path
-- somebody is actually waiting on. It reads `constraints->>'profile'` below, and `constraints` is
-- where 006 already put platform, tier, requireCaps and ttlSeconds for exactly this reason.
--
-- The two functions are kept in step by construction: `allocate_device` writes the blob and
-- `promote_queued` reads it, so a constraint added to one without the other is a constraint that
-- visibly does nothing on promotion rather than one that silently does something different.
--
-- ---------------------------------------------------------------- security
--
-- The new predicate can only NARROW the candidate set. Row-level security and the existing
-- `d.org_id IS NULL OR d.org_id = p_org` clause are untouched and still decide what is visible; a
-- caller naming a profile can reach nothing it could not reach before.

BEGIN;

-- The signature changes, so the old one is dropped rather than overloaded. Two functions differing
-- only in trailing defaulted parameters is an ambiguity Postgres resolves at call time, and the
-- resolution nobody intended is the one that keeps today's behaviour while looking fixed.
-- Migration 006 dropped its own predecessor the same way.
DROP FUNCTION IF EXISTS allocate_device(uuid,uuid,text,text,text,interval,jsonb,jsonb);

CREATE FUNCTION allocate_device(
  p_org           uuid,
  p_user          uuid,
  p_region        text,
  p_platform      text,
  p_tier          text     DEFAULT NULL,
  p_ttl           interval DEFAULT '30 minutes',
  p_requested     jsonb    DEFAULT '{}'::jsonb,
  -- Capabilities the device MUST declare, e.g. '["webdriver"]'. Matched with @>.
  p_require_caps  jsonb    DEFAULT '[]'::jsonb,
  -- The device class. Only consulted when p_match_profile is true — see the header.
  p_profile       text     DEFAULT NULL,
  p_match_profile boolean  DEFAULT false
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
  --
  -- `matchProfile` is recorded ALONGSIDE `profile` rather than inferred from it, for the same
  -- reason the parameters are separate: a stored `"profile": null` has to mean "the unprofiled
  -- class" on promotion, and it can only mean that if something else says the caller was
  -- constraining at all.
  v_constraints := jsonb_build_object(
    'platform', p_platform, 'tier', p_tier,
    'requireCaps', COALESCE(p_require_caps, '[]'::jsonb),
    'profile', p_profile,
    'matchProfile', COALESCE(p_match_profile, false),
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
       -- NULL-safe on purpose: with p_match_profile true and p_profile NULL this matches exactly
       -- the devices that have no profile, which is a real class somebody can ask for.
       AND (NOT COALESCE(p_match_profile, false) OR d.profile IS NOT DISTINCT FROM p_profile)
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

-- ---------------------------------------------------------------- the queue honours it too

CREATE OR REPLACE FUNCTION promote_queued(p_limit integer DEFAULT 20)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_dev uuid; v_fence bigint; v_promoted integer := 0;
        v_platform text; v_tier text; v_caps jsonb; v_ttl interval;
        v_profile text; v_match_profile boolean;
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

    -- Sessions QUEUED before this migration have no `matchProfile` key, so they promote exactly as
    -- they would have. `->>` on a JSON null also yields SQL NULL, which is why the flag is read
    -- from its own key rather than inferred from the profile being absent.
    v_match_profile := COALESCE((r.constraints->>'matchProfile')::boolean, false);
    v_profile       := r.constraints->>'profile';

    WITH candidate AS (
      SELECT d.id FROM devices d
       WHERE d.state = 'READY' AND d.region = r.region
         AND (v_platform IS NULL OR d.platform = v_platform)
         AND (v_tier IS NULL OR d.tier = v_tier)
         AND (d.org_id IS NULL OR d.org_id = r.org_id)
         AND d.capabilities @> v_caps
         AND (NOT v_match_profile OR d.profile IS NOT DISTINCT FROM v_profile)
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

-- ---------------------------------------------------------------- re-assert the ACL and the owner
--
-- The dropped function took its OWNER and its ACL with it, and a REPLACEMENT DOES NOT INHERIT
-- EITHER. Both have to be restated here, and the order is the part that is easy to get wrong.
--
-- REVOKE FIRST. Postgres grants EXECUTE to PUBLIC on every new function, so `allocate_device` is
-- reachable by every role the moment it is created — and it is SECURITY DEFINER, which means it
-- runs as its owner rather than as its caller. Granting to `mfarm_app` without revoking PUBLIC
-- leaves the explicit grant decorative: the app pool could already call it, and so could anything
-- else. Migration 012 made exactly this revoke for the previous signature and said why; dropping
-- the function threw that away.
--
-- OWNERSHIP LAST, for 012's stated reason: doing it before the revoke leaves a window in which the
-- function both runs as `mfarm_definer` and is callable by PUBLIC.
REVOKE EXECUTE ON FUNCTION allocate_device(uuid,uuid,text,text,text,interval,jsonb,jsonb,text,boolean)
  FROM PUBLIC;
ALTER FUNCTION allocate_device(uuid,uuid,text,text,text,interval,jsonb,jsonb,text,boolean)
  OWNER TO mfarm_definer;
GRANT EXECUTE ON FUNCTION allocate_device(uuid,uuid,text,text,text,interval,jsonb,jsonb,text,boolean)
  TO mfarm_app;

COMMIT;
