// Icons on the toast buttons (DESIGN-SPEC 3.13.3a). Pure functions, so they can be tested.
// Packaged: <resources>/toast-icons (extraResources). Development: <repo>/build/toast-icons.
import { join } from 'node:path';

export type ToastIconAction = 'read' | 'archive' | 'delete';
export type ToastIcons = Partial<Record<ToastIconAction, string>>;

export function toastIconsDir(o: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return o.isPackaged ? join(o.resourcesPath, 'toast-icons') : join(o.appPath, 'build', 'toast-icons');
}

/**
 * Absolute path of the icon of each button, for the current theme. A file that does not exist is
 * left out: that button then has text only (the toast must never break because of an icon).
 * `-dark.png` is the white glyph for a dark toast, `-light.png` the dark glyph for a light toast.
 */
export function resolveToastIcons(o: { dir: string; dark: boolean; exists: (p: string) => boolean }): ToastIcons {
  const out: ToastIcons = {};
  for (const a of ['read', 'archive', 'delete'] as const) {
    const p = join(o.dir, `${a}-${o.dark ? 'dark' : 'light'}.png`);
    if (o.exists(p)) out[a] = p;
  }
  return out;
}
