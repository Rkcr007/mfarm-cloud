-- 063 — a failure can be explained (ADR-0043, capability C8).
--
-- One model call over what the farm already recorded about a failed session — the failure the suite
-- reported, the last WebDriver commands, the tail of logcat, the last screen — answering "why did
-- this fail, and whose problem is it?". Scripted runs and AI runs alike: the evidence is the
-- session's either way.
--
-- A diagnosis is BILLED, from the same monthly budget as AI steps, at `AI_DIAGNOSE_PRICE_INR`. It is
-- kept, so asking twice shows the answer already paid for rather than buying it again.

BEGIN;

CREATE TABLE ai_diagnoses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  session_id         uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Whose problem the model thinks it is. `unknown` is a real answer and the console shows it as one.
  verdict            text NOT NULL CHECK (verdict IN ('app_bug', 'test_bug', 'environment', 'unknown')),
  summary            text NOT NULL,
  evidence           jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_fix      text,
  -- What the model was shown, as counts — so "it never saw the log" is visible rather than inferred.
  inputs             jsonb NOT NULL DEFAULT '{}'::jsonb,
  model              text NOT NULL,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  price_inr          numeric(8, 2) NOT NULL CHECK (price_inr >= 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_diagnoses_session_idx ON ai_diagnoses (session_id, created_at DESC);
CREATE INDEX ai_diagnoses_spend_idx ON ai_diagnoses (org_id, created_at);

ALTER TABLE ai_diagnoses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_diagnoses FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_diagnoses_own_org ON ai_diagnoses
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());
-- A billed record, append-only like `ai_steps`.
REVOKE UPDATE, DELETE ON ai_diagnoses FROM mfarm_app;
GRANT  SELECT, INSERT ON ai_diagnoses TO mfarm_app;

COMMIT;
