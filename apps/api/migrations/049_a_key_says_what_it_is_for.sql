-- 049: an API key says what it is for, what it may do, and when it stops working.
--
-- ---------------------------------------------------------------- what is wrong today
--
-- `api_keys` is (prefix, key_hash, created_at, revoked_at) and nothing else. The console's "New API
-- key" button POSTs an empty body, so ONE CLICK MINTS A LIVE ORG-WIDE CREDENTIAL THAT NEVER
-- EXPIRES and has no name. The 2026-09-09 review found this by clicking it: an exploratory press
-- during an audit produced a working key, and the only thing distinguishing it from the CI key
-- beside it was the creation timestamp.
--
-- The consequence is not that keys are too powerful — it is that **rotation is impossible**. To
-- rotate you must know which key a system is using, and with four unlabelled prefixes and no record
-- of use, revoking one is a coin flip on whether CI stops. So nobody rotates, and a key that leaked
-- a year ago is still valid. That is the actual defect: not the blast radius of one key, but that
-- the org cannot safely reduce it.
--
-- ---------------------------------------------------------------- what a scope can honestly mean
--
-- A key ALREADY cannot escalate. `requireOrgAdmin` calls `requireUser`, so team changes, retention
-- settings, agent enrollment and minting or revoking keys all require a signed-in person — an API
-- key cannot mint another API key. That boundary exists and is not what this adds.
--
-- What a key CAN do that a CI job has no business doing is DESTROY EVIDENCE. Exactly three
-- tenant-guarded routes delete data:
--
--   DELETE /v1/artifacts/:id            one artifact
--   DELETE /v1/sessions/:id/artifacts   every artifact a session left
--   DELETE /v1/sessions/:id/record      the recording
--
-- So `scope` names that existing boundary rather than inventing a permission matrix. Two values,
-- because two is what the code can actually enforce today and a third would be a column nothing
-- reads:
--
--   'automation'  run tests. Allocate, drive, install, read runs, artifacts and usage. May NOT
--                 delete evidence. This is what a CI key wants and it is the DEFAULT for new keys.
--   'full'        everything a tenant key can do today, evidence deletion included.
--
-- A capability list was the alternative and is refused on the grounds that it would be mostly
-- aspiration: eleven capability strings of which the code checks one. When a second real boundary
-- appears, this becomes a third scope or a list then, with something to put in it.
--
-- ---------------------------------------------------------------- why existing keys become 'full'
--
-- Backfilled to 'full', not to the new default. A migration that silently narrowed a live CI
-- credential would break a customer's pipeline at 3am to enforce a policy they were never told
-- about, and they would read it as the farm being broken. Existing keys keep exactly the authority
-- they have; the narrower default applies only to keys minted after this.
--
-- Their label is honest about what it is rather than invented: nobody knows what those keys were
-- for, and a made-up "CI key" would be a fact this table cannot support.
--
-- ---------------------------------------------------------------- last_used_at, and its cost
--
-- The column that makes revocation safe: "this key has not been used in 90 days" is the sentence
-- that lets somebody delete it without holding their breath. It is deliberately NOT exact. Writing
-- it on every request would add a write to every authenticated call including every WebDriver
-- command the hub proxies, which on a busy run is hundreds per minute per session — so `auth.ts`
-- updates it only when the recorded value is older than a few minutes. The column therefore means
-- "used at or after this", which is all the question needs.
--
-- ---------------------------------------------------------------- expiry
--
-- NULL means never, which is what every existing key is and what a long-lived integration wants.
-- The check is in `authenticate`, not here, because a constraint cannot express "stop working
-- later". An expired key authenticates as nothing at all rather than as a refused principal: a
-- caller presenting it gets the same answer as a caller presenting nonsense, which is the correct
-- disclosure — a 403 saying "that key expired" confirms the key was real.
BEGIN;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS label        text;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scope        text NOT NULL DEFAULT 'full';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at   timestamptz;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_by   uuid REFERENCES users(id) ON DELETE SET NULL;

-- Every key that existed before this migration. Said plainly, because the alternative is inventing
-- a purpose for a credential whose purpose nobody recorded.
UPDATE api_keys SET label = 'unnamed — created before keys had labels' WHERE label IS NULL;

-- Required from here on. The backfill above is what makes NOT NULL safe to add.
ALTER TABLE api_keys ALTER COLUMN label SET NOT NULL;

-- THE DEFAULT IS A ROLLBACK GUARD, NOT A CONVENIENCE, and `rollback.test.ts` is what insisted on
-- it. Rolling the API image back to a release that predates this migration leaves code whose
-- `createApiKey` inserts (org_id, prefix, key_hash) and names no label — which against a NOT NULL
-- column with no default fails outright, so a rollback would take key minting down completely.
--
-- With a default, the old release writes exactly what it always wrote and the row is labelled the
-- same way the backfill above labels the keys nobody named. Nothing in the NEW code relies on it:
-- the route refuses an unlabelled request and `createApiKey` takes the label as a required
-- argument, so a label is compulsory where a person can see the error, and merely present where a
-- rolled-back binary can still function.
ALTER TABLE api_keys ALTER COLUMN label SET DEFAULT 'unnamed — created before keys had labels';
ALTER TABLE api_keys ADD CONSTRAINT api_keys_label_len
  CHECK (length(label) > 0 AND length(label) <= 120);

-- The vocabulary, in the database rather than only in the route, because `createApiKey` is not the
-- only thing that has ever written this table — `deploy/` has minted keys by SQL during bring-up.
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_known
  CHECK (scope IN ('automation', 'full'));

-- The default is deliberately NOT changed to 'automation'. A default belongs to whoever writes a
-- row without naming the column, and the only such writers are bring-up scripts that legitimately
-- want a full key. The narrower default for PEOPLE lives in the route, where it can be shown in a
-- dialog and overridden with a click.

COMMENT ON COLUMN api_keys.label IS
  'What this key is for, chosen by the person who minted it. Required. The thing that makes '
  'rotation possible: you cannot safely revoke a credential you cannot identify.';
COMMENT ON COLUMN api_keys.scope IS
  'automation = run tests, may not delete evidence (the default for new keys). full = everything a '
  'tenant key can do, evidence deletion included. Names the three destructive tenant routes that '
  'already exist rather than a permission matrix.';
COMMENT ON COLUMN api_keys.expires_at IS
  'When this key stops authenticating. NULL means never. Enforced in authenticate(), not by a '
  'constraint, and an expired key is indistinguishable from an invalid one to its presenter.';
COMMENT ON COLUMN api_keys.last_used_at IS
  'Approximately when this key last authenticated — updated at most once every few minutes, because '
  'an exact value would cost a write on every proxied WebDriver command. Means "used at or after".';
COMMENT ON COLUMN api_keys.created_by IS
  'The person who minted it, for attribution. NULL for keys minted before this column and for keys '
  'whose creator has since been removed from the org.';

COMMIT;
