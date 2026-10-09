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
 * laptop (ADR-0009).
 *
 * INPUT GOES THROUGH scrcpy'S CONTROL SOCKET when the capture has one open: a finger's down, every
 * move and its up are streamed as they happen, so a drag follows the finger. Without one — the jar is
 * absent, or the socket would not open — it goes the way every other input does, through the held
 * adb shell, where a press is a tap and a drag a swipe replayed once the finger lifts.
 */
import {
  RTCPeerConnection, MediaStreamTrack, MediaStream, RTCRtpCodecParameters, RtpPacket, RtpHeader,
} from 'werift';
import type { RTCRtpSender } from 'werift';
import type { SignalChannel, SignalOptions } from '../device.ts';
import type { ScreenCapture, FrameMark, LiveControl } from './capture.ts';

/** Payload bytes per RTP packet. Under a 1280-byte path MTU with room for SRTP and TURN headers. */
const MAX_PAYLOAD = 1100;

/**
 * How long the screen must have been still before a PLI is taken for Chrome's stuck-stream probe
 * (sent at 3 s) rather than a loss (sent within a round trip of it). See D68 at the PLI handler.
 */
const IDLE_PLI_MS = Number(process.env.PHYSICAL_IDLE_PLI_MS ?? 2000);
/** RTCP sender and receiver report packet types (RFC 3550). */
const RTCP_SR = 200;
const RTCP_RR = 201;
let viewerCount = 0;
/** One frame at 60 fps, in microseconds — the step a re-based clock carries on by. */
const FRAME_US = 16_667;
/** The fewest milliseconds between two encoder restarts asked for by viewers — see `requestKeyframe`. */
const KEYFRAME_MIN_MS = Number(process.env.PHYSICAL_KEYFRAME_MIN_MS ?? 1000);

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

/** RBSP bits, read MSB first, as the SPS lays them out (ITU-T H.264 §7.2). */
class Bits {
  private readonly b: number[];
  private i = 0;
  constructor(b: number[]) { this.b = b; }
  u(n: number): number {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const byte = this.b[this.i >> 3];
      if (byte === undefined) throw new RangeError('SPS ended early');
      v = v * 2 + ((byte >> (7 - (this.i & 7))) & 1);
      this.i++;
    }
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) if (++zeros > 31) throw new RangeError('bad Exp-Golomb code');
    return 2 ** zeros - 1 + this.u(zeros);
  }
  se(): number { const k = this.ue(); return k % 2 ? (k + 1) / 2 : -k / 2; }
}

/** Profiles whose SPS carries chroma format, bit depth and scaling lists (§7.3.2.1.1). */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
/** Every profile an SPS may name: Baseline, Main, Extended, and the ones above. */
const PROFILES = new Set([66, 77, 88, ...HIGH_PROFILES]);

/**
 * The picture size an SPS describes, cropping applied — what a browser reports as the video's size,
 * and so the space a touch arrives in. Undefined for anything that does not parse.
 *
 * WHY READ IT RATHER THAN COMPUTE IT. scrcpy drops a touch whose stated size is not the size it is
 * encoding at, silently, by design: it is how it ignores input aimed at a picture from before a
 * rotation. A size computed from the panel is right until the phone turns, or a vendor encoder rounds
 * differently — and then every touch vanishes. The stream says what it is.
 */
export function spsSize(nal: Buffer): { w: number; h: number } | undefined {
  if (nal.length < 4 || (nal[0] & 0x1f) !== NAL_SPS) return undefined;
  // Emulation prevention: `00 00 03` carries `00 00` and the 03 is not part of the syntax.
  const rbsp: number[] = [];
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    if (zeros >= 2 && nal[i] === 3) { zeros = 0; continue; }
    zeros = nal[i] === 0 ? zeros + 1 : 0;
    rbsp.push(nal[i]);
  }
  try {
    /**
     * EVERY FIELD WITHIN ITS RANGE, OR NO ANSWER. Exp-Golomb reads something out of any bytes at all,
     * so a reader that only parses will turn junk into a confident, wrong size — the test's filler
     * SPS came out as 14x28. A wrong size here is worse than none: every touch would name it, and
     * scrcpy would drop every one. The ranges are the standard's (§7.4.2.1.1).
     */
    const bad = (): never => { throw new RangeError('not an SPS'); };
    const r = new Bits(rbsp);
    const profile = r.u(8);
    if (!PROFILES.has(profile)) bad();
    r.u(16);                                              // constraint flags, level
    if (r.ue() > 31) bad();                               // seq_parameter_set_id
    let chroma = 1;
    if (HIGH_PROFILES.has(profile)) {
      chroma = r.ue();
      if (chroma > 3) bad();
      if (chroma === 3) r.u(1);                           // separate_colour_plane_flag
      if (r.ue() > 6 || r.ue() > 6) bad();                // bit depths, luma and chroma, minus 8
      r.u(1);                                             // qpprime_y_zero_transform_bypass
      if (r.u(1)) {                                       // seq_scaling_matrix_present_flag
        for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
          if (!r.u(1)) continue;
          let last = 8, next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
    if (r.ue() > 12) bad();                               // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType > 2) bad();
    if (pocType === 0 && r.ue() > 12) bad();              // log2_max_pic_order_cnt_lsb_minus4
    if (pocType === 1) {
      r.u(1); r.se(); r.se();
      const n = r.ue();
      if (n > 255) bad();
      for (let i = 0; i < n; i++) r.se();
    }
    if (r.ue() > 16) bad();                               // max_num_ref_frames
    r.u(1);                                               // gaps_in_frame_num_value_allowed_flag
    const wMbs = r.ue() + 1;
    const hMaps = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1);                            // mb_adaptive_frame_field_flag
    r.u(1);                                               // direct_8x8_inference_flag
    let w = wMbs * 16;
    let h = (2 - frameMbsOnly) * hMaps * 16;
    if (r.u(1)) {                                         // frame_cropping_flag
      const [left, right, top, bottom] = [r.ue(), r.ue(), r.ue(), r.ue()];
      const cx = chroma === 1 || chroma === 2 ? 2 : 1;
      const cy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
      w -= (left + right) * cx;
      h -= (top + bottom) * cy;
    }
    // A phone's stream: at least a macroblock, and no more than the 16-bit size a touch can state.
    return w >= 16 && h >= 16 && w <= 0xffff && h <= 0xffff ? { w, h } : undefined;
  } catch {
    return undefined;
  }
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

/** Milliseconds from the NTP epoch (1900) to the Unix one (1970). */
const NTP_EPOCH_OFFSET_MS = 2_208_988_800_000;

/** A 64-bit NTP timestamp (RFC 3550 §4): whole seconds since 1900, then the fraction in 1/2^32 s. */
export function ntpNow(epochMs = performance.timeOrigin + performance.now()): bigint {
  const ms = epochMs + NTP_EPOCH_OFFSET_MS;
  const sec = Math.floor(ms / 1000);
  const frac = Math.floor(((ms - sec * 1000) / 1000) * 2 ** 32);
  return (BigInt(sec) << 32n) | BigInt(Math.min(frac, 2 ** 32 - 1));
}

/**
 * GIVE A werift SENDER A CLOCK THE RECEIVER'S REPORTS CAN BE MATCHED AGAINST.
 *
 * Round trip is what the bitrate governor steers by, and werift's came back as 4 ms and −56 ms on a
 * path whose floor is ~90 ms — enough on its own to step a healthy stream down to 0.8 Mbit/s. Two
 * defects in werift 0.24.4, both found by running it:
 *
 *   1. Its `ntpTime()` writes the DECIMAL digits after the point as the binary fraction (1234.567 s
 *      becomes fraction 567, not 0.567 x 2^32), so every sender report within one second carries the
 *      same compact timestamp (LSR) — and a receiver report echoing an older one is matched to the
 *      newest, yielding a round trip short by up to a second, or negative.
 *   2. The report's timestamp is the time of the last RTP packet, so on a still screen consecutive
 *      reports carry the SAME timestamp, which brings the ambiguity back however good the clock.
 *
 * `ntpTimestamp` is a plain field on the sender (the ESM bundle's `ntpTime` is private, so it cannot
 * be patched at the source). Replaced by an accessor, it reads as the correct time NOW whenever werift
 * builds a report, and werift's write after each packet is ignored. The report and the
 * `lastSRtimestamp` matched against it are read in the same synchronous block, and the value is held
 * for exactly that long, so the two are identical. Video only, so the report's NTP and RTP times need not describe the same instant.
 *
 * Every value handed out is also written to the returned log, which is what the round trip is
 * computed from (D78; see `SenderReportLog`).
 */
export function fixSenderClock(sender: object): SenderReportLog {
  const log = new SenderReportLog();
  let cached: bigint | undefined;
  Object.defineProperty(sender, 'ntpTimestamp', {
    configurable: true,
    enumerable: true,
    // Held until the synchronous block that read it is done: werift reads it twice back to back, and a
    // millisecond boundary between the two reads would make the report and its LSR disagree.
    get: () => {
      if (cached === undefined) {
        const at = performance.timeOrigin + performance.now();
        cached = ntpNow(at);
        log.record(cached, at);
        queueMicrotask(() => { cached = undefined; });
      }
      return cached;
    },
    set: () => { /* werift's own value is the defect; see above */ },
  });
  return log;
}

/**
 * THE ROUND TRIP, FROM ANY SENDER REPORT A RECEIVER ECHOES (D78).
 *
 * A receiver report carries LSR, the middle 32 bits of the NTP time of the last sender report it
 * received, and DLSR, how long it held that report before answering. The round trip is now − when that
 * report was sent − DLSR (RFC 3550 §6.4.1).
 *
 * werift computes it only when LSR matches its MOST RECENT sender report (`rtpSender.js`:
 * `this.lastSRtimestamp === report.lsr`). Behind a queue deeper than the gap between sender reports,
 * every receiver report echoes an older one, so werift's `rtt` froze at whatever it last matched. On
 * the OnePlus over a 2 Mbit/s link it read 266 ms while Chrome measured 600–945, and 70 ms against
 * Chrome's 730. That is the queue the governor exists to see, hidden at exactly the moment it is
 * there. So the agent keeps the last few reports it sent and matches any of them.
 */
export class SenderReportLog {
  /** Compact NTP time (the LSR a receiver echoes) → when that report was built, in epoch ms. */
  private readonly sent = new Map<number, number>();

  record(ntp: bigint, epochMs: number): void {
    this.sent.set(Number((ntp >> 16n) & 0xffff_ffffn), epochMs);
    // About a minute of reports at werift's pace; a receiver echoing anything older is not a queue.
    if (this.sent.size > 64) this.sent.delete(this.sent.keys().next().value as number);
  }

  /** Round trip in ms for a report echoing `lsr` after holding it `dlsr` (1/65536 s), if it is ours. */
  rttMs(lsr: number, dlsr: number, now = performance.timeOrigin + performance.now()): number | undefined {
    // LSR 0 means the receiver has not had a sender report yet.
    if (!lsr) return undefined;
    const sentAt = this.sent.get(lsr);
    if (sentAt === undefined) return undefined;
    const rtt = now - sentAt - (dlsr / 65_536) * 1_000;
    return rtt > 0 ? rtt : undefined;
  }
}

/**
 * LET werift'S CONSENT CHECKS WAIT FOR THE QUEUE THEY ARE STUCK IN (D79).
 *
 * werift waits for each consent answer max(500 ms, 2 × the pair's round trip + 200 ms), using the
 * pair's `rtt`, which it updates only when an answer arrives in time. That `rtt` is the one measured
 * at connection, about 70 ms here. Behind a queue of more than half a second every answer came too
 * late and was thrown away, `rtt` never moved, and 30 s later consent expired and the view closed.
 * Seen on the OnePlus, with adaptation on and with it off.
 *
 * The receiver reports measure the same queue, since they ride the same path, so the pair is given
 * that round trip and werift's own formula stretches the wait to fit. werift overwrites it with its
 * own measurement whenever an answer does arrive, which is the same quantity.
 */
export function stretchConsentWait(sender: RTCRtpSender, rttMs: number): void {
  const pair = sender.dtlsTransport?.iceTransport?.connection?.nominated;
  if (pair && rttMs > 0) pair.rtt = rttMs / 1_000;
}

/** What a viewer's receiver reports said, most recently. */
export interface LinkReport {
  /** Round trip from the RTCP sender/receiver reports, in ms. Includes the forward path's queue. */
  rttMs?: number;
  /** Fraction of packets lost since the receiver's previous report, 0..1. */
  fractionLost?: number;
  at: number;
}

/** The rates the stream can step between, highest first. 576x1280 stays readable at the bottom. */
export const BITRATE_TIERS = [4_000_000, 2_500_000, 1_500_000, 800_000, 400_000];

/**
 * THE FRAME RATE A RATE IS ENCODED AT (D77): the highest one at which the encoder will actually
 * hold that rate.
 *
 * Asking an encoder for fewer bits is not the same as getting them. On the OnePlus 8T's Qualcomm
 * encoder, at 576×1280 with the screen scrolling, measured on 2026-10-09:
 * - At its default rate control (VBR), it produced about 2 Mbit/s for any target under that, at 60 fps
 *   and still about 1.7 at 30. That is the D77 stall: the governor reached the bottom tier and the link
 *   stayed full.
 * - At a constant bitrate (`H264Fanout`'s `cbr`), the floors were: 60 fps, 1.37 Mbit/s; 30 fps, 0.80;
 *   20 fps, 0.58; 15 fps, 0.44; 10 fps, 0.40.
 *
 * So a rate under a frame rate's floor runs at the next lower frame rate. The ladder's tiers came out
 * at 4.13, 2.66, 1.49, 0.81 and 0.44 Mbit/s against 4, 2.5, 1.5, 0.8 and 0.4. A phone with a better
 * encoder pays only in smoothness at the bottom two tiers, where the link could not carry 60 fps
 * anyway.
 */
const FRAME_RATE_FLOORS: Array<{ fps: number; from: number }> = [
  { fps: 60, from: 1_400_000 },
  { fps: 30, from: 800_000 },
  { fps: 20, from: 600_000 },
  { fps: 15, from: 0 },
];
export function frameRateFor(bitRate: number): number {
  return FRAME_RATE_FLOORS.find((f) => bitRate >= f.from)!.fps;
}
/** The fewest milliseconds between two steps down: long enough for a step to show in the reports. */
const DOWN_GAP_MS = 4_000;
/**
 * How long a step down is given when the queue is visibly draining: its round trip under
 * `DRAINING` of what it was at the step. Found on the OnePlus over a 2 Mbit/s link: the step to
 * 1.5 Mbit/s was working, 1,567 ms falling to 859 four seconds later, and a second step took the
 * stream to 0.4 Mbit/s and 15 fps for half a minute it did not need to.
 */
const DRAIN_GAP_MS = 8_000;
const DRAINING = 0.8;
/** How long the link must look healthy before a step up is tried, at first. */
const UP_HOLD_MS = Number(process.env.PHYSICAL_BITRATE_UP_HOLD_MS ?? 15_000);
/** The longest that wait grows to after steps up that did not hold. */
const UP_HOLD_MAX_MS = 120_000;
/** A step down this soon after a step up means the step up did not hold. */
const UP_FAILED_WITHIN_MS = 20_000;
/** A report older than this is about a link that may have changed; it no longer counts. */
const REPORT_FRESH_MS = 5_000;
/**
 * Below this share of its rate the stream is not what fills a queue, so a queue is not its to answer.
 * Found live: on a still screen the round trip drifted from 115 to 300 ms on a home link at 4 a.m.,
 * and the stream was stepped down twice for a queue it was not causing.
 */
const ACTIVE_SHARE = 0.3;

/**
 * BANDWIDTH ADAPTATION: what rate the phone's encoder should run at, from what its viewers report.
 *
 * WHY. The stream was a fixed 4 Mbit/s and a link that could not carry it was not told so: measured
 * on a 3 Mbit/s downlink, the relayed view queued to a 1.7 s round trip, Chrome asked for the packets
 * it lost, the retransmissions joined the queue, and 1,992 packets arrived of which 106 were new.
 *
 * THE SIGNAL IS THE QUEUE, NOT AN ESTIMATE. Chrome's REMB starts near 300 kbit/s and only grows while
 * traffic flows, and a phone's screen is still most of the time and then bursts — so its estimate
 * reads as congestion at the start of every session. What a congested link does unmistakably is
 * queue: the round trip of the RTCP reports, which travel with the media, climbs from its floor. That,
 * and loss, are what move the rate.
 *
 * DOWN FAST, UP SLOWLY. Two congested reports in a row step down — straight to the bottom tier the
 * round trip suggests rather than one at a time, because a queue of seconds needs relief now. A step
 * up is one tier, after the link has looked healthy for a while, and when a step up does not hold the
 * wait for the next one doubles: otherwise the rate would saw between two tiers on a link that sits
 * between them.
 *
 * ONE ENCODER FOR EVERY VIEWER, so the slowest viewer sets the rate.
 */
export class BitrateGovernor {
  private readonly tiers: number[];
  private index: number;
  private readonly reports = new Map<string, LinkReport>();
  /** The lowest round trip each viewer has shown: its link's floor, with no queue in it. */
  private readonly floors = new Map<string, number>();
  private congestedTicks = 0;
  private healthySince?: number;
  private lastSwitchAt = -Infinity;
  /** Steps down are spaced from each other only: a step up that did not hold is undone at once. */
  private lastDownAt = -Infinity;
  private lastUpAt?: number;
  /** The worst viewer's round trip when the stream last stepped down: what draining is measured from. */
  private rttAtDown?: number;
  private upHold = UP_HOLD_MS;
  /** Why the last change was made, for the log line. */
  reason = '';

  /**
   * `start` is also the ceiling: it is the rate an operator chose (`PHYSICAL_VIDEO_BIT_RATE`), and a
   * stream capped below the top tier must not climb past it on a clear link. A start between two
   * tiers is itself the top rate, so the encoder and the governor agree on where they began.
   */
  constructor(start: number, tiers: number[] = BITRATE_TIERS) {
    const below = [...tiers].filter((t) => t < start).sort((a, b) => b - a);
    this.tiers = [start, ...below];
    this.index = 0;
  }

  get bitRate(): number { return this.tiers[this.index]; }

  report(viewer: string, r: LinkReport): void {
    // A round trip of zero or less is a clock that could not be matched, not a fast link.
    if (r.rttMs !== undefined && !(r.rttMs > 0)) { const { rttMs: _, ...rest } = r; r = rest; }
    const prev = this.reports.get(viewer);
    this.reports.set(viewer, { ...prev, ...r });
    if (r.rttMs !== undefined && r.rttMs > 0) {
      this.floors.set(viewer, Math.min(this.floors.get(viewer) ?? Infinity, r.rttMs));
    }
  }

  forget(viewer: string): void {
    this.reports.delete(viewer);
    this.floors.delete(viewer);
  }

  /** How congested one viewer's link looks: 0 is clear; >= 1 is congested. */
  private pressure(viewer: string, r: LinkReport): number {
    let p = 0;
    const floor = this.floors.get(viewer);
    if (r.rttMs !== undefined && floor !== undefined) {
      // A queue of more than 150 ms — or of more than the floor itself on a long path — is congestion.
      p = Math.max(p, (r.rttMs - floor) / Math.max(150, floor));
    }
    if (r.fractionLost !== undefined) p = Math.max(p, r.fractionLost / 0.05);
    return p;
  }

  /**
   * Called about once a second, with what the stream has actually been sending (bits per second, over
   * the last few seconds). Returns the new rate when the stream should change, else undefined.
   */
  tick(now: number, sendingBps = Infinity): number | undefined {
    let worst = 0;
    let worstViewer: string | undefined;
    for (const [viewer, r] of this.reports) {
      if (now - r.at > REPORT_FRESH_MS) continue;
      const p = this.pressure(viewer, r);
      if (p > worst) { worst = p; worstViewer = viewer; }
    }
    // Nothing fresh: no viewer, or a still screen sending nothing to report on. Nothing to decide.
    if (worstViewer === undefined && ![...this.reports.values()].some((r) => now - r.at <= REPORT_FRESH_MS)) {
      return undefined;
    }

    // A queue the stream is not filling is somebody else's: neither a reason to go down nor proof the
    // link is clear enough to go up.
    if (sendingBps < this.bitRate * ACTIVE_SHARE) {
      this.congestedTicks = 0;
      if (worst < 0.5) this.healthySince ??= now;
      else this.healthySince = undefined;
      return this.maybeStepUp(now);
    }
    if (worst >= 1) {
      this.congestedTicks += 1;
      this.healthySince = undefined;
    } else {
      this.congestedTicks = 0;
      // "Healthy" is well clear of the line, not merely under it.
      if (worst < 0.5) this.healthySince ??= now;
      else this.healthySince = undefined;
    }

    // A step up that has held as long as a failing one would have taken to fail: the link has room
    // again, so the wait for the next goes back to where it started. Without this it stayed doubled
    // for good, and on the OnePlus a link that had cleared took a minute per tier to climb back.
    if (this.lastUpAt !== undefined && this.lastDownAt < this.lastUpAt && now - this.lastUpAt >= UP_FAILED_WITHIN_MS) {
      this.upHold = UP_HOLD_MS;
    }
    const worstRtt = worstViewer !== undefined ? this.reports.get(worstViewer)?.rttMs : undefined;
    const draining = this.rttAtDown !== undefined && worstRtt !== undefined && worstRtt < this.rttAtDown * DRAINING;
    if (this.congestedTicks >= 2 && now - this.lastDownAt >= (draining ? DRAIN_GAP_MS : DOWN_GAP_MS)
      && this.index < this.tiers.length - 1) {
      // A step up that did not hold goes back to the tier it came from, which carried this link a
      // moment ago. Going by the queue's depth instead took the OnePlus from 2.5 to 0.8 Mbit/s on a
      // link that 1.5 fills well.
      const failedProbe = this.lastUpAt !== undefined && this.lastDownAt < this.lastUpAt
        && now - this.lastUpAt < UP_FAILED_WITHIN_MS;
      // Otherwise, the deeper the queue, the further down: one tier per doubling of the pressure, at
      // most two at once — a queue of seconds wants relief now, and a further step is seconds away if not.
      const steps = failedProbe ? 1 : Math.min(2, Math.max(1, Math.floor(Math.log2(worst)) + 1));
      const from = this.bitRate;
      this.index = Math.min(this.tiers.length - 1, this.index + steps);
      if (failedProbe) this.upHold = Math.min(this.upHold * 2, UP_HOLD_MAX_MS);
      this.rttAtDown = worstRtt;
      const r = this.reports.get(worstViewer!)!;
      const floor = this.floors.get(worstViewer!);
      this.reason = `${fmtRate(from)} → ${fmtRate(this.bitRate)}: `
        + `round trip ${Math.round(r.rttMs ?? 0)} ms against ${Math.round(floor ?? 0)} ms at best, `
        + `${Math.round((r.fractionLost ?? 0) * 100)}% lost`;
      this.lastSwitchAt = now;
      this.lastDownAt = now;
      this.congestedTicks = 0;
      this.healthySince = undefined;
      return this.bitRate;
    }

    return this.maybeStepUp(now);
  }

  private maybeStepUp(now: number): number | undefined {
    if (this.healthySince !== undefined && this.index > 0
      && now - this.healthySince >= this.upHold && now - this.lastSwitchAt >= this.upHold) {
      const from = this.bitRate;
      this.index -= 1;
      this.rttAtDown = undefined;
      this.reason = `${fmtRate(from)} → ${fmtRate(this.bitRate)}: ${Math.round(this.upHold / 1000)} s without congestion`;
      this.lastSwitchAt = now;
      this.lastUpAt = now;
      this.healthySince = undefined;
      return this.bitRate;
    }
    return undefined;
  }
}

const fmtRate = (bps: number): string => `${(bps / 1_000_000).toFixed(1)} Mbit/s`;

/**
 * ONE capture per phone, however many viewers. scrcpy binds one server and one forwarded port per
 * device; a second tab starting a second one would fight the first for both. Started by the first
 * viewer, stopped with the last, and the parameter sets are kept so a viewer that joins mid-stream
 * can be given them before the keyframe it starts on.
 */
/** What a capture is built with: the rate, the frame rate that rate is held at, and the rate control. */
export interface CaptureRate { bitRate: number; maxFps: number; cbr: boolean }

export class H264Fanout {
  private readonly make: (o: CaptureRate) => ScreenCapture;
  private capture?: ScreenCapture;
  private starting?: Promise<void>;
  /** Decides the encoder's rate from the viewers' reports; absent when adaptation is off. */
  readonly governor?: BitrateGovernor;
  private bitRate: number;
  /** A constant bitrate, until an encoder refuses one; see `startCapture`. */
  private cbr: boolean;
  private adaptTimer?: ReturnType<typeof setInterval>;
  private restarting = false;
  /** Every rate change made, in order — for the log, and for tests. */
  readonly changes: Array<{ at: number; bitRate: number; maxFps: number; reason: string }> = [];
  /** Bytes the encoder produced, per second, for the last few seconds — what the stream is sending. */
  private readonly sent: Array<{ at: number; bytes: number }> = [];
  private readonly subs = new Set<(nal: Buffer, at: number, frame?: FrameMark) => void>();
  private keyframeAt = 0;
  sps?: Buffer;
  pps?: Buffer;
  /** What the encoder is producing now, from its latest SPS — see `spsSize`. */
  size?: { w: number; h: number };
  /** Keyframes asked of the encoder, and requests turned away for coming too soon after one. */
  readonly keyframes = { asked: 0, limited: 0 };
  /** When the encoder last produced a picture — how long the screen has been still. */
  lastFrameAt = 0;

  /**
   * `make` builds a capture at the rate given, at the frame rate that rate is held at
   * (`frameRateFor`). `adapt` lets the viewers' reports move that rate (BitrateGovernor); without it
   * the stream stays at `bitRate`, as it always did. `cbr` asks the encoder for a constant bitrate,
   * which is what makes it honour a low one (D77).
   */
  constructor(make: (o: CaptureRate) => ScreenCapture, o: { bitRate?: number; adapt?: boolean; cbr?: boolean } = {}) {
    this.make = make;
    this.bitRate = o.bitRate ?? BITRATE_TIERS[0];
    this.cbr = o.cbr ?? false;
    if (o.adapt) this.governor = new BitrateGovernor(this.bitRate);
  }

  /** The rate the encoder is running at now. */
  get currentBitRate(): number { return this.bitRate; }
  /** The frame rate it is running at now. */
  get currentFps(): number { return frameRateFor(this.bitRate); }

  /** A viewer's receiver report, for the governor. */
  report(viewer: string, r: LinkReport): void { this.governor?.report(viewer, r); }
  forget(viewer: string): void { this.governor?.forget(viewer); }

  private readonly onNal = (nal: Buffer, at: number, frame?: FrameMark): void => {
    const t = nalType(nal);
    if (t === NAL_IDR || t === NAL_NON_IDR) this.lastFrameAt = at;
    if (this.governor) this.sent.push({ at, bytes: nal.length });
    if (t === NAL_SPS) { this.sps = Buffer.from(nal); this.size = spsSize(nal) ?? this.size; }
    else if (t === NAL_PPS) this.pps = Buffer.from(nal);
    for (const s of this.subs) s(nal, at, frame);
  };

  private startCapture(): ScreenCapture {
    const cbr = this.cbr;
    const capture = this.make({ bitRate: this.bitRate, maxFps: frameRateFor(this.bitRate), cbr });
    this.capture = capture;
    this.starting = capture.start(this.onNal).catch((e) => {
      if (this.capture !== capture) throw e;
      /**
       * AN ENCODER THAT REFUSES A CONSTANT BITRATE GETS ITS OWN RATE CONTROL, ONCE, AND KEEPS IT.
       * `bitrate-mode` is a request MediaCodec may decline, and only the OnePlus has been run with it.
       * Without this a phone whose encoder declines would have no live view at all: worse than the
       * soft floor D77 is about.
       */
      if (cbr) {
        this.cbr = false;
        console.warn(`[video] the encoder would not start at a constant bitrate (${(e as Error).message}); `
          + 'using its own rate control from now on');
        void capture.stop().catch(() => {});
        this.startCapture();
        return this.starting;
      }
      // A capture that could not start leaves nobody holding it, so the next viewer tries afresh.
      this.capture = undefined;
      this.starting = undefined;
      throw e;
    });
    if (this.governor && !this.adaptTimer) {
      this.adaptTimer = setInterval(() => this.adapt(), 1_000);
      this.adaptTimer.unref?.();
    }
    return capture;
  }

  /**
   * Put the governor's decision into effect: the encoder is restarted at the new rate.
   *
   * A RESTART, BECAUSE THERE IS NO OTHER WAY IN. scrcpy 4.1 has no control message for the bitrate
   * (its message types were read from the jar), so a new rate is a new server. The viewers keep their
   * connections: the new encoder begins on a keyframe with its parameter sets, and `stream()` re-bases
   * its clock (the same path a keyframe request takes). The old capture stops first, because a phone
   * serves one scrcpy server per forwarded port.
   */
  async setBitRate(bitRate: number, reason = ''): Promise<void> {
    if (bitRate === this.bitRate || this.restarting) return;
    this.bitRate = bitRate;
    this.changes.push({ at: Date.now(), bitRate, maxFps: frameRateFor(bitRate), reason });
    const old = this.capture;
    if (!old || this.subs.size === 0) return;
    this.restarting = true;
    try {
      await old.stop();
      if (this.subs.size === 0) return;
      this.startCapture();
      await this.starting;
    } catch (e) {
      console.error(`[video] restarting the encoder at ${fmtRate(bitRate)} failed: ${(e as Error).message}`);
    } finally {
      this.restarting = false;
    }
  }

  /** What the stream has sent over the last three seconds, in bits per second. */
  sendingBps(now = Date.now()): number {
    while (this.sent.length && now - this.sent[0].at > 3_000) this.sent.shift();
    return (this.sent.reduce((n, x) => n + x.bytes, 0) * 8) / 3;
  }

  private adapt(): void {
    if (!this.governor || this.restarting || !this.capture) return;
    const now = Date.now();
    const next = this.governor.tick(now, this.sendingBps(now));
    if (next !== undefined) {
      console.log(`[video] the stream ${next < this.bitRate ? 'drops' : 'rises'} to ${fmtRate(next)} at ${frameRateFor(next)} fps`
        + ` — ${this.governor.reason}`);
      void this.setBitRate(next, this.governor.reason);
    }
  }

  get viewers(): number { return this.subs.size; }

  /** The phone's live input while the capture has it — undefined sends input the adb way. */
  get control(): LiveControl | undefined { return this.capture?.control; }

  /**
   * A keyframe now, for a viewer that cannot decode what it has — its PLI — or has just joined.
   *
   * ONE PER KEYFRAME_MIN_MS, FOR EVERY VIEWER. Restarting the encoder costs every viewer a short gap
   * and a large frame, and a browser that is losing packets asks again on each one it notices; the
   * keyframe it gets answers all of them. Without the control socket there is nothing to ask, and the
   * encoder's own interval (`keyFrameIntervalSeconds`) is the answer.
   */
  requestKeyframe(): boolean {
    const now = Date.now();
    if (now - this.keyframeAt < KEYFRAME_MIN_MS) { this.keyframes.limited += 1; return false; }
    if (!this.control?.resetVideo()) return false;
    this.keyframeAt = now;
    this.keyframes.asked += 1;
    return true;
  }

  async subscribe(onNal: (nal: Buffer, at: number, frame?: FrameMark) => void): Promise<() => void> {
    this.subs.add(onNal);
    // A viewer joining a capture already running starts on the NEXT keyframe — which, on a screen
    // that is not moving, may not come for as long as nothing changes. So it asks for one.
    const joining = Boolean(this.capture);
    if (!this.capture) this.startCapture();
    await this.starting;
    if (joining) this.requestKeyframe();
    let gone = false;
    return () => {
      if (gone) return;
      gone = true;
      this.subs.delete(onNal);
      if (this.subs.size === 0 && this.capture) {
        const c = this.capture;
        this.capture = undefined;
        this.starting = undefined;
        clearInterval(this.adaptTimer);
        this.adaptTimer = undefined;
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

/** Android keycodes for the phone's buttons, sent over the control socket. */
const BUTTON_KEYCODES: Record<'home' | 'back' | 'recents' | 'power', number> = { home: 3, back: 4, recents: 187, power: 26 };

/**
 * `KeyboardEvent.code` to the Android keycode it presses, for the keys that type nothing. Over adb
 * only Enter and Backspace go through; the control socket can press any key, so the ones a form needs
 * — Tab, the arrows, Delete — come with it.
 */
const KEYCODES: Record<string, number> = {
  Enter: 66, NumpadEnter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 111,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
};

/** Where live input goes: the fanout, which knows the capture's control socket and the encoded size. */
export interface LiveInput {
  readonly control?: LiveControl;
  readonly size?: { w: number; h: number };
}

/**
 * The browser's `input-channel` messages, turned into the phone's input.
 *
 * LIVE WHEN IT CAN BE. With a control socket open, a finger's down, its moves and its up go to the
 * phone as they arrive, in the video's own pixels — a drag follows the finger, a long press is long,
 * and a press is decided by the phone, as a real one is. Keys and text go the same way, unbatched.
 *
 * OTHERWISE, OVER adb: a press is a tap and a drag a swipe, decided on release, exactly as the screen-
 * without-video view decides it (M4) — the distance is the only honest test, and deciding on press
 * would tap at the start of every scroll. Typed characters are gathered for a moment and sent as one
 * `input text`, because each call spawns a process on the phone and a person types faster than that.
 *
 * A gesture stays on the path it began on: one that started over adb is finished over adb even if the
 * control socket opens halfway through, or the phone would be told about an up it never saw go down.
 */
export class InputMapper {
  private readonly input: PhoneInput;
  private readonly live?: LiveInput;
  private readonly video: { w: number; h: number };
  private readonly kx: number;
  private readonly ky: number;
  private readonly downs = new Map<number, { x: number; y: number; at: number; lx: number; ly: number; live: boolean }>();
  private shift = false;
  private typed = '';
  private flush?: ReturnType<typeof setTimeout>;
  /** The latest thing sent to the phone, and when — what `PHYSICAL_VIDEO_TRACE` times a frame against. */
  last?: { verb: string; at: number; doneAt?: number; framed?: boolean };

  constructor(input: PhoneInput, screen: { width: number; height: number }, video: { w: number; h: number }, live?: LiveInput) {
    this.input = input;
    this.live = live;
    this.video = video;
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
    if (!name || m.button_state !== 'down') return;
    if (this.live?.control?.key(BUTTON_KEYCODES[name])) return this.record(name);
    this.send(name, () => this.input.key(name));
  }

  /** Every adb verb goes out through here, so the latest one is on record with its timing. */
  private send(verb: string, act: () => Promise<void>): void {
    const rec: NonNullable<InputMapper['last']> = { verb, at: Date.now() };
    this.last = rec;
    void act().then(() => { rec.doneAt = Date.now(); }, () => {});
  }

  /** A live one is done when it is written: the phone has it as soon as the socket does. */
  private record(verb: string): void {
    const at = Date.now();
    this.last = { verb, at, doneAt: at };
  }

  private liveTouch(action: 'down' | 'move' | 'up', id: number, x: number, y: number): boolean {
    const control = this.live?.control;
    return Boolean(control?.touch(action, id, x, y, this.live?.size ?? this.video));
  }

  private touch(m: Record<string, unknown>): void {
    const id = Number((m.id as unknown[])?.[0] ?? 0);
    const vx = Number((m.x as unknown[])?.[0]);
    const vy = Number((m.y as unknown[])?.[0]);
    if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(id)) return;
    const x = Math.round(vx * this.kx);
    const y = Math.round(vy * this.ky);
    const d = this.downs.get(id);
    if (m.down) {
      if (!d) {
        const live = this.liveTouch('down', id, vx, vy);
        this.downs.set(id, { x, y, at: Date.now(), lx: x, ly: y, live });
        if (live) this.record('press');
      } else {
        d.lx = x; d.ly = y;
        if (d.live) this.liveTouch('move', id, vx, vy);
      }
      return;
    }
    if (!d) return;
    this.downs.delete(id);
    if (d.live) {
      this.liveTouch('up', id, vx, vy);
      this.record('release');
      return;
    }
    const moved = Math.hypot(x - d.x, y - d.y);
    // 24 device pixels — about the width of a fingertip's wobble at 480dpi.
    if (moved < 24) this.send('tap', () => this.input.tap(d.x, d.y));
    else this.send('swipe', () => this.input.swipe(d.x, d.y, x, y, Math.max(100, Math.min(1500, Date.now() - d.at))));
  }

  private keyboard(code: string, kind: string): void {
    if (/^Shift(Left|Right)$/.test(code)) { this.shift = kind === 'keydown'; return; }
    if (kind !== 'keydown') return;
    const control = this.live?.control;
    if (control) {
      const keycode = KEYCODES[code];
      const ch = keycode === undefined ? charFor(code, this.shift) : undefined;
      if (keycode === undefined && !ch) return;
      this.sendTyped();   // anything still gathered for adb goes first, so the order holds
      if (keycode !== undefined ? control.key(keycode) : control.text(ch!)) {
        return this.record(keycode !== undefined ? code : 'text');
      }
    }
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

/** How long a browser's relay-over-TCP candidate is held back, so its relay-over-UDP one can win. */
const TCP_RELAY_HOLD_MS = Number(process.env.PHYSICAL_TCP_RELAY_HOLD_MS ?? 1500);
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

/**
 * A browser's relay candidate that reaches the relay over TCP or TLS rather than UDP.
 *
 * WHY IT MATTERS: werift nominates the first pair whose check succeeds, and never moves (see D70). A
 * browser gathers its relay over UDP and over TCP; when the TCP allocation happens to finish first,
 * werift locks onto it — and a 4 Mbit/s stream down TURN-over-TCP queues behind its own congestion
 * control until consent checks time out. Measured in the console: a 6.2 s round trip, the view
 * stalling, and a `disconnected` every few seconds, with a UDP relay candidate sitting unused.
 *
 * THE LINE DOES NOT SAY. A relay candidate's transport is always `udp` (the leg between the peers),
 * whatever carries it to the relay. The priority says: browsers rank a relay by how they reach it,
 * and put that in the top byte — Chrome 3 for UDP and 1 for TCP (0 for TLS), Firefox 5 and 0.
 */
export function relayOverTcp(candidate: unknown): boolean {
  const line = typeof candidate === 'string' ? candidate : (candidate as { candidate?: unknown } | null)?.candidate;
  if (typeof line !== 'string') return false;
  const f = line.trim().replace(/^a=/, '').split(/\s+/);
  const typ = f.indexOf('typ');
  const priority = Number(f[3]);
  return typ > 0 && f[typ + 1] === 'relay' && Number.isFinite(priority) && (priority >>> 24) < 2;
}

/**
 * THE AGENT NEVER RELAYS ITSELF (D70) — STUN only, whatever the console names.
 *
 * werift sends every packet down the first pair IT nominated and never moves, and with a relay of its
 * own that pair can be one of its relay pairs while the browser — the controlled side — settles on
 * another. Then the media goes out through the relay to a path the browser is not listening on. Found
 * the day the relay moved to the control plane and became reachable (ADR-0047): with the agent
 * holding an allocation, Chrome's direct path froze after its first frames and its relayed path
 * received a megabyte it threw away; a werift viewer, which accepts packets from anywhere, saw none
 * of it. Without the agent's relay both paths streamed.
 *
 * Nothing is lost by it. A browser that needs the relay has its own allocation, and a relayed browser
 * reaches the agent's public address — that is what STUN is kept for. Only an agent whose network
 * blocks outbound UDP outright is beyond reach, and that agent's werift relay was the broken path.
 *
 * It also retires the relay probe (D67): a relay werift is never given cannot hold its offer.
 */
export function agentIceServers(servers: IceServer[]): IceServer[] {
  const stun = servers
    .map((s) => ({ urls: ([] as string[]).concat(s.urls).filter((u) => parseIceUrl(u)?.scheme.startsWith('stun')) }))
    .filter((s) => s.urls.length);
  return stun.length ? stun : [{ urls: DEFAULT_STUN }];
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
  /** This viewer has been sent a keyframe, so it has a whole picture to hold on a still screen. */
  private keyframeSent = false;
  /** Who this viewer is to the governor: one phone can have several. */
  private readonly viewer = `viewer-${++viewerCount}`;
  private reports = 0;
  private lastReport?: { lost: number; seq: number };

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
      const add = () => { if (this.pc && !this.closed) void this.pc.addIceCandidate(p.candidate as never).catch(() => {}); };
      // Held, not dropped: on a network that blocks UDP it is the only way in, and arrives late.
      if (relayOverTcp(p.candidate)) setTimeout(add, TCP_RELAY_HOLD_MS).unref?.();
      else add();
    }
  }

  private async offer(iceServers: unknown): Promise<void> {
    if (this.pc || this.closed) return;
    const log = (line: string) => console.log(`[video:${this.o.label}] ${line}`);
    const servers = agentIceServers(iceServersFrom(iceServers));
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
    const video = pc.addTransceiver(track, { direction: 'sendonly', streams: [new MediaStream({ id: `display_${this.o.label}` })] });
    const sentReports = fixSenderClock(video.sender);
    /**
     * A PLI IS ANSWERED. The browser sends one when it cannot decode what it has — a lost packet in a
     * keyframe, a decoder reset — and until it gets a keyframe the picture is frozen or smeared. Left
     * unanswered (as it was), that lasted until the encoder's next scheduled keyframe, and on a screen
     * that is not moving there is no next one. See `H264Fanout.requestKeyframe` for the rate limit.
     */
    /**
     * THE VIEWER'S RECEIVER REPORTS, FOR THE GOVERNOR, AND FOR werift'S CONSENT CHECKS.
     * - The round trip comes from the report's echo of one of our sender reports. The SR rides with the
     *   media, so the round trip carries the forward queue. It is computed here, from our own record of
     *   those reports, and not read from werift, whose value freezes behind a queue (D78).
     * - That round trip also sets how long werift waits for a consent answer (D79).
     * - Loss is from the report's cumulative counters.
     */
    video.sender.onRtcp.subscribe((packet) => {
      if (packet.type !== RTCP_SR && packet.type !== RTCP_RR) return;
      const s = video.sender as unknown as { ssrc: number };
      /**
       * LOSS OVER ENOUGH PACKETS TO MEAN SOMETHING. The report's own fraction is over whatever arrived
       * since the last one, and on a still screen that is a packet or two: one lost read as "50% lost"
       * and counted as congestion. The cumulative counters give the span; under 30 packets, no verdict.
       */
      const rep = (packet as unknown as {
        reports?: Array<{ ssrc: number; packetsLost: number; highestSequence: number; lsr: number; dlsr: number }>;
      }).reports?.find((r) => r.ssrc === s.ssrc);
      const rttMs = rep ? sentReports.rttMs(rep.lsr, rep.dlsr) : undefined;
      if (rttMs !== undefined) stretchConsentWait(video.sender, rttMs);
      let fractionLost: number | undefined;
      if (rep) {
        const prev = this.lastReport;
        this.lastReport = { lost: rep.packetsLost, seq: rep.highestSequence };
        const expected = prev ? rep.highestSequence - prev.seq : 0;
        if (prev && expected >= 30) fractionLost = Math.max(0, rep.packetsLost - prev.lost) / expected;
      }
      if (TRACE && ++this.reports % 5 === 0) {
        log(`link: round trip ${rttMs !== undefined ? Math.round(rttMs) : '?'} ms, `
          + `${fractionLost === undefined ? 'loss n/a' : `${Math.round(fractionLost * 100)}% lost`}, `
          + `sending ${(this.o.fanout.sendingBps() / 1e6).toFixed(2)} of ${(this.o.fanout.currentBitRate / 1e6).toFixed(1)} Mbit/s`
          + ` at ${this.o.fanout.currentFps} fps`);
      }
      this.o.fanout.report(this.viewer, {
        ...(rttMs !== undefined ? { rttMs } : {}),
        ...(fractionLost !== undefined ? { fractionLost } : {}),
        at: Date.now(),
      });
    });
    video.sender.onPictureLossIndication.subscribe(() => {
      /**
       * BUT NOT CHROME'S PROBE OF A STILL SCREEN (D68). Chrome also sends a PLI when no frame has come
       * for 3 s while packets came within 5 — its "is this stream stuck?" check, not a loss. Answered,
       * the restart's frames count as packets, so 3 s after them it asked again: on the farm, a still
       * home screen restarted the encoder every ~4 s for as long as anybody watched it — 4 keyframes
       * and 245 KB in 20 idle seconds. A PLI for a real loss comes while frames are flowing, within a
       * round trip of the frame it lost; one that comes after the screen has been still this long,
       * to a viewer already given a keyframe, is the probe. Left unanswered, Chrome asks once and stops.
       */
      const stillMs = Date.now() - this.o.fanout.lastFrameAt;
      if (this.keyframeSent && stillMs >= IDLE_PLI_MS) {
        if (TRACE) log(`the viewer asked for a keyframe (PLI) after ${stillMs}ms of a still screen — its picture is whole, so no restart`);
        return;
      }
      const asked = this.o.fanout.requestKeyframe();
      if (TRACE) log(`the viewer asked for a keyframe (PLI): ${asked ? 'encoder restarted' : 'not now'}`);
    });

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
    let lastUs: number | undefined;
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
          /**
           * FORWARD ONLY. A restarted encoder — a keyframe asked for, a rotation — may start its clock
           * again, and a receiver takes a frame whose timestamp went backwards as a late copy of an old
           * one and drops it: the very keyframe that was asked for. So a clock that steps back is
           * re-based to carry on one frame after the last.
           */
          if (lastUs !== undefined && frame.ptsUs - pts0 <= lastUs) pts0 = frame.ptsUs - (lastUs + FRAME_US);
          lastUs = frame.ptsUs - pts0;
          ts = Math.round((lastUs * 90) / 1000) >>> 0;
        } else {
          ts = ((at - t0) * 90) >>> 0;
        }
        if (keyframe && this.o.fanout.sps && this.o.fanout.pps) {
          send(this.o.fanout.sps, ts, false);
          send(this.o.fanout.pps, ts, false);
        }
        if (keyframe) this.keyframeSent = true;
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
    this.o.fanout.forget(this.viewer);
    this.unsubscribe?.();
    void this.pc?.close().catch(() => {});
  }
}
