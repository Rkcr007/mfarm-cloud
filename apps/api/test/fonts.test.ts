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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
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
   * EVERY FACE THE IMAGE CARRIES IS ACTUALLY WORN BY SOMETHING.
   *
   * This is the check that was missing. Stage 1 defined the display face, self-hosted it, served it
   * correctly and wired it to nothing — so Bricolage Grotesque shipped 41 KB into the image and
   * never rendered a glyph. Every test was green, the asset check was green, and a screenshot of
   * the deployed page looked entirely correct, because the fallback in the stack is another face
   * that IS loaded. It was caught only by asking the live page which faces it had loaded.
   *
   * A font nobody uses is not a cosmetic problem: it is bytes in the image, an entry in the
   * allowlist, and a CSP directive, all bought for nothing — and the fact that it looks fine is
   * exactly why it would have stayed.
   *
   * Asserted through `--f-*`, not through the family name, because the family name appears in
   * `design-tokens.css` by definition. What matters is whether a RULE reaches for it.
   */
  test('each family is referenced by a rule that some markup can match', async () => {
    const css = await readFile(join(PUBLIC, 'console.css'), 'utf8');
    const tokens = await readFile(join(PUBLIC, 'design-tokens.css'), 'utf8');

    for (const [family, token] of [
      ['Bricolage Grotesque', '--f-display'],
      ['Instrument Sans', '--f-ui'],
      ['JetBrains Mono', '--f-mono'],
    ] as const) {
      assert.ok(tokens.includes(family), `${family} is not declared in design-tokens.css`);

      // Directly (`font-family: var(--f-display)`) or through the scale (`font: var(--ty-*)`,
      // whose value is built on the family token). Either is a real use.
      const direct = new RegExp(`var\\(${token}\\)`).test(css);
      const viaScale = /font:\s*var\(--ty-/.test(css)
        && new RegExp(`--ty-[a-z-]+:[^;]*var\\(${token}\\)`).test(tokens);

      assert.ok(
        direct || viaScale,
        `${family} is served but no rule in console.css reaches for ${token} — ` +
        'it is bytes in the image, an allowlist entry and a CSP directive bought for nothing, ' +
        'and the page looks fine because it falls back to a face that IS loaded.',
      );
    }
  });

  /**
   * And the display face specifically is on markup that EXISTS, not only on a utility class nobody
   * applies. `.t-display-*` being defined proved nothing — that was the shape of the bug.
   */
  test('the display face is on selectors the console actually renders', async () => {
    const [css, js, html] = await Promise.all([
      readFile(join(PUBLIC, 'console.css'), 'utf8'),
      readFile(join(PUBLIC, 'console.js'), 'utf8'),
      readFile(join(PUBLIC, 'index.html'), 'utf8'),
    ]);

    // The selector list that carries `--f-display`, as class names.
    const block = css.slice(css.indexOf('.headline,'), css.indexOf('font-family: var(--f-display)'));
    const selectors = [...block.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    assert.ok(selectors.length >= 4, `expected several display selectors, found ${selectors.length}`);

    const markup = js + html;
    const orphans = selectors.filter((cls) => !markup.includes(cls));
    assert.deepEqual(orphans, [], 'these carry the display face and no markup uses them');
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
