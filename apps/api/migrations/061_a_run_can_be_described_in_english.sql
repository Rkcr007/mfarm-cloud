-- 061 — a run can be described in English (ADR-0043, capabilities C2–C4).
--
-- An AI run is a prompt, a profile and a device; MFARM's agent drives the device through the hub
-- until it can state a verdict. The DEVICE side of it is not new and gets no new tables: the agent
-- allocates through `/wd/hub` like any client, so the lease is a `sessions` row, the run is a `runs`
-- row, every command is a `session_commands` row, and release/reset/metering are exactly a scripted
-- session's. What is new is the part the hub cannot see — what the agent was asked, what it saw,
-- what it decided and why, and what each decision cost.
--
-- WRITTEN THROUGH THE TENANT POOL, NOT A DEFINER FUNCTION. The runner acts for one org at a time
-- and always knows which, so `withTenant(org)` and RLS scope every write; there is no fleet-side
-- caller here that would need to cross orgs. The one cross-org operation — claiming the next queued
-- run — runs on the system pool and touches only `status`/`started_at`.

BEGIN;

CREATE TABLE ai_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Who pressed Run. NULL when they have since left the org — the run stays, like an API key does.
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  prompt              text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000),
  profile             text NOT NULL CHECK (profile IN ('flash', 'pro')),
  platform            text NOT NULL CHECK (platform IN ('android', 'ios')),
  region              text,
  -- As the customer wrote it (`pkg@latest`, a build id). The hub resolves it at allocation, which
  -- is also where an unknown reference becomes a clear refusal.
  app_ref             text CHECK (app_ref IS NULL OR length(app_ref) BETWEEN 1 AND 300),
  step_cap            integer NOT NULL CHECK (step_cap BETWEEN 1 AND 200),
  -- queued → running → one of the four ends. `failed` is the AGENT'S verdict that the app does not
  -- do what was asked; `error` is that no verdict could be reached (budget, step cap, device lost,
  -- model unreachable). They are different claims and the console must never merge them.
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error', 'cancelled')),
  stop_reason         text,
  summary             text,
  evidence            text,
  model               text,
  session_id          uuid REFERENCES sessions(id) ON DELETE SET NULL,
  run_id              uuid REFERENCES runs(id) ON DELETE SET NULL,
  steps               integer NOT NULL DEFAULT 0,
  cost_inr            numeric(12, 2) NOT NULL DEFAULT 0,
  cancel_requested_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  ended_at            timestamptz
);

CREATE INDEX ai_runs_org_idx ON ai_runs (org_id, created_at DESC);
-- The runner's claim query and the boot-time sweep read only these, which are almost never many.
CREATE INDEX ai_runs_open_idx ON ai_runs (created_at) WHERE status IN ('queued', 'running');

ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_runs_own_org ON ai_runs
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- A run is a record: it is created, advanced and cancelled, never removed by a tenant.
REVOKE DELETE ON ai_runs FROM mfarm_app;
GRANT  SELECT, INSERT, UPDATE ON ai_runs TO mfarm_app;

CREATE TABLE ai_steps (
  id                 bigserial PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ai_run_id          uuid NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  n                  integer NOT NULL CHECK (n >= 1),
  phase              text NOT NULL CHECK (phase IN ('plan', 'act', 'verify')),
  thought            text,
  -- `{tool, input}` exactly as the model sent it. The input is the agent's, never the customer's
  -- secrets — unless the customer's prompt contained one, which is theirs to have typed.
  action             jsonb,
  result             text,
  -- The observation the step decided on, in the artifact store under `ai/`. Content-addressed, so
  -- an unchanged screen across three steps is one file.
  screenshot_sha256  text CHECK (screenshot_sha256 IS NULL OR screenshot_sha256 ~ '^[0-9a-f]{64}$'),
  element_count      integer,
  model              text NOT NULL,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  -- THE BILLING LEDGER FOR AI (C4). Written at the price in force when the step ran, so a later
  -- change to `AI_PROFILES` never re-prices history.
  price_inr          numeric(8, 2) NOT NULL CHECK (price_inr >= 0),
  started_at         timestamptz NOT NULL,
  duration_ms        integer NOT NULL CHECK (duration_ms >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ai_run_id, n)
);

CREATE INDEX ai_steps_spend_idx ON ai_steps (org_id, created_at);
-- Retention asks "does anything newer still point at this blob?" before deleting it.
CREATE INDEX ai_steps_screenshot_idx ON ai_steps (screenshot_sha256) WHERE screenshot_sha256 IS NOT NULL;

ALTER TABLE ai_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_steps FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_steps_own_org ON ai_steps
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- APPEND-ONLY, like `session_commands` (041) and `execution_events` (030): a ledger a tenant role
-- could rewrite is not a ledger. The one write after insert is retention, on the owner pool, which
-- clears `screenshot_sha256` when the image ages out — the step and its price stay.
REVOKE UPDATE, DELETE ON ai_steps FROM mfarm_app;
GRANT  SELECT, INSERT ON ai_steps TO mfarm_app;
GRANT  USAGE, SELECT  ON SEQUENCE ai_steps_id_seq TO mfarm_app;

-- The guard-rail a customer can see: a run is refused a step that would take the month past this.
ALTER TABLE orgs ADD COLUMN ai_monthly_budget_inr numeric(12, 2) NOT NULL DEFAULT 2000
  CHECK (ai_monthly_budget_inr >= 0);

-- Each AI run drives the hub with its own short-lived `automation` key (ADR-0043 §5). Marked so the
-- org's key list can leave out credentials nobody minted by hand and nobody can use again.
ALTER TABLE api_keys ADD COLUMN ai_run_id uuid REFERENCES ai_runs(id) ON DELETE SET NULL;

COMMIT;
