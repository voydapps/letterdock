// Notification-area (tray) icon: tooltip with the unread count and a small menu.
import { readFileSync } from 'node:fs';
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { appIconPath } from './appIcon';
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
      this.dotImage ??= buildDotIcon(appIconPath());
      if (!this.dotImage) return; // no usable frames: keep the normal icon
      img = this.dotImage;
    }
    this.tray!.setImage(img);
    this.showingDot = this.dotWanted;
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}
