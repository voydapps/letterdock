// Unread count on the taskbar button (DESIGN-SPEC 3.15). The normal images are cropped from the pre-rendered
// strips in build/badges (see badgeStrips.ts). If those cannot be loaded, the vector drawer below (raw pixels)
// is the fallback, so the badge never disappears. Everything that draws is pure and has no Electron import; the
// controller gets the window, the image maker and the tray switch from outside, so tests can drive it.
//
// Representation: ONE bitmap at the pixel size, scaleFactor 1. Electron's SetOverlayIcon uses only the 1x
// representation (`overlay.AsBitmap()`), so extra or scaled representations are never seen by Windows, and a
// bitmap tagged with another scale factor would only be resampled first. The pixel size is the real size.
import type { NativeImage } from 'electron';
import { overlaySize, OVERLAY_MAX_PX } from './badgeStrips';

export const BADGE_RED = { r: 0xc4, g: 0x2b, b: 0x1c };
/** The four sizes and the scale factor each one is for (100%, 125%, 150%, 200%). */
export const BADGE_SIZES = [
  { size: 16, scaleFactor: 1 },
  { size: 20, scaleFactor: 1.25 },
  { size: 24, scaleFactor: 1.5 },
  { size: 32, scaleFactor: 2 },
] as const;

/** '' (nothing), '1'...'99'. 100 or more shows '99' (three digits do not fit at 16 px). */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count < 1) return '';
  return String(Math.min(99, Math.floor(count)));
}

/** What a screen reader says for the overlay. */
export function badgeDescription(count: number): string {
  const n = Number.isFinite(count) ? Math.floor(count) : 0;
  if (n < 1) return '';
  if (n === 1) return '1 unread message';
  if (n >= 100) return 'More than 99 unread messages';
  return `${n} unread messages`;
}

/** The tray shows a dot only for unread mail and only when the setting is on. */
export function trayDotWanted(unread: number, badgeTray: boolean): boolean {
  return badgeTray && Number.isFinite(unread) && unread > 0;
}

// ---------------------------------------------------------------- glyphs
// 16 px: hand-drawn pixel masks. One digit is 5x7, two digits are 4x7 each with 1 px between.
const SINGLE_16: Record<string, string[]> = {
  '0': ['.###.', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
  '1': ['..##.', '.###.', '..##.', '..##.', '..##.', '..##.', '.####'],
  '2': ['.###.', '##.##', '...##', '..##.', '.##..', '##...', '#####'],
  '3': ['.###.', '##.##', '...##', '..##.', '...##', '##.##', '.###.'],
  '4': ['...##', '..###', '.####', '##.##', '#####', '...##', '...##'],
  '5': ['#####', '##...', '####.', '...##', '...##', '##.##', '.###.'],
  '6': ['.###.', '##...', '####.', '##.##', '##.##', '##.##', '.###.'],
  '7': ['#####', '...##', '..##.', '..##.', '.##..', '.##..', '.##..'],
  '8': ['.###.', '##.##', '##.##', '.###.', '##.##', '##.##', '.###.'],
  '9': ['.###.', '##.##', '##.##', '.####', '...##', '...##', '.###.'],
};
const DOUBLE_16: Record<string, string[]> = {
  '0': ['.##.', '#..#', '#..#', '#..#', '#..#', '#..#', '.##.'],
  '1': ['.##.', '###.', '.##.', '.##.', '.##.', '.##.', '####'],
  '2': ['.##.', '#..#', '...#', '..#.', '.#..', '#...', '####'],
  '3': ['.##.', '#..#', '...#', '.##.', '...#', '#..#', '.##.'],
  '4': ['..#.', '.##.', '#.#.', '#.#.', '####', '..#.', '..#.'],
  '5': ['####', '#...', '###.', '...#', '...#', '#..#', '.##.'],
  '6': ['.##.', '#...', '###.', '#..#', '#..#', '#..#', '.##.'],
  '7': ['####', '...#', '..#.', '..#.', '.#..', '.#..', '.#..'],
  '8': ['.##.', '#..#', '#..#', '.##.', '#..#', '#..#', '.##.'],
  '9': ['.##.', '#..#', '#..#', '.###', '...#', '#..#', '.##.'],
};

type Pt = [number, number];
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 14): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}
/** Stroke centre lines in a unit box (y down) for the sizes above 16 px. */
const STROKES: Record<string, Pt[][]> = {
  '0': [arc(0.5, 0.5, 0.5, 0.5, 0, 360, 20)],
  '1': [[[0.1, 0.28], [0.6, 0], [0.6, 1]]],
  '2': [[...arc(0.5, 0.27, 0.5, 0.27, 180, 385), [0, 1], [1, 1]]],
  '3': [[...arc(0.5, 0.25, 0.5, 0.25, 160, 450), ...arc(0.5, 0.75, 0.5, 0.25, 270, 560)]],
  '4': [[[0.75, 1], [0.75, 0], [0, 0.68], [1, 0.68]]],
  '5': [[[0.92, 0], [0.12, 0], [0.06, 0.46], ...arc(0.5, 0.7, 0.5, 0.3, 235, 515, 18)]],
  '6': [arc(0.5, 0.68, 0.5, 0.32, 0, 360, 20), [[0.02, 0.68], [0.06, 0.3], [0.3, 0.05], [0.88, 0.02]]],
  '7': [[[0, 0], [1, 0], [0.35, 1]]],
  '8': [arc(0.5, 0.27, 0.45, 0.27, 0, 360, 20), arc(0.5, 0.73, 0.5, 0.27, 0, 360, 20)],
  '9': [arc(0.5, 0.32, 0.5, 0.32, 0, 360, 20), [[0.98, 0.32], [0.94, 0.7], [0.7, 0.96], [0.1, 0.98]]],
};
/** Glyph box (px) per size above 16: height, width of one digit alone / in a pair, gap, stroke. */
const VECTOR_METRICS: Record<number, { h: number; wSingle: number; wPair: number; gap: number; stroke: number }> = {
  20: { h: 10, wSingle: 6, wPair: 5.5, gap: 1.5, stroke: 1.9 },
  24: { h: 12, wSingle: 7, wPair: 6.5, gap: 1.5, stroke: 2.2 },
  32: { h: 16, wSingle: 10, wPair: 9.5, gap: 2, stroke: 3.1 },
};

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - a[0]) * dx + (py - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

const SS = 4;

/** How much of each pixel (0..1) the digits cover, for a text of 1 or 2 digits in a size x size image. */
function glyphCoverage(size: number, text: string): Float32Array {
  const cov = new Float32Array(size * size);
  if (size === 16) {
    const masks = text.length === 1 ? SINGLE_16 : DOUBLE_16;
    const gw = text.length === 1 ? 5 : 4;
    const total = gw * text.length + (text.length - 1);
    const x0 = Math.floor((size - total) / 2);
    const y0 = Math.floor((size - 7) / 2);
    [...text].forEach((ch, i) => {
      masks[ch].forEach((row, y) => {
        for (let x = 0; x < gw; x++) {
          if (row[x] === '#') cov[(y0 + y) * size + x0 + i * (gw + 1) + x] = 1;
        }
      });
    });
    return cov;
  }
  const m = VECTOR_METRICS[size];
  if (!m) throw new Error(`no glyph metrics for ${size} px`);
  const w = text.length === 1 ? m.wSingle : m.wPair;
  const total = w * text.length + m.gap * (text.length - 1);
  const x0 = Math.floor((size - total) / 2);
  const y0 = Math.floor((size - m.h) / 2);
  const half = m.stroke / 2;
  const segs: [Pt, Pt][] = [];
  [...text].forEach((ch, i) => {
    const ox = x0 + i * (w + m.gap) + half;
    const oy = y0 + half;
    const sx = w - m.stroke;
    const sy = m.h - m.stroke;
    for (const line of STROKES[ch]) {
      for (let k = 0; k + 1 < line.length; k++) {
        segs.push([
          [ox + line[k][0] * sx, oy + line[k][1] * sy],
          [ox + line[k + 1][0] * sx, oy + line[k + 1][1] * sy],
        ]);
      }
    }
  });
  // Centre the ink sideways (a "1" has empty space on one side of its box).
  let inkMin = Infinity;
  let inkMax = -Infinity;
  for (const [p, q] of segs) {
    inkMin = Math.min(inkMin, p[0], q[0]);
    inkMax = Math.max(inkMax, p[0], q[0]);
  }
  const shift = size / 2 - (inkMin + inkMax) / 2;
  for (const seg of segs) for (const pt of seg) pt[0] += shift;
  for (let y = y0 - 1; y <= y0 + m.h; y++) {
    for (let x = 0; x < size; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      let hit = 0;
      for (let sy2 = 0; sy2 < SS; sy2++) {
        for (let sx2 = 0; sx2 < SS; sx2++) {
          const px = x + (sx2 + 0.5) / SS;
          const py = y + (sy2 + 0.5) / SS;
          for (const [a, b] of segs) {
            if (distToSegment(px, py, a, b) <= half) {
              hit++;
              break;
            }
          }
        }
      }
      cov[y * size + x] = hit / (SS * SS);
    }
  }
  return cov;
}

/** Share (0..1) of the pixel inside the circle, by 4x4 supersampling. */
export function circleCoverage(cx: number, cy: number, r: number, x: number, y: number): number {
  let hit = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const dx = x + (sx + 0.5) / SS - cx;
      const dy = y + (sy + 0.5) / SS - cy;
      if (dx * dx + dy * dy <= r * r) hit++;
    }
  }
  return hit / (SS * SS);
}

/**
 * The badge as a size x size BGRA bitmap with premultiplied alpha (what `createFromBitmap` wants):
 * red circle filling the whole image, white digits, transparent outside the circle.
 */
export function drawBadgeBitmap(size: number, text: string): Buffer {
  if (!/^\d{1,2}$/.test(text)) throw new Error('badge text must be 1 or 2 digits');
  const glyph = glyphCoverage(size, text);
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = circleCoverage(c, c, c, x, y);
      if (a === 0) continue;
      const g = Math.min(1, glyph[y * size + x]);
      const r = BADGE_RED.r * (1 - g) + 255 * g;
      const gr = BADGE_RED.g * (1 - g) + 255 * g;
      const b = BADGE_RED.b * (1 - g) + 255 * g;
      const o = (y * size + x) * 4;
      buf[o] = Math.round(b * a);
      buf[o + 1] = Math.round(gr * a);
      buf[o + 2] = Math.round(r * a);
      buf[o + 3] = Math.round(255 * a);
    }
  }
  return buf;
}

/** What the builders need from Electron's `nativeImage`. */
export interface ImageFactory {
  /** An image from one premultiplied BGRA bitmap. */
  fromBitmap(buffer: Buffer, opts: { width: number; height: number; scaleFactor: number }): NativeImage;
}

/** One image with the four sizes attached, each for its scale factor. */
export function buildMultiScaleImage(
  factory: ImageFactory,
  draw: (size: number) => Buffer,
  sizes: readonly { size: number; scaleFactor: number }[] = BADGE_SIZES,
): NativeImage {
  const [first, ...rest] = sizes;
  const img = factory.fromBitmap(draw(first.size), {
    width: first.size,
    height: first.size,
    scaleFactor: first.scaleFactor,
  });
  for (const s of rest) {
    img.addRepresentation({ scaleFactor: s.scaleFactor, width: s.size, height: s.size, buffer: draw(s.size) });
  }
  return img;
}

/** The vector fallback: one 16 px bitmap (what Electron sends to Windows anyway), scale factor 1. */
export function buildBadgeImage(factory: ImageFactory, text: string): NativeImage {
  return factory.fromBitmap(drawBadgeBitmap(16, text), { width: 16, height: 16, scaleFactor: 1 });
}

// ---------------------------------------------------------------- controller
export interface BadgeWindowLike {
  isDestroyed(): boolean;
  setOverlayIcon(image: NativeImage | null, description: string): void;
  on(event: 'show' | 'restore' | 'focus' | 'moved', listener: () => void): unknown;
}

export interface BadgeDeps {
  getWindow: () => BadgeWindowLike | null;
  setTrayDot: (on: boolean) => void;
  /** The image for `text` (1..99) at `px` physical pixels (a strip size). Throw to use the vector fallback. */
  makeImage: (text: string, px: number) => NativeImage;
  /** Vector fallback, used when `makeImage` throws. */
  fallbackImage?: (text: string) => NativeImage;
  /** Scale factor of the display the window is on. */
  getScaleFactor?: (win: BadgeWindowLike) => number;
  /** Largest overlay size worth making (default `OVERLAY_MAX_PX`). */
  maxPx?: number;
  /** Called once when the strips failed and the vector fallback is used. */
  onFallback?: (err: unknown) => void;
}

export interface BadgeSettings {
  badgeTaskbar: boolean;
  badgeTray: boolean;
}

export const BADGE_DEBOUNCE_MS = 250;
const IMAGE_CACHE_MAX = 100;

export class UnreadBadge {
  private count = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastKey = '|';
  private lastWin: BadgeWindowLike | null = null;
  private lastDot = false;
  private fallbackReported = false;
  private readonly images = new Map<string, NativeImage>();

  constructor(
    private readonly deps: BadgeDeps,
    private settings: BadgeSettings,
  ) {}

  /** A new unread number from `counts:changed`. A burst of them becomes one update. */
  onCounts(n: number): void {
    this.count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.apply(false);
    }, BADGE_DEBOUNCE_MS);
  }

  /** The number read at start-up (or after an engine restart): apply at once. */
  setCountNow(n: number): void {
    this.count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.apply(false);
  }

  /** A setting changed: apply at once. */
  settingsChanged(s: BadgeSettings): void {
    this.settings = { badgeTaskbar: s.badgeTaskbar, badgeTray: s.badgeTray };
    this.apply(false);
  }

  /** Call for each main window that gets created. Windows can drop the overlay, so it is set again on show. */
  attachWindow(win: BadgeWindowLike): void {
    const again = () => this.apply(true);
    for (const ev of ['show', 'restore', 'focus', 'moved'] as const) win.on(ev, again);
    this.apply(false);
  }

  /** The display scale changed (screen 'display-metrics-changed'): apply again if the pixel size is different. */
  displayChanged(): void {
    this.apply(false);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private pixelSize(win: BadgeWindowLike): number {
    const sf = (() => {
      try {
        return this.deps.getScaleFactor?.(win) ?? 1;
      } catch {
        return 1;
      }
    })();
    return overlaySize(sf, this.deps.maxPx ?? OVERLAY_MAX_PX);
  }

  private image(text: string, px: number): NativeImage {
    const cacheKey = `${text}@${px}`;
    let img = this.images.get(cacheKey);
    if (!img) {
      if (this.images.size >= IMAGE_CACHE_MAX) this.images.delete(this.images.keys().next().value as string);
      try {
        img = this.deps.makeImage(text, px);
      } catch (e) {
        if (!this.fallbackReported) {
          this.fallbackReported = true;
          this.deps.onFallback?.(e);
        }
        if (!this.deps.fallbackImage) throw e;
        img = this.deps.fallbackImage(text);
      }
      this.images.set(cacheKey, img);
    }
    return img;
  }

  private apply(force: boolean): void {
    const text = this.settings.badgeTaskbar ? badgeText(this.count) : '';
    const description = text ? badgeDescription(this.count) : '';
    const win = this.deps.getWindow();
    const px = win && !win.isDestroyed() && text ? this.pixelSize(win) : 0;
    const key = `${text ? `${text}@${px}` : ''}|${description}`;
    if (win && !win.isDestroyed()) {
      if (win !== this.lastWin) {
        this.lastWin = win;
        this.lastKey = '|'; // a new window starts without an overlay
      }
      if (force ? text !== '' : key !== this.lastKey) {
        try {
          if (text) win.setOverlayIcon(this.image(text, px), description);
          else win.setOverlayIcon(null, '');
        } catch {
          /* the window went away between the check and the call */
        }
      }
      this.lastKey = key;
    }
    const dot = trayDotWanted(this.count, this.settings.badgeTray);
    if (dot !== this.lastDot) {
      this.lastDot = dot;
      this.deps.setTrayDot(dot);
    }
  }
}
