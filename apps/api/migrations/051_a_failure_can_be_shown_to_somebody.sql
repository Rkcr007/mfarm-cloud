-- 051: a failure can be shown to somebody who has no account here.
--
-- ---------------------------------------------------------------- what is wrong today
--
-- Every way of looking at a failure requires a session cookie for this org. So the thing a QA
-- engineer does thirty times a week — paste a failure into Slack and say "is this you?" — is not
-- possible: the developer who broke it, the contractor on the integration, the person in the
-- incident channel all need an account on the farm first. What happens instead is a screenshot of a
-- screenshot, with the stack retyped and the step trace lost.
--
-- LambdaTest calls it `public_url`. It is the smallest feature on the gap list and the one a team
-- reaches for daily.
--
-- ---------------------------------------------------------------- what a share is scoped to
--
-- ONE TEST RESULT. Not a run, not a session, not an org. The narrowest thing that answers the
-- question somebody is asking, because every widening is a disclosure nobody reviewed: a session
-- share would carry every other test that ran on that device, and a run share would carry the
-- entire suite.
--
-- ---------------------------------------------------------------- what it deliberately does NOT
-- ---------------------------------------------------------------- carry
--
-- **THE LOGCAT.** A share is readable by anyone holding the link, and a device log is the artifact
-- most likely to contain something the person sharing it has not read — an app logs auth headers,
-- deep links with tokens in them, and whatever a third-party SDK feels like printing. The screenshot
-- was framed by the app, the stack was written by the suite, and the step trace is MFARM's own
-- record of which commands it forwarded (ADR-0029 stores no request bodies, so no selector or typed
-- password is in it). The log is the one artifact nobody curated.
--
-- That is a default, not a law: somebody who wants to hand over a log can still download it and send
-- it. The difference is that they will have looked at it.
--
-- ---------------------------------------------------------------- the credential
--
-- Shaped exactly like `api_keys`: a random secret shown once, a `prefix` that is safe to log and to
-- render, and a sha256 of the whole token. The plaintext is never stored, so a database dump does
-- not hand somebody every live share link.
--
-- REVOCABLE, which is why this is a TABLE and not a signed token. A signed URL cannot be withdrawn,
-- and the realistic mistake with this feature is not that the crypto fails — it is that somebody
-- shares a failure and then notices the screenshot has a customer's name in it. `revoked_at` is what
-- makes that recoverable.
--
-- EXPIRING BY DEFAULT, because the link outlives the conversation it was made for. The API picks the
-- default and enforces a ceiling; the column only records what was chosen.
BEGIN;

CREATE TABLE result_shares (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Derived from the test result at insert time, never accepted from the caller -- architecture
  -- rule 4, the same reasoning that stops a worker naming the org it bills.
  org_id          uuid NOT NULL REFERENCES orgs(id)         ON DELETE CASCADE,
  test_result_id  uuid NOT NULL REFERENCES test_results(id) ON DELETE CASCADE,

  -- Shown in the console so a person can tell two links apart, and safe to write to a log.
  prefix          text NOT NULL UNIQUE,
  -- sha256 of the full token. The token itself is returned once and never stored.
  token_hash      text NOT NULL,

  -- Who disclosed this, kept for the reason an audit trail exists at all: "who sent that link" is
  -- the first question asked when one turns up somewhere unexpected. ON DELETE SET NULL, because a
  -- share must outlive the account that made it rather than vanishing with it.
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,

  -- Approximately when it was last opened, and how often. Both are the same question -- "is this
  -- link still circulating?" -- which is what makes revoking one a decision rather than a guess.
  -- Updated at most once every few minutes, like `api_keys.last_used_at`, because a link pasted in
  -- a busy channel is fetched by every unfurler that sees it.
  last_viewed_at  timestamptz,
  views           integer NOT NULL DEFAULT 0
);

-- The lookup every unauthenticated request makes. Unique already indexes `prefix`; this is the
-- "which shares exist for this result" query the console asks when drawing the button.
CREATE INDEX result_shares_result_idx ON result_shares(test_result_id) WHERE revoked_at IS NULL;

-- RLS, like every other tenant table. The PUBLIC read path deliberately does NOT go through this
-- policy -- it cannot, because an anonymous caller has no org -- and reads on the system pool with
-- the token as the entire authorization. That is the same shape `authenticate()` uses for api_keys
-- and it is stated here so the next reader does not think the policy is protecting that route.
--
-- `current_org()` (002), NOT `current_setting(...)` SPELT BY HAND. The first draft of this file
-- wrote `current_setting('mfarm.org_id', true)::uuid`, and nothing anywhere sets `mfarm.org_id` --
-- `withTenant` sets `app.org_id`. The policy was therefore comparing org_id against NULL on every
-- row, which is neither true nor false, so the table admitted no reads AND no writes: the feature
-- was dead on arrival in a way that reads, in a migration, like ordinary care. Architecture rule 8
-- is the general form of this -- go and look at what the database DOES, not at what a file says it
-- should -- and the probe that caught it was six lines against the running schema.
ALTER TABLE result_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_shares FORCE  ROW LEVEL SECURITY;
CREATE POLICY result_shares_own_org ON result_shares
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());
GRANT SELECT, INSERT, UPDATE ON result_shares TO mfarm_app;

COMMENT ON TABLE result_shares IS
  'A link that shows ONE failed test to somebody with no account here. Scoped to a single '
  'test_result, revocable, expiring, and deliberately excluding the logcat -- see the migration.';
COMMENT ON COLUMN result_shares.token_hash IS
  'sha256 of the share token. The token is returned once at creation and never stored, so a '
  'database dump does not hand over every live link.';
COMMENT ON COLUMN result_shares.views IS
  'How often it has been opened, counted to make revoking a decision rather than a guess. '
  'Approximate: link unfurlers in chat clients fetch a URL several times per paste.';

COMMIT;
