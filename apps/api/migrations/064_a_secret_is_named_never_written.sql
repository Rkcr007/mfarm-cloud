-- 064 — a secret is named in a task, never written into it (ADR-0045).
--
-- A task says `{{PIN}}`; the value lives here, sealed (AES-256-GCM, bound to its org and name — see
-- `ai/vault.ts`), and is opened only by the runner at the moment the agent types it. No endpoint
-- returns `sealed`, and nothing but the runner can open it: the key is derived from the farm's
-- signing key and never stored.
--
-- One row per org and name, like CI secrets: any test of the org may name any of its secrets.

BEGIN;

CREATE TABLE ai_secrets (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- As a task writes it between the braces: PIN, LOGIN_EMAIL.
  name        text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  -- iv (12) ‖ tag (16) ‖ ciphertext. At most 500 characters of value, so a bounded size.
  sealed      bytea NOT NULL CHECK (octet_length(sealed) BETWEEN 29 AND 2100),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, name)
);

ALTER TABLE ai_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_secrets FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_secrets_own_org ON ai_secrets
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- DELETE, unlike ai_tests: nothing points at a secret, and a removed secret should be GONE — kept,
-- it would be a value the org believes it has taken back.
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_secrets TO mfarm_app;

COMMIT;
