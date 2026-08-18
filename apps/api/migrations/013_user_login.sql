-- 013: let a HUMAN authenticate, which nothing in this schema could do before.
--
-- `users` and `memberships` have existed since 001, and neither carries a credential. Every
-- authenticated request in this system is an org-wide API key or a worker token, so the only way to
-- "log in" was to hold a key that is equivalent to every other holder of that key. That is fine for
-- a CI job and wrong for a person: a key cannot be attributed, cannot be revoked without breaking
-- every other user of it, and cannot express that Asha is an admin and Ravi is not.
--
-- Two things are added, and the split matters.
--
-- 1. A PASSWORD, stored as a scrypt digest with a per-user salt and the parameters INSIDE the
--    string (`scrypt$N$r$p$salt$hash`). Encoding the cost alongside the digest is what makes it
--    possible to raise N later without a flag day: an old digest still verifies under its own
--    parameters and is rewritten on the next successful login.
--
-- 2. A SESSION TABLE rather than a stateless signed cookie. A browser credential must be
--    revocable on the server the instant a password changes or a person leaves, and a stateless
--    token cannot be — it stays valid until it expires, wherever it was copied to. The cost is one
--    indexed lookup per request, which is the same cost the API key path already pays.

BEGIN;

-- NULL means "cannot log in with a password", which is a real state: a user invited but not yet
-- activated, or one who only ever authenticates through an org API key.
ALTER TABLE users ADD COLUMN password_hash text;

-- Rotated on password change so every OTHER session dies while the current one survives; see the
-- session table's comment.
ALTER TABLE users ADD COLUMN credential_epoch integer NOT NULL DEFAULT 0;

CREATE TABLE user_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Which org this browser session is acting as. A user can belong to several; the session pins
  -- one, so an org switch is an explicit act that produces a new session rather than an ambient
  -- setting that a request might read differently than the check that authorised it.
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- sha256 of the cookie value. The cookie itself is never stored, for the same reason api_keys
  -- stores only a hash: a database read must not yield a working credential.
  token_hash    text NOT NULL UNIQUE,
  -- Double-submit value, checked against a header on every unsafe request — a cookie is attached by
  -- the browser automatically and a header is not.
  --
  -- Stored IN THE CLEAR, unlike token_hash beside it, and the asymmetry is deliberate. The console
  -- has to be handed this value again after every page reload, so it must be recoverable; and it
  -- defends against a cross-origin page, which cannot read a same-origin response at all. Anyone who
  -- can read this column can already mint a session row outright, so hashing it would protect
  -- nothing while making the reload path impossible.
  csrf          text NOT NULL,
  -- The value of users.credential_epoch when this session was minted. A password change bumps the
  -- user's epoch, which invalidates every session carrying the old one without a DELETE that has to
  -- find them all.
  epoch         integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

CREATE INDEX user_sessions_user_idx ON user_sessions(user_id) WHERE revoked_at IS NULL;
-- Expiry sweep. Sessions are the one credential here that accumulates without operator action.
CREATE INDEX user_sessions_expiry_idx ON user_sessions(expires_at);

-- NOT under RLS, and that is deliberate rather than an omission. RLS on the tenant tables keys off
-- `current_org()`, which is set from an ALREADY AUTHENTICATED principal — this table is what
-- produces that principal, so it is read before an org is known. It is reached only through
-- `withSystem`, exactly like `api_keys` and `hosts.token_hash`, and never by tenant-scoped code.

COMMIT;
