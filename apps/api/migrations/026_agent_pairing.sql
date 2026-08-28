-- 026: pairing a machine by reading a code off its screen — ADR-0014.
--
-- WHAT THIS REPLACES. Enrolling a host today means an org admin logging in by curl with a cookie
-- jar, echoing a CSRF token back in a header, minting an `mae_` token, and the person holding the
-- laptop pasting it into an environment variable. It is eight of the eleven steps a new user faces,
-- it cannot be done by the person actually at the machine unless they are an admin, and the
-- credential travels through a chat message on its way there.
--
-- The enrollment token itself is fine and is NOT being replaced — 023's table stays exactly as it
-- is, single-use, expiring, revocable, org-scoped. What changes is how a human obtains one.
--
-- THE FLOW (RFC 8628, the device authorization grant — how a television signs into a streaming
-- account). The agent asks for a pairing and shows the short code it gets back. The user types that
-- code into the console they are already signed into. The agent polls, and when the code has been
-- approved its poll returns a freshly minted `mae_` token.
--
-- WHY THE CODE GOES AGENT -> CONSOLE and not the reverse: the console is the authenticated side.
-- The code therefore carries exactly one claim — possession of the agent in front of you — and the
-- identity comes from the session. Minting in the console and pasting into the agent would put a
-- bearer credential back in a text field, which is the thing being removed.
--
-- NOTHING IS STORED THAT COULD BE STOLEN AND USED. The `mae_` token is minted at POLL time, not at
-- approval time, so no plaintext credential ever rests in this table waiting to be collected. Both
-- secrets are stored as hashes.

BEGIN;

CREATE TABLE agent_pairings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The short code a person reads off the agent's window and types into the console. Eight
  -- characters from a 32-character alphabet — 2^40 — displayed as XXXX-XXXX.
  --
  -- HASHED, even though it is short-lived and low-entropy. Lookup is exact-match, so hashing costs
  -- nothing and means a database dump does not hand over the live codes. Uniqueness is on the hash
  -- for the same reason: storing the plaintext to enforce it would defeat the point.
  user_code_hash text NOT NULL UNIQUE,

  -- The 32-byte secret returned ONLY in the response to POST /v1/pair, never displayed and never
  -- logged. It is what authenticates the poll, so it is a credential of the same weight as the
  -- `mae_` token the poll eventually returns — and it is stored the same way.
  device_code_hash text NOT NULL UNIQUE,

  -- What the machine says it is. Shown on the approval screen BEFORE the user confirms, because
  -- the one real weakness of this flow is somebody being talked into typing an attacker's code:
  -- naming the machine is what gives them a chance to notice. Self-reported and therefore
  -- untrusted — it is a description for a human, never an identifier.
  hostname       text,
  platform       text,
  agent_version  text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Short. A pending pairing is an unauthenticated row created by a stranger; ten minutes is longer
  -- than reading eight characters off a screen and far shorter than useful to anybody else.
  expires_at     timestamptz NOT NULL,

  -- Set when an authenticated admin approves it. `org_id` is the entire result of the approval:
  -- everything the agent is granted follows from it.
  approved_at    timestamptz,
  org_id         uuid REFERENCES orgs(id) ON DELETE CASCADE,
  approved_by    uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Set when the agent's poll collected its token. The row is kept rather than deleted so a support
  -- question — "did that laptop ever actually finish pairing?" — has an answer.
  collected_at   timestamptz,

  CONSTRAINT agent_pairings_approved_together
    CHECK ((approved_at IS NULL) = (org_id IS NULL)),
  -- Nothing can be collected before it is approved. A check rather than a comment, because the
  -- statement that collects is the one that mints a credential.
  CONSTRAINT agent_pairings_collected_after_approval
    CHECK (collected_at IS NULL OR approved_at IS NOT NULL)
);

-- Pending rows are swept on creation, so the sweep needs this. Partial, because a collected row is
-- history and never needs finding by time again.
CREATE INDEX agent_pairings_expiry_idx ON agent_pairings(expires_at)
  WHERE collected_at IS NULL;

-- "Which machines did my org pair, and when" — the only query the console makes against history.
CREATE INDEX agent_pairings_org_idx ON agent_pairings(org_id, approved_at DESC)
  WHERE org_id IS NOT NULL;

COMMENT ON TABLE agent_pairings IS
  'Pending and completed device-authorization pairings (ADR-0014). A row is created by an unauthenticated agent, approved by an authenticated admin, and collected once by the agent''s poll — which is when the mae_ enrollment token is minted. No usable credential is ever stored here.';

COMMENT ON COLUMN agent_pairings.hostname IS
  'Self-reported by the agent and shown to the approver. Never trusted as an identifier — the host names itself again at registration, and hosts.hostname stays the key.';

-- ------------------------------------------------------------------------------------------ RLS
--
-- SYSTEM POOL ONLY, and unlike 023 there is not even a SELECT policy for tenants.
--
-- The reason is structural rather than cautious: a pending pairing HAS NO ORG. It is created by a
-- caller with no principal at all, and the approval is what first attaches it to one — so there is
-- no `current_org()` to scope a policy by at the moment the console needs to read it. A policy
-- would have to be written for a principal that does not exist yet, which is a policy that says
-- nothing. Every path through this table goes through the system pool with its checks written out
-- explicitly in `pairing.ts`.
ALTER TABLE agent_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_pairings FORCE  ROW LEVEL SECURITY;

-- 001's ALTER DEFAULT PRIVILEGES grants mfarm_app the full set on every table the owner creates, so
-- this one arrived with SELECT/INSERT/UPDATE/DELETE already attached. Same trap as 014 and 023.
REVOKE SELECT, INSERT, UPDATE, DELETE ON agent_pairings FROM mfarm_app;

COMMIT;
