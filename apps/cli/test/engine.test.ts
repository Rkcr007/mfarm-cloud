/**
 * The runtime floor.
 *
 * Every case here is a Node this test is not running on, which is the point: the failure mode being
 * guarded against is a customer's CI image, not ours. The boundary is asserted from BOTH sides —
 * a floor that is one patch too high turns away a working runtime, and one patch too low ships the
 * confusing `AbortSignal.any is not a function` this check exists to replace.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_NODE, nodeTooOld } from '../src/engine.ts';

describe('which Node versions are allowed', () => {
  for (const version of ['20.3.0', '20.3.1', '20.4.0', '21.0.0', '22.11.0', '23.11.0', '24.0.0']) {
    test(`${version} is accepted`, () => {
      assert.equal(nodeTooOld(version), null);
    });
  }

  for (const version of ['16.17.0', '18.20.4', '20.0.0', '20.2.9', '19.9.0']) {
    test(`${version} is refused`, () => {
      const message = nodeTooOld(version);
      assert.ok(message, `${version} must be refused`);
      // The message has to carry both numbers or it cannot be acted on: what is needed, and what
      // they have. "Unsupported Node version" sends people to a search engine.
      assert.match(message, /20\.3\.0/);
      assert.ok(message.includes(version), `the message must name the version in use: ${message}`);
    });
  }

  /**
   * The exact boundary, stated independently of the constant.
   *
   * `MIN_NODE` itself must pass and the patch below it must fail. Written from `MIN_NODE` so that
   * raising the floor updates this automatically — but the literal cases above are NOT derived, so
   * a wrong new floor still fails a named test rather than silently agreeing with itself.
   */
  test('the declared minimum passes and the patch below it does not', () => {
    const [maj, min, pat] = MIN_NODE;
    assert.equal(nodeTooOld(`${maj}.${min}.${pat}`), null);
    assert.ok(nodeTooOld(`${maj}.${min}.${pat - 1}`));
  });
});

describe('versions that are not three plain numbers', () => {
  test('a nightly is judged on its numeric prefix', () => {
    assert.equal(nodeTooOld('22.0.0-nightly20240101abcdef'), null);
    assert.ok(nodeTooOld('19.0.0-nightly20240101abcdef'));
  });

  test('a release candidate is judged the same way', () => {
    assert.equal(nodeTooOld('24.0.0-rc.1'), null);
  });

  /**
   * A version this code cannot parse must be refused, never waved through.
   *
   * Waving it through is the tempting default — "we could not tell, so assume it is fine" — and it
   * puts the confusing downstream crash back exactly where a user cannot act on it.
   */
  for (const junk of ['', 'unknown', 'v.x.y', 'null']) {
    test(`"${junk}" is treated as too old rather than assumed fine`, () => {
      assert.ok(nodeTooOld(junk), `${junk} must not be accepted`);
    });
  }
});
