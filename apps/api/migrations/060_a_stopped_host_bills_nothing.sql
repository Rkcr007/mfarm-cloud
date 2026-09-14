-- 060: a beat from a machine we stopped does not restart the meter.
--
-- ---------------------------------------------------------------- what 059 broke
--
-- Found on the farm within minutes of deploying 059, by reading the top bar: the console said
-- **"Host on · ₹65/hr"** about a VM that was TERMINATED, while the Infrastructure page beside it
-- said "0 of 1 hosts powered on". `host_power_intervals` had an interval OPENED at 09:40 and nothing
-- that would ever close it.
--
-- The sequence, all three parts working as written:
--
--   * Stop marks the host DOWN. 054 case 3 closes the open interval, `ended_by = 'stopped'`. Right.
--   * A dying beat arrives a second later. 054 case 2 — "it spoke, so if no interval is open, open
--     one" — opens a NEW interval. That case exists because the reaper's ninety seconds and the
--     heartbeat's two minutes do not line up, and before 059 it was harmless: the beat also lifted
--     `DOWN`, the host went back to UP, and the reaper's silence quarantine closed the interval
--     ninety seconds later (case 4).
--   * 059 stopped the beat lifting DOWN. So the host stays DOWN, the reaper never sweeps it — it
--     only sweeps `UP` — and case 4 never fires. **The interval stays open for ever.**
--
-- ADR-0035 exists because a switched-off host was billed for twelve hours. This would have billed
-- one for the rest of the month.
--
-- ---------------------------------------------------------------- the rule
--
-- A BEAT IS NOT EVIDENCE OF POWER WHEN THE CONTROL PLANE KNOWS IT STOPPED THE MACHINE. `DOWN` is
-- written by exactly one thing (a stop this control plane performed and watched), and 059 already
-- decided such a beat is not evidence the machine is staying. It is not evidence it is billing
-- either — and of the two ways to be wrong, ADR-0035 and 054 both choose to undercount.
--
-- The interval reopens when the host genuinely comes back: `lift_host_down` sets DOWN -> UP, which
-- is a transition no case covered, because before 059 the same statement always moved
-- `last_heartbeat_at` or `up_since` as well. It gets its own case rather than relying on that.

BEGIN;

CREATE OR REPLACE FUNCTION track_host_power() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 1. THE HOST CAME UP, or came back after a gap the heartbeat judged long enough to be a restart.
  IF NEW.up_since IS NOT NULL AND NEW.up_since IS DISTINCT FROM OLD.up_since THEN
    UPDATE host_power_intervals
       SET ended_at = GREATEST(started_at, COALESCE(OLD.last_heartbeat_at, NEW.up_since)),
           ended_by = 'restarted'
     WHERE host_id = NEW.id AND ended_at IS NULL;

    INSERT INTO host_power_intervals (host_id, started_at)
    VALUES (NEW.id, NEW.up_since) ON CONFLICT DO NOTHING;
    RETURN NEW;
  END IF;

  -- 1b. IT WAS STOPPED AND IT IS BACK. DOWN -> UP is `lift_host_down` (059) deciding a beat or a
  --     registration disproves the stop. Before 059 this transition always carried a moved
  --     `last_heartbeat_at` in the same statement, so case 2 covered it; now it arrives on its own.
  IF NEW.state = 'UP' AND OLD.state = 'DOWN' THEN
    INSERT INTO host_power_intervals (host_id, started_at)
    SELECT NEW.id, COALESCE(NEW.last_heartbeat_at, now())
     WHERE NOT EXISTS (
       SELECT 1 FROM host_power_intervals WHERE host_id = NEW.id AND ended_at IS NULL)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
  END IF;

  -- 2. IT SPOKE, AND WE ARE NOT COUNTING IT — unless we are the reason it is quiet.
  --
  --    `NEW.state <> 'DOWN'` is 060. A packet from a machine this control plane stopped and watched
  --    the provider confirm is the tail of a process being killed, not proof the meter is running;
  --    reopening on it billed a TERMINATED VM for ever, because nothing sweeps a DOWN host.
  IF NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at AND NEW.state <> 'DOWN' THEN
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

  -- 4. IT WENT SILENT AND THE REAPER NOTICED. Only a REAPER quarantine closes an interval: an
  --    operator quarantine is a drain, and a drained host is switched on and costing money.
  IF NEW.state = 'QUARANTINED' AND NEW.quarantine_source = 'reaper'
     AND OLD.quarantine_source IS DISTINCT FROM 'reaper' THEN
    UPDATE host_power_intervals
       SET ended_at = GREATEST(started_at, COALESCE(NEW.last_heartbeat_at, now())),
           ended_by = 'silence'
     WHERE host_id = NEW.id AND ended_at IS NULL;
  END IF;

  RETURN NEW;
END $$;

-- THE REPAIR. Any interval left open on a host this control plane knows is stopped is the defect
-- above, still running up a bill. Closed at the last beat — the last moment there was evidence the
-- machine was on — which is the same instant case 3 would have used.
UPDATE host_power_intervals i
   SET ended_at = GREATEST(i.started_at, COALESCE(h.last_heartbeat_at, i.started_at)),
       ended_by = 'stopped'
  FROM hosts h
 WHERE h.id = i.host_id AND i.ended_at IS NULL AND h.state = 'DOWN';

COMMIT;
