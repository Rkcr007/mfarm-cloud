-- BILLING FIX: let the hub bind to a session someone else already allocated (ADR-0002, defect D1).
--
-- `mfarm run` allocates a session and hands the child `<origin>/wd/hub`. The child's Appium client
-- then POSTs /session, and the hub — having no way to be told about the session that already exists —
-- allocates a SECOND device from the W3C capabilities. The suite held two devices, paid for two, and
-- never touched the one the CLI allocated. It did not fail; it overcharged, and the customer would
-- have found out on the invoice.
--
-- The fix is to make "who owns this session's lifecycle" an explicit fact rather than an assumption
-- the hub gets to make. One column, because the answer decides three different behaviours:
--
--   * hub_allocated = true  — the hub allocated the device from capabilities (a plain Appium client
--     pointed at the hub). The hub releases it on quit and on every failure path, exactly as before.
--   * hub_allocated = false — the caller allocated it (`mfarm run`, or anything driving the REST API)
--     and passed the session id in. The hub drives the device but MUST NOT release it: the caller is
--     the single lifecycle owner, which is what keeps ADR-0002's release-on-every-exit-path
--     guarantee, its --ttl, and its exit-code contract meaning what they say.
--
-- The second case also makes `driver.quit()` followed by a new session work within one allocation:
-- quit tears down the upstream Appium session and frees the binding, and the next POST /session binds
-- the same device again. A suite that quits between tests now costs one device instead of N.

BEGIN;

ALTER TABLE webdriver_sessions
  ADD COLUMN hub_allocated boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN webdriver_sessions.hub_allocated IS
  'True when the hub allocated this session itself and must therefore release it. False when the '
  'caller (mfarm run / the REST API) owns the lifecycle and the hub only borrows the device.';

COMMIT;
