-- 019: artifacts — the evidence a failed run leaves behind.
--
-- Closes the half of E2E_MVP_PLAN M3 that has a producer today. Logcat and screenshots already
-- exist (ADR-0007) and live ONLY in the browser tab that watched them: close the tab and the
-- evidence is gone, and a CI run has no tab at all. So a red run is currently unexplainable after
-- the fact, which is the single thing that makes a farm worth having over a laptop.
--
-- VIDEO IS DELIBERATELY ABSENT. `recording` was removed from the Cuttlefish capability list rather
-- than left as a claim with nothing behind it, and the same honesty applies to a storage enum: the
-- `kind` CHECK below lists exactly what something can produce today. Adding `video` later is one
-- line here plus a producer, and `text` + CHECK is used instead of an enum precisely so that line
-- can run inside a transaction — `ALTER TYPE ... ADD VALUE` cannot.
--
-- MinIO stays deferred, per the plan: the S3 API buys nothing on a single box and is one more
-- service to keep alive. Bytes go to the existing content-addressed `AppStore` under its own root,
-- which already solves dedupe, integrity and "a caller cannot name a file it did not upload".

BEGIN;

CREATE TABLE artifacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- DERIVED FROM THE SESSION at insert time, never accepted from the worker. Architecture rule 4:
  -- metering took the paying org from the worker's own request body and that was a billing forgery
  -- waiting to happen. The same reasoning applies to who owns a screenshot of a device.
  org_id       uuid NOT NULL REFERENCES orgs(id)     ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  device_id    uuid          REFERENCES devices(id)  ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('logcat', 'screenshot')),
  -- The blob's address in the store. NOT unique: two sessions that capture an identical screenshot
  -- share one file on disk and hold two rows, which is the point of content addressing.
  sha256       text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  content_type text NOT NULL,
  -- What to call it in a download. Cosmetic, and never used to build a path.
  filename     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Retention is not optional. A 500 GB disk and unbounded capture is an outage with a date on it.
  expires_at   timestamptz NOT NULL
);

-- The session detail screen's only query.
CREATE INDEX artifacts_session_idx ON artifacts(session_id, created_at DESC);
-- The reaper's sweep.
CREATE INDEX artifacts_expiry_idx  ON artifacts(expires_at);

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE  ROW LEVEL SECURITY;

CREATE POLICY artifacts_own_org ON artifacts
  USING (org_id = current_org())
  WITH CHECK (org_id = current_org());

-- ---------------------------------------------------------------- worker-facing insert

-- Upload is worker -> API, never API -> worker (ADR-0006: the control plane never dials a worker).
-- That makes this a WORKER-authenticated write, and migration 008 is the cautionary tale for what
-- those look like when the authorisation is left at the call site:
--
--   * the host id is in the SIGNATURE, so it cannot be forgotten by a caller;
--   * the device must belong to that host AND the session must be on that device, so a worker
--     cannot attach evidence to another host's session;
--   * `org_id` is SELECTed from the session rather than accepted, so a worker cannot file a
--     screenshot into another tenant's library.
--
-- Returns NULL rather than raising when the checks fail. The API turns that into a 409, and the
-- worker drops the artifact — a device that cannot ship its logcat is still a device that must
-- reset, and an exception here would make releasing it fail too.
CREATE FUNCTION artifact_record(
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

  -- No row means the session is not on that device, or that device is not on that host, or the
  -- session does not exist. All three are the same answer to the caller: not yours.
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO artifacts (org_id, session_id, device_id, kind, sha256, size_bytes,
                         content_type, filename, expires_at)
  VALUES (v_org, p_session, p_device, p_kind, p_sha256, p_size_bytes,
          p_content_type, p_filename, now() + p_ttl)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

ALTER FUNCTION artifact_record(uuid,uuid,uuid,text,text,bigint,text,text,interval)
  OWNER TO mfarm_definer;

-- Postgres grants EXECUTE to PUBLIC by default, so never having granted it is not the same as it
-- being unreachable. 012's lesson, re-applied: revoke first, then grant the one role that needs it.
REVOKE ALL ON FUNCTION artifact_record(uuid,uuid,uuid,text,text,bigint,text,text,interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION artifact_record(uuid,uuid,uuid,text,text,bigint,text,text,interval) TO mfarm_app;

-- The definer body reads sessions and devices and writes artifacts. Exactly those, no more.
GRANT SELECT ON sessions TO mfarm_definer;
GRANT SELECT ON devices  TO mfarm_definer;
GRANT SELECT, INSERT ON artifacts TO mfarm_definer;

-- ---------------------------------------------------------------- retention

-- Deletes expired rows and reports, per deleted row, whether its blob is now unreferenced.
--
-- ONE ROW OUT PER ROW DELETED, deliberately. An earlier shape returned only the orphaned digests,
-- which made "how many artifacts expired" unanswerable: content addressing means fifty rows can
-- share three files, so the caller would have logged 3 for a sweep that removed 50.
--
-- It cannot delete the files itself — they are on the API's disk, not in the database — so the
-- caller unlinks the ones flagged `blob_orphaned`. A row deleted without its blob is wasted disk;
-- a blob deleted while a row still points at it is a 404 for someone chasing a failure. Only the
-- first of those is recoverable, which is why the flag is computed here rather than guessed there.
CREATE FUNCTION expire_artifacts(p_limit integer DEFAULT 500)
RETURNS TABLE (sha256 text, blob_orphaned boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_shas text[];
BEGIN
  -- TWO STATEMENTS, AND IT HAS TO BE TWO.
  --
  -- The obvious single query is
  --     WITH gone AS (DELETE ... RETURNING sha256)
  --     SELECT g.sha256, NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.sha256 = g.sha256) FROM gone g
  -- and it is silently, permanently wrong: a data-modifying CTE's effects are NOT visible to the
  -- rest of the same query, which all runs against the snapshot taken when the query started. The
  -- NOT EXISTS therefore still sees the very rows being deleted, so `blob_orphaned` comes back
  -- FALSE for everything and no blob is ever unlinked. The store grows forever while the sweep
  -- reports success, which is exactly the shape of bug that gets found by a full disk.
  --
  -- Collecting into an array first ends that statement. The second one runs afterwards and sees the
  -- post-delete state, which is the question actually being asked.
  WITH gone AS (
    DELETE FROM artifacts
     WHERE id IN (SELECT id FROM artifacts WHERE expires_at < now() ORDER BY expires_at LIMIT p_limit)
     RETURNING artifacts.sha256
  )
  SELECT array_agg(gone.sha256) INTO v_shas FROM gone;

  -- One row out per row deleted, duplicates included: the caller counts these to report how many
  -- artifacts expired, and de-duplicating here would under-report a sweep of rows sharing a file.
  RETURN QUERY
  SELECT s, NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.sha256 = s)
    FROM unnest(COALESCE(v_shas, ARRAY[]::text[])) AS s;
END $$;

ALTER FUNCTION expire_artifacts(integer) OWNER TO mfarm_definer;
REVOKE ALL ON FUNCTION expire_artifacts(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_artifacts(integer) TO mfarm_app;
GRANT DELETE ON artifacts TO mfarm_definer;

COMMIT;
