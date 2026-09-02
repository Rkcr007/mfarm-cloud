/**
 * The placeholder has one job and two ways to fail at it silently.
 *
 * It could stop naming the real package — leaving whoever typed `npx mfarm` with an error and no
 * idea what to do next. Or it could start exiting 0, which is worse: a CI step that "passes" having
 * allocated no device and run no tests, which is exactly the outcome that looks like success and is
 * not.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../src/bin.js', import.meta.url));

function runIt() {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN], (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

describe('the unscoped mfarm placeholder', () => {
  test('exits non-zero, so a CI pipeline stops rather than reporting success', async () => {
    const { code } = await runIt();
    assert.equal(code, 1);
  });

  test('names the package the user actually wants', async () => {
    const { stderr } = await runIt();
    assert.match(stderr, /@mfarm\/cli/);
  });

  test('says what to type, not merely what went wrong', async () => {
    const { stderr } = await runIt();
    assert.match(stderr, /npm install --save-dev @mfarm\/cli/);
  });

  test('writes to stderr, leaving stdout clean for anything piping it', async () => {
    const { stdout, stderr } = await runIt();
    assert.equal(stdout, '');
    assert.ok(stderr.length > 0);
  });
});
