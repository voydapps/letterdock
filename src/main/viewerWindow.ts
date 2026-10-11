// "Open in new window": one BrowserWindow per message, same security settings as the compose window.
// It loads the third renderer entry (viewer.html); the message id travels in the URL hash.
// Size, position and maximized state are remembered between runs (see windowBounds.ts).
import { join } from 'node:path';
import { BrowserWindow, nativeTheme, shell } from 'electron';
import type { EmlErrorItem } from '../shared/emlErrors';
import { isSafeExternalUrl } from '../shared/safety';
import { appIconPath } from './appIcon';
import { emlErrorHash, emlHash, viewerHash } from './viewerState';
import { BoundsStore, VIEWER_RULES } from './windowBounds';
import { placeNewWindow, trackWindowBounds } from './windowPlacement';

export interface ViewerWindowsOptions {
  preload: string;
  rendererUrl: string | undefined;
  rendererDir: string;
  stateFile: string;
  /** The main window (new windows open on its display). */
  getMain: () => BrowserWindow | null;
  /** Called for every new window (main adds it to the trusted-sender set). */
  onCreated: (w: BrowserWindow) => void;
}

export class ViewerWindows {
  private windows = new Map<number, BrowserWindow>();
  private emlWindows = new Set<BrowserWindow>();
  private store: BoundsStore;

  constructor(private readonly opts: ViewerWindowsOptions) {
    this.store = new BoundsStore(opts.stateFile, VIEWER_RULES);
  }

  /** Opens the message, or focuses the window that already shows it. */
  open(messageId: number): BrowserWindow {
    const existing = this.windows.get(messageId);
    if (existing && !existing.isDestroyed()) {
      focusWindow(existing);
      return existing;
    }
    const win = this.create(viewerHash(messageId));
    this.windows.set(messageId, win);
    win.on('closed', () => {
      if (this.windows.get(messageId) === win) this.windows.delete(messageId);
    });
    this.opts.onCreated(win);
    return win;
  }

  /**
   * A message from a .eml file (DESIGN-SPEC 3.14): same window, loaded by token. `onClosed` runs once
   * when the window is gone (main frees the message then).
   */
  openEml(token: string, onClosed: () => void): BrowserWindow {
    const win = this.create(emlHash(token));
    this.emlWindows.add(win);
    win.on('closed', () => {
      this.emlWindows.delete(win);
      onClosed();
    });
    this.opts.onCreated(win);
    return win;
  }

  /** Small window with an error text, for an app that was started by a file it could not open. */
  openEmlError(items: readonly EmlErrorItem[]): BrowserWindow {
    const dark = nativeTheme.shouldUseDarkColors;
    const win = new BrowserWindow({
      width: 520,
      height: items.length > 1 ? Math.min(560, 280 + 56 * items.length) : 300,
      minWidth: 400,
      minHeight: 240,
      show: false,
      backgroundColor: dark ? '#202020' : '#F3F3F3',
      icon: appIconPath(),
      title: 'Letterdock',
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 36, color: '#00000000', symbolColor: dark ? '#FFFFFF' : '#1A1A1A' },
      webPreferences: this.webPreferences(),
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.load(win, emlErrorHash(items));
    this.opts.onCreated(win);
    return win;
  }

  private webPreferences() {
    return {
      preload: this.opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    };
  }

  private load(win: BrowserWindow, hash: string): void {
    if (this.opts.rendererUrl) {
      void win.loadURL(`${this.opts.rendererUrl.replace(/\/$/, '')}/viewer.html#${hash}`);
    } else {
      void win.loadFile(join(this.opts.rendererDir, 'viewer.html'), { hash });
    }
  }

  private create(hash: string): BrowserWindow {
    const dark = nativeTheme.shouldUseDarkColors;
    const place = placeNewWindow({
      rules: VIEWER_RULES,
      store: this.store,
      remember: true,
      others: [...this.windows.values(), ...this.emlWindows],
      main: this.opts.getMain(),
    });
    const win = new BrowserWindow({
      width: place.width,
      height: place.height,
      x: place.x,
      y: place.y,
      minWidth: 480,
      minHeight: 400,
      show: false,
      backgroundColor: dark ? '#202020' : '#F3F3F3',
      icon: appIconPath(),
      title: 'Message',
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 36, color: '#00000000', symbolColor: dark ? '#FFFFFF' : '#1A1A1A' },
      webPreferences: this.webPreferences(),
    });
    if (place.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    trackWindowBounds(win, { store: this.store, remember: () => true, cascaded: place.cascaded });

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && isSafeExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    this.load(win, hash);
    return win;
  }
}

function focusWindow(w: BrowserWindow): void {
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}
