-- 065 — a passing run of a saved test is kept as its route, and the next run replays it (ADR-0046).
--
-- A saved test used to pay a model to rediscover the same route on every run and every upload. When
-- a run of one PASSES, and its verdict names what on the screen proves it (`expect`), the steps that
-- worked are kept here as a plan: each action, the element it landed on and which of that element's
-- id / label / text named it alone on its screen. The next run of the test replays the plan with no
-- model at all, and asks one only for the part the app no longer matches — and a run that passes
-- that way writes the next version.
--
-- Append-only: a new version is written, none is rewritten, so a run always points at the route it
-- replayed. A plan belongs to the task it was written for (`prompt_sha256`): an edited test's old
-- route is not replayed against its new words.

BEGIN;

CREATE TABLE ai_test_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ai_test_id     uuid NOT NULL REFERENCES ai_tests(id) ON DELETE CASCADE,
  version        integer NOT NULL CHECK (version >= 1),
  prompt_sha256  text NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  platform       text NOT NULL CHECK (platform IN ('android', 'ios')),
  source_run_id  uuid REFERENCES ai_runs(id) ON DELETE SET NULL,
  -- `[{tool, input, target, intent}]` — typed text as its `{{PLACEHOLDER}}`, never a secret's value.
  steps          jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  -- What the screen shows when the test passed; checked by the runner, not by a model.
  expect         text NOT NULL CHECK (length(btrim(expect)) BETWEEN 1 AND 500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ai_test_id, version)
);

-- The runner's lookup: the newest route for this test, task and platform.
CREATE INDEX ai_test_plans_latest ON ai_test_plans (ai_test_id, platform, prompt_sha256, version DESC);

ALTER TABLE ai_test_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_test_plans FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_test_plans_own_org ON ai_test_plans
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());
REVOKE UPDATE, DELETE ON ai_test_plans FROM mfarm_app;
GRANT  SELECT, INSERT ON ai_test_plans TO mfarm_app;

-- Which route a run replayed, if any. A run with none was driven by the model from its first step.
ALTER TABLE ai_runs ADD COLUMN plan_id uuid REFERENCES ai_test_plans(id) ON DELETE SET NULL;

COMMIT;
