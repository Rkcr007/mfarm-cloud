-- 043: a queued caller is told where they stand.
--
-- ---------------------------------------------------------------- what is wrong today
--
-- `POST /v1/sessions` answers a queued caller with:
--
--     No device is free right now. The session is queued and will start automatically.
--
-- and nothing else. `mfarm run` then prints "waiting up to 300s" and either starts or exits 75.
-- Over fifteen minutes of a CI log, that is indistinguishable from a hang. The difference between a
-- person waiting calmly and a person killing the job is entirely in whether the queue said
-- anything, and this queue says nothing.
--
-- Everything needed is already stored. `sessions.created_at` gives position and `sessions.expires_at`
-- on the leases ahead gives an estimate — the sessions list read already carries the lease for
-- exactly this reason. What was missing is a caller-facing way to ask.
--
-- ---------------------------------------------------------------- why this is a definer function
--
-- A queued caller has to be told how many sessions are ahead of them INCLUDING OTHER ORGS' — that
-- is what makes the number true — and RLS correctly hides those rows from a tenant connection.
--
-- So the count is computed under `mfarm_definer`, which has BYPASSRLS. The disclosure is bounded by
-- what comes back: **a COUNT and a TIMESTAMP, never a row**. "26 ahead of you" says nothing about
-- who they are, what they asked for, or which org they belong to — and `p_org` is in the predicate
-- so a caller cannot ask about somebody else's session, which is the rule migration 041 learned the
-- hard way and 040 already had.
--
-- ---------------------------------------------------------------- position counts the way the queue drains
--
-- ADR-0028 made promotion round-robin across orgs and FIFO within one. So position is the number of
-- sessions whose `(queue_rank, created_at)` sorts before this one — the same ordering
-- `promote_queued` walks.
--
-- A GLOBAL `created_at` RANK WOULD BE THE OBVIOUS IMPLEMENTATION AND WOULD BE WRONG. It was correct
-- before ADR-0028; it now disagrees with the scheduler, and would tell the second org's first
-- session it is 26th when it is next to be promoted. A queue position that does not match how the
-- queue drains is worse than no queue position, because a person plans around it.

BEGIN;

CREATE OR REPLACE FUNCTION queue_standing(p_org uuid, p_session uuid)
-- `queue_position`, not `position`: `position(x IN y)` is SQL-standard syntax, so a column of that
-- name is a syntax error the moment it appears in a SELECT list. The error says "syntax error at or
-- near \"position\"" and points at the RETURNS clause, which is not where a reader looks first.
RETURNS TABLE (queue_position integer, free_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rank integer; v_created timestamptz; v_region text; v_platform text; v_tier text;
BEGIN
  -- `p_org` in the predicate, not merely derived. `mfarm_definer` has BYPASSRLS, so RLS will not
  -- scope this — migration 041's lesson, and the reason that one shipped a cross-tenant write in
  -- draft. A caller may only ask about their own session.
  SELECT (SELECT count(*) FROM sessions o
           WHERE o.org_id = s.org_id AND o.state = 'QUEUED' AND o.created_at <= s.created_at),
         s.created_at, s.region,
         s.constraints->>'platform', s.constraints->>'tier'
    INTO v_rank, v_created, v_region, v_platform, v_tier
    FROM sessions s
   WHERE s.id = p_session AND s.org_id = p_org AND s.state = 'QUEUED';

  -- Not queued, not theirs, or gone. All three are the same answer, and none is an error: a session
  -- that started between the poll and this call is the ordinary case, not a fault.
  IF v_rank IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    /**
     * How many sort before this one under ADR-0028's ordering, plus one.
     *
     * `q.queue_rank < v_rank` counts every org's earlier laps; the tie-break on equal rank is
     * `created_at`, exactly as `promote_queued` does it. The session itself is excluded by the
     * strict comparisons, so the `+ 1` makes the answer 1-based — "you are next" reads as 1, which
     * is what a person expects and what `ahead: 0` in the API then confirms.
     */
    (1 + (SELECT count(*) FROM (
        SELECT s2.created_at,
               row_number() OVER (PARTITION BY s2.org_id ORDER BY s2.created_at) AS queue_rank
          FROM sessions s2 WHERE s2.state = 'QUEUED'
      ) q
      WHERE q.queue_rank < v_rank
         OR (q.queue_rank = v_rank AND q.created_at < v_created)))::integer,

    /**
     * When a device that could serve this session is next expected to free up.
     *
     * THE ESTIMATE IS DELIBERATELY PESSIMISTIC AND OFTEN NULL, and both are the point.
     *
     * It reads `expires_at` — the LEASE, which is the latest a session may run, not when it will
     * actually end. Most suites finish early, so the real wait is usually shorter than this says. A
     * queue that is early is a queue people trust; one that is late is one they stop believing, and
     * an optimistic estimate built on average durations would be late roughly half the time.
     *
     * NULL where nothing can be proved: no matching device is held under a readable lease. That is
     * the common case on a small farm and it is reported as null rather than guessed, because a
     * confident wrong number is what makes people stop trusting a queue. The API says "queued" with
     * no estimate, which is exactly as much as is known.
     *
     * Matched on the same class predicate the allocator uses, minus capabilities: a device that
     * could not serve this session is not a device whose lease is worth counting.
     */
    (SELECT min(s3.expires_at)
       FROM sessions s3
       JOIN devices d ON d.id = s3.device_id
      WHERE s3.state IN ('ALLOCATING', 'ACTIVE')
        AND s3.expires_at IS NOT NULL
        AND d.region = v_region
        AND (v_platform IS NULL OR d.platform = v_platform)
        AND (v_tier IS NULL OR d.tier = v_tier)
        AND (d.org_id IS NULL OR d.org_id = p_org));
END $$;

-- Granted to `mfarm_app`, unlike `promote_queued`: this is called from a request handler, it takes
-- the org in its signature and names it in the predicate, and it returns a count rather than rows.
REVOKE ALL   ON FUNCTION queue_standing(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION queue_standing(uuid, uuid) OWNER TO mfarm_definer;
GRANT EXECUTE ON FUNCTION queue_standing(uuid, uuid) TO mfarm_app;

COMMIT;
