-- 011: the device's real identity, and the ports a concurrent driver session needs (ADR-0003 B3).
--
-- `webdriver.ts` sent `appium:udid = devices.local_id` — `cf-1`, `avd-1`. UiAutomator2 matches
-- `udid` against the ADB SERIAL (`0.0.0.0:6520`, `emulator-5560`), so every session the hub has ever
-- created would have targeted nothing on a real driver. Both worker backends already computed the
-- correct serial and kept it private; this is where it becomes a fact the control plane holds.
--
-- Overriding the capability was always right — a client that picks its own udid is picking a device,
-- and the device it picks may belong to another tenant right now. Only the value was wrong.
--
-- The two ports are the same class of defect, and they became reachable the moment migration 010 let
-- one host serve WebDriver on more than one device. UiAutomator2 defaults `systemPort` to 8200 and
-- its MJPEG server to 7810 for EVERY session, so two concurrent sessions on one host collide and the
-- second fails to start. Nothing set either.
--
-- Deliberately three typed columns rather than one jsonb bag of Appium capabilities. A bag would be
-- extensible without a migration, and it would also let a worker inject arbitrary capabilities into
-- a tenant's session — `appium:app`, for one. Migration 008 established that worker-supplied input
-- is scoped and derived, never trusted wholesale; the hub maps exactly these three to exactly three
-- known capability names, so a worker cannot introduce a fourth.

ALTER TABLE devices ADD COLUMN adb_serial        text;
ALTER TABLE devices ADD COLUMN system_port       integer;
ALTER TABLE devices ADD COLUMN mjpeg_server_port integer;

COMMENT ON COLUMN devices.adb_serial IS
  'Serial the platform driver matches on (adb serial for Android). Sent as appium:udid. NOT local_id '
  '— that is our name for the device and no driver has heard of it (B3).';
COMMENT ON COLUMN devices.system_port IS
  'Port reserved on the host for this device''s UiAutomator2 helper. Sent as appium:systemPort so '
  'two concurrent sessions on one host do not both take the 8200 default.';
COMMENT ON COLUMN devices.mjpeg_server_port IS
  'As system_port, for UiAutomator2''s MJPEG server (default 7810).';

-- No backfill is possible or wanted. A serial cannot be derived from `local_id` — that is the entire
-- bug — so pre-existing rows stay NULL, and the hub refuses WebDriver on them with a clear message
-- until their worker re-registers. Guessing here would reintroduce exactly the defect being fixed,
-- and on a multi-device host a guess can land on another tenant's device.
