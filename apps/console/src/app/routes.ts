/**
 * Routing for the console, which is thirty lines rather than a dependency.
 *
 * There are two screens. A router library would be four hundred kilobytes of matcher, loader and
 * transition machinery to answer a question this file answers with a `switch`, and "no new
 * dependencies" is the constraint the sign-in work was given anyway.
 *
 * THE PATHS ARE REAL PATHS, NOT HASHES, and that costs one line each in the API's allowlist
 * (`routes/ui.ts`) — every one of them serves `app/index.html`. A hash route would have avoided
 * that and would have been the wrong trade: `/app#signin` is not a link anybody can send, a proxy
 * never sees the fragment, and the redirect-after-login below would have had to smuggle its
 * destination through a fragment inside a fragment.
 *
 * A path that IS under `/app` but is not a screen resolves to the devices screen rather than to a
 * 404, because the only way to reach one is to type it: nothing in the console links anywhere else.
 */

import { useSyncExternalStore } from 'react';

/** Vite's `base`. Every path this module produces or parses is under it. */
export const BASE = '/app';

export type Route = 'signin' | 'devices';

export const PATHS: Record<Route, string> = {
  signin: `${BASE}/signin`,
  devices: `${BASE}/devices`,
};

export function routeOf(pathname: string): Route {
  return pathname === PATHS.signin ? 'signin' : 'devices';
}

/**
 * Where to go after signing in, taken from `?next=`.
 *
 * VALIDATED, NOT TRUSTED. `next` arrives in a url, which means it arrives from whoever wrote the
 * link — and a sign-in page that redirects wherever a query parameter says is the textbook open
 * redirect: a phishing page sends `/app/signin?next=https://evil.example`, the person signs in to
 * the real farm, and the real farm hands them to the attacker with the flow looking legitimate the
 * whole way. So this accepts exactly one shape: a path under `/app`, no scheme, no host, and no
 * `//` prefix (which a browser reads as protocol-relative and therefore as another origin).
 */
export function nextFrom(search: string): string {
  const raw = new URLSearchParams(search).get('next');
  if (!raw) return PATHS.devices;
  if (!raw.startsWith(`${BASE}/`) || raw.startsWith('//')) return PATHS.devices;
  // A signed-in person sent back to the sign-in page would bounce between the two forever.
  if (raw === PATHS.signin) return PATHS.devices;
  return raw;
}

export function signinPathFor(pathname: string, search: string): string {
  // `/app` and `/app/` are the devices screen, and remembering them buys nothing — the default
  // destination is already devices. Only a deliberate deep link is worth carrying.
  const asked = pathname + search;
  const worth = pathname.startsWith(`${BASE}/`) && pathname !== PATHS.signin && pathname !== `${BASE}/`;
  return worth ? `${PATHS.signin}?next=${encodeURIComponent(asked)}` : PATHS.signin;
}

/**
 * Send this person to sign in, and remember where they were.
 *
 * Called from two places that must not import each other: the gate in `App.tsx` when its `whoami()`
 * comes back 401, and `DevicesScreen.tsx` when a later request does — which is the ordinary case of
 * a twelve-hour session expiring in a tab that has been open all day.
 */
export function signedOut(): void {
  navigate(signinPathFor(window.location.pathname, window.location.search));
}

/**
 * Navigate without a reload.
 *
 * `replace` is the default for a redirect the person did not ask for — pushing "you were sent to
 * sign in" onto the history stack means Back lands them on the page that redirected them, which
 * redirects again, and the button stops working.
 */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = new URL(to, window.location.origin);
  if (url.pathname + url.search === window.location.pathname + window.location.search) return;
  window.history[opts.replace === false ? 'pushState' : 'replaceState']({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * The current location, as a value React re-renders on.
 *
 * `useSyncExternalStore` rather than `useState` + an effect, because the store here is the browser's
 * own history and an effect-based mirror of it is a frame behind on the first paint — which on this
 * screen is the frame where the gate decides whether to show the sign-in page.
 *
 * The snapshot is a STRING, not an object: this hook is called on every render and returning a
 * freshly-built `{pathname, search}` would be a new identity every time, which is an infinite
 * re-render loop rather than a subtle inefficiency.
 */
export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(subscribe, snapshot, snapshot);
  const url = new URL(href, 'http://l');
  return { pathname: url.pathname, search: url.search };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

/** Server-rendered snapshot is the same function: there is no server, and vite never prerenders. */
function snapshot(): string {
  return window.location.pathname + window.location.search;
}
