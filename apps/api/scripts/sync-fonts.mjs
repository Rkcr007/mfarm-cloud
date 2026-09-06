/**
 * Refresh the checked-in woff2 files from the `@fontsource-variable` packages they came from.
 *
 * THE FACES ARE COMMITTED, not built, and that is the decision this script exists to make
 * survivable. Both consoles reference them by absolute path — the old one through
 * `design-tokens.css` — and the API serves
 * them from an allowlist of literal paths. A file produced by a build step could not be named by
 * that allowlist without the build having run first, which would make `npm test` in a fresh
 * checkout depend on a vite invocation to serve a typeface.
 *
 * The cost of committing them is that they can go stale against the package silently. So:
 * `fonts.test.ts` asserts every checked-in file is byte-identical to the one in `node_modules`, and
 * this script is how you make that true again after a `npm update`. The test names this script in
 * its failure message, so the person who hits it does not have to find it.
 *
 * `--check` reports without writing, which is what CI wants.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DEST = join(HERE, '..', 'public', 'fonts');

/**
 * Latin only, and only the `wght` cut of each face.
 *
 * Fontsource ships every subset it has — Cyrillic, Greek, Vietnamese — which is eleven files for
 * three faces, plus `wdth`, `opsz` and `standard` cuts on top. A browser downloads only the subset
 * its text needs, so the unused ones cost no bandwidth; they cost ALLOWLIST ENTRIES, and a list of
 * eleven paths is a list nobody audits. Add one here the day the console is translated, and add it
 * to `routes/ui.ts` and to both stylesheets in the same commit.
 */
export const FACES = [
  'instrument-sans',
  'bricolage-grotesque',
  'jetbrains-mono',
].map((name) => ({
  name,
  file: `${name}-latin-wght-normal.woff2`,
  from: join(REPO, 'node_modules', '@fontsource-variable', name, 'files', `${name}-latin-wght-normal.woff2`),
  to: join(DEST, `${name}-latin-wght-normal.woff2`),
}));

/**
 * Read a font as a Buffer, never as text.
 *
 * A woff2 decoded as utf8 and re-encoded is a file the browser SILENTLY REFUSES — no console error,
 * no failed request, the only symptom is that the page renders in the fallback face. The API's own
 * route learned this the same way and says so; a comparison that stringified the bytes would report
 * two corrupted files as equal.
 */
const read = (p) => readFile(p);

async function main() {
  const check = process.argv.includes('--check');
  const stale = [];

  for (const face of FACES) {
    const source = await read(face.from).catch(() => null);
    if (!source) {
      console.error(`missing: ${face.from}\n  run \`npm install\` — the package supplies this file`);
      process.exitCode = 1;
      continue;
    }
    const current = await read(face.to).catch(() => null);
    if (current && current.equals(source)) continue;

    stale.push(face.file);
    if (!check) {
      await writeFile(face.to, source);
      console.log(`updated: public/fonts/${face.file}  (${source.length} bytes)`);
    }
  }

  if (check && stale.length) {
    console.error(
      `${stale.length} checked-in font(s) differ from the package:\n` +
      stale.map((f) => `  ${f}`).join('\n') +
      '\n\nRun `node apps/api/scripts/sync-fonts.mjs` and commit the result.',
    );
    process.exitCode = 1;
    return;
  }
  if (!stale.length) console.log('fonts are in step with @fontsource-variable');
}

// Importable by the test without running: the test wants FACES, not the side effect.
if (import.meta.url === `file://${process.argv[1]}`) await main();
