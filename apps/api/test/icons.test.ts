/**
 * The console's icon set, against the package it is generated from.
 *
 * `public/icons.js` is a build product that is checked in — it has to be, because `routes/ui.ts`
 * serves an allowlist of literal paths and a file that appears only after a build could not be
 * served from a fresh checkout. The cost of committing a build product is that it goes stale in
 * silence: `npm update` moves lucide, nothing moves `icons.js`, and the console draws last year's
 * geometry from a file nobody looked at.
 *
 * So the generator is re-run IN MEMORY here and compared against what is on disk. Same shape as
 * `fonts.test.ts`, and for the same reason.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, ICON_MAP } from '../scripts/build-icon-sprite.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

describe('the icon set', () => {
  test('the committed file is what the generator produces', async () => {
    const [onDisk, fresh] = await Promise.all([
      readFile(join(PUBLIC, 'icons.js'), 'utf8'),
      generate(),
    ]);
    assert.equal(
      onDisk,
      fresh,
      'public/icons.js is out of step with lucide-static.\n' +
      'Run `node apps/api/scripts/build-icon-sprite.mjs` and commit the result.',
    );
  });

  /**
   * EVERY NAME THE CONSOLE ASKS FOR IS A NAME THE SET HAS.
   *
   * `iconSvg` renders an unknown name as an EMPTY svg — deliberately, because a missing icon that
   * silently draws some other glyph is a bug that ships while a hole is one somebody fixes. That
   * choice is only safe if something checks the names, because an empty 16px box in a nav is quiet
   * enough to survive a review. This is that check, and it reads the call sites rather than a list:
   * `icon('foo')` in console.js and `data-icon="foo"` in index.html.
   */
  test('every icon the console names exists in the set', async () => {
    const [js, html] = await Promise.all([
      readFile(join(PUBLIC, 'console.js'), 'utf8'),
      readFile(join(PUBLIC, 'index.html'), 'utf8'),
    ]);

    const asked = new Set<string>();
    for (const m of js.matchAll(/\bicon\('([a-z0-9-]+)'/g)) asked.add(m[1]!);
    for (const m of js.matchAll(/\bicon:\s*'([a-z0-9-]+)'/g)) asked.add(m[1]!);
    for (const m of html.matchAll(/data-icon="([a-z0-9-]+)"/g)) asked.add(m[1]!);

    assert.ok(asked.size > 15, `expected the console to name many icons, found ${asked.size}`);
    for (const name of asked) {
      assert.ok(name in ICON_MAP, `the console asks for icon "${name}", which the set does not have`);
    }
  });

  /**
   * The twenty Unicode glyphs are GONE, not merely supplemented.
   *
   * They are why the chrome read as unfinished: a character like ▤ comes from whatever font the
   * platform picked, at whatever weight and baseline it chose, so the same sidebar looked different
   * on every machine and matched nothing else on screen. A reintroduced one would look almost right
   * in review and wrong on somebody else's laptop, which is precisely the failure a test can see
   * and an eye cannot.
   */
  test('no Unicode pictographs are left in the chrome', async () => {
    const [js, html] = await Promise.all([
      readFile(join(PUBLIC, 'console.js'), 'utf8'),
      readFile(join(PUBLIC, 'index.html'), 'utf8'),
    ]);
    /**
     * Geometric shapes, technical symbols, dingbats and the fullwidth plus — the four blocks the
     * old set actually drew from (▶ ■ ✚ ☰ ▤ ⋮ ◎ ☍ ● ⚙ ⏻ ⧉ ＋ □ ✓).
     *
     * ARROWS ARE DELIBERATELY NOT IN THIS CLASS, and the distinction is the point of the test
     * rather than a hole in it. `↵` and `⌘` are KEY CAPS: they name a key the reader is about to
     * press, and drawing them as a Lucide glyph would be worse, not better. `keyboard → device`
     * and `12,40 → 300,88` are arrows used as PUNCTUATION inside a sentence and a machine value.
     * None of those is an icon standing in for a control, which is the thing that read as
     * unfinished and the thing this guards against coming back.
     */
    const pictograph = /[⌀-⏿■-◿☀-➿＋]/g;

    /**
     * The exception, enumerated rather than carved out of the range.
     *
     * These are KEY CAPS — they name a key the reader is about to press, and the Command symbol is
     * the character Apple's own HIG uses for it. Drawing that as a Lucide glyph would be a
     * regression, not a fix. Listing them is better than widening the character class, because a
     * range with a hole in it is a range nobody can read the intent of.
     */
    const KEY_CAPS = new Set(['⌘', '⇧', '⌥', '⌃', '⎋', '⌫']);

    for (const [where, src] of [['console.js', js], ['index.html', html]] as const) {
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments, which discuss the old glyphs
        .replace(/^\s*\/\/.*$/gm, '')            // line comments
        .replace(/<!--[\s\S]*?-->/g, '');        // html comments
      const found = [...code.matchAll(pictograph)].map((m) => m[0]).filter((c) => !KEY_CAPS.has(c));
      assert.deepEqual(found, [], `${where} still draws Unicode glyphs: ${found.join(' ')}`);
    }
  });
});
