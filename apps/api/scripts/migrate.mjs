// Applies migrations in filename order, tracking what has run. No framework needed at this size.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? 'postgres://mfarm:mfarm@localhost:5433/mfarm',
});

await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

const applied = new Set(
  (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

let ran = 0;
for (const f of files) {
  if (applied.has(f)) { console.log(`  skip  ${f}`); continue; }
  const sql = await readFile(join(dir, f), 'utf8');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    console.log(`  ok    ${f}`);
    ran++;
  } catch (err) {
    console.error(`  FAIL  ${f}\n        ${err.message}`);
    await client.end();
    process.exit(1);
  }
}
console.log(ran ? `applied ${ran} migration(s)` : 'schema up to date');
await client.end();
