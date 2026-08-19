/**
 * The live device connection — one session, one socket, one peer connection (ADR-0007).
 *
 * Kept out of console.js because it is the only part of this console that is not a render function.
 * Everything else here draws state that a poll fetched; this holds a socket open, negotiates media,
 * and pushes input at whatever rate a person's finger moves.
 *
 * THE SHAPE, because it is easy to get wrong from the outside:
 *
 *   browser ──wss──▶ console ingress ──▶ worker data plane ──▶ cvd operator   (signalling only)
 *   browser ◀════════════════ WebRTC, direct or via TURN ═══════════▶ device  (media and input)
 *
 * The socket carries the negotiation and nothing else that moves. Once `streaming` is reached, every
 * frame and every tap is on the peer connection — so a slow control plane, a restarted API or a
 * proxy hiccup costs a reconnect, never frame rate.
 *
 * The message vocabulary on the WebSocket is the worker's (`t: 'hello' | 'signal' | 'logcat' | …`).
 * The vocabulary INSIDE `signal` payloads is Cuttlefish's, and this file is the only place in the
 * repo that knows it.
 */

/**
 * What a caller may see in `onState`, roughly in the order they happen.
 *
 * `nostream` is NOT a failure and the distinction is load-bearing. It means the grant was accepted,
 * the socket is open and usable — logcat, screenshots and input all work through it — and only the
 * video is unavailable, because this device tier has nothing that negotiates one. Collapsing it into
 * `failed` was the first thing tried and it took the working half of the connection down with the
 * missing half: a device with no live view lost its log pane too.
 */
export const STATES = [
  'idle', 'connecting', 'authenticated', 'negotiating', 'streaming', 'nostream', 'nodisplay',
  'closed', 'failed',
];

/** States in which the socket is up and the device is reachable, whatever the video is doing. */
export const ATTACHED = new Set(['authenticated', 'negotiating', 'streaming', 'nostream', 'nodisplay']);

/**
 * How long a CONNECTED peer connection may go without offering a display before we say so.
 *
 * This is not a guess at network latency — by the time it starts, ICE has completed and media is
 * already flowing. It is the window in which a device that is going to publish a display has
 * published one.
 *
 * OBSERVED ON REAL HARDWARE, which is why it exists: a Cuttlefish host whose webRTC process
 * registers `displays: []` completes the whole negotiation, sends an audio track, and never sends
 * video. Without this the viewer sits on "Negotiating…" forever — a populated device list over a
 * dead stream, with nothing in any log, which is the exact failure shape ADR-0005 was written
 * about. The guest is fine in that state: `adb screencap` returns a real frame.
 */
const DISPLAY_GRACE_MS = 9_000;

/**
 * Cuttlefish's own scaling rule, kept verbatim.
 *
 * Coordinates are scaled by the ratio of the video's INTRINSIC width to its RENDERED width, and the
 * height is deliberately not consulted — the aspect ratio is preserved by the element, so one ratio
 * describes both axes and reading `offsetHeight` on a letterboxed element gives the wrong one.
 *
 * Before the first frame `videoWidth` is 0. Cuttlefish sends 0,0 in that case rather than skipping
 * the event, on the grounds that a click at 0,0 is no more dangerous than a click anywhere else on
 * a screen the user cannot see. Same choice here, for the same reason.
 */
function scale(video, x, y) {
  const intrinsic = video.videoWidth || 1;
  const rendered = video.offsetWidth || 1;
  const k = intrinsic / rendered;
  return [Math.trunc(x * k), Math.trunc(y * k)];
}

export class LiveSession {
  /**
   * @param {object} o
   * @param {string} o.url            wss url for this session's host, from `dataPlane.browserEndpoint`
   * @param {string} o.token          the Ed25519 grant, from `dataPlane.token`
   * @param {object[]} [o.iceServers] control-plane-minted TURN. Wins over whatever the host suggests.
   * @param {(state: string, detail?: string) => void} o.onState
   * @param {(stream: MediaStream, label: string) => void} o.onStream
   * @param {(lines: string[]) => void} [o.onLog]
   * @param {(shot: {data: string, contentType: string, takenAt: string}) => void} [o.onScreenshot]
   * @param {(message: string) => void} [o.onNotice]  non-fatal: a dropped log batch, a refused verb
   */
  constructor(o) {
    this.o = o;
    this.state = 'idle';
    this.ws = null;
    this.pc = null;
    this.input = null;
    this.control = null;
    this.video = null;
    /** The stream id, which is also the `device_label` the device matches touches against. */
    this.label = 'display_0';
    this.deviceInfo = null;
    this.screen = null;
    this.closedByUs = false;
    this.pending = new Map();
    this.stats = { fps: 0, kbps: 0, rtt: null, ice: null };
    this.statsTimer = null;
    this.displayTimer = null;
    this.activePointers = new Set();
  }

  /* ------------------------------------------------------------------ lifecycle */

  connect() {
    if (this.ws) return;
    this.#state('connecting');
    let ws;
    try {
      ws = new WebSocket(this.o.url);
    } catch (e) {
      return this.#state('failed', `That data-plane address is not usable: ${e.message}`);
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: this.o.token }));
    ws.onmessage = (ev) => this.#onWorkerMessage(ev.data);
    ws.onerror = () => { /* onclose always follows, and carries the better message */ };
    ws.onclose = () => {
      if (this.closedByUs || this.state === 'failed') return;
      // Distinguished from a device fault on purpose: a socket that closes before the grant is
      // accepted is almost always the route (no ingress rule, wrong host id), and a socket that
      // closes afterwards is almost always the lease ending.
      this.#state('failed', this.state === 'connecting'
        ? 'The data plane closed the connection before this session was accepted. Check that the ingress proxies /dp to the worker.'
        : 'The connection to the device closed.');
    };
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.displayTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    try { this.pc?.close(); } catch { /* already closed */ }
    try { this.ws?.close(); } catch { /* already closed */ }
    this.pc = null;
    this.ws = null;
    this.#state('closed');
  }

  #state(state, detail) {
    if (this.state === state && !detail) return;
    this.state = state;
    this.o.onState?.(state, detail);
  }

  #send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /* ------------------------------------------------------------------ worker protocol */

  #onWorkerMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.t) {
      case 'ready':
        // The worker accepted the grant. `device.screen` is the control plane's idea of the panel;
        // the video's own intrinsic size is what input is actually scaled against, because a device
        // whose display was resized at boot would otherwise take taps in the wrong place.
        this.screen = msg.device?.screen || null;
        this.capabilities = msg.device?.capabilities || [];
        this.#state('authenticated');
        this.#send({ t: 'signal-open' });
        return;

      case 'signal-ready':
        this.deviceInfo = msg.deviceInfo;
        return void this.#negotiate(msg.iceServers || []);

      case 'signal':
        return this.#onDevicePayload(msg.payload);

      case 'signal-error':
        // No video. Everything else on this socket keeps working, so the connection is not failed —
        // see the note on STATES. A negotiation that dies AFTER it started is a different case and
        // is reported by `onconnectionstatechange` as a genuine failure.
        return this.#state(this.state === 'streaming' ? 'failed' : 'nostream', msg.message);

      case 'logcat':
        return void this.o.onLog?.(msg.lines || []);
      case 'logcat-dropped':
        return void this.o.onNotice?.(`${msg.lines} log lines were dropped — the device is louder than this connection.`);
      case 'logcat-error':
        return void this.o.onNotice?.(msg.message);
      case 'logcat-started':
        return;

      case 'screenshot': {
        const r = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        r?.resolve(msg);
        this.o.onScreenshot?.(msg);
        return;
      }
      case 'screenshot-error': {
        const r = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        r ? r.reject(new Error(msg.message)) : this.o.onNotice?.(msg.message);
        return;
      }

      case 'error':
        // The worker's refusals are terminal by construction — it closes the socket after each one.
        return this.#state('failed', msg.message || msg.code);
      default:
        return;
    }
  }

  /* ------------------------------------------------------------------ WebRTC */

  async #negotiate(hostIceServers) {
    // Control-plane credentials first. They expire with the session; the host's own suggestions do
    // not expire at all and are only useful on a network where a relay was never needed.
    const iceServers = (this.o.iceServers?.length ? this.o.iceServers : hostIceServers) || [];
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    this.#state('negotiating');

    // Created by us, exactly as Cuttlefish's own client does. The device matches on the label.
    this.input = pc.createDataChannel('input-channel');

    // `device-control` is created by the DEVICE, so it arrives as an event rather than being asked
    // for. It carries the hardware buttons — home, back, menu, power.
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === 'device-control') this.control = ev.channel;
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!stream) return;
      // Cuttlefish names display streams `display_<n>` and audio streams something else. Only the
      // displays are rendered here; taking any stream would put an audio track in a <video> and
      // show a black rectangle.
      if (!stream.id.startsWith('display_')) return;
      this.label = stream.id;
      clearTimeout(this.displayTimer);
      this.o.onStream?.(stream, stream.id);
      this.#state('streaming');
      this.#watchStats();
    };

    pc.onicecandidate = (ev) => {
      // The final candidate is null and Firefox's penultimate one is empty; neither is sendable.
      if (ev.candidate && ev.candidate.candidate) {
        this.#send({ t: 'signal', payload: { type: 'ice-candidate', candidate: ev.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      if (pc.connectionState === 'connected' && this.state !== 'streaming') {
        // Connected, but nothing has arrived on `ontrack` with a display stream yet. Give it a
        // moment, then stop pretending the negotiation is still in progress — it finished.
        clearTimeout(this.displayTimer);
        this.displayTimer = setTimeout(() => {
          if (this.state === 'streaming' || !this.pc) return;
          this.#state('nodisplay',
            'The device connected and is sending audio, but it is not publishing a display, so there '
            + 'is no video to show. On a Cuttlefish host this means its webRTC process registered no '
            + 'displays — the device itself is fine, and a screenshot still works.');
        }, DISPLAY_GRACE_MS);
      }
      if (pc.connectionState === 'failed') {
        this.#state('failed',
          iceServers.length
            ? 'The media connection failed. The relay answered but no path to the device could be established.'
            : 'The media connection failed, and no TURN relay is configured — a direct path only exists on the same network as the farm.');
      }
      if (pc.connectionState === 'disconnected') this.#state('failed', 'The media connection dropped.');
    };

    // The device offers, we answer. `request-offer` carries the ice servers the DEVICE should use,
    // which is why the minted credentials have to reach it and not only this browser.
    this.#send({ t: 'signal', payload: { type: 'request-offer', ice_servers: iceServers } });
  }

  async #onDevicePayload(payload) {
    const pc = this.pc;
    if (!pc || !payload || typeof payload !== 'object') return;
    try {
      switch (payload.type) {
        case 'offer': {
          await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.#send({ t: 'signal', payload: { type: 'answer', sdp: answer.sdp } });
          return;
        }
        case 'answer':
          return void await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        case 'ice-candidate':
          // The device names the fields the way the SDP does, not the way RTCIceCandidate does.
          return void await pc.addIceCandidate(new RTCIceCandidate({
            sdpMid: payload.mid,
            sdpMLineIndex: payload.mLineIndex,
            candidate: payload.candidate,
          }));
        case 'error':
          return this.#state('failed', `The device reported: ${payload.error}`);
        default:
          return;
      }
    } catch (e) {
      this.#state('failed', `Negotiation failed: ${e.message}`);
    }
  }

  /**
   * Sample the inbound video once a second.
   *
   * This is the number the design's `LIVE · 8 fps` pill shows, and it is measured rather than
   * assumed for a specific reason: snapshot/restore forces software rendering, so the honest frame
   * rate is single digits and a UI that implies 60 would be lying about the product.
   */
  #watchStats() {
    if (this.statsTimer) return;
    let lastBytes = 0, lastAt = 0;
    this.statsTimer = setInterval(async () => {
      const pc = this.pc;
      if (!pc) return;
      try {
        const report = await pc.getStats();
        let fps = 0, bytes = 0, rtt = null, ice = null;
        report.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            fps = s.framesPerSecond ?? fps;
            bytes = s.bytesReceived ?? bytes;
          }
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
            rtt = s.currentRoundTripTime != null ? Math.round(s.currentRoundTripTime * 1000) : rtt;
          }
          if (s.type === 'local-candidate' && s.candidateType) ice = s.candidateType;
        });
        const now = performance.now();
        const kbps = lastAt ? Math.round(((bytes - lastBytes) * 8) / (now - lastAt)) : 0;
        lastBytes = bytes; lastAt = now;
        // `relay` here means the media is going through coturn. Worth surfacing: it is the mode that
        // costs egress, and the mode a LAN-only test never exercises.
        this.stats = { fps: Math.round(fps), kbps, rtt, ice };
      } catch { /* the connection went away between the check and the call */ }
    }, 1000);
  }

  /* ------------------------------------------------------------------ input */

  /**
   * Bind pointer and keyboard input on the video element.
   *
   * Pointer events rather than mouse or touch: one code path covers a mouse, a trackpad and a
   * touchscreen, and `pointerId` is exactly the multi-touch id the device's protocol wants.
   */
  attachInput(video) {
    this.video = video;
    const send = (e, down) => {
      if (this.input?.readyState !== 'open') return;
      const [x, y] = scale(video, e.offsetX, e.offsetY);
      this.input.send(JSON.stringify({
        type: 'multi-touch',
        id: [e.pointerId],
        x: [x],
        y: [y],
        down: down ? 1 : 0,
        device_label: this.label,
      }));
    };

    video.addEventListener('pointerdown', (e) => {
      video.focus();
      this.activePointers.add(e.pointerId);
      // Capture, so a drag that leaves the element still delivers its move and up events — without
      // it a swipe that overshoots the phone's edge leaves the device believing a finger is still
      // down.
      video.setPointerCapture?.(e.pointerId);
      send(e, true);
    });
    video.addEventListener('pointermove', (e) => {
      if (this.activePointers.has(e.pointerId)) send(e, true);
    });
    const up = (e) => {
      if (!this.activePointers.delete(e.pointerId)) return;
      send(e, false);
    };
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) video.addEventListener(ev, up);

    for (const ev of ['keydown', 'keyup']) {
      video.addEventListener(ev, (e) => {
        if (this.input?.readyState !== 'open') return;
        // Prevented so that space does not scroll the console and tab does not move focus out of
        // the device the person is typing into.
        if (e.cancelable) e.preventDefault();
        this.input.send(JSON.stringify({ type: 'keyboard', keycode: e.code, event_type: e.type }));
      });
    }
  }

  /**
   * Send a raw data-plane message — volume, rotate, and anything else the worker adds later.
   *
   * These do NOT go over the WebRTC control channel, and the reason is that Cuttlefish's control
   * channel has no command for them: its panel exposes power, home, menu and back, and everything
   * else a device toolbar offers is done on the host with adb. So they take the slower path
   * deliberately, and they are the reason `DeviceControl.key` and `rotate` exist.
   */
  sendControl(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    // `seq` because the data plane's input gate drops anything not newer than the last one it saw.
    this.#send({ ...msg, seq: this.#nextSeq() });
    return true;
  }

  #nextSeq() {
    this.seq = (this.seq || 0) + 1;
    return this.seq;
  }

  /** A hardware button: home, back, menu, power. Sent as a press and a release, like a real one. */
  pressButton(command) {
    if (this.control?.readyState !== 'open') return false;
    this.control.send(JSON.stringify({ command, button_state: 'down' }));
    // The gap matters: Android distinguishes a tap from a long press by duration, and a down/up in
    // the same tick is not reliably seen as either.
    setTimeout(() => {
      if (this.control?.readyState === 'open') {
        this.control.send(JSON.stringify({ command, button_state: 'up' }));
      }
    }, 60);
    return true;
  }

  /* ------------------------------------------------------------------ out-of-band */

  startLogcat() { this.#send({ t: 'logcat', action: 'start' }); }
  stopLogcat() { this.#send({ t: 'logcat', action: 'stop' }); }

  /**
   * Ask the worker for one frame.
   *
   * Correlated by id and answered through a promise, because a screenshot takes an adb round trip
   * and a person who presses the button twice must not be shown the first answer twice.
   */
  screenshot() {
    const id = `s${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('Not connected to the device.'));
      this.pending.set(id, { resolve, reject });
      this.#send({ t: 'screenshot', id });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('The device did not answer the screenshot in 30s.'));
      }, 30_000);
    });
  }
}

/**
 * Parse one `-v threadtime` logcat line into its columns.
 *
 * Returns the raw line under `message` when it does not match, rather than dropping it: adb's own
 * diagnostics ("device offline", "waiting for device") do not have this shape and are exactly the
 * lines someone staring at an empty pane needs to see.
 */
const THREADTIME = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+([^:]*?):\s?([\s\S]*)$/;

export function parseLogLine(line) {
  const m = THREADTIME.exec(line);
  if (!m) return { time: '', level: '', tag: '', message: line, raw: line };
  return { time: m[1], pid: m[2], tid: m[3], level: m[4], tag: m[5].trim(), message: m[6], raw: line };
}
