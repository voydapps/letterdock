// Notification-area (tray) icon: tooltip with the unread count and a small menu.
import { readFileSync } from 'node:fs';
// The tray images are made with nativeImage.createFromPath(<.ico>) on purpose. Electron v44 (Tray.setImage, Windows)
// asks the image for an HICON of GetSystemMetrics(SM_CXSMICON) px (16/20/24/28/32 at 100/125/150/175/200 %).
// NativeImage::GetHICON(size) of a path image does LoadImage(path, size): Windows picks the exact frame of the .ico.
// For an image built from a bitmap it ignores the size: IconUtil::CreateHICONFromSkBitmap(image_.AsBitmap()) uses the
// 1x (16 px) bitmap, and Windows stretches it at 150 % (blurry). So the dot icon is a pre-built .ico, not a bitmap.
import { Menu, Tray, nativeImage, screen, type NativeImage } from 'electron';
import { appIconPath, trayDotIconPath } from './appIcon';
import { trayTooltip } from './background';
import { premultiply, trayFrames, withDot } from './trayIcon';
import { buildMultiScaleImage, BADGE_SIZES } from './unreadBadge';

/**
 * The tray icon with the unread dot, built from the .ico's own 16/20/24/32 px frames (3.15).
 * Returns null when the file cannot be read or has no such frames: then there is no dot.
 */
export function buildDotIcon(icoPath: string): NativeImage | null {
  try {
    const frames = trayFrames(readFileSync(icoPath));
    if (!frames) return null;
    const img = buildMultiScaleImage(
      { fromBitmap: (buffer, opts) => nativeImage.createFromBitmap(buffer, opts) },
      (size) => premultiply(withDot(frames.get(size)!).bgra),
      BADGE_SIZES,
    );
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

/** The dot icon from build/tray-dot.ico (exact frame per display scale), or null when the file is missing. */
export function loadDotIconFile(path: string): NativeImage | null {
  try {
    const img = nativeImage.createFromPath(path);
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

export interface TrayActions {
  open: () => void;
  newMail: () => void;
  checkMail: () => void;
  quit: () => void;
}

export class AppTray {
  private tray: Tray | null = null;
  private unread = 0;
  private dotWanted = false;
  private normalImage: NativeImage | null = null;
  private dotImage: NativeImage | null = null;
  private showingDot = false;
  private warned = false;
  private onMetrics: (() => void) | null = null;

  /** `log` is called once if the pre-built dot icon is missing (the runtime-built dot is used instead). */
  constructor(private readonly log: (message: string) => void = () => {}) {}

  /** Returns false if Windows would not give us a tray icon. */
  create(actions: TrayActions): boolean {
    try {
      const image = nativeImage.createFromPath(appIconPath());
      if (image.isEmpty()) return false;
      this.normalImage = image;
      this.dotImage = null;
      this.showingDot = false;
      const tray = new Tray(image);
      tray.setToolTip(trayTooltip(this.unread));
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Open Letterdock', click: actions.open },
          { label: 'New mail', click: actions.newMail },
          { label: 'Check mail now', click: actions.checkMail },
          { type: 'separator' },
          { label: 'Quit', click: actions.quit },
        ]),
      );
      tray.on('click', actions.open);
      tray.on('double-click', actions.open);
      this.tray = tray;
      // On a display scale change Windows may want another frame: set the image again so Electron asks for
      // GetHICON(SM_CXSMICON) anew (it is cached per size, so this is cheap).
      this.onMetrics = () => this.reapply();
      screen.on('display-metrics-changed', this.onMetrics);
      this.refreshImage();
      return true;
    } catch {
      this.tray = null;
      return false;
    }
  }

  get available(): boolean {
    return this.tray !== null && !this.tray.isDestroyed();
  }

  setUnread(n: number): void {
    this.unread = n;
    if (this.available) this.tray!.setToolTip(trayTooltip(n));
  }

  /** Show (or hide) the red unread dot. The tooltip is not touched. */
  setDot(on: boolean): void {
    this.dotWanted = on;
    this.refreshImage();
  }

  private refreshImage(): void {
    if (!this.available || !this.normalImage) return;
    if (this.dotWanted === this.showingDot) return;
    let img = this.normalImage;
    if (this.dotWanted) {
      this.dotImage ??= this.loadDot();
      if (!this.dotImage) return; // no usable frames: keep the normal icon
      img = this.dotImage;
    }
    this.tray!.setImage(img);
    this.showingDot = this.dotWanted;
  }

  private loadDot(): NativeImage | null {
    const file = loadDotIconFile(trayDotIconPath());
    if (file) return file;
    if (!this.warned) {
      this.warned = true;
      this.log(`tray-dot.ico missing or unreadable (${trayDotIconPath()}): using the runtime-built dot icon (may look soft above 100% scaling)`);
    }
    return buildDotIcon(appIconPath());
  }

  /** Sets the current image again (display scale changed). */
  reapply(): void {
    if (!this.available || !this.normalImage) return;
    this.tray!.setImage(this.showingDot && this.dotImage ? this.dotImage : this.normalImage);
  }

  destroy(): void {
    if (this.onMetrics) screen.removeListener('display-metrics-changed', this.onMetrics);
    this.onMetrics = null;
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}
