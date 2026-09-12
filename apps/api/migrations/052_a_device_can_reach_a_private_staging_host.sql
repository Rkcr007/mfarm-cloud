-- 052: a device can reach a host on the customer's own network.
--
-- ---------------------------------------------------------------- what is wrong today
--
-- An app under test almost never talks to production. It talks to `staging.acme.internal`, which
-- lives on the customer's network and has no route from this farm -- so the single most common
-- thing a team wants to test is the one thing the product cannot do. `docs/ltcomp/` lists it as the
-- last P1 gap and LambdaTest sells it as "Local Connection".
--
-- ---------------------------------------------------------------- what this table is, and is NOT
--
-- It is a REGISTER, not a route. The live socket lives in `CustomerTunnelRegistry`, in memory, in
-- the process holding it -- exactly like the agent tunnels, and for the same reason: a row cannot
-- carry bytes and a database that thought it could would be a database that lies during a network
-- partition. Nothing in the data path reads this table.
--
-- What it is for is the three questions a row can answer and a socket cannot:
--
--   WHICH TUNNELS EXIST, so the console can show one that is not currently connected rather than
--   forgetting it ever existed -- "my tunnel is down" and "I never had a tunnel" are different
--   problems with different fixes, and a registry that only knows live sockets cannot tell them
--   apart.
--
--   WHAT EACH ONE WAS ALLOWED TO REACH, so that "what could that tunnel get to last Tuesday" has an
--   answer. A tunnel is a hole in somebody's network; the shape of the hole is worth keeping.
--
--   WHO OPENED IT, for the reason every audit trail exists.
--
-- ---------------------------------------------------------------- where the allow-list is ENFORCED
--
-- IN THE CUSTOMER'S OWN CLIENT, never here. The control plane is a switch between two sockets: it
-- cannot know that `10.0.0.7` is a payroll database and `staging.acme.internal` is the thing under
-- test, and a rule it enforced would be a rule the customer had to take our word for. The client
-- runs inside their network, was started by them, and is the only party that can refuse from a
-- position of knowledge. `allow` here is a RECORD of what the client declared -- echoed back to it
-- on connect so the console and the person who started it cannot disagree -- and enforcing it a
-- second time here would be the second authorization check that eventually contradicts the first.

BEGIN;

CREATE TABLE tunnels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- The routing key a suite names in `mfarm:tunnel`. Lowercase-with-dashes, like an org slug and a
  -- region code, because this is a string a person types into a CI config by hand.
  name         text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),

  -- What the client declared it would reach, as [{host, port?}]. A RECORD of the client's own
  -- rules -- see the header. Never read on the data path.
  allow        jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Free text the client sent about itself, so a person can tell two machines apart in a list.
  -- Never a credential and never trusted: it is rendered as text and used for nothing else.
  client       text CHECK (client IS NULL OR length(client) <= 200),

  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- When a client last held this open. NULL means "declared, never connected", which is a real and
  -- common state: a person creates the tunnel in the console and then goes to start the client.
  last_seen_at timestamptz,
  -- Cumulative, and approximate in the same sense `result_shares.views` is. It answers "is anything
  -- actually using this" -- the question that makes deleting one a decision rather than a guess.
  requests     bigint NOT NULL DEFAULT 0
);

-- ONE NAME PER ORG, which is the whole reason a name is a routing key. Two tunnels called `staging`
-- in one org would make `mfarm:tunnel=staging` ambiguous, and the honest place to refuse that is
-- here rather than in whichever code path happens to look second.
CREATE UNIQUE INDEX tunnels_org_name_idx ON tunnels(org_id, lower(name));

ALTER TABLE tunnels ENABLE ROW LEVEL SECURITY;
ALTER TABLE tunnels FORCE  ROW LEVEL SECURITY;
CREATE POLICY tunnels_own_org ON tunnels
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON tunnels TO mfarm_app;

COMMENT ON TABLE tunnels IS
  'A named route from a device on this farm to a host on the customer''s own network. A REGISTER, '
  'not a route: the live socket is in memory in the process holding it. Nothing on the data path '
  'reads this table -- see the migration for why the allow-list is enforced in the client.';
COMMENT ON COLUMN tunnels.allow IS
  'What the client DECLARED it would reach. A record, not a rule: enforcement is in the customer''s '
  'own client, which is the only party that can refuse from a position of knowledge.';

COMMIT;
