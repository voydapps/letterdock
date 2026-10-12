// Unread count on the taskbar button (DESIGN-SPEC 3.15, addendum 2026-10-12). The number is the taskbar OVERLAY icon
// of every window, set through ITaskbarList3 with an HICON at the real pixel size of the screen (taskbarOverlay.ts),
// because Electron's own setOverlayIcon shrinks it to 16 px. If the native path cannot start, Electron's 16 px overlay
// is used instead, so the number never disappears. The main window title carries the count for screen readers.
// Nothing here imports Electron at run time; the controller gets its windows and image makers from outside, so
// tests can drive it.
import type { NativeImage } from 'electron';
import { overlaySize } from './badgeStrips';
import { OverlayError, type HiconOverlay } from './taskbarOverlay';

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

/** What a screen reader says for the overlay. */
export function badgeDescription(count: number): string {
  const n = Number.isFinite(count) ? Math.floor(count) : 0;
  if (n < 1) return '';
  if (n === 1) return '1 unread message';
  if (n >= 100) return 'More than 99 unread messages';
  return `${n} unread messages`;
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
  setTitle(title: string): void;
  /** The HWND as 4 or 8 bytes, little endian (`BrowserWindow.getNativeWindowHandle`). */
  getNativeWindowHandle(): Buffer;
  /** Electron's 16 px overlay: only used when the native path cannot start. */
  setOverlayIcon(image: NativeImage | null, description: string): void;
  hookWindowMessage?(message: number, callback: () => void): void;
  on(event: 'closed' | 'show' | 'restore' | 'moved', listener: () => void): unknown;
  on(event: 'page-title-updated', listener: (e: { preventDefault(): void }) => void): unknown;
}

export interface BadgeDeps {
  /** Starts the native overlay (koffi + COM). Throws when it cannot; the controller then uses Electron's overlay. */
  loadOverlay: () => HiconOverlay;
  /** PNG bytes of the number `text` (1..99) in the strip of `size` px. Throw when the strip cannot be read. */
  cellPng: (text: string, size: number) => Buffer;
  /** An Electron image from PNG bytes (for the fallback overlay). */
  imageFromPng: (png: Buffer) => NativeImage;
  /** Scale factor of the display the window is on. */
  getScaleFactor: (win: BadgeWindowLike) => number;
  setTrayDot: (on: boolean) => void;
  /** Says which path is used, once: 'native' (detail = "koffi 3.3.3") or 'fallback' (detail = the reason). */
  onMode?: (mode: 'native' | 'fallback', detail: string) => void;
  /** A native call failed but will be tried again (debug log). */
  onTransientError?: (err: unknown) => void;
  /** Forces the unread count (the LETTERDOCK_DEBUG_UNREAD hook; null in a packaged app). */
  forcedCount?: number | null;
}

export interface BadgeSettings {
  badgeTaskbar: boolean;
  badgeTray: boolean;
}

export const BADGE_DEBOUNCE_MS = 250;
const PNG_CACHE_MAX = 100;
/** Size of the strip used by the Electron fallback (Electron resizes to 16 px anyway). */
const FALLBACK_PX = 16;

interface Tracked {
  main: boolean;
  /** HWND, read once when the window was attached (it cannot be read after the window is destroyed). */
  hwnd: bigint | null;
  /** What was last applied: '' = nothing, otherwise "<text>@<size>|<description>". null = apply again whatever it was. */
  key: string | null;
  title: string;
  hooked: boolean;
}

function readHwnd(win: BadgeWindowLike): bigint | null {
  try {
    const b = win.getNativeWindowHandle();
    if (b.length >= 8) return b.readBigUInt64LE(0);
    if (b.length >= 4) return BigInt(b.readUInt32LE(0));
  } catch {
    /* no handle: this window uses the fallback */
  }
  return null;
}

export class UnreadBadge {
  private count = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastDot = false;
  private native: HiconOverlay | null = null;
  private mode: 'unknown' | 'native' | 'fallback' = 'unknown';
  private readonly windows = new Map<BadgeWindowLike, Tracked>();
  private readonly pngs = new Map<string, Buffer>();

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

  /** A display changed (scale factor, resolution): the overlay size may be different now. Cheap when it is not. */
  displayChanged(): void {
    this.apply();
  }

  /**
   * Call for every window that gets created (`browser-window-created`), and again with `main: true` for the main
   * window (safe to call twice). Every window gets the overlay (the grouped taskbar button shows the overlay of the
   * window Windows picks); only the main window gets the title.
   */
  attachWindow(win: BadgeWindowLike, opts: { main?: boolean } = {}): void {
    let t = this.windows.get(win);
    if (!t) {
      t = { main: false, hwnd: readHwnd(win), key: '', title: APP_TITLE, hooked: false };
      this.windows.set(win, t);
      this.ensureMode();
      const tracked = t;
      win.on('closed', () => {
        this.windows.delete(win);
        if (tracked.hwnd !== null) this.native?.forget(tracked.hwnd);
      });
      // The taskbar button may not exist yet (window created hidden) or may be rebuilt (Explorer restarted):
      // apply again whenever the window shows or comes back.
      const again = () => {
        tracked.key = null;
        this.apply();
      };
      win.on('show', again);
      win.on('restore', again);
      // Dragging to another screen can change the scale factor. `apply` does nothing when the size is the same.
      win.on('moved', () => this.apply());
      this.hook(win, tracked);
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
    try {
      this.native?.dispose();
    } catch {
      /* quitting anyway */
    }
    this.native = null;
  }

  /** Starts the native overlay once; on failure the Electron fallback is used from then on. */
  private ensureMode(): void {
    if (this.mode !== 'unknown') return;
    try {
      this.native = this.deps.loadOverlay();
      this.mode = 'native';
      this.deps.onMode?.('native', this.native.description);
    } catch (e) {
      this.switchToFallback(e);
    }
  }

  private switchToFallback(reason: unknown): void {
    if (this.mode === 'fallback') return;
    const wasNative = this.mode === 'native';
    this.mode = 'fallback';
    try {
      this.native?.dispose();
    } catch {
      /* ignore */
    }
    this.native = null;
    // Windows that already got a native overlay get the Electron one on the next apply.
    if (wasNative) for (const t of this.windows.values()) t.key = null;
    this.deps.onMode?.('fallback', reason instanceof Error ? reason.message : String(reason));
  }

  private hook(win: BadgeWindowLike, t: Tracked): void {
    if (t.hooked || !this.native || !win.hookWindowMessage) return;
    const msg = this.native.taskbarCreatedMessage();
    if (!msg) return;
    t.hooked = true;
    try {
      win.hookWindowMessage(msg, () => {
        t.key = null;
        this.apply();
      });
    } catch {
      /* the window went away */
    }
  }

  private png(text: string, size: number): Buffer {
    const key = `${text}@${size}`;
    let png = this.pngs.get(key);
    if (!png) {
      png = this.deps.cellPng(text, size);
      if (this.pngs.size >= PNG_CACHE_MAX) this.pngs.delete(this.pngs.keys().next().value as string);
      this.pngs.set(key, png);
    }
    return png;
  }

  private scaleOf(win: BadgeWindowLike): number {
    try {
      return this.deps.getScaleFactor(win);
    } catch {
      return 1;
    }
  }

  /** The overlay of one window; returns the key that is now on screen, or undefined when the call failed (try again later). */
  private applyOverlay(win: BadgeWindowLike, t: Tracked, text: string, desc: string): string | undefined {
    if (this.mode === 'native' && this.native && t.hwnd !== null) {
      const size = overlaySize(this.scaleOf(win));
      const key = text ? `${text}@${size}|${desc}` : '';
      if (t.key === key) return key;
      try {
        if (text) this.native.set(t.hwnd, this.png(text, size), size, desc);
        else this.native.clear(t.hwnd);
        return key;
      } catch (e) {
        if (e instanceof OverlayError && !e.permanent) {
          this.deps.onTransientError?.(e);
          return undefined;
        }
        this.switchToFallback(e);
        // fall through to the Electron overlay for this window
      }
    }
    const key = text ? `${text}@fallback|${desc}` : '';
    if (t.key === key) return key;
    win.setOverlayIcon(text ? this.deps.imageFromPng(this.png(text, FALLBACK_PX)) : null, desc);
    return key;
  }

  private apply(): void {
    const text = this.settings.badgeTaskbar ? badgeText(this.count) : '';
    const desc = text ? badgeDescription(this.count) : '';
    const title = windowTitle(this.count, this.settings.badgeTaskbar);
    for (const [win, t] of [...this.windows]) {
      if (win.isDestroyed()) {
        this.windows.delete(win);
        if (t.hwnd !== null) this.native?.forget(t.hwnd);
        continue;
      }
      try {
        const key = this.applyOverlay(win, t, text, desc);
        if (key !== undefined) t.key = key;
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
