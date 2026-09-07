/**
 * Every metric the dashboard asks for is a metric the API actually publishes.
 *
 * WHY THIS EXISTS. `alerts.test.yml` opens by saying that `promtool check rules` validates syntax
 * and evaluates nothing, so a rule watching `mfarm_backup_age_second` — singular, a typo — passes
 * and then never fires. A DASHBOARD has the same hole and no promtool at all: a panel whose query
 * names a metric that does not exist renders an empty graph, and an empty graph on a farm at 3am is
 * indistinguishable from a farm with nothing happening.
 *
 * That is this repo's recurring failure in its purest form — a control on a premise that is false,
 * which looks finished. `docs/DEFECTS.md` has six of them.
 *
 * The check is deliberately crude: pull every `mfarm_*` identifier out of every panel query, and
 * require each one to be declared in `metrics.ts`. It cannot check PromQL semantics and does not
 * try. It catches the typo, the renamed metric, and the panel someone wrote against a gauge that
 * was only ever proposed — which is the whole population of bugs this file can have.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dashboard = JSON.parse(
  readFileSync(join(root, 'deploy/observability/grafana/dashboards/mfarm.json'), 'utf8'));
const metricsSrc = readFileSync(join(root, 'apps/api/src/metrics.ts'), 'utf8');

/**
 * Names declared in `metrics.ts`, as string literals.
 *
 * Read from the SOURCE rather than by importing and scraping the registry, because collecting a
 * scrape needs a database and this file runs in `test:deploy`, which has none. The names are
 * literals — `g('mfarm_devices', …)` — so a regex over the source is exact for the thing being
 * checked, and a metric renamed in one place and not the other still fails.
 */
const declared = new Set([...metricsSrc.matchAll(/'(mfarm_[a-z0-9_]+)'/g)].map((m) => m[1]));

/** Every `mfarm_*` identifier in every panel target, with histogram suffixes stripped. */
function queried() {
  const found = new Map(); // metric -> the panel titles that ask for it
  for (const panel of dashboard.panels ?? []) {
    for (const t of panel.targets ?? []) {
      for (const m of (t.expr ?? '').matchAll(/\bmfarm_[a-z0-9_]+/g)) {
        // A histogram publishes `_bucket`, `_sum` and `_count`; only the base name is declared.
        const base = m[0].replace(/_(bucket|sum|count)$/, '');
        if (!found.has(base)) found.set(base, []);
        found.get(base).push(panel.title);
      }
    }
  }
  return found;
}

describe('the farm dashboard', () => {
  test('is valid JSON with panels', () => {
    assert.ok(Array.isArray(dashboard.panels) && dashboard.panels.length > 0);
  });

  test('every metric it graphs is one metrics.ts declares', () => {
    const missing = [];
    for (const [metric, panels] of queried()) {
      if (!declared.has(metric)) missing.push(`${metric} (in: ${panels.join(', ')})`);
    }
    assert.deepEqual(missing, [],
      `these panels graph metrics that do not exist — they render empty, which looks like a quiet farm:\n  ${missing.join('\n  ')}`);
  });

  /**
   * THE OTHER DIRECTION, as a floor rather than an exhaustive rule. Not every metric needs a panel
   * — plenty are only worth alerting on — but the ones an operator opens this page to see should be
   * on it, and a panel silently deleted in a refactor is not otherwise noticeable.
   */
  test('the numbers an operator opens this page for are on it', () => {
    const shown = new Set(queried().keys());
    for (const m of [
      'mfarm_devices', 'mfarm_sessions', 'mfarm_session_queue_oldest_seconds',
      'mfarm_host_last_heartbeat_timestamp_seconds', 'mfarm_host_disk_free_bytes',
      'mfarm_autodeploy_pending_seconds',
    ]) {
      assert.ok(shown.has(m), `${m} has no panel — nobody will see it until it is already an incident`);
    }
  });

  test('no two panels occupy the same grid slot', () => {
    const seen = new Map();
    for (const p of dashboard.panels) {
      const k = `${p.gridPos.x},${p.gridPos.y}`;
      assert.equal(seen.get(k), undefined,
        `"${p.title}" and "${seen.get(k)}" both sit at ${k} — one of them is invisible`);
      seen.set(k, p.title);
    }
  });
});
