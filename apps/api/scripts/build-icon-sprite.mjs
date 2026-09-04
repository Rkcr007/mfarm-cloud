/**
 * Generate `public/icons.js` — the console's inline Lucide sprite.
 *
 * WHY A SPRITE AND NOT A LIBRARY. The console has no build step and is served as the files sit on
 * disk, so there is no tree-shaking to lean on: importing an icon package would ship 2000 icons to
 * every visitor. And the CSP is `default-src 'none'`, which rules out the other usual shape — an
 * external `sprite.svg` referenced by `<use href="/sprite.svg#play">` is a fetch, and it is a fetch
 * browsers additionally refuse for `<use>` in most cases. An inline `<symbol>` sheet injected into
 * the document is markup, so it needs no directive at all.
 *
 * WHY GENERATED AND COMMITTED. Same reasoning as the fonts: the allowlist names literal paths, so
 * the file has to exist in a fresh checkout. `icons.test.ts` re-runs this generator in memory and
 * asserts the committed output matches, which is what stops the two drifting after a `npm update`
 * moves lucide.
 *
 * THE SET IS CLOSED ON PURPOSE. Every name below is one the design document actually maps to a
 * place in the product. An icon nobody has decided the meaning of is an icon somebody will use for
 * the wrong thing, so adding one here should mean adding it to the mapping too.
 *
 *   node apps/api/scripts/build-icon-sprite.mjs           write public/icons.js
 *   node apps/api/scripts/build-icon-sprite.mjs --check    report drift, write nothing
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const ICON_DIR = join(REPO, 'node_modules', 'lucide-static', 'icons');
const OUT = join(HERE, '..', 'public', 'icons.js');

/**
 * The mapping, keyed by the name the CONSOLE uses and valued by the Lucide file it comes from.
 *
 * The console's own names are kept where they already existed — `volup`, `rotl`, `fit`, `inspect` —
 * because renaming them would touch every call site to buy nothing. What changes is what they draw.
 */
export const ICON_MAP = {
  /* --- navigation. These twenty are the replacement 01 calls the highest-leverage in the product,
     because the sidebar's Unicode glyphs are most of why the chrome reads as unfinished. --------- */
  launch:    'play',
  devices:   'smartphone',
  apps:      'package',
  sessions:  'monitor-play',
  runs:      'list-checks',
  queue:     'layers',
  health:    'activity',
  agents:    'link-2',
  team:      'users',
  settings:  'settings',

  /* --- device controls -------------------------------------------------------------------------- */
  power:   'power',
  volup:   'volume-2',
  voldown: 'volume-1',
  rotl:    'rotate-ccw',
  rotr:    'rotate-cw',
  /**
   * Back, home and overview.
   *
   * The set they replace was deliberately Android's own — triangle, circle, square — on the
   * reasoning that somebody coming from a device toolbar already knows them and cleverness here
   * costs recognition for nothing. That reasoning still holds, and the mapping does not break it:
   * circle and square are unchanged, and modern Android's own back affordance is a chevron rather
   * than the triangle of the three-button era. This follows the device, not a style guide.
   */
  back:     'chevron-left',
  home:     'circle',
  overview: 'square',

  /* --- session tools ---------------------------------------------------------------------------- */
  camera:  'camera',
  inspect: 'scan-search',
  zoomin:  'zoom-in',
  zoomout: 'zoom-out',
  fit:     'maximize',
  refresh: 'refresh-cw',
  phone:   'monitor-smartphone',
  logcat:  'scroll-text',

  /* --- outcomes, and the two shield states quarantine uses ------------------------------------- */
  check:      'check',
  x:          'x',
  minus:      'minus',
  copy:       'copy',
  quarantine: 'shield-alert',
  release:    'shield-check',

  /* --- shell ------------------------------------------------------------------------------------ */
  search:    'search',
  collapse:  'chevrons-left',
  expand:    'chevrons-right',
  chevron:   'chevron-right',
  enter:     'corner-down-left',
  signout:   'log-out',
  plus:      'plus',
  trash:     'trash-2',
  external:  'external-link',
  warn:      'triangle-alert',
  info:      'info',
  clock:     'clock',
  upload:    'upload',
  download:  'download',
  key:       'key',
  adduser:   'user-plus',
  host:      'server',
};

/**
 * Pull the drawing out of a Lucide file and drop everything else.
 *
 * The wrapper carries `width`, `height`, `class`, `stroke-width` and the two linecaps, and every one
 * of those belongs on the `<svg>` the console renders rather than baked into a `<symbol>` — a
 * stroke-width frozen at 2 is exactly what makes a 14px inline icon look heavier than the text
 * beside it. 01 asks for 1.75 at 16px and below, which is only expressible if the symbol does not
 * carry its own.
 */
function extract(svg, name) {
  const open = svg.indexOf('>', svg.indexOf('<svg'));
  const close = svg.lastIndexOf('</svg>');
  if (open < 0 || close < 0) throw new Error(`${name}: not an svg`);
  const body = svg.slice(open + 1, close).trim();
  if (!body) throw new Error(`${name}: empty`);
  // One line per symbol keeps the generated file diffable: an icon that changes upstream shows as
  // one changed line rather than as a reflowed block.
  return body.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ');
}

export async function generate() {
  const version = JSON.parse(
    await readFile(join(REPO, 'node_modules', 'lucide-static', 'package.json'), 'utf8'),
  ).version;

  const symbols = [];
  for (const [name, file] of Object.entries(ICON_MAP)) {
    const svg = await readFile(join(ICON_DIR, `${file}.svg`), 'utf8');
    symbols.push(`  '${name}': '${extract(svg, file).replace(/'/g, "\\'")}',`);
  }

  return `/**
 * The console's icon set. GENERATED — do not edit.
 *
 *   source:  lucide-static v${version} (ISC)
 *   rebuild: node apps/api/scripts/build-icon-sprite.mjs
 *
 * Lucide because it is ISC-licensed, ships as clean 24px geometry on a 2px grid, and its line
 * quality matches the calm register the rest of the console is written in. The set is closed: every
 * name here is one the design maps to a place in the product, so an icon nobody has decided the
 * meaning of is an icon nobody can accidentally use for the wrong thing.
 *
 * A BROWSER ASSET, so it stays plain JavaScript with no build step — the API serves these files
 * exactly as they sit on disk. See profiles.js and live.js for the same reasoning.
 *
 * PATHS, NOT AN EXTERNAL SPRITE FILE. The CSP is \`default-src 'none'\`, and \`<use href="/sprite.svg#x">\`
 * is a fetch that would need a directive to permit and that browsers refuse for \`<use>\` besides.
 * Building each \`<svg>\` from a path string needs nothing.
 */

/** Icon geometry, keyed by the name the console calls it. Every path is on a 24×24 viewBox. */
export const ICON_PATHS = {
${symbols.join('\n')}
};

/**
 * One icon element, at a size.
 *
 * STROKE SCALES WITH SIZE and that is not decoration: a stroke frozen at Lucide's own 2 makes a
 * 14px icon read heavier than the 13px text beside it, which is the single most common way an icon
 * set looks bolted on. 01 specifies 1.75 at 16px and below, 2 above.
 *
 * \`aria-hidden\` ALWAYS. An icon in this console never carries meaning without a word: it either
 * sits beside a label, or it is inside a control that has an \`aria-label\` and a tooltip of its own.
 * Marking the glyph hidden is what stops a screen reader announcing it twice.
 */
export function iconSvg(name, size = 16) {
  const path = ICON_PATHS[name];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(size <= 16 ? 1.75 : 2));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  /**
   * \`innerHTML\` on an SVG element, with a value that is NEVER user input.
   *
   * The strings above are generated from files in \`node_modules\` at build time and this module has
   * no other way in — nothing from the API, a device name or a URL reaches this line. That is what
   * makes it safe here and would not make it safe anywhere else in the console, which is why it
   * appears exactly once.
   *
   * An unknown name renders EMPTY rather than falling back to some other glyph. A missing icon that
   * silently draws a different one is a bug that ships; a hole is one somebody fixes.
   */
  if (path) svg.innerHTML = path;
  return svg;
}
`;
}

async function main() {
  const generated = await generate();
  const current = await readFile(OUT, 'utf8').catch(() => null);

  if (current === generated) {
    console.log(`icons.js is in step with lucide (${Object.keys(ICON_MAP).length} icons)`);
    return;
  }
  if (process.argv.includes('--check')) {
    console.error(
      'public/icons.js is out of step with lucide-static.\n' +
      'Run `node apps/api/scripts/build-icon-sprite.mjs` and commit the result.',
    );
    process.exitCode = 1;
    return;
  }
  await writeFile(OUT, generated);
  console.log(`wrote public/icons.js — ${Object.keys(ICON_MAP).length} icons`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
