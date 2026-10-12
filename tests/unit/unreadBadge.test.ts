// Unread badge in the window icon (DESIGN-SPEC 3.15, addendum 2026-10-12): text and title, the icon composite
// geometry, the controller (all windows, restore, cache, no overlay), the debug hook, the tray dot frames and
// the two settings.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_TITLE,
  BADGE_DEBOUNCE_MS,
  UnreadBadge,
  badgeText,
  debugUnreadOverride,
  trayDotWanted,
  windowTitle,
  type BadgeDeps,
  type BadgeWindowLike,
} from '../../src/main/unreadBadge';
import {
  BADGE_RATIO,
  ICON_BASE_PX,
  badgeBox,
  badgeDiameter,
  compositeBadge,
  largestFrame,
  premulFrame,
  resizePremul,
  ringWidth,
  type PremulImage,
} from '../../src/main/iconBadge';
import { BADGE_STRIP_SIZES, ICON_BADGE_PX, badgeStripsDir, stripCropRect } from '../../src/main/badgeStrips';
import { dotDiameter, parseIco, premultiply, trayFrames, withDot } from '../../src/main/trayIcon';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/main/settings';
import { schemas } from '../../src/main/ipcSchemas';

const px = (buf: Buffer, size: number, x: number, y: number) => {
  const o = (y * size + x) * 4;
  return { b: buf[o], g: buf[o + 1], r: buf[o + 2], a: buf[o + 3] };
};

const PLAIN = { plain: true } as never;
function fakeWindow() {
  const handlers: Record<string, ((e?: { preventDefault(): void }) => void)[]> = {};
  let destroyed = false;
  const setIcon = vi.fn();
  const setTitle = vi.fn();
  const setOverlayIcon = vi.fn();
  const win: BadgeWindowLike = {
    isDestroyed: () => destroyed,
    setIcon,
    setTitle,
    setOverlayIcon,
    on: ((ev: string, fn: () => void) => ((handlers[ev] ??= []).push(fn), undefined)) as never,
  };
  return {
    win,
    setIcon,
    setTitle,
    setOverlayIcon,
    destroy: () => (destroyed = true),
    emit: (ev: string, e?: { preventDefault(): void }) => (handlers[ev] ?? []).forEach((f) => f(e)),
  };
}

describe('badge text and window title', () => {
  it('maps counts to the text of the badge', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(1)).toBe('1');
    expect(badgeText(26)).toBe('26');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99');
    expect(badgeText(5000)).toBe('99');
    expect(badgeText(-3)).toBe('');
    expect(badgeText(Number.NaN)).toBe('');
    expect(badgeText(7.9)).toBe('7');
  });

  it('puts the count in the window title only with unread mail and the setting on', () => {
    expect(windowTitle(26, true)).toBe('Letterdock (26)');
    expect(windowTitle(1, true)).toBe('Letterdock (1)');
    expect(windowTitle(150, true)).toBe('Letterdock (150)');
    expect(windowTitle(0, true)).toBe(APP_TITLE);
    expect(windowTitle(26, false)).toBe('Letterdock');
    expect(windowTitle(Number.NaN, true)).toBe('Letterdock');
  });

  it('shows the tray dot only with unread mail and the setting on', () => {
    expect(trayDotWanted(1, true)).toBe(true);
    expect(trayDotWanted(0, true)).toBe(false);
    expect(trayDotWanted(5, false)).toBe(false);
  });
});

describe('debug unread hook', () => {
  it('forces the count in a development run', () => {
    expect(debugUnreadOverride({ LETTERDOCK_DEBUG_UNREAD: '26' }, false)).toBe(26);
    expect(debugUnreadOverride({ LETTERDOCK_DEBUG_UNREAD: '0' }, false)).toBe(0);
    expect(debugUnreadOverride({ LETTERDOCK_DEBUG_UNREAD: '150' }, false)).toBe(150);
  });

  it('is ignored when the app is packaged', () => {
    expect(debugUnreadOverride({ LETTERDOCK_DEBUG_UNREAD: '26' }, true)).toBeNull();
  });

  it('is ignored when missing or not a whole number', () => {
    expect(debugUnreadOverride({}, false)).toBeNull();
    expect(debugUnreadOverride({ LETTERDOCK_DEBUG_UNREAD: '' }, false)).toBeNull();
    expect(debugUnreadOverride({ LETTERDOCK_DEBUG_UNREAD: 'abc' }, false)).toBeNull();
    expect(debugUnreadOverride({ LETTERDOCK_DEBUG_UNREAD: '-4' }, false)).toBeNull();
    expect(debugUnreadOverride({ LETTERDOCK_DEBUG_UNREAD: '2.5' }, false)).toBeNull();
  });

  it('forces the controller count whatever the engine says', () => {
    vi.useFakeTimers();
    const w = fakeWindow();
    const badge = new UnreadBadge(
      { makeImage: (t) => ({ text: t }) as never, plainImage: () => PLAIN, setTrayDot: () => undefined, forcedCount: 26 },
      { badgeTaskbar: true, badgeTray: true },
    );
    badge.attachWindow(w.win, { main: true });
    expect(w.setIcon).toHaveBeenLastCalledWith({ text: '26' });
    expect(w.setTitle).toHaveBeenLastCalledWith('Letterdock (26)');
    badge.setCountNow(0);
    badge.onCounts(3);
    vi.advanceTimersByTime(BADGE_DEBOUNCE_MS);
    expect(w.setIcon).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

// A synthetic opaque icon square (any size) and a synthetic badge cell: a red disc with a white centre dot.
function solidIcon(size: number): PremulImage {
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200; // b
    data[i + 1] = 120; // g
    data[i + 2] = 20; // r
    data[i + 3] = 255;
  }
  return { size, data };
}
function discCell(d: number): PremulImage {
  const data = Buffer.alloc(d * d * 4);
  const c = d / 2;
  for (let y = 0; y < d; y++) {
    for (let x = 0; x < d; x++) {
      const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      if (r <= c - 0.5) {
        const o = (y * d + x) * 4;
        const white = r < c / 3;
        data[o] = white ? 255 : 0x1c;
        data[o + 1] = white ? 255 : 0x2b;
        data[o + 2] = white ? 255 : 0xc4;
        data[o + 3] = 255;
      }
    }
  }
  return { size: d, data };
}
const isRed = (p: { b: number; g: number; r: number; a: number }) => p.a === 255 && p.r === 0xc4 && p.g === 0x2b && p.b === 0x1c;

describe('icon composite geometry', () => {
  it('uses a 56% badge, a ring of max(1, size/32) and a 96 px base', () => {
    expect(BADGE_RATIO).toBe(0.56);
    expect(ICON_BASE_PX).toBe(96);
    expect([16, 24, 32, 48, 64, 96].map(badgeDiameter)).toEqual([9, 13, 18, 27, 36, 54]);
    expect([16, 24, 32, 48, 64, 96].map(ringWidth)).toEqual([1, 1, 1, 1.5, 2, 3]);
  });

  it('puts the badge flush to the bottom-right, fully inside the square, at every icon size', () => {
    for (const size of [16, 24, 32, 48, 64, 96]) {
      const d = badgeDiameter(size);
      const out = compositeBadge(solidIcon(size), discCell(d));
      expect(out.size).toBe(size);
      expect(out.data.length).toBe(size * size * 4);
      let minX = size, maxX = -1, minY = size, maxY = -1;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (isRed(px(out.data, size, x, y))) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
      }
      // the red disc spans the badge box: it touches the right and bottom edge and is about d px wide (2 px slack for the soft edge)
      expect(maxX).toBeGreaterThanOrEqual(size - 2); // anti-aliased edge: the last column can be a bit transparent
      expect(maxY).toBeGreaterThanOrEqual(size - 2);
      expect(Math.abs(maxX - minX + 1 - d)).toBeLessThanOrEqual(2);
      expect(Math.abs(maxY - minY + 1 - d)).toBeLessThanOrEqual(2);
      expect(minX).toBeGreaterThanOrEqual(size - d);
      expect(minY).toBeGreaterThanOrEqual(size - d);
    }
  });

  it('clears a ring around the badge and leaves the rest of the icon untouched', () => {
    const size = ICON_BASE_PX;
    const icon = solidIcon(size);
    const box = badgeBox(size);
    const out = compositeBadge(icon, discCell(box.d));
    const rw = ringWidth(size);
    // along the diagonal up-left of the badge: inside the ring band the icon is cleared, outside it is as before
    const at = (dist: number) => {
      const x = Math.floor(box.cx - Math.SQRT1_2 * dist);
      return { x, p: px(out.data, size, x, x) };
    };
    expect(at(box.d / 2 + rw / 2).p).toEqual({ b: 0, g: 0, r: 0, a: 0 });
    expect(at(box.d / 2 + 1).p).toEqual({ b: 0, g: 0, r: 0, a: 0 });
    const outside = at(box.d / 2 + rw + 3);
    expect(outside.p).toEqual(px(icon.data, size, outside.x, outside.x));
    // far from the badge nothing changed
    for (const [x, y] of [[0, 0], [10, 10], [size - 1, 5], [5, size - 1], [20, 60]]) {
      expect(px(out.data, size, x, y)).toEqual(px(icon.data, size, x, y));
    }
    // the white centre of the cell is at the middle of the badge
    expect(px(out.data, size, Math.floor(box.cx), Math.floor(box.cy))).toEqual({ b: 255, g: 255, r: 255, a: 255 });
  });

  it('keeps premultiplied pixels valid (no channel above alpha)', () => {
    const out = compositeBadge(solidIcon(96), discCell(54));
    for (let o = 0; o < out.data.length; o += 4) {
      expect(out.data[o]).toBeLessThanOrEqual(out.data[o + 3]);
      expect(out.data[o + 1]).toBeLessThanOrEqual(out.data[o + 3]);
      expect(out.data[o + 2]).toBeLessThanOrEqual(out.data[o + 3]);
    }
  });

  it('refuses a cell of the wrong size', () => {
    expect(() => compositeBadge(solidIcon(96), discCell(48))).toThrow(/54 px needed/);
  });

  it('builds the real 96 px icon from the .ico (256 px frame) and keeps its shape', () => {
    const frame = largestFrame(parseIco(readFileSync(join(__dirname, '../../build/icon.ico'))))!;
    expect(frame.width).toBe(256);
    const base = resizePremul(premulFrame(frame), ICON_BASE_PX);
    expect(base.size).toBe(96);
    expect(px(base.data, 96, 0, 0).a).toBe(0); // the rounded corner stays transparent
    expect(px(base.data, 96, 48, 48).a).toBe(255);
    const out = compositeBadge(base, discCell(ICON_BADGE_PX));
    expect(px(out.data, 96, 80, 80).a).toBe(255); // inside the badge
  });

  it('resize keeps a flat colour flat', () => {
    const small = resizePremul(solidIcon(64), 24);
    for (let o = 0; o < small.data.length; o += 4) {
      expect([small.data[o], small.data[o + 1], small.data[o + 2], small.data[o + 3]]).toEqual([200, 120, 20, 255]);
    }
  });
});

describe('badge controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(settings = { badgeTaskbar: true, badgeTray: true }, extra: Partial<BadgeDeps> = {}) {
    const dots: boolean[] = [];
    const makeImage = vi.fn((t: string) => ({ text: t }) as never);
    const badge = new UnreadBadge(
      { makeImage, plainImage: () => PLAIN, setTrayDot: (on) => dots.push(on), ...extra },
      settings,
    );
    const main = fakeWindow();
    badge.attachWindow(main.win, { main: true });
    return { badge, dots, makeImage, main };
  }

  it('sets the badged icon and the title for the first count and restores the plain icon at zero', () => {
    const { badge, main } = setup();
    expect(main.setIcon).not.toHaveBeenCalled(); // nothing unread: the window keeps its plain icon
    badge.setCountNow(26);
    expect(main.setIcon).toHaveBeenLastCalledWith({ text: '26' });
    expect(main.setTitle).toHaveBeenLastCalledWith('Letterdock (26)');
    badge.setCountNow(0);
    expect(main.setIcon).toHaveBeenLastCalledWith(PLAIN); // never null
    expect(main.setTitle).toHaveBeenLastCalledWith('Letterdock');
  });

  it('never uses the native overlay, except one clear per window', () => {
    const { badge, main } = setup();
    const other = fakeWindow();
    badge.attachWindow(other.win);
    badge.setCountNow(5);
    badge.setCountNow(0);
    expect(main.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(main.setOverlayIcon).toHaveBeenCalledWith(null, '');
    expect(other.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(other.setOverlayIcon).toHaveBeenCalledWith(null, '');
    badge.attachWindow(main.win, { main: true }); // attaching again does not clear again
    expect(main.setOverlayIcon).toHaveBeenCalledTimes(1);
  });

  it('puts the badge on every window, and only the main window gets the title', () => {
    const { badge, main } = setup();
    const compose = fakeWindow();
    const viewer = fakeWindow();
    badge.attachWindow(compose.win);
    badge.attachWindow(viewer.win);
    badge.setCountNow(9);
    for (const w of [main, compose, viewer]) expect(w.setIcon).toHaveBeenLastCalledWith({ text: '9' });
    expect(main.setTitle).toHaveBeenLastCalledWith('Letterdock (9)');
    expect(compose.setTitle).not.toHaveBeenCalled();
    expect(viewer.setTitle).not.toHaveBeenCalled();
    badge.setCountNow(0);
    for (const w of [main, compose, viewer]) expect(w.setIcon).toHaveBeenLastCalledWith(PLAIN);
  });

  it('gives a window created later the badge at once', () => {
    const { badge } = setup();
    badge.setCountNow(12);
    const late = fakeWindow();
    badge.attachWindow(late.win);
    expect(late.setIcon).toHaveBeenCalledTimes(1);
    expect(late.setIcon).toHaveBeenCalledWith({ text: '12' });
  });

  it('does not touch a late window at zero (it was created with the plain icon)', () => {
    const { badge } = setup();
    const late = fakeWindow();
    badge.attachWindow(late.win);
    expect(late.setIcon).not.toHaveBeenCalled();
    expect(late.setTitle).not.toHaveBeenCalled();
  });

  it('upgrades a window to main when it is attached again as the main window', () => {
    const { badge } = setup();
    badge.setCountNow(4);
    const w = fakeWindow();
    badge.attachWindow(w.win); // browser-window-created
    expect(w.setTitle).not.toHaveBeenCalled();
    badge.attachWindow(w.win, { main: true }); // ensureMainWindow
    expect(w.setTitle).toHaveBeenLastCalledWith('Letterdock (4)');
    expect(w.setIcon).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a call when nothing changed', () => {
    const { badge, main } = setup();
    badge.setCountNow(5);
    badge.setCountNow(5);
    badge.setCountNow(5);
    expect(main.setIcon).toHaveBeenCalledTimes(1);
    expect(main.setTitle).toHaveBeenCalledTimes(1);
    badge.setCountNow(120); // 99 on the icon, the exact count in the title
    badge.setCountNow(130);
    expect(main.setIcon).toHaveBeenCalledTimes(2);
    expect(main.setTitle).toHaveBeenCalledTimes(3);
    expect(main.setTitle).toHaveBeenLastCalledWith('Letterdock (130)');
  });

  it('turns a burst of counts into one update after 250 ms', () => {
    const { badge, main } = setup();
    badge.onCounts(1);
    badge.onCounts(2);
    badge.onCounts(3);
    expect(main.setIcon).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BADGE_DEBOUNCE_MS - 1);
    expect(main.setIcon).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(main.setIcon).toHaveBeenCalledTimes(1);
    expect(main.setIcon).toHaveBeenCalledWith({ text: '3' });
  });

  it('builds each image once and caches it by text and size', () => {
    const { badge, makeImage } = setup();
    const a = fakeWindow();
    badge.attachWindow(a.win);
    badge.setCountNow(7);
    badge.setCountNow(0);
    badge.setCountNow(7);
    badge.setCountNow(8);
    badge.setCountNow(120);
    badge.setCountNow(99);
    expect(makeImage.mock.calls.map((c) => c[0])).toEqual(['7', '8', '99']);
    expect(a.setIcon).toHaveBeenCalledWith(expect.objectContaining({ text: '7' }));
  });

  it('restores the plain icon when the taskbar setting goes off and the badge when it goes on', () => {
    const { badge, main } = setup();
    badge.setCountNow(5);
    badge.settingsChanged({ badgeTaskbar: false, badgeTray: true });
    expect(main.setIcon).toHaveBeenLastCalledWith(PLAIN);
    expect(main.setTitle).toHaveBeenLastCalledWith('Letterdock');
    badge.settingsChanged({ badgeTaskbar: true, badgeTray: true });
    expect(main.setIcon).toHaveBeenLastCalledWith({ text: '5' });
    expect(main.setTitle).toHaveBeenLastCalledWith('Letterdock (5)');
  });

  it('starts with the taskbar setting off and shows nothing', () => {
    const { badge, main, dots } = setup({ badgeTaskbar: false, badgeTray: false });
    badge.setCountNow(9);
    expect(main.setIcon).not.toHaveBeenCalled();
    expect(main.setTitle).not.toHaveBeenCalled();
    expect(dots).toEqual([]);
  });

  it('switches the tray dot with its own setting', () => {
    const { badge, dots } = setup();
    badge.setCountNow(3);
    expect(dots).toEqual([true]);
    badge.settingsChanged({ badgeTaskbar: true, badgeTray: false });
    expect(dots).toEqual([true, false]);
    badge.settingsChanged({ badgeTaskbar: true, badgeTray: true });
    expect(dots).toEqual([true, false, true]);
    badge.setCountNow(0);
    expect(dots).toEqual([true, false, true, false]);
  });

  it('keeps the main title when the page sets its own title', () => {
    const { main } = setup();
    const e = { preventDefault: vi.fn() };
    main.emit('page-title-updated', e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('leaves the title of compose and viewer windows alone', () => {
    const { badge } = setup();
    const compose = fakeWindow();
    badge.attachWindow(compose.win);
    const e = { preventDefault: vi.fn() };
    compose.emit('page-title-updated', e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('survives destroyed and closed windows', () => {
    const { badge, main } = setup();
    const gone = fakeWindow();
    badge.attachWindow(gone.win);
    gone.destroy();
    expect(() => badge.setCountNow(3)).not.toThrow();
    expect(gone.setIcon).not.toHaveBeenCalled();
    expect(main.setIcon).toHaveBeenCalledTimes(1);
    const closed = fakeWindow();
    badge.attachWindow(closed.win);
    closed.emit('closed');
    badge.setCountNow(4);
    expect(closed.setIcon).toHaveBeenCalledTimes(1); // only the one from attach
  });

  it('ignores nonsense counts', () => {
    const { badge, main } = setup();
    badge.setCountNow(Number.NaN);
    badge.setCountNow(-4);
    expect(main.setIcon).not.toHaveBeenCalled();
    badge.setCountNow(2.9);
    expect(main.setIcon).toHaveBeenLastCalledWith({ text: '2' });
  });

  it('keeps the plain icon, and says so once, when the badged icon cannot be made', () => {
    const onError = vi.fn();
    const makeImage = vi.fn(() => {
      throw new Error('strip missing');
    });
    const badge = new UnreadBadge(
      { makeImage, plainImage: () => PLAIN, setTrayDot: () => undefined, onError },
      { badgeTaskbar: true, badgeTray: true },
    );
    const w = fakeWindow();
    badge.attachWindow(w.win, { main: true });
    badge.setCountNow(3);
    badge.setCountNow(4);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(w.setIcon).toHaveBeenCalledWith(PLAIN); // never null
    expect(w.setTitle).toHaveBeenLastCalledWith('Letterdock (4)'); // the count still reaches the title
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
  it('has the one strip size the 96 px icon needs, equal to the badge diameter', () => {
    expect([...BADGE_STRIP_SIZES]).toEqual([54]);
    expect(ICON_BADGE_PX).toBe(badgeDiameter(ICON_BASE_PX));
    expect(ICON_BADGE_PX).toBe(54);
  });

  it('crops number n from cell n-1', () => {
    expect(stripCropRect(54, '1')).toEqual({ x: 0, y: 0, width: 54, height: 54 });
    expect(stripCropRect(54, '99')).toEqual({ x: 98 * 54, y: 0, width: 54, height: 54 });
    expect(() => stripCropRect(54, '0')).toThrow();
    expect(() => stripCropRect(54, '100')).toThrow();
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
