-- 039: one org can no longer starve another out of the queue.
--
-- `AutomationExecutionPlan.md` §20 asks for one thing by name: "If ten users submit tests, don't let
-- one user monopolize the device forever." The queue built in 003 and carried forward through 006
-- and 037 does exactly that, and has since the day it was written.
--
-- ---------------------------------------------------------------- what was wrong
--
-- `promote_queued` reads a WINDOW of candidates — the twenty oldest QUEUED sessions in the whole
-- fleet, `ORDER BY created_at LIMIT p_limit` — and then skips each one whose org is already at
-- `max_concurrent`. Every part of that is defensible on its own. Together they stop the queue:
--
--   * an org holding twenty or more queued sessions fills the entire window by itself;
--   * if that org is at its cap, every row in the window hits the `CONTINUE`;
--   * the loop ends having promoted nothing — WITH DEVICES SITTING READY;
--   * the next sweep, ten seconds later, computes the same window and does the same nothing.
--
-- A second org's session is never *considered*. Not deprioritised, not made to wait its turn —
-- never read. It sits QUEUED until the first org's backlog drops under twenty, which happens only
-- at that org's cap rate, one ended session at a time.
--
-- THIS IS INVISIBLE ON A ONE-ORG FARM, which is how it survived thirty-eight migrations. It
-- surfaces on the first day the farm is put in front of a second team — the pending decision in
-- `docs/STATUS.md` §4, and the reason this migration comes before every other execution-engine
-- change in `docs/EXECUTION_ROADMAP.md`.
--
-- ---------------------------------------------------------------- what replaces it
--
-- The window becomes fair instead of chronological: rank each org's queued sessions by age, then
-- take candidates in rank order. Every org's oldest session is considered before any org's second,
-- every org's second before any org's third, and so on. Round-robin ACROSS orgs, strict FIFO
-- WITHIN one.
--
-- The cap check does not move and does not change. It bounds what an org RUNS. The rank bounds what
-- an org OCCUPIES IN THE QUEUE. Those are two different questions and the old query was asking one
-- mechanism to answer both.
--
-- WITH A SINGLE ORG THE BEHAVIOUR IS UNCHANGED, byte for byte: one partition means the ranks are
-- 1..n in `created_at` order, and the tie-break keeps them there. That is what makes this safe to
-- apply to a farm mid-flight — the farm it is being applied to has one org, so the migration that
-- fixes the two-org case cannot disturb the one-org case it is running in.
--
-- ---------------------------------------------------------------- what this deliberately is NOT
--
-- **Not priority, not quotas, not reserved pools.** §20 lists those as things the scheduler should
-- eventually support and asks for "a clean FIFO scheduler with architecture that allows future
-- scheduling policies" in V1. A policy knob added now would be a knob with one customer and no
-- evidence behind its default. The ordering key is the extension point: a priority scheme is a
-- second column in that `ORDER BY`, and a quota is a second `CONTINUE`.
--
-- **Not a change to `allocate_device`.** The synchronous path already treats every org identically
-- — it allocates for whoever asks, or queues them — and has no window to be unfair with.

BEGIN;

-- ---------------------------------------------------------------- the index the ranking wants
--
-- The old query could walk `created_at` and stop after twenty rows. The new one has to rank every
-- QUEUED session before it can take the first candidate, so it reads them all — which is the
-- correct cost of the question, and cheap on any queue a four-device farm can produce, but it is
-- read six times a minute forever by the sweep.
--
-- PARTIAL, on the predicate the function uses. The table is overwhelmingly ENDED rows and only the
-- QUEUED ones are ever ranked, so this indexes the handful that matter and stays small enough to
-- live in cache. `(org_id, created_at)` is the window's PARTITION BY and ORDER BY in that order,
-- which is what lets the planner produce the ranking without a sort.
CREATE INDEX IF NOT EXISTS sessions_queued_idx ON sessions(org_id, created_at)
  WHERE state = 'QUEUED';

-- ---------------------------------------------------------------- promote_queued, made fair
--
-- CREATE OR REPLACE at the SAME SIGNATURE, which preserves the owner and the ACL. That matters
-- here more than usual: this is a SECURITY DEFINER function that mutates devices and sessions
-- fleet-wide, 012 owns it to `mfarm_definer` and 008 revokes it from PUBLIC, and a replacement that
-- silently reset either would be the exact regression `test/definer-acl.test.ts` exists to catch.
-- Both are re-asserted below anyway — belt and braces on the one function where being wrong means
-- every role in the cluster can move every device in the fleet.
CREATE OR REPLACE FUNCTION promote_queued(p_limit integer DEFAULT 20)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_dev uuid; v_fence bigint; v_promoted integer := 0;
        v_platform text; v_tier text; v_caps jsonb; v_ttl interval;
        v_profile text; v_match_profile boolean;
BEGIN
  FOR r IN
    -- `queue_rank`, not `rank`: `rank` is a window function's name and aliasing a column to it
    -- reads as a call to anyone scanning this later.
    SELECT q.id, q.org_id, q.region, q.constraints, o.max_concurrent
      FROM (
        SELECT s.id, s.org_id, s.region, s.constraints, s.created_at,
               row_number() OVER (PARTITION BY s.org_id ORDER BY s.created_at) AS queue_rank
          FROM sessions s
         WHERE s.state = 'QUEUED'
      ) q
      JOIN orgs o ON o.id = q.org_id
     -- The whole fix is this line. `queue_rank` first makes the window round-robin across orgs;
     -- `created_at` second keeps it deterministic, and keeps a single-org farm on exactly the
     -- ordering it had before this migration.
     ORDER BY q.queue_rank, q.created_at
     LIMIT p_limit
  LOOP
    CONTINUE WHEN (SELECT count(*) FROM sessions
                    WHERE org_id = r.org_id AND state IN ('ALLOCATING','ACTIVE')) >= r.max_concurrent;

    v_platform := r.constraints->>'platform';
    v_tier     := r.constraints->>'tier';
    v_caps     := COALESCE(r.constraints->'requireCaps', '[]'::jsonb);
    v_ttl      := make_interval(secs => COALESCE((r.constraints->>'ttlSeconds')::bigint, 1800));

    -- Unchanged from 037. Sessions QUEUED before that migration have no `matchProfile` key and
    -- promote exactly as they would have; the flag is read from its own key rather than inferred
    -- from the profile being absent, because `->>` on a JSON null also yields SQL NULL.
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

-- Re-asserted rather than assumed. REVOKE before the owner change, for 012's reason: doing it the
-- other way round leaves a window in which the function both runs as `mfarm_definer` and is
-- callable by PUBLIC.
--
-- AND FROM `mfarm_app` TOO, which is the part that is easy to get wrong and was got wrong in the
-- first draft of this file. `promote_queued` is a FLEET-WIDE mutation: it moves devices and
-- sessions belonging to every org, and RLS says nothing about a definer function because it runs as
-- its owner. It is called by the reaper on the SYSTEM pool, which connects as the owner and needs
-- no grant at all — so the app pool, the one a request handler reaches the database through, must
-- not be able to call it. 008 revoked it from `mfarm_app` for exactly this reason and said so.
--
-- Copying the `GRANT ... TO mfarm_app` pattern from `allocate_device` here looks harmless and is
-- not: that function is called from a request handler and this one must never be.
-- `test/definer-acl.test.ts` caught the draft that got this backwards, which is what that test is
-- for — it names `promote_queued` in its fleet-wide list.
REVOKE EXECUTE ON FUNCTION promote_queued(integer) FROM PUBLIC, mfarm_app;
ALTER FUNCTION promote_queued(integer) OWNER TO mfarm_definer;

COMMIT;
