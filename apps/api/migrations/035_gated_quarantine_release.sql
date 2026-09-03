-- 035: releasing a quarantine authorises a recovery ATTEMPT. It does not mark a device available.
--
-- WHAT WAS MISSING. `QUARANTINED` has been a device state since migration 001 and, at the device
-- level, it has only ever been something that HAPPENS TO a device: `quarantine_host` collapses a
-- silent host's fleet into it (003, 016), and the only ways out are the host beating again
-- (`clear_silence_quarantine`) or a worker re-registering. There was no way to quarantine ONE
-- handset, nothing recorded WHY a device was quarantined — `quarantine_reason` existed on `hosts`
-- and never on `devices` — and no operator action of any kind.
--
-- So `AutomationExecutionPlan.md` §30's "[Recover Device]" had nowhere to land, and the obvious
-- implementation of it is the one this migration exists to refuse:
--
--     UPDATE devices SET state = 'READY' WHERE id = $1;
--
-- That is a button that puts a broken handset back into the allocation pool on an operator's
-- optimism. The device failed its health checks; a human deciding to look at it is not evidence
-- that anything about it has changed.
--
-- ---------------------------------------------------------------- release is not "make available"
--
-- The lifecycle this builds:
--
--     QUARANTINED --(operator releases)--> PREPARING --(reset + health check)--> READY
--                        ^                                    |
--                        +-------------(either fails)---------+
--
-- Release means "I am authorising this device to ATTEMPT recovery". Only a completed reset AND a
-- passing health check, reported by the host that owns the device, earns `READY`. Anything else —
-- a reset that throws, a health probe that says the handset is still offline, a host that never
-- answers within the window — returns it to `QUARANTINED` carrying the NEW failure, not the old one.
--
-- PREPARING rather than a condition on QUARANTINED, and this is where this migration parts company
-- with 032. Escalation stayed a condition because `CLEANING` already meant everything the escalated
-- device needed to mean. Here it does not: `QUARANTINED` stops the heartbeat offering a reset, and
-- the offer is the entire preparation flow. A device recovering has to be in a state that IS
-- offered resets and is NOT allocatable, and no existing value is both.
--
-- ---------------------------------------------------------------- the preparation flow is reused
--
-- Nothing here drives a device. The recovery runs down the path that already exists and is already
-- the farm's only tested way to make a device fit for a tenant: the heartbeat offers a reset to the
-- host that owns the device, the agent restores it, and the host reports back. The one thing added
-- is that a reset offered to a PREPARING device is flagged as a recovery, and a recovery is
-- confirmed with a HEALTH RESULT rather than with the bare "done" an ordinary post-session reset
-- reports. A parallel recovery pipeline would be a second, untested way to prepare a device, which
-- is how the two would drift.
--
-- ---------------------------------------------------------------- and every transition is written
--
-- `device_quarantine_log` is append-only and answers, for any device: who released it, when, what
-- it had been quarantined for, what the preparation and health check reported, and where it ended
-- up. The actor's email is COPIED into the row rather than joined at read time — an audit record
-- that says "user 3f2a…, since deleted" has lost the fact it existed to keep.

BEGIN;

-- ---------------------------------------------------------------- why a device is quarantined
--
-- `hosts` has carried these three since 003/016 and `devices` never has, which is why a quarantined
-- handset in the console could only ever be described as "Quarantined" with no cause. The source
-- column is the same split 016 made for hosts and for the same reason: the exit condition differs.
--
--   host      cascaded from `quarantine_host`; `clear_silence_quarantine` lifts it when the host
--             beats again, because the beat is the disproof of the claim that put it away.
--   operator  a human took this device out of service. No packet refutes a judgement.
--   health    the device failed a health check, or failed a recovery it was released for.
--
-- Only `host` is self-clearing. `operator` and `health` require the deliberate release below, and
-- the registration and withdrawal paths in `routes/workers.ts` are taught to leave them alone —
-- without that, plugging a quarantined handset back in would silently return it to the pool.
ALTER TABLE devices ADD COLUMN quarantined_at    timestamptz;
ALTER TABLE devices ADD COLUMN quarantine_reason text;
ALTER TABLE devices ADD COLUMN quarantine_source text
  CHECK (quarantine_source IS NULL OR quarantine_source IN ('host', 'operator', 'health'));

COMMENT ON COLUMN devices.quarantine_source IS
  'host = cascaded from quarantine_host and cleared when the host beats again; operator = a human '
  'took it out of service; health = it failed a health check or a recovery. Only host is '
  'self-clearing — the other two need release_device_quarantine. NULL when not quarantined.';

-- ---------------------------------------------------------------- the recovery in flight
--
-- On the row rather than joined out of the log, following 032's `reset_escalated_at`: this is the
-- answer to "why is this device not being handed out", and the screen that asks it should not have
-- to know about an audit table to get one.
ALTER TABLE devices ADD COLUMN recovery_started_at  timestamptz;
ALTER TABLE devices ADD COLUMN recovery_released_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN recovery_from_reason text;

COMMENT ON COLUMN devices.recovery_started_at IS
  'When an operator authorised this device to attempt recovery. Set on release, cleared when the '
  'recovery finishes either way. It is also the clock expire_stalled_recoveries measures against, '
  'so a host that never answers cannot leave a device in PREPARING for ever.';

-- The reaper's predicate and the console's "what is mid-recovery" query.
CREATE INDEX devices_recovering_idx ON devices(recovery_started_at)
  WHERE recovery_started_at IS NOT NULL;

-- ---------------------------------------------------------------- the audit
--
-- One row per transition rather than one row per recovery with columns filled in as it progresses.
-- A quarantine that is never released still has to be a record, and a device that fails three
-- recoveries is a story rather than a final value — an append-only log says both without a schema
-- that has to know in advance which shape it is looking at.
CREATE TABLE device_quarantine_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- APPEND ORDER, because `occurred_at` is not one. Two rows written in the same transaction share
  -- a timestamp to the microsecond — `now()` is the transaction's clock, not the statement's — and
  -- `quarantine_host` writes a row per device in one statement, while a quarantine and its release
  -- can land in one call from a test or a script. Ordering by `(occurred_at, id)` then falls back
  -- to a RANDOM uuid, which renders the timeline in a different order on different reads: the
  -- console would show a device released before it was quarantined, intermittently.
  seq         bigserial NOT NULL,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event       text NOT NULL CHECK (event IN
                ('quarantined', 'released', 'recovered', 'recovery-failed')),
  -- host | operator | health, on a `quarantined` row. NULL on the others.
  source      text,
  -- Why it was quarantined, or — on `recovery-failed` — what the recovery reported. The NEW failure
  -- in that case, never a restatement of the old one: preserving the reason a device went away the
  -- first time, and losing the reason it could not come back, is exactly backwards.
  reason      text,
  -- Who released it. NULL on anything the farm did to itself.
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Copied, not joined. An audit row that outlives the account it names still has to say who.
  actor_email text,
  -- On a `released` row: the quarantine reason being recovered FROM, so the whole story reads out
  -- of this table without also needing the device row as it was at the time.
  from_reason text,
  -- What the preparation and the health check actually reported, as the agent said it. jsonb rather
  -- than columns because the shape is the backend's, and a handset reports battery and storage
  -- where a Cuttlefish instance reports neither.
  detail      jsonb,
  fence       bigint,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_quarantine_log_device_idx
  ON device_quarantine_log(device_id, seq DESC);

COMMENT ON TABLE device_quarantine_log IS
  'Append-only record of every device quarantine, release, and recovery outcome. Fleet-level, like '
  'device_reset_attempts (032): devices are not tenant-owned, so there is no org_id to scope by and '
  'no RLS policy — it is reachable only through the system pool.';

-- No RLS, deliberately and for 032's reason: this is about HARDWARE, not about a tenant. A
-- shared-pool device belongs to no org, so there is no org_id and no tenant who should read another
-- tenant's device history. `mfarm_app` gets nothing; the routes that read it run on the system pool
-- after RLS on `devices` has already decided what the caller may see.
REVOKE ALL ON device_quarantine_log FROM mfarm_app;

-- ---------------------------------------------------------------- taking one device out of service
--
-- Returns true when the device actually moved, so a caller that clicks twice is told rather than
-- reassured — the same contract as `clear_reset_escalation`.
--
-- ANY LIVE SESSION ON THE DEVICE ENDS. "Remove it from allocation immediately" is not satisfied by
-- refusing FUTURE allocations while a tenant is still driving a handset that just failed its health
-- checks. `ENDED` with a reason, not `FAILED`: every other end path in this schema writes ENDED and
-- nothing has ever written FAILED, and a device fault is not the session's own doing. The attempt
-- bookkeeping from 033 is closed by the reaper's sweep, which is why nothing here calls it.
--
-- `quarantined_from` IS SET TO NULL, and that is load-bearing. `clear_silence_quarantine` restores
-- devices `WHERE quarantined_from IS NOT NULL`, so leaving a value there would let a host coming
-- back from silence quietly undo a human's judgement about one of its handsets — 016's own rule,
-- applied one level down.
CREATE FUNCTION quarantine_device(
  p_device uuid, p_reason text, p_source text DEFAULT 'operator',
  p_actor uuid DEFAULT NULL, p_detail jsonb DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email text;
BEGIN
  IF p_source NOT IN ('host', 'operator', 'health') THEN
    RAISE EXCEPTION 'quarantine_device: p_source must be host, operator or health, got %', p_source;
  END IF;

  -- EVICTED is the one state this will not touch: it means the device has left the fleet, and
  -- quarantining something that is gone would put a row in the log that reads like a live problem.
  -- An already-QUARANTINED device is left alone too — a second quarantine would overwrite the
  -- reason that is the whole point of the first.
  UPDATE devices
     SET state = 'QUARANTINED',
         quarantined_at = now(), quarantine_reason = p_reason, quarantine_source = p_source,
         quarantined_from = NULL,
         -- A recovery in flight is over. Whatever it was going to prove, it is not proving it now.
         recovery_started_at = NULL, recovery_released_by = NULL, recovery_from_reason = NULL,
         updated_at = now()
   WHERE id = p_device
     AND state NOT IN ('QUARANTINED', 'EVICTED');
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE sessions
     SET state = 'ENDED', ended_at = now(), end_reason = 'device_quarantined'
   WHERE device_id = p_device AND state IN ('QUEUED', 'ALLOCATING', 'ACTIVE');

  SELECT email INTO v_email FROM users WHERE id = p_actor;
  INSERT INTO device_quarantine_log
    (device_id, event, source, reason, actor_id, actor_email, detail, fence)
  SELECT p_device, 'quarantined', p_source, p_reason, p_actor, v_email, p_detail, d.fence
    FROM devices d WHERE d.id = p_device;
  RETURN true;
END $$;

-- ---------------------------------------------------------------- authorising an attempt
--
-- The operator action, and the one this migration is named for. It moves the device to PREPARING —
-- NOT to READY — and returns true only when it actually moved one out of QUARANTINED.
--
-- THE FENCE IS BUMPED. A device quarantined mid-session may have a worker somewhere that still
-- believes it holds the old allocation, and the fence is this schema's existing answer to exactly
-- that: every command and every confirmation carries one, and a stale token is refused. Bumping
-- here means the reset a recovery is about to run cannot be satisfied by a confirmation left over
-- from the allocation that broke the device. The cost is that no session row matches the new fence,
-- so the heartbeat offers this reset without a `sessionId` and the agent skips artifact capture —
-- which is right: a recovery reset is not a session teardown and there is nothing of a tenant's to
-- collect.
--
-- THE RESET BUDGET IS ZEROED, for 032's own reason: the budget is per recovery, not per lifetime.
-- Whatever this device spent failing before it was quarantined is not this attempt's allowance.
CREATE FUNCTION release_device_quarantine(p_device uuid, p_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_from text; v_fence bigint; v_email text;
BEGIN
  UPDATE devices
     SET state = 'PREPARING',
         recovery_started_at = now(), recovery_released_by = p_actor,
         recovery_from_reason = quarantine_reason,
         quarantined_at = NULL, quarantine_reason = NULL, quarantine_source = NULL,
         quarantined_from = NULL,
         reset_attempts = 0, last_reset_attempt_at = NULL,
         reset_escalated_at = NULL, reset_escalation_reason = NULL,
         fence = fence + 1,
         updated_at = now()
   WHERE id = p_device AND state = 'QUARANTINED'
  RETURNING recovery_from_reason, fence INTO v_from, v_fence;

  IF NOT FOUND THEN RETURN false; END IF;

  SELECT email INTO v_email FROM users WHERE id = p_actor;
  INSERT INTO device_quarantine_log
    (device_id, event, actor_id, actor_email, from_reason, fence)
  VALUES (p_device, 'released', p_actor, v_email, v_from, v_fence);
  RETURN true;
END $$;

-- ---------------------------------------------------------------- what the attempt earned
--
-- Called by `POST /v1/workers/events` when a host reports the outcome of a recovery it was asked to
-- perform. Returns the state the device ended in, or NULL when nothing matched.
--
-- HOST-SCOPED AND FENCED, which is migration 008's rule and the reason it is a rule: a function
-- that filtered on device id alone would let any worker in the fleet promote another host's device
-- out of quarantine. The host comes from the authenticated worker credential; the fence comes from
-- the offer the control plane made.
--
-- `p_ok` IS THE HEALTH RESULT, not "the reset call returned". A restore that completes on a handset
-- whose USB has gone is a successful reset of a device nobody can drive, and promoting that to
-- READY is the failure this whole gate exists to prevent.
CREATE FUNCTION finish_device_recovery(
  p_host uuid, p_device uuid, p_fence bigint, p_ok boolean,
  p_reason text DEFAULT NULL, p_detail jsonb DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_from text;
BEGIN
  SELECT recovery_from_reason INTO v_from
    FROM devices
   WHERE id = p_device AND host_id = p_host AND fence = p_fence AND state = 'PREPARING'
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF p_ok THEN
    UPDATE devices
       SET state = 'READY', last_reset_at = now(),
           reset_attempts = 0, last_reset_attempt_at = NULL,
           reset_escalated_at = NULL, reset_escalation_reason = NULL,
           recovery_started_at = NULL, recovery_released_by = NULL, recovery_from_reason = NULL,
           updated_at = now()
     WHERE id = p_device;
    INSERT INTO device_quarantine_log (device_id, event, reason, from_reason, detail, fence)
    VALUES (p_device, 'recovered', p_reason, v_from, p_detail, p_fence);
    RETURN 'READY';
  END IF;

  -- Straight back to QUARANTINED, carrying the NEW reason. Stamped `health` rather than whatever
  -- put it away the first time: this device has now failed a check it was released to pass, and
  -- that is a different fact from the one an operator was looking at when they released it.
  UPDATE devices
     SET state = 'QUARANTINED',
         quarantined_at = now(),
         quarantine_reason = COALESCE(p_reason, 'the recovery health check failed with no detail'),
         quarantine_source = 'health',
         quarantined_from = NULL,
         recovery_started_at = NULL, recovery_released_by = NULL, recovery_from_reason = NULL,
         updated_at = now()
   WHERE id = p_device;
  INSERT INTO device_quarantine_log (device_id, event, source, reason, from_reason, detail, fence)
  VALUES (p_device, 'recovery-failed', 'health',
          COALESCE(p_reason, 'the recovery health check failed with no detail'),
          v_from, p_detail, p_fence);
  RETURN 'QUARANTINED';
END $$;

-- ---------------------------------------------------------------- a recovery nobody finishes
--
-- §11's fourth requirement, and the one a gated workflow is most likely to omit: a terminal state
-- that is reached WITHOUT anybody reporting anything. A host that is asked to recover a device and
-- then goes silent — powered off, unplugged, partitioned — would otherwise leave that device in
-- PREPARING for the life of the database, which is precisely the "state a device could never leave"
-- ADR-0019 refused to build.
--
-- ONE WINDOW, not a counted budget, and the difference from 032 is deliberate. There, an attempt
-- was one offer among many on a device that might yet succeed on its own. Here the whole recovery
-- is a single authorised attempt with a person behind it: the heartbeat re-offers the reset every
-- beat inside the window, so the retries are real, and when the window closes the honest report is
-- "nobody confirmed this", not "attempt 3 of 3 timed out".
--
-- Bounded by LIMIT, like every other fleet-wide write in the reaper.
CREATE FUNCTION expire_stalled_recoveries(p_timeout interval)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  WITH stalled AS (
    SELECT d.id, d.fence, d.recovery_from_reason
      FROM devices d
     WHERE d.state = 'PREPARING'
       AND d.recovery_started_at < now() - p_timeout
     ORDER BY d.recovery_started_at
     LIMIT 100
     FOR UPDATE OF d SKIP LOCKED
  ), expired AS (
    UPDATE devices d
       SET state = 'QUARANTINED',
           quarantined_at = now(),
           quarantine_reason = 'the host did not confirm a recovery within ' || p_timeout,
           quarantine_source = 'health',
           quarantined_from = NULL,
           recovery_started_at = NULL, recovery_released_by = NULL, recovery_from_reason = NULL,
           updated_at = now()
      FROM stalled s
     WHERE d.id = s.id
    RETURNING d.id, s.fence, s.recovery_from_reason
  ), ins AS (
    INSERT INTO device_quarantine_log
      (device_id, event, source, reason, from_reason, fence)
    SELECT e.id, 'recovery-failed', 'health',
           'the host did not confirm a recovery within ' || p_timeout,
           e.recovery_from_reason, e.fence
      FROM expired e
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM expired;
  RETURN v_count;
END $$;

-- ---------------------------------------------------------------- the host cascade, now with a why
--
-- `CREATE OR REPLACE` keeps the owner and the ACL that 016 set, so the REVOKEs at the foot of this
-- file are a re-assertion rather than a repair — cheap, and the one thing invariant 4 says never to
-- assume.
--
-- Two changes, both about the columns added above:
--
--   * the devices it collapses are now stamped with WHY, sourced `host`, so a quarantined handset
--     in the console can say "its host stopped beating" instead of nothing at all;
--   * PREPARING joins the collapse set. A device mid-recovery on a host that has gone silent must
--     leave the pool with the rest of that host's fleet, and `quarantined_from` remembers what it
--     was doing so the recovery resumes rather than being lost.
--
-- A device already carrying an operator or health quarantine is untouched, because the predicate
-- has never included QUARANTINED — the same line that has always made a second host quarantine
-- harmless is what protects a human's judgement here.
CREATE OR REPLACE FUNCTION quarantine_host(p_host uuid, p_reason text, p_source text DEFAULT 'operator')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF p_source NOT IN ('reaper', 'operator') THEN
    RAISE EXCEPTION 'quarantine_host: p_source must be reaper or operator, got %', p_source;
  END IF;

  UPDATE hosts
     SET state = 'QUARANTINED', quarantined_at = now(), quarantine_reason = p_reason,
         quarantine_source = p_source
   WHERE id = p_host;

  -- One statement, so the log names exactly the rows this call moved. Counting them afterwards by
  -- re-reading `quarantined_at` would be a clock comparison standing in for a fact the UPDATE
  -- already has — 032's lesson, and here it would also pick up a device quarantined moments earlier
  -- by another caller inside the same transaction.
  WITH collapsed AS (
    UPDATE devices
       SET quarantined_from = state, state = 'QUARANTINED',
           quarantined_at = now(),
           quarantine_reason = 'its host was quarantined: ' || p_reason,
           quarantine_source = 'host',
           updated_at = now()
     WHERE host_id = p_host AND state IN ('READY','OFFLINE','BOOTING','CLEANING','PREPARING')
    RETURNING id, fence
  ), ins AS (
    INSERT INTO device_quarantine_log (device_id, event, source, reason, fence)
    SELECT c.id, 'quarantined', 'host', 'its host was quarantined: ' || p_reason, c.fence
      FROM collapsed c
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM collapsed;

  RETURN v_count;
END $$;

-- ---------------------------------------------------------------- and the way back from silence
--
-- Unchanged in what it decides — only a `reaper` host quarantine clears this way, and it is
-- re-checked here rather than trusted to the caller (016's point). Two additions:
--
--   * the device-level quarantine stamp is cleared alongside the state, or a device restored to
--     READY would go on reporting a reason it no longer has;
--   * a device restored to PREPARING gets a FRESH recovery clock. The window
--     `expire_stalled_recoveries` measures is "how long since this host was asked to prepare it",
--     and this host was gone for part of it — expiring the recovery for time spent waiting on a
--     partition would fail the attempt for the one reason that is not about the device.
CREATE OR REPLACE FUNCTION clear_silence_quarantine(p_host uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE hosts
     SET state = 'UP', quarantined_at = NULL, quarantine_reason = NULL, quarantine_source = NULL
   WHERE id = p_host AND state = 'QUARANTINED' AND quarantine_source = 'reaper';
  IF NOT FOUND THEN RETURN -1; END IF;

  UPDATE devices
     SET state = quarantined_from, quarantined_from = NULL,
         quarantined_at = NULL, quarantine_reason = NULL, quarantine_source = NULL,
         recovery_started_at = CASE WHEN quarantined_from = 'PREPARING'
                                    THEN now() ELSE recovery_started_at END,
         updated_at = now()
   WHERE host_id = p_host AND state = 'QUARANTINED' AND quarantined_from IS NOT NULL
     -- Only the cascade's own rows. A handset an operator took out of service while its host was
     -- also silent keeps its quarantine when the host comes back, which is 016's rule about who
     -- may overrule whom, one level down.
     --
     -- NULL is included because rows collapsed by the PRE-035 `quarantine_host` carry a
     -- `quarantined_from` and no source at all. Excluding them would strand every device that was
     -- mid-cascade at the moment this migration was applied — a deploy-time regression that would
     -- look exactly like the bug 016 was written to fix.
     AND (quarantine_source = 'host' OR quarantine_source IS NULL);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Fleet-wide mutations on the system pool: 008's split, 012's ownership, and the REVOKE that
-- matters because Postgres grants EXECUTE to PUBLIC by default (invariant 4).
ALTER FUNCTION quarantine_device(uuid,text,text,uuid,jsonb)          OWNER TO mfarm_definer;
ALTER FUNCTION release_device_quarantine(uuid,uuid)                  OWNER TO mfarm_definer;
ALTER FUNCTION finish_device_recovery(uuid,uuid,bigint,boolean,text,jsonb) OWNER TO mfarm_definer;
ALTER FUNCTION expire_stalled_recoveries(interval)                   OWNER TO mfarm_definer;
REVOKE EXECUTE ON FUNCTION quarantine_device(uuid,text,text,uuid,jsonb)          FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION release_device_quarantine(uuid,uuid)                  FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION finish_device_recovery(uuid,uuid,bigint,boolean,text,jsonb) FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION expire_stalled_recoveries(interval)                   FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION quarantine_host(uuid,text,text)                       FROM PUBLIC, mfarm_app;
REVOKE EXECUTE ON FUNCTION clear_silence_quarantine(uuid)                        FROM PUBLIC, mfarm_app;
GRANT SELECT, INSERT ON device_quarantine_log TO mfarm_definer;
-- The sequence behind `seq`. Without this every INSERT above fails with "permission denied for
-- sequence device_quarantine_log_seq_seq" — a bigserial's default is a nextval() the inserting role
-- has to be allowed to call, which the table grant does not cover.
GRANT USAGE ON SEQUENCE device_quarantine_log_seq_seq TO mfarm_definer;

-- TWO COLUMNS OF `users`, AND ONLY TWO.
--
-- `quarantine_device` and `release_device_quarantine` copy the actor's email into the audit row so
-- the record outlives the account (see the table above). `mfarm_definer` is deliberately least-
-- privileged — it owns definer functions and is emphatically not a superuser — so it has no read on
-- `users` at all, and without this the release path fails with "permission denied for table users".
--
-- Column-level rather than table-level: these functions need an id and an address, and `users` is
-- the table a password hash lives beside. A blanket GRANT SELECT would hand every definer function
-- in the schema a read of everything on that row, which is a wider door than the audit needs and
-- exactly the kind of thing nobody re-examines once it is in.
GRANT SELECT (id, email) ON users TO mfarm_definer;

COMMIT;
