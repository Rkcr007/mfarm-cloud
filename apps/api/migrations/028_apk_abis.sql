-- 028: a build records which ABIs it ships native code for — the other half of ADR-0016's preflight.
--
-- 027 gave a device its executable ABIs. This gives a build its required ones, and the two together
-- are what let an install be refused with the real reason instead of dying inside `adb install`.
--
-- WHY IT IS A SEPARATE MIGRATION FROM 027: 027 had already been applied. A migration that has run
-- anywhere is immutable — editing it changes nothing on any database that recorded it, and leaves
-- the file disagreeing with the schema it supposedly produced.
--
-- STORED RATHER THAN RE-PARSED, for the same reason `min_sdk` and `label` are: the check runs when
-- an install is REQUESTED, and re-opening the blob to walk a zip at that moment turns a single
-- indexed read into file IO on the API host, on a path a tenant can call in a loop. The bytes are
-- content-addressed by sha256, so the value can never drift from the file it describes.
--
-- NULL means "uploaded before this column existed", and it is NOT the same as `'[]'`. `[]` is a
-- positive finding — this build contains no native code and therefore runs anywhere — while NULL
-- means nobody looked. Both allow the install; they differ in what a future backfill should touch.

ALTER TABLE app_builds ADD COLUMN IF NOT EXISTS abis jsonb;

COMMENT ON COLUMN app_builds.abis IS
  'ABIs the APK ships native libraries for. [] means no native code (runs anywhere); NULL means not parsed.';
