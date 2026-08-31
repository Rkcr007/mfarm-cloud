#!/usr/bin/env node
/**
 * Give already-uploaded builds their real names.
 *
 * WHY THIS IS NEEDED ONCE. `android:label` in a normally-built app is `@string/app_name`, a
 * reference into `resources.arsc`. The APK parser used to answer null for a reference, so every
 * build uploaded before that changed carries `label = NULL` and shows in the console as
 * `com.example.thing` — a package id where a product shows a name.
 *
 * New uploads resolve it at parse time. This walks the rows that predate that and fills them in
 * from the blobs already on disk. Idempotent, and safe to run against a live control plane: it
 * touches only rows whose label is NULL, and only ever sets a name.
 *
 * A row whose blob is missing, or whose resource table this parser cannot read, is REPORTED AND
 * SKIPPED rather than failed — the run is a nicety, and a build with no pretty name still installs.
 *
 *   node deploy/backfill-app-labels.mjs            # report what would change
 *   node deploy/backfill-app-labels.mjs --write    # apply it
 */
import { Pool } from 'pg';
import { access } from 'node:fs/promises';
import { readApkMetadata } from '../apps/api/src/apk.ts';

const WRITE = process.argv.includes('--write');
const APP_STORE = process.env.APP_STORE_DIR ?? '/var/lib/mfarm/apps';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const pathFor = (sha) => `${APP_STORE}/${sha.slice(0, 2)}/${sha}`;

const pool = new Pool({ connectionString: url });
try {
  const { rows } = await pool.query(
    `SELECT id, package_name, version_name, sha256 FROM app_builds WHERE label IS NULL ORDER BY created_at`,
  );
  if (!rows.length) { console.log('Every build already has a label. Nothing to do.'); process.exit(0); }

  console.log(`${rows.length} build(s) without a label${WRITE ? '' : ' — dry run, pass --write to apply'}\n`);
  let named = 0, skipped = 0;

  for (const r of rows) {
    const blob = pathFor(r.sha256);
    let label = null, why = '';
    try {
      await access(blob);
      label = (await readApkMetadata(blob)).label;
      if (!label) why = 'no resolvable label in the APK';
    } catch (e) {
      why = e.code === 'ENOENT' ? 'blob is not on this host' : e.message.slice(0, 60);
    }

    if (label) {
      named++;
      console.log(`  ${r.package_name} ${r.version_name ?? ''} -> ${JSON.stringify(label)}`);
      if (WRITE) await pool.query(`UPDATE app_builds SET label = $2 WHERE id = $1 AND label IS NULL`, [r.id, label]);
    } else {
      skipped++;
      console.log(`  ${r.package_name} ${r.version_name ?? ''} -- skipped (${why})`);
    }
  }

  console.log(`\n${named} named, ${skipped} skipped.${WRITE ? '' : '  Re-run with --write to apply.'}`);
} finally {
  await pool.end();
}
