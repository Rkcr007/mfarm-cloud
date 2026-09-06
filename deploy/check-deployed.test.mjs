/**
 * "Is the farm running main?" — the verdict, executed.
 *
 * D18 and D19 were both the same failure: a farm serving something other than `main` with nothing
 * anywhere reporting it, so an hour of verification measured a build nobody meant to be testing.
 * The gathering is ssh and cannot be unit-tested; the DECISION can, and it is the part that would
 * silently start answering "ok" to everything.
 *
 * Executed rather than read, for the reason `farm-up.test.mjs` records at length: a test that
 * asserts the text of a script can stay green while the script does nothing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const lib = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'deployed-state.sh');

const verdict = (want, got) => execFileSync('bash', ['-c',
  `set -euo pipefail; . "$1"; mfarm_sha_verdict "$2" "$3"`, 'bash', lib, want, got,
], { encoding: 'utf8' }).trim();

const FULL = '1eba6c68b45dc14c400b61486b692cc33545b8bc';

describe('the farm is running main, or it says which part is not', () => {
  test('a full sha that matches is ok', () => {
    assert.equal(verdict(FULL, FULL), 'ok');
  });

  /**
   * `docker ps` reports the full sha and a checkout may be printed either way, so the comparison is
   * on the shorter of the two. A verdict that demanded equal lengths would call a correct farm
   * behind — which is the failure mode that gets a check deleted.
   */
  test('a short sha of the same commit is ok', () => {
    assert.equal(verdict(FULL, FULL.slice(0, 7)), 'ok');
    assert.equal(verdict(FULL, FULL.slice(0, 12)), 'ok');
  });

  test('a different commit is behind, at either length', () => {
    assert.equal(verdict(FULL, '886cb472636646f5bb1b28d82c48dc50dd230969'), 'behind');
    assert.equal(verdict(FULL, '886cb47'), 'behind');
  });

  /**
   * UNKNOWN IS NOT OK, and this is the assertion that matters most. Every gatherer here is an ssh
   * that can fail — a stopped box, a passphrase-locked key, a renamed container. If an unreadable
   * answer scored `ok` the check would go green on a farm it never reached, which is worse than
   * having no check at all.
   */
  test('an answer that could not be read is never ok', () => {
    for (const got of ['', 'unknown', 'abc', '   ']) {
      assert.equal(verdict(FULL, got), 'unknown', `"${got}" must not pass as up to date`);
    }
  });

  test('an unreadable origin/main does not make everything look fine', () => {
    assert.notEqual(verdict('unknown', FULL), 'ok');
  });
});
