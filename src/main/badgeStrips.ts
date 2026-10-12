// Pre-rendered unread numbers (DESIGN-SPEC 3.15). Pure functions, so they can be tested.
// build/badges/badge-<size>.png (made by scripts/build-badges.mjs) is a row of 99 square cells; cell n-1 is the
// number n. Packaged: <resources>/badges (extraResources). Development: <repo>/build/badges.
import { join } from 'node:path';

/** Sizes of the strips, in physical pixels. */
export const BADGE_STRIP_SIZES = [16, 20, 24, 28, 32, 40, 48] as const;
/** The overlay is 16 device-independent pixels (what Windows draws on the taskbar button). */
export const BADGE_DIP = 16;

export function badgeStripsDir(o: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return o.isPackaged ? join(o.resourcesPath, 'badges') : join(o.appPath, 'build', 'badges');
}

export function badgeStripPath(dir: string, size: number): string {
  return join(dir, `badge-${size}.png`);
}

/** Pixels needed for a 16 DIP overlay on a screen with this scale factor. */
export function badgePx(scaleFactor: number): number {
  const sf = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return Math.round(BADGE_DIP * sf);
}

/** The smallest strip size that is at least `px`; the largest one when `px` is bigger than all of them. */
export function pickBadgeSize(px: number): number {
  for (const s of BADGE_STRIP_SIZES) if (s >= px) return s;
  return BADGE_STRIP_SIZES[BADGE_STRIP_SIZES.length - 1];
}

/** Strip size for a scale factor. */
export function overlaySize(scaleFactor: number): number {
  return pickBadgeSize(badgePx(scaleFactor));
}

/** Where the number `text` ('1'..'99') is in a strip of `size`-pixel cells. */
export function stripCropRect(size: number, text: string): { x: number; y: number; width: number; height: number } {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error(`no badge cell for "${text}"`);
  return { x: (n - 1) * size, y: 0, width: size, height: size };
}
