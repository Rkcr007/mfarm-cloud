-- 027: a device says what it is shaped like, and what it can execute — ADR-0016.
--
-- WHAT THIS IS FOR. Two of the farm's virtual devices are now configured to reproduce a real
-- handset: panel geometry, density, RAM, and the build properties the guest reports about itself.
-- The console draws them as recognisable phones rather than as a rectangle with an aspect ratio
-- guessed at 16:9. To do that it needs three facts registration never carried.
--
-- WHY `screen` HAS TO LIVE HERE AT ALL. It already existed on the worker, and it already reached the
-- browser — but ONLY over the live data-plane socket, in the grant message, once a session was
-- open. So every device card, every picker row and every bring-up screen fell back to 16:9, which
-- is not the shape of any phone made in the last decade. The geometry was known and simply had
-- nowhere to be read from until a tenant had already allocated the device.
--
-- WHY `profile` IS SEPARATE FROM `model`. A profiled device reports `model = 'Samsung Galaxy S25
-- Ultra'`, which is a CONFIGURED CLAIM rather than something read off hardware — the deliberate
-- exception ADR-0016 makes to ADR-0003's rule that a claim is observed state. `profile` is what
-- tells the console the difference, and it is what the console keys its device chrome off. Matching
-- the chrome on the model string instead would break the first time a marketing name is retyped,
-- and would leave nothing at all distinguishing a configured name from a discovered one.
--
-- WHY `abis` SHIPS IN THE SAME MIGRATION. It is the counterweight, and it belongs with the thing it
-- balances. A device that answers `Build.MODEL` with a Samsung part number invites a tester to
-- assume it runs what their phone runs; it does not, because Cuttlefish here is x86_64 and every
-- real Galaxy is arm64-v8a. Most real APKs carry arm64-only native libraries. Without this column
-- the first such upload fails somewhere inside `adb install`, on a device calling itself the exact
-- phone the customer builds for — which is a worse outcome than never having claimed the name.
--
-- ALL THREE ARE NULLABLE, and that is not laziness. An N-1 worker sends none of them, a physical
-- handset has no profile because it IS the device, and the two unprofiled Cuttlefish devices this
-- change deliberately leaves alone send only `screen` and `abis`. Every reader below must render
-- correctly with all three absent.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS profile text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS screen  jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS abis    jsonb;

COMMENT ON COLUMN devices.profile IS
  'Device profile the guest was configured from (ADR-0016). NULL means model was discovered, not configured.';
COMMENT ON COLUMN devices.screen IS
  '{width,height,density} of the device panel, as the worker observes it.';
COMMENT ON COLUMN devices.abis IS
  'Executable ABIs, most-preferred first. NULL means the worker did not report them; do not treat as "none".';
