-- 048: a session says which test it is, and a run says what it is called.
--
-- ---------------------------------------------------------------- what is wrong today
--
-- Open the Runs screen while a suite is running and it shows sessions by uuid. Which of the two
-- phones is on "search and view pending expenses" and which one is stuck on the OTP screen is not
-- a question this console can answer, and it is the first question anybody asks.
--
-- The farm HAS the name — `test_results.name` carries it — but not until the suite posts a result,
-- which by definition is after the test has finished. For the whole time somebody would actually
-- want to look, the session is anonymous. And a passing test is never rendered at all: the run
-- screen lists failures, so a green session's name is written down and shown to nobody.
--
-- Every commercial farm takes this as a CAPABILITY, at session creation, because that is the only
-- moment where the name is both known and useful: LambdaTest's `lt:options.name`, BrowserStack's
-- `name`. A suite sets it once in its `@Before` and every row in the dashboard is legible from then
-- on. MFARM had no equivalent, so the migration from one of those farms lost the labels — which is
-- the thing that made their dashboards readable in the first place.
--
-- ---------------------------------------------------------------- what this adds
--
-- Two nullable text columns. `sessions.name` is the TEST this session is running;`runs.name` is
-- what the suite calls the run, as opposed to `external_id`, which is what CI calls it.
--
-- WHY `runs.name` IS SEPARATE FROM `runs.external_id`, given the caller could just pass a readable
-- string as the id. Because the two are wanted at once and they disagree: `external_id` is the join
-- key back to CI (`$GITHUB_RUN_ID` — a number, and the only thing that will match the Actions run)
-- and the name is what a person scans a list for (`Android_UAE_Expenses_08_09_2026_06_53_38`).
-- Forcing one field to be both means picking which of "click through to the CI job" and "find this
-- morning's expenses run" the customer gets to keep.
--
-- NULLABLE, AND NULL IS ORDINARY rather than a gap to be backfilled. A suite that sets neither
-- reads exactly as it does today — the id, which is what every existing run has. Nothing derives a
-- name from anything: an invented one ("session 3 of 8") would be a label the suite never wrote,
-- and this table's whole value is that its labels came from the person who knew.
--
-- NOT UNIQUE, and deliberately not. Two sessions running the same scenario — a retry, or the same
-- test on two device classes — are two sessions with one name, which is true and useful. A
-- constraint here would refuse the retry, which is the run most worth looking at.
--
-- ---------------------------------------------------------------- why the length is bounded here
--
-- A CHECK rather than validation in one API handler, because there are two writers — the hub's
-- capability parser and the `mfarm-name` script hook — and a bound enforced in the application is
-- a bound that holds until somebody adds a third.
BEGIN;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE sessions ADD CONSTRAINT sessions_name_len
  CHECK (name IS NULL OR (length(name) > 0 AND length(name) <= 300));

COMMENT ON COLUMN sessions.name IS
  'What the SUITE calls the test this session is running, from the mfarm:name capability or the '
  'mfarm-name script hook. NULL for a session that never said. Never derived.';

ALTER TABLE runs ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE runs ADD CONSTRAINT runs_name_len
  CHECK (name IS NULL OR (length(name) > 0 AND length(name) <= 200));

COMMENT ON COLUMN runs.name IS
  'What the SUITE calls this run, from the mfarm:runName capability — as opposed to external_id, '
  'which is what CI calls it and is the join key back to the CI job. NULL for a run that never said.';

COMMIT;
