import { deflateSync, inflateSync } from 'node:zlib';

/**
 * PAINTING OVER A SECRET IN A SCREENSHOT (ADR-0045).
 *
 * Found on the farm 2026-09-27: the element list the model reads had `{{NOTE}}` where a search box
 * showed the value — and the model read the value off the SCREENSHOT instead ("typed {{NOTE}}
 * (zq7481)"). A plain text field draws what was typed into it. So wherever an element's text held a
 * secret, its box is painted over in the image too, before the model is sent it or the run keeps it.
 *
 * A minimal PNG editor, because nothing in the repo reads images: 8-bit RGB or RGBA, not interlaced —
 * what Android's screencap and XCUITest produce. Anything else answers NULL, and the caller withholds
 * the screenshot rather than send one it could not cover. Ancillary chunks are dropped on the way out.
 */

export interface Box { x: number; y: number; width: number; height: number }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Dark, opaque, and not black — a box a person reading the step can tell was put there. */
const PAINT = [0x2a, 0x2a, 0x30];

interface Decoded { width: number; height: number; channels: 3 | 4; pixels: Buffer }

export function decodePng(png: Buffer): Decoded | null {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) return null;
  let at = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  while (at + 12 <= png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!ihdr || !idat.length) return null;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, colour, , , interlace] = [ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]];
  if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) return null;
  const channels = colour === 6 ? 4 : 3;
  const stride = width * channels;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
  if (raw.length < height * (stride + 1)) return null;

  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = up ? up[i]! : 0;
      const c = up && i >= channels ? up[i - channels]! : 0;
      let v = src[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      row[i] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

export function encodePng(img: Decoded): Buffer {
  const stride = img.width * img.channels;
  const raw = Buffer.alloc(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) img.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = img.channels === 4 ? 6 : 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * The screenshot with each box painted over. Boxes are in the DEVICE's coordinates (`screen`) —
 * pixels on Android, points on iOS, where the image is 2–3× larger — so they are scaled to the image.
 * Null when the image is not one this can edit.
 */
export function coverBoxes(pngB64: string, boxes: Box[], screen: { width: number; height: number }): string | null {
  const img = decodePng(Buffer.from(pngB64, 'base64'));
  if (!img) return null;
  const sx = img.width / (screen.width || img.width);
  const sy = img.height / (screen.height || img.height);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x * sx)), y0 = Math.max(0, Math.floor(b.y * sy));
    const x1 = Math.min(img.width, Math.ceil((b.x + b.width) * sx)), y1 = Math.min(img.height, Math.ceil((b.y + b.height) * sy));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * img.width + x) * img.channels;
        img.pixels[o] = PAINT[0]!; img.pixels[o + 1] = PAINT[1]!; img.pixels[o + 2] = PAINT[2]!;
        if (img.channels === 4) img.pixels[o + 3] = 0xff;
      }
    }
  }
  return encodePng(img).toString('base64');
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
