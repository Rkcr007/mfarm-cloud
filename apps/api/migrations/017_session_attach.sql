-- 017: a session a person opened in a browser can reach ACTIVE.
--
-- Found while building the live view (ADR-0007), on the bring-up screen's "Device ready" step: it
-- never completed, because nothing ever completed it.
--
-- `session_activate` has existed since migration 005 and has exactly ONE caller — the WebDriver hub
-- (`routes/webdriver.ts`). So a session allocated by an Appium client goes ALLOCATING -> ACTIVE, and
-- a session allocated from the console stays ALLOCATING for its entire life. The consequences were
-- all quiet:
--
--   * `sessions.started_at` stays NULL, so every duration and every lease bar in the console is
--     measured from `created_at` instead — the allocation, not the attach.
--   * the device stays RESERVED rather than SESSION_ACTIVE, so "in use" never shows on the fleet.
--   * ACTIVE means "a client is attached", and the console's whole product story is a person
--     attaching from a browser. The one path that mattered most could not express it.
--
-- WHY THE WORKER REPORTS IT, and not the console. The fact being recorded is "a client attached to
-- the data plane", and the data plane is the only party that observes it — offline, from a signed
-- grant, without asking the control plane anything. A console-side `POST /sessions/:id/activate`
-- would be the browser asserting a state transition about a socket the API cannot see, and it would
-- leave every non-browser data-plane client (the CLI, a suite, a future viewer) still unable to
-- activate. This rides the existing worker->control-plane events channel, which is the direction
-- ADR-0004 allows.
--
-- HOST-SCOPED, per architecture rule 4 (migrations 005 and 008). A worker names a session; without
-- the join below any registered worker could activate any other host's session. And the org is
-- DERIVED from the session rather than accepted from the caller, for the same reason
-- `record_metering` derives it: a worker that can name the paying org can bill any org.

BEGIN;

CREATE FUNCTION session_attach(p_host uuid, p_session uuid, p_fence bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_dev uuid;
BEGIN
  UPDATE sessions s
     SET state = 'ACTIVE', started_at = now()
    FROM devices d
   WHERE d.id = s.device_id
     AND d.host_id = p_host                    -- the authorisation, and the whole point
     AND s.id = p_session
     AND s.state = 'ALLOCATING'
     AND s.fence = p_fence                     -- not a defence on its own; see migration 008
  RETURNING s.device_id INTO v_dev;

  -- Already ACTIVE is the normal case on a reconnect, not an error: a viewer that drops and comes
  -- back sends hello again, and the worker reports the attach again. Answering false is truthful
  -- ("nothing changed") and the caller treats it as such.
  IF v_dev IS NULL THEN RETURN false; END IF;

  UPDATE devices SET state = 'SESSION_ACTIVE', updated_at = now()
   WHERE id = v_dev AND fence = p_fence;
  RETURN true;
END $$;

-- The two things migration 012 had to retrofit onto every definer function that came before it, so
-- this one is born with them:
--
--   * NOT owned by the superuser. A definer function executes as its owner, and one owned by the
--     cluster superuser turns any future bug in it into superuser execution.
--   * NOT EXECUTE-able by PUBLIC. Postgres grants that by default, so never having granted it is
--     not the same as it being unreachable from the app pool (architecture rule 4, second half).
--     CI asserts both; a new definer function that skips this fails the build.
ALTER FUNCTION session_attach(uuid,uuid,bigint) OWNER TO mfarm_definer;
REVOKE ALL ON FUNCTION session_attach(uuid,uuid,bigint) FROM PUBLIC;

COMMIT;
