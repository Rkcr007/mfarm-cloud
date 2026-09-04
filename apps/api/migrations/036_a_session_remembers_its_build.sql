-- 036: a run forgets which build it tested, and only when the client behaves correctly.
--
-- FOUND BY RUNNING A REAL SUITE, 2026-09-04. `examples/medishop-suite` passed 8/8 against the farm
-- and `GET /v1/runs` reported:
--
--     "build": null, "buildCount": 0
--
-- for a run whose every session had installed `com.way2automation.medishop@1.0`. Both installs are
-- still there in `app_actions`, `DONE`, naming the build.
--
-- ---------------------------------------------------------------- the row that held the answer
--
-- Migration 020 put `app_build_id` on `webdriver_sessions`, and said why: "which sessions ran this
-- build" has to be an indexed foreign key rather than a cast inside a predicate. That reasoning was
-- right. The table was wrong.
--
-- `webdriver_sessions` is the LIVE PROXY MAPPING — upstream session id, upstream base url,
-- `last_command_at`. It exists while the hub is forwarding commands, and `DELETE /wd/hub/session/:id`
-- deletes the row on `driver.quit()`, correctly: the upstream session is gone and nothing should
-- keep claiming otherwise. So the only record of which build a run tested was deleted **by the
-- client doing the right thing**, and `routes/runs.ts` — which reads the build through
-- `LEFT JOIN webdriver_sessions` — has been answering `null` for every well-behaved suite ever run.
--
-- It survived only for sessions that LEAKED. In this database, the two rows that ever reported a
-- build are the two `webdriver_sessions` rows whose sessions never quit. That inversion is the
-- clearest statement of the bug: the feature worked exactly when the client did not.
--
-- **"What failed on build 4471?" is the question migration 020 and `EXECUTION_MODEL.md` §4.2/§4.3
-- exist to answer**, and it has never had an answer for a suite that finished properly.
--
-- ---------------------------------------------------------------- so it moves to the session
--
-- `sessions` is where a durable fact about an execution belongs: the row outlives the WebDriver
-- session, outlives the lease, and is what `runs` already aggregates over. The build a session ran
-- is a property of the session, not of the proxy mapping that happened to carry its commands.
--
-- `webdriver_sessions.app_build_id` IS KEPT AND STILL WRITTEN. Dropping it would break a rollback —
-- the previous release's INSERT names the column (rollback.test.ts's rule) — and it costs one uuid
-- on a row that is deleted minutes later. The new column is what the run queries read.
--
-- ONE WRITER, and it is the hub at session creation: `mfarm:appId` is a hub capability, resolved
-- before Appium is called, and that is the moment the fact is known. An install a tenant requests
-- MID-SESSION through `POST /v1/sessions/:id/app-actions` deliberately does NOT retroactively claim
-- to be the session's build — a session that installed three things did not "run" the third one,
-- and a column that quietly changed meaning depending on how the app arrived would be worse than
-- one that is honest about covering the hub's path.

BEGIN;

ALTER TABLE sessions ADD COLUMN app_build_id uuid REFERENCES app_builds(id) ON DELETE SET NULL;

COMMENT ON COLUMN sessions.app_build_id IS
  'The library build this session was opened against (mfarm:appId), resolved by the hub before '
  'Appium was called. Durable, unlike webdriver_sessions.app_build_id, which is deleted on quit. '
  'NULL for a session that named no build, or one whose app arrived some other way.';

-- "Which sessions ran this build" — the §4.2 question, as an index rather than a scan.
CREATE INDEX sessions_build_idx ON sessions(app_build_id) WHERE app_build_id IS NOT NULL;

-- ---------------------------------------------------------------- what can be recovered
--
-- BEST-EFFORT, AND SAID SO. The authoritative record was deleted at quit, so this reconstructs it
-- from `app_actions`, which keeps `session_id`, `app_id` and the outcome for every install ever
-- performed. The EARLIEST successful install per session is taken, because the hub queues its
-- install before the session opens and anything a tenant asked for afterwards came later by
-- definition — the same rule the live writer follows, applied backwards.
--
-- Where a session installed nothing, or only failed, this leaves NULL, which is the truth.
UPDATE sessions s
   SET app_build_id = first_install.app_id
  FROM (
    SELECT DISTINCT ON (i.session_id) i.session_id, i.app_id
      FROM app_actions i
     WHERE i.kind = 'install' AND i.state = 'DONE' AND i.app_id IS NOT NULL
     ORDER BY i.session_id, i.requested_at
  ) AS first_install
 WHERE s.id = first_install.session_id
   AND s.app_build_id IS NULL;

COMMIT;
