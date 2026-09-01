-- 033: one logical user request is ONE user attempt, however many times the farm had to try.
--
-- WHAT IS WRONG TODAY. A user asks for a device once. If the emulator goes unhealthy, adb drops, or
-- the handset falls off the end of its cable, the farm recovers and carries on — and nothing
-- anywhere records that it happened to THIS request. So three questions have no answer:
--
--   * how many times did a user actually ask for something?
--   * how many times did MFARM have to try again to serve one of those asks?
--   * which device made it have to?
--
-- `AutomationExecutionPlan.md` §33 and §35 name the shape: `Execution -> ExecutionAttempt ->
-- Device`, "because an execution may require an infrastructure retry without becoming a new
-- user-visible test run". This is that, with `sessions` as the execution — a session IS one user's
-- logical request for a device, which is why the attempt hangs off it rather than off a new table
-- that would duplicate what `sessions` already is.
--
-- ---------------------------------------------------------------- the invariant is an INDEX
--
-- "One logical user request = one user attempt" is the whole point, so it is stated where it cannot
-- be got wrong: a partial unique index on `origin = 'user'`. A second user attempt on one session is
-- not a bug that shows up in a report later, it is a constraint violation at the moment somebody
-- writes the code that would have caused it.
--
-- Every retry the FARM performs is `origin = 'infra-retry'` and is invisible to that index, which is
-- exactly the accounting rule: the farm absorbs its own recovery.
--
-- ---------------------------------------------------------------- what this does NOT touch
--
-- **`metering_events` is unchanged, and so is `usage()`.** The tenant is still metered in
-- `device_seconds` for the time it held a device, which is the right unit and is not what this
-- table is about — nothing here is a price, a credit or a charge. Migration 006's decision that
-- usage is append-only and worker-reported stands untouched; do not read this table as billing.
--
-- **It never reclassifies a test.** A failed assertion is `test_results`, the suite's own word
-- (021, 024). An attempt outcome here is the FARM's word about its own infrastructure, and §13's
-- rule is that the two must never be confused. There is deliberately no 'test-failure' outcome
-- below: this table cannot see one, so it may not claim one.

BEGIN;

CREATE TABLE session_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Derived from the session at insert time, never accepted from a caller — architecture rule 4,
  -- the same reasoning that stops a worker naming the org it bills.
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Which attempt this was within the session, so a reader does not count rows to find out.
  attempt     integer NOT NULL CHECK (attempt >= 1),
  origin      text NOT NULL CHECK (origin IN ('user', 'infra-retry')),
  -- NULLABLE and ON DELETE SET NULL: an attempt outlives the device row it names, and a queued
  -- session has no device yet. Losing the attribution is better than losing the attempt.
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  /**
   * NULL means STILL RUNNING, which is a real state and not missing data.
   *
   * No 'test-failure' member, deliberately — see the header. The farm reports only what the farm
   * can see, and 'device-failure' vs 'infrastructure-failure' is 024's split: the device itself
   * went bad, or something around it did.
   */
  outcome     text CHECK (outcome IN ('succeeded', 'device-failure', 'infrastructure-failure', 'abandoned')),
  -- 024's vocabulary where there is one, so "how often does usb-failure cost us a retry" is one
  -- query across both tables rather than two vocabularies to reconcile.
  reason      text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);

-- THE INVARIANT. One user attempt per session, enforced rather than intended.
CREATE UNIQUE INDEX session_attempts_one_user_idx
  ON session_attempts(session_id) WHERE origin = 'user';

CREATE UNIQUE INDEX session_attempts_seq_idx ON session_attempts(session_id, attempt);

-- "Which device caused the retries, and how often does this one fail" — §2's device-health question.
CREATE INDEX session_attempts_device_idx ON session_attempts(device_id, started_at DESC)
  WHERE device_id IS NOT NULL;

-- The rollup read: attempts for an org over a window.
CREATE INDEX session_attempts_org_idx ON session_attempts(org_id, started_at DESC);

COMMENT ON TABLE session_attempts IS
  'One row per attempt at serving a session. Exactly one carries origin=''user'' (enforced by a '
  'partial unique index); every retry MFARM performs to recover its own infrastructure is '
  '''infra-retry'' and never becomes a second user attempt. Not billing: usage stays in '
  'metering_events.';

COMMENT ON COLUMN session_attempts.outcome IS
  'NULL while the attempt is running. Never ''test-failure'': the farm cannot see an assertion '
  'fail, and saying so would be the confusion spec §13 forbids.';

ALTER TABLE session_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_attempts FORCE  ROW LEVEL SECURITY;

-- SELECT only for the tenant pool, following 018/023/024: every writer below is the worker or
-- control-plane path on the system pool, where `current_org()` does not exist.
CREATE POLICY session_attempts_own_org ON session_attempts
  FOR SELECT USING (org_id = current_org());

GRANT SELECT ON session_attempts TO mfarm_app;

-- ---------------------------------------------------------------- opening an attempt
--
-- Returns the attempt number, or NULL when the session does not exist. The org and the device are
-- read from the session row rather than taken as arguments, so a caller cannot file an attempt
-- against the wrong tenant by passing a stale id.
CREATE FUNCTION open_session_attempt(p_session uuid, p_origin text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_attempt integer;
BEGIN
  IF p_origin NOT IN ('user', 'infra-retry') THEN
    RAISE EXCEPTION 'open_session_attempt: origin must be user or infra-retry, got %', p_origin;
  END IF;

  INSERT INTO session_attempts (org_id, session_id, attempt, origin, device_id)
  SELECT s.org_id, s.id,
         -- Next in sequence for THIS session. `coalesce(max)+1` under the unique index above: two
         -- concurrent retries race, one wins, and the loser's error is the right outcome — it means
         -- something tried to open two attempts for one failure.
         (SELECT coalesce(max(a.attempt), 0) + 1 FROM session_attempts a WHERE a.session_id = s.id),
         p_origin, s.device_id
    FROM sessions s
   WHERE s.id = p_session
  RETURNING attempt INTO v_attempt;

  RETURN v_attempt;
END $$;

-- ---------------------------------------------------------------- closing one
--
-- Closes the session's OPEN attempt (the one with no outcome). Returns false when there was none,
-- which is the ordinary answer for a session that never opened one — a pre-033 session, or one that
-- queued and was abandoned before it held a device.
CREATE FUNCTION close_session_attempt(p_session uuid, p_outcome text, p_reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE session_attempts a
     SET outcome = p_outcome, reason = p_reason, ended_at = now()
   WHERE a.session_id = p_session
     AND a.outcome IS NULL
     -- The newest open one. There should never be two, and if there are, closing the one the caller
     -- means is better than closing an arbitrary row.
     AND a.attempt = (SELECT max(b.attempt) FROM session_attempts b
                       WHERE b.session_id = p_session AND b.outcome IS NULL);
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------- the farm absorbs one failure
--
-- THE WHOLE ACCOUNTING RULE, in one function: close the attempt that just failed, and open the next
-- one as `infra-retry`. The session is untouched, so the user's request is still the same request —
-- and because the new row is not `origin = 'user'`, the partial unique index above guarantees the
-- user's attempt count did not move.
--
-- Returns the new attempt number, or NULL when the session had no open attempt to fail.
CREATE FUNCTION record_infra_retry(p_session uuid, p_outcome text, p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_attempt integer;
BEGIN
  IF p_outcome NOT IN ('device-failure', 'infrastructure-failure') THEN
    -- A retry is only ever justified by the farm's own failure. Refusing anything else here is what
    -- stops a future caller quietly retrying a test failure, which §34 forbids and which would
    -- manufacture false green results.
    RAISE EXCEPTION 'record_infra_retry: % is not an infrastructure failure', p_outcome;
  END IF;

  IF NOT close_session_attempt(p_session, p_outcome, p_reason) THEN
    RETURN NULL;
  END IF;
  SELECT open_session_attempt(p_session, 'infra-retry') INTO v_attempt;
  RETURN v_attempt;
END $$;

-- ---------------------------------------------------------------- closing what the session closed
--
-- A SWEEP RATHER THAN A CALL ON EVERY END PATH, and that is the design decision here.
--
-- A session ends in at least four places: the tenant's own DELETE, `expire_sessions()` on the TTL,
-- the idle-WebDriver reclaim from 029, and `quarantine_host` taking a device back. Adding a close
-- to each is four places to keep in step and a fifth that will be added later without one — and the
-- symptom would be an attempt that stays open forever, which reads as "the farm is still trying"
-- when it is not.
--
-- So the reaper closes any attempt whose SESSION has ended, whatever ended it. One indexed
-- statement, self-healing, and it cannot be forgotten by a future end path because it does not know
-- about end paths at all.
--
-- THE OUTCOME IS NOT A CLAIM ABOUT THE TEST. 'succeeded' here means the farm served the request —
-- it held a device for the session until the session finished. Whether the tests passed is the
-- suite's word, in `test_results`, and this table has no business repeating or contradicting it.
CREATE FUNCTION close_ended_session_attempts(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_closed integer;
BEGIN
  WITH due AS (
    SELECT a.id,
           /**
            * Only reasons that are the FARM's own fault become a failure.
            *
            * `timeout` and `idle_timeout` are not: the farm delivered a device and the lease ran
            * out, which is the product working. Calling those infrastructure failures would make
            * every well-behaved CI run look like a farm incident, and the device-health numbers
            * built on this column would be noise within a day.
            */
           CASE WHEN s.end_reason IN ('no_endpoint', 'session_not_created')
                THEN 'infrastructure-failure' ELSE 'succeeded' END AS outcome,
           s.end_reason, s.ended_at
      FROM session_attempts a
      JOIN sessions s ON s.id = a.session_id
     WHERE a.outcome IS NULL
       AND s.state IN ('ENDED', 'FAILED')
     ORDER BY s.ended_at NULLS LAST
     LIMIT p_limit
     FOR UPDATE OF a SKIP LOCKED
  ), closed AS (
    UPDATE session_attempts a
       SET outcome = d.outcome, reason = d.end_reason,
           -- The session's own end time, not now(). The reaper runs on a tick, so `now()` would
           -- date every attempt to whenever the sweep happened to notice.
           ended_at = COALESCE(d.ended_at, now())
      FROM due d WHERE a.id = d.id
    RETURNING 1
  )
  SELECT count(*) INTO v_closed FROM closed;
  RETURN v_closed;
END $$;

-- Fleet/control-plane writes on the system pool, per 008 and 012, with the REVOKE that matters
-- because Postgres grants EXECUTE to PUBLIC by default (invariant 4).
ALTER FUNCTION open_session_attempt(uuid, text)          OWNER TO mfarm_definer;
ALTER FUNCTION close_session_attempt(uuid, text, text)   OWNER TO mfarm_definer;
ALTER FUNCTION record_infra_retry(uuid, text, text)      OWNER TO mfarm_definer;
ALTER FUNCTION close_ended_session_attempts(integer)     OWNER TO mfarm_definer;
REVOKE EXECUTE ON FUNCTION open_session_attempt(uuid, text)        FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION close_session_attempt(uuid, text, text) FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION record_infra_retry(uuid, text, text)    FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION close_ended_session_attempts(integer)   FROM PUBLIC, mfarm_app;
GRANT SELECT, INSERT, UPDATE ON session_attempts TO mfarm_definer;

COMMIT;
