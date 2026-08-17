-- 010: move the automation endpoint onto the device (ADR-0003 B2, ADR-0004 point 4).
--
-- Until now `hosts.automation_endpoint` was the only place an automation server could be named, so
-- a host with two devices could describe at most one of them. `agent.ts` stamped `webdriver` onto
-- every device on the host regardless, which meant the second device advertised a capability whose
-- server the hub could never reach — every session allocated to it failed at the proxy hop. The
-- worker agent's answer was to refuse to start Appium at all on a multi-device host.
--
-- ADR-0004 makes this urgent rather than merely untidy: the gateway's url contains a device local
-- id, so the endpoint is now *inherently* per-device and a host-level column cannot express it.
--
-- `hosts.automation_endpoint` is KEPT, not dropped. A v1 worker still sends only the host-level
-- field, and the hub reads `COALESCE(d.automation_endpoint, h.automation_endpoint)` so those hosts
-- keep working exactly as before. Dropping it would break every N-1 worker on the first deploy,
-- which is the situation `PROTOCOL_VERSION`/`MIN_SUPPORTED_VERSION` exists to avoid.

ALTER TABLE devices ADD COLUMN automation_endpoint text;

COMMENT ON COLUMN devices.automation_endpoint IS
  'Base url the WebDriver hub dials for this device — the worker''s automation gateway, not Appium '
  '(ADR-0004). NULL falls back to hosts.automation_endpoint for v1 workers.';

COMMENT ON COLUMN hosts.automation_endpoint IS
  'LEGACY host-level automation base url. v1 workers only; v2 workers set devices.automation_endpoint. '
  'Read via COALESCE(d.automation_endpoint, h.automation_endpoint).';

-- Backfill so an in-place upgrade does not withdraw `webdriver` from every device already serving
-- it. Without this, a host registered before the migration keeps working (the COALESCE finds the
-- host row) but any query written against the device column alone would see NULL and disagree.
UPDATE devices d
   SET automation_endpoint = h.automation_endpoint
  FROM hosts h
 WHERE h.id = d.host_id
   AND h.automation_endpoint IS NOT NULL
   AND d.automation_endpoint IS NULL;
