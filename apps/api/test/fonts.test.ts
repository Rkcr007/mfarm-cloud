/**
 * The checked-in typefaces, against the packages they came from.
 *
 * WHY THEY ARE COMMITTED AT ALL. Both consoles reference the faces by absolute path and the API
 * serves them from an allowlist of literal paths; a file that only exists after a vite build could
 * not be named by that allowlist without the build having run, which would make a fresh checkout
 * unable to serve a typeface until somebody ran a bundler. So they are committed.
 *
 * The cost of committing a derived file is that it goes stale in silence — `npm update` moves the
 * package, nothing moves `public/fonts`, and the console renders a version of the face nobody chose
 * from a file nobody looked at. This is the test that turns that into a failure, and it names the
 * script that fixes it so the person who hits it does not have to go looking.
 *
 * NO SERVER AND NO DATABASE HERE. It is a file comparison, and keeping it out of `ui.test.ts` means
 * it still runs when Postgres is not up.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FACES } from '../scripts/sync-fonts.mjs';

describe('the self-hosted faces', () => {
  test('every checked-in file is byte-identical to the package it came from', async () => {
    for (const face of FACES) {
      const [source, committed] = await Promise.all([
        readFile(face.from).catch(() => null),
        readFile(face.to).catch(() => null),
      ]);

      assert.ok(source, `${face.name}: not in node_modules — run \`npm install\``);
      assert.ok(committed, `${face.name}: missing from public/fonts — run \`node apps/api/scripts/sync-fonts.mjs\``);
      assert.ok(
        committed.equals(source),
        `${face.file} has drifted from @fontsource-variable/${face.name}.\n` +
        'Run `node apps/api/scripts/sync-fonts.mjs` and commit the result.',
      );
    }
  });

  /**
   * The magic number, checked on the bytes ON DISK.
   *
   * `ui.test.ts` checks it on the bytes coming back off the wire, which catches the route reading a
   * font as utf8. This catches the other half: a file that was corrupted on its way INTO the repo —
   * by a copy through a text-mode tool, or by a merge that treated it as text — would be served
   * faithfully and still render as the fallback face, with no error anywhere.
   */
  test('each one is intact woff2 on disk', async () => {
    for (const face of FACES) {
      const bytes = await readFile(face.to);
      assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${face.file} is not woff2`);
      assert.ok(bytes.length > 10_000, `${face.file} is ${bytes.length} bytes, which is not a face`);
    }
  });

  /**
   * The subset list is short because every entry is an allowlist entry, and a list nobody can hold
   * in their head is a list nobody audits. If this number goes up, `routes/ui.ts` and both
   * stylesheets need the same entry in the same commit — which is the thing this assertion is
   * really here to make somebody notice.
   */
  test('three faces, latin wght only', () => {
    assert.equal(FACES.length, 3);
    for (const face of FACES) assert.match(face.file, /-latin-wght-normal\.woff2$/);
  });
});
