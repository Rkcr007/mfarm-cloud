/**
 * The new console, first slice.
 *
 * WHAT THIS IS AND IS NOT, stated plainly because §27 of the direction document is a hard rule and
 * a half-built screen is exactly where it gets broken: the devices below are REAL, fetched from
 * `/v1/devices` with the session cookie, and drawn at the geometry the worker actually reported.
 * The screen inside the device is NOT live — the WebRTC path is not ported yet — so it says so, in
 * those words, instead of showing a picture that implies otherwise.
 *
 * Served at `/app` alongside the existing console at `/`, so neither blocks the other and a cutover
 * is one line in the API's allowlist.
 */
import { useEffect, useState } from 'react';
import { DeviceStage, type DeviceChrome } from './session/DeviceStage.tsx';
import './session/stage.css';
import './shell.css';

interface Device {
  id: string;
  model: string;
  state: string;
  platform: string;
  osVersion: string;
  tier: string;
  region: string;
  profile?: string;
  screen?: { width: number; height: number; density: number };
}

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

const DEFAULT_SCREEN = { width: 1080, height: 2340, density: 420 };

type Load =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'error'; message: string }
  | { status: 'ready'; devices: Device[] };

export function App() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch('/v1/devices', { credentials: 'same-origin' });
        if (!live) return;
        if (res.status === 401) { setLoad({ status: 'signed-out' }); return; }
        if (!res.ok) { setLoad({ status: 'error', message: `The farm answered ${res.status}.` }); return; }
        const body = await res.json();
        const devices: Device[] = body.devices ?? body ?? [];
        setLoad({ status: 'ready', devices });
        setSelected((s) => s ?? devices.find((d) => d.screen)?.id ?? devices[0]?.id ?? null);
      } catch {
        if (live) setLoad({ status: 'error', message: 'The farm could not be reached.' });
      }
    })();
    return () => { live = false; };
  }, []);

  const devices = load.status === 'ready' ? load.devices : [];
  const device = devices.find((d) => d.id === selected);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">MFARM</span>
        <span className="topbar-sep" aria-hidden="true" />
        <span className="topbar-ctx">
          {device ? device.model : 'Console'}
        </span>
        <span className="grow" />
        <span className="pill pill-warn">Preview build · not the live console</span>
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
              onClick={() => setSelected(d.id)}
            >
              <span className="devrow-name">{d.model}</span>
              <span className={`dot dot-${d.state === 'READY' ? 'ok' : d.state === 'OFFLINE' ? 'bad' : 'warn'}`} />
              <span className="devrow-meta">
                {d.screen ? `${d.screen.width}×${d.screen.height} · ${d.screen.density}dpi` : 'no panel reported'}
              </span>
            </button>
          ))}
        </nav>

        <main className="main">
          <DeviceStage
            screen={device?.screen ?? DEFAULT_SCREEN}
            chrome={chromeFor(device)}
            lit={Boolean(device)}
            maxHeight={640}
          >
            {/*
              An honest empty screen. The live view is not ported yet, and a placeholder image here
              would be a picture of a phone pretending to be a phone — exactly the thing §27 forbids.
            */}
            <div className="screen-empty">
              <p>No live stream on this screen yet</p>
              <p className="quiet">
                Device geometry is real. The stream is not ported to this build.
              </p>
            </div>
          </DeviceStage>
        </main>

        <aside className="side" aria-label="Device detail">
          <section className="card">
            <p className="lbl">Device</p>
            {device ? (
              <>
                <Row k="Model" v={device.model} />
                <Row k="Profile" v={device.profile ?? 'none'} />
                <Row k="Panel" v={device.screen ? `${device.screen.width} × ${device.screen.height}` : '—'} />
                <Row k="Density" v={device.screen ? `${device.screen.density} dpi` : '—'} />
                <Row
                  k="Width"
                  v={device.screen ? `${Math.round((device.screen.width * 160) / device.screen.density)} dp` : '—'}
                />
                <Row k="Android" v={device.osVersion} />
                <Row k="State" v={device.state} />
              </>
            ) : (
              <p className="quiet">Pick a device.</p>
            )}
          </section>

          <section className="card">
            <p className="lbl">Not built yet</p>
            <p className="quiet">
              Live view, controls, logs and the app workflow still live on the current console.
              Nothing here is wired to a control that does not work.
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
