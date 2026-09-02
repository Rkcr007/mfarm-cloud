/**
 * The live pixels, and the only thing allowed inside `DeviceStage`'s screen box.
 *
 * The stage draws the chassis; this draws what the device is actually showing. It never invents a
 * frame — when there is nothing to show it says which of the several different nothings this is,
 * because "connecting", "the device publishes no display" and "the lease ended" want three
 * different reactions from the person watching.
 *
 * THE DOM SHAPE IS LOAD-BEARING, in one specific way. `live.js`'s `attachInput` draws its local tap
 * echo into `video.parentElement.querySelector('.dev-taps')`. So the video and that layer must be
 * siblings under one wrapper. Getting this wrong costs no error and no test failure — it silently
 * removes the echo, and the echo is the thing that stops a person tapping twice on a relayed link.
 */
import type { LiveSnapshot } from './useLiveSession.ts';

export interface LiveScreenProps {
  live: LiveSnapshot;
  videoRef: (el: HTMLVideoElement | null) => void;
  onRetry: () => void;
}

/** States in which the socket is up and the device is reachable, whatever the video is doing. */
const ATTACHED = new Set(['authenticated', 'negotiating', 'streaming', 'nostream', 'nodisplay']);

export function LiveScreen({ live, videoRef, onRetry }: LiveScreenProps) {
  const streaming = live.state === 'streaming' && live.stream !== null;

  return (
    <div className="live-fill" data-live={streaming ? 'on' : 'off'}>
      {/*
        Present from the first render and merely hidden until it streams, never conditionally
        mounted. Unmounting a <video> drops its stream and forces a re-decode on the way back, which
        is a visible stutter on the one surface where smoothness IS the product.

        `playsInline` keeps iOS Safari from taking the stream fullscreen on play. `muted` is what
        makes autoplay permissible at all — Cuttlefish sends an audio track, and an unmuted autoplay
        is refused by every browser, which presents as a video that never starts.
      */}
      <video
        ref={videoRef}
        className="live-video"
        autoPlay
        playsInline
        muted
        tabIndex={0}
        aria-label="Live device screen"
      />
      {/* Where live.js appends its tap rings. Must stay a sibling of the video. */}
      <div className="dev-taps" aria-hidden="true" />

      {!streaming && (
        <div className="live-overlay" role="status">
          <LiveMessage live={live} onRetry={onRetry} />
        </div>
      )}
    </div>
  );
}

function LiveMessage({ live, onRetry }: { live: LiveSnapshot; onRetry: () => void }) {
  switch (live.state) {
    case 'idle':
      return <p className="quiet">No session on this device.</p>;

    case 'connecting':
    case 'authenticated':
    case 'negotiating':
      return (
        <>
          <p>{live.state === 'connecting' ? 'Opening the data plane…' : 'Negotiating the stream…'}</p>
          {live.retries > 0 && <p className="quiet">Re-dialled {live.retries}×</p>}
        </>
      );

    /**
     * NOT A FAILURE, and the distinction is the same one `STATES` in `live.js` makes.
     *
     * The socket is up and usable — buttons, screenshots and logs all work — and only the video is
     * missing. Collapsing these into `failed` was tried once on the old console and took the
     * working half of the connection down with the missing half.
     */
    case 'nostream':
      return (
        <>
          <p>This device does not publish a video stream.</p>
          <p className="quiet">{live.detail ?? 'Everything else on the connection still works.'}</p>
        </>
      );

    case 'nodisplay':
      return (
        <>
          <p>Connected, but the device is publishing no display.</p>
          <p className="quiet">{live.detail ?? 'The device itself is fine — a screenshot still works.'}</p>
        </>
      );

    case 'failed':
      return (
        <>
          <p className="bad">{live.detail ?? 'The connection to the device closed.'}</p>
          {/*
            Offered only once the automatic budget is spent. Showing it during backoff invites a
            person to race the retry that is already scheduled, and two dials is two channels.
          */}
          {live.retries >= 4
            ? <button type="button" className="btn" onClick={onRetry}>Try again</button>
            : <p className="quiet">Re-dialling… ({live.retries}/4)</p>}
        </>
      );

    case 'closed':
      return <p className="quiet">Disconnected.</p>;

    default:
      return <p className="quiet">Waiting for the device…</p>;
  }
}

/** The measured numbers, shown only when they mean something. */
export function LiveStatsPill({ live }: { live: LiveSnapshot }) {
  if (!ATTACHED.has(live.state)) return null;
  const { fps, kbps, rtt, ice } = live.stats;
  return (
    <div className="live-pills">
      <span className={`pill ${live.state === 'streaming' ? 'pill-ok' : 'pill-warn'}`}>
        {live.state === 'streaming' ? `LIVE · ${fps} FPS` : live.state.toUpperCase()}
      </span>
      {live.state === 'streaming' && (
        <>
          <span className="pill tabular">{kbps} kbit/s</span>
          {rtt !== null && <span className="pill tabular">{rtt} ms</span>}
          {/*
            `relay` is worth surfacing: it is the mode that costs egress and the mode a LAN-only
            test never exercises, so a farm that has quietly started relaying everything should be
            visible rather than merely slower.
          */}
          {ice && <span className={`pill ${ice === 'relay' ? 'pill-warn' : ''}`}>{ice}</span>}
        </>
      )}
    </div>
  );
}
