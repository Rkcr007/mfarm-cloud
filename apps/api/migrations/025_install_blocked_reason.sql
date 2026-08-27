-- `install-blocked`: the device refused an install rather than failing at one.
--
-- Play Protect's package verifier rejects an APK pushed over adb — INSTALL_FAILED_VERIFICATION_FAILURE
-- on the wire, "Harmful app blocked" on the phone. It refuses Appium's own helper APKs, which are
-- debug-signed, so a stock handset cannot run a session at all until somebody deals with it.
--
-- Infrastructure rather than test, and the distinction is the whole point of 024: the suite never
-- ran. Nothing about the application was exercised, so recording this as a test failure would blame
-- the product for a setting on the phone.
--
-- One line, inside a transaction, exactly as 024 predicted adding a reason would be. Constraints are
-- dropped and recreated because Postgres has no ALTER ... ADD VALUE for a CHECK.
ALTER TABLE test_results DROP CONSTRAINT test_results_failure_reason_ck;
ALTER TABLE test_results ADD CONSTRAINT test_results_failure_reason_ck
  CHECK (failure_reason IS NULL OR failure_reason IN (
    'assertion-failure', 'application-crash',
    'adb-failure', 'appium-failure', 'device-disconnected', 'usb-failure',
    'agent-failure', 'network-failure', 'install-blocked',
    'low-storage', 'low-battery', 'device-locked', 'device-unresponsive'));
