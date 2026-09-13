-- 057: a share can carry the device log and the recording, when whoever made it says so.
--
-- ---------------------------------------------------------------- what changed
--
-- Migration 051 and ADR-0036 kept both out of every share: the logcat because it is the one artifact
-- nobody curated, the recording because it covers the whole session. On 2026-09-14 the product owner
-- decided a share should be able to carry both, and that the console's share dialog offers them
-- CHECKED BY DEFAULT. ADR-0040 records that decision and the risk it accepts -- an unreviewed log can
-- carry tokens, and a recording shows every other test that ran on the device.
--
-- ---------------------------------------------------------------- why the columns default to false
--
-- THE DATABASE AND THE API DEFAULT TO NOT INCLUDING. The console's default-on is a choice made in
-- front of a person, with the two checkboxes in view; an API caller -- a CI job minting a link the
-- moment a test goes red -- sees no checkbox, so its default stays what it was. It also means every
-- link that already exists keeps exactly the disclosure it had when it was made: a link somebody
-- pasted on Friday must not start serving a device log on Monday because a migration ran.
--
-- ---------------------------------------------------------------- constraints
--
-- None to rewrite. Architecture rule 8 says a CHECK is rewritten from the LIVE constraint, and the
-- live `result_shares` carries no CHECK at all -- read from `\d result_shares` on 2026-09-14, not
-- from 051. Two booleans need none.
BEGIN;

ALTER TABLE result_shares
  ADD COLUMN include_recording boolean NOT NULL DEFAULT false,
  ADD COLUMN include_logcat    boolean NOT NULL DEFAULT false;

COMMENT ON TABLE result_shares IS
  'A link that shows ONE test result to somebody with no account here. Scoped to a single '
  'test_result, revocable and expiring. The device log and the session recording are carried only '
  'when include_logcat / include_recording say so -- see migration 057 and ADR-0040.';
COMMENT ON COLUMN result_shares.include_logcat IS
  'Whether the link serves the logcat of the session that produced the result. Nobody curated a '
  'device log, so it can carry tokens; chosen per link by whoever made it (ADR-0040).';
COMMENT ON COLUMN result_shares.include_recording IS
  'Whether the link serves the session recording. It covers the WHOLE session, so on a multi-test '
  'session it shows every other test too; chosen per link by whoever made it (ADR-0040).';

COMMIT;
