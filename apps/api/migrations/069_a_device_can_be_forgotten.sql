-- 069: a device can be forgotten.
--
-- ---------------------------------------------------------------- what is wrong today
--
-- A device that registers once is in `devices` for ever. A handset plugged in on 2026-08-27 for one
-- afternoon is still in the Fleet six weeks later, OFFLINE, under a model name nobody recognises,
-- and counted in every "N devices" the product states. With agents on people's laptops this is the
-- ordinary case rather than the odd one: phones are borrowed, sold and replaced.
--
-- There was no way to say "that one is gone". Migration 056 answered the same question for a HOST
-- and this is its counterpart one level down.
--
-- ---------------------------------------------------------------- forget, not delete
--
-- `sessions`, `metering_events`, the quarantine log and the run history all point at a device id.
-- Deleting the row would leave a failing test's record unable to say which phone it ran on, which
-- is the evidence a run exists to keep. So this is a timestamp, exactly as 056 is: the reads that
-- describe what the fleet HAS leave a forgotten device out, and everything about the past still
-- resolves.
--
-- ---------------------------------------------------------------- hidden is never allocatable
--
-- THE RULE EVERY READ USES IS NOT `retired_at IS NULL`. It is
--
--     retired_at IS NULL OR state NOT IN ('OFFLINE', 'QUARANTINED')
--
-- A device may only be forgotten while it is OFFLINE, or quarantined by a person or a health check
-- — states the allocator never hands out. The second half of the rule is what makes that safe
-- against every path this migration does not know about: if anything ever moves a forgotten device
-- into a state where it could be allocated, that same change makes it visible again. There is no
-- arrangement of these two columns in which a device is both hidden and available.
--
-- ---------------------------------------------------------------- and it comes back by itself
--
-- The agent seeing the device again is the evidence that "gone" was wrong — the same shape as a
-- registration un-retiring a host. The heartbeat that gives an away device back, and the
-- registration that lists it as present, both clear these columns (`routes/workers.ts`). A person
-- can also restore one from the console.

BEGIN;

ALTER TABLE devices
  ADD COLUMN retired_at     timestamptz,
  -- ON DELETE SET NULL: deleting the person must never bring the device back.
  ADD COLUMN retired_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN retired_reason text;

COMMENT ON COLUMN devices.retired_at IS
  'Set when somebody forgets a device that is gone. A read of what the fleet HAS uses (retired_at IS NULL OR state NOT IN (OFFLINE, QUARANTINED)), never retired_at alone, so a hidden device can never be an allocatable one. Cleared when its agent sees it again, or by a person.';

-- The forgotten set is the small one; this is the index the list of them reads.
CREATE INDEX devices_forgotten_idx ON devices (host_id) WHERE retired_at IS NOT NULL;

COMMIT;
