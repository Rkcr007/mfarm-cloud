-- 032: a reset that will not succeed stops being retried, and says so.
--
-- WHAT WAS WRONG. A device goes to CLEANING when its session ends and only leaves when a worker
-- confirms the restore. The heartbeat re-offers every CLEANING device on every beat, which is what
-- makes a missed or failed reset self-healing — and it is also an UNBOUNDED RETRY LOOP. When the
-- agent's reset throws it logs and reports nothing, so the device stays CLEANING and is offered
-- again ten seconds later, forever. A device that can never reset silently leaves the pool and the
-- farm keeps trying until somebody notices the capacity is gone.
--
-- `AutomationExecutionPlan.md` §11 is explicit that every recovery mechanism needs a retry count, a
-- timeout, a backoff and a terminal state. This one had none of the four.
--
-- ---------------------------------------------------------------- an attempt is not a heartbeat
--
-- THE COUNTER IS NOT INCREMENTED BY THE OFFER. That distinction is the whole design, and getting it
-- wrong would make the budget a function of how often the host beats: six beats a minute would burn
-- a three-attempt budget in thirty seconds, and a slow-but-working reset would escalate while it
-- was still succeeding.
--
-- An attempt is counted when a reset has been outstanding LONGER THAN IT SHOULD TAKE — observed by
-- the reaper on its own clock, from `updated_at`, which is the same signal
-- `mfarm_device_cleaning_age_seconds_max` and the `MfarmDeviceResetStuck` alert already use. The
-- heartbeat carries on offering while budget remains, so the self-healing that made re-offering
-- worth having is unchanged.
--
-- ---------------------------------------------------------------- escalated is not quarantined
--
-- Exhausting the budget does NOT set `state = 'QUARANTINED'`, and it does not add a device_state
-- value either. Two reasons, and the second is the important one:
--
--   * `device_state` is a Postgres enum from 001, so a new value cannot be added and used in the
--     same transaction (invariant 6, the trap 019 wrote down and 022 paid for);
--   * more to the point, CLEANING ALREADY MEANS "not allocatable", which is exactly what an
--     escalated device must remain. It is dirty, it may still hold the last tenant's data, and the
--     one thing that must never happen is handing it to somebody. Quarantining would ALSO stop the
--     heartbeat offering it a reset, which is the only thing that could ever fix it — so a
--     quarantine here would be a state a device could never leave.
--
-- So escalation is a CONDITION on the device rather than a state: it stays CLEANING, stops being
-- offered, and carries why and when. Clearing it is a deliberate act (`clear_reset_escalation`),
-- which is what "requires a new lifecycle action to resume recovery" means here.

BEGIN;

-- ---------------------------------------------------------------- the budget, on the device

ALTER TABLE devices ADD COLUMN reset_attempts integer NOT NULL DEFAULT 0
  CHECK (reset_attempts >= 0);
-- When the last attempt was counted. The reaper measures from HERE rather than from `updated_at`
-- once an attempt exists, so a second attempt cannot be counted on the very next tick: the timeout
-- has to elapse again. That is the backoff §11 asks for, expressed as the thing it actually means.
ALTER TABLE devices ADD COLUMN last_reset_attempt_at timestamptz;
ALTER TABLE devices ADD COLUMN reset_escalated_at timestamptz;
ALTER TABLE devices ADD COLUMN reset_escalation_reason text;

COMMENT ON COLUMN devices.reset_attempts IS
  'Resets counted against this device''s budget since it last completed one. Incremented by the '
  'reaper when a reset stays outstanding too long, NEVER by a heartbeat offer.';
COMMENT ON COLUMN devices.reset_escalated_at IS
  'Set when the reset budget is exhausted. The device stays CLEANING — unallocatable — and stops '
  'being offered resets until a human clears it. Deliberately not QUARANTINED: that state would '
  'also stop the offers that are the only thing which could fix it.';

-- The reaper's predicate and the console's "what needs a human" query.
CREATE INDEX devices_reset_escalated_idx ON devices(reset_escalated_at)
  WHERE reset_escalated_at IS NOT NULL;

-- ---------------------------------------------------------------- every attempt, with its time

CREATE TABLE device_reset_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- Which attempt this was in the budget, so a reader does not have to count rows to find out.
  attempt      integer NOT NULL,
  -- The allocation this reset belonged to. A device reallocated mid-recovery is a different story
  -- and the fence is what tells them apart.
  fence        bigint,
  outcome      text NOT NULL CHECK (outcome IN ('timed-out', 'succeeded', 'escalated')),
  detail       text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

-- "What happened to this device, most recently first" — the console panel and the device-health
-- question in `AutomationExecutionPlan.md` §2 ("how often does a particular device fail").
CREATE INDEX device_reset_attempts_device_idx ON device_reset_attempts(device_id, occurred_at DESC);

COMMENT ON TABLE device_reset_attempts IS
  'One row per counted reset attempt, with its outcome and time. Fleet-level: devices are not '
  'tenant-owned (a shared device has no org), so this carries no org_id and no RLS policy — it is '
  'reachable only through the system pool, like the fleet queries in metrics.ts.';

-- No RLS, and that is deliberate rather than an omission: this table is about HARDWARE, not about a
-- tenant. A shared-pool device belongs to no org (001), so there is no org_id to scope by and no
-- tenant who should see another's device history. `mfarm_app` gets nothing at all; the reaper and
-- the fleet endpoints run on the system pool.
REVOKE ALL ON device_reset_attempts FROM mfarm_app;

-- ---------------------------------------------------------------- counting an attempt
--
-- Returns the number of devices escalated by this call, so the reaper can log the transition rather
-- than a running total nobody can act on.
CREATE FUNCTION count_stalled_resets(p_timeout interval, p_max integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_escalated integer;
BEGIN
  IF p_max < 1 THEN
    RAISE EXCEPTION 'count_stalled_resets: p_max must be at least 1, got %', p_max;
  END IF;

  -- One statement. `counted` is referenced twice — once to write the attempt rows and once to
  -- count the escalations — and a data-modifying CTE runs to completion whether or not the primary
  -- query reads it, so `ins` fires even though nothing selects from it. The first version of this
  -- counted escalations by re-reading the table for rows newer than a second, which is a clock
  -- comparison standing in for a fact this statement already has.
  WITH stalled AS (
    SELECT d.id, d.fence, d.reset_attempts + 1 AS next_attempt
      FROM devices d
     WHERE d.state = 'CLEANING'
       AND d.reset_escalated_at IS NULL
       -- Measured from the LAST ATTEMPT once there is one, and from the moment it entered CLEANING
       -- before that. Using `updated_at` throughout would count an attempt on every tick after the
       -- first timeout, since nothing about the row changes while it sits there.
       AND COALESCE(d.last_reset_attempt_at, d.updated_at) < now() - p_timeout
     -- Bounded, like every other fleet-wide write in the reaper: a farm that lost a rack should not
     -- turn one tick into an unbounded transaction.
     ORDER BY COALESCE(d.last_reset_attempt_at, d.updated_at)
     LIMIT 100
     FOR UPDATE OF d SKIP LOCKED
  ), counted AS (
    UPDATE devices d
       SET reset_attempts        = s.next_attempt,
           last_reset_attempt_at = now(),
           -- Escalate in the SAME statement that exhausts the budget. A second pass would leave a
           -- window where the device is over budget and still offerable, which on a ten-second beat
           -- is exactly long enough to happen.
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

-- ---------------------------------------------------------------- a reset that WORKS clears it
--
-- Signature is unchanged, so every caller is untouched. Dropped and recreated rather than replaced
-- only because the body changes; the arguments are identical.
CREATE OR REPLACE FUNCTION device_reset_complete(p_host uuid, p_device uuid, p_fence bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_attempt integer;
BEGIN
  UPDATE devices
     SET state = 'READY', last_reset_at = now(), updated_at = now(),
         -- THE BUDGET IS PER RECOVERY, NOT PER LIFETIME. A device that failed twice and then
         -- succeeded starts its next session with a full budget; carrying the count forward would
         -- retire a healthy device after three bad days spread over a month.
         reset_attempts = 0,
         last_reset_attempt_at = NULL,
         reset_escalated_at = NULL,
         reset_escalation_reason = NULL
   WHERE id = p_device
     AND host_id = p_host
     AND fence = p_fence
     AND state = 'CLEANING'
  RETURNING reset_attempts INTO v_attempt;

  IF NOT FOUND THEN RETURN false; END IF;

  -- Recorded only when attempts were actually counted, so the table stays a record of TROUBLE
  -- rather than a row per reset on a healthy farm — which at four devices and a session a minute
  -- would bury the interesting rows within a day.
  INSERT INTO device_reset_attempts (device_id, attempt, fence, outcome, detail)
  SELECT p_device, 0, p_fence, 'succeeded', 'reset completed after a stalled attempt'
   WHERE EXISTS (SELECT 1 FROM device_reset_attempts a
                  WHERE a.device_id = p_device AND a.outcome IN ('timed-out', 'escalated')
                    AND a.occurred_at > now() - interval '1 hour');
  RETURN true;
END $$;

-- ---------------------------------------------------------------- the way back
--
-- The deliberate act that resumes recovery. Returns false when there was nothing to clear, so an
-- operator who clicks twice is told rather than reassured.
CREATE FUNCTION clear_reset_escalation(p_device uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE devices
     SET reset_attempts = 0,
         last_reset_attempt_at = NULL,
         reset_escalated_at = NULL,
         reset_escalation_reason = NULL,
         updated_at = now()
   WHERE id = p_device AND reset_escalated_at IS NOT NULL;
  RETURN FOUND;
END $$;

-- Fleet-wide mutations on the system pool: 008's split, 012's ownership, and the REVOKE that
-- matters because Postgres grants EXECUTE to PUBLIC by default (invariant 4).
ALTER FUNCTION count_stalled_resets(interval, integer) OWNER TO mfarm_definer;
ALTER FUNCTION clear_reset_escalation(uuid)            OWNER TO mfarm_definer;
REVOKE EXECUTE ON FUNCTION count_stalled_resets(interval, integer) FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION clear_reset_escalation(uuid)            FROM PUBLIC, mfarm_app;
GRANT SELECT, INSERT ON device_reset_attempts TO mfarm_definer;

COMMIT;
