-- 042: the timeline learns that tests exist.
--
-- ---------------------------------------------------------------- what is wrong today
--
-- `execution_events` (030) has nine kinds and every one of them describes what the FARM did: a run
-- was created, a session queued, a device allocated, a build installed, a session ended, a device
-- released. So the timeline can tell you the device was allocated at 10:30:04 and the session ended
-- at 10:31:52, and it cannot tell you the thing the person opened the page for — that the test
-- failed at 10:31:43.
--
-- The spec's own worked example (`AutomationExecutionPlan.md` §18) has `Test started` and
-- `Test failed` in the middle of it. They were not built because when 030 landed there was nothing
-- to emit them from that the farm could see. There is now: migration 021's result POST, which 040
-- taught to request evidence and which this teaches to leave a mark.
--
-- ---------------------------------------------------------------- what a kind costs
--
-- One line, because 030 chose `text + CHECK` over an enum for exactly this — `ALTER TYPE … ADD
-- VALUE` cannot run in the transaction that adds it, so a new kind plus a constraint mentioning it
-- would take two migrations.
--
-- ---------------------------------------------------------------- what is deliberately NOT a kind
--
-- **`command-failed` is not here, and that is a decision rather than an omission.** Migration 041
-- records every WebDriver command, and a failed one is extremely common in a healthy suite: an
-- implicit wait polls `findElement` until it succeeds, so a single successful step can produce a
-- dozen `no such element` responses on the way. Putting those on the run timeline would bury the
-- three events somebody came to read under a hundred they did not.
--
-- The command trace is its own view, at the SESSION level, where the volume belongs and where the
-- failing step can be shown in context with the ones around it. The run timeline stays a summary,
-- and the two link rather than merge — the same reasoning ADR-0018 used to keep an execution
-- separate from the test process it wraps.

-- ---------------------------------------------------------------- rewriting a CHECK is a trap
--
-- THIS MIGRATION SHIPPED A REGRESSION IN DRAFT AND IT IS WORTH RECORDING, because the mistake is
-- invisible and the next person to add a kind will make it.
--
-- A `CHECK (kind IN (…))` cannot be extended; it has to be dropped and rewritten in full. The first
-- draft of this file rewrote the list from **migration 030**, which is where the constraint was
-- born — and so silently dropped `'run-completed'`, which migration 031 had added in between. It
-- applied cleanly, because no existing row violated it. The failure would have arrived later, on
-- the first run somebody declared finished.
--
-- The rule: read the CONSTRAINT, not the migration that created it.
--
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'execution_events_kind_check';

BEGIN;

ALTER TABLE execution_events DROP CONSTRAINT execution_events_kind_check;
ALTER TABLE execution_events ADD  CONSTRAINT execution_events_kind_check
  CHECK (kind IN (
    'run-created',
    'session-queued', 'device-allocated', 'session-active',
    'build-install-started', 'build-install-finished',
    -- What the SUITE says happened. The farm cannot see an assertion (021's whole premise), so
    -- these exist only for a run whose suite reports — and their absence is honest: a run with no
    -- test events is one that told us nothing, not one where nothing happened.
    'test-failed',
    -- Evidence landed. Its `detail` carries the artifact id and kind, so a timeline entry is a link
    -- to the picture rather than a note that a picture exists somewhere.
    'artifact-created',
    'session-ended',
    'device-released',
    'incident',
    -- From migration 031, and NOT from 030's original list. See the note above.
    'run-completed'
  ));

-- ---------------------------------------------------------------- when the test failed, not when we heard
--
-- `reported_at` is when the row reached us. That is the wrong clock for a timeline: a reporter that
-- batches its POSTs — which is what a `after()` hook does, and what every CI-friendly reporter does
-- on a crashed run — collapses ten failures onto one instant, and the timeline then says the suite
-- failed everything simultaneously three minutes after the session ended.
--
-- OPTIONAL, AND DEFAULTED TO `reported_at`. Every suite written before this migration keeps working
-- and reads exactly as it did; one that sends the real time gets a truthful timeline. Making it
-- required would break every existing reporting hook to fix a problem those hooks do not have.
--
-- NOT TRUSTED BLINDLY. The API clamps it to the session's own lifetime — see `results.ts`. A
-- reporter with a wrong clock, or a caller who would like their failure to appear before the run
-- started, must not be able to write a timeline that cannot have happened.
ALTER TABLE test_results ADD COLUMN occurred_at timestamptz;

COMMENT ON COLUMN test_results.occurred_at IS
  'When the SUITE says the test finished, as opposed to reported_at, which is when we heard. NULL '
  'for a suite that does not send one; read it as COALESCE(occurred_at, reported_at).';

COMMIT;
