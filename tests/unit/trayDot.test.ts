// The tray icon swaps to a dot variant only when asked, and the tooltip is not touched (DESIGN-SPEC 3.15).
import { describe, expect, it, vi } from 'vitest';

const el = vi.hoisted(() => {
  const tray = { setToolTip: vi.fn(), setImage: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), isDestroyed: () => false, destroy: vi.fn() };
  return {
    tray,
    bitmaps: [] as { width: number; scaleFactor: number }[],
    reps: [] as number[],
    paths: [] as string[],
    dotFileMissing: false,
    metricsListeners: [] as (() => void)[],
  };
});
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  Menu: { buildFromTemplate: () => ({}) },
  Tray: function Tray() {
    return el.tray;
  },
  screen: {
    on: (_e: string, f: () => void) => el.metricsListeners.push(f),
    removeListener: (_e: string, f: () => void) => {
      el.metricsListeners = el.metricsListeners.filter((x) => x !== f);
    },
  },
  nativeImage: {
    createFromPath: (p: string) => {
      el.paths.push(p);
      const isDot = p.endsWith('tray-dot.ico');
      return { tag: isDot ? 'dotfile' : 'normal', isEmpty: () => isDot && el.dotFileMissing };
    },
    createFromBitmap: (_b: Buffer, o: { width: number; scaleFactor: number }) => {
      el.bitmaps.push(o);
      return { tag: 'dot', isEmpty: () => false, addRepresentation: (r: { width: number }) => el.reps.push(r.width) };
    },
  },
}));

import { AppTray } from '../../src/main/tray';

const actions = { open: vi.fn(), newMail: vi.fn(), checkMail: vi.fn(), quit: vi.fn() };

describe('tray dot', () => {
  it('fallback: with tray-dot.ico missing it builds the dot from the .ico frames (once) and logs once', () => {
    el.dotFileMissing = true;
    el.bitmaps.length = 0;
    el.reps.length = 0;
    const log = vi.fn();
    const t = new AppTray(log);
    t.setUnread(4);
    expect(t.create(actions)).toBe(true);
    expect(el.tray.setImage).not.toHaveBeenCalled();
    t.setDot(true);
    expect(el.tray.setImage).toHaveBeenCalledTimes(1);
    expect(el.tray.setImage.mock.calls[0][0].tag).toBe('dot');
    expect(el.bitmaps).toEqual([{ width: 16, height: 16, scaleFactor: 1 }].map((o) => expect.objectContaining({ width: o.width, scaleFactor: 1 })));
    expect(el.reps).toEqual([20, 24, 32]);
    t.setDot(true); // no change: no new call
    expect(el.tray.setImage).toHaveBeenCalledTimes(1);
    t.setDot(false);
    expect(el.tray.setImage).toHaveBeenCalledTimes(2);
    expect(el.tray.setImage.mock.calls[1][0].tag).toBe('normal');
    t.setDot(true);
    expect(el.bitmaps.length).toBe(1); // cached
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('tray-dot.ico');
    el.dotFileMissing = false;
  });

  it('uses the pre-built tray-dot.ico (path image, exact frame per scale) when it exists', () => {
    el.dotFileMissing = false;
    el.bitmaps.length = 0;
    el.tray.setImage.mockClear();
    el.paths.length = 0;
    const log = vi.fn();
    const t = new AppTray(log);
    t.create(actions);
    t.setDot(true);
    expect(el.tray.setImage.mock.calls[0][0].tag).toBe('dotfile');
    expect(el.paths.some((p) => p.endsWith('icon.ico'))).toBe(true);
    expect(el.paths.some((p) => p.endsWith('tray-dot.ico'))).toBe(true);
    expect(el.bitmaps.length).toBe(0); // nothing built from a bitmap
    expect(log).not.toHaveBeenCalled();
    t.setDot(false);
    expect(el.tray.setImage.mock.calls[1][0].tag).toBe('normal');
  });

  it('sets the current image again when the display metrics change, and stops listening on destroy', () => {
    el.metricsListeners = [];
    el.tray.setImage.mockClear();
    const t = new AppTray();
    t.create(actions);
    t.setDot(true);
    el.tray.setImage.mockClear();
    expect(el.metricsListeners.length).toBe(1);
    el.metricsListeners[0]();
    expect(el.tray.setImage).toHaveBeenCalledTimes(1);
    expect(el.tray.setImage.mock.calls[0][0].tag).toBe('dotfile');
    t.destroy();
    expect(el.metricsListeners.length).toBe(0);
  });

  it('does not change the tooltip when the dot changes', () => {
    const t = new AppTray();
    t.setUnread(2);
    t.create(actions);
    el.tray.setToolTip.mockClear();
    t.setDot(true);
    t.setDot(false);
    expect(el.tray.setToolTip).not.toHaveBeenCalled();
    t.setUnread(3);
    expect(el.tray.setToolTip).toHaveBeenCalledWith('Letterdock - 3 unread');
  });

  it('applies a dot that was asked for before the tray existed', () => {
    el.tray.setImage.mockClear();
    const t = new AppTray();
    t.setDot(true);
    expect(el.tray.setImage).not.toHaveBeenCalled();
    t.create(actions);
    expect(el.tray.setImage).toHaveBeenCalledTimes(1);
  });
});
