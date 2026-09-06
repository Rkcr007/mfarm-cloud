/**
 * The console's unauthenticated entry point.
 *
 * PRESENTATION ONLY. The auth call, the token storage, the session model and the
 * redirect-after-login are the ones that were already there: `login()` in `api.ts` posts to
 * `/v1/auth/login`, the API sets an HttpOnly cookie, the CSRF token goes into the same module-level
 * variable `whoami()` has always kept it in, and the destination comes from `?next=` via
 * `routes.ts`. Nothing about the session changed; the screen in front of it did.
 *
 * Rebuilt from `Farm_app_design_exploration/Sign In.dc.html` — its markup, not its runtime. Every
 * string on this screen is the artifact's, unedited.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, login } from '../api.ts';
import { navigate, nextFrom } from '../routes.ts';
import { Backdrop, type Overlay } from './Backdrop.tsx';
import './signin.css';

/** The artifact's three messages, verbatim. */
const EMPTY_EMAIL = 'Enter the email your administrator gave you.';
const EMPTY_PASSWORD = 'Enter your password.';
const REJECTED = 'That password does not match this account.';

export function SignInScreen({ search, onSignedIn }: {
  search: string;
  /**
   * REQUIRED, and the screen is broken without it.
   *
   * The gate in `App.tsx` decides what renders from a `whoami()` it ran once on mount, and a
   * successful login here does not re-run it. Navigating alone changed the url to `/app/devices`
   * and left the sign-in screen sitting on top of it — a control that looked like it worked and
   * did nothing. Caught by driving the real screen, by none of the checks around it.
   */
  onSignedIn: () => void;
}) {
  /**
   * The modal is open on arrival, which is the one state the artifact does not default to.
   *
   * Its `openOnLoad` prop defaults to "none" because it is a design file and a designer wants to see
   * the landing surface unobstructed. This is the route you land on when you are not signed in, so
   * arriving with the form closed would mean every visitor's first action is finding the button that
   * opens the thing they came for. Closing it is still possible and still returns to that surface.
   */
  const [overlay, setOverlay] = useState<Overlay>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const titleId = useId();

  const close = useCallback(() => { if (!pending) setOverlay(null); }, [pending]);

  /** One overlay at a time: opening either sets `overlay`, and re-opening the open one closes it. */
  const open = useCallback((which: Exclude<Overlay, null>) => {
    setOverlay((o) => (o === which ? null : which));
  }, []);

  // Escape closes whichever is open — the artifact binds this on `window`, and so does this, so it
  // works whether focus is in the modal, in the popover or on the page behind them.
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, close]);

  // Autofocus on open rather than the `autoFocus` attribute: the modal is mounted and unmounted, and
  // `autoFocus` only fires on the first mount of a node React decides to reuse.
  useEffect(() => { if (overlay === 'signin') emailRef.current?.focus(); }, [overlay]);

  /** Typing clears a visible error — it is about the previous attempt, not this one. */
  const onEmail = (v: string) => { setEmail(v); setError(''); };
  const onPassword = (v: string) => { setPassword(v); setError(''); };

  const onSubmit = async (e: React.FormEvent) => {
    // The CSP sends `form-action 'none'`, so an actual submission would be blocked rather than
    // navigating anywhere. This is what makes it not happen in the first place.
    e.preventDefault();
    if (pending) return;

    if (!email.trim()) { setError(EMPTY_EMAIL); emailRef.current?.focus(); return; }
    if (!password) { setError(EMPTY_PASSWORD); return; }

    setPending(true);
    setError('');
    try {
      await login(email, password);
      // BOTH, and in this order. `onSignedIn` is what flips the gate — without it the url changes
      // and this screen stays on top of the one it navigated to. React batches the two, so the
      // device screen is the next paint rather than a frame of sign-in at the devices url.
      onSignedIn();
      navigate(nextFrom(search));
      // No `setPending(false)` on this path deliberately: the request succeeded and this screen is
      // being replaced, and re-enabling a button on a form that is about to unmount is a frame of
      // "you may press this again" that would post a second login.
    } catch (err) {
      /**
       * 401 IS THE ONLY ONE THE DESIGN'S MESSAGE FITS.
       *
       * The brief says a server rejection reads "That password does not match this account.", and
       * that is exactly right for the credentials being wrong. It is not right for the other two
       * things this endpoint does: `/v1/auth/login` rate-limits at ten attempts a minute and
       * answers 429 with how long to wait, and a farm that is down answers nothing at all. Showing
       * the password message for either would send somebody to reset a password that is fine, so
       * those keep the reason they were given — in the same red row inside the modal, never a toast.
       *
       * SPLIT ON `ApiError`, NOT ON `Error`, and that distinction is the whole of this expression.
       * `ApiError` means the farm answered and its `message` is a sentence somebody wrote for a
       * person to read. Anything else is a `TypeError` from `fetch`, whose message is the string
       * "Failed to fetch" — which is what this screen actually put in the red row when it was
       * written the obvious way, because a fallback guarded by `err.message` never fires for the
       * one error that has a useless one.
       */
      const message = err instanceof ApiError
        ? (err.status === 401 ? REJECTED : err.message)
        : 'The farm could not be reached.';
      setError(message);
      setPending(false);
    }
  };

  return (
    <Backdrop overlay={overlay} onOpen={open}>
      {overlay && (
        <button
          type="button"
          className="si-scrim"
          // The scrim is a real button so it is reachable and dismissible without a mouse. Its label
          // is for assistive tech only; visually it is the dimmed page.
          aria-label="Close"
          onClick={close}
        />
      )}

      {overlay === 'signin' && (
        <div className="si-modal-layer">
          <div className="si-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <button type="button" className="si-close" aria-label="Close" onClick={close}>✕</button>

            <div className="si-handset">
              {/* The three side buttons. Decorative metal on a div that is drawn as a phone. */}
              <div className="si-handset-btn" style={{ left: '-2px', top: '96px', height: '24px' }} />
              <div className="si-handset-btn" style={{ left: '-2px', top: '134px', height: '40px' }} />
              <div className="si-handset-btn" style={{ right: '-2px', top: '120px', height: '52px' }} />

              <div className="si-handset-face">
                <div className="si-statusbar" aria-hidden="true">
                  <span className="si-statusbar-time">9:41</span>
                  <span className="si-statusbar-right">
                    <span className="si-signal"><i /><i /><i /><i /></span>
                    <span className="si-batt"><i /></span>
                  </span>
                </div>
                <div className="si-island" aria-hidden="true" />

                <div className="si-notif">
                  <div className="si-notif-icon" aria-hidden="true">M</div>
                  <div className="si-notif-body">
                    <div className="si-notif-head">
                      <span className="si-notif-app">MFARM</span>
                      <span className="si-notif-when">now</span>
                    </div>
                    <div className="si-notif-text">
                      Your admin set a password for this account. Sign in to reach the farm.
                    </div>
                  </div>
                </div>

                <div className="si-head">
                  <h2 className="si-title" id={titleId}>Sign in</h2>
                  <div className="si-host">farm.mfarm.dev</div>
                </div>

                {/*
                  A REAL FORM, so a password manager recognises it, offers to fill it and offers to
                  save afterwards. That is also what makes Enter submit from either field without a
                  keydown handler — it is the browser's behaviour on a form with a submit button.
                */}
                <form onSubmit={onSubmit} aria-busy={pending || undefined}>
                  <div className="si-fields">
                    <div className="si-field">
                      {/* Decorative. The accessible name is the visually-hidden label below. */}
                      <span className="si-field-tag" aria-hidden="true">EMAIL</span>
                      <label className="si-sr" htmlFor="si-email">Email</label>
                      <input
                        id="si-email"
                        ref={emailRef}
                        className="si-input"
                        type="email"
                        name="email"
                        autoComplete="username"
                        // No `spellCheck`/`autoCapitalize` guesswork: `type=email` already turns both
                        // off, and on iOS it is what puts the @ on the keyboard.
                        placeholder="you@mfarm.local"
                        value={email}
                        onChange={(e) => onEmail(e.target.value)}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                      />
                    </div>
                    <div className="si-field-rule" />
                    <div className="si-field">
                      <span className="si-field-tag" aria-hidden="true">PASSWORD</span>
                      <label className="si-sr" htmlFor="si-password">Password</label>
                      <input
                        id="si-password"
                        className="si-input"
                        type="password"
                        name="password"
                        autoComplete="current-password"
                        placeholder="••••••••••••"
                        value={password}
                        onChange={(e) => onPassword(e.target.value)}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                      />
                    </div>
                  </div>

                  {/*
                    `role="alert"` and not a toast. The brief is explicit that every error renders
                    here, and it is the right call independently: a toast for "your password is
                    wrong" appears away from the field that is wrong and disappears while somebody is
                    still reading it.
                  */}
                  {error && (
                    <div className="si-error" id={errorId} role="alert">
                      <span className="si-error-mark" aria-hidden="true">!</span>
                      <span className="si-error-text">{error}</span>
                    </div>
                  )}

                  <button type="submit" className="si-submit" disabled={pending}>Sign in</button>
                </form>

                <div className="si-sessions">Sessions last 12 hours</div>

                <div className="si-modal-foot">
                  <span>SELF-HOSTED</span>
                  <span>v2.4</span>
                </div>

                <div className="si-modal-home" aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>
      )}

      {overlay === 'pricing' && (
        <div className="si-pop" role="dialog" aria-modal="true" aria-label="Pay as you use">
          <div className="si-pop-head">
            <div className="si-pop-icon" aria-hidden="true">M</div>
            <div className="si-pop-body">
              <div className="si-notif-head">
                <span className="si-pop-title">USAGE</span>
                <span className="si-notif-when">now</span>
              </div>
              <div className="si-pop-text">You are billed per device-minute — nothing else.</div>
            </div>
            <button type="button" className="si-pop-close" aria-label="Close" onClick={close}>✕</button>
          </div>
          <div className="si-pop-rows">
            <PopRow k="Metering starts" v="on allocation" />
            <PopRow k="Metering stops" v="on release" />
            <PopRow k="Billed to" v="the organisation" />
          </div>
          <div className="si-pop-note">
            Queued requests are not metered. Your admin can see per-team usage in the organisation
            view.
          </div>
        </div>
      )}
    </Backdrop>
  );
}

function PopRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="si-pop-row">
      <span className="si-pop-k">{k}</span>
      <span className="si-pop-v">{v}</span>
    </div>
  );
}
