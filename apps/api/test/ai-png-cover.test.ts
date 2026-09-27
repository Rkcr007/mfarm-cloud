/**
 * ADR-0045: painting over a secret in a screenshot. The model read a typed value off the IMAGE on the
 * farm once the element list no longer had it; these check the editor that closes that door, and that
 * it refuses — rather than guesses at — an image it cannot edit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { coverBoxes, decodePng, encodePng } from '../src/ai/png-cover.ts';

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(width: number, height: number, raw: Buffer, { depth = 8, colour = 6, interlace = 0 } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = colour; ihdr[12] = interlace;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A picture with texture in every channel, so a filter decoded wrong cannot pass by luck. */
function picture(w: number, h: number, ch: 3 | 4): Buffer {
  const p = Buffer.alloc(w * h * ch);
  for (let i = 0; i < p.length; i++) p[i] = (i * 37 + (i >> 5) * 11) & 0xff;
  return p;
}

/** Rows encoded with the filter type given for each — how real encoders mix them. */
function filtered(pixels: Buffer, w: number, h: number, ch: number, filterOf: (y: number) => number): Buffer {
  const stride = w * ch;
  const out = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const f = filterOf(y);
    out[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i]!;
      const a = i >= ch ? pixels[y * stride + i - ch]! : 0;
      const b = y ? pixels[(y - 1) * stride + i]! : 0;
      const c = y && i >= ch ? pixels[(y - 1) * stride + i - ch]! : 0;
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1
        : f === 4 ? (() => { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })()
        : 0;
      out[y * (stride + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  return out;
}

test('every PNG row filter decodes back to the picture — RGBA and RGB', () => {
  for (const ch of [4, 3] as const) {
    const w = 23, h = 11;
    const pix = picture(w, h, ch);
    const img = decodePng(png(w, h, filtered(pix, w, h, ch, (y) => y % 5), { colour: ch === 4 ? 6 : 2 }))!;
    assert.ok(img, `channels ${ch}`);
    assert.deepEqual([img.width, img.height, img.channels], [w, h, ch]);
    assert.ok(img.pixels.equals(pix), `filters 0–4 undone exactly (channels ${ch})`);
    assert.ok(decodePng(encodePng(img))!.pixels.equals(pix), 'and what it writes, it reads back');
  }
});

test('a box in device coordinates is painted where the device drew it — scaled, as iOS points are', () => {
  const w = 100, h = 200;
  const white = Buffer.alloc(w * h * 4, 0xff);
  const b64 = encodePng({ width: w, height: h, channels: 4, pixels: white }).toString('base64');
  // The device is 50×100 (points); the image is twice that.
  const out = decodePng(Buffer.from(coverBoxes(b64, [{ x: 10, y: 20, width: 15, height: 20 }], { width: 50, height: 100 })!, 'base64'))!;
  const at = (x: number, y: number) => [...out.pixels.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  assert.deepEqual(at(20, 40), [0x2a, 0x2a, 0x30, 0xff], 'the box\'s first pixel, scaled ×2');
  assert.deepEqual(at(49, 79), [0x2a, 0x2a, 0x30, 0xff], 'its last');
  assert.deepEqual(at(50, 40), [0xff, 0xff, 0xff, 0xff], 'one past it is untouched');
  assert.deepEqual(at(19, 40), [0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(at(0, 0), [0xff, 0xff, 0xff, 0xff]);
  assert.ok(coverBoxes(b64, [{ x: -10, y: -10, width: 500, height: 500 }], { width: 50, height: 100 }), 'a box past the edge is clipped, not an error');
});

test('an image it cannot edit is refused — the caller then withholds it rather than send it as it was', () => {
  const raw = filtered(picture(4, 4, 4), 4, 4, 4, () => 0);
  assert.equal(decodePng(png(4, 4, raw, { depth: 16 })), null, '16-bit');
  assert.equal(decodePng(png(4, 4, raw, { interlace: 1 })), null, 'interlaced');
  assert.equal(decodePng(png(4, 4, raw, { colour: 3 })), null, 'palette');
  assert.equal(decodePng(Buffer.from('\x89PNG\r\n\x1a\nfake-screen')), null, 'not a PNG at all');
  assert.equal(coverBoxes(Buffer.from('fake').toString('base64'), [{ x: 0, y: 0, width: 1, height: 1 }], { width: 1, height: 1 }), null);
});
