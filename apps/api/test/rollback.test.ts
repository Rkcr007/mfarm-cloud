/**
 * Can the previous release's code still run against this release's schema?
 *
 * WHY THIS EXISTS. `deploy/mfarm-deploy.sh` says it plainly: "rollback is this same command with an
 * older sha — which works because images are tagged by commit and never mutated. Migrations do NOT
 * roll back." So the image half of a rollback is solved and the schema half is not, and the schema
 * half is the one that decides whether rollback is a command or a gamble.
 *
 * It is only a gamble if a migration is backward-INCOMPATIBLE. Adding a nullable column or a new
 * table cannot hurt code that has never heard of either. Dropping a column, tightening one to NOT
 * NULL, changing a type, or adding a CHECK to an existing table all can — and every one of them
 * looks completely fine in review, in CI, and on the day it ships. It fails later, on the worst day
 * of the quarter, in the middle of a rollback nobody wants to be doing.
 *
 * So this builds BOTH schemas in a scratch database — the baseline release's, then the current one's
 * — and compares them mechanically. Nothing is inferred from reading the SQL: the migrations are
 * applied to a real Postgres and the answer comes from `information_schema`, because inferring
 * policy from SQL text is how you get a rule that passes on a statement it did not recognise.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The last migration in the DEPLOYED release — currently the one tagged `mvp1`.
 *
 * Bump it when you cut a new release, and only then. Deliberately a constant someone changes by
 * hand: deriving it — from the newest file, from a tag, from anything that follows HEAD — would
 * make it compare a release against itself, which passes forever while proving nothing. The last
 * test in this file exists to catch exactly that mistake.
 */
const BASELINE = '022_screenshot_action.sql';

/**
 * New CHECK constraints on tables that existed at the baseline.
 *
 * Empty, and it should stay that way most of the time. A CHECK added to an existing table rejects
 * writes the previous release makes happily, so adding one is a decision to record here with the
 * reason it is safe — not something to discover during a rollback.
 */
const ACCEPTED_NEW_CHECKS: string[] = [
  /**
   * Migration 024, failure classification (spec §18). All four constrain ONLY columns that did not
   * exist at the baseline — `failure_class` and `failure_reason`, both nullable and both added by
   * the same migration.
   *
   * That is what makes them safe in the direction this guard actually cares about. Roll the CODE
   * back to the previous release against a 024 schema and it writes `test_results` exactly as it
   * always did, naming neither column; both default to NULL; and every one of these CHECKs is
   * satisfied by its own `IS NULL` branch. There is no write the old release makes that the new
   * constraints reject, which is the precise question the test is asking.
   *
   * The general rule stays right and this is not a precedent for relaxing it: a CHECK that touched
   * `status` or `failure` — columns the old release DOES write — would fail a rollback exactly as
   * the guard predicts, and belongs in a new migration rather than in this list.
   */
  'test_results.test_results_failure_class_ck',
  'test_results.test_results_failure_reason_ck',
  'test_results.test_results_failure_pair_ck',
  'test_results.test_results_failure_only_on_failed_ck',
];

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SYSTEM_URL = process.env.DATABASE_URL ?? 'postgres://mfarm:mfarm@localhost:5433/mfarm';
const SCRATCH = `mfarm_rollback_${process.pid}`;

interface Column { table: string; column: string; type: string; nullable: boolean; hasDefault: boolean }
interface Check { table: string; name: string; def: string }
interface Snapshot { columns: Map<string, Column>; tables: Set<string>; checks: Map<string, Check> }

let baseline: Snapshot;
let current: Snapshot;

const scratchUrl = () => {
  const u = new URL(SYSTEM_URL);
  u.pathname = `/${SCRATCH}`;
  return u.toString();
};

async function snapshot(c: pg.Client): Promise<Snapshot> {
  const cols = await c.query<{ t: string; c: string; d: string; n: string; def: string | null }>(
    `SELECT table_name AS t, column_name AS c, data_type AS d, is_nullable AS n, column_default AS def
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  );
  const checks = await c.query<{ t: string; n: string; def: string }>(
    `SELECT rel.relname AS t, con.conname AS n, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = 'public' AND con.contype = 'c'`,
  );
  const columns = new Map<string, Column>();
  const tables = new Set<string>();
  for (const r of cols.rows) {
    tables.add(r.t);
    columns.set(`${r.t}.${r.c}`, {
      table: r.t, column: r.c, type: r.d, nullable: r.n === 'YES', hasDefault: r.def !== null,
    });
  }
  const checkMap = new Map<string, Check>();
  for (const r of checks.rows) checkMap.set(`${r.t}.${r.n}`, { table: r.t, name: r.n, def: r.def });
  return { columns, tables, checks: checkMap };
}

async function applyUpTo(c: pg.Client, files: string[]): Promise<void> {
  for (const f of files) {
    await c.query(await readFile(join(MIGRATIONS, f), 'utf8'));
  }
}

before(async () => {
  // CREATE DATABASE cannot run inside a transaction, so this is a raw client rather than withSystem.
  const admin = new pg.Client({ connectionString: SYSTEM_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.query(`CREATE DATABASE ${SCRATCH}`);
  await admin.end();

  const all = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const upToBaseline = all.filter((f) => f <= BASELINE);
  const after = all.filter((f) => f > BASELINE);
  assert.ok(upToBaseline.includes(BASELINE), `BASELINE ${BASELINE} is not a migration file`);

  const c = new pg.Client({ connectionString: scratchUrl() });
  await c.connect();
  await applyUpTo(c, upToBaseline);
  baseline = await snapshot(c);
  await applyUpTo(c, after);
  current = await snapshot(c);
  await c.end();
});

after(async () => {
  const admin = new pg.Client({ connectionString: SYSTEM_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.end();
});

describe(`schema changes since ${BASELINE} are backward compatible`, () => {
  test('no table the previous release reads has been dropped or renamed', () => {
    const gone = [...baseline.tables].filter((t) => !current.tables.has(t));
    assert.deepEqual(gone, [],
      'the previous release SELECTs from these; rolling the image back would 42P01 on the first request');
  });

  test('no column the previous release uses has been dropped or renamed', () => {
    const gone = [...baseline.columns.keys()].filter((k) => !current.columns.has(k));
    assert.deepEqual(gone, [],
      'a rename is a drop and an add as far as the old code is concerned');
  });

  test('no column has been tightened to NOT NULL', () => {
    const tightened = [...baseline.columns.values()]
      .filter((b) => b.nullable && current.columns.get(`${b.table}.${b.column}`)?.nullable === false)
      .map((b) => `${b.table}.${b.column}`);
    assert.deepEqual(tightened, [],
      'the previous release writes rows leaving these empty, and would start failing on INSERT');
  });

  test('no column has changed type', () => {
    const changed = [...baseline.columns.values()]
      .filter((b) => {
        const now = current.columns.get(`${b.table}.${b.column}`);
        return now && now.type !== b.type;
      })
      .map((b) => `${b.table}.${b.column}: ${b.type} -> ${current.columns.get(`${b.table}.${b.column}`)!.type}`);
    assert.deepEqual(changed, []);
  });

  test('no column has lost a default', () => {
    // The previous release omits defaulted columns from its INSERTs. Removing the default turns
    // that into a NOT NULL violation, or worse, a silently different value.
    const lost = [...baseline.columns.values()]
      .filter((b) => b.hasDefault && current.columns.get(`${b.table}.${b.column}`)?.hasDefault === false)
      .map((b) => `${b.table}.${b.column}`);
    assert.deepEqual(lost, []);
  });

  test('every new column on an existing table is nullable or defaulted', () => {
    // This is the rule that makes additive migrations safe, and the one an ordinary feature branch
    // is most likely to break — `ADD COLUMN ... NOT NULL` reads as good hygiene right up until the
    // previous release's INSERT omits it.
    const offenders: string[] = [];
    for (const [key, col] of current.columns) {
      if (baseline.columns.has(key)) continue;
      if (!baseline.tables.has(col.table)) continue;   // a wholly new table cannot break old code
      if (col.nullable || col.hasDefault) continue;
      offenders.push(key);
    }
    assert.deepEqual(offenders, [],
      'add it nullable, backfill, then tighten in a LATER release — that sequence is what keeps rollback available');
  });

  test('no new CHECK constraint on a table the previous release writes to', () => {
    const added: string[] = [];
    for (const [key, con] of current.checks) {
      if (baseline.checks.has(key)) continue;
      if (!baseline.tables.has(con.table)) continue;
      if (ACCEPTED_NEW_CHECKS.includes(key)) continue;
      added.push(`${key}: ${con.def}`);
    }
    assert.deepEqual(added, [],
      'a CHECK rejects writes the previous release makes happily; if it is genuinely safe, record it in ACCEPTED_NEW_CHECKS with the reason');
  });

  test('the comparison actually ran against two different schemas', () => {
    // A guard on the test itself. If BASELINE ever named the newest migration, every assertion
    // above would compare a schema to itself and pass while proving nothing.
    assert.ok(current.columns.size > baseline.columns.size || current.tables.size > baseline.tables.size,
      `nothing changed since ${BASELINE} — is BASELINE stale, pointing at HEAD?`);
  });
});
