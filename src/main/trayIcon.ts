// Tray icon with an unread dot (DESIGN-SPEC 3.15). The dot is drawn on the .ico's own 16/20/24/32 px
// frames, so the icon does not change shape when the dot appears. Pure: no Electron import.
import { BADGE_RED, BADGE_SIZES, circleCoverage } from './unreadBadge';

export interface IcoFrame {
  width: number;
  height: number;
  /** Straight (not premultiplied) BGRA, top row first. */
  bgra: Buffer;
}

/** Reads the 32-bit BMP frames of an .ico. Frames in other formats (PNG, 8-bit) are skipped. */
export function parseIco(buf: Buffer): Map<number, IcoFrame> {
  const frames = new Map<number, IcoFrame>();
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return frames;
  const count = buf.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 16 > buf.length) break;
    const bytes = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    if (off + 40 > buf.length || off + bytes > buf.length) continue;
    if (buf.readUInt32LE(off) !== 40) continue; // BITMAPINFOHEADER only
    const w = buf.readInt32LE(off + 4);
    const h = buf.readInt32LE(off + 8) / 2; // XOR bitmap + AND mask
    const bpp = buf.readUInt16LE(off + 14);
    if (bpp !== 32 || w <= 0 || h !== w || w > 256) continue;
    const start = off + 40;
    if (start + w * h * 4 > buf.length) continue;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      buf.copy(out, y * w * 4, start + (h - 1 - y) * w * 4, start + (h - y) * w * 4); // rows are bottom-up
    }
    frames.set(w, { width: w, height: h, bgra: out });
  }
  return frames;
}

/** Dot diameter for an icon size: 40% of it (6/8/10/13 px at 16/20/24/32). */
export function dotDiameter(size: number): number {
  return Math.round(size * 0.4);
}

/** Straight-alpha "over" of one colour on one pixel (BGRA, in place). */
function over(buf: Buffer, o: number, b: number, g: number, r: number, a: number): void {
  if (a <= 0) return;
  const da = buf[o + 3] / 255;
  const oa = a + da * (1 - a);
  buf[o] = Math.round((b * a + buf[o] * da * (1 - a)) / oa);
  buf[o + 1] = Math.round((g * a + buf[o + 1] * da * (1 - a)) / oa);
  buf[o + 2] = Math.round((r * a + buf[o + 2] * da * (1 - a)) / oa);
  buf[o + 3] = Math.round(oa * 255);
}

/** A copy of the frame with the red dot (and its 90% white ring) at the bottom-right corner. */
export function withDot(frame: IcoFrame): IcoFrame {
  const size = frame.width;
  const out = Buffer.from(frame.bgra);
  const rDot = dotDiameter(size) / 2;
  const rRing = rDot + 1;
  const c = size - rRing;
  for (let y = Math.max(0, Math.floor(c - rRing) - 1); y < size; y++) {
    for (let x = Math.max(0, Math.floor(c - rRing) - 1); x < size; x++) {
      const o = (y * size + x) * 4;
      over(out, o, 255, 255, 255, 0.9 * circleCoverage(c, c, rRing, x, y));
      over(out, o, BADGE_RED.b, BADGE_RED.g, BADGE_RED.r, circleCoverage(c, c, rDot, x, y));
    }
  }
  return { width: size, height: size, bgra: out };
}

/** Straight BGRA to premultiplied BGRA (what Electron's `createFromBitmap` wants). */
export function premultiply(bgra: Buffer): Buffer {
  const out = Buffer.from(bgra);
  for (let o = 0; o < out.length; o += 4) {
    const a = out[o + 3];
    if (a === 255) continue;
    out[o] = Math.round((out[o] * a) / 255);
    out[o + 1] = Math.round((out[o + 1] * a) / 255);
    out[o + 2] = Math.round((out[o + 2] * a) / 255);
  }
  return out;
}

/** The 16/20/24/32 px frames of the icon keyed by size, or null when one is missing. */
export function trayFrames(ico: Buffer): Map<number, IcoFrame> | null {
  const all = parseIco(ico);
  const picked = new Map<number, IcoFrame>();
  for (const { size } of BADGE_SIZES) {
    const f = all.get(size);
    if (!f) return null;
    picked.set(size, f);
  }
  return picked;
}
