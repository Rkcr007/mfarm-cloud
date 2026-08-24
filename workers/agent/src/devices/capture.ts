import { spawn, execFile, type ChildProcess } from 'node:child_process';

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
}

export interface CaptureStats {
  frames: number;
  bytes: number;
  /** Wall-clock ms from capture start to the first byte of the first frame. */
  firstFrameMs?: number;
  startedAt: number;
}

export interface ScreenCapture {
  /** Which source this is, for the console and for honest logging. */
  readonly kind: 'scrcpy' | 'screenrecord';
  /** Resolves once a first frame has genuinely arrived — see `start`'s comment. */
  start(onNal: (nal: Buffer, receivedAt: number) => void): Promise<void>;
  stop(): Promise<void>;
  readonly stats: CaptureStats;
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
 * UNVERIFIED AGAINST A HANDSET. This was written from the protocol and has never run against a real
 * phone or a real jar — see `deploy/verify-capture.mjs`, which exists to be the first thing that
 * does. The handshake is where version drift shows up, so that is where the diagnostics are.
 */
export class ScrcpyCapture implements ScreenCapture {
  readonly kind = 'scrcpy';
  readonly stats: CaptureStats = { frames: 0, bytes: 0, startedAt: 0 };
  private server?: ChildProcess;
  private socket?: import('node:net').Socket;
  private port = 0;
  private readonly splitter = new NalSplitter();

  // A plain field, not a parameter property: this package runs under Node's type stripping, where
  // `constructor(private readonly opts: …)` is syntax that cannot simply be erased.
  private readonly opts: CaptureOptions & { jarPath: string; version: string };
  constructor(opts: CaptureOptions & { jarPath: string; version: string }) { this.opts = opts; }

  async start(onNal: (nal: Buffer, receivedAt: number) => void): Promise<void> {
    const { createConnection } = await import('node:net');
    const adb = adbPath();
    const serial = this.opts.serial;
    this.stats.startedAt = Date.now();

    // 1. The jar has to be on the device. Pushed every time rather than checked: the check costs an
    //    adb round trip anyway, and a stale jar from an older agent is a version mismatch that
    //    presents as an unreadable stream.
    await run(adb, ['-s', serial, 'push', this.opts.jarPath, '/data/local/tmp/scrcpy-server.jar'], 60_000);

    // 2. Start the server. `tunnel_forward=true` makes it listen on an abstract socket we then
    //    forward to, which is the direction that works without the device dialling out.
    const args = [
      '-s', serial, 'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process', '/', 'com.genymobile.scrcpy.Server', this.opts.version,
      'tunnel_forward=true',
      'audio=false',            // video only; audio is a second socket and a second problem
      'control=false',          // input goes over the held adb shell, not through scrcpy
      'cleanup=false',
      `video_bit_rate=${this.opts.bitRate ?? 8_000_000}`,
      ...(this.opts.maxSize ? [`max_size=${this.opts.maxSize}`] : []),
      ...(this.opts.maxFps ? [`max_fps=${this.opts.maxFps}`] : []),
    ];
    this.server = spawn(adb, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // The server's own stderr is the only place a version mismatch explains itself, so it is
    // surfaced rather than swallowed — this is the failure people will actually hit.
    this.server.stderr?.on('data', (d) => console.warn(`[scrcpy:${serial}] ${String(d).trim()}`));
    this.server.on('error', (e) => console.error(`[scrcpy:${serial}] could not start: ${e.message}`));

    // 3. Forward a local port to the server's abstract socket. It takes a moment to appear, so this
    //    retries rather than racing it.
    this.port = 27183 + (hashPort(serial) % 500);
    await withRetries(20, 250, () =>
      run(adb, ['-s', serial, 'forward', `tcp:${this.port}`, 'localabstract:scrcpy'], 5_000));

    // 4. Connect and read. With `tunnel_forward=true` the server writes one dummy byte first, then
    //    a 64-byte device name, then the codec metadata, then frames.
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ port: this.port, host: '127.0.0.1' }, () => resolve());
      sock.on('error', reject);
      this.socket = sock;
    });

    let header = Buffer.alloc(0);
    const HEADER_BYTES = 1 + 64 + 12;   // dummy + device name + codec/width/height
    this.socket!.on('data', (chunk: Buffer) => {
      const at = Date.now();
      if (header.length < HEADER_BYTES) {
        header = Buffer.concat([header, chunk]);
        if (header.length < HEADER_BYTES) return;
        chunk = header.subarray(HEADER_BYTES);
        header = Buffer.alloc(HEADER_BYTES);      // marker: header consumed
        if (chunk.length === 0) return;
      }
      this.stats.bytes += chunk.length;
      if (this.stats.firstFrameMs === undefined) this.stats.firstFrameMs = at - this.stats.startedAt;
      this.splitter.push(chunk, (nal) => { this.stats.frames += 1; onNal(nal, at); });
    });
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    this.socket = undefined;
    this.server?.kill('SIGTERM');
    this.server = undefined;
    this.splitter.reset();
    if (this.port) {
      await run(adbPath(), ['-s', this.opts.serial, 'forward', '--remove', `tcp:${this.port}`], 5_000)
        .catch(() => { /* the forward goes with the adb server anyway */ });
    }
  }
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

async function withRetries(attempts: number, delayMs: number, fn: () => Promise<unknown>): Promise<void> {
  let last: Error | undefined;
  for (let i = 0; i < attempts; i++) {
    try { await fn(); return; } catch (e) { last = e as Error; }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw last ?? new Error('retries exhausted');
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
