/**
 * Live video for a phone — M6.
 *
 * Cuttlefish publishes its own WebRTC stream and the agent relays opaque signalling to it. A phone
 * publishes nothing, so here the agent IS the device's peer: it answers the console's `request-offer`
 * with an offer of its own, and feeds the video track from scrcpy's hardware-encoded H.264. Nothing is
 * decoded or encoded on the host — the NAL units go into RTP as they arrive (RFC 6184), which keeps
 * device.ts's "the agent never touches frames" invariant: no transcode, ever.
 *
 * THE SAME PROTOCOL CUTTLEFISH SPEAKS, on purpose. The console's live view already knows it — the
 * device offers, the browser answers, candidates trickle both ways, the display stream's id begins
 * `display_`, touches arrive on a data channel the browser creates called `input-channel`. Speaking
 * it means the console needs no second video path for phones, and a fix to the one path is a fix to
 * both.
 *
 * `werift` is the peer: pure TypeScript, no native build, which is the whole point on somebody's
 * laptop (ADR-0009). Input still goes to the phone the way every other input does — through the held
 * adb shell — so a press is a tap and a drag a swipe, decided on release. A drag that follows the
 * finger live would need scrcpy's control socket; that is a separate step, not this one.
 */
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { randomBytes } from 'node:crypto';
import {
  RTCPeerConnection, MediaStreamTrack, MediaStream, RTCRtpCodecParameters, RtpPacket, RtpHeader,
} from 'werift';
import type { SignalChannel, SignalOptions } from '../device.ts';
import type { ScreenCapture, FrameMark } from './capture.ts';

/** Payload bytes per RTP packet. Under a 1280-byte path MTU with room for SRTP and TURN headers. */
const MAX_PAYLOAD = 1100;

/** NAL unit types this file has to tell apart (H.264, ITU-T H.264 table 7-1). */
const NAL_NON_IDR = 1;
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
export const nalType = (nal: Buffer): number => nal[0] & 0x1f;

/**
 * One NAL unit to RTP payloads (RFC 6184): whole if it fits, FU-A fragments if it does not. The
 * caller sets the marker on the last payload of the last NAL of a frame.
 */
export function packetizeNal(nal: Buffer, max = MAX_PAYLOAD): Buffer[] {
  if (nal.length <= max) return [nal];
  const nri = nal[0] & 0x60;
  const type = nal[0] & 0x1f;
  const body = nal.subarray(1);
  const room = max - 2;
  const out: Buffer[] = [];
  for (let off = 0; off < body.length; off += room) {
    const first = off === 0;
    const last = off + room >= body.length;
    out.push(Buffer.concat([
      Buffer.from([nri | 28, (first ? 0x80 : 0) | (last ? 0x40 : 0) | type]),
      body.subarray(off, off + room),
    ]));
  }
  return out;
}

/**
 * The size scrcpy encodes at, which is the coordinate space touches arrive in.
 *
 * scrcpy's own rule: the longer side becomes `maxSize` when it is larger, the shorter is scaled to
 * match and rounded to a multiple of 8, and both sides are multiples of 8 regardless. The browser
 * reports a press in the video's own pixels, so this is the ratio a tap is multiplied back by.
 */
export function videoSizeFor(screen: { width: number; height: number }, maxSize?: number): { w: number; h: number } {
  const portrait = screen.height > screen.width;
  let major = portrait ? screen.height : screen.width;
  let minor = portrait ? screen.width : screen.height;
  if (maxSize && major > maxSize) {
    minor = Math.floor((minor * maxSize) / major + 4) & ~7;
    major = maxSize;
  }
  major &= ~7;
  minor &= ~7;
  return portrait ? { w: minor, h: major } : { w: major, h: minor };
}

/**
 * ONE capture per phone, however many viewers. scrcpy binds one server and one forwarded port per
 * device; a second tab starting a second one would fight the first for both. Started by the first
 * viewer, stopped with the last, and the parameter sets are kept so a viewer that joins mid-stream
 * can be given them before the keyframe it starts on.
 */
export class H264Fanout {
  private readonly make: () => ScreenCapture;
  private capture?: ScreenCapture;
  private starting?: Promise<void>;
  private readonly subs = new Set<(nal: Buffer, at: number, frame?: FrameMark) => void>();
  sps?: Buffer;
  pps?: Buffer;

  constructor(make: () => ScreenCapture) { this.make = make; }

  get viewers(): number { return this.subs.size; }

  async subscribe(onNal: (nal: Buffer, at: number, frame?: FrameMark) => void): Promise<() => void> {
    this.subs.add(onNal);
    if (!this.capture) {
      const capture = this.make();
      this.capture = capture;
      this.starting = capture.start((nal, at, frame) => {
        const t = nalType(nal);
        if (t === NAL_SPS) this.sps = Buffer.from(nal);
        else if (t === NAL_PPS) this.pps = Buffer.from(nal);
        for (const s of this.subs) s(nal, at, frame);
      }).catch((e) => {
        // A capture that could not start leaves nobody holding it, so the next viewer tries afresh.
        if (this.capture === capture) { this.capture = undefined; this.starting = undefined; }
        throw e;
      });
    }
    await this.starting;
    let gone = false;
    return () => {
      if (gone) return;
      gone = true;
      this.subs.delete(onNal);
      if (this.subs.size === 0 && this.capture) {
        const c = this.capture;
        this.capture = undefined;
        this.starting = undefined;
        void c.stop();
      }
    };
  }
}

/** What a phone does with a press, a drag and a key — the held adb shell's verbs. */
export interface PhoneInput {
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  key(name: 'enter' | 'backspace' | 'home' | 'back' | 'recents' | 'power'): Promise<void>;
  text(value: string): Promise<void>;
}

/** The console's `device-control` commands, as the phone's keys — `menu` is Recents (see live.js). */
const BUTTONS: Record<string, 'home' | 'back' | 'recents' | 'power'> = {
  home: 'home', back: 'back', menu: 'recents', recents: 'recents', power: 'power',
};

/** `KeyboardEvent.code` to the character it types, without and with Shift. */
const CODE_CHARS: Record<string, [string, string]> = {
  Space: [' ', ' '], Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'],
  Backslash: ['\\', '|'], Semicolon: [';', ':'], Quote: ["'", '"'], Backquote: ['`', '~'], Comma: [',', '<'],
  Period: ['.', '>'], Slash: ['/', '?'],
  Digit0: ['0', ')'], Digit1: ['1', '!'], Digit2: ['2', '@'], Digit3: ['3', '#'], Digit4: ['4', '$'],
  Digit5: ['5', '%'], Digit6: ['6', '^'], Digit7: ['7', '&'], Digit8: ['8', '*'], Digit9: ['9', '('],
};
export function charFor(code: string, shift: boolean): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return shift ? letter[1] : letter[1].toLowerCase();
  const c = CODE_CHARS[code];
  return c ? c[shift ? 1 : 0] : undefined;
}

/**
 * The browser's `input-channel` messages, turned into the phone's verbs.
 *
 * A PRESS IS A TAP AND A DRAG IS A SWIPE, decided on release, exactly as the screen-without-video view
 * decides it (M4) — the distance is the only honest test, and deciding on press would tap at the
 * start of every scroll. Typed characters are gathered for a moment and sent as one `input text`,
 * because each call spawns a process on the phone and a person types faster than that.
 */
export class InputMapper {
  private readonly input: PhoneInput;
  private readonly kx: number;
  private readonly ky: number;
  private readonly downs = new Map<number, { x: number; y: number; at: number; lx: number; ly: number }>();
  private shift = false;
  private typed = '';
  private flush?: ReturnType<typeof setTimeout>;
  /** The latest thing sent to the phone, and when — what `PHYSICAL_VIDEO_TRACE` times a frame against. */
  last?: { verb: string; at: number; doneAt?: number; framed?: boolean };

  constructor(input: PhoneInput, screen: { width: number; height: number }, video: { w: number; h: number }) {
    this.input = input;
    this.kx = screen.width / video.w;
    this.ky = screen.height / video.h;
  }

  handle(raw: string | Buffer): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'multi-touch') return this.touch(m);
    if (m.type === 'keyboard') return this.keyboard(String(m.keycode ?? ''), String(m.event_type ?? ''));
  }

  /** A hardware button from `device-control`: pressed on the down half, the way the phone's own are. */
  button(raw: string | Buffer): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(raw)); } catch { return; }
    const name = BUTTONS[String(m.command ?? '')];
    if (name && m.button_state === 'down') this.send(name, () => this.input.key(name));
  }

  /** Every verb goes out through here, so the latest one is on record with its timing. */
  private send(verb: string, act: () => Promise<void>): void {
    const rec: NonNullable<InputMapper['last']> = { verb, at: Date.now() };
    this.last = rec;
    void act().then(() => { rec.doneAt = Date.now(); }, () => {});
  }

  private touch(m: Record<string, unknown>): void {
    const id = Number((m.id as unknown[])?.[0] ?? 0);
    const x = Math.round(Number((m.x as unknown[])?.[0]) * this.kx);
    const y = Math.round(Number((m.y as unknown[])?.[0]) * this.ky);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const d = this.downs.get(id);
    if (m.down) {
      if (!d) this.downs.set(id, { x, y, at: Date.now(), lx: x, ly: y });
      else { d.lx = x; d.ly = y; }
      return;
    }
    if (!d) return;
    this.downs.delete(id);
    const moved = Math.hypot(x - d.x, y - d.y);
    // 24 device pixels — about the width of a fingertip's wobble at 480dpi.
    if (moved < 24) this.send('tap', () => this.input.tap(d.x, d.y));
    else this.send('swipe', () => this.input.swipe(d.x, d.y, x, y, Math.max(100, Math.min(1500, Date.now() - d.at))));
  }

  private keyboard(code: string, kind: string): void {
    if (/^Shift(Left|Right)$/.test(code)) { this.shift = kind === 'keydown'; return; }
    if (kind !== 'keydown') return;
    if (code === 'Enter' || code === 'NumpadEnter') { this.sendTyped(); this.send('enter', () => this.input.key('enter')); return; }
    if (code === 'Backspace') { this.sendTyped(); this.send('backspace', () => this.input.key('backspace')); return; }
    const ch = charFor(code, this.shift);
    if (!ch) return;
    this.typed += ch;
    clearTimeout(this.flush);
    this.flush = setTimeout(() => this.sendTyped(), 120);
  }

  private sendTyped(): void {
    clearTimeout(this.flush);
    if (!this.typed) return;
    const value = this.typed;
    this.typed = '';
    this.send('text', () => this.input.text(value));
  }
}

type IceServer = { urls: string | string[]; username?: string; credential?: string };

/** The console's ICE server shape to werift's, dropping anything malformed rather than failing. */
function iceServersFrom(raw: unknown): IceServer[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => s && typeof s === 'object' && (typeof s.urls === 'string' || Array.isArray(s.urls)))
    .map((s) => ({ urls: s.urls, ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) }));
}

/**
 * `PHYSICAL_VIDEO_TRACE=1` logs, for each touch or key, how long the phone took to carry it out and
 * how long until the first frame after it reached the agent — the phone's half of the latency, with
 * the network and the browser's half measured in the browser. Off by default: a line per touch.
 */
const TRACE = process.env.PHYSICAL_VIDEO_TRACE === '1';

/** How long a relay gets to answer before the offer goes without it. */
const RELAY_PROBE_MS = Number(process.env.PHYSICAL_RELAY_PROBE_MS ?? 1500);
/** The longest an offer may take. Past it the viewer is told so, rather than left on "negotiating". */
const OFFER_DEADLINE_MS = Number(process.env.PHYSICAL_OFFER_DEADLINE_MS ?? 15_000);
/** werift's own default, kept when the console names no STUN server: the phone's public address. */
const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

/** `turn:host:port?transport=tcp` and its kin, taken apart; undefined for anything else. */
export function parseIceUrl(url: string): { scheme: string; host: string; port: number; transport: 'udp' | 'tcp' } | undefined {
  const m = /^(stuns?|turns?):(\[[^\]]+\]|[^:?\s]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url.trim());
  if (!m) return undefined;
  const scheme = m[1].toLowerCase();
  const tls = scheme.endsWith('s');
  return {
    scheme, host: m[2].replace(/^\[|\]$/g, ''),
    port: Number(m[3] ?? (tls ? 5349 : 3478)),
    transport: (m[4]?.toLowerCase() as 'udp' | 'tcp' | undefined) ?? (tls ? 'tcp' : 'udp'),
  };
}

/** A STUN Binding request with no attributes, and the transaction id an answer must carry. */
function bindingRequest(): { req: Buffer; id: Buffer } {
  const id = randomBytes(12);
  const req = Buffer.alloc(20);
  req.writeUInt16BE(0x0001, 0);
  req.writeUInt32BE(0x2112a442, 4);       // the magic cookie
  id.copy(req, 8);
  return { req, id };
}

/** Whether a STUN or TURN server answers a Binding request over UDP within `ms`. Any answer counts. */
export function answersOverUdp(host: string, port: number, ms = RELAY_PROBE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const { req, id } = bindingRequest();
    const sock = createSocket(host.includes(':') ? 'udp6' : 'udp4');
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), ms);
    sock.on('message', (m) => { if (m.length >= 20 && m.subarray(8, 20).equals(id)) finish(true); });
    sock.on('error', () => finish(false));
    sock.send(req, port, host, (e) => { if (e) finish(false); });
  });
}

/**
 * The same question over TCP, or TLS for `turns:`. A connection that is accepted and never answered
 * is not an answer: werift would wait on it exactly as long as on a port that drops everything.
 */
export function answersOverTcp(host: string, port: number, ms = RELAY_PROBE_MS, tls = false): Promise<boolean> {
  return new Promise((resolve) => {
    const { req, id } = bindingRequest();
    const s = tls ? connectTls({ host, port, servername: host }) : connect({ host, port });
    let got = Buffer.alloc(0);
    const finish = (ok: boolean) => { clearTimeout(timer); s.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), ms);
    s.once(tls ? 'secureConnect' : 'connect', () => s.write(req));
    s.on('data', (d: Buffer) => {
      got = Buffer.concat([got, d]);
      if (got.length >= 20) finish(got.subarray(8, 20).equals(id));
    });
    s.once('error', () => finish(false));
  });
}

/**
 * ONLY THE RELAYS THAT ANSWER.
 *
 * werift will not hand over an offer until every candidate is gathered, and it puts no limit on the
 * relay: a TURN server that never answers holds the offer forever. On the farm that is exactly what
 * happened — the relay host was down, the agent never offered, and the console sat on "negotiating"
 * with a phone on the same desk. So each relay is asked first, briefly, and one that does not answer
 * is left out: a direct path still works, and a relay that is down was never going to carry the call.
 * STUN is left alone — werift bounds that itself.
 */
export async function reachableIceServers(
  servers: IceServer[],
  probe: { udp: typeof answersOverUdp; tcp: typeof answersOverTcp } = { udp: answersOverUdp, tcp: answersOverTcp },
  onDropped?: (url: string) => void,
): Promise<IceServer[]> {
  const checked = await Promise.all(servers.map(async (s): Promise<IceServer | undefined> => {
    const urls = ([] as string[]).concat(s.urls);
    const kept = await Promise.all(urls.map(async (url) => {
      const u = parseIceUrl(url);
      if (!u) return undefined;
      if (!u.scheme.startsWith('turn')) return url;
      const ok = u.transport === 'udp'
        ? await probe.udp(u.host, u.port)
        : await probe.tcp(u.host, u.port, RELAY_PROBE_MS, u.scheme === 'turns');
      if (!ok) onDropped?.(url.replace(/\?.*$/, '') + (u.transport === 'tcp' ? ' (tcp)' : ''));
      return ok ? url : undefined;
    }));
    const live = kept.filter((u): u is string => Boolean(u));
    return live.length ? { ...s, urls: live } : undefined;
  }));
  const out = checked.filter((s): s is IceServer => Boolean(s));
  const hasStun = out.some((s) => ([] as string[]).concat(s.urls).some((u) => parseIceUrl(u)?.scheme.startsWith('stun')));
  return hasStun ? out : [...out, { urls: DEFAULT_STUN }];
}

/**
 * One viewer's peer connection. Implements the signalling channel the data plane already relays for
 * Cuttlefish, so `dataplane.ts` cannot tell the two apart — which is the point.
 */
export class PhoneVideoPeer implements SignalChannel {
  readonly deviceInfo: unknown;
  readonly iceServers: unknown[] = [];
  private readonly o: { signal: SignalOptions; fanout: H264Fanout; input: InputMapper; label: string };
  private pc?: RTCPeerConnection;
  private unsubscribe?: () => void;
  private closed = false;

  constructor(o: { signal: SignalOptions; fanout: H264Fanout; input: InputMapper; label: string; video: { w: number; h: number } }) {
    this.o = o;
    this.deviceInfo = { kind: 'mfarm-phone', device_id: o.label, displays: [{ width: o.video.w, height: o.video.h }] };
  }

  send(payload: unknown): void {
    const p = payload as { type?: string; sdp?: string; candidate?: unknown; ice_servers?: unknown };
    if (!p || typeof p !== 'object') return;
    const fail = (e: unknown) => this.o.signal.onClose(`The phone's video could not be negotiated: ${(e as Error).message}`);
    if (p.type === 'request-offer') void this.offer(p.ice_servers).catch(fail);
    else if (p.type === 'answer' && this.pc && typeof p.sdp === 'string') {
      void this.pc.setRemoteDescription({ type: 'answer', sdp: p.sdp }).catch(fail);
    } else if (p.type === 'ice-candidate' && this.pc && p.candidate) {
      // A candidate the peer cannot use is not a reason to end the call; the others may still pair.
      void this.pc.addIceCandidate(p.candidate as never).catch(() => {});
    }
  }

  private async offer(iceServers: unknown): Promise<void> {
    if (this.pc || this.closed) return;
    const log = (line: string) => console.log(`[video:${this.o.label}] ${line}`);
    const servers = await reachableIceServers(iceServersFrom(iceServers), undefined,
      (url) => log(`the relay ${url} did not answer within ${RELAY_PROBE_MS}ms — offering without it`));
    if (this.pc || this.closed) return;
    const pc = new RTCPeerConnection({
      iceServers: servers,
      /**
       * ONE TRANSPORT FROM THE START. The offer has two sections — the video and the data channel —
       * and under the default policy werift gathers for each, bundles them into one, and never closes
       * the one it dropped: three UDP sockets (an IPv4 and two IPv6) left bound by every viewer that
       * came and went, measured by counting the process's handles across connect-and-close cycles.
       * A long-running agent would have leaked them for good. Every browser bundles, so nothing is
       * given up.
       */
      bundlePolicy: 'max-bundle',
      codecs: {
        audio: [],
        video: [new RTCRtpCodecParameters({
          mimeType: 'video/H264', clockRate: 90000,
          rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }],
          // Constrained baseline is what every browser decodes; the phone's encoder may produce a
          // higher profile, and browsers decode what arrives rather than what was named.
          parameters: 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1',
        })],
      },
    });
    this.pc = pc;
    const track = new MediaStreamTrack({ kind: 'video' });
    pc.addTransceiver(track, { direction: 'sendonly', streams: [new MediaStream({ id: `display_${this.o.label}` })] });

    /**
     * OPENED BY THE DEVICE, AND THAT IS WHAT LETS THE BROWSER'S CHANNEL EXIST AT ALL.
     *
     * The device makes the offer, and only an offer can add the SDP section data channels ride in;
     * an answer cannot. Cuttlefish always opens `device-control`, so the console's `input-channel`
     * rides along. Without one here the offer had no data section, and the input channel the
     * console created never opened — every touch on the video went nowhere. Found by the werift-
     * to-werift test before it could be found on a phone.
     */
    const buttons = pc.createDataChannel('device-control');
    buttons.onMessage.subscribe((data) => this.o.input.button(data));

    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      if (ch.label !== 'input-channel') return;
      ch.onMessage.subscribe((data) => this.o.input.handle(data));
    };
    /**
     * CUTTLEFISH'S SHAPE, which is the SDP's: `{ mid, mLineIndex, candidate: '<string>' }` — what
     * live.js reads a device's candidate from. Sent in RTCIceCandidate's shape instead, the browser
     * built a candidate naming no section at all and Chrome refused the first live negotiation with
     * "sdpMid and sdpMLineIndex are both null". werift leaves the section unset on its own candidates
     * too, and under max-bundle every one belongs to the first section, so that is the one named.
     */
    let firstMid = '0';
    /**
     * HELD UNTIL THE OFFER HAS GONE. werift raises its candidates while it is setting the local
     * description — before the offer is in our hands — and a browser cannot add a candidate for a
     * description it has not been given: "The remote description was null", the second refusal the
     * first live negotiation met. Cuttlefish always sends its offer first; so does this.
     */
    let held: Array<Record<string, unknown>> | null = [];
    pc.onicecandidate = (ev) => {
      const c = ev.candidate;
      if (!c) return;
      const payload = {
        type: 'ice-candidate', candidate: c.candidate, mid: c.sdpMid ?? firstMid, mLineIndex: c.sdpMLineIndex ?? 0,
      };
      if (held) held.push(payload);
      else this.o.signal.onPayload(payload);
    };
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected' || state === 'failed') log(`viewer ${state}`);
      if (state === 'connected') void this.stream(track);
      if (state === 'failed') this.o.signal.onClose('The media connection to the phone failed.');
    });

    const offer = await pc.createOffer();
    firstMid = /^a=mid:(\S+)/m.exec(offer.sdp)?.[1] ?? firstMid;
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([
      pc.setLocalDescription(offer),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`finding a network path took longer than ${OFFER_DEADLINE_MS / 1000}s`)),
          OFFER_DEADLINE_MS);
      }),
    ]).finally(() => clearTimeout(deadline));
    if (this.closed) return;
    this.o.signal.onPayload({ type: 'offer', sdp: pc.localDescription?.sdp ?? offer.sdp });
    const early = held ?? [];
    held = null;
    for (const p of early) this.o.signal.onPayload(p);
  }

  /**
   * Feed the track. A viewer starts on a keyframe, with the parameter sets in front of it, or it
   * shows a black rectangle until the next one; the parameter sets go in front of every keyframe,
   * so a lost packet costs at most one keyframe interval rather than the rest of the session.
   */
  private async stream(track: MediaStreamTrack): Promise<void> {
    if (this.unsubscribe || this.closed) return;
    let seq = 0;
    let started = false;
    const t0 = Date.now();
    const send = (nal: Buffer, ts: number, marker: boolean): void => {
      const parts = packetizeNal(nal);
      parts.forEach((payload, i) => {
        const header = new RtpHeader({ payloadType: 96, sequenceNumber: seq, timestamp: ts, marker: marker && i === parts.length - 1 });
        seq = (seq + 1) & 0xffff;
        track.writeRtp(new RtpPacket(header, payload));
      });
    };
    /**
     * ONE FRAME, ONE TIMESTAMP, ONE MARKER. An encoder may cut a frame into several slices, and a
     * receiver puts a frame together from the packets that share its RTP timestamp and ends it at the
     * marker. So the slices of a frame are held until its last one, then sent together under the
     * encoder's own clock with the marker on the final packet. The source says where a frame ends
     * (FrameMark); one that cannot gets a frame per slice, which is what this did for every source.
     */
    let pts0: number | undefined;
    let pending: Buffer[] = [];
    let keyframe = false;
    try {
      this.unsubscribe = await this.o.fanout.subscribe((nal, at, frame) => {
        const type = nalType(nal);
        const vcl = type === NAL_IDR || type === NAL_NON_IDR;   // parameter sets go with keyframes
        if (vcl && (started || type === NAL_IDR)) {
          started = true;
          pending.push(nal);
          if (type === NAL_IDR) keyframe = true;
        }
        if (frame && !frame.last) return;
        if (!pending.length) return;
        let ts: number;
        if (frame?.ptsUs !== undefined) {
          pts0 ??= frame.ptsUs;
          ts = Math.round(((frame.ptsUs - pts0) * 90) / 1000) >>> 0;
        } else {
          ts = ((at - t0) * 90) >>> 0;
        }
        if (keyframe && this.o.fanout.sps && this.o.fanout.pps) {
          send(this.o.fanout.sps, ts, false);
          send(this.o.fanout.pps, ts, false);
        }
        pending.forEach((slice, i) => send(slice, ts, i === pending.length - 1));
        pending = [];
        keyframe = false;
        const last = this.o.input.last;
        if (TRACE && last && !last.framed) {
          // The first frame after the input was sent — which may come before the shell has even
          // said the input is done, so that is not waited for.
          last.framed = true;
          const now = Date.now();
          const acted = last.doneAt === undefined ? 'not yet done' : `${last.doneAt - last.at}ms`;
          console.log(`[video:${this.o.label}] ${last.verb}: the phone's input took ${acted}; `
            + `the first frame after it reached the agent ${now - last.at}ms after it was sent`);
        }
      });
      if (this.closed) this.unsubscribe();
    } catch (e) {
      this.o.signal.onClose(`The phone's screen could not be captured: ${(e as Error).message}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    void this.pc?.close().catch(() => {});
  }
}
