-- 034: PREPARING, on its own, because a Postgres enum will not let it be added and used at once.
--
-- This migration adds ONE enum value and nothing else. It looks like it should be the first ten
-- lines of 035, and it cannot be: `ALTER TYPE ... ADD VALUE` may run inside a transaction on PG 12+
-- but THE NEW VALUE CANNOT BE USED UNTIL THAT TRANSACTION COMMITS. A function body in 035 that
-- writes 'PREPARING' would fail at CREATE time with "unsafe use of new value of enum type" if it
-- shared this transaction. That is invariant 6 — the trap ADR-0019 wrote down and migration 022
-- paid for — and splitting the file is the whole of the workaround.
--
-- The runner applies files in name order and records each one, so a failure in 035 re-runs 035
-- alone; `IF NOT EXISTS` is what makes that second run harmless rather than an error about a value
-- that is already there.
--
-- ---------------------------------------------------------------- what the state means
--
-- PREPARING is the state a device holds while it is ATTEMPTING TO RECOVER from quarantine, after an
-- operator authorised the attempt and before it has earned its way back. It is not allocatable and
-- it is not quarantined, and both halves are the point:
--
--   * not allocatable, because a device that failed its health checks has proved nothing yet;
--   * not quarantined, because QUARANTINED stops the heartbeat offering it a reset, which is the
--     only thing that could fix it — the exact objection ADR-0019 raised against quarantining an
--     escalated device, and the reason that ADR chose a condition over a state.
--
-- ADR-0024 is what makes a device-level QUARANTINED safe to enter at all: there is now a way out of
-- it, and this is the state that way runs through.
--
-- Placed after CLEANING in the enum's own ordering because that is where it sits in the lifecycle,
-- and `ORDER BY state` is the only thing that ordering affects.

BEGIN;

ALTER TYPE device_state ADD VALUE IF NOT EXISTS 'PREPARING' AFTER 'CLEANING';

COMMIT;
