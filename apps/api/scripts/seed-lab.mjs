// Seeds the minimum a FRESH database needs before anything can be driven: a region, an org, and a
// tenant API key.
//
// WHY THIS EXISTS. `migrate.mjs` creates the schema and stops, which is correct — but it leaves a
// control plane that cannot actually be used, and the gap is invisible until you are standing in
// front of it:
//
//   * `hosts.region` and `devices.region` are FOREIGN KEYS to `regions(code)`, and `regions` starts
//     empty. A worker registering against a fresh database fails on a constraint, not on anything
//     that names the real problem.
//   * There is no way to mint a tenant API key. Every route except the probes and worker
//     registration needs one, so without this you have a running farm and no way to ask it anything.
//
// Both were found while writing docs/HARDWARE_DAY.html, before renting a machine rather than on it.
//
// Idempotent: re-running reuses the region and org, and mints an ADDITIONAL key. Keys are never
// recoverable after this prints them, because only the sha256 is stored.
//
//   DATABASE_URL=postgres://... node apps/api/scripts/seed-lab.mjs
//   DATABASE_URL=postgres://... REGION=lab ORG_SLUG=lab node apps/api/scripts/seed-lab.mjs
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const REGION = process.env.REGION ?? 'lab';
const REGION_NAME = process.env.REGION_NAME ?? 'Hardware day lab';
const ORG_SLUG = process.env.ORG_SLUG ?? 'lab';
const ORG_NAME = process.env.ORG_NAME ?? 'Lab';
const MAX_CONCURRENT = Number(process.env.ORG_MAX_CONCURRENT ?? 8);

// This mints a long-lived credential and prints it to a terminal. That is exactly right for a
// throwaway lab box and exactly wrong for the farm you actually depend on, where keys should be
// issued deliberately and never echoed. Refuse rather than rely on nobody making the mistake.
if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'i-mean-it') {
  console.error(
    'seed-lab refuses to run with NODE_ENV=production.\n' +
    'It prints a tenant API key to stdout, which belongs in a scratch environment and nowhere else.\n' +
    'If you genuinely mean it, set SEED_ALLOW_PRODUCTION=i-mean-it.',
  );
  process.exit(78);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Mirrors generateApiKey() in apps/api/src/auth.ts — same prefix, same entropy, same hash. Kept as
// a copy rather than an import because this is a plain .mjs script run by node without type
// stripping; if auth.ts ever changes shape, apps/api/test/http.test.ts is what catches the drift,
// since it authenticates with keys minted by the real function.
function generateApiKey() {
  const plaintext = `mfk_${randomBytes(32).toString('base64url')}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256(plaintext) };
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL ?? 'postgres://mfarm:mfarm@localhost:5433/mfarm',
});

await client.connect();

try {
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO regions (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`,
    [REGION, REGION_NAME],
  );

  // Returns the existing row on conflict as well as the inserted one, so re-running is not an error
  // and does not silently create a second org with a suffixed slug.
  const { rows: orgRows } = await client.query(
    `INSERT INTO orgs (slug, name, max_concurrent) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [ORG_SLUG, ORG_NAME, MAX_CONCURRENT],
  );
  const orgId = orgRows[0].id;

  const key = generateApiKey();
  await client.query(
    `INSERT INTO api_keys (org_id, prefix, key_hash) VALUES ($1, $2, $3)`,
    [orgId, key.prefix, key.hash],
  );

  await client.query('COMMIT');

  // stdout carries ONLY the export lines, so `eval "$(… seed-lab.mjs)"` works and the commentary
  // below cannot end up inside a shell variable.
  console.log(`export MFARM_API_KEY=${key.plaintext}`);
  console.log(`export MFARM_REGION=${REGION}`);
  console.log(`export MFARM_ORG_ID=${orgId}`);

  console.error('');
  console.error(`  region   ${REGION} (${REGION_NAME})`);
  console.error(`  org      ${ORG_SLUG} -> ${orgId}, max_concurrent=${MAX_CONCURRENT}`);
  console.error(`  api key  ${key.prefix}… — SHOWN ONCE. Only its sha256 is stored.`);
  console.error('');
  console.error('  Load it into your shell with:');
  console.error('      eval "$(DATABASE_URL=... node apps/api/scripts/seed-lab.mjs)"');
  console.error('');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`seed-lab failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
