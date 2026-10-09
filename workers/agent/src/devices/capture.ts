import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * Getting H.264 off a physical handset (ADR-0008, spec §20).
 *
 * WHY THIS IS AN INTERFACE RATHER THAN JUST scrcpy. The two ways to do this have opposite
 * trade-offs, and which one is right depends on something this code cannot know — whether the
 * person running the agent can put a matching `scrcpy-server.jar` on the machine.
 *
 *   scrcpy       ~50-100ms latency, runs indefinitely, and needs a VERSION-MATCHED server jar
 *                pushed to the device. Fast enough to feel live.
 *   screenrecord built into every Android since 4.4, needs nothing extra, and is capped at 180
 *                SECONDS per invocation by the platform. Latency is encoder-buffered and much
 *                worse. Segments have to be restitched, and the seam is visible.
 *
 * scrcpy is the one to want. `screenrecord` exists here so that a laptop with no jar still gets a
 * picture, and so the transport half of the live view can be developed and tested before the jar
 * question is settled. Both produce the same thing — an Annex-B H.264 byte stream — which is what
 * makes them substitutable at all.
 *
 * NEITHER DECODES ANYTHING. `device.ts`'s invariant is that the agent never touches frames, meaning
 * it must not transcode; both of these hand through bytes the device's own hardware encoder
 * produced. Splitting the stream into NAL units is framing, not decoding.
 */

const adbPath = (): string =>
  process.env.ADB_PATH
  ?? (process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb');

export interface CaptureOptions {
  serial: string;
  /** Long edge in pixels. Downscaling on the DEVICE is free; doing it here would be a transcode. */
  maxSize?: number;
  bitRate?: number;
  maxFps?: number;
  /**
   * The encoder's rate control. `cbr` asks MediaCodec for a constant bitrate (`bitrate-mode` 2).
   * Left unset, the encoder keeps its default, usually VBR, and on the OnePlus's Qualcomm encoder VBR
   * ignores any target under about 2 Mbit/s on a moving screen (D77). scrcpy only.
   */
  bitrateMode?: 'cbr';
  /**
   * How often the encoder is asked for a keyframe, in seconds. scrcpy only.
   *
   * THIS IS THE NUMBER A LATE VIEWER WAITS. Everything between keyframes is undecodable to somebody
   * who just opened the device, so it is the delay between pressing Open and seeing a picture — not
   * an encoding detail. scrcpy's own default is 10s, which is fine for scrcpy (its client is there
   * from the first frame) and wrong for a console where viewers arrive whenever they like.
   *
   * Measured on a Samsung SM-S918B: at the default, a 20s capture contained ONE keyframe. The cost
   * of lowering it is bitrate, since keyframes are far larger than the frames between them, which
   * is why this is 2 rather than 1.
   */
  keyFrameIntervalSeconds?: number;
  /**
   * Open scrcpy's control socket beside the video, so touches, keys and keyframe requests reach the
   * phone as they happen rather than through `adb shell input`. scrcpy only; see `LiveControl`.
   */
  control?: boolean;
}

export interface CaptureStats {
  frames: number;
  bytes: number;
  /** Wall-clock ms from capture start to the first byte of the first frame. */
  firstFrameMs?: number;
  startedAt: number;
}

/**
 * Where a NAL sits in its frame, when the source says. scrcpy does; `screenrecord` cannot — a bare
 * Annex-B stream only shows a frame has ended when the next one begins.
 */
export interface FrameMark {
  /** The last NAL of its frame: the frame is complete, and can be sent on now. */
  last: boolean;
  /** The encoder's presentation time, in microseconds. Absent on parameter sets. */
  ptsUs?: number;
}

export interface ScreenCapture {
  /** Which source this is, for the console and for honest logging. */
  readonly kind: 'scrcpy' | 'screenrecord';
  /** Resolves once a first frame has genuinely arrived — see `start`'s comment. */
  start(onNal: (nal: Buffer, receivedAt: number, frame?: FrameMark) => void): Promise<void>;
  stop(): Promise<void>;
  readonly stats: CaptureStats;
  /** The phone's input, live, while the source has one open — scrcpy with `control` set. */
  readonly control?: LiveControl;
}

/* ------------------------------------------------------------------------------ Annex-B framing */

/**
 * Split an Annex-B stream into NAL units, across chunk boundaries.
 *
 * STATEFUL ON PURPOSE. A socket hands over arbitrary chunks, and a start code straddles a chunk
 * boundary often enough that a stateless splitter loses a NAL every few seconds — which presents as
 * a decoder that occasionally corrupts and recovers, and is miserable to diagnose after the fact.
 * The carry buffer is what makes the stream reassembly correct rather than usually correct.
 */
export class NalSplitter {
  private carry = Buffer.alloc(0);

  push(chunk: Buffer, emit: (nal: Buffer) => void): void {
    const buf = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    let searchFrom = 0;
    let lastStart = -1;

    // Find every start code in what we have.
    const starts: Array<{ at: number; len: number }> = [];
    for (let i = 0; i + 2 < buf.length; i++) {
      if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
      if (buf[i + 2] === 1) { starts.push({ at: i, len: 3 }); i += 2; }
      else if (i + 3 < buf.length && buf[i + 2] === 0 && buf[i + 3] === 1) { starts.push({ at: i, len: 4 }); i += 3; }
    }

    for (let s = 0; s < starts.length; s++) {
      const from = starts[s].at + starts[s].len;
      const to = s + 1 < starts.length ? starts[s + 1].at : -1;
      if (to === -1) { lastStart = starts[s].at; break; }
      if (to > from) emit(buf.subarray(from, to));
      lastStart = to;
      searchFrom = to;
    }
    void searchFrom;

    // Keep from the last start code onward: it is an incomplete NAL whose tail is in the next chunk.
    // With no start code at all, keep the last 3 bytes — a start code may straddle the boundary.
    this.carry = lastStart >= 0 ? Buffer.from(buf.subarray(lastStart)) : Buffer.from(buf.subarray(Math.max(0, buf.length - 3)));
  }

  reset(): void { this.carry = Buffer.alloc(0); }
}

/** Whether a buffer begins with an Annex-B start code, as every frame scrcpy sends does. */
export const startsAnnexB = (b: Buffer): boolean =>
  b.length >= 3 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b.length >= 4 && b[3] === 1));

/** Every NAL in a buffer that is known to be whole — one frame — the last one included. */
export function splitAnnexB(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const splitter = new NalSplitter();
  splitter.push(data, (nal) => out.push(nal));
  // The splitter keeps the last NAL back until a start code follows it; here nothing follows, by
  // construction, so a start code is what ends it.
  splitter.push(Buffer.from([0, 0, 0, 1]), (nal) => out.push(nal));
  return out;
}

/** One packet of scrcpy's framed stream: a whole frame, or the codec's parameter sets. */
export interface ScrcpyPacket { data: Buffer; config: boolean; key: boolean; ptsUs: number }

/**
 * scrcpy's per-frame header, across chunk boundaries: 8 bytes of PTS whose top two bits flag a
 * config packet and a keyframe, then a 4-byte big-endian length, then that many bytes of frame.
 */
export class ScrcpyFramer {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer, emit: (packet: ScrcpyPacket) => void): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    let at = 0;
    while (this.buf.length - at >= 12) {
      const size = this.buf.readUInt32BE(at + 8);
      if (this.buf.length - at - 12 < size) break;
      const head = this.buf.readBigUInt64BE(at);
      emit({
        data: this.buf.subarray(at + 12, at + 12 + size),
        config: (head >> 63n) === 1n,
        key: ((head >> 62n) & 1n) === 1n,
        ptsUs: Number(head & ((1n << 62n) - 1n)),
      });
      at += 12 + size;
    }
    this.buf = at === 0 ? this.buf : Buffer.from(this.buf.subarray(at));
  }

  reset(): void { this.buf = Buffer.alloc(0); }
}

/* ----------------------------------------------------------------------------- scrcpy control */

/**
 * The phone's input as it happens: a finger's down, move and up, a key, text, and a fresh keyframe.
 *
 * WHY NOT `adb shell input`. Each `input` call is a process on the phone, and a drag can only be
 * replayed as a `swipe` once the finger has lifted — measured through the farm, a swipe took 270-300ms
 * to begin moving, and the screen never followed the finger at all. scrcpy's server is already
 * running for the video and injects events directly, so a drag is streamed point by point.
 *
 * Every method answers whether the message went out. `false` means the socket is gone, and the
 * caller falls back to adb rather than dropping the input.
 */
export interface LiveControl {
  /** One finger, in the VIDEO's pixels, with the video's size — scrcpy maps it back to the screen. */
  touch(action: 'down' | 'move' | 'up', pointerId: number, x: number, y: number, video: { w: number; h: number }): boolean;
  /** An Android keycode, pressed and released. */
  key(keycode: number): boolean;
  text(value: string): boolean;
  /** Restart the encoder, which begins again on a keyframe — the answer to a viewer's PLI. */
  resetVideo(): boolean;
}

/**
 * scrcpy's control message types, as the 4.1 server numbers them. Read from the jar itself
 * (`ControlMessage.TYPE_*` in its dex) rather than from memory: 4.x inserted camera messages, and a
 * wrong number here is not an error anywhere — the server reads a different message and moves on.
 */
const MSG_INJECT_KEYCODE = 0;
const MSG_INJECT_TEXT = 1;
const MSG_INJECT_TOUCH = 2;
const MSG_RESET_VIDEO = 17;
const MOTION = { down: 0, up: 1, move: 2 } as const;
/** scrcpy's own client never sends more text than this in one message. */
const TEXT_MAX_BYTES = 300;

/** 32 bytes: type, action, pointer id (i64), x, y (i32), width, height (u16), pressure, buttons. */
export function encodeTouch(action: 'down' | 'move' | 'up', pointerId: number, x: number, y: number, video: { w: number; h: number }): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt8(MSG_INJECT_TOUCH, 0);
  b.writeUInt8(MOTION[action], 1);
  b.writeBigInt64BE(BigInt(Math.trunc(pointerId)), 2);
  b.writeInt32BE(Math.round(x), 10);
  b.writeInt32BE(Math.round(y), 14);
  b.writeUInt16BE(video.w, 18);
  b.writeUInt16BE(video.h, 20);
  // Pressure is a 16-bit fixed-point fraction; a lifted finger presses with nothing.
  b.writeUInt16BE(action === 'up' ? 0 : 0xffff, 22);
  // action button and buttons stay 0: those are a mouse's, and this is a finger.
  return b;
}

/** 14 bytes: type, action, keycode, repeat, meta state. */
export function encodeKey(action: 'down' | 'up', keycode: number): Buffer {
  const b = Buffer.alloc(14);
  b.writeUInt8(MSG_INJECT_KEYCODE, 0);
  b.writeUInt8(action === 'down' ? 0 : 1, 1);
  b.writeInt32BE(keycode, 2);
  return b;
}

/** Type, a 4-byte length, then UTF-8 — cut at characters, never inside one, to scrcpy's limit. */
export function encodeText(value: string): Buffer[] {
  const out: Buffer[] = [];
  let part = '';
  const flush = (): void => {
    if (!part) return;
    const t = Buffer.from(part, 'utf8');
    const head = Buffer.alloc(5);
    head.writeUInt8(MSG_INJECT_TEXT, 0);
    head.writeUInt32BE(t.length, 1);
    out.push(Buffer.concat([head, t]));
    part = '';
  };
  for (const ch of value) {
    if (Buffer.byteLength(part + ch, 'utf8') > TEXT_MAX_BYTES) flush();
    part += ch;
  }
  flush();
  return out;
}

/** The control socket, written to. Anything the server sends back is read and dropped. */
export class ScrcpyControl implements LiveControl {
  private readonly socket: import('node:net').Socket;
  constructor(socket: import('node:net').Socket) {
    this.socket = socket;
    // The server's replies (clipboard, acknowledgements) are not used; an unread socket would fill.
    socket.on('data', () => {});
  }

  get open(): boolean { return !this.socket.destroyed && this.socket.writable; }

  private write(...msgs: Buffer[]): boolean {
    if (!this.open) return false;
    for (const m of msgs) this.socket.write(m);
    return true;
  }

  touch(action: 'down' | 'move' | 'up', pointerId: number, x: number, y: number, video: { w: number; h: number }): boolean {
    // Outside the picture is outside the screen; scrcpy would drop it, and an `up` must not be lost.
    const cx = Math.min(Math.max(x, 0), video.w - 1);
    const cy = Math.min(Math.max(y, 0), video.h - 1);
    return this.write(encodeTouch(action, pointerId, cx, cy, video));
  }

  key(keycode: number): boolean { return this.write(encodeKey('down', keycode), encodeKey('up', keycode)); }
  text(value: string): boolean { return this.write(...encodeText(value)); }
  resetVideo(): boolean { return this.write(Buffer.from([MSG_RESET_VIDEO])); }
  close(): void { this.socket.destroy(); }
}

/* ------------------------------------------------------------------------------------- scrcpy */

/**
 * scrcpy's server, over an adb forward.
 *
 * THE JAR IS THE WHOLE DIFFICULTY, and it is an operational one rather than a technical one.
 * scrcpy's client and server are released as a matched pair and the wire format has changed
 * between majors, so this needs BOTH the jar and the version string it was built as. There is
 * deliberately no download here: fetching and executing a binary on a teammate's machine is a
 * supply-chain decision, not something an agent should do quietly on first run.
 *
 * `SCRCPY_SERVER_PATH` and `SCRCPY_SERVER_VERSION` name them. Absent, `createCapture` falls back to
 * `screenrecord`, which needs nothing.
 *
 * VERIFIED AGAINST A HANDSET on 2026-08-25 — Samsung SM-S918B, Android 16, scrcpy 4.1 — and the
 * first run produced zero frames while reporting success. Three things were wrong, and all three
 * are worth stating because each one is a trap the next person would fall into identically:
 *
 *   1. `adb forward` IS NOT A READINESS CHECK. It registers a local listener and returns 0 whether
 *      or not anything is listening on the device end, so retrying it retried a command that could
 *      not fail. Readiness is now the first byte off the socket, which is the only evidence that
 *      the server is actually serving.
 *   2. CONNECTING PROVED NOTHING EITHER. adb accepts the TCP connection, then tries to open the
 *      device-side socket, and closes the connection when it cannot. `net.createConnection`'s
 *      callback had already fired by then, so `start()` resolved ~10ms before the socket died
 *      empty. Measured: connect at +0ms, closed at +10ms, zero bytes.
 *   3. THE STREAM WAS NOT WHAT THE PARSER EXPECTED. Without `raw_stream`, scrcpy prefixes a dummy
 *      byte, a 64-byte device name and codec metadata — which this parsed — and then a 12-byte
 *      header on EVERY frame, which it did not. Those headers would have been fed to the NAL
 *      splitter as if they were video. `raw_stream=true` turned all of it off.
 *
 *      AND THEN THE PER-FRAME HEADER CAME BACK, ON PURPOSE (M6). A bare stream says a frame has
 *      ended only when the next one begins, so every frame waited for its successor: a frame late
 *      while the screen moved, and on a still screen the last change never arrived at all. The
 *      12-byte frame header is the one piece worth having — it says how long the frame is, so it
 *      can go out the moment it is whole, and it carries the encoder's own timestamp. It is asked
 *      for alone (`send_frame_meta`), with the device name, dummy byte and codec metadata still
 *      off, and it has had the same layout since scrcpy 2.0.
 *
 * The handshake is still where version drift shows up, so that is still where the diagnostics are —
 * and the server's own log goes to STDOUT, not stderr, which is why both are surfaced now.
 */
/** Where the jar lands on the device. */
const DEVICE_JAR = '/data/local/tmp/scrcpy-server.jar';
/** How long to keep trying before calling it a dead stream rather than a slow one. */
const CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_MS = 150;
/** See `CaptureOptions.keyFrameIntervalSeconds`. scrcpy's own default is 10s. */
const DEFAULT_KEYFRAME_SECONDS = 2;

/**
 * scrcpy's `video_codec_options`, handed straight to MediaFormat as `key:type=value` pairs.
 * `bitrate-mode` 2 is MediaFormat's constant bitrate (D77).
 */
export function scrcpyCodecOptions(o: { keyFrameIntervalSeconds?: number; bitrateMode?: 'cbr' }): string {
  return `i-frame-interval:int=${o.keyFrameIntervalSeconds ?? DEFAULT_KEYFRAME_SECONDS}`
    + (o.bitrateMode === 'cbr' ? ',bitrate-mode:int=2' : '');
}
/** How long video may take to begin once the control socket is open, before control is given up. */
const CONTROL_TIMEOUT_MS = 5_000;

/** The control socket could not be opened — the video can still be had without it. */
class ControlUnavailable extends Error {}

/** The next chunk off a paused socket, or why it never came. Leaves the socket paused again. */
function nextData(socket: import('node:net').Socket, ms: number, other?: import('node:net').Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      socket.off('data', onData); socket.off('close', onClose); other?.off('close', onClose);
      fn();
    };
    const onData = (d: Buffer): void => { socket.pause(); done(() => resolve(d)); };
    const onClose = (): void => done(() => reject(new Error('the server closed a socket before the video began')));
    const timer = setTimeout(() => done(() => reject(new Error(`no video within ${ms}ms of opening control`))), ms);
    socket.on('data', onData); socket.once('close', onClose); other?.once('close', onClose);
    socket.resume();
  });
}

export class ScrcpyCapture implements ScreenCapture {
  readonly kind = 'scrcpy';
  readonly stats: CaptureStats = { frames: 0, bytes: 0, startedAt: 0 };
  private server?: ChildProcess;
  private socket?: import('node:net').Socket;
  private port = 0;
  /** Distinguishes a stream we ended from one that died, so only the latter is reported. */
  private stopped = false;
  private readonly framer = new ScrcpyFramer();
  private ctl?: ScrcpyControl;

  /** Only while the socket is open: a dead one must send the caller to adb, not swallow input. */
  get control(): LiveControl | undefined { return this.ctl?.open ? this.ctl : undefined; }

  // A plain field, not a parameter property: this package runs under Node's type stripping, where
  // `constructor(private readonly opts: …)` is syntax that cannot simply be erased.
  private readonly opts: CaptureOptions & { jarPath: string; version: string };
  constructor(opts: CaptureOptions & { jarPath: string; version: string }) { this.opts = opts; }

  async start(onNal: (nal: Buffer, receivedAt: number, frame?: FrameMark) => void): Promise<void> {
    if (!this.opts.control) return this.startOnce(onNal, false);
    try {
      return await this.startOnce(onNal, true);
    } catch (e) {
      // Live input is the better path, not a precondition for the picture: one try, then without it.
      if (!(e instanceof ControlUnavailable) || this.stopped) throw e;
      console.error(`[scrcpy:${this.opts.serial}] no control socket (${e.message}) — streaming without it; input goes over adb`);
      await this.teardown();
      return this.startOnce(onNal, false);
    }
  }

  private async startOnce(onNal: (nal: Buffer, receivedAt: number, frame?: FrameMark) => void, withControl: boolean): Promise<void> {
    const adb = adbPath();
    const serial = this.opts.serial;
    this.stats.startedAt = Date.now();
    this.stopped = false;

    // 1. The jar has to be on the device. Pushed every time rather than checked: the check costs an
    //    adb round trip anyway, and a stale jar from an older agent is a version mismatch that
    //    presents as an unreadable stream.
    await run(adb, ['-s', serial, 'push', this.opts.jarPath, DEVICE_JAR], 60_000);

    // 2. Start the server. `tunnel_forward=true` makes it listen on an abstract socket we then
    //    forward to, which is the direction that works without the device dialling out.
    // A socket name of its own per start (`scrcpy_<scid>`), so a restart never meets a server that
    // has not yet let go of the last one's name.
    const scid = randomBytes(4).readUInt32BE(0) & 0x7fffffff;
    const socketName = `scrcpy_${scid.toString(16).padStart(8, '0')}`;
    const args = [
      '-s', serial, 'shell',
      `CLASSPATH=${DEVICE_JAR}`,
      'app_process', '/', 'com.genymobile.scrcpy.Server', this.opts.version,
      `scid=${scid.toString(16).padStart(8, '0')}`,
      'tunnel_forward=true',
      'audio=false',            // video only; audio is a second socket and a second problem
      `control=${withControl}`,
      'cleanup=false',
      // Annex-B with scrcpy's 12-byte frame header and nothing else. See the class comment: the
      // header is what lets a frame go out the moment it is whole.
      'send_device_meta=false',
      /**
       * THE DUMMY BYTE COMES BACK WITH CONTROL. The server accepts the video socket, then the control
       * socket, and only then starts encoding — so with control on, no video arrives until control
       * is connected, and the first byte (the only honest readiness signal, see `connectWhenServing`)
       * would never come. The dummy byte is sent the moment the video socket is accepted.
       */
      `send_dummy_byte=${withControl}`,
      // The phone's clipboard, pushed to us on every change — nothing here reads it, and it is the
      // tester's data, so it is not asked for.
      ...(withControl ? ['clipboard_autosync=false'] : []),
      // The same switch under both its names: `send_codec_meta` became `send_stream_meta` (4.1
      // knows only the second). An unknown option is a warning in scrcpy's log; a missed one leaves
      // a 12-byte stream header in front of the first frame, which the framer reads as a frame
      // header — every frame after it misaligned, and a black picture with no error. Found on the
      // OnePlus, where the first try sent only the old name.
      'send_codec_meta=false',
      'send_stream_meta=false',
      'send_frame_meta=true',
      `video_bit_rate=${this.opts.bitRate ?? 8_000_000}`,
      // Passed straight to MediaFormat. The syntax is `key:type=value` and scrcpy rejects anything
      // else with `'=' expected` — which is only visible at all because the server's log is now
      // surfaced. See `keyFrameIntervalSeconds` for why the default is not scrcpy's.
      `video_codec_options=${scrcpyCodecOptions(this.opts)}`,
      ...(this.opts.maxSize ? [`max_size=${this.opts.maxSize}`] : []),
      ...(this.opts.maxFps ? [`max_fps=${this.opts.maxFps}`] : []),
    ];
    const server = spawn(adb, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.server = server;
    // scrcpy's server logs to STDOUT, not stderr. Reading only stderr — which is what this did —
    // discards the one place a version mismatch explains itself, and leaves a failed start looking
    // like a device that simply produced nothing.
    const say = (d: Buffer): void => {
      const line = String(d).trim();
      if (line) console.warn(`[scrcpy:${serial}] ${line}`);
    };
    server.stdout?.on('data', say);
    server.stderr?.on('data', say);
    server.on('error', (e) => console.error(`[scrcpy:${serial}] could not start: ${e.message}`));
    // A server that exits during the connect loop must fail fast. Without this the loop below runs
    // its full deadline against a process that is already gone, and reports a timeout rather than
    // the exit that caused it.
    let serverExit: string | undefined;
    server.on('close', (code, signal) => {
      if (!this.stopped) serverExit = `scrcpy server exited (code ${code}, signal ${signal})`;
    });

    // 3. Forward a local port to the server's abstract socket.
    //
    //    NOT retried, and NOT a readiness check — see the class comment. `adb forward` succeeds
    //    whether or not the device end exists, so a failure here is a real adb failure and retrying
    //    it only hides how long we waited. The name carries the `scid` passed above; without one the
    //    server listens on plain `scrcpy`, which is what this used to forward to.
    this.port = 27183 + (hashPort(serial) % 500);
    await run(adb, ['-s', serial, 'forward', `tcp:${this.port}`, `localabstract:${socketName}`], 5_000);

    // 4. Connect, and keep connecting until bytes actually arrive. The first byte is the readiness
    //    signal because it is the only one that cannot lie: everything earlier — the forward, the
    //    TCP handshake — succeeds against a server that is not yet listening.
    const ready = await connectWhenServing({
      port: this.port,
      describe: serial,
      exited: () => serverExit,
    });
    const socket = ready.socket;
    let first = ready.first;
    this.socket = socket;

    // 5. With control: the dummy byte is not video; the control socket is the server's second accept;
    //    and the video that follows is what proves both ends are really there — adb accepts a TCP
    //    connection on its own account whether or not the phone does.
    if (withControl) {
      socket.pause();
      first = first.subarray(1);
      const { createConnection } = await import('node:net');
      const ctlSocket = createConnection({ port: this.port, host: '127.0.0.1' });
      ctlSocket.on('error', () => { /* reported as the video not beginning */ });
      try {
        first = Buffer.concat([first, await nextData(socket, CONTROL_TIMEOUT_MS, ctlSocket)]);
      } catch (e) {
        ctlSocket.destroy();
        throw new ControlUnavailable((e as Error).message);
      }
      ctlSocket.setNoDelay(true);   // a touch is 32 bytes; Nagle would hold it for the next one
      this.ctl = new ScrcpyControl(ctlSocket);
    }

    let misaligned = false;
    const consume = (chunk: Buffer, at: number): void => {
      this.stats.bytes += chunk.length;
      if (this.stats.firstFrameMs === undefined) this.stats.firstFrameMs = at - this.stats.startedAt;
      this.framer.push(chunk, (packet) => {
        // Every frame begins with a start code. One that does not means the framer is reading
        // something other than frame headers — said once, loudly, rather than as a black picture.
        if (!startsAnnexB(packet.data)) {
          if (!misaligned) {
            misaligned = true;
            console.error(`[scrcpy:${serial}] the stream is not framed as expected — does SCRCPY_SERVER_VERSION `
              + `(${this.opts.version}) match the jar at ${this.opts.jarPath}?`);
          }
          return;
        }
        const nals = splitAnnexB(packet.data);
        nals.forEach((nal, i) => {
          this.stats.frames += 1;
          onNal(nal, at, { last: i === nals.length - 1, ...(packet.config ? {} : { ptsUs: packet.ptsUs }) });
        });
      });
    };
    socket.on('data', (chunk: Buffer) => consume(chunk, Date.now()));
    socket.resume();
    // A stream that dies mid-session used to go silent and stay silent, with `stats.frames` frozen
    // and nobody told. Saying so is the difference between "the view froze" and a diagnosable fault.
    socket.on('close', () => {
      if (!this.stopped) {
        console.error(`[scrcpy:${serial}] stream ended after ${this.stats.frames} NALs`
          + `${serverExit ? ` — ${serverExit}` : ''}`);
      }
    });
    socket.on('error', (e) => {
      if (!this.stopped) console.error(`[scrcpy:${serial}] stream error: ${e.message}`);
    });

    // The bytes that proved readiness are video, and dropping them would lose the SPS/PPS that
    // begin the stream — which presents as a permanently black picture rather than as an error.
    consume(first, Date.now());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    this.ctl?.close();
    this.ctl = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.server?.kill('SIGTERM');
    this.server = undefined;
    this.framer.reset();
    if (this.port) {
      await run(adbPath(), ['-s', this.opts.serial, 'forward', '--remove', `tcp:${this.port}`], 5_000)
        .catch(() => { /* the forward goes with the adb server anyway */ });
    }
  }
}

/**
 * Connect to a port and keep reconnecting until it genuinely serves data.
 *
 * THE FIRST BYTE IS THE ONLY HONEST READINESS SIGNAL when the other end is an `adb forward`, and
 * this function exists as a separate, testable unit because getting that wrong is what made the
 * first hardware run of this file report a working capture that delivered nothing. adb accepts the
 * TCP connection on its own account and only then tries to reach the device; when the device-side
 * socket is not listening yet it closes the connection having sent nothing. A caller that treats
 * `connect` as success has been told a truth about adb and nothing at all about the phone.
 *
 * An attempt that closes empty is therefore NOT an error — it is the expected state for the first
 * few hundred milliseconds. Measured against a Samsung SM-S918B: the fourth attempt succeeds.
 *
 * Returns the first chunk alongside the socket. It must not be dropped: it carries the SPS and PPS
 * that begin the stream, and a decoder that never sees them shows a black rectangle rather than an
 * error.
 */
export async function connectWhenServing(opts: {
  port: number;
  host?: string;
  timeoutMs?: number;
  retryMs?: number;
  /** Returns a reason if the process we are waiting on has already died, to fail fast. */
  exited?: () => string | undefined;
  /** Named in the error, so a failure says which device it was about. */
  describe?: string;
}): Promise<{ socket: import('node:net').Socket; first: Buffer }> {
  const { createConnection } = await import('node:net');
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? CONNECT_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError = 'the server never delivered a byte';

  while (Date.now() < deadline) {
    const gone = opts.exited?.();
    if (gone) throw new Error(`${gone}; check the version string matches the jar exactly`);
    attempts++;

    const outcome = await new Promise<{ socket: import('node:net').Socket; first: Buffer } | null>((resolve) => {
      const sock = createConnection({ port: opts.port, host });
      const give = (why: string): void => {
        lastError = why;
        sock.removeAllListeners();
        sock.destroy();
        resolve(null);
      };
      sock.once('data', (first: Buffer) => {
        // Only the failure listeners are removed. The caller installs its own 'close' and 'error'
        // handlers on the returned socket, and needs them to fire for a mid-stream death.
        sock.removeAllListeners('close');
        sock.removeAllListeners('error');
        resolve({ socket: sock, first });
      });
      sock.on('close', () => give('the connection closed before any data arrived'));
      sock.on('error', (e) => give(e.message));
    });

    if (outcome) return outcome;
    await new Promise((r) => setTimeout(r, retryMs));
  }

  throw new Error(
    `no data within ${timeoutMs}ms over ${attempts} attempt(s)`
    + `${opts.describe ? ` on ${opts.describe}` : ''}: ${lastError}`);
}

/* -------------------------------------------------------------------------------- screenrecord */

/**
 * Android's built-in `screenrecord`, straight to stdout.
 *
 * Needs NOTHING on the device — which is why it is here. `--output-format=h264` writes a raw
 * Annex-B elementary stream, so the framing is identical to scrcpy's and everything downstream is
 * unchanged.
 *
 * THE 180-SECOND CAP IS THE PLATFORM'S, not a choice, and it is why this is a fallback rather than
 * the design. `screenrecord` stops itself after at most three minutes, so a live view built on it
 * has to relaunch, and the relaunch loses frames — a visible hitch every three minutes. It is
 * handled here rather than left to surprise somebody, and it is the honest reason to want the jar.
 *
 * Latency is also materially worse: the encoder buffers for recording quality rather than for
 * liveness. Good enough to see what a test is doing; not good enough to call interactive.
 */
/** How long `screenrecord` may take to produce its first byte before it counts as broken. */
const FIRST_FRAME_TIMEOUT_MS = 10_000;

export class ScreenrecordCapture implements ScreenCapture {
  readonly kind = 'screenrecord';
  readonly stats: CaptureStats = { frames: 0, bytes: 0, startedAt: 0 };
  private proc?: ChildProcess;
  private stopped = false;
  private readonly splitter = new NalSplitter();

  private readonly opts: CaptureOptions;
  constructor(opts: CaptureOptions) { this.opts = opts; }

  async start(onNal: (nal: Buffer, receivedAt: number) => void): Promise<void> {
    this.stats.startedAt = Date.now();
    this.stopped = false;
    this.spawnSegment(onNal);

    // `ScreenCapture.start` promises to resolve only once a frame has genuinely arrived, and this
    // used to return the instant the process was spawned. The difference matters for the same
    // reason it mattered in the scrcpy path: a device that produces nothing — a locked screen on
    // some OEMs, a `screenrecord` that refuses the requested size — would report a working capture
    // and then stay silent forever.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(
          `screenrecord produced no data within ${FIRST_FRAME_TIMEOUT_MS}ms on ${this.opts.serial}`));
      }, FIRST_FRAME_TIMEOUT_MS);
      const poll = setInterval(() => {
        if (this.stats.bytes > 0) { clearTimeout(deadline); clearInterval(poll); resolve(); }
      }, 25);
      // Neither timer should hold the process open on its own.
      deadline.unref?.();
      poll.unref?.();
    });
  }

  private spawnSegment(onNal: (nal: Buffer, receivedAt: number) => void): void {
    if (this.stopped) return;
    const args = [
      '-s', this.opts.serial, 'exec-out', 'screenrecord',
      '--output-format=h264',
      `--bit-rate=${this.opts.bitRate ?? 8_000_000}`,
      // 175 rather than 180: relaunching just BEFORE the platform's own cutoff keeps the seam under
      // our control. Letting it hit the cap means the process dies at a moment we only learn about
      // afterwards, which makes the gap longer, not shorter.
      '--time-limit=175',
      ...(this.opts.maxSize ? ['--size', `${this.opts.maxSize}x${Math.round(this.opts.maxSize * 16 / 9)}`] : []),
      '-',
    ];
    const p = spawn(adbPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;

    p.stdout.on('data', (chunk: Buffer) => {
      const at = Date.now();
      this.stats.bytes += chunk.length;
      if (this.stats.firstFrameMs === undefined) this.stats.firstFrameMs = at - this.stats.startedAt;
      this.splitter.push(chunk, (nal) => { this.stats.frames += 1; onNal(nal, at); });
    });
    p.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (line) console.warn(`[screenrecord:${this.opts.serial}] ${line}`);
    });
    p.on('error', (e) => console.error(`[screenrecord:${this.opts.serial}] ${e.message}`));
    p.on('close', () => {
      if (this.stopped) return;
      // The segment ended — either the time limit or a hiccup. Relaunch. The splitter is reset
      // because the next segment starts with its own SPS/PPS and a carried partial NAL from the old
      // one would be prepended to it as garbage.
      this.splitter.reset();
      console.log(`[screenrecord:${this.opts.serial}] segment ended — relaunching (the 180s platform cap)`);
      setTimeout(() => this.spawnSegment(onNal), 50).unref?.();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.proc?.kill('SIGTERM');
    this.proc = undefined;
    this.splitter.reset();
  }
}

/* -------------------------------------------------------------------------------------- helpers */

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${bin} ${args.join(' ')}: ${stderr.trim() || err.message}`));
      resolve(stdout.trim());
    });
  });
}

/** A stable per-device port offset, so two phones on one host never collide. */
function hashPort(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Pick a capture source.
 *
 * scrcpy when the jar has been named, `screenrecord` otherwise — and it SAYS which, because the two
 * behave differently enough that a person debugging a laggy view needs to know which one they are
 * looking at without reading config.
 */
export function createCapture(opts: CaptureOptions): ScreenCapture {
  const jarPath = process.env.SCRCPY_SERVER_PATH;
  const version = process.env.SCRCPY_SERVER_VERSION;
  if (jarPath && version) return new ScrcpyCapture({ ...opts, jarPath, version });
  if (jarPath && !version) {
    console.warn('[capture] SCRCPY_SERVER_PATH is set but SCRCPY_SERVER_VERSION is not — '
      + 'the version string must match the jar exactly. Falling back to screenrecord.');
  }
  return new ScreenrecordCapture(opts);
}
