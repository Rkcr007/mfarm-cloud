-- 024: an infrastructure failure is not a test failure (spec §18).
--
-- WHAT IS WRONG TODAY. A test that failed its assertion and a test that "failed" because somebody's
-- foot caught the USB cable are the same row: `status = 'failed'`, with whatever WebDriver error the
-- suite happened to catch in `failure`. So a run's failure count mixes the product's defects with
-- the farm's, and the one number the Runs screen exists to show cannot be trusted to mean what it
-- says. On virtual devices this was rare enough to ignore. On a phone at the end of a cable it is
-- routine, which is why §18 calls this essential and why it lands with physical devices.
--
-- ---------------------------------------------------------------- two sources, two tables
--
-- The split is the design, and it follows from asking who can actually KNOW each thing.
--
--   The SUITE knows whether an assertion failed or the app under test crashed. Nothing else does —
--   the farm watches a session drive a device and those look identical. So the suite classifies its
--   own results, on the endpoint it already calls: two nullable columns on `test_results`.
--
--   The FARM knows adb dropped, Appium had to be restarted, the handset fell below a usable
--   battery. The suite CANNOT know these: it sees one WebDriver call fail and has no vocabulary for
--   why. So the agent records them itself, against the session, in `session_incidents`.
--
-- ---------------------------------------------------------------- what this deliberately does NOT do
--
-- **It does not reclassify a failed test because an incident overlapped it.** That is the tempting
-- version and it is inference dressed as fact, in exactly the way migration 021 refuses to infer
-- pass/fail from an exit code. A test can genuinely fail an assertion during a session that also had
-- a cable glitch; relabelling it as infrastructure would hide a real defect behind the farm's own
-- flakiness, and the person reading the report would never know a claim had been made on their
-- behalf. Both facts are recorded, and the console shows the correlation as a correlation.
--
-- **It does not default a failure to `test`.** A row with no class is UNCLASSIFIED, which is what an
-- older suite reporting `status: 'failed'` honestly is. Defaulting would manufacture the exact claim
-- this migration exists to stop being manufactured, and would make every pre-024 result retroactively
-- assert it was the product's fault.

BEGIN;

-- ------------------------------------------------------------- what the SUITE says about a failure
--
-- Both nullable. A suite that does not classify still reports results, and a passing test has
-- nothing to classify — so this is additive to every existing caller (see the rollback guard).
ALTER TABLE test_results ADD COLUMN failure_class  text;
ALTER TABLE test_results ADD COLUMN failure_reason text;

-- text + CHECK rather than an enum, per 019 and 021: adding a reason later is one line that runs
-- inside a transaction, where `ALTER TYPE ... ADD VALUE` cannot.
ALTER TABLE test_results ADD CONSTRAINT test_results_failure_class_ck
  CHECK (failure_class IS NULL OR failure_class IN ('test', 'infrastructure', 'device-health'));

ALTER TABLE test_results ADD CONSTRAINT test_results_failure_reason_ck
  CHECK (failure_reason IS NULL OR failure_reason IN (
    'assertion-failure', 'application-crash',
    'adb-failure', 'appium-failure', 'device-disconnected', 'usb-failure',
    'agent-failure', 'network-failure',
    'low-storage', 'low-battery', 'device-locked', 'device-unresponsive'));

-- A reason without its class is half a fact, and the pair is what every reader groups by. The API
-- derives the class from the reason rather than trusting the caller to keep them in step, so this
-- constraint should never fire — it is here because "should never" is not "cannot".
ALTER TABLE test_results ADD CONSTRAINT test_results_failure_pair_ck
  CHECK ((failure_class IS NULL) = (failure_reason IS NULL));

-- Only a FAILED test has a failure to classify. A passed test carrying `assertion-failure` is a
-- caller bug, and one that would quietly corrupt every count built on this column.
ALTER TABLE test_results ADD CONSTRAINT test_results_failure_only_on_failed_ck
  CHECK (failure_class IS NULL OR status = 'failed');

-- "How much of last week did this farm lose to USB" — the question the whole taxonomy exists for,
-- and a small slice of a large table.
CREATE INDEX test_results_failure_class_idx
  ON test_results(org_id, failure_class) WHERE failure_class IS NOT NULL;

COMMENT ON COLUMN test_results.failure_class IS
  'What KIND of failure the suite reported, or NULL for unclassified. Never inferred: a failed test '
  'with no class means the suite did not say, not that it was the product''s fault.';

-- ------------------------------------------------------- what the FARM saw, whoever was watching
--
-- Not on `test_results`, because an incident is not a test. It happens to a DEVICE, during a window
-- that may cover several tests or none — a phone that goes unresponsive between two specs belongs
-- to neither of them, and the reset that failed afterwards belongs to no test at all.
CREATE TABLE session_incidents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /**
   * WHO THIS HAPPENED TO — derived at insert time, never accepted from the worker (architecture
   * rule 4, the same reasoning that stopped a worker naming the org it bills).
   *
   * NULLABLE, and working out why is what this column is for. The obvious source is the device's
   * org, and it is wrong: a shared-pool Cuttlefish has NO org — that is what makes it shareable —
   * so a NOT NULL taken from the device rejects every incident on the entire virtual fleet.
   *
   * The right source is the SESSION, because an incident's tenant is whoever it disrupted, not
   * whoever owns the hardware. So: the session's org when a session was running, the device's own
   * org when it is a pinned handset with no session, and NULL when neither — an idle shared device
   * that fell over. That last case is real and is deliberately visible to no tenant: it disrupted
   * nobody, it is fleet news, and showing it to an arbitrary org would be a small privacy leak and
   * a large confusion.
   */
  org_id      uuid REFERENCES orgs(id) ON DELETE CASCADE,
  -- NULLABLE, and the null case is the one worth designing for: a device can go unhealthy while
  -- idle, and a reset can fail after the session that dirtied the device has already ended. An
  -- incident that required a live session to exist would drop exactly those.
  session_id  uuid REFERENCES sessions(id) ON DELETE SET NULL,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  class       text NOT NULL CHECK (class IN ('infrastructure', 'device-health')),
  reason      text NOT NULL,
  -- What the agent actually saw, in its own words: adb's stderr, the health probe's reason. Bounded
  -- by the API rather than here, exactly as `test_results.failure` is.
  detail      text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- IDEMPOTENCY. The agent buffers events and re-sends on reconnect, so the same incident arrives
  -- more than once by design — see the buffer in `agent.ts`. Without this, a worker that lost its
  -- connection for a minute would report one cable pull as thirty.
  event_id    text NOT NULL
);

-- `class` is NOT constrained to include 'test' above, and that is the point: the farm never reports
-- a product defect. It cannot see one.
COMMENT ON TABLE session_incidents IS
  'Infrastructure and device-health failures the FARM observed. Deliberately separate from '
  'test_results: these are things the suite cannot know, and they never overwrite what it reported.';

CREATE UNIQUE INDEX session_incidents_event_idx ON session_incidents(event_id);
CREATE INDEX session_incidents_session_idx ON session_incidents(session_id, occurred_at)
  WHERE session_id IS NOT NULL;
CREATE INDEX session_incidents_device_idx ON session_incidents(device_id, occurred_at DESC);

ALTER TABLE session_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_incidents FORCE  ROW LEVEL SECURITY;

-- SELECT only for the tenant pool, following 018's rule and 023's: the writer is the worker path,
-- which runs on the system pool with the org resolved from the device. There is no `current_org()`
-- at that point — a worker is not a tenant — so a WITH CHECK policy would be a permission for a
-- principal that does not exist here.
-- `org_id = current_org()` is NULL-safe by accident of SQL rather than by design, so it is worth
-- saying: a NULL org_id makes this predicate NULL, which is not TRUE, so a fleet-level incident is
-- invisible to every tenant. That is the intent — see the column comment — and it is why this is
-- written as an equality rather than as an IS NOT DISTINCT FROM.
CREATE POLICY session_incidents_own_org ON session_incidents
  FOR SELECT
  USING (org_id = current_org());

-- 001's ALTER DEFAULT PRIVILEGES hands `mfarm_app` the full set on every table the owner creates,
-- so this arrived with INSERT/UPDATE/DELETE attached. Same trap as 014 and 023; same revoke.
REVOKE INSERT, UPDATE, DELETE ON session_incidents FROM mfarm_app;

COMMIT;
