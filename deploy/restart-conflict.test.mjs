/**
 * The stale-container-name parse, executed.
 *
 * `mfarm-deploy.sh` once reported failure on a deploy that had worked: compose refused a container
 * name left behind by an out-of-band `docker compose up -d api`, `set -e` ended the script on that
 * line, and the VERIFICATION step — the only part that decides whether a deploy happened — never
 * ran. The fix retries after clearing the name and, whatever happens, goes on to verify.
 *
 * This is the fragile half of that fix. Docker's wording has changed between versions, the name is
 * quoted and slash-prefixed, and the same sentence also quotes the id of the container holding it.
 * A regex that quietly stopped matching would put the retry back to square one with nothing to say
 * so — and the wrong match would `docker rm -f` a container nobody asked about.
 *
 * Executed rather than read, for the reason `farm-up.test.mjs` records: a test that asserts the text
 * of a script can stay green while the script does nothing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const lib = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'restart-conflict.sh');

const parse = (out) => execFileSync('bash', ['-c',
  `set -uo pipefail; . "$1"; mfarm_conflict_container "$2"`, 'bash', lib, out,
], { encoding: 'utf8' }).trim();

/** The message this was written against, verbatim. */
const REAL = 'Error response from daemon: Conflict. The container name "/mfarm_mfarm-api-1" is '
  + 'already in use by container "8f3c1d2e4b5a6789". You have to remove (or rename) that container '
  + 'to be able to reuse that name.';

describe('the container name a conflict is about', () => {
  test('is pulled out of the real message', () => {
    assert.equal(parse(REAL), 'mfarm_mfarm-api-1');
  });

  test('is the NAME, not the id of the container holding it', () => {
    // The same sentence quotes both. Taking the first quoted string in the message rather than the
    // one after "container name" would remove a container chosen at random.
    assert.notEqual(parse(REAL), '8f3c1d2e4b5a6789');
  });

  test('survives a message with no leading slash', () => {
    assert.equal(
      parse('Conflict. The container name "mfarm-api-1" is already in use by container "abc".'),
      'mfarm-api-1');
  });
});

describe('what it refuses to answer, which is the half that keeps it safe', () => {
  test('ordinary compose output yields nothing', () => {
    assert.equal(parse('Container mfarm-api-1  Started'), '');
  });

  test('A BUSY PORT IS NOT A CONTAINER TO REMOVE', () => {
    // "is already in use" is said about ports and volumes too. Removing a container because a port
    // was taken is precisely the wrong action, and it would look like the fix working.
    assert.equal(
      parse('Error starting userland proxy: listen tcp4 0.0.0.0:3000: bind: address already in use'),
      '');
  });

  test('a Conflict that is not about a name yields nothing', () => {
    assert.equal(parse('Error response from daemon: Conflict. Something else entirely.'), '');
  });

  test('an empty message yields nothing', () => {
    assert.equal(parse(''), '');
  });
});
