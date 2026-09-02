#!/usr/bin/env node
/**
 * The whole package.
 *
 * Deliberately plain JavaScript with no build, no dependencies and no imports: this file's only job
 * is to run correctly on ANY Node a stranger might have — including versions far below what the real
 * CLI supports — and say one true thing. An engine floor, a compile step or a dependency would each
 * be a way for it to fail with something other than its message.
 *
 * Exit 1, not 0. Someone reaching this in CI has a broken pipeline and should find out now, rather
 * than watch a "successful" step that allocated no device and ran no tests.
 */
process.stderr.write(
  'mfarm: this package is a placeholder and does nothing.\n' +
  '\n' +
  'The MFARM CLI is @mfarm/cli:\n' +
  '\n' +
  '  npm install --save-dev @mfarm/cli\n' +
  '\n' +
  'or, without installing:\n' +
  '\n' +
  '  npx --package @mfarm/cli mfarm run --region <region> -- <your test command>\n' +
  '\n' +
  'See https://www.npmjs.com/package/@mfarm/cli\n',
);
process.exit(1);
