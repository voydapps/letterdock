// Unread badge (DESIGN-SPEC 3.15, addendum 2026-10-12): text and title, the native overlay (size pick, HICON
// life cycle, all windows, fallback to the Electron overlay), the debug hook, the tray dot frames and the settings.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_TITLE,
  BADGE_DEBOUNCE_MS,
  UnreadBadge,
  badgeDescription,
  badgeText,
  debugUnreadOverride,
  trayDotWanted,
  windowTitle,
  type BadgeDeps,
  type BadgeWindowLike,
} from '../../src/main/unreadBadge';
import { HiconOverlay, OverlayError, loadNativeOverlay, type OverlayNative } from '../../src/main/taskbarOverlay';
import { BADGE_STRIP_SIZES, badgePx, badgeStripsDir, overlaySize, pickBadgeSize, stripCropRect } from '../../src/main/badgeStrips';
import { dotDiameter, parseIco, premultiply, trayFrames, withDot } from '../../src/main/trayIcon';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/main/settings';
import { schemas } from '../../src/main/ipcSchemas';

const px = (buf: Buffer, size: number, x: number, y: number) => {
  const o = (y * size + x) * 4;
  return { b: buf[o], g: buf[o + 1], r: buf[o + 2], a: buf[o + 3] };
};

let nextHwnd = 100n;
function fakeWindow() {
  const handlers: Record<string, ((e?: { preventDefault(): void }) => void)[]> = {};
  let destroyed = false;
  const hwnd = nextHwnd++;
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(hwnd);
  const setTitle = vi.fn();
  const setOverlayIcon = vi.fn();
  const hooks: { msg: number; cb: () => void }[] = [];
  const win: BadgeWindowLike = {
    isDestroyed: () => destroyed,
    setTitle,
    setOverlayIcon,
    getNativeWindowHandle: () => handle,
    hookWindowMessage: (msg, cb) => void hooks.push({ msg, cb }),
    on: ((ev: string, fn: () => void) => ((handlers[ev] ??= []).push(fn), undefined)) as never,
  };
  return {
    win,
    hwnd,
    setTitle,
    setOverlayIcon,
    hooks,
    destroy: () => (destroyed = true),
    emit: (ev: string, e?: { preventDefault(): void }) => (handlers[ev] ?? []).forEach((f) => f(e)),
  };
}

type Shown = { icon: bigint; png: Buffer; px: number; desc: string } | null;
/** A fake of the Win32 layer: hands out HICON numbers, keeps the ones not destroyed, remembers what each window shows. */
function fakeNative(over: Partial<OverlayNative> = {}) {
  let n = 1000n;
  const live = new Set<bigint>();
  const shown = new Map<bigint, Shown>();
  const made = new Map<bigint, { png: Buffer; px: number }>();
  const native: OverlayNative = {
    description: 'koffi test',
    createIcon: (png, size) => {
      const h = ++n;
      live.add(h);
      made.set(h, { png, px: size });
      return h;
    },
    destroyIcon: (h) => void live.delete(h),
    setOverlay: (hwnd, icon, desc) => {
      shown.set(hwnd, icon === null ? null : { icon, ...made.get(icon)!, desc });
      return 0;
    },
    taskbarCreatedMessage: () => 0xc123,
    release: vi.fn(),
    ...over,
  };
  return { native, live, shown };
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

  it('describes the overlay for a screen reader', () => {
    expect(badgeDescription(0)).toBe('');
    expect(badgeDescription(1)).toBe('1 unread message');
    expect(badgeDescription(26)).toBe('26 unread messages');
    expect(badgeDescription(100)).toBe('More than 99 unread messages');
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

describe('overlay size', () => {
  it('is 16 DIP in pixels for the scale factor', () => {
    expect(badgePx(1)).toBe(16);
    expect(badgePx(1.25)).toBe(20);
    expect(badgePx(1.5)).toBe(24);
    expect(badgePx(1.75)).toBe(28);
    expect(badgePx(2)).toBe(32);
    expect(badgePx(Number.NaN)).toBe(16);
    expect(badgePx(0)).toBe(16);
  });

  it('picks the smallest strip that is at least that big, the largest when none is', () => {
    expect([...BADGE_STRIP_SIZES]).toEqual([16, 20, 24, 28, 32, 40, 48]);
    expect(pickBadgeSize(16)).toBe(16);
    expect(pickBadgeSize(17)).toBe(20);
    expect(pickBadgeSize(24)).toBe(24);
    expect(pickBadgeSize(36)).toBe(40);
    expect(pickBadgeSize(41)).toBe(48);
    expect(pickBadgeSize(200)).toBe(48);
    expect(overlaySize(1.5)).toBe(24);
    expect(overlaySize(2.25)).toBe(40);
    expect(overlaySize(3)).toBe(48);
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
});

describe('HICON life cycle (HiconOverlay)', () => {
  it('destroys the previous icon only after the new one is set', () => {
    const order: string[] = [];
    const f = fakeNative();
    const create = f.native.createIcon;
    f.native.createIcon = (p, s) => {
      const h = create(p, s);
      order.push(`create ${h}`);
      return h;
    };
    const set = f.native.setOverlay;
    f.native.setOverlay = (h, i, d) => (order.push('set'), set(h, i, d));
    f.native.destroyIcon = (h) => void order.push(`destroy ${h}`);
    const o = new HiconOverlay(f.native);
    o.set(7n, Buffer.from('a'), 24, 'x');
    o.set(7n, Buffer.from('b'), 24, 'y');
    expect(order).toEqual(['create 1001', 'set', 'create 1002', 'set', 'destroy 1001']);
  });

  it('keeps one icon per window and frees all of them on dispose', () => {
    const { native, live } = fakeNative();
    const o = new HiconOverlay(native);
    o.set(1n, Buffer.from('a'), 16, '');
    o.set(2n, Buffer.from('a'), 16, '');
    o.set(1n, Buffer.from('b'), 16, '');
    expect(live.size).toBe(2);
    o.forget(2n);
    expect(live.size).toBe(1);
    o.dispose();
    expect(live.size).toBe(0);
    expect(native.release).toHaveBeenCalledTimes(1);
  });

  it('clears with a null icon and frees the icon', () => {
    const { native, live, shown } = fakeNative();
    const o = new HiconOverlay(native);
    o.set(1n, Buffer.from('a'), 16, 'x');
    o.clear(1n);
    expect(shown.get(1n)).toBeNull();
    expect(live.size).toBe(0);
  });

  it('destroys the new icon when Windows refuses it, and keeps the old one', () => {
    let hr = 0;
    const { native, live } = fakeNative({ setOverlay: () => hr });
    const o = new HiconOverlay(native);
    o.set(1n, Buffer.from('a'), 16, '');
    hr = -2147467259;
    expect(() => o.set(1n, Buffer.from('b'), 16, '')).toThrow(OverlayError);
    expect(live.size).toBe(1);
  });

  it('treats a missing icon as a permanent failure and a failed HRESULT as a passing one', () => {
    const a = new HiconOverlay(fakeNative({ createIcon: () => null }).native);
    expect(() => a.set(1n, Buffer.from('a'), 16, '')).toThrow(expect.objectContaining({ permanent: true }));
    const b = new HiconOverlay(fakeNative({ setOverlay: () => -1 }).native);
    expect(() => b.set(1n, Buffer.from('a'), 16, '')).toThrow(expect.objectContaining({ permanent: false }));
  });
});

describe('native layer', () => {
  it('throws when koffi cannot be loaded, so the caller can fall back', () => {
    if (process.platform !== 'win32') return;
    expect(() =>
      loadNativeOverlay(() => {
        throw new Error('Cannot find module koffi');
      }),
    ).toThrow(/koffi/);
  });
});

describe('badge controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(
    opts: { settings?: { badgeTaskbar: boolean; badgeTray: boolean }; loadFails?: boolean; extra?: Partial<BadgeDeps> } = {},
  ) {
    const dots: boolean[] = [];
    const fake = fakeNative();
    const modes: [string, string][] = [];
    const scale = { value: 1.5 };
    const cellPng = vi.fn((text: string, size: number) => Buffer.from(`${text}@${size}`));
    const badge = new UnreadBadge(
      {
        loadOverlay: () => {
          if (opts.loadFails) throw new Error('koffi missing');
          return new HiconOverlay(fake.native);
        },
        cellPng,
        imageFromPng: (png) => ({ png: png.toString() }) as never,
        getScaleFactor: () => scale.value,
        setTrayDot: (on) => dots.push(on),
        onMode: (m, d) => modes.push([m, d]),
        ...opts.extra,
      },
      opts.settings ?? { badgeTaskbar: true, badgeTray: true },
    );
    const main = fakeWindow();
    badge.attachWindow(main.win, { main: true });
    return { badge, dots, cellPng, main, fake, modes, scale };
  }
  type Setup = ReturnType<typeof setup>;
  const shownText = (f: Setup, w: { hwnd: bigint }) => f.fake.shown.get(w.hwnd)?.png.toString();

  it('shows nothing at start, the number at the real size, and clears at zero', () => {
    const f = setup();
    expect(f.fake.shown.size).toBe(0);
    f.badge.setCountNow(26);
    expect(shownText(f, f.main)).toBe('26@24'); // 150% = 24 px
    expect(f.fake.shown.get(f.main.hwnd)?.px).toBe(24);
    expect(f.fake.shown.get(f.main.hwnd)?.desc).toBe('26 unread messages');
    expect(f.main.setTitle).toHaveBeenLastCalledWith('Letterdock (26)');
    f.badge.setCountNow(0);
    expect(f.fake.shown.get(f.main.hwnd)).toBeNull();
    expect(f.fake.live.size).toBe(0);
    expect(f.main.setTitle).toHaveBeenLastCalledWith('Letterdock');
    expect(f.main.setOverlayIcon).not.toHaveBeenCalled(); // never the Electron overlay on the native path
  });

  it('reports the native path once', () => {
    const f = setup();
    expect(f.modes).toEqual([['native', 'koffi test']]);
  });

  it('picks the strip from the scale factor and re-applies when the window moves to another display', () => {
    const f = setup();
    f.scale.value = 1;
    f.badge.setCountNow(5);
    expect(shownText(f, f.main)).toBe('5@16');
    f.scale.value = 2.25;
    f.main.emit('moved');
    expect(shownText(f, f.main)).toBe('5@40');
    f.scale.value = 1.25;
    f.badge.displayChanged();
    expect(shownText(f, f.main)).toBe('5@20');
    expect(f.fake.live.size).toBe(1);
  });

  it('does nothing on a move when the size did not change', () => {
    const f = setup();
    f.badge.setCountNow(5);
    const before = f.fake.shown.get(f.main.hwnd);
    f.main.emit('moved');
    f.main.emit('moved');
    expect(f.fake.shown.get(f.main.hwnd)).toBe(before);
    expect(f.cellPng).toHaveBeenCalledTimes(1);
  });

  it('puts the overlay on every window, and only the main window gets the title', () => {
    const f = setup();
    const compose = fakeWindow();
    const viewer = fakeWindow();
    f.badge.attachWindow(compose.win);
    f.badge.attachWindow(viewer.win);
    f.badge.setCountNow(9);
    for (const w of [f.main, compose, viewer]) expect(shownText(f, w)).toBe('9@24');
    expect(compose.setTitle).not.toHaveBeenCalled();
    expect(viewer.setTitle).not.toHaveBeenCalled();
    f.badge.setCountNow(0);
    for (const w of [f.main, compose, viewer]) expect(f.fake.shown.get(w.hwnd)).toBeNull();
  });

  it('gives a window created later the overlay at once, and leaves it alone at zero', () => {
    const f = setup();
    const quiet = fakeWindow();
    f.badge.attachWindow(quiet.win);
    expect(f.fake.shown.has(quiet.hwnd)).toBe(false);
    f.badge.setCountNow(12);
    const late = fakeWindow();
    f.badge.attachWindow(late.win);
    expect(shownText(f, late)).toBe('12@24');
  });

  it('upgrades a window to main when it is attached again as the main window', () => {
    const f = setup();
    f.badge.setCountNow(4);
    const w = fakeWindow();
    f.badge.attachWindow(w.win);
    expect(w.setTitle).not.toHaveBeenCalled();
    f.badge.attachWindow(w.win, { main: true });
    expect(w.setTitle).toHaveBeenLastCalledWith('Letterdock (4)');
  });

  it('does not repeat a call when nothing changed', () => {
    const f = setup();
    const set = vi.spyOn(f.fake.native, 'setOverlay');
    f.badge.setCountNow(5);
    f.badge.setCountNow(5);
    f.badge.setCountNow(5);
    expect(set).toHaveBeenCalledTimes(1);
    expect(f.main.setTitle).toHaveBeenCalledTimes(1);
    f.badge.setCountNow(120); // 99 on the badge, the exact count in the title
    f.badge.setCountNow(130);
    expect(f.main.setTitle).toHaveBeenLastCalledWith('Letterdock (130)');
    expect(shownText(f, f.main)).toBe('99@24');
  });

  it('turns a burst of counts into one update after 250 ms', () => {
    const f = setup();
    f.badge.onCounts(1);
    f.badge.onCounts(2);
    f.badge.onCounts(3);
    expect(f.fake.shown.size).toBe(0);
    vi.advanceTimersByTime(BADGE_DEBOUNCE_MS - 1);
    expect(f.fake.shown.size).toBe(0);
    vi.advanceTimersByTime(1);
    expect(shownText(f, f.main)).toBe('3@24');
  });

  it('builds each cell once per text and size', () => {
    const f = setup();
    f.badge.setCountNow(7);
    f.badge.setCountNow(0);
    f.badge.setCountNow(7);
    f.badge.setCountNow(8);
    expect(f.cellPng.mock.calls).toEqual([
      ['7', 24],
      ['8', 24],
    ]);
  });

  it('clears the overlay when the taskbar setting goes off and brings it back when it goes on', () => {
    const f = setup();
    f.badge.setCountNow(5);
    f.badge.settingsChanged({ badgeTaskbar: false, badgeTray: true });
    expect(f.fake.shown.get(f.main.hwnd)).toBeNull();
    expect(f.main.setTitle).toHaveBeenLastCalledWith('Letterdock');
    f.badge.settingsChanged({ badgeTaskbar: true, badgeTray: true });
    expect(shownText(f, f.main)).toBe('5@24');
    expect(f.main.setTitle).toHaveBeenLastCalledWith('Letterdock (5)');
  });

  it('starts with the taskbar setting off and shows nothing', () => {
    const f = setup({ settings: { badgeTaskbar: false, badgeTray: false } });
    f.badge.setCountNow(9);
    expect(f.fake.shown.size).toBe(0);
    expect(f.main.setTitle).not.toHaveBeenCalled();
    expect(f.dots).toEqual([]);
  });

  it('applies again when the window shows, restores, or the taskbar button is created again', () => {
    const f = setup();
    f.badge.setCountNow(5);
    expect(f.main.hooks.map((h) => h.msg)).toEqual([0xc123]);
    const set = vi.spyOn(f.fake.native, 'setOverlay');
    f.main.emit('show');
    f.main.emit('restore');
    f.main.hooks[0].cb();
    expect(set).toHaveBeenCalledTimes(3);
    expect(shownText(f, f.main)).toBe('5@24');
  });

  it('frees the icon of a window that closed or was destroyed', () => {
    const f = setup();
    f.badge.setCountNow(5);
    const a = fakeWindow();
    const b = fakeWindow();
    f.badge.attachWindow(a.win);
    f.badge.attachWindow(b.win);
    expect(f.fake.live.size).toBe(3);
    a.emit('closed');
    b.destroy();
    f.badge.setCountNow(6);
    expect(f.fake.live.size).toBe(1);
    expect(() => f.badge.setCountNow(7)).not.toThrow();
  });

  it('releases the native object on dispose', () => {
    const f = setup();
    f.badge.setCountNow(5);
    f.badge.dispose();
    expect(f.fake.native.release).toHaveBeenCalledTimes(1);
    expect(f.fake.live.size).toBe(0);
  });

  it('switches the tray dot with its own setting', () => {
    const f = setup();
    f.badge.setCountNow(3);
    expect(f.dots).toEqual([true]);
    f.badge.settingsChanged({ badgeTaskbar: true, badgeTray: false });
    expect(f.dots).toEqual([true, false]);
    f.badge.settingsChanged({ badgeTaskbar: true, badgeTray: true });
    expect(f.dots).toEqual([true, false, true]);
    f.badge.setCountNow(0);
    expect(f.dots).toEqual([true, false, true, false]);
  });

  it('keeps the main title when the page sets its own title, and leaves other windows alone', () => {
    const f = setup();
    const e = { preventDefault: vi.fn() };
    f.main.emit('page-title-updated', e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    const compose = fakeWindow();
    f.badge.attachWindow(compose.win);
    const e2 = { preventDefault: vi.fn() };
    compose.emit('page-title-updated', e2);
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores nonsense counts', () => {
    const f = setup();
    f.badge.setCountNow(Number.NaN);
    f.badge.setCountNow(-4);
    expect(f.fake.shown.size).toBe(0);
    f.badge.setCountNow(2.9);
    expect(shownText(f, f.main)).toBe('2@24');
  });

  it('forces the controller count whatever the engine says (debug hook)', () => {
    const f = setup({ extra: { forcedCount: 26 } });
    expect(shownText(f, f.main)).toBe('26@24');
    expect(f.main.setTitle).toHaveBeenLastCalledWith('Letterdock (26)');
    f.badge.setCountNow(0);
    f.badge.onCounts(3);
    vi.advanceTimersByTime(BADGE_DEBOUNCE_MS);
    expect(shownText(f, f.main)).toBe('26@24');
  });

  describe('fallback to the Electron overlay', () => {
    it('is used, and said once, when koffi cannot be loaded; the number still shows', () => {
      const f = setup({ loadFails: true });
      expect(f.modes).toEqual([['fallback', 'koffi missing']]);
      f.badge.setCountNow(26);
      f.badge.setCountNow(27);
      expect(f.cellPng).toHaveBeenCalledWith('26', 16);
      expect(f.main.setOverlayIcon).toHaveBeenLastCalledWith({ png: '27@16' }, '27 unread messages');
      expect(f.modes).toHaveLength(1);
      expect(f.main.setTitle).toHaveBeenLastCalledWith('Letterdock (27)');
      f.badge.setCountNow(0);
      expect(f.main.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
    });

    it('is used for every window, and not repeated when nothing changed', () => {
      const f = setup({ loadFails: true });
      const other = fakeWindow();
      f.badge.attachWindow(other.win);
      f.badge.setCountNow(4);
      f.badge.setCountNow(4);
      expect(f.main.setOverlayIcon).toHaveBeenCalledTimes(1);
      expect(other.setOverlayIcon).toHaveBeenCalledTimes(1);
    });

    it('takes over for good when the native path fails for good (no icon can be made)', () => {
      const f = setup();
      f.fake.native.createIcon = () => null;
      f.badge.setCountNow(8);
      expect(f.modes.map((m) => m[0])).toEqual(['native', 'fallback']);
      expect(f.main.setOverlayIcon).toHaveBeenLastCalledWith({ png: '8@16' }, '8 unread messages');
      expect(f.fake.native.release).toHaveBeenCalledTimes(1);
    });

    it('stays native after one failed call and tries again on the next event', () => {
      const onTransientError = vi.fn();
      const f = setup({ extra: { onTransientError } });
      let hr = -2147467259;
      const ok = f.fake.native.setOverlay;
      f.fake.native.setOverlay = (hwnd, icon, desc) => (hr < 0 ? hr : ok(hwnd, icon, desc));
      f.badge.setCountNow(8);
      expect(onTransientError).toHaveBeenCalledTimes(1);
      expect(f.main.setOverlayIcon).not.toHaveBeenCalled();
      expect(f.modes).toHaveLength(1);
      hr = 0;
      f.main.emit('show');
      expect(shownText(f, f.main)).toBe('8@24');
      expect(f.fake.live.size).toBe(1);
    });
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
  it('crops number n from cell n-1', () => {
    expect(stripCropRect(24, '1')).toEqual({ x: 0, y: 0, width: 24, height: 24 });
    expect(stripCropRect(24, '99')).toEqual({ x: 98 * 24, y: 0, width: 24, height: 24 });
    expect(() => stripCropRect(24, '0')).toThrow();
    expect(() => stripCropRect(24, '100')).toThrow();
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
