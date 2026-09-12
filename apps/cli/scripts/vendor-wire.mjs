/**
 * Copy the tunnel wire definitions out of `@mfarm/protocol` into `apps/cli/src/wire.ts`.
 *
 * WHY A COPY. `@mfarm/cli` is published to npm; `@mfarm/protocol` is `private: true` and exports raw
 * TypeScript, so a tarball importing it fails to resolve on a customer's machine — which is what CI
 * caught. The CLI also ships ZERO runtime dependencies deliberately, because it is a program a
 * customer runs inside their own network and every dependency is one their security review reads.
 *
 * SAME SHAPE AS `apps/api/scripts/build-icon-sprite.mjs`: generated, committed, and re-run in memory
 * by a test that fails when the two drift. Committing a build product goes stale in silence unless
 * something checks, and `wire.ts` carries an ALLOW-LIST — the one thing in this repo it would be
 * worst to have two versions of.
 *
 * TEXT, NOT AST. The regions are delimited by markers in `protocol.ts` and copied verbatim, so what
 * lands here is the same characters a reviewer read there — including the comments that explain why
 * a wildcard also matches its bare domain, which is the sort of reasoning a paraphrase loses.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', '..', '..', 'packages', 'protocol', 'src', 'protocol.ts');
const TARGET = join(HERE, '..', 'src', 'wire.ts');

const START = '/* --- VENDORED REGION START: apps/cli/src/wire.ts';
const END = '/* --- VENDORED REGION END';

const HEADER = `/**
 * GENERATED — DO NOT EDIT. Run \`node apps/cli/scripts/vendor-wire.mjs\` and commit the result.
 *
 * The tunnel wire definitions, copied verbatim out of \`packages/protocol/src/protocol.ts\` between
 * its VENDORED REGION markers. \`apps/cli/test/wire.test.ts\` re-runs the generator in memory and
 * fails when this file drifts from that one.
 *
 * WHY IT IS A COPY rather than an import: \`@mfarm/cli\` is published and \`@mfarm/protocol\` is not —
 * it is \`private: true\` and exports raw TypeScript, so a tarball importing it cannot resolve. The
 * CLI also ships zero runtime dependencies on purpose, because it is a program a customer runs
 * inside their own network. The generator's header says the rest.
 *
 * THE SOURCE OF TRUTH IS \`packages/protocol\`. Change it there.
 */

`;

export async function generate() {
  const src = await readFile(SOURCE, 'utf8');
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(START, from);
    if (start === -1) break;
    // Skip past the marker's own comment block, so the banner does not land in the output.
    const afterMarker = src.indexOf('*/', start);
    if (afterMarker === -1) throw new Error('a VENDORED REGION START marker is unterminated');
    const end = src.indexOf(END, afterMarker);
    if (end === -1) throw new Error('a VENDORED REGION START has no matching END');
    blocks.push(src.slice(afterMarker + 2, end).trim());
    from = end + END.length;
  }
  if (blocks.length === 0) {
    // Loud rather than empty. A generator that silently produces nothing when its markers move
    // would replace a security boundary with an empty file, and the drift test would then be
    // comparing two empty files and passing.
    throw new Error('no VENDORED REGION markers found in protocol.ts — did they move?');
  }
  return `${HEADER}${blocks.join('\n\n')}\n`;
}

// Run directly: write the file. Imported by the test: just `generate()`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await writeFile(TARGET, await generate());
  console.log(`wrote ${TARGET}`);
}
