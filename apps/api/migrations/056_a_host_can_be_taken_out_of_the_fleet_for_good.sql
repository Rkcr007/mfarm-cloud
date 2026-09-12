-- 056: a host can be taken out of the fleet for good.
--
-- ---------------------------------------------------------------- what is wrong today
--
-- A machine that registers an agent is in `hosts` forever. There is no way to say "that was a
-- laptop, it is not coming back" — so a host that has been switched off for a fortnight keeps its
-- row, keeps its devices, and keeps being counted.
--
-- ON THIS FARM THAT IS NOT THEORETICAL. A MacBook ran an agent once on 2026-08-29 and has not
-- beaten since. Fifteen days later it is still:
--
--   a CRITICAL alert on the Infrastructure page, every minute of every day;
--   the reason "Hosts" and "Device farm" read DEGRADED and never read anything else;
--   one of "1 of 2 hosts powered on", so the headline understates the farm it describes;
--   a device in the fleet that no allocator will ever hand out.
--
-- **A ROLLUP THAT IS ALWAYS AMBER IS ONE PEOPLE STOP READING.** That is the actual cost: the health
-- board was built so a degraded farm is noticeable, and a permanent degradation trains the eye past
-- it. The page cannot fix that by being cleverer about silence — fifteen days and fifteen minutes
-- are the same kind of fact — so the product needs a way for a person to say which it was.
--
-- ---------------------------------------------------------------- retire, not delete
--
-- `DELETE FROM hosts` cascades to `devices` and to `host_power_intervals`, and sets
-- `agent_enrollments.host_id` to NULL. That throws away what the machine cost and what its devices
-- did, which is exactly the history the Infrastructure page exists to keep. It would also make
-- `infra_operations` rows point at a `target_id` that resolves to nothing.
--
-- A timestamp costs nothing and keeps all of it. Every read that describes the CURRENT fleet filters
-- on it; every read that describes the PAST does not.
--
-- ---------------------------------------------------------------- and it is not permanent
--
-- A REGISTRATION UN-RETIRES. Running the agent on that laptop again is a deliberate act by a person
-- with the enrollment credential, and it is the same evidence a heartbeat is for a silence
-- quarantine (016) or for `DOWN` (ADR-0038): the claim is "this machine is not part of the fleet",
-- and a machine registering itself falsifies it.
--
-- A BEAT ALONE DOES NOT. That distinction is deliberate. A beat can arrive from an agent process
-- nobody meant to leave running; registration means somebody set it up again. Retiring is a
-- judgement, and only a comparable act should overturn it.

BEGIN;

ALTER TABLE hosts
  ADD COLUMN retired_at     timestamptz,
  -- ON DELETE SET NULL: deleting the person must never resurrect the host.
  ADD COLUMN retired_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN retired_reason text;

COMMENT ON COLUMN hosts.retired_at IS
  'Set when an operator takes a machine out of the fleet for good. Every read describing the CURRENT fleet filters it out; history keeps it. Cleared by a fresh registration, which is evidence the machine is back.';

-- The predicate every fleet read now carries. Partial, because the interesting set is the small one.
CREATE INDEX hosts_active_idx ON hosts (region, state) WHERE retired_at IS NULL;

-- ---------------------------------------------------------------- the devices go with it
--
-- A retired host's devices are withdrawn the same way a drained host's are, through the function
-- that already knows how: it leaves RESERVED and SESSION_ACTIVE alone, so retiring a machine cannot
-- evict a tenant mid-session, and it records what each device was so nothing is guessed.
--
-- NOT A SEPARATE MECHANISM. `quarantine_host` is the one place that knows how to take devices out of
-- circulation safely, and a second implementation here would be the one that eventually forgets the
-- RESERVED case. The route calls it before setting `retired_at`.

-- ---------------------------------------------------------------- allocation
--
-- The allocator selects from `devices`, joined to hosts only through the silence sweep, so a retired
-- host's devices are already unallocatable once quarantined. This is belt and braces for the sweep
-- itself: there is no point quarantining a machine that has been retired, and doing so would write a
-- fresh `quarantined_at` every time the reaper ran.
COMMENT ON INDEX hosts_active_idx IS
  'The current fleet. Every host read that answers "what do we have" uses this; the reaper and the cost history do not.';

COMMIT;
