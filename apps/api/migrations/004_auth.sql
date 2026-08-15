-- Auth and HTTP-layer support.

BEGIN;

-- Where the browser connects for the DATA plane. v2 decision 2: the control plane mints a token and
-- points at the worker; frames and input never traverse the API. This column is what makes that
-- redirection possible, so it is required before a host can take tenant traffic.
ALTER TABLE hosts ADD COLUMN endpoint text;

-- Workers authenticate as themselves, not as a tenant. A worker credential must never be able to
-- read tenant data, and a tenant key must never be able to register a host.
ALTER TABLE hosts ADD COLUMN token_prefix text UNIQUE;
ALTER TABLE hosts ADD COLUMN token_hash   text;

-- Worker-local device identifier, so re-registration is an upsert rather than a duplicate insert.
-- Without it, a worker restart doubles the fleet inventory every time.
ALTER TABLE devices ADD COLUMN local_id text;
CREATE UNIQUE INDEX devices_host_local_idx ON devices(host_id, local_id) WHERE local_id IS NOT NULL;

-- Idempotency for unsafe requests (the gap flagged in the v1 review).
-- Session creation allocates a scarce, billable resource; a client that retries on a timeout must
-- not get two devices and two bills. The stored response is replayed verbatim.
CREATE TABLE idempotency_keys (
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key          text NOT NULL,
  request_hash text NOT NULL,        -- sha256 of method+path+body
  status_code  integer NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);
CREATE INDEX idempotency_gc_idx ON idempotency_keys(created_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY idempotency_own_org ON idempotency_keys
  USING (org_id = current_org()) WITH CHECK (org_id = current_org());

GRANT SELECT, INSERT, DELETE ON idempotency_keys TO mfarm_app;

COMMIT;
