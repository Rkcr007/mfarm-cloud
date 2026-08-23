-- 021: outcomes — the farm learns whether the test passed.
--
-- WebDriver has no concept of an assertion. The farm watches a session open, drive a device, and
-- close, and every one of those looks identical whether the test passed or failed. So a Runs screen
-- built on migration 020 can say how many sessions a run had and which build they ran, and cannot
-- say the one thing anybody actually asks. There are exactly two ways to close that gap:
--
--   1. the suite tells us;
--   2. we infer it from something — a non-zero exit code, an exception in the logcat, a session
--      that ended without a clean quit.
--
-- The second is inference dressed up as fact, and it is wrong in both directions: a suite can fail
-- assertions and exit zero, and a session can end dirtily because CI was cancelled. A number that is
-- confidently wrong about whether your tests passed is worse than no number, because a green
-- dashboard is precisely what stops people looking. So: the suite tells us, in one line of an
-- afterEach, and if it does not tell us the run reports NOTHING rather than a guess.
--
-- ---------------------------------------------------------------- one session, many tests
--
-- A row per TEST, not per session. `examples/medishop-suite` allocates one device per spec file and
-- runs eight tests on it, which is the shape the docs recommend and the shape the economics force —
-- allocation takes seconds and the powerwash after release takes 40-80s, so a device per test would
-- spend most of its life recycling. A result table keyed by session could not represent that at all.
--
-- ---------------------------------------------------------------- what is NOT constrained
--
-- **`(session_id, name)` IS NOT UNIQUE, and that is deliberate.** A retry reports the same test name
-- twice — failed, then passed — and that pair IS the flakiness signal, which is the single most
-- valuable thing this table can eventually show. Deduplicating on name would silently discard it
-- and would also break parameterised tests that legitimately share a name. The cost is that a
-- retried test contributes two results to a run's counts, and the API says so rather than guessing
-- which one was "the real" attempt; the farm cannot tell a retry from a distinct test with the same
-- name, and inventing an answer here would be the same mistake as inferring pass/fail.
--
-- **No expiry.** `artifacts` expire in 14 days because they are megabytes of logcat; a result is a
-- few hundred bytes of text and is the record of what happened. Outliving the evidence is correct —
-- "test X failed on build 4471" stays answerable after the logcat is swept.

BEGIN;

CREATE TABLE test_results (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- DERIVED FROM THE SESSION at insert time, never accepted from the caller. Architecture rule 4:
  -- the same reasoning that stopped a worker naming the org it bills.
  org_id      uuid NOT NULL REFERENCES orgs(id)     ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- The test's name as the suite knows it. Bounded because it is rendered in the console and
  -- appears in log lines; 500 is generous for "describe > it" concatenations.
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  -- text + CHECK rather than an enum, per 019: adding a status later is one line that runs inside a
  -- transaction, where `ALTER TYPE ... ADD VALUE` cannot. Three values because they are the three
  -- every framework has; anything richer is a taxonomy nobody shares.
  status      text NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
  -- The message and stack, for a failure. Truncated by the API rather than rejected: a stack that
  -- is too long must not cost the caller the whole result, which is the one thing they came to
  -- report. The truncation is marked in the text so nobody debugs a stack that silently stops.
  failure     text,
  duration_ms integer CHECK (duration_ms >= 0),
  reported_at timestamptz NOT NULL DEFAULT now()
);

-- The session detail screen, and the per-session rollup the run detail does.
CREATE INDEX test_results_session_idx ON test_results(session_id, reported_at);
-- "Show me what failed", which is the whole point and is a small slice of a large table.
CREATE INDEX test_results_failed_idx ON test_results(session_id) WHERE status = 'failed';

ALTER TABLE test_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_results FORCE  ROW LEVEL SECURITY;

CREATE POLICY test_results_own_org ON test_results
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

GRANT SELECT, INSERT ON test_results TO mfarm_app;

COMMENT ON TABLE test_results IS
  'What the SUITE reported about its own tests. The farm cannot observe this — WebDriver has no '
  'concept of an assertion — so a session with no rows here has an unknown outcome, which is '
  'different from a passing one and is reported as such.';

COMMIT;
