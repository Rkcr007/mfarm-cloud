-- 055: an operation still in flight can say where it got to.
--
-- ---------------------------------------------------------------- what 053 got right, and the gap
--
-- Migration 053 made `infra_operations` append-only with a trigger rather than with grants, and that
-- was the right call: the API writes as the table owner, and an owner can UPDATE and DELETE whatever
-- it likes, so a GRANT-based rule would have been a check that could not come out both ways.
--
-- The trigger permits exactly one UPDATE: an `accepted` row settling to one of the four outcomes.
-- That covers every operation that finishes inside its request, which was all of them when 053 was
-- written.
--
-- POWERING A MACHINE DOES NOT FINISH INSIDE ITS REQUEST. A GCE start reaches RUNNING in tens of
-- seconds and the devices cold boot for minutes after that; the control plane asks, watches for a
-- bounded window, and answers with what it saw. When the machine is still moving, the honest record
-- is a row that is STILL `accepted` and carries what was last observed -- "last seen STAGING after
-- 25s". The alternatives are both worse: settling it `succeeded` because the provider took the
-- request puts a result in the log that nobody verified, and leaving the detail NULL makes an
-- in-flight operation indistinguishable from one the process died in the middle of.
--
-- The trigger refused that write. It raised on `NEW.result = 'accepted'`, which is correct as a rule
-- about OUTCOMES and too strong as a rule about rows -- and because `settle()` swallows its errors
-- by design, the refusal was silent: the row stayed open with an empty detail and a line in the log.
--
-- ---------------------------------------------------------------- what changes, precisely
--
-- An unsettled row may have its `detail` rewritten while it stays unsettled. Nothing else moves:
-- every identifying column is still frozen, `finished_at` must still be NULL while the row is open,
-- a settled row is still settled forever, and a DELETE is still refused. The difference is one
-- branch, and it is the difference between "this is what it is doing" and silence.

BEGIN;

CREATE OR REPLACE FUNCTION infra_operations_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'infra_operations is append-only: rows are never deleted (id %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Everything that IDENTIFIES the operation is frozen at insert, on every path below. Checked
  -- first so that neither branch can forget it.
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

  -- A SETTLED ROW IS SETTLED FOREVER. Unchanged from 053, and the reason `unknown` is safe to
  -- record: it cannot later decay into a failure.
  IF OLD.result <> 'accepted' THEN
    RAISE EXCEPTION 'infra_operations row % already settled as %; an outcome is written once',
      OLD.id, OLD.result USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- THE NEW BRANCH: a progress note on a row that is still open.
  IF NEW.result = 'accepted' THEN
    -- An open row has not finished, and a `finished_at` on one would make every "how long did that
    -- take" query wrong in the direction of looking complete.
    IF NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'infra_operations row % is still accepted, so it cannot have finished', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- Otherwise this is the settle, which is what 053 allowed and still allows.
  RETURN NEW;
END $$;

COMMIT;
