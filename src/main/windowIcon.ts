// Builds the window icons for the unread badge (DESIGN-SPEC 3.15 addendum 2026-10-12): the plain app icon and the
// app icon with the red number in its corner. The drawing itself is in iconBadge.ts (pure); this file only reads the
// .ico and the pre-rendered strip and makes the Electron images.
import { readFileSync } from 'node:fs';
import { nativeImage, type NativeImage } from 'electron';
import { ICON_BASE_PX, compositeBadge, largestFrame, premulFrame, resizePremul, type PremulImage } from './iconBadge';
import { ICON_BADGE_PX, badgeStripPath, stripCropRect } from './badgeStrips';
import { parseIco } from './trayIcon';

export interface WindowIconSources {
  icoPath: string;
  stripsDir: string;
}

export function createWindowIcons(src: WindowIconSources): {
  /** The plain app icon (the .ico itself, so Windows picks the exact frame), or null when it cannot be loaded. */
  plain: () => NativeImage | null;
  /** The app icon with the number `text` ('1'..'99'): one ICON_BASE_PX bitmap, scale factor 1. Throws when it cannot be made. */
  badged: (text: string) => NativeImage;
} {
  let plain: NativeImage | null | undefined;
  let base: PremulImage | undefined;
  let strip: NativeImage | undefined;

  const getBase = (): PremulImage => {
    if (!base) {
      const frame = largestFrame(parseIco(readFileSync(src.icoPath)));
      if (!frame) throw new Error('the app icon has no usable frame');
      base = resizePremul(premulFrame(frame), ICON_BASE_PX);
    }
    return base;
  };

  const getCell = (text: string): PremulImage => {
    if (!strip) {
      const s = nativeImage.createFromPath(badgeStripPath(src.stripsDir, ICON_BADGE_PX));
      if (s.isEmpty()) throw new Error(`badge strip ${ICON_BADGE_PX} could not be loaded`);
      strip = s;
    }
    const cell = strip.crop(stripCropRect(ICON_BADGE_PX, text));
    const size = cell.getSize();
    if (cell.isEmpty() || size.width !== ICON_BADGE_PX || size.height !== ICON_BADGE_PX) {
      throw new Error(`badge cell ${text} is empty`);
    }
    return { size: ICON_BADGE_PX, data: cell.toBitmap() }; // Skia bitmaps are premultiplied BGRA
  };

  return {
    plain: () => {
      if (plain === undefined) {
        const img = nativeImage.createFromPath(src.icoPath);
        plain = img.isEmpty() ? null : img;
      }
      return plain;
    },
    badged: (text) => {
      const out = compositeBadge(getBase(), getCell(text));
      return nativeImage.createFromBitmap(out.data, { width: out.size, height: out.size, scaleFactor: 1 });
    },
  };
}
