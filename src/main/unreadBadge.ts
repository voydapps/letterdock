// Unread count on the taskbar button (DESIGN-SPEC 3.15, addendum 2026-10-12). The number is part of the window icon:
// every window gets the app icon with the red badge composited into it (iconBadge.ts), and the main window title
// carries the count for screen readers. The native taskbar overlay is not used (Electron shrinks it to 16 px).
// Nothing here imports Electron at run time; the controller gets its windows and image makers from outside, so
// tests can drive it.
import type { NativeImage } from 'electron';
import { ICON_BASE_PX } from './iconBadge';

export const BADGE_RED = { r: 0xc4, g: 0x2b, b: 0x1c };
/** The four tray icon sizes and the scale factor each one is for (100%, 125%, 150%, 200%). */
export const BADGE_SIZES = [
  { size: 16, scaleFactor: 1 },
  { size: 20, scaleFactor: 1.25 },
  { size: 24, scaleFactor: 1.5 },
  { size: 32, scaleFactor: 2 },
] as const;

/** '' (nothing), '1'...'99'. 100 or more shows '99' (three digits do not fit in the badge). */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count < 1) return '';
  return String(Math.min(99, Math.floor(count)));
}

export const APP_TITLE = 'Letterdock';

/** Main window title: "Letterdock (26)" with unread mail and the setting on, "Letterdock" otherwise. */
export function windowTitle(count: number, badgeTaskbar: boolean): string {
  const n = Number.isFinite(count) ? Math.floor(count) : 0;
  return badgeTaskbar && n > 0 ? `${APP_TITLE} (${n})` : APP_TITLE;
}

/** The tray shows a dot only for unread mail and only when the setting is on. */
export function trayDotWanted(unread: number, badgeTray: boolean): boolean {
  return badgeTray && Number.isFinite(unread) && unread > 0;
}

/**
 * LETTERDOCK_DEBUG_UNREAD=<n> forces the unread count, for testing without real mail. Only in a development run:
 * a packaged app ignores it. Returns null when it is not set, not a whole number >= 0, or the app is packaged.
 */
export function debugUnreadOverride(env: Record<string, string | undefined>, isPackaged: boolean): number | null {
  if (isPackaged) return null;
  const raw = env.LETTERDOCK_DEBUG_UNREAD;
  if (raw === undefined || !/^\d{1,6}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

const SS = 4;
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

/** What the tray icon builder needs from Electron's `nativeImage`. */
export interface ImageFactory {
  /** An image from one premultiplied BGRA bitmap. */
  fromBitmap(buffer: Buffer, opts: { width: number; height: number; scaleFactor: number }): NativeImage;
}

/** One image with the four sizes attached, each for its scale factor (tray icon). */
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

// ---------------------------------------------------------------- controller
export interface BadgeWindowLike {
  isDestroyed(): boolean;
  setIcon(image: NativeImage): void;
  setTitle(title: string): void;
  /** Called once per window, with null, to clear an overlay that an older version may have left. */
  setOverlayIcon(image: null, description: string): void;
  on(event: 'closed', listener: () => void): unknown;
  on(event: 'page-title-updated', listener: (e: { preventDefault(): void }) => void): unknown;
}

export interface BadgeDeps {
  /** The app icon with the badge for `text` (1..99), `ICON_BASE_PX` square, scale factor 1. Throw when it cannot be made. */
  makeImage: (text: string) => NativeImage;
  /** The plain app icon (build/icon.ico), or null when it cannot be loaded. */
  plainImage: () => NativeImage | null;
  setTrayDot: (on: boolean) => void;
  /** Called once when the badged icon cannot be made; the plain icon stays (the title still carries the count). */
  onError?: (err: unknown) => void;
  /** Forces the unread count (the LETTERDOCK_DEBUG_UNREAD hook; null in a packaged app). */
  forcedCount?: number | null;
}

export interface BadgeSettings {
  badgeTaskbar: boolean;
  badgeTray: boolean;
}

export const BADGE_DEBOUNCE_MS = 250;
const IMAGE_CACHE_MAX = 100;

interface Tracked {
  main: boolean;
  /** The icon key last applied: '' = plain icon, otherwise the badge text. */
  icon: string;
  title: string;
}

export class UnreadBadge {
  private count = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastDot = false;
  private errorReported = false;
  private readonly windows = new Map<BadgeWindowLike, Tracked>();
  private readonly images = new Map<string, NativeImage>();

  constructor(
    private readonly deps: BadgeDeps,
    private settings: BadgeSettings,
  ) {
    if (deps.forcedCount != null) this.count = deps.forcedCount;
  }

  private norm(n: number): number {
    if (this.deps.forcedCount != null) return this.deps.forcedCount;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** A new unread number from `counts:changed`. A burst of them becomes one update. */
  onCounts(n: number): void {
    this.count = this.norm(n);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.apply();
    }, BADGE_DEBOUNCE_MS);
  }

  /** The number read at start-up (or after an engine restart): apply at once. */
  setCountNow(n: number): void {
    this.count = this.norm(n);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.apply();
  }

  /** A setting changed: apply at once. */
  settingsChanged(s: BadgeSettings): void {
    this.settings = { badgeTaskbar: s.badgeTaskbar, badgeTray: s.badgeTray };
    this.apply();
  }

  /**
   * Call for every window that gets created (`browser-window-created`), and again with `main: true` for the main
   * window (safe to call twice). Compose and viewer windows get the icon only; the main window also gets the title.
   */
  attachWindow(win: BadgeWindowLike, opts: { main?: boolean } = {}): void {
    let t = this.windows.get(win);
    if (!t) {
      t = { main: false, icon: '', title: APP_TITLE };
      this.windows.set(win, t);
      win.on('closed', () => this.windows.delete(win));
      try {
        win.setOverlayIcon(null, ''); // an older version set a native overlay; make sure no second badge is left
      } catch {
        /* the window went away */
      }
    }
    if (opts.main && !t.main) {
      t.main = true;
      // The page sets document.title; the window title is ours (it carries the count).
      win.on('page-title-updated', (e) => e.preventDefault());
    }
    this.apply();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private image(text: string): NativeImage {
    const key = `${text}@${ICON_BASE_PX}`;
    let img = this.images.get(key);
    if (!img) {
      img = this.deps.makeImage(text);
      if (this.images.size >= IMAGE_CACHE_MAX) this.images.delete(this.images.keys().next().value as string);
      this.images.set(key, img);
    }
    return img;
  }

  private apply(): void {
    const text = this.settings.badgeTaskbar ? badgeText(this.count) : '';
    const title = windowTitle(this.count, this.settings.badgeTaskbar);
    for (const [win, t] of [...this.windows]) {
      if (win.isDestroyed()) {
        this.windows.delete(win);
        continue;
      }
      try {
        if (t.icon !== text) {
          let img: NativeImage | null = null;
          if (text) {
            try {
              img = this.image(text);
            } catch (e) {
              if (!this.errorReported) {
                this.errorReported = true;
                this.deps.onError?.(e);
              }
            }
          }
          // No badged image (or no number): the plain icon, never null.
          if (!img) img = this.deps.plainImage();
          if (img) win.setIcon(img);
          t.icon = text;
        }
        if (t.main && t.title !== title) {
          win.setTitle(title);
          t.title = title;
        }
      } catch {
        /* the window went away between the check and the call */
      }
    }
    const dot = trayDotWanted(this.count, this.settings.badgeTray);
    if (dot !== this.lastDot) {
      this.lastDot = dot;
      this.deps.setTrayDot(dot);
    }
  }
}
