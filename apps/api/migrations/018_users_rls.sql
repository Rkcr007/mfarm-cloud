-- 018: close the users table to the tenant pool.
--
-- FOUND WHILE BUILDING THE TEAM SCREEN, 2026-08-23, and it is architecture rule 2 in a new place.
--
-- `users` and `user_sessions` are the only tables holding org-scoped data with RLS never enabled.
-- 001 grants `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` to `mfarm_app`, and adds a DEFAULT
-- PRIVILEGES rule so every table created since arrived with the same grant already attached. So the
-- tenant pool can read every user row in the database — every address, every `password_hash`, every
-- org — and can write them too.
--
-- Nothing exploits it today ONLY because every function in `users.ts` happens to use `withSystem`.
-- That is an accident of implementation, not a boundary: the first query that reaches `users`
-- through `withTenant` turns a join mistake into a cross-tenant disclosure with nothing underneath
-- to catch it. A Team screen is precisely that query, which is why this lands before it.
--
-- SELECT ONLY, deliberately. A policy with `WITH CHECK` would let the tenant pool UPDATE a
-- colleague's `password_hash` — an account takeover reachable from any request that reuses a
-- connection. Reads are what the console needs; every mutation stays on `withSystem`, where it
-- already is, and where the org scope is written out explicitly in the query.

BEGIN;

ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE users         FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE  ROW LEVEL SECURITY;

-- A user is visible to an org it is a member of, and to no other. Membership is the join that
-- decides it, and `memberships` carries its own RLS — so this cannot be widened by forgetting a
-- WHERE clause upstream. A person in two orgs is visible to both, once each, which is correct.
CREATE POLICY users_in_my_org ON users
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.user_id = users.id
       AND m.org_id  = current_org()
  ));

-- No policy at all for `user_sessions`: RLS with no policy denies everything, which is exactly
-- right. A browser session token hash is not org data a tenant query should ever reach, and every
-- caller today is already `withSystem`.

COMMIT;
