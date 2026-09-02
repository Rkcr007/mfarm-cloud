/**
 * Build the tarball that goes to npm.
 *
 * `tsc` does the compiling; this file exists for one thing it cannot do, and that thing is the
 * whole reason the published package differs from the repo.
 *
 * THE SHEBANG. `src/bin.ts` begins:
 *
 *     #!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
 *
 * which is correct for the source — running the TypeScript directly is how this repo develops and
 * how `action-test.yml`'s `real-cli` scenario drives the action against a checkout. tsc copies a
 * shebang through verbatim, so without this step the compiled JavaScript would still ask Node to
 * strip types it no longer contains. That is not merely redundant:
 *
 *   - `--experimental-strip-types` is not accepted by every Node a customer might run, and an
 *     unknown flag is a hard startup failure, not a warning. The package would install cleanly and
 *     die on `mfarm --version` with a message about a flag nobody typed.
 *   - `env -S` itself is not portable to every /usr/bin/env in the wild.
 *
 * A published CLI's shebang should ask for the least it can, so the emitted one is `#!/usr/bin/env
 * node` and nothing else.
 */
import { readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const BIN = new URL('dist/bin.js', import.meta.url);
const WANTED = '#!/usr/bin/env node';

await rm(new URL('dist', import.meta.url), { recursive: true, force: true });
execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit', cwd: new URL('.', import.meta.url) });

const source = await readFile(BIN, 'utf8');
if (!source.startsWith('#!')) {
  // Fail rather than prepend. If the shebang has gone missing the entry point has been restructured,
  // and guessing what it should be now is how a broken `bin` gets published.
  throw new Error('dist/bin.js has no shebang — did src/bin.ts change shape?');
}
const rewritten = `${WANTED}\n${source.slice(source.indexOf('\n') + 1)}`;
await writeFile(BIN, rewritten);

// npm sets the executable bit on `bin` entries at install time, but a tarball inspected by hand or
// run straight out of `dist/` should work too.
await chmod(BIN, 0o755);

console.log(`built dist/ — bin.js shebang is now ${WANTED}`);
