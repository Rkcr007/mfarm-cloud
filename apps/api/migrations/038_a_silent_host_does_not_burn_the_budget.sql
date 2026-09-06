-- 038: a reset nobody was there to attempt is not a stalled reset.
--
-- WHAT WENT WRONG, on the lab, 2026-09-05. `cf-4` burned two full reset budgets in thirty minutes
-- and escalated itself out of the pool twice. Nothing was wrong with the device.
--
-- The agent drains and EXITS to withdraw a capability — `POST /workers/heartbeat` ignores its body
-- and only `register` writes capabilities, so withdrawal means restarting (ADR-0003 decision 3,
-- and the comment on `UNHEALTHY_GRACE_MS` in the agent's index.ts). Appium for cf-4 stopped being
-- ready, the grace window expired, and the agent drained — which stops EVERY backend on the host
-- and cold-boots all of them on the way back. That took thirteen minutes.
--
-- During those thirteen minutes the host sent no heartbeats and performed no resets. The reaper
-- went on measuring, counted three stalled attempts against a device that had never been offered
-- one, and escalated it.
--
-- ---------------------------------------------------------------- why this is the right place
--
-- Migration 032's budget answers "will this reset EVER succeed" — it exists so a device that cannot
-- be cleaned stops being retried forever. That question is only meaningful if somebody was asked.
-- A reset outstanding while the host is silent is not evidence about the device; it is evidence
-- about the host, and the farm already has a mechanism for that: the reaper quarantines a host with
-- no heartbeat for 90s and its devices with it (migration 016).
--
-- SO THE TWO MECHANISMS WERE BOTH FIRING ON ONE OUTAGE, AND ONLY ONE OF THEM HEALS. A silence
-- quarantine is cleared by the next heartbeat — the evidence for it is falsifiable, which is the
-- whole point of migration 016. A reset escalation is not: it is deliberately terminal and waits
-- for a human (`clear_reset_escalation`). Letting a host outage produce the non-self-healing one
-- means every agent restart permanently costs a device until somebody notices.
--
-- ---------------------------------------------------------------- the predicate
--
-- The host must have beaten within the SAME window the reset is being judged over. Not "recently"
-- on some new constant: if a reset is allowed `p_timeout` to complete, then a host which beat at
-- any point in that window was present to be offered it and had the chance to act. One that beat at
-- no point in it was not.
--
-- A host with no heartbeat at all — a row written by registration and never beaten since — fails
-- this too, and should: it has never been in a position to reset anything.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not make the budget forgiving. A host that is beating
-- and failing to reset burns its budget exactly as before, which is the case the budget was written
-- for. This only removes the case where nobody was listening.

DROP FUNCTION IF EXISTS count_stalled_resets(interval, integer);

CREATE FUNCTION count_stalled_resets(p_timeout interval, p_max integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_escalated integer;
BEGIN
  IF p_max < 1 THEN
    RAISE EXCEPTION 'count_stalled_resets: p_max must be at least 1, got %', p_max;
  END IF;

  WITH stalled AS (
    SELECT d.id, d.fence, d.reset_attempts + 1 AS next_attempt
      FROM devices d
      -- INNER JOIN, so a device whose host row is gone is not counted either. It cannot be reset by
      -- anybody, and the thing to fix there is the orphan, not the budget.
      JOIN hosts h ON h.id = d.host_id
     WHERE d.state = 'CLEANING'
       AND d.reset_escalated_at IS NULL
       AND COALESCE(d.last_reset_attempt_at, d.updated_at) < now() - p_timeout
       -- 038: somebody has to have been there to attempt it. See the header.
       AND h.last_heartbeat_at IS NOT NULL
       AND h.last_heartbeat_at >= now() - p_timeout
     ORDER BY COALESCE(d.last_reset_attempt_at, d.updated_at)
     LIMIT 100
     FOR UPDATE OF d SKIP LOCKED
  ), counted AS (
    UPDATE devices d
       SET reset_attempts        = s.next_attempt,
           last_reset_attempt_at = now(),
           reset_escalated_at    = CASE WHEN s.next_attempt >= p_max THEN now() END,
           reset_escalation_reason = CASE WHEN s.next_attempt >= p_max
             THEN 'reset did not complete after ' || p_max || ' attempts' END,
           updated_at = now()
      FROM stalled s
     WHERE d.id = s.id
    RETURNING d.id, d.fence, d.reset_attempts, d.reset_escalated_at
  ), ins AS (
    INSERT INTO device_reset_attempts (device_id, attempt, fence, outcome, detail)
    SELECT c.id, c.reset_attempts, c.fence,
           CASE WHEN c.reset_escalated_at IS NULL THEN 'timed-out' ELSE 'escalated' END,
           CASE WHEN c.reset_escalated_at IS NULL
                THEN 'reset still outstanding after ' || p_timeout
                ELSE 'budget exhausted; no further resets will be offered' END
      FROM counted c
    RETURNING 1
  )
  SELECT count(*) INTO v_escalated FROM counted WHERE reset_escalated_at IS NOT NULL;

  RETURN v_escalated;
END $$;

-- ---------------------------------------------------------------- the privileges come back too
--
-- DROP + CREATE RESETS OWNERSHIP AND GRANTS, and both matter here. A SECURITY DEFINER function
-- executes as its OWNER, so one recreated by the migration runner is owned by `mfarm` — a superuser
-- — and every caller of it would run as a superuser with RLS off. And Postgres grants EXECUTE to
-- PUBLIC on every new function, which is the second half: `mfarm_app` could call a fleet-wide write
-- it must never reach.
--
-- Migration 012 created `mfarm_definer` (NOLOGIN, NOSUPERUSER, BYPASSRLS) precisely so the privilege
-- these functions carry is the smallest one that works. 032 set both for this function; recreating
-- it here silently undid them, and `definer-acl.test.ts` is what said so — both halves, by name.
ALTER FUNCTION count_stalled_resets(interval, integer) OWNER TO mfarm_definer;
REVOKE EXECUTE ON FUNCTION count_stalled_resets(interval, integer) FROM PUBLIC, mfarm_app;

COMMENT ON FUNCTION count_stalled_resets(interval, integer) IS
  'Counts a stalled reset attempt against every CLEANING device past p_timeout WHOSE HOST HAS '
  'BEATEN inside that same window, escalating any that exhaust p_max. A device whose host was '
  'silent for the whole window was never offered the reset, so it is not evidence about the '
  'device — a silent host is handled by the silence quarantine (016), which a heartbeat undoes.';
