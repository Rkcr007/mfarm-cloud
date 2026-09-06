/**
 * The landing surface behind the sign-in modal: grid, glow, header, hero, pipeline, footer.
 *
 * Rebuilt from `Farm_app_design_exploration/Sign In.dc.html`. Nothing here is interactive except the
 * two header buttons, and NOTHING HERE IS DATA. The device specs, the "142 PASSED · 3 DEVICES"
 * pill, the FARM REACHABLE badge and the six pipeline steps are illustrative — the artifact says so
 * itself in the footer, and this screen is served to anonymous visitors who are entitled to none of
 * the farm's real state.
 *
 * That is why the whole figure is `aria-hidden`: a screen reader reading out a fictional device
 * count is worse than silence. The header, the heading and the lede are real content and are not
 * hidden.
 */
import type { ReactNode } from 'react';

export type Overlay = 'signin' | 'pricing' | null;

export function Backdrop({ overlay, onOpen, children }: {
  overlay: Overlay;
  onOpen: (o: Exclude<Overlay, null>) => void;
  children: ReactNode;
}) {
  return (
    <div className="si">
      <div className="si-grid" aria-hidden="true" />
      <div className="si-glow" aria-hidden="true" />

      <header className="si-header">
        <div className="si-brandgroup">
          <div className="si-brand">
            <div className="si-mark" aria-hidden="true">M</div>
            <span className="si-wordmark">MFARM</span>
          </div>
          {/*
            FARM REACHABLE is part of the picture, not a health check.
            The vanilla console earns its equivalent pill by calling the genuinely-public `/health`;
            this screen does not, so the badge is inside the `aria-hidden` decorative set and is
            never presented as a live reading. Wiring it to `/health` is a real improvement and a
            separate one — it changes what the screen claims, which is more than a presentation swap.
          */}
          <div className="si-reach" aria-hidden="true">
            <span className="si-reach-dot" />
            <span className="si-reach-text">FARM REACHABLE</span>
          </div>
        </div>
        <div className="si-actions">
          <button
            type="button"
            className="si-ghost"
            aria-expanded={overlay === 'pricing'}
            onClick={() => onOpen('pricing')}
          >
            Pay as you use
          </button>
          <button
            type="button"
            className="si-cta"
            aria-expanded={overlay === 'signin'}
            onClick={() => onOpen('signin')}
          >
            Sign in
          </button>
        </div>
      </header>

      <div className="si-hero">
        <div className="si-hero-inner">
          <div className="si-tags">
            <span className="si-tag">iOS</span>
            <span className="si-tag">ANDROID</span>
            <span className="si-tag si-tag-accent">BUILD YOUR OWN</span>
          </div>
          <h1 className="si-h1">Define the device your test needs. Run it as an org.</h1>
          <p className="si-lede">
            Compose a device from its spec, point your existing suite at one URL, and pay for the
            device-minutes you use.
          </p>
        </div>
      </div>

      <Pipeline />

      <footer className="si-footer">
        <div className="si-steps" aria-hidden="true">
          <span className="si-steps-lead">METERED WHILE RUNNING</span>
          {STEPS.map(([label, delay]) => (
            <Step key={label} label={label} delay={delay} />
          ))}
        </div>
        <div className="si-legal">ILLUSTRATIVE · SELF-HOSTED · v2.4</div>
      </footer>

      {children}
    </div>
  );
}

/** Label and the point in the 18s loop it lights up at, both verbatim from the artifact. */
const STEPS: Array<[string, string]> = [
  ['01 REQUEST', '0s'],
  ['02 BUILD DEVICES', '2.1s'],
  ['03 INSTALL', '6s'],
  ['04 EXECUTE · METERED', '8s'],
  ['05 SHIP', '11.9s'],
  ['06 LIVE', '15.3s'],
];

function Step({ label, delay }: { label: string; delay: string }) {
  return (
    <>
      <span className="si-steps-rule" />
      <span className="si-step" style={{ ['--si-d' as string]: delay }}>{label}</span>
    </>
  );
}

/**
 * request → build → install → execute → ship → live.
 *
 * One 18-second loop shared by every animation in it; the percentages in `signin.css` are what
 * sequence the story, so they are only meaningful together.
 */
function Pipeline() {
  return (
    <div className="si-diagram" aria-hidden="true">
      <div className="si-track">
        <div className="si-node si-node-src">
          <div className="si-dot si-dot-req" />
          <div className="si-node-label">ORG SUITE</div>
          <div className="si-node-meta">POST /session<br />3 devices</div>
        </div>

        <div className="si-wire si-wire-in">
          <div className="si-packet" />
        </div>

        <div className="si-stage">
          <div className="si-devices">
            <Handset
              kind="ios"
              label="iOS"
              meta="iOS 18 · 6.3in · 460ppi"
              chrome={<>
                <div className="si-status">
                  <span className="si-clock">9:41</span>
                  <span className="si-batt-mini"><span className="si-batt-box" /></span>
                </div>
                <div className="si-homebar" />
              </>}
              parts={<>
                <div className="si-part si-notch" />
                <div className="si-part si-btn-side" style={{ left: '-1.5px', top: '22%', height: '6.8%' }} />
                <div className="si-part si-btn-side" style={{ left: '-1.5px', top: '33%', height: '11%' }} />
                <div className="si-part si-btn-side" style={{ right: '-1.5px', top: '29.6%', height: '14.4%' }} />
              </>}
            />
            <Handset
              kind="android"
              label="ANDROID"
              meta="Android 15 · 6.8in · 120Hz"
              chrome={<>
                <div className="si-status">
                  <span className="si-clock">9:41</span>
                  <span className="si-batt-box" />
                </div>
                <div className="si-navbar">
                  <span className="si-nav-square" />
                  <span className="si-nav-circle" />
                  <span className="si-nav-tri" />
                </div>
              </>}
              parts={<>
                <div className="si-part si-lens" />
                <div className="si-part si-btn-side" style={{ right: '-1.5px', top: '25.4%', height: '7.1%' }} />
                <div className="si-part si-btn-side" style={{ right: '-1.5px', top: '35.7%', height: '11.9%' }} />
              </>}
            />
            <Handset
              kind="virtual"
              label="VIRTUAL"
              meta="your spec · built on demand"
              parts={<div className="si-custom">CUSTOM</div>}
            />
          </div>

          <div className="si-meterrow">
            <div className="si-meter"><div className="si-meter-fill" /></div>
            <div className="si-passed">
              <span className="si-passed-mark">✓</span>
              <span className="si-passed-text">142 PASSED · 3 DEVICES</span>
            </div>
          </div>
        </div>

        <div className="si-wire si-wire-out">
          <div className="si-release">
            <span className="si-release-dot" />
            <span className="si-release-text">release</span>
          </div>
        </div>

        <div className="si-node si-node-prod">
          <div className="si-dot si-dot-prod" />
          <div className="si-node-label">PROD</div>
          <div className="si-node-meta si-node-meta-tight">promoted</div>
        </div>

        <div className="si-stub" />

        <div className="si-node si-node-market">
          <div className="si-dot si-dot-market" />
          <div className="si-node-label">MARKET</div>
          <div className="si-livepill">
            <span className="si-livepill-dot" />
            <span className="si-livepill-text">LIVE FOR USERS</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One device in the figure.
 *
 * The virtual one has no metal shell and no status chrome — it is a dashed outline, because it has
 * not been built yet at the point in the loop where it appears. That is the whole idea the third
 * column is carrying, so it is a `kind` rather than a set of optional props that happen to be unset.
 */
function Handset({ kind, label, meta, chrome, parts }: {
  kind: 'ios' | 'android' | 'virtual';
  label: string;
  meta: string;
  chrome?: ReactNode;
  parts?: ReactNode;
}) {
  return (
    <div className={`si-dev si-dev-${kind}`}>
      <div className={`si-body si-body-${kind}`}>
        <div className="si-shell" />
        {kind !== 'virtual' && <div className="si-inner" />}
        <div className="si-screen">
          <div className="si-scan" />
          {chrome}
        </div>
        {parts}
        <div className="si-tile">A</div>
        <div className="si-ripple" />
        <div className="si-ripple si-ripple-2" />
      </div>
      <div className="si-dev-label">{label}</div>
      <div className="si-dev-meta">{meta}</div>
    </div>
  );
}
