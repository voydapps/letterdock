// Path of the app icon (DESIGN-SPEC 1.8). Packaged builds copy it to resources/ (extraResources);
// in dev it is read from build/.
import { join } from 'node:path';
import { app } from 'electron';

export function appIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build', 'icon.ico');
}

/** The tray icon with the unread dot: an .ico with one frame per display scale, drawn at build time (3.15). */
export function trayDotIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'tray-dot.ico') : join(app.getAppPath(), 'build', 'tray-dot.ico');
}
