/**
 * Where the console sends people, and the one thing on this screen that is a security control.
 *
 * `nextFrom` reads a destination out of a URL, which means it reads it from whoever wrote the link.
 * A sign-in page that redirects wherever `?next=` says is the textbook open redirect: a phishing
 * page links to `/app/signin?next=https://evil.example`, the person signs in to the REAL farm with
 * the real password, and the real farm then hands them to the attacker — with a legitimate origin
 * and a real login in the middle of the flow, which is exactly what makes the next page believable.
 *
 * Nothing else here fails loudly. A bad redirect target still redirects; the browser follows it and
 * the console never sees a thing. So the cases below are written as a list of the shapes an attacker
 * would try rather than as a paraphrase of the implementation, and they are the reason this file
 * exists at all — the rest of the routing is a `switch` that fails visibly the moment it is wrong.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PATHS, nextFrom, routeOf, signinPathFor } from '../src/app/routes.ts';

describe('nextFrom refuses to leave the console', () => {
  test('a path under /app is kept', () => {
    assert.equal(nextFrom('?next=%2Fapp%2Fdevices'), '/app/devices');
  });

  test('nothing to go on falls back to devices', () => {
    assert.equal(nextFrom(''), PATHS.devices);
    assert.equal(nextFrom('?next='), PATHS.devices);
  });

  /**
   * The list an attacker actually tries.
   *
   * `//evil.example` is the one worth naming: it has no scheme, it passes any check that only looks
   * for "http", and a browser reads it as protocol-relative — which is to say, as another origin.
   * `/app` without a trailing slash is here too, because a prefix test written as `startsWith('/app')`
   * would happily accept `/appalling.example` and `/app.evil.example`.
   */
  for (const hostile of [
    'https://evil.example',
    '//evil.example',
    '/appalling',
    '/app.evil.example/x',
    '/v1/auth/logout',
    'javascript:alert(1)',
    'http://localhost:8080/app/devices',
  ]) {
    test(`${hostile} is refused`, () => {
      assert.equal(nextFrom(`?next=${encodeURIComponent(hostile)}`), PATHS.devices);
    });
  }

  test('the sign-in page itself is refused — it would be a redirect loop', () => {
    assert.equal(nextFrom(`?next=${encodeURIComponent(PATHS.signin)}`), PATHS.devices);
  });
});

describe('signinPathFor remembers a deep link and nothing else', () => {
  test('a real screen is carried through', () => {
    assert.equal(
      signinPathFor('/app/devices', ''),
      `${PATHS.signin}?next=${encodeURIComponent('/app/devices')}`,
    );
  });

  test('the query string travels with it', () => {
    assert.equal(
      signinPathFor('/app/devices', '?id=abc'),
      `${PATHS.signin}?next=${encodeURIComponent('/app/devices?id=abc')}`,
    );
  });

  // Remembering these buys nothing: the fallback destination is already the devices screen.
  test('the bare console root is not worth remembering', () => {
    assert.equal(signinPathFor('/app', ''), PATHS.signin);
    assert.equal(signinPathFor('/app/', ''), PATHS.signin);
  });

  test('the sign-in page does not remember itself', () => {
    assert.equal(signinPathFor(PATHS.signin, '?next=%2Fapp%2Fdevices'), PATHS.signin);
  });

  /** The round trip is the property that matters: whatever is remembered must be accepted back. */
  test('what it remembers, nextFrom accepts', () => {
    const asked = '/app/devices?id=abc';
    const search = signinPathFor(asked, '').slice(PATHS.signin.length);
    assert.equal(nextFrom(search), asked);
  });
});

describe('routeOf', () => {
  test('only the sign-in path is the sign-in screen', () => {
    assert.equal(routeOf(PATHS.signin), 'signin');
  });

  // Not a 404: nothing in the console links anywhere else, so the only way to reach an unknown path
  // is to type it, and the device screen is a better answer than an error page for a typo.
  test('everything else is the devices screen', () => {
    for (const p of ['/app', '/app/', '/app/devices', '/app/nonsense']) {
      assert.equal(routeOf(p), 'devices', p);
    }
  });
});
