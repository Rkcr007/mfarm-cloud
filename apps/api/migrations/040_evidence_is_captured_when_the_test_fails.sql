-- 040: evidence is captured when the test fails, not when the device is handed back.
--
-- ---------------------------------------------------------------- what is wrong today
--
-- `captureArtifacts()` in the agent runs when a device enters CLEANING — that is, at teardown,
-- after Appium's `deleteSession()` has force-stopped the app under test. Two consequences, and
-- both are what a person meets on the worst day they have with this product:
--
--   THE SCREENSHOT SHOWS THE LAUNCHER. Migration 022 already wrote this down and added a
--   `screenshot` verb so a suite could take its own — which works, and which every customer would
--   then have to reinvent. `examples/medishop-suite` reinvented it first.
--
--   THE LOGCAT IS THE WHOLE SESSION, with no marker for when the failure happened. Production
--   artifacts average 2.55 MB of it. That is a haystack shipped in place of a needle, and there is
--   no on-demand verb for logcat at all — teardown is the only way to get one.
--
-- ---------------------------------------------------------------- what this changes
--
-- The control plane already learns that a test failed, DURING the session, the moment the suite
-- POSTs its result (migration 021). It has never done anything with that. It does now: a failed
-- result requests a capture, and the capture rides the pipeline migration 015 generalised and 022
-- proved.
--
-- NO NEW DELIVERY MECHANISM, deliberately. The control plane cannot dial a worker (ADR-0006), so
-- anything it wants done is offered on the beat, host-scoped, fence-checked at delivery and swept
-- if it is orphaned. That pipeline exists and this is its second consumer.
--
-- ---------------------------------------------------------------- the honest limit
--
-- The beat is ten seconds, so a failure-triggered capture lands up to ten seconds after the
-- assertion — by which time a suite may have navigated on. This is worth having anyway: ten seconds
-- late beats after-force-stop, which is what it replaces. It is also why `context` exists below.
-- An artifact that says WHICH failure it was taken for can be read correctly even when it is late;
-- one that does not is a mystery PNG in a list of them.

BEGIN;

-- ---------------------------------------------------------------- a logcat is a verb now

-- 022 converted this from an enum to text + CHECK precisely so that adding a verb would be one
-- migration rather than two. This is the payoff.
ALTER TABLE app_actions DROP CONSTRAINT app_actions_kind_check;
ALTER TABLE app_actions ADD  CONSTRAINT app_actions_kind_check
  CHECK (kind IN ('install', 'launch', 'uninstall', 'screenshot', 'logcat'));

-- `logcat` names no app either, for the same reason `screenshot` does not: it is a dump of what the
-- device has been saying, not an operation on a build. The constraint carries the real rule, so it
-- has to learn the second verb that is exempt from it — otherwise a logcat action is refused by a
-- CHECK whose message names `app_id` and explains nothing.
ALTER TABLE app_actions DROP CONSTRAINT app_actions_app_required;
ALTER TABLE app_actions ADD  CONSTRAINT app_actions_app_required
  CHECK (kind IN ('screenshot', 'logcat') OR app_id IS NOT NULL);

-- ---------------------------------------------------------------- why an action was requested

-- WHAT THIS IS FOR. A session that fails six tests produces six captures, and without this they are
-- six unlabelled files with adjacent timestamps. With it, each one names the `test_results` row
-- that triggered it, and the run screen can put the evidence next to the failure it belongs to
-- rather than next to the session it happened in.
--
-- jsonb rather than a `test_result_id` column, for 030's reason: most kinds carry nothing here, and
-- a table of mostly-NULL columns is one nobody can read. A console capture carries
-- `{"source": "console"}`; a failure capture carries `{"source": "test-failure", "testResultId": ...}`.
--
-- NOT A FOREIGN KEY. A `test_results` row deleted by retention must not take the artifact of the
-- failure with it, and an FK here would either cascade (losing evidence) or block (making retention
-- fail). The id is a pointer for a screen to follow and a dangling one renders as "the test this
-- was taken for is no longer on record", which is true and fine.
ALTER TABLE app_actions ADD COLUMN context jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The same field on the artifact itself, because that is where a reader meets it. The worker copies
-- the action's context onto what it uploads; a release-time capture has no context and says so with
-- an empty object rather than a NULL that would have to be handled separately at every call site.
ALTER TABLE artifacts ADD COLUMN context jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The run screen's query: "the evidence for this failure". A partial index, because the
-- overwhelming majority of artifacts are release-time captures with an empty context and indexing
-- those buys nothing.
CREATE INDEX artifacts_context_result_idx ON artifacts((context->>'testResultId'))
  WHERE context ? 'testResultId';

-- ---------------------------------------------------------------- requesting a capture, safely
--
-- WHY A FUNCTION AND NOT AN INSERT AT THE CALL SITE. Three rules have to hold together and each one
-- is a way this feature could make things worse rather than better:
--
--   1. COALESCE. Fifty failing tests must not queue fifty screenshots. One PENDING capture of a
--      kind per session is the bound — the next failure reuses the one already on its way, which is
--      the right answer anyway on a ten-second beat.
--
--   2. THE DEVICE MUST DECLARE THE CAPABILITY. An action a device can never perform sits PENDING,
--      is re-offered on every beat, and is eventually swept into a FAILED row that says the farm
--      broke. It did not; the tier simply has no capture path. Refusing here means silence instead
--      of a false alarm.
--
--   3. THE SESSION MUST STILL HOLD THE DEVICE AT THE FENCE IT WAS GIVEN. Straight from migration
--      014's rule: fence beats state, so a result that arrives late — after the device was
--      reallocated — cannot aim a capture at whoever holds it now.
--
-- Returns the action id, or NULL when any rule declines. NULL IS A NORMAL ANSWER, not an error: the
-- caller is a result POST, and a result must be recorded whether or not evidence could be taken.
CREATE OR REPLACE FUNCTION request_capture(
  p_org     uuid,
  p_session uuid,
  p_kind    text,
  p_context jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_device uuid; v_fence bigint; v_id uuid;
BEGIN
  IF p_kind NOT IN ('screenshot', 'logcat') THEN
    RAISE EXCEPTION 'request_capture is for evidence verbs, not %', p_kind;
  END IF;

  -- Rules 2 and 3 in one read. The org is in the predicate rather than trusted from the caller,
  -- which is architecture rule 4 and the reason metering was a billing forgery once.
  SELECT s.device_id, s.fence INTO v_device, v_fence
    FROM sessions s JOIN devices d ON d.id = s.device_id
   WHERE s.id = p_session
     AND s.org_id = p_org
     AND s.state IN ('ALLOCATING', 'ACTIVE')
     AND d.fence = s.fence
     AND d.capabilities ? p_kind;

  IF v_device IS NULL THEN RETURN NULL; END IF;

  -- Rule 1. Checked inside the same transaction as the insert, so two results arriving together
  -- cannot both find nothing pending and both queue one.
  PERFORM 1 FROM app_actions
   WHERE session_id = p_session AND kind = p_kind AND state = 'PENDING'
   FOR UPDATE;
  IF FOUND THEN RETURN NULL; END IF;

  INSERT INTO app_actions (org_id, app_id, session_id, device_id, fence, kind, context)
  VALUES (p_org, NULL, p_session, v_device, v_fence, p_kind, p_context)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- SECURITY DEFINER, so the same treatment every other one gets. REVOKE before the owner change
-- (012's ordering), and this one IS granted to `mfarm_app`: unlike `promote_queued`, it is called
-- from a request handler, and it is scoped to a single org by its own predicate rather than being
-- fleet-wide.
REVOKE EXECUTE ON FUNCTION request_capture(uuid,uuid,text,jsonb) FROM PUBLIC;
ALTER FUNCTION request_capture(uuid,uuid,text,jsonb) OWNER TO mfarm_definer;
GRANT EXECUTE ON FUNCTION request_capture(uuid,uuid,text,jsonb) TO mfarm_app;

-- `mfarm_definer` needs to be able to do what the function does. 001's ALTER DEFAULT PRIVILEGES
-- covers tables the owner creates, and these two predate the role.
GRANT SELECT                  ON sessions, devices TO mfarm_definer;
GRANT SELECT, INSERT, UPDATE  ON app_actions       TO mfarm_definer;

-- ---------------------------------------------------------------- the artifact carries it back
--
-- `artifact_record` gains the context the action was requested with. TEN ARGUMENTS NOW, and the
-- nine-argument form survives as a forwarder for 037's reason, restated because it is the same
-- trap: `deploy/mfarm-deploy.sh` applies migrations and THEN restarts the API, so there is a window
-- in which the OLD API calls the OLD signature against the NEW schema — and a rollback is that
-- window made permanent. Dropping the old form turns a rollback into a farm that cannot file
-- evidence, on the day somebody is already having a bad one.
CREATE OR REPLACE FUNCTION artifact_record(
  p_host         uuid,
  p_device       uuid,
  p_session      uuid,
  p_kind         text,
  p_sha256       text,
  p_size_bytes   bigint,
  p_content_type text,
  p_filename     text,
  p_ttl          interval,
  p_context      jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid;
  v_id  uuid;
BEGIN
  SELECT s.org_id INTO v_org
    FROM sessions s
    JOIN devices d ON d.id = s.device_id
   WHERE s.id = p_session
     AND s.device_id = p_device
     AND d.host_id = p_host;

  -- Unchanged from 019: no row means not yours, and which of the three reasons it was is not a
  -- worker's business — telling it would let one probe the rest of the fleet.
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO artifacts (org_id, session_id, device_id, kind, sha256, size_bytes,
                         content_type, filename, expires_at, context)
  VALUES (v_org, p_session, p_device, p_kind, p_sha256, p_size_bytes,
          p_content_type, p_filename, now() + p_ttl, COALESCE(p_context, '{}'::jsonb))
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- The nine-argument form becomes a thin forwarder. SECURITY INVOKER (the default): it adds no
-- definer surface of its own, and the function it calls carries the privilege exactly as before.
CREATE OR REPLACE FUNCTION artifact_record(
  p_host         uuid,
  p_device       uuid,
  p_session      uuid,
  p_kind         text,
  p_sha256       text,
  p_size_bytes   bigint,
  p_content_type text,
  p_filename     text,
  p_ttl          interval
) RETURNS uuid
LANGUAGE sql SET search_path = public AS $$
  SELECT artifact_record(p_host, p_device, p_session, p_kind, p_sha256, p_size_bytes,
                         p_content_type, p_filename, p_ttl, '{}'::jsonb);
$$;

-- The new signature is a new function, so it arrives owned by whoever ran the migration and
-- executable by PUBLIC. Revoke first, then own, then grant the one role that calls it — 012's
-- ordering, and the same one migration 039 got wrong in draft.
REVOKE ALL   ON FUNCTION artifact_record(uuid,uuid,uuid,text,text,bigint,text,text,interval,jsonb)
  FROM PUBLIC;
ALTER FUNCTION artifact_record(uuid,uuid,uuid,text,text,bigint,text,text,interval,jsonb)
  OWNER TO mfarm_definer;
GRANT EXECUTE ON FUNCTION artifact_record(uuid,uuid,uuid,text,text,bigint,text,text,interval,jsonb)
  TO mfarm_app;

-- The forwarder is not SECURITY DEFINER and grants no privilege of its own, but PUBLIC being able
-- to call it would reach the definer function behind it.
REVOKE ALL   ON FUNCTION artifact_record(uuid,uuid,uuid,text,text,bigint,text,text,interval)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION artifact_record(uuid,uuid,uuid,text,text,bigint,text,text,interval)
  TO mfarm_app;

COMMIT;
