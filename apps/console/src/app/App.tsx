/**
 * The console's root: the session gate, and the two screens either side of it.
 *
 * THE RULE IS ONE SENTENCE — no valid session, no screen but sign-in. `whoami()` is what decides,
 * and it is the same call this console has always made first: a 401 from it is what "not signed in"
 * means here, and its success is what recovers the CSRF token every mutation on the device screen
 * needs. Nothing about that changed. What changed is where a 401 goes.
 *
 * IT RENDERS NOTHING WHILE IT IS ASKING, deliberately. The alternatives are both worse: showing the
 * device screen optimistically means a signed-out visitor watches a fleet page appear and then be
 * yanked away, and showing the sign-in screen optimistically means a signed-in person is shown a
 * password box for one round trip on every reload — and, on a farm on a slow link, has time to
 * start typing into it. The check is one same-origin request against an API that is already warm.
 * A blank frame is the honest thing to show while you genuinely do not know.
 */
import { useEffect, useState } from 'react';
import { ApiError, whoami } from './api.ts';
import { DevicesScreen } from './DevicesScreen.tsx';
import { SignInScreen } from './signin/SignInScreen.tsx';
import { navigate, nextFrom, routeOf, signedOut, useLocation } from './routes.ts';

type Gate =
  | { status: 'checking' }
  /**
   * `unreachable` is NOT `out`, and keeping them apart is the point of this type.
   *
   * A farm that is down answers `whoami` with a network error, not a 401. Folding that into
   * "signed out" would put a password box in front of somebody whose password is fine and whose
   * session is fine — they would type it, the login would fail the same way, and the screen would
   * tell them their password was wrong. The device screen already knows how to say the farm could
   * not be reached, and it says it without asking for a credential first.
   */
  | { status: 'unreachable' }
  | { status: 'out' }
  | { status: 'in' };

export function App() {
  const { pathname, search } = useLocation();
  const [gate, setGate] = useState<Gate>({ status: 'checking' });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        await whoami();
        if (live) setGate({ status: 'in' });
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) { setGate({ status: 'out' }); signedOut(); return; }
        setGate({ status: 'unreachable' });
      }
    })();
    return () => { live = false; };
  }, []);

  /**
   * A signed-in person on the sign-in route goes where they were headed.
   *
   * Not the same path as signing in — that one redirects itself. This is for arriving at
   * `/app/signin` with a session already in the cookie: a bookmark, a link somebody sent, a typed
   * url, or a second tab opened while the first is signed in. Without it the gate would render
   * `null` for that route forever, which is a blank page for somebody who is signed in and fine.
   */
  useEffect(() => {
    if (gate.status === 'in' && routeOf(pathname) === 'signin') navigate(nextFrom(search));
  }, [gate.status, pathname, search]);

  if (gate.status === 'checking') return null;

  const signIn = <SignInScreen search={search} onSignedIn={() => setGate({ status: 'in' })} />;

  // Signed out: the sign-in screen, whatever the url says. `signedOut()` above has already put the
  // right url in the bar, but rendering on the state rather than on the route means a slow history
  // update can never leave a signed-out visitor looking at the device screen.
  if (gate.status === 'out') return signIn;

  /**
   * FARM DOWN: honour the route, and let both screens say so in their own words.
   *
   * This branch used to fall through to the one below and hit its `return null`, which meant a
   * person who reloaded `/app/signin` while the API was down got a permanently blank page — the
   * gate never learns better, because nothing retries, and the effect that redirects only runs for
   * `in`. Found by reading this tail back, not by any check: every screenshot and every test had a
   * reachable farm, so nothing here was ever asked the question.
   *
   * Either screen is honest about it. The sign-in form's submit reports the failure in its error
   * row, and the device screen already reports it in place of a fleet.
   */
  if (gate.status === 'unreachable') {
    return routeOf(pathname) === 'signin' ? signIn : <DevicesScreen />;
  }

  // Signed in, but still on `/app/signin` for the one frame before the effect above redirects.
  if (routeOf(pathname) === 'signin') return null;

  return <DevicesScreen />;
}
