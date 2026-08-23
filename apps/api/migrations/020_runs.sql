-- 020: runs — the thing that makes a hundred sessions legible.
--
-- Until now nothing grouped sessions. Twenty tests were twenty unrelated `sessions` rows and the
-- console's Sessions screen was a flat chronological list, so "what failed on build 4471" was not
-- slow to answer, it was UNANSWERABLE. Every other execution-model gap (docs/EXECUTION_MODEL.md §4)
-- is downstream of this one: artifacts can only be rolled up per lease, cost can only be attributed
-- per lease, and a nightly's result cannot be compared with yesterday's.
--
-- A run is named by the CLIENT, not by us. `mfarm:runId` takes whatever the caller already has —
-- $GITHUB_RUN_ID, a Jenkins build number, a uuid minted per `npm test` — and the FIRST session to
-- use a given name creates the run while every later one joins it. That is what makes it a
-- one-line change in a wdio.conf.js with no coordination call, no run-create step to fail, and
-- nothing to clean up if the suite dies halfway.
--
-- ---------------------------------------------------------------- what is deliberately NOT here
--
-- **No `ended_at`.** There is no signal that a run is over, and the obvious substitute is wrong in
-- a way that would be believed. "The last session of the run ended" is not the end of the run: a
-- sequential suite ends every test's session before starting the next one, so a twenty-test run
-- would be marked finished nineteen times before it was. The honest shape is to derive the window
-- from the sessions (`min(created_at)`, `max(ended_at)`) and report the number of live ones, which
-- is what `GET /v1/runs` does. A real end needs either an explicit close or the outcome reporting
-- of §4.3, and when one of those exists this column is one line.
--
-- **No `status`.** Same reason, worse consequence. WebDriver has no concept of an assertion — the
-- farm sees a session open and close and cannot tell a passing test from a failing one — so any
-- pass/fail on a run today would be inference presented as fact. §4.3 is what makes it knowable.
--
-- **No `app_build_id` on the run.** A run's sessions can legitimately name different builds (an
-- upgrade test, an A/B). Denormalising one of them onto the run would silently pick a winner. The
-- build is recorded where it is a fact — on the session that installed it, below — and the Runs
-- screen reports how many distinct builds a run touched, naming it only when there is exactly one.
--
-- Both omissions follow 019's rule: a column nothing writes is a claim with nothing behind it.

BEGIN;

CREATE TABLE runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- What the caller wrote in `mfarm:runId`. Opaque to us: it is their id, and its only job is to
  -- be the same string on every session of one run. Bounded and control-character-free because it
  -- is rendered in the console and appears in log lines.
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- SCOPED BY ORG, and that is the whole safety argument for letting clients choose the name. Every
-- CI system on earth numbers builds from 1, so two tenants both running `mfarm:runId: '412'` is the
-- normal case rather than the adversarial one. A global unique index would have merged their runs —
-- one org reading the other's session list through a name collision, with no policy violated
-- because both would genuinely own the row they were handed.
CREATE UNIQUE INDEX runs_org_external_idx ON runs(org_id, external_id);
-- The Runs screen's only query.
CREATE INDEX runs_org_created_idx ON runs(org_id, created_at DESC);

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE  ROW LEVEL SECURITY;

CREATE POLICY runs_own_org ON runs
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

GRANT SELECT, INSERT ON runs TO mfarm_app;

-- ---------------------------------------------------------------- sessions join a run

-- SET NULL, not CASCADE. A session row is the billing record for a device lease; deleting a run
-- must never delete the evidence that the device was held and metered.
ALTER TABLE sessions ADD COLUMN run_id uuid REFERENCES runs(id) ON DELETE SET NULL;

-- "Every session of run X, oldest first" — the run detail screen, and the rollup on the list.
CREATE INDEX sessions_run_idx ON sessions(run_id, created_at) WHERE run_id IS NOT NULL;

COMMENT ON COLUMN sessions.run_id IS
  'The run this session belongs to, from the mfarm:runId capability. NULL for a session that named '
  'no run, which is every session created before migration 020 and every one from a suite that has '
  'not set the capability.';

-- ---------------------------------------------------------------- which build a session ran

-- The resolved `mfarm:appId` has been recorded since 2026-08-23, but only inside the
-- `webdriver_sessions.capabilities` jsonb blob, which is stored for support ("it picked API 34,
-- you assumed 35") and is the wrong place to ask a question from. "What failed on build X" is the
-- query this whole migration exists to enable, and against jsonb it is a scan with a cast in the
-- predicate and no referential integrity — a build id that no longer names a build reads exactly
-- like one that does.
--
-- SET NULL rather than CASCADE for the same reason as above: deleting a build from the library must
-- not delete the record of the sessions that ran it.
ALTER TABLE webdriver_sessions
  ADD COLUMN app_build_id uuid REFERENCES app_builds(id) ON DELETE SET NULL;

-- "Every session that ran this build", which is the query the column exists for.
CREATE INDEX webdriver_sessions_build_idx ON webdriver_sessions(app_build_id)
  WHERE app_build_id IS NOT NULL;

-- Backfill from where it has been living. The join is what makes this safe: `capabilities` is
-- tenant-influenced (it is the upstream's answer merged with ours), so a value in it is a string
-- that LOOKS like a build id until a real row confirms it. The org check is not redundant — this
-- migration runs as the owner, with RLS bypassed, so it is the only thing standing between a
-- forged capability blob and a cross-tenant foreign key.
UPDATE webdriver_sessions w
   SET app_build_id = b.id
  FROM app_builds b
 WHERE b.id::text = (w.capabilities->>'mfarm:appId')
   AND b.org_id = w.org_id
   AND w.app_build_id IS NULL;

COMMENT ON COLUMN webdriver_sessions.app_build_id IS
  'The build mfarm:appId resolved to and the hub installed before the session opened. NULL when the '
  'suite named no build, or brought its own APK with appium:app. Note that app_actions remains the '
  'general record of everything installed onto a session, including installs after it started.';

COMMIT;
