/**
 * The new console.
 *
 * THE SCREEN IS LIVE AS OF 2026-09-02. Until then this file rendered real device geometry around an
 * honest empty screen, because §27 forbids a control that implies something works when it does not.
 * The WebRTC path is now ported: `live.js` — the same implementation the old console at `/` runs,
 * imported rather than copied — negotiates the stream, and `LiveController` owns when it exists.
 *
 * WHAT IS STILL NOT HERE, said plainly for the same reason: logcat, the inspector, screenshots and
 * the app workflow all remain on the old console. Nothing below is wired to a control that does
 * nothing.
 *
 * Served at `/app` alongside `/`, so neither blocks the other and a cutover is one line in the
 * API's allowlist.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceStage, type DeviceChrome } from './session/DeviceStage.tsx';
import { LiveScreen, LiveStatsPill } from './session/LiveScreen.tsx';
import { useLiveSession } from './session/useLiveSession.ts';
import { stageScreenFor, widthDp } from './session/geometry.ts';
import {
  ApiError, getSession, listDevices, releaseSession, startSession, whoami,
  type Device, type SessionDetail,
} from './api.ts';
import './session/stage.css';
import './session/live.css';
import './shell.css';

/**
 * Device chrome, keyed by the SAME profile ids the worker uses.
 *
 * Presentation only — nothing here reaches a device, and geometry is never taken from this table.
 * An unknown or absent profile falls back rather than failing: two of this farm's four devices are
 * deliberately unprofiled, every physical handset is, and a worker one version ahead sends a
 * profile this build has never heard of. That is the ordinary case, not an error.
 */
const CHROME: Record<string, DeviceChrome> = {
  'mfarm-x1-pro': {
    radiusPct: 4.5,
    bezelPx: 9,
    cutout: { xPct: 50, yPct: 1.55, dPct: 3.4 },
    buttons: [
      { side: 'right', topPct: 20, lenPct: 7 },
      { side: 'right', topPct: 29, lenPct: 5 },
    ],
  },
  'mfarm-x1': {
    radiusPct: 7.5,
    bezelPx: 10,
    cutout: { xPct: 50, yPct: 1.8, dPct: 3.8 },
    buttons: [
      { side: 'right', topPct: 21, lenPct: 7.5 },
      { side: 'right', topPct: 31, lenPct: 5.5 },
    ],
  },
};

const PLAIN: DeviceChrome = { radiusPct: 2.5, bezelPx: 8, cutout: null, buttons: [] };

const chromeFor = (d: Device | undefined): DeviceChrome =>
  (d?.profile && CHROME[d.profile]) || PLAIN;



type Load =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'error'; message: string }
  | { status: 'ready'; devices: Device[] };

/** What we hold, if anything. `starting` is separate so the button can disable without lying. */
type Held =
  | { status: 'none' }
  | { status: 'starting' }
  | { status: 'queued'; id: string }
  | { status: 'held'; detail: SessionDetail }
  | { status: 'error'; message: string };

/**
 * Three tones, not two, and the middle one is the whole point.
 *
 * This picker used to draw everything that was not READY or OFFLINE as `warn`, which put a device
 * being restored and a device that failed its health checks on the same amber dot. That is the
 * defect the old console was caught making in words — the Launch screen called a QUARANTINED
 * handset "1 busy" while the Health screen, reading the same API, called it "Quarantined" — and it
 * tells a tester to wait for a device nobody is coming to fix.
 *
 * So: `warn` is reserved for the states that RESOLVE ON THEIR OWN, and `bad` covers the ones that
 * need somebody to do something. PREPARING is a resolving state — an operator has already acted on
 * it, and the farm ends the attempt either way within RECOVERY_TIMEOUT_MS (ADR-0024).
 */
const NEEDS_A_PERSON = new Set(['OFFLINE', 'QUARANTINED', 'EVICTED']);

function dotFor(state: string): 'ok' | 'warn' | 'bad' {
  if (state === 'READY') return 'ok';
  return NEEDS_A_PERSON.has(state) ? 'bad' : 'warn';
}

/** Hover text, because a dot alone never carries a state — the old console's rule, kept. */
const STATE_NOTE: Record<string, string> = {
  READY: 'Available now',
  RESERVED: 'Allocated, session not live yet',
  SESSION_ACTIVE: 'A session is holding it',
  BOOTING: 'Coming up from snapshot',
  CLEANING: 'Restoring its snapshot',
  PREPARING: 'Recovering from quarantine — not available until it passes a health check',
  QUARANTINED: 'Quarantined: out of the pool until an operator releases it',
  OFFLINE: 'Its host has not reported it',
  EVICTED: 'Removed from the fleet',
};

export function App() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [held, setHeld] = useState<Held>({ status: 'none' });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // `whoami` first: it is the sign-in check AND it is what recovers the CSRF token, without
        // which every mutation below would 403 with a message about a header nobody set.
        await whoami();
        const devices = await listDevices();
        if (!live) return;
        setLoad({ status: 'ready', devices });
        setSelected((s) => s ?? devices.find((d) => d.screen)?.id ?? devices[0]?.id ?? null);
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) { setLoad({ status: 'signed-out' }); return; }
        setLoad({ status: 'error', message: err instanceof Error ? err.message : 'The farm could not be reached.' });
      }
    })();
    return () => { live = false; };
  }, []);

  const devices = load.status === 'ready' ? load.devices : [];
  const device = devices.find((d) => d.id === selected);

  /**
   * The connection target, or null when we hold nothing.
   *
   * `browserEndpoint` is required rather than optional-with-a-fallback: the API composes a
   * same-origin `/dp/<hostId>` for every host since the ADR-0007 amendment, so its absence means a
   * control plane too old to talk to, and inventing a url would produce a socket that cannot open.
   */
  const target = held.status === 'held' && held.detail.dataPlane
    ? {
      sessionId: held.detail.session.id,
      url: held.detail.dataPlane.browserEndpoint,
      token: held.detail.dataPlane.token,
      iceServers: held.detail.ice?.iceServers,
    }
    : null;

  const { live, videoRef, retry } = useLiveSession(target);

  /**
   * The stage's geometry, in priority order.
   *
   * THE LIVE PANEL WINS. It is the panel the stream is actually encoded from, and the element's
   * aspect ratio is what `live.js` scales touches against — so drawing the registered panel while
   * the device encodes another one letterboxes the video and puts every tap off by the crop. The
   * registered screen is the right answer only before a session exists.
   */
  const stageScreen = stageScreenFor(live.screen, device?.screen);

  const onStart = useCallback(async () => {
    if (!device) return;
    setHeld({ status: 'starting' });
    try {
      const detail = await startSession(device);
      setHeld(detail.dataPlane
        ? { status: 'held', detail }
        : { status: 'queued', id: detail.session.id });
    } catch (err) {
      setHeld({ status: 'error', message: err instanceof Error ? err.message : 'Could not start a session.' });
    }
  }, [device]);

  const onRelease = useCallback(async () => {
    const id = held.status === 'held' ? held.detail.session.id : held.status === 'queued' ? held.id : null;
    if (!id) return;
    // Optimistic, and deliberately so: `useLiveSession` tears the socket down the moment `target`
    // goes null, and waiting for the DELETE to answer would hold a channel open across the round
    // trip for no benefit. A failed release is reported, and the reaper is the backstop either way.
    setHeld({ status: 'none' });
    try { await releaseSession(id); } catch { /* the lease expires on its own */ }
  }, [held]);

  /** A queued session has no device yet. Poll until it does, or until the person gives up. */
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (held.status !== 'queued') return;
    let live = true;
    const tick = async () => {
      try {
        const detail = await getSession(held.id);
        if (!live) return;
        if (detail.dataPlane) { setHeld({ status: 'held', detail }); return; }
      } catch { /* transient; the next tick tries again */ }
      if (live) pollRef.current = setTimeout(tick, 2_000);
    };
    pollRef.current = setTimeout(tick, 2_000);
    return () => { live = false; if (pollRef.current) clearTimeout(pollRef.current); };
  }, [held]);

  const busy = held.status === 'starting';
  const holding = held.status === 'held' || held.status === 'queued';

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">MFARM</span>
        <span className="topbar-sep" aria-hidden="true" />
        <span className="topbar-ctx">{device ? device.model : 'Console'}</span>
        <span className="grow" />
        <span className="pill pill-warn">Preview build · live view only</span>
      </header>

      <div className="body">
        <nav className="devlist" aria-label="Devices">
          <p className="lbl">Devices</p>
          {load.status === 'loading' && <p className="quiet">Asking the farm…</p>}
          {load.status === 'signed-out' && (
            <p className="quiet">
              Not signed in. Sign in on the <a href="/">current console</a>, then reload this page —
              it uses the same session.
            </p>
          )}
          {load.status === 'error' && <p className="quiet bad">{load.message}</p>}
          {devices.map((d) => (
            <button
              key={d.id}
              type="button"
              className="devrow"
              aria-current={d.id === selected}
              // Switching device while holding one would silently strand the lease, so it is
              // refused rather than handled — release is a decision, not a side effect of a click.
              disabled={holding && d.id !== selected}
              onClick={() => setSelected(d.id)}
            >
              <span className="devrow-name">{d.model}</span>
              <span className={`dot dot-${dotFor(d.state)}`} title={STATE_NOTE[d.state] ?? d.state} />
              <span className="devrow-meta">
                {d.screen ? `${d.screen.width}×${d.screen.height} · ${d.screen.density}dpi` : 'no panel reported'}
              </span>
            </button>
          ))}
        </nav>

        <main className="main">
          <DeviceStage
            screen={stageScreen}
            chrome={chromeFor(device)}
            lit={live.state === 'streaming'}
            maxHeight={640}
          >
            {target
              ? <LiveScreen live={live} videoRef={videoRef} onRetry={retry} />
              : (
                <div className="screen-empty">
                  <p>{held.status === 'queued' ? 'Queued for a device…' : 'No session on this device'}</p>
                  <p className="quiet">
                    {held.status === 'queued'
                      ? 'Nothing is free right now. It starts automatically when one is.'
                      : 'Device geometry is real. Start a session to see the screen.'}
                  </p>
                </div>
              )}
          </DeviceStage>

          <div className="live-actions">
            {!holding && (
              <button type="button" className="btn btn-primary" disabled={!device || busy} onClick={onStart}>
                {busy ? 'Starting…' : 'Start session'}
              </button>
            )}
            {holding && (
              <button type="button" className="btn" onClick={onRelease}>Release</button>
            )}
          </div>
          <LiveStatsPill live={live} />
          {held.status === 'error' && <p className="quiet bad">{held.message}</p>}
        </main>

        <aside className="side" aria-label="Device detail">
          <section className="card">
            <p className="lbl">Device</p>
            {device ? (
              <>
                <Row k="Model" v={device.model} />
                <Row k="Profile" v={device.profile ?? 'none'} />
                <Row k="Panel" v={`${stageScreen.width} × ${stageScreen.height}`} />
                <Row k="Density" v={`${stageScreen.density} dpi`} />
                <Row k="Width" v={`${widthDp(stageScreen)} dp`} />
                <Row k="Android" v={device.osVersion} />
                <Row k="State" v={device.state} />
                {/* Says which panel is on screen, because the two can disagree and the difference
                    is exactly what decides whether taps land where they look. */}
                <Row k="Panel from" v={live.screen ? 'live session' : 'registration'} />
              </>
            ) : (
              <p className="quiet">Pick a device.</p>
            )}
          </section>

          {live.notices.length > 0 && (
            <section className="card">
              <p className="lbl">Device said</p>
              {/* Non-fatal refusals — a rotate a portrait-locked app declined, an input overrun.
                  They belong beside a device that is still streaming, never in place of it. */}
              {live.notices.slice(-5).map((n, i) => (
                <p key={`${i}-${n}`} className="quiet">{n}</p>
              ))}
            </section>
          )}

          <section className="card">
            <p className="lbl">Not built yet</p>
            <p className="quiet">
              Logs, the inspector, screenshots and the app workflow still live on the{' '}
              <a href="/">current console</a>.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row">
      <span>{k}</span>
      <b className="tabular">{v}</b>
    </div>
  );
}
