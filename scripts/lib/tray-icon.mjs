// Builds build/icon.ico and build/tray-dot.ico (DESIGN-SPEC 3.15).
// Why separate files: Electron's Tray on Windows asks for the icon at SM_CXSMICON (16/20/24/28/32... px
// depending on the display scale). A nativeImage made with createFromPath(<.ico>) keeps the file, so Windows
// loads the exact frame. A bitmap-built image only gives Windows its 1x bitmap, which is then stretched.
// Every frame is drawn from vector at its own size with whole-pixel edges (never resampled from a master).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

/** 16/20/24/28/32/36/40 px are what Windows asks for at 100/125/150/175/200/225/250 % (SM_CXSMICON). */
export const TRAY_SIZES = [16, 20, 24, 28, 32, 36, 40, 48, 64, 256];
export const APP_SIZES = TRAY_SIZES;
/** Title-bar logo: 16 CSS px at 100/125/150/175/200/250/300 %. */
export const APPICO_SIZES = [16, 20, 24, 28, 32, 40, 48];
/** Up to this size the flat small design is drawn on a pixel grid; above it the master is scaled. */
const GRID_MAX = 28;
const RED = '#C42B1C';
const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'build');
const masterSvg = readFileSync(join(buildDir, 'icon.svg'), 'utf8');

const even = (n) => Math.round(n / 2) * 2;
const half = (n) => Math.round(n * 2) / 2;

/** The flat small icon for one size, every edge on a whole pixel (the 256 design snapped to a grid). */
export function gridSvg(S) {
  const tileR = Math.round(S * 0.2);
  const ew = even(S * 0.625 - (S >= 24 ? 1 : 0)); // envelope width
  const eh = Math.round(S * 0.4375);
  const ex = (S - ew) / 2;
  const ey = Math.round(S * 0.375);
  const lw = even(S * 0.5);
  const lh = Math.max(3, Math.round(S * 0.25));
  const lx = (S - lw) / 2;
  const ly = Math.round(S * 0.1875);
  const er = Math.max(1, Math.round(S * 0.075)); // envelope corner radius
  const sw = S >= 20 ? 2 : 1.5; // chevron stroke
  const x1 = ex + ew * 0.2;
  const x2 = S / 2;
  const x3 = ex + ew * 0.8;
  const y1 = half(ey + eh * 0.3);
  const y2 = half(ey + eh * 0.66);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">` +
    `<rect x="0" y="0" width="${S}" height="${S}" rx="${tileR}" fill="#0F6CBD"/>` +
    `<rect x="${lx}" y="${ly}" width="${lw}" height="${lh + 2}" rx="${er}" fill="#FFFFFF" fill-opacity="0.6"/>` +
    `<rect x="${ex}" y="${ey}" width="${ew}" height="${eh}" rx="${er}" fill="#FFFFFF"/>` +
    `<path d="M${x1} ${y1} L${x2} ${y2} L${x3} ${y1}" fill="none" stroke="#0F6CBD" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

/** Same spec as src/main/trayIcon.ts withDot: diameter 40% of the size, white ring +1 px at 90%, bottom-right. */
function dotMarkup(S, k) {
  const rDot = Math.round(S * 0.4) / 2;
  const rRing = rDot + 1;
  const c = S - rRing;
  return (
    `<circle cx="${c * k}" cy="${c * k}" r="${rRing * k}" fill="#FFFFFF" fill-opacity="0.9"/>` +
    `<circle cx="${c * k}" cy="${c * k}" r="${rDot * k}" fill="${RED}"/>`
  );
}

export function renderTrayPng(S, { dot = false } = {}) {
  let svg = S <= GRID_MAX ? gridSvg(S) : masterSvg;
  const k = S <= GRID_MAX ? 1 : 256 / S;
  if (dot) svg = svg.replace('</svg>', `${dotMarkup(S, k)}</svg>`);
  return new Resvg(svg, { fitTo: { mode: 'width', value: S } }).render().asPng();
}

export function buildIco({ dot = false, sizes = TRAY_SIZES } = {}) {
  return pngToIco(sizes.map((s) => renderTrayPng(s, { dot })));
}
