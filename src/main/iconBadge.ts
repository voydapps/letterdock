// The unread number inside the app icon (DESIGN-SPEC 3.15, addendum 2026-10-12). Pure: no Electron import, so the
// geometry can be tested. All images here are PREMULTIPLIED BGRA, top row first (what `createFromBitmap` wants).
//
// Electron 44.7 hands Windows one HICON built from the 1x bitmap at its own pixel size and ignores the system icon
// size (see the spec addendum), so the icon is composited ONCE at a fixed base size, ICON_BASE_PX, and Windows only
// ever shrinks it.
import type { IcoFrame } from './trayIcon';

/** Base size of the composited icon. 96 px covers a 300% display; Windows shrinks it. */
export const ICON_BASE_PX = 96;
/** Badge diameter as a share of the icon square. */
export const BADGE_RATIO = 0.56;

/** A square image, premultiplied BGRA. */
export interface PremulImage {
  size: number;
  data: Buffer;
}

/** Badge diameter in pixels for an icon of `size` px (54 at 96). */
export function badgeDiameter(size: number): number {
  return Math.round(size * BADGE_RATIO);
}

/** Width of the transparent ring around the badge: max(1 px, size / 32) (3 px at 96). */
export function ringWidth(size: number): number {
  return Math.max(1, size / 32);
}

/** Where the badge circle is: flush to the right and bottom edges. */
export function badgeBox(size: number): { x: number; y: number; d: number; cx: number; cy: number } {
  const d = badgeDiameter(size);
  return { x: size - d, y: size - d, d, cx: size - d / 2, cy: size - d / 2 };
}

/** Straight BGRA frame (an .ico frame) to premultiplied. */
export function premulFrame(frame: IcoFrame): PremulImage {
  const data = Buffer.from(frame.bgra);
  for (let o = 0; o < data.length; o += 4) {
    const a = data[o + 3];
    if (a === 255) continue;
    data[o] = Math.round((data[o] * a) / 255);
    data[o + 1] = Math.round((data[o + 1] * a) / 255);
    data[o + 2] = Math.round((data[o + 2] * a) / 255);
  }
  return { size: frame.width, data };
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const lanczos3 = (x: number): number => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0);

/** Lanczos3 resize of a premultiplied image to `target` x `target` (separable; the channels are premultiplied, so edges stay clean). */
export function resizePremul(src: PremulImage, target: number): PremulImage {
  if (src.size === target) return { size: target, data: Buffer.from(src.data) };
  const pass = (input: Float32Array, inW: number, inH: number, outW: number, outH: number, horizontal: boolean): Float32Array => {
    const out = new Float32Array(outW * outH * 4);
    const inLen = horizontal ? inW : inH;
    const outLen = horizontal ? outW : outH;
    const scale = inLen / outLen;
    const f = Math.max(1, scale);
    const lines = horizontal ? inH : inW;
    for (let o = 0; o < outLen; o++) {
      const centre = (o + 0.5) * scale;
      const taps: [number, number][] = [];
      let sum = 0;
      for (let i = Math.floor(centre - 3 * f); i <= Math.ceil(centre + 3 * f); i++) {
        const w = lanczos3((i + 0.5 - centre) / f);
        if (w === 0) continue;
        taps.push([Math.min(Math.max(i, 0), inLen - 1), w]);
        sum += w;
      }
      for (let t = 0; t < lines; t++) {
        for (let c = 0; c < 4; c++) {
          let acc = 0;
          for (const [i, w] of taps) acc += input[(horizontal ? t * inW + i : i * inW + t) * 4 + c] * w;
          out[(horizontal ? t * outW + o : o * outW + t) * 4 + c] = acc / sum;
        }
      }
    }
    return out;
  };
  const f0 = new Float32Array(src.size * src.size * 4);
  for (let i = 0; i < f0.length; i++) f0[i] = src.data[i];
  const h = pass(f0, src.size, src.size, target, src.size, true);
  const v = pass(h, target, src.size, target, target, false);
  const data = Buffer.alloc(target * target * 4);
  for (let i = 0; i < v.length; i += 4) {
    const a = Math.min(255, Math.max(0, Math.round(v[i + 3])));
    data[i + 3] = a;
    for (let c = 0; c < 3; c++) data[i + c] = Math.min(a, Math.max(0, Math.round(v[i + c]))); // premultiplied: never above alpha
  }
  return { size: target, data };
}

const KNOCK_SS = 8;
/** Share (0..1) of the pixel inside the circle, by 8x8 supersampling. */
function discCoverage(cx: number, cy: number, r: number, x: number, y: number): number {
  const r2 = r * r;
  let hit = 0;
  for (let sy = 0; sy < KNOCK_SS; sy++) {
    for (let sx = 0; sx < KNOCK_SS; sx++) {
      const dx = x + (sx + 0.5) / KNOCK_SS - cx;
      const dy = y + (sy + 0.5) / KNOCK_SS - cy;
      if (dx * dx + dy * dy <= r2) hit++;
    }
  }
  return hit / (KNOCK_SS * KNOCK_SS);
}

/**
 * The icon with the badge in the bottom-right corner. `cell` is the finished badge (a red circle with the number,
 * transparent outside) and must be `badgeDiameter(base.size)` px square. The icon is cleared in a ring around the
 * badge (knock-out, `ringWidth` wide), so the taskbar colour shows between the blue icon and the red badge.
 */
export function compositeBadge(base: PremulImage, cell: PremulImage): PremulImage {
  const n = base.size;
  const box = badgeBox(n);
  if (cell.size !== box.d) throw new Error(`badge cell is ${cell.size} px, ${box.d} px needed for a ${n} px icon`);
  const out = Buffer.from(base.data);
  const rKnock = box.d / 2 + ringWidth(n);
  const from = Math.max(0, Math.floor(box.cx - rKnock) - 1);
  for (let y = from; y < n; y++) {
    for (let x = from; x < n; x++) {
      const keep = 1 - discCoverage(box.cx, box.cy, rKnock, x, y);
      if (keep === 1) continue;
      const o = (y * n + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(out[o + c] * keep);
    }
  }
  for (let y = 0; y < box.d; y++) {
    for (let x = 0; x < box.d; x++) {
      const i = (y * box.d + x) * 4;
      const a = cell.data[i + 3];
      if (a === 0) continue;
      const o = ((box.y + y) * n + box.x + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.min(255, Math.round(cell.data[i + c] + (out[o + c] * (255 - a)) / 255));
    }
  }
  return { size: n, data: out };
}

/** The largest frame of the .ico (the best source for a downscale), or null when there is none. */
export function largestFrame(frames: Map<number, IcoFrame>): IcoFrame | null {
  let best: IcoFrame | null = null;
  for (const f of frames.values()) if (!best || f.width > best.width) best = f;
  return best;
}
