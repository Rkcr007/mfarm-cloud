-- 023: an agent host can belong to an org, and enrolling one no longer needs the fleet secret.
--
-- Physical devices arrive on machines nobody in this project administers — a teammate's laptop with
-- a phone on the end of a USB cable. Two things about the current bootstrap stop working at that
-- point, and they are different problems.
--
-- ONE. `POST /v1/workers/register` is gated by `WORKER_REGISTRATION_TOKEN`, a single fleet-wide
-- secret that must exist on every machine that will ever register. That is defensible for two
-- machines you own and rebuild yourself. It is not defensible once the token has to be pasted into
-- a laptop: it does not expire, it names nobody, revoking it revokes the whole fleet, and anyone
-- holding it can register a host that then receives real sessions. So: per-enrollment tokens,
-- single-use, expiring, revocable, attributable, and scoped to one org.
--
-- TWO. A phone cannot be powerwashed between tenants, so it must never enter the shared pool. The
-- allocator ALREADY has the mechanism — `allocate_device` filters on
-- `(d.org_id IS NULL OR d.org_id = p_org)` and `devices_visible` scopes SELECT the same way — so
-- nothing here changes how scheduling works. What is missing is the plumbing that SETS
-- `devices.org_id`, because until now every device came from a host the operator owned and shared
-- pooling was the only case. An enrolled host carries an org, and the devices it registers inherit
-- it. Pinning by construction, not by a policy someone has to remember to apply.

BEGIN;

-- ---------------------------------------------------------------- hosts belong to an org, or not
--
-- NULLABLE, and the null case is the existing behaviour: a host registered with the fleet secret is
-- infrastructure the operator owns, its devices are shared, and nothing about it changes. Only the
-- enrollment path sets this.
ALTER TABLE hosts ADD COLUMN org_id uuid REFERENCES orgs(id) ON DELETE CASCADE;

COMMENT ON COLUMN hosts.org_id IS
  'The org that enrolled this host, or NULL for an operator-owned host whose devices are shared. Devices registered by this host inherit it, which is what keeps a physical device out of the shared pool.';

CREATE INDEX hosts_org_idx ON hosts(org_id) WHERE org_id IS NOT NULL;

-- ---------------------------------------------------------------------------- enrollment tokens
--
-- Shaped like `api_keys` on purpose: prefix shown and safe to log, sha256 of the secret stored, the
-- plaintext returned exactly once. The differences are all about it being a BOOTSTRAP credential
-- rather than a standing one — it expires, it is used once, and it records what it became.
CREATE TABLE agent_enrollments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  prefix      text NOT NULL UNIQUE,
  token_hash  text NOT NULL,
  -- What a person calls this machine in the console. Not an identifier: the host names itself at
  -- registration and `hosts.hostname` stays the key.
  label       text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Required, not defaulted-to-forever. A bootstrap secret that outlives the afternoon someone set
  -- up a laptop is the thing this table exists to stop being.
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  -- SINGLE USE. Set when redeemed, together with the host it produced, so an operator looking at a
  -- host can answer "who enrolled this and when" without reading logs that have rotated away.
  used_at     timestamptz,
  host_id     uuid REFERENCES hosts(id) ON DELETE SET NULL
);

CREATE INDEX agent_enrollments_org_idx ON agent_enrollments(org_id, created_at DESC);

COMMENT ON COLUMN agent_enrollments.used_at IS
  'Redemption is one-shot: a token with this set is refused. Kept rather than deleted so a host row can be traced back to the person who enrolled it.';

ALTER TABLE agent_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_enrollments FORCE  ROW LEVEL SECURITY;

-- SELECT ONLY for the tenant pool, following 018's rule rather than `api_keys`'s.
--
-- The console lists these; every mutation — minting, revoking, and above all REDEEMING — runs on
-- the system pool with the org written out explicitly. Redemption is the reason this matters: it is
-- reached by an UNAUTHENTICATED caller presenting a token, so there is no `current_org()` to scope
-- it by, and a policy with WITH CHECK would be a permission for a principal that does not exist yet.
CREATE POLICY agent_enrollments_own_org ON agent_enrollments
  FOR SELECT
  USING (org_id = current_org());

-- 001's ALTER DEFAULT PRIVILEGES hands `mfarm_app` the full set on every table the owner creates
-- from now on, so this table arrived with INSERT/UPDATE/DELETE already attached. Same trap
-- migration 014 hit; same revoke.
REVOKE INSERT, UPDATE, DELETE ON agent_enrollments FROM mfarm_app;

COMMIT;
