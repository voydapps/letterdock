// Pre-rendered unread numbers (DESIGN-SPEC 3.15). Pure functions, so they can be tested.
// build/badges/badge-<size>.png (made by scripts/build-badges.mjs) is a row of 99 square cells; cell n-1 is the
// number n. Packaged: <resources>/badges (extraResources). Development: <repo>/build/badges.
import { join } from 'node:path';
import { ICON_BASE_PX, badgeDiameter } from './iconBadge';

/**
 * Strip sizes, in physical pixels. The badge is composited into a 96 px icon, where it is 54 px, and the cell is
 * used as it is, never resampled. The test in unreadBadge.test.ts keeps this in step with iconBadge.ts.
 */
export const BADGE_STRIP_SIZES = [54] as const;
/** The strip size the window icon needs. */
export const ICON_BADGE_PX = badgeDiameter(ICON_BASE_PX);

export function badgeStripsDir(o: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return o.isPackaged ? join(o.resourcesPath, 'badges') : join(o.appPath, 'build', 'badges');
}

export function badgeStripPath(dir: string, size: number): string {
  return join(dir, `badge-${size}.png`);
}

/** Where the number `text` ('1'..'99') is in a strip of `size`-pixel cells. */
export function stripCropRect(size: number, text: string): { x: number; y: number; width: number; height: number } {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error(`no badge cell for "${text}"`);
  return { x: (n - 1) * size, y: 0, width: size, height: size };
}
