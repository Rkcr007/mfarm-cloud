-- 046 — a tenant decides how long its evidence lives, and can delete it on demand
--
-- WHAT WAS MISSING. Retention was an OPERATOR's environment variable — `ARTIFACT_RETENTION_HOURS`
-- (14 days) and `VIDEO_RETENTION_HOURS` (3) — set on the box, applied to everybody, and invisible
-- from the console. A tenant could neither see when its logs would go nor remove one sooner. That
-- is the wrong owner for the decision twice over: it is the tenant's data, and it is the tenant who
-- knows whether a recording of their checkout flow should sit on a shared disk for a fortnight.
--
-- ---------------------------------------------------------------- what this adds
--
--   orgs.evidence_retention_days   how long THIS org's evidence lives. Default 3.
--   orgs.evidence_auto_delete      whether the sweep applies at all. Default TRUE.
--   delete_artifact(org, id)       remove one artifact, tenant-scoped.
--   delete_session_evidence(...)   remove everything one session left behind.
--   purge_session(org, session)    remove the session record itself.
--
-- DEFAULT ON, AND AT THREE DAYS. A farm that keeps everything forever is a farm that fills its disk
-- and takes the database with it; `docs/VIDEO_EVIDENCE.md` §5 does that arithmetic. Three days is
-- what a recording already got, and it is long enough that a red run noticed on Monday morning is
-- still explicable on Wednesday.
--
-- ---------------------------------------------------------------- what it deliberately does NOT do
--
-- **The auto-sweep never deletes SESSION RECORDS, only evidence.** Those two were asked for
-- together and they are not the same risk. Evidence is megabytes and its value decays in days; a
-- session row is a hundred bytes and it is what the Runs screen counts — auto-purging them would
-- silently erase the history somebody uses to tell a flake from a regression, and it would do it to
-- every org by default. `purge_session` exists for a deliberate, per-session, admin-gated press.
--
-- **Metering survives a purge, and that is not luck.** `metering_events.session_id` is
-- `ON DELETE SET NULL` (001), so billing keeps its rows and merely forgets which session they came
-- from. Had it been CASCADE this function could not be written at all — a tenant would be able to
-- delete its own invoice by deleting its sessions, which is architecture rule 4 read backwards.

BEGIN;

ALTER TABLE orgs
  ADD COLUMN evidence_retention_days integer NOT NULL DEFAULT 3
    CHECK (evidence_retention_days BETWEEN 1 AND 365),
  ADD COLUMN evidence_auto_delete    boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN orgs.evidence_retention_days IS
  'How long this org''s artifacts live. Applied at INSERT via artifact_record, so a change moves new evidence only.';
COMMENT ON COLUMN orgs.evidence_auto_delete IS
  'When false, artifacts are written with no expiry and only an explicit delete removes them.';

-- ---------------------------------------------------------------- retention is the ORG's, not the box's
--
-- `artifact_record` already derives the paying org from the session (040). It now derives the
-- EXPIRY from that same org rather than from the caller's argument, which is the same rule applied
-- to a second field: the worker uploading a logcat has no business saying how long it is kept.
--
-- The caller's `p_ttl` becomes a CEILING rather than the value. A farm operator who sets
-- ARTIFACT_MAX to seven days still bounds the disk; an org asking for ninety gets seven. Without
-- that, one tenant's setting could fill a shared disk on everybody else's behalf.
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
  v_org    uuid;
  v_id     uuid;
  v_days   integer;
  v_auto   boolean;
  v_expiry timestamptz;
BEGIN
  SELECT s.org_id, o.evidence_retention_days, o.evidence_auto_delete
    INTO v_org, v_days, v_auto
    FROM sessions s
    JOIN devices d ON d.id = s.device_id
    JOIN orgs    o ON o.id = s.org_id
   WHERE s.id = p_session
     AND s.device_id = p_device
     AND d.host_id = p_host;

  -- Unchanged from 019: no row means not yours, and which of the three reasons it was is not a
  -- worker's business — telling it would let one probe the rest of the fleet.
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;

  -- LEAST, so the operator's ceiling still bounds a shared disk. NULL expiry when the org has
  -- turned the sweep off — `expire_artifacts` already skips those rows, because it compares
  -- `expires_at < now()` and NULL is never less than anything.
  v_expiry := CASE
                WHEN NOT v_auto THEN NULL
                ELSE now() + LEAST(p_ttl, make_interval(days => v_days))
              END;

  INSERT INTO artifacts (org_id, session_id, device_id, kind, sha256, size_bytes,
                         content_type, filename, expires_at, context)
  VALUES (v_org, p_session, p_device, p_kind, p_sha256, p_size_bytes,
          p_content_type, p_filename, v_expiry, COALESCE(p_context, '{}'::jsonb))
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- `expires_at` has been NOT NULL since 019 and now has a legitimate absent case.
ALTER TABLE artifacts ALTER COLUMN expires_at DROP NOT NULL;

-- ---------------------------------------------------------------- deleting on demand
--
-- WHY FUNCTIONS RATHER THAN A DELETE AT THE CALL SITE. The blob is CONTENT-ADDRESSED and shared: two
-- sessions that captured identical bytes reference one file. Deleting a row must therefore report
-- whether any row still references that digest, and only the database can answer that in the same
-- transaction as the delete. 019's `expire_artifacts` already had this exact shape; these are the
-- on-demand door into it, and returning `blob_orphaned` is what lets the caller unlink the file
-- without ever risking unlinking one somebody else still points at.

CREATE OR REPLACE FUNCTION delete_artifact(p_org uuid, p_id uuid)
RETURNS TABLE (sha256 text, blob_orphaned boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sha text;
BEGIN
  DELETE FROM artifacts a WHERE a.id = p_id AND a.org_id = p_org RETURNING a.sha256 INTO v_sha;
  IF v_sha IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT v_sha, NOT EXISTS (SELECT 1 FROM artifacts x WHERE x.sha256 = v_sha);
END $$;

CREATE OR REPLACE FUNCTION delete_session_evidence(p_org uuid, p_session uuid)
RETURNS TABLE (sha256 text, blob_orphaned boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH gone AS (
    DELETE FROM artifacts a
     WHERE a.session_id = p_session AND a.org_id = p_org
   RETURNING a.sha256
  )
  -- DISTINCT because one session can hold two artifacts with identical bytes, and the caller
  -- unlinks per digest. Reporting the same file twice would make the second unlink look like a
  -- failure on a file that was already correctly gone.
  SELECT g.sha256, NOT EXISTS (SELECT 1 FROM artifacts x WHERE x.sha256 = g.sha256)
    FROM (SELECT DISTINCT gone.sha256 FROM gone) g;
END $$;

-- ---------------------------------------------------------------- purging the record itself
--
-- REFUSES A LIVE SESSION. A row in ALLOCATING or ACTIVE still holds a device, and deleting it would
-- strand that device with a fence nobody can match — the reaper would never release it, because the
-- session it is looking for no longer exists. The device leaves the fleet until a human notices.
CREATE OR REPLACE FUNCTION purge_session(p_org uuid, p_session uuid)
RETURNS TABLE (sha256 text, blob_orphaned boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_state text;
BEGIN
  SELECT s.state::text INTO v_state FROM sessions s WHERE s.id = p_session AND s.org_id = p_org;
  IF v_state IS NULL THEN RETURN; END IF;
  IF v_state IN ('QUEUED', 'ALLOCATING', 'ACTIVE', 'ENDING') THEN
    RAISE EXCEPTION 'session % is still % — release it before deleting it', p_session, v_state
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- Evidence first and in the same transaction, so the blobs are reported even though the CASCADE
  -- below would have removed the rows anyway. A cascade deletes rows; it cannot tell the caller
  -- which files on disk are now unreferenced, and a file nothing references is one nothing will
  -- ever clean up.
  RETURN QUERY SELECT * FROM delete_session_evidence(p_org, p_session);

  DELETE FROM sessions s WHERE s.id = p_session AND s.org_id = p_org;
END $$;

-- 012's ordering: revoke, own, grant. All three are called from a request handler and are scoped to
-- a single org by their own predicates.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'delete_artifact(uuid,uuid)',
    'delete_session_evidence(uuid,uuid)',
    'purge_session(uuid,uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('ALTER FUNCTION %s OWNER TO mfarm_definer', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO mfarm_app', fn);
  END LOOP;
END $$;

COMMIT;
