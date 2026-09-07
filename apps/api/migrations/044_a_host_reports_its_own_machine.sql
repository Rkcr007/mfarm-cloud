-- 044: the fleet has been observable for weeks; the MACHINE has not.
--
-- ---------------------------------------------------------------- what was missing
--
-- Every gauge on the dashboard is sampled from THIS DATABASE by the control plane: devices by
-- state, sessions by state, queue depth, queue age, host heartbeat age. All of them describe the
-- fleet, and all of them are green on a device host whose disk is 98% full.
--
-- `docs/EXECUTION_ROADMAP.md` S7 used to claim queue depth and capacity were unobservable from
-- Grafana. That was wrong — `collectFleet()` has exported them since the metrics work landed, the
-- dashboard graphs them, `alerts.yml` fires on them, and `metrics.test.ts` has a case named for
-- them. THIS is the gap that was actually there.
--
-- Two things make it worth closing now rather than later:
--
--   * a device host fills its disk. Four Cuttlefish instances, a 4 GB snapshot each, an app cache
--     that `fetchApk` never prunes, and every logcat dump. When it fills, resets fail and the farm
--     degrades in a way that reads as a DEVICE fault for as long as it takes somebody to ssh in and
--     run `df` — which is the same shape as D18: a fact nobody was measuring, discovered by hand.
--   * `docs/RENDER_BASELINE.md` and the encode measurement that closed S5's gate both landed on the
--     host's CPU being this farm's binding constraint. A farm whose limiting resource is invisible
--     is a farm nobody can size.
--
-- ---------------------------------------------------------------- what this adds
--
-- Five nullable columns on `hosts`, written by the heartbeat, read by the metrics scrape.
--
-- NULLABLE, AND NULL IS THE POINT. An agent that predates this sends no stats and stores no stats,
-- and the gauges report "unmeasured" rather than a zero that reads as a full disk or a large number
-- that reads as an empty one. Same rule as `mfarm_backup_age_seconds`'s -1: "we cannot see it" and
-- "it is fine" must never be the same value.
--
-- NO CHECK CONSTRAINTS on the numbers. A disk that reports more free than total is a bug worth
-- SEEING in a graph, not one worth refusing a heartbeat over — and refusing it would take the host
-- out of service over a metric, which inverts the priority between liveness and observability.
--
-- ON `hosts` RATHER THAN A TIME SERIES TABLE. These are current values with a timestamp, scraped
-- every 15s by Prometheus, which is the thing that owns history. A table accumulating a row per
-- host per beat would be 8,640 rows per host per day to answer a question Prometheus already
-- answers better.

BEGIN;

ALTER TABLE hosts
  ADD COLUMN IF NOT EXISTS disk_free_bytes   bigint,
  ADD COLUMN IF NOT EXISTS disk_total_bytes  bigint,
  ADD COLUMN IF NOT EXISTS load1             real,
  ADD COLUMN IF NOT EXISTS mem_available_mb  integer,
  ADD COLUMN IF NOT EXISTS mem_total_mb      integer,
  -- WHEN the stats were last written, which is NOT `last_heartbeat_at`.
  --
  -- A beat from an agent too old to send stats still touches `last_heartbeat_at`, so reading
  -- freshness from that column would report an ancient disk reading as current. This is the column
  -- that says "these five numbers are from a beat that actually carried them".
  ADD COLUMN IF NOT EXISTS stats_at          timestamptz;

COMMIT;
