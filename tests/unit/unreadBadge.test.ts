// Unread badge on the taskbar and tray icons (DESIGN-SPEC 3.15): text, bitmaps, controller, tray dot,
// the .ico reader and the two settings.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BADGE_DEBOUNCE_MS,
  BADGE_SIZES,
  UnreadBadge,
  badgeDescription,
  badgeText,
  buildBadgeImage,
  drawBadgeBitmap,
  trayDotWanted,
  type BadgeDeps,
  type BadgeWindowLike,
  type ImageFactory,
} from '../../src/main/unreadBadge';
import {
  BADGE_STRIP_SIZES,
  OVERLAY_MAX_PX,
  badgePx,
  badgeStripsDir,
  overlaySize,
  pickBadgeSize,
  stripCropRect,
} from '../../src/main/badgeStrips';
import { dotDiameter, parseIco, premultiply, trayFrames, withDot } from '../../src/main/trayIcon';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/main/settings';
import { schemas } from '../../src/main/ipcSchemas';

const px = (buf: Buffer, size: number, x: number, y: number) => {
  const o = (y * size + x) * 4;
  return { b: buf[o], g: buf[o + 1], r: buf[o + 2], a: buf[o + 3] };
};

describe('badge text and description', () => {
  it('maps counts to the text of the badge', () => {
    expect([0, 1, 9, 10, 99, 100, 5000].map(badgeText)).toEqual(['', '1', '9', '10', '99', '99', '99']);
    expect(badgeText(-3)).toBe('');
    expect(badgeText(Number.NaN)).toBe('');
    expect(badgeText(7.9)).toBe('7');
  });

  it('describes the count for screen readers', () => {
    expect(badgeDescription(0)).toBe('');
    expect(badgeDescription(1)).toBe('1 unread message');
    expect(badgeDescription(3)).toBe('3 unread messages');
    expect(badgeDescription(99)).toBe('99 unread messages');
    expect(badgeDescription(100)).toBe('More than 99 unread messages');
  });

  it('shows the tray dot only with unread mail and the setting on', () => {
    expect(trayDotWanted(1, true)).toBe(true);
    expect(trayDotWanted(0, true)).toBe(false);
    expect(trayDotWanted(5, false)).toBe(false);
  });
});

describe('badge bitmaps', () => {
  it('draws a premultiplied BGRA circle at each of the four sizes', () => {
    for (const { size } of BADGE_SIZES) {
      for (const text of ['1', '9', '42', '99']) {
        const b = drawBadgeBitmap(size, text);
        expect(b.length).toBe(size * size * 4);
        // corners are transparent, the middle of the left edge area is red
        for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
          expect(px(b, size, x, y)).toEqual({ b: 0, g: 0, r: 0, a: 0 });
        }
        const edge = px(b, size, 2, size / 2);
        expect(edge).toEqual({ b: 0x1c, g: 0x2b, r: 0xc4, a: 255 });
        // some pixels are white (the digits) and none is brighter than its alpha (premultiplied)
        let white = 0;
        for (let o = 0; o < b.length; o += 4) {
          if (b[o] === 255 && b[o + 1] === 255 && b[o + 2] === 255 && b[o + 3] === 255) white++;
          expect(b[o]).toBeLessThanOrEqual(b[o + 3]);
        }
        expect(white).toBeGreaterThan(size / 2);
      }
    }
  });

  it('keeps the digits inside the circle and centred', () => {
    for (const { size } of BADGE_SIZES) {
      for (const text of ['1', '8', '42', '99']) {
        const b = drawBadgeBitmap(size, text);
        let minX: number = size, maxX = -1, minY: number = size, maxY = -1;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const p = px(b, size, x, y);
            if (p.a === 255 && p.g > 0x80) {
              minX = Math.min(minX, x); maxX = Math.max(maxX, x);
              minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
          }
        }
        // left and right margins differ by at most 1 px, top and bottom too
        expect(Math.abs(minX - (size - 1 - maxX))).toBeLessThanOrEqual(1);
        expect(Math.abs(minY - (size - 1 - maxY))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('refuses text that does not fit', () => {
    expect(() => drawBadgeBitmap(16, '')).toThrow();
    expect(() => drawBadgeBitmap(16, '100')).toThrow();
  });

  it('the vector fallback is one 16 px bitmap at scale factor 1', () => {
    const calls: { buffer: Buffer; opts: { width: number; height: number; scaleFactor: number } }[] = [];
    const factory: ImageFactory = {
      fromBitmap: (buffer, opts) => {
        calls.push({ buffer, opts });
        return {} as never;
      },
    };
    buildBadgeImage(factory, '42');
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({ width: 16, height: 16, scaleFactor: 1 });
    expect(calls[0].buffer.length).toBe(16 * 16 * 4);
  });
});

function fakeWindow() {
  const handlers: Record<string, () => void> = {};
  const win = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    setOverlayIcon: vi.fn(),
    on: (ev: string, cb: () => void) => {
      handlers[ev] = cb;
    },
  };
  return { win: win as typeof win & BadgeWindowLike, handlers };
}

describe('badge controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(settings = { badgeTaskbar: true, badgeTray: true }) {
    const w = fakeWindow();
    const dots: boolean[] = [];
    const makeImage = vi.fn((t: string) => ({ text: t }) as never);
    let current: BadgeWindowLike | null = w.win;
    const badge = new UnreadBadge(
      { getWindow: () => current, setTrayDot: (on) => dots.push(on), makeImage },
      settings,
    );
    badge.attachWindow(w.win);
    return { ...w, badge, dots, makeImage, setWindow: (x: BadgeWindowLike | null) => (current = x) };
  }

  it('sets the overlay for the first count and clears it at zero', () => {
    const { badge, win, dots } = setup();
    badge.setCountNow(3);
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith({ text: '3' }, '3 unread messages');
    expect(dots).toEqual([true]);
    badge.setCountNow(0);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
    expect(dots).toEqual([true, false]);
  });

  it('does not touch the window when nothing is unread at start', () => {
    const { badge, win, dots } = setup();
    badge.setCountNow(0);
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
    expect(dots).toEqual([]);
  });

  it('does not repeat a call when the badge did not change', () => {
    const { badge, win } = setup();
    badge.setCountNow(5);
    badge.setCountNow(5);
    badge.onCounts(5);
    vi.advanceTimersByTime(BADGE_DEBOUNCE_MS);
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(1);
    badge.setCountNow(150);
    badge.setCountNow(300); // still "99" and "More than 99": same badge
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(2);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith({ text: '99' }, 'More than 99 unread messages');
  });

  it('turns a burst of counts into one update after 250 ms', () => {
    const { badge, win } = setup();
    for (const n of [1, 2, 3, 4, 5]) badge.onCounts(n);
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BADGE_DEBOUNCE_MS - 1);
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(win.setOverlayIcon).toHaveBeenCalledWith({ text: '5' }, '5 unread messages');
  });

  it('builds each image once and caches it', () => {
    const { badge, makeImage } = setup();
    badge.setCountNow(4);
    badge.setCountNow(0);
    badge.setCountNow(4);
    expect(makeImage).toHaveBeenCalledTimes(1);
  });

  it('clears the overlay when the taskbar setting goes off and restores it when it goes on', () => {
    const { badge, win, dots } = setup();
    badge.setCountNow(8);
    badge.settingsChanged({ badgeTaskbar: false, badgeTray: true });
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
    expect(dots).toEqual([true]); // the tray dot is a separate setting
    badge.settingsChanged({ badgeTaskbar: true, badgeTray: true });
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith({ text: '8' }, '8 unread messages');
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(3);
  });

  it('switches the tray dot with its own setting', () => {
    const { badge, dots, win } = setup();
    badge.setCountNow(2);
    badge.settingsChanged({ badgeTaskbar: true, badgeTray: false });
    badge.settingsChanged({ badgeTaskbar: true, badgeTray: true });
    expect(dots).toEqual([true, false, true]);
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(1);
  });

  it('starts with both settings off and shows nothing', () => {
    const { badge, win, dots } = setup({ badgeTaskbar: false, badgeTray: false });
    badge.setCountNow(12);
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
    expect(dots).toEqual([]);
  });

  it('sets the overlay again when the window is shown, restored or focused', () => {
    const { badge, win, handlers } = setup();
    badge.setCountNow(6);
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(1);
    handlers.show();
    handlers.restore();
    handlers.focus();
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(4);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith({ text: '6' }, '6 unread messages');
  });

  it('does not set anything on show when nothing is unread', () => {
    const { badge, win, handlers } = setup();
    badge.setCountNow(0);
    handlers.show();
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
  });

  it('applies the badge to a window that is created later, and survives a destroyed one', () => {
    const { badge, win, setWindow } = setup();
    badge.setCountNow(2);
    const next = fakeWindow();
    setWindow(next.win);
    badge.attachWindow(next.win);
    expect(next.win.setOverlayIcon).toHaveBeenCalledWith({ text: '2' }, '2 unread messages');
    next.win.destroyed = true;
    expect(() => badge.setCountNow(3)).not.toThrow();
    setWindow(null);
    expect(() => badge.setCountNow(4)).not.toThrow();
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(1);
  });

  it('ignores nonsense counts', () => {
    const { badge, win } = setup();
    badge.setCountNow(Number.NaN);
    badge.setCountNow(-4);
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
  });
});

describe('tray icon frames and dot', () => {
  const ico = readFileSync(join(__dirname, '../../build/icon.ico'));

  it('reads the 16, 20, 24 and 32 px frames of the real icon', () => {
    const frames = trayFrames(ico)!;
    expect([...frames.keys()]).toEqual([16, 20, 24, 32]);
    for (const [size, f] of frames) {
      expect(f.width).toBe(size);
      expect(f.bgra.length).toBe(size * size * 4);
    }
    // the corner of the rounded icon is transparent, the middle is not
    expect(px(frames.get(32)!.bgra, 32, 0, 0).a).toBe(0);
    expect(px(frames.get(32)!.bgra, 32, 16, 16).a).toBe(255);
  });

  it('returns nothing for garbage or an .ico without the needed frames', () => {
    expect(parseIco(Buffer.from('not an icon')).size).toBe(0);
    expect(trayFrames(Buffer.from('not an icon'))).toBeNull();
  });

  it('draws a 40% red dot with a white ring at the bottom-right and leaves the rest alone', () => {
    expect([16, 20, 24, 32].map(dotDiameter)).toEqual([6, 8, 10, 13]);
    for (const [size, frame] of trayFrames(ico)!) {
      const dotted = withDot(frame);
      const d = dotDiameter(size);
      const c = size - (d / 2 + 1); // centre of the dot
      const mid = px(dotted.bgra, size, Math.floor(c), Math.floor(c));
      expect(mid).toEqual({ b: 0x1c, g: 0x2b, r: 0xc4, a: 255 });
      // the ring: a pixel just outside the dot is mostly white
      const ring = px(dotted.bgra, size, Math.floor(c), size - 1);
      expect(ring.a).toBeGreaterThan(200);
      expect(Math.min(ring.r, ring.g, ring.b)).toBeGreaterThan(120);
      // everything far from the dot is identical to the original frame
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (Math.hypot(x + 0.5 - c, y + 0.5 - c) > d / 2 + 3) {
            expect(px(dotted.bgra, size, x, y)).toEqual(px(frame.bgra, size, x, y));
          }
        }
      }
    }
  });

  it('premultiplies straight alpha', () => {
    const out = premultiply(Buffer.from([200, 100, 50, 128, 10, 20, 30, 255, 9, 9, 9, 0]));
    expect([...out]).toEqual([100, 50, 25, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
  });
});

describe('settings', () => {
  it('both badge settings default to on', () => {
    expect(DEFAULT_SETTINGS.badgeTaskbar).toBe(true);
    expect(DEFAULT_SETTINGS.badgeTray).toBe(true);
    const m = mergeSettings({});
    expect(m.badgeTaskbar).toBe(true);
    expect(m.badgeTray).toBe(true);
  });

  it('keeps stored booleans and ignores other types', () => {
    const m = mergeSettings({ badgeTaskbar: false, badgeTray: 'no' as never });
    expect(m.badgeTaskbar).toBe(false);
    expect(m.badgeTray).toBe(true);
  });

  it('settings.set accepts only booleans for the two keys', () => {
    const s = schemas['settings.set'];
    expect(s.safeParse({ badgeTaskbar: false, badgeTray: false }).success).toBe(true);
    expect(s.safeParse({ badgeTaskbar: 'yes' }).success).toBe(false);
    expect(s.safeParse({ badgeTray: 1 }).success).toBe(false);
  });
});


describe('badge strips', () => {
  it('picks the smallest strip size that is at least the needed pixels', () => {
    const table: [number, number][] = [[1, 16], [1.1, 20], [1.25, 20], [1.5, 24], [2, 32], [3, 48], [3.5, 48]];
    for (const [sf, size] of table) expect(pickBadgeSize(badgePx(sf))).toBe(size);
    expect(badgePx(1.1)).toBe(18);
    expect(badgePx(Number.NaN)).toBe(16);
    expect(BADGE_STRIP_SIZES).toEqual([16, 20, 24, 28, 32, 40, 48]);
  });

  it('is limited to what Electron passes to Windows (16 px) unless the cap is lifted', () => {
    expect(OVERLAY_MAX_PX).toBe(16);
    expect(overlaySize(1.5)).toBe(16);
    expect(overlaySize(1.5, Infinity)).toBe(24);
    expect(overlaySize(3.5, Infinity)).toBe(48);
  });

  it('crops number n from cell n-1', () => {
    expect(stripCropRect(24, '1')).toEqual({ x: 0, y: 0, width: 24, height: 24 });
    expect(stripCropRect(24, '26')).toEqual({ x: 600, y: 0, width: 24, height: 24 });
    expect(stripCropRect(16, '99')).toEqual({ x: 1568, y: 0, width: 16, height: 16 });
    expect(() => stripCropRect(16, '100')).toThrow();
    expect(() => stripCropRect(16, '')).toThrow();
  });

  it('finds the strips in resources when packaged and in build/ in development', () => {
    expect(badgeStripsDir({ isPackaged: true, resourcesPath: join('r', 'res'), appPath: 'a' })).toBe(join('r', 'res', 'badges'));
    expect(badgeStripsDir({ isPackaged: false, resourcesPath: 'r', appPath: join('a') })).toBe(join('a', 'build', 'badges'));
  });

  it('ships a strip of 99 cells for every size', () => {
    for (const size of BADGE_STRIP_SIZES) {
      const png = readFileSync(join(__dirname, '..', '..', 'build', 'badges', `badge-${size}.png`));
      expect(png.readUInt32BE(16)).toBe(size * 99);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });
});

describe('badge size follows the display', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(extra: Partial<BadgeDeps> = {}) {
    const w = fakeWindow();
    let sf = 1;
    const makeImage = vi.fn((t: string, px: number) => ({ text: t, px }) as never);
    const badge = new UnreadBadge(
      { getWindow: () => w.win, setTrayDot: () => undefined, makeImage, getScaleFactor: () => sf, maxPx: Infinity, ...extra },
      { badgeTaskbar: true, badgeTray: true },
    );
    badge.attachWindow(w.win);
    return { ...w, badge, makeImage, setSf: (x: number) => (sf = x) };
  }

  it('builds at the pixel size and caches by text and size', () => {
    const { badge, makeImage, setSf, win } = setup();
    badge.setCountNow(26);
    expect(makeImage).toHaveBeenLastCalledWith('26', 16);
    setSf(1.5);
    badge.displayChanged();
    expect(makeImage).toHaveBeenLastCalledWith('26', 24);
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(2);
    badge.displayChanged(); // same size: nothing new
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(2);
    setSf(1);
    badge.displayChanged(); // back: cached image, applied again
    expect(makeImage).toHaveBeenCalledTimes(2);
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(3);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith({ text: '26', px: 16 }, '26 unread messages');
  });

  it('applies again when the window moves to another display', () => {
    const { badge, setSf, win, handlers } = setup();
    badge.setCountNow(3);
    setSf(2);
    handlers.moved();
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith({ text: '3', px: 32 }, '3 unread messages');
  });

  it('shows 99 for 100 and more, at the same size', () => {
    const { badge, makeImage } = setup();
    badge.setCountNow(250);
    expect(makeImage).toHaveBeenCalledWith('99', 16);
  });

  it('uses 1x when the scale factor cannot be read', () => {
    const { badge, makeImage } = setup({
      getScaleFactor: () => {
        throw new Error('no display');
      },
    });
    badge.setCountNow(5);
    expect(makeImage).toHaveBeenCalledWith('5', 16);
  });

  it('keeps the default 16 px cap on this Electron', () => {
    const { badge, makeImage } = setup({ maxPx: undefined });
    badge.setCountNow(5);
    badge.setCountNow(0);
    // scale 1.5 would be 24, the cap makes it 16
    const w2 = setup({ maxPx: undefined, getScaleFactor: () => 1.5 });
    w2.badge.setCountNow(5);
    expect(w2.makeImage).toHaveBeenCalledWith('5', 16);
    expect(makeImage).toHaveBeenCalledWith('5', 16);
  });

  it('falls back to the vector image when the strips fail, and says so once', () => {
    const onFallback = vi.fn();
    const fallbackImage = vi.fn((t: string) => ({ text: t, vector: true }) as never);
    const { badge, win } = setup({
      makeImage: () => {
        throw new Error('strip missing');
      },
      fallbackImage,
      onFallback,
    });
    badge.setCountNow(7);
    badge.setCountNow(8);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith({ text: '8', vector: true }, '8 unread messages');
    expect(fallbackImage).toHaveBeenCalledTimes(2);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});
