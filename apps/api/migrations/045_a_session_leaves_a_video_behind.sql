-- 045 — video evidence for a virtual-device session (S5, docs/VIDEO_EVIDENCE.md)
--
-- WHAT UNBLOCKED THIS. `docs/EXECUTION_ROADMAP.md` S5 held video behind one measurement: what
-- recording costs the device being recorded. `deploy/measure-encode-cost.mjs` answered it for the
-- naive path — guest `screenrecord` takes a third of the Flutter canvas's frame rate — and
-- `deploy/measure-video-cost.mjs` answered it for the path this migration serves:
--
--   | arm                            |  fps | dropped |
--   |--------------------------------|-----:|--------:|
--   | A no recording                 | 29.9 |      84 |
--   | B screenrecord (guest)         | 20.0 |     137 |
--   | C record_cvd (host, 1 device)  | 29.8 |      83 |
--   | D record_cvd (host, 4 devices) | 29.9 |      85 |
--
-- Cuttlefish's own `RecordingManager` encodes on the HOST, off the same frame source that already
-- feeds the live view, so the guest does no work and the numbers say so. That is the whole reason
-- this is a schema change rather than a still-open question.
--
-- ---------------------------------------------------------------- what this adds, and what it does not
--
-- FOUR SMALL THINGS, and the shape of each was decided somewhere else in this schema:
--
--   * `artifacts.kind` learns 'video'. One line, because 019 wrote the constraint as a CHECK.
--   * `app_actions.kind` learns 'video-start'. One line, because 022 converted that column from an
--     enum to text + CHECK in anticipation of exactly this — 019's note said the next verb would be
--     cheap and it is the fourth time that has paid.
--   * `request_capture` accepts the new verb, mapping it to the CAPABILITY that actually gates it.
--   * `session_should_keep_video` — one function, so that "was this session worth keeping" has a
--     single definition rather than one per caller.
--
-- THERE IS NO 'video-stop' VERB, deliberately. Stopping is not a request that may or may not be
-- delivered: it must happen on every path a session can end, including the ones where nothing is
-- listening — a timeout, a crashed test process, a device fault, a reaper sweep. The worker already
-- has a hook that runs on all of them (`captureArtifacts` on the CLEANING transition), and the beat
-- already carries the reset request that triggers it. A stop verb would be a second mechanism that
-- works in the common case and fails in exactly the cases video exists for.
--
-- THE KEEP DECISION IS NOT STORED, either. It is derived from `test_results` at the moment the
-- reset is offered, because a stored flag would have to be written by something and every candidate
-- writer is a place it could be forgotten. The rule is one line of SQL and it lives below.

BEGIN;

-- ---------------------------------------------------------------- the artifact
--
-- Rewritten from the LIVE constraint (`pg_get_constraintdef`, read from the farm 2026-09-07), not
-- from the migration that created it. Architecture rule 8: those two have disagreed before, and a
-- CHECK rebuilt from a stale source silently drops whatever was added in between.
ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE artifacts ADD  CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('logcat', 'screenshot', 'video'));

-- ---------------------------------------------------------------- the verb
ALTER TABLE app_actions DROP CONSTRAINT app_actions_kind_check;
ALTER TABLE app_actions ADD  CONSTRAINT app_actions_kind_check
  CHECK (kind IN ('install', 'launch', 'uninstall', 'screenshot', 'logcat', 'video-start'));

-- Three verbs name no app now. Same rewrite-from-live rule as above.
ALTER TABLE app_actions DROP CONSTRAINT app_actions_app_required;
ALTER TABLE app_actions ADD  CONSTRAINT app_actions_app_required
  CHECK (kind IN ('screenshot', 'logcat', 'video-start') OR app_id IS NOT NULL);

-- ---------------------------------------------------------------- requesting the recording
--
-- 040's function, with one change and one addition.
--
-- THE VERB AND THE CAPABILITY ARE NO LONGER THE SAME WORD, and that is the only subtle thing here.
-- 040 could check `d.capabilities ? p_kind` because 'screenshot' and 'logcat' happen to be spelled
-- the same as the capabilities they need. 'video-start' needs `recording` — a capability that has
-- existed in the protocol since the beginning and was, until 2026-09-07, declared by a device that
-- could not do it. Mapping the verb to the capability keeps rule 2 doing what its comment says
-- rather than what its spelling implies: a device with no recorder is never handed a recording.
CREATE OR REPLACE FUNCTION request_capture(
  p_org     uuid,
  p_session uuid,
  p_kind    text,
  p_context jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_device uuid; v_fence bigint; v_id uuid; v_capability text;
BEGIN
  IF p_kind NOT IN ('screenshot', 'logcat', 'video-start') THEN
    RAISE EXCEPTION 'request_capture is for evidence verbs, not %', p_kind;
  END IF;

  v_capability := CASE p_kind WHEN 'video-start' THEN 'recording' ELSE p_kind END;

  -- Rules 2 and 3 in one read, unchanged from 040 except for the capability above. The org is in
  -- the predicate rather than trusted from the caller, which is architecture rule 4.
  SELECT s.device_id, s.fence INTO v_device, v_fence
    FROM sessions s JOIN devices d ON d.id = s.device_id
   WHERE s.id = p_session
     AND s.org_id = p_org
     AND s.state IN ('ALLOCATING', 'ACTIVE')
     AND d.fence = s.fence
     AND d.capabilities ? v_capability;

  IF v_device IS NULL THEN RETURN NULL; END IF;

  -- Rule 1, coalescing. It matters MORE for video than for the capture verbs it was written for:
  -- two 'video-start' actions delivered on one beat would have the worker start a recorder that is
  -- already running, and the second start is an error rather than a duplicate file.
  PERFORM 1 FROM app_actions
   WHERE session_id = p_session AND kind = p_kind AND state = 'PENDING'
   FOR UPDATE;
  IF FOUND THEN RETURN NULL; END IF;

  INSERT INTO app_actions (org_id, app_id, session_id, device_id, fence, kind, context)
  VALUES (p_org, NULL, p_session, v_device, v_fence, p_kind, p_context)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- ---------------------------------------------------------------- was this session worth keeping
--
-- RECORD EVERYTHING, KEEP ALMOST NOTHING. You cannot record a session retroactively, so the choice
-- is not "which sessions to record" but "which recordings to upload", and it is made after the fact
-- — here, at the moment the worker is told to reset the device.
--
-- The farm may not claim a test failed (ADR-0018): only the customer's suite knows, and it says so
-- through `POST /v1/sessions/:id/result` (021). So the rule is exactly "the suite reported at least
-- one failure", and a session that reported nothing keeps no video — the same refusal to infer that
-- makes an unreported run read "Not reported" rather than as a pass.
--
-- SECURITY INVOKER, deliberately. It reads two tables the caller can already read under its own
-- RLS, so a definer here would add privilege for nothing — and architecture rule 7 is that
-- `mfarm_definer` has BYPASSRLS, which has shipped a cross-tenant write before.
CREATE OR REPLACE FUNCTION session_should_keep_video(p_session uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM test_results t
     WHERE t.session_id = p_session
       AND t.status = 'failed'
  );
$$;

REVOKE EXECUTE ON FUNCTION session_should_keep_video(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION session_should_keep_video(uuid) TO mfarm_app;

COMMIT;
