-- 031: a run can be told it is over.
--
-- Migration 020 refused `runs.ended_at` and `runs.status`, and the reasoning was right: a run has no
-- DERIVABLE end. A sequential suite ends every session before starting the next, so "the last
-- session ended" would mark a twenty-test run finished nineteen times before it was.
--
-- ADR-0018 changes the input, not the reasoning. MFARM owns the execution RECORD and the customer
-- owns the test PROCESS — so the process can SAY when it is done, in an `after` hook or at
-- `mfarm run`'s exit. A declared end is not an inference, which is the whole difference. The 020
-- comment has been corrected in docs/EXECUTION_MODEL.md §4.2 rather than left to contradict this.
--
-- ---------------------------------------------------------------- one column, not a status
--
-- `completed_at` and nothing else. The obvious second column is a `status`, and it would be a claim
-- this table has no standing to make: whether the run PASSED is already answered, by `test_results`,
-- from the only party that can observe an assertion (§4.3). A `status` here would either duplicate
-- that — two numbers that can disagree, and eventually will — or invite the caller to declare an
-- outcome the farm cannot check.
--
-- So completion says one thing: NOBODY IS GOING TO ADD MORE TO THIS RUN. That is precisely what the
-- existing rollup was missing. `tests.passed = 2, failed = 0` on a live run means "so far"; on a
-- completed run it means "that is the result". Same numbers, and only now safe to act on.
--
-- ---------------------------------------------------------------- what a missing completion means
--
-- INCOMPLETE, and never FAILED. A suite that was killed, a CI job that timed out, a laptop that
-- slept — none of those is evidence about the product, and rendering them as failure would be the
-- same manufactured claim that migration 021 refuses when it declines to infer pass/fail from an
-- exit code, and that 024 refuses when it leaves an unclassified failure unclassified.
--
-- It also cannot be back-filled: every run that predates this migration was never asked to declare
-- an end, so a default would assert something about all of them at once. NULL is the honest value
-- and the only one available.

BEGIN;

ALTER TABLE runs ADD COLUMN completed_at timestamptz;

COMMENT ON COLUMN runs.completed_at IS
  'When the SUITE said it was finished. NULL means incomplete — nobody declared an end — which is '
  'never the same as failed. Deliberately not derived: a sequential suite ends every session before '
  'starting the next, so "the last session ended" is not the end of the run.';

-- "Runs still open" — what a console banner and any future reaper would ask for. Partial, because
-- the answer is a handful of rows out of a table that only grows.
CREATE INDEX runs_incomplete_idx ON runs(org_id, created_at DESC) WHERE completed_at IS NULL;

-- ---------------------------------------------------------------- the event
--
-- `text` + CHECK is what makes this one line rather than two migrations — 019 wrote the rule down,
-- 022 paid for it, and 030 followed it precisely so that this moment would be cheap.
ALTER TABLE execution_events DROP CONSTRAINT execution_events_kind_check;
ALTER TABLE execution_events ADD CONSTRAINT execution_events_kind_check
  CHECK (kind IN (
    'run-created',
    'session-queued', 'device-allocated', 'session-active',
    'build-install-started', 'build-install-finished',
    'session-ended',
    'device-released',
    'incident',
    'run-completed'
  ));

COMMIT;
