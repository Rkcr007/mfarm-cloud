-- Row-level security. Default deny, per v2 decision 1.
--
-- The tenant is carried on the connection as `app.org_id`, set with SET LOCAL inside a transaction
-- so it cannot leak across pooled connections. A query that forgets to filter by org returns zero
-- rows rather than another tenant's data — the failure mode is a visible bug, not a silent breach.

BEGIN;

-- FORCE matters: without it the table owner (migration role) bypasses every policy below, which is
-- exactly the footgun that makes people believe RLS is on when it isn't.
ALTER TABLE orgs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs             FORCE  ROW LEVEL SECURITY;
ALTER TABLE memberships      ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships      FORCE  ROW LEVEL SECURITY;
ALTER TABLE api_keys         ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys         FORCE  ROW LEVEL SECURITY;
ALTER TABLE devices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices          FORCE  ROW LEVEL SECURITY;
ALTER TABLE sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions         FORCE  ROW LEVEL SECURITY;
ALTER TABLE metering_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE metering_events  FORCE  ROW LEVEL SECURITY;

-- Current tenant, or NULL when unset. `true` as the second arg makes a missing setting return NULL
-- instead of raising, so an unscoped query yields no rows rather than an error that might get
-- caught and ignored somewhere upstream.
CREATE OR REPLACE FUNCTION current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------- policies

CREATE POLICY orgs_self ON orgs
  USING (id = current_org());

CREATE POLICY memberships_own_org ON memberships
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

CREATE POLICY api_keys_own_org ON api_keys
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- Devices: an org sees the shared fleet (org_id IS NULL) plus anything dedicated to it.
-- Reads are permissive; writes are not — only the allocator (SECURITY DEFINER) mutates device rows.
CREATE POLICY devices_visible ON devices
  FOR SELECT
  USING (org_id IS NULL OR org_id = current_org());

CREATE POLICY sessions_own_org ON sessions
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

CREATE POLICY metering_own_org ON metering_events
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- Regions and hosts are fleet metadata, not tenant data. Hosts stay unexposed to tenants entirely;
-- regions are readable by all so clients can pick one.
GRANT SELECT ON regions TO mfarm_app;
REVOKE ALL ON hosts FROM mfarm_app;

COMMIT;
