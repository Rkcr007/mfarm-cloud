-- 047 — `delete_session_evidence` deleted the rows and freed nothing
--
-- THE BUG, and it is a property of Postgres rather than a typo. 046 wrote the function as ONE
-- statement:
--
--   WITH gone AS (DELETE FROM artifacts ... RETURNING sha256)
--   SELECT g.sha256, NOT EXISTS (SELECT 1 FROM artifacts x WHERE x.sha256 = g.sha256) ...
--
-- **A data-modifying CTE's effects are not visible to other parts of the same query.** Every
-- sub-statement sees the same snapshot, taken before the statement ran — so the `EXISTS` still
-- found the very rows the CTE was deleting, `blob_orphaned` came back FALSE for all of them, and
-- the caller unlinked nothing. Rows went; bytes stayed; nothing ever came back for them.
--
-- Caught on the farm rather than by the suite: `{"deleted":3,"blobsDeleted":0}` on a session whose
-- recording was 268 KB of bytes no other row referenced. The test asserted the row count and not
-- the blob count, so it agreed with the bug — the same shape as every other defect in DEFECTS.md
-- where a fixture confirmed what the code did instead of what it should do.
--
-- `delete_artifact` was never affected: it does the DELETE as its own statement with RETURNING INTO
-- and asks the question afterwards, so the second statement sees the first one's work. That is the
-- shape this now uses too.

BEGIN;

CREATE OR REPLACE FUNCTION delete_session_evidence(p_org uuid, p_session uuid)
RETURNS TABLE (sha256 text, blob_orphaned boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_shas text[];
BEGIN
  -- STATEMENT ONE: delete, and collect the digests. `array_agg ... INTO` completes the statement,
  -- which is the whole point — everything after this sees a snapshot in which the rows are gone.
  --
  -- DISTINCT because one session can hold two artifacts with identical bytes, and the caller
  -- unlinks per digest; reporting a digest twice makes the second unlink look like a failure on a
  -- file that was already correctly removed.
  WITH gone AS (
    DELETE FROM artifacts a
     WHERE a.session_id = p_session AND a.org_id = p_org
   RETURNING a.sha256
  )
  SELECT array_agg(DISTINCT g.sha256) INTO v_shas FROM gone g;

  IF v_shas IS NULL THEN RETURN; END IF;

  -- STATEMENT TWO: now ask which of those files nothing else points at. The store is
  -- content-addressed, so a digest another session still references must survive — deleting it
  -- would break that session's download silently, and only for whoever opened it next.
  RETURN QUERY
  SELECT s, NOT EXISTS (SELECT 1 FROM artifacts x WHERE x.sha256 = s)
    FROM unnest(v_shas) AS s;
END $$;

COMMIT;
