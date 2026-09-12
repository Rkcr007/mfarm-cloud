/**
 * The vendored wire definitions, against the protocol they are copied from.
 *
 * `src/wire.ts` is a build product that is checked in — it has to be, because this package is
 * PUBLISHED with zero runtime dependencies and `@mfarm/protocol` is `private: true` and exports raw
 * TypeScript, so a tarball importing it cannot resolve on a customer's machine. CI caught exactly
 * that, which is why the copy exists at all.
 *
 * The cost of committing a build product is that it goes stale in silence: somebody tightens the
 * allow-list in `packages/protocol`, nothing moves `wire.ts`, and the CLI keeps enforcing last
 * month's rules — on the one file in this repo where two versions would be worst. So the generator
 * is re-run IN MEMORY here and compared against what is on disk. Same shape as `icons.test.ts`, and
 * for the same reason.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../scripts/vendor-wire.mjs';
import { tunnelAllows, isValidTunnelName, isProxyFrame } from '../src/wire.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('the vendored wire definitions', () => {
  test('the committed file is what the generator produces', async () => {
    const [onDisk, fresh] = await Promise.all([
      readFile(join(SRC, 'wire.ts'), 'utf8'),
      generate(),
    ]);
    assert.equal(
      onDisk,
      fresh,
      'apps/cli/src/wire.ts is out of step with packages/protocol.\n'
      + 'Run `node apps/cli/scripts/vendor-wire.mjs` and commit the result.',
    );
  });

  /**
   * THE GENERATOR MUST NOT SILENTLY PRODUCE NOTHING. If the markers in `protocol.ts` are moved or
   * renamed, an empty output would make the test above compare two empty files and pass — replacing
   * a security boundary with nothing and reporting green.
   */
  test('the generator carries the definitions that matter', async () => {
    const fresh = await generate();
    for (const name of ['tunnelAllows', 'isValidTunnelName', 'isProxyFrame', 'TunnelAllowRule', 'TunnelHello']) {
      assert.ok(fresh.includes(name), `the vendored copy lost ${name} — check the markers`);
    }
    assert.ok(fresh.length > 2000, 'the generated file is suspiciously small');
  });

  /**
   * AND IT MUST BEHAVE. A byte comparison proves the text matches; this proves the text that
   * matched is the text that works, so a generator bug cannot ship a file that is faithfully copied
   * and syntactically inert.
   */
  test('the copy enforces the allow-list the protocol describes', () => {
    assert.equal(tunnelAllows([{ host: '*.acme.internal' }], 'api.acme.internal', 443), true);
    assert.equal(tunnelAllows([{ host: '*.acme.internal' }], 'acme.internal', 443), true);
    assert.equal(tunnelAllows([{ host: '*.acme.internal' }], 'acme.internal.evil.com', 443), false);
    assert.equal(tunnelAllows([{ host: 'localhost', port: 3000 }], 'localhost', 3001), false);
    assert.equal(tunnelAllows([], 'anything', 80), false, 'the default is deny');
    assert.equal(isValidTunnelName('staging'), true);
    assert.equal(isValidTunnelName('Staging Env'), false);
    assert.equal(isProxyFrame({ k: 'req', method: 'GET', url: 'http://x/', headers: {} }), true);
    assert.equal(isProxyFrame({ k: 'nope' }), false);
  });

  /**
   * NOTHING IN THE PUBLISHED SOURCE MAY IMPORT THE PRIVATE PACKAGE. That is the defect this whole
   * arrangement exists to prevent, and it shipped once: the tarball installed cleanly and died on
   * `Cannot find package '@mfarm/protocol'` — taking the whole CLI down, not just the tunnel, since
   * `bin.ts` imports it at the top level.
   */
  test('no published source imports @mfarm/protocol', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(SRC)).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 4, `expected several source files, found ${files.join(', ')}`);
    for (const f of files) {
      const body = await readFile(join(SRC, f), 'utf8');
      assert.ok(
        !/from\s+'@mfarm\//.test(body),
        `src/${f} imports a workspace package. The published tarball cannot resolve one — `
        + 'vendor what it needs through `scripts/vendor-wire.mjs` instead.',
      );
    }
  });
});
