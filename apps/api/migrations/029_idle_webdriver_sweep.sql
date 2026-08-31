-- 029: a client that stopped driving gets its device taken back.
--
-- WHAT WAS WRONG. A WebDriver suite that is killed — `kill -9` on the runner, a cancelled CI job, a
-- laptop that slept — sends no `deleteSession`. WebDriver is stateless HTTP, so there is no
-- connection whose loss the farm could notice: a crashed suite and a suite that is merely slow
-- between two commands look identical from here. The only backstop was the 30-minute lease TTL, so
-- one crash-looping CI job took a device out of a four-device farm for half an hour per run.
--
-- Reproduced on real hardware 2026-09-01 by `deploy/verify-failure.mjs --only=abandon`: open a
-- session, abandon it, and the device is still held 90 seconds later with nothing on its way to
-- reclaim it.
--
-- THE SIGNAL ALREADY EXISTED, WHICH IS THE UNCOMFORTABLE PART. `webdriver_sessions.last_command_at`
-- is updated on EVERY proxied command, and migration 006 built an index over it whose comment says
-- exactly what it was for:
--
--     -- Supports finding sessions a client has stopped driving without deleting.
--     CREATE INDEX webdriver_sessions_idle_idx ON webdriver_sessions(last_command_at);
--
-- The column was written on every command and the index maintained on every command, for a query
-- that was never written. That is the inverse of invariant 5 in docs/INDEX.md — not a column
-- nothing writes, but a column nothing READS, which costs the same and is harder to notice because
-- the data looks alive.
--
-- ---------------------------------------------------------------- why the threshold is not small
--
-- The sweep must not end a session that is merely mid-command. `last_command_at` marks the START of
-- the last proxied command, so a slow one — an install, a long `waitUntil`, a screenshot on a
-- loaded host — leaves it stale while the session is perfectly alive. The threshold therefore has
-- to exceed the longest plausible SINGLE command, not the gap between commands.
--
-- It should also sit above the client's own idle timer, because that is the layer meant to fire
-- first: `examples/medishop-suite` sets `appium:newCommandTimeout: 300`, and a suite whose driver
-- has already given up is a case the farm can afford to observe a little later. Ten minutes is
-- comfortably past both, and still a third of the lease TTL — so the mechanism this migration adds
-- does the reclaiming in the ordinary case and the TTL stays as the backstop it was always meant
-- to be, rather than the only thing there is.
--
-- ---------------------------------------------------------------- what it deliberately does NOT do
--
-- **It does not touch a session with no `webdriver_sessions` row.** `mfarm run --no-webdriver`
-- allocates a device for something that speaks the raw data plane, which produces no WebDriver
-- commands at all — every such session would look permanently idle and be swept instantly. The
-- lifecycle of those belongs to the CLI, which releases on every exit path (ADR-0002 decision 4).
--
-- **It does not send the device to READY.** Same rule as `release_device`: a device only becomes
-- allocatable when a worker confirms the reset. Skipping CLEANING here would hand the next tenant a
-- device still carrying the last one's data — and this path exists precisely for sessions that
-- ended badly, which are the ones most likely to have left something behind.

BEGIN;

CREATE OR REPLACE FUNCTION expire_idle_webdriver_sessions(p_idle interval)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  -- `idle` ends the sessions; `cleaned` sends their devices to CLEANING. Counting comes from `idle`
  -- rather than from the device update, because the two are not the same number — a session can be
  -- ALLOCATING with a device or have lost it — and migration 007 exists because `expire_sessions`
  -- returned the device count while its caller logged it as a session count.
  WITH idle AS (
    UPDATE sessions s
       SET state = 'ENDED', ended_at = now(), end_reason = 'idle_timeout'
      FROM webdriver_sessions w
     WHERE w.session_id = s.id
       AND s.state IN ('ALLOCATING','ACTIVE')
       AND w.last_command_at < now() - p_idle
    RETURNING s.id, s.device_id
  ), cleaned AS (
    UPDATE devices d
       SET state = 'CLEANING', updated_at = now()
      FROM idle i
     WHERE d.id = i.device_id
    RETURNING d.id
  )
  SELECT count(*) INTO v_count FROM idle;
  RETURN v_count;
END $$;

-- `idle_timeout`, not `timeout`. The lease expiring and the client vanishing are different events
-- with different fixes — one means the suite needed longer, the other means it died — and a support
-- question that cannot tell them apart is answered with a guess.
COMMENT ON FUNCTION expire_idle_webdriver_sessions(interval) IS
  'Ends WebDriver sessions whose client has stopped issuing commands, and sends their devices to '
  'CLEANING. end_reason is idle_timeout, distinct from the lease TTL''s timeout.';

-- ---------------------------------------------------------------- the one new grant
--
-- Migration 012 left `webdriver_sessions` out of `mfarm_definer` on purpose, and said why: "no
-- definer function reads or writes them, and a grant 'just in case' is how a narrow role stops
-- being narrow." That is no longer true — this function reads `last_command_at` — so the grant is
-- added, and it is SELECT ALONE. Nothing here writes to the table; the session rows it updates are
-- in `sessions`, which 012 already covers.
GRANT SELECT ON webdriver_sessions TO mfarm_definer;

-- Fleet-wide mutation on the system pool, so it follows 008's split and 012's ownership rule:
-- owned by mfarm_definer, unreachable from the app pool. Postgres grants EXECUTE to PUBLIC by
-- default and says nothing about it, which is what the REVOKE is for (invariant 4).
ALTER FUNCTION expire_idle_webdriver_sessions(interval) OWNER TO mfarm_definer;
REVOKE EXECUTE ON FUNCTION expire_idle_webdriver_sessions(interval) FROM PUBLIC, mfarm_app;

COMMIT;
