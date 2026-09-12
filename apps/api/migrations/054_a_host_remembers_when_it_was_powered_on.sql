-- 054: a host remembers when it was powered on, not just since when.
--
-- ---------------------------------------------------------------- the question 050 cannot answer
--
-- Migration 050 added `hosts.up_since` and ADR-0035 explains why: the device host ran for twenty
-- hours and forty-eight minutes after a check that needed two, and nothing in the product said so.
-- That column fixed "how long has this been on, and what has it cost SO FAR".
--
-- It is a single timestamp, so it can only ever describe the CURRENT power-on. The moment the host
-- stops, the fact that it was on for twenty hours yesterday is gone — overwritten the next time it
-- comes up. So every question the cost surface actually needs is unanswerable:
--
--   what did the farm cost today?          -- needs yesterday's intervals, which are gone
--   what has it cost this month?           -- same, thirty times over
--   what will it cost this month?          -- an estimate with no history is a guess with a currency
--   is it costing more than last week?     -- there is no last week
--   which host is on but doing nothing?    -- needs powered time to divide device time BY
--
-- `metering_events` cannot stand in and ADR-0035 says why in its own words: it records what a TENANT
-- consumed, correctly, and across those twenty hours it recorded a few minutes because the devices
-- were idle. **What costs money is the machine being POWERED ON**, allocated or not. That is a
-- different measurement and this is the table for it.
--
-- ---------------------------------------------------------------- why a trigger and not a route
--
-- The obvious implementation is "the start/stop endpoints write a row". It is also wrong, because
-- most power transitions do not come from an endpoint and never will: the box is started by
-- `deploy/farm-online.sh` from a laptop, by a GCP maintenance event, by somebody in the cloud
-- console, or by the machine rebooting itself. A row written only where the product acts would
-- undercount exactly the hours nobody was watching — which are the hours that produced the incident
-- this whole line of work descends from.
--
-- So the intervals are derived from the ONE fact every path already updates: `hosts.up_since`,
-- maintained by the heartbeat (050, and see the comment in `routes/workers.ts` about why a gap in
-- beats is what "came up" means). A trigger cannot be forgotten by a new route, and cannot be
-- bypassed by a script that updates the table directly.

BEGIN;

CREATE TABLE host_power_intervals (
  id         bigserial PRIMARY KEY,
  host_id    uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,

  started_at timestamptz NOT NULL,
  -- NULL means "still on". Exactly one open row per host, enforced below.
  ended_at   timestamptz,

  -- How we learned the interval ended. Kept because the three mean different things when reading a
  -- bill: `stopped` is somebody acting, `silence` is the reaper inferring it from missed beats, and
  -- `restarted` is a host that came back up without ever telling us it went down.
  ended_by   text CHECK (ended_by IN ('stopped', 'silence', 'restarted')),

  CONSTRAINT host_power_intervals_ordered CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- ONE OPEN INTERVAL PER HOST, as a constraint rather than as a convention. Two open rows would
-- double every cost this table is used to compute, and would do it silently.
CREATE UNIQUE INDEX host_power_intervals_open_idx
  ON host_power_intervals (host_id) WHERE ended_at IS NULL;

-- The shape every cost query has: one host, a window, newest first.
CREATE INDEX host_power_intervals_window_idx
  ON host_power_intervals (host_id, started_at DESC);

COMMENT ON TABLE host_power_intervals IS
  'When each host was powered on. Derived from hosts.up_since and hosts.state by trigger, never written by a route. The basis for every cost figure that covers more than the current power-on.';

-- ---------------------------------------------------------------- the derivation
--
-- THE END OF AN INTERVAL IS NEVER `now()`. A host that stopped beating at 03:11 and was noticed by
-- the reaper at 03:12 was off from 03:11; billing it for the minute the control plane took to work
-- that out is a small error that compounds on every single outage. `last_heartbeat_at` is the last
-- moment we have evidence the machine was on, so that is the end.
--
-- The `GREATEST` guard is not defensive dressing: a host whose beat lands out of order with another
-- write could otherwise produce `ended_at < started_at`, violate the CHECK, and turn a cost
-- bookkeeping detail into a FAILED HEARTBEAT. A zero-length interval is the honest answer there,
-- and a heartbeat is never allowed to fail over accounting.
CREATE FUNCTION track_host_power() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 1. THE HOST CAME UP, or came back after a gap the heartbeat judged long enough to be a restart.
  --    `up_since` moving is the only signal for this, and it is maintained on the BEAT path, which
  --    is the only path a host actually returns by -- see 050's own comment about the
  --    register-only version of this rule that never fired.
  IF NEW.up_since IS NOT NULL AND NEW.up_since IS DISTINCT FROM OLD.up_since THEN
    UPDATE host_power_intervals
       SET ended_at = GREATEST(started_at, COALESCE(OLD.last_heartbeat_at, NEW.up_since)),
           ended_by = 'restarted'
     WHERE host_id = NEW.id AND ended_at IS NULL;

    INSERT INTO host_power_intervals (host_id, started_at)
    VALUES (NEW.id, NEW.up_since) ON CONFLICT DO NOTHING;
    RETURN NEW;
  END IF;

  -- 2. IT SPOKE, AND WE ARE NOT COUNTING IT. A beat is proof the machine is on, so if no interval
  --    is open one is opened here.
  --
  --    THIS BRANCH EXISTS BECAUSE THE TWO THRESHOLDS DO NOT MATCH, and without it the gap between
  --    them is a permanent leak. The reaper quarantines at 90 seconds of silence (case 4 closes the
  --    interval); the heartbeat only moves `up_since` after a gap of TWO MINUTES. A host that is
  --    quiet for 100 seconds and then returns therefore trips neither case 1 nor case 3 — it would
  --    be recorded as powered off, forever, while running and billing.
  --
  --    It reopens at the BEAT, not at `up_since`: `up_since` still points at the original power-on,
  --    and starting there would re-bill the silent gap that case 4 just decided we had no evidence
  --    for. One index probe per beat, on a partial unique index over at most one row per host.
  IF NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at THEN
    INSERT INTO host_power_intervals (host_id, started_at)
    SELECT NEW.id, NEW.last_heartbeat_at
     WHERE NOT EXISTS (
       SELECT 1 FROM host_power_intervals WHERE host_id = NEW.id AND ended_at IS NULL)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
  END IF;

  -- 3. IT WAS STOPPED. DOWN is the only state that means "not powered".
  IF NEW.state = 'DOWN' AND OLD.state IS DISTINCT FROM 'DOWN' THEN
    UPDATE host_power_intervals
       SET ended_at = GREATEST(started_at,
                               COALESCE(NEW.last_heartbeat_at, OLD.last_heartbeat_at, now())),
           ended_by = 'stopped'
     WHERE host_id = NEW.id AND ended_at IS NULL;
    RETURN NEW;
  END IF;

  -- 4. IT WENT SILENT AND THE REAPER NOTICED.
  --
  --    ONLY A REAPER QUARANTINE CLOSES AN INTERVAL. An OPERATOR quarantine is a drain: the machine
  --    is switched on, doing nothing, and costing exactly what it cost yesterday — which is the
  --    single most important thing this table has to be able to say. Treating the two the same way
  --    would make "drained" silently stop the meter on a running VM, and the cost page would then
  --    report its best numbers on its worst days.
  --
  --    UNDERCOUNTING IS THE DELIBERATE DIRECTION HERE. A silent host may be switched off, or it may
  --    be a running VM behind a broken network. We close at `last_heartbeat_at` -- the last moment
  --    we have EVIDENCE it was on -- so a partition is under-billed rather than a stopped machine
  --    over-billed, and `ended_by = 'silence'` is on the row to say which kind of gap this was.
  IF NEW.state = 'QUARANTINED' AND NEW.quarantine_source = 'reaper'
     AND OLD.quarantine_source IS DISTINCT FROM 'reaper' THEN
    UPDATE host_power_intervals
       SET ended_at = GREATEST(started_at, COALESCE(NEW.last_heartbeat_at, now())),
           ended_by = 'silence'
     WHERE host_id = NEW.id AND ended_at IS NULL;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER hosts_track_power
  AFTER UPDATE ON hosts
  FOR EACH ROW EXECUTE FUNCTION track_host_power();

-- ---------------------------------------------------------------- the hosts that are on RIGHT NOW
--
-- Backfilled from `up_since`, so the table is not empty until the next restart of every machine.
-- That is the difference between a cost page that works on the day it ships and one that works next
-- Tuesday. Only what is knowable is backfilled: there is exactly one interval per currently-up host
-- and no invented history before it.
INSERT INTO host_power_intervals (host_id, started_at)
SELECT id, up_since FROM hosts
 WHERE up_since IS NOT NULL AND state IN ('UP', 'QUARANTINED')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- who may write the ledger
--
-- `mfarm_app` never touches it: hosts are fleet metadata and 002 revoked the whole table from that
-- role, so nothing on the tenant pool can reach a statement that fires this trigger.
--
-- `mfarm_definer` MUST, and finding out why cost a test. The trigger is invoker-rights, so inside
-- `quarantine_host` -- a SECURITY DEFINER function owned by `mfarm_definer` since 012 -- it executes
-- as that role. Without these grants the REAPER's quarantine raises "permission denied for table
-- host_power_intervals" and the whole sweep fails: a cost-bookkeeping detail would have taken down
-- the mechanism that withdraws a silent host's devices, which is the opposite of the trade this
-- table is supposed to make.
--
-- NO DELETE, and no DELETE for anybody. This is a ledger; rows are closed, never removed.
GRANT SELECT, INSERT, UPDATE ON host_power_intervals             TO mfarm_definer;
GRANT USAGE, SELECT          ON SEQUENCE host_power_intervals_id_seq TO mfarm_definer;

REVOKE ALL ON host_power_intervals FROM PUBLIC, mfarm_app;
REVOKE ALL ON SEQUENCE host_power_intervals_id_seq FROM PUBLIC, mfarm_app;

COMMIT;
