-- 053: the fleet has operators, and it remembers what they did to it.
--
-- ---------------------------------------------------------------- the boundary this fixes
--
-- Every authorization decision in this product is made against `memberships.role`, which is scoped
-- to an ORG. That is right for the things a role was invented for -- handing out API keys, adding a
-- colleague, reading your own usage -- and it is wrong for the machines, because the machines are
-- not tenant data. `hosts.org_id IS NULL` for a shared host; `002_rls.sql` revokes the whole table
-- from `mfarm_app` for exactly that reason.
--
-- `routes/hosts.ts` has said so in prose since the day it shipped:
--
--     "A KNOWN LIMIT, named rather than designed around: on a farm with more than one tenant, the
--      cost of a SHARED host is operator information and not attributable to whoever asked. [...]
--      When an operator role exists, the cost block belongs behind it."
--
-- This is that role. It is deliberately NOT a fourth value in `memberships.role`: a membership is a
-- relationship between a person and ONE org, and operating the fleet is a relationship between a
-- person and the FARM. Modelling it as a membership role would mean the same human needs the grant
-- once per tenant they belong to, and that the grant silently disappears when somebody removes them
-- from an org for unrelated reasons.
--
-- ---------------------------------------------------------------- why it is a column and not a table
--
-- A `fleet_operators` table is the shape that looks more correct, and it buys nothing here. The
-- session lookup in `users.ts` already joins `users`; a column rides that join for free, while a
-- table adds a LEFT JOIN to the hottest query in the product to express a fact that is one boolean.
-- The provenance a join table would have carried -- who granted it and when -- is kept as columns
-- beside it, and the GRANT ITSELF is an auditable operation in `infra_operations` below.
--
-- NOT GRANTABLE THROUGH THE API, by anything, in either direction. `src/bin/grant-operator.ts` is a
-- shell command, for the same reason `create-user.ts` is: an endpoint that can promote somebody to
-- fleet operator is an endpoint that is one authorization bug away from being the whole farm. An
-- operator with a shell is already the trust root.

BEGIN;

-- ---------------------------------------------------------------- the grant

ALTER TABLE users
  ADD COLUMN operator            boolean     NOT NULL DEFAULT false,
  ADD COLUMN operator_granted_at timestamptz,
  -- ON DELETE SET NULL rather than CASCADE: deleting the person who granted the capability must
  -- never delete the person who holds it.
  ADD COLUMN operator_granted_by uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN users.operator IS
  'Fleet-level operator. Orthogonal to memberships.role, which is per-org. Gates every /v1/infra read and every infrastructure operation. Set only by src/bin/grant-operator.ts.';

-- Small table, and the predicate is the whole point: "who can operate this farm" should be one
-- index scan and should stay answerable instantly however many users exist.
CREATE INDEX users_operator_idx ON users (id) WHERE operator;

-- ---------------------------------------------------------------- the log
--
-- WHAT MAKES THIS DIFFERENT FROM THE TWO LOGS THAT ALREADY EXIST. `session_commands` (041) records
-- what a TEST did to a device and is written by the WebDriver proxy at hundreds of rows a minute.
-- `app_actions` records what a session asked of an app. Neither can answer "who stopped the device
-- host on Tuesday", because until now nobody could stop it from inside the product at all.
--
-- Written on the SYSTEM pool, like everything else about hosts. There is no org scope on a row
-- here and there must not be one: a shared host has no tenant, and an audit trail that could only
-- be read by the org that happened to own the actor is an audit trail that hides cross-tenant
-- actions from the only people entitled to review them.

CREATE TABLE infra_operations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,

  -- WHO.
  --
  -- The user id AND the email, denormalised on purpose. `ON DELETE SET NULL` keeps the row when the
  -- account goes; the email keeps the row MEANINGFUL when it does. An audit trail that reads
  -- "someone stopped the production host" after an offboarding is not an audit trail. The org is
  -- kept for the same reason -- it is which tenant the actor was acting as, not who owns the target.
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email   text NOT NULL,
  actor_org_id  uuid REFERENCES orgs(id) ON DELETE SET NULL,

  -- WHAT. Open text with a length bound rather than an enum, because the set grows with every
  -- operation added and a CHECK here would make each addition a migration. The API validates
  -- against its own allow-list before it ever reaches this table -- that is where the real gate is,
  -- and a second copy of the list would be the second authorization check that eventually
  -- contradicts the first (052's lesson, same words).
  action        text NOT NULL CHECK (length(action) BETWEEN 1 AND 64),

  -- AGAINST WHAT. `target_id` is text and not a uuid because not every target is a row: a host is,
  -- a service on that host is a name.
  target_kind   text NOT NULL CHECK (target_kind IN ('host', 'service', 'fleet')),
  target_id     text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  -- What the operator SAW when they pressed it. A hostname can be reused and a host row can be
  -- deleted; the label is what makes the row legible a year later without a join that may not
  -- resolve.
  target_label  text NOT NULL,

  -- Arguments, as validated. Never credentials: nothing that reaches this table has any.
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- HOW IT WENT.
  --
  --   accepted  -- authorized and dispatched; the outcome is not known yet. Every row starts here.
  --   succeeded -- the provider or the agent confirmed it.
  --   failed    -- it was refused or it errored, and `detail` says why.
  --   noop      -- it was already in the requested state. Starting a running VM is not a failure
  --                and must never be recorded as one, or the log stops being usable for "did
  --                anything actually change".
  --   unknown   -- we asked, and we never found out. A timeout, a provider that stopped answering,
  --                an agent that went away mid-operation. THIS IS NOT A FAILURE AND IS NOT ALLOWED
  --                TO DECAY INTO ONE: reporting "failed" for an operation that may well have
  --                succeeded is how somebody presses Stop a second time on a VM that already
  --                stopped, or worse, presses Start believing nothing happened.
  result        text NOT NULL DEFAULT 'accepted'
                CHECK (result IN ('accepted', 'succeeded', 'failed', 'noop', 'unknown')),
  -- Prose for a human, in the same voice as `errors.ts`: what happened and what to do.
  detail        text,

  -- Which request, for correlating with the API log, and where it came from. `inet` rather than
  -- text so that "everything from this subnet" is a query and not a LIKE.
  request_id    text,
  client_ip     inet
);

-- The six filters the operations history offers, and nothing speculative. Date is the default
-- ordering and every other filter narrows within it, so it leads the composite.
CREATE INDEX infra_operations_recent_idx ON infra_operations (requested_at DESC);
CREATE INDEX infra_operations_actor_idx  ON infra_operations (actor_user_id, requested_at DESC);
CREATE INDEX infra_operations_target_idx ON infra_operations (target_kind, target_id, requested_at DESC);
CREATE INDEX infra_operations_action_idx ON infra_operations (action, requested_at DESC);
-- Partial: "show me what went wrong" is the query somebody runs during an incident, and it must not
-- degrade into a scan of every successful operation ever performed.
CREATE INDEX infra_operations_bad_idx    ON infra_operations (requested_at DESC)
  WHERE result IN ('failed', 'unknown');

COMMENT ON TABLE infra_operations IS
  'Append-only audit of every infrastructure operation. One row per attempt, written before the operation is dispatched and updated exactly once with its outcome.';

-- ---------------------------------------------------------------- append-only, ENFORCED
--
-- The API writes this on the system pool, which is the OWNER. An owner can UPDATE and DELETE
-- whatever it likes, so a GRANT-based rule here would be decoration -- the exact "check that cannot
-- come out both ways" this repo has shipped before.
--
-- A trigger is not decoration. It applies to the owner, and the only ways past it are `ALTER TABLE
-- ... DISABLE TRIGGER` and setting `session_replication_role`, both of which are deliberate acts by
-- somebody with a psql prompt rather than something a bug in a route can do by accident.
--
-- THE ONE UPDATE THE LOG NEEDS is the outcome landing on a row that was written as `accepted`, and
-- it is allowed exactly once and only forwards. Anything else -- rewriting who did it, what it was
-- against, or a result that has already settled -- raises.
CREATE FUNCTION infra_operations_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'infra_operations is append-only: rows are never deleted (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.result <> 'accepted' THEN
    RAISE EXCEPTION 'infra_operations row % already settled as %; an outcome is written once',
      OLD.id, OLD.result USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.result = 'accepted' THEN
    RAISE EXCEPTION 'infra_operations row % may only be updated to a settled result', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Everything that identifies the operation is frozen at insert. Only the outcome may move.
  IF (NEW.id, NEW.requested_at, NEW.actor_user_id, NEW.actor_email, NEW.actor_org_id,
      NEW.action, NEW.target_kind, NEW.target_id, NEW.target_label, NEW.params,
      NEW.request_id, NEW.client_ip)
     IS DISTINCT FROM
     (OLD.id, OLD.requested_at, OLD.actor_user_id, OLD.actor_email, OLD.actor_org_id,
      OLD.action, OLD.target_kind, OLD.target_id, OLD.target_label, OLD.params,
      OLD.request_id, OLD.client_ip)
  THEN
    RAISE EXCEPTION 'infra_operations row % is immutable apart from its outcome', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER infra_operations_append_only
  BEFORE UPDATE OR DELETE ON infra_operations
  FOR EACH ROW EXECUTE FUNCTION infra_operations_append_only();

-- `mfarm_app` never touches this table -- infrastructure runs on the system pool, like every other
-- fleet operation since 002. Stated as a REVOKE rather than left to the default so that a later
-- `GRANT ... ON ALL TABLES` cannot quietly hand it over.
REVOKE ALL ON infra_operations FROM PUBLIC, mfarm_app;

-- ---------------------------------------------------------------- the way back from a drain
--
-- `quarantine_host(uuid, text, 'operator')` from 016 is ALREADY drain-and-maintenance-mode, exactly:
-- it withdraws READY, OFFLINE, BOOTING and CLEANING devices from allocation, deliberately leaves
-- RESERVED and SESSION_ACTIVE alone so a tenant mid-session is not evicted, and remembers each
-- device's previous state in `quarantined_from`. It has never had an HTTP route.
--
-- What it has never had is an INVERSE. `clear_silence_quarantine` refuses anything not sourced
-- 'reaper', and that refusal is correct and load-bearing -- it is what stops a heartbeat from
-- arguing with a human's judgement. So there is currently no way at all to end an operator
-- quarantine except UPDATE by hand, which is precisely the manual VM interaction this work exists
-- to remove.
--
-- SYMMETRICAL REFUSAL, for the same reason as its counterpart: this clears ONLY an operator
-- quarantine. A host the reaper put away is silent, and a human declaring it healthy does not make
-- packets arrive -- the next beat does that, through the path that already exists.
CREATE FUNCTION release_host_quarantine(p_host uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE hosts
     SET state = 'UP', quarantined_at = NULL, quarantine_reason = NULL, quarantine_source = NULL
   WHERE id = p_host AND state = 'QUARANTINED' AND quarantine_source = 'operator';
  -- -1, not 0, and the caller must tell the two apart. 0 devices restored is a real outcome (a host
  -- that was drained while every device was already in a tenant's hands); "there was nothing to
  -- release" is a different answer and the console says something different about it.
  IF NOT FOUND THEN RETURN -1; END IF;

  -- Only what THIS function's counterpart withdrew. A device quarantined in its own right -- by a
  -- health check or by an operator, through `quarantine_device` -- has `quarantined_from` NULL and
  -- stays exactly where it is. Un-draining a host must not launder a sick device back into the
  -- pool, which is the same trap migration 016's own comment describes from the other direction.
  UPDATE devices
     SET state = quarantined_from, quarantined_from = NULL, updated_at = now()
   WHERE host_id = p_host AND state = 'QUARANTINED' AND quarantined_from IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- 012's ownership rule: owned by `mfarm_definer`, which is not a superuser, and unreachable from the
-- app pool. Postgres grants EXECUTE to PUBLIC by default and says nothing about it.
ALTER FUNCTION release_host_quarantine(uuid) OWNER TO mfarm_definer;
REVOKE EXECUTE ON FUNCTION release_host_quarantine(uuid) FROM PUBLIC, mfarm_app;

COMMIT;
