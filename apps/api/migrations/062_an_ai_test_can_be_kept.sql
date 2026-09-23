-- 062 — an AI test can be kept, and run again on every new build (ADR-0043, capabilities C6, C7).
--
-- A one-off AI run is a question; a SAVED one is a regression check. `ai_tests` holds the prompt,
-- the mode and the app it is about, so "Run again" is one click and its history is one list. With
-- `run_on_upload`, uploading a new build of `app_package` queues it against that build — the
-- exploratory pass on every build that nobody has to remember to start.

BEGIN;

CREATE TABLE ai_tests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  prompt        text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000),
  profile       text NOT NULL DEFAULT 'flash' CHECK (profile IN ('flash', 'pro')),
  platform      text NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios')),
  region        text,
  -- The package (or bundle id) this test is ABOUT. A run with no build picked uses
  -- `<app_package>@latest`, and an upload of a new build of it is what `run_on_upload` listens for.
  app_package   text CHECK (app_package IS NULL OR length(app_package) BETWEEN 1 AND 255),
  run_on_upload boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Archived, never deleted: its runs point at it and their history must keep its name.
  archived_at   timestamptz,
  -- Listening for uploads of nothing is a switch that can never fire; refuse it rather than show it.
  CONSTRAINT ai_tests_upload_needs_package CHECK (NOT run_on_upload OR app_package IS NOT NULL)
);

-- Names are how a person finds a test in a list, so two live ones may not share one.
CREATE UNIQUE INDEX ai_tests_live_name ON ai_tests (org_id, lower(btrim(name))) WHERE archived_at IS NULL;
-- The upload hook's lookup.
CREATE INDEX ai_tests_on_upload ON ai_tests (org_id, app_package) WHERE run_on_upload AND archived_at IS NULL;

ALTER TABLE ai_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_tests FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_tests_own_org ON ai_tests
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());
REVOKE DELETE ON ai_tests FROM mfarm_app;
GRANT  SELECT, INSERT, UPDATE ON ai_tests TO mfarm_app;

ALTER TABLE ai_runs ADD COLUMN ai_test_id uuid REFERENCES ai_tests(id) ON DELETE SET NULL;
-- Who or what started it: a person (`manual`), a saved test's Run (`test`), or an upload (`upload`).
-- An upload-triggered run has no `created_by`, and this is what says why.
ALTER TABLE ai_runs ADD COLUMN trigger text NOT NULL DEFAULT 'manual'
  CHECK (trigger IN ('manual', 'test', 'upload'));
CREATE INDEX ai_runs_test_idx ON ai_runs (ai_test_id, created_at DESC) WHERE ai_test_id IS NOT NULL;

COMMIT;
