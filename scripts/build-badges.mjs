// Builds the unread-number sprite strips: build/badges/badge-<size>.png (DESIGN-SPEC 3.15).
// Run with: npm run badges      (contact sheet of the finished icon: scripts/icon-sheet.ts, see its header)
//
// One strip per size (54 px: the badge inside the 96 px window icon). Each strip is a row of 99 square cells, cell n-1 is the
// number n (1..99). Every size is drawn from vector on its own, never scaled from a master.
// A cell is a red circle (#C42B1C) filling the square with white, anti-aliased digits.
//
// Font: Selawik Bold (Microsoft, SIL OFL 1.1), release 1.01, https://github.com/microsoft/Selawik/releases
// (Selawik_Release.zip, file selawkb.ttf). Licence: build/fonts/Selawik-OFL.txt. It is only used here, at
// build time. It is not shipped in the app (the strips are plain PNGs). Segoe UI is not used.
//
// Sizing: one digit has a cap height of about 62% of the diameter, two digits about 50% (rounded to whole
// pixels so flat tops and bottoms land on pixel rows). Two digits are tracked by -2% of the font size.
// Centring uses the measured ink box: the digits sit on one baseline with the cap-height band centred in
// the circle, and each number is moved sideways so its ink (not its em box) is centred.
//
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_FILE = join(root, 'build', 'fonts', 'selawkb.ttf');
const FONT_FAMILY = 'Selawik';
const OUT_DIR = join(root, 'build', 'badges');
// 54 = the badge diameter in the 96 px window icon (56%, src/main/iconBadge.ts; a test keeps them equal).
export const SIZES = [54];
const COUNT = 99;
const RED = '#C42B1C';
const SINGLE_RATIO = 0.62;
const PAIR_RATIO = 0.5;
const TRACKING = -0.02; // of the font size, between the two digits

const fontOpts = {
  loadSystemFonts: false,
  fontFiles: [FONT_FILE],
  defaultFontFamily: FONT_FAMILY,
};

const textTag = (txt, x, y, fs, extra = '') =>
  `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-weight="700" font-size="${fs}" ` +
  `letter-spacing="${(TRACKING * fs).toFixed(4)}" fill="#fff" ${extra}>${txt}</text>`;

/** Ink box of a text (user units) when drawn at origin (0,0) with the given font size. Text becomes paths in resvg, so this is exact. */
function inkBox(txt, fs) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000" viewBox="-500 -500 2000 1000">${textTag(txt, 0, 0, fs)}</svg>`;
  const b = new Resvg(svg, { font: fontOpts }).getBBox();
  if (!b) throw new Error(`no bounding box for "${txt}": font not loaded?`);
  return b;
}

// Sanity: "1" must be narrower than "0", or the box is an em box and not the ink.
{
  const one = inkBox('1', 100);
  const zero = inkBox('0', 100);
  if (!(one.width < zero.width)) throw new Error('bbox looks like an em box, not ink');
}

/** Font size so the flat cap height (the height of "1": flat top, sits on the baseline) is `capPx`. */
function fontSizeForCap(capPx) {
  return (capPx / inkBox('1', 100).height) * 100;
}

/** One cell as SVG: circle + number, in a size x size box whose left edge is at x0. */
function cellSvg(size, n, x0) {
  const txt = String(n);
  const pair = txt.length === 2;
  const cap = Math.round(size * (pair ? PAIR_RATIO : SINGLE_RATIO));
  const fs = fontSizeForCap(cap);
  // Baseline on a whole pixel row; the cap band (cap tall) is centred, so the top is a whole row too.
  const baseline = Math.round(size / 2 + cap / 2);
  const b = inkBox(txt, fs);
  const x = x0 + size / 2 - (b.x + b.width / 2);
  return (
    `<circle cx="${x0 + size / 2}" cy="${size / 2}" r="${size / 2}" fill="${RED}"/>` +
    textTag(txt, x.toFixed(4), baseline, fs.toFixed(4))
  );
}

function stripSvg(size) {
  let body = '';
  for (let n = 1; n <= COUNT; n++) body += cellSvg(size, n, (n - 1) * size);
  const w = size * COUNT;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${size}" viewBox="0 0 ${w} ${size}">${body}</svg>`;
}

function renderStrip(size) {
  const r = new Resvg(stripSvg(size), { font: fontOpts, fitTo: { mode: 'original' } }).render();
  if (r.width !== size * COUNT || r.height !== size) throw new Error(`strip ${size}: unexpected ${r.width}x${r.height}`);
  return r.asPng();
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = renderStrip(size);
  writeFileSync(join(OUT_DIR, `badge-${size}.png`), png);
}
console.log(`Wrote build/badges/badge-<size>.png for ${SIZES.join(', ')} (${COUNT} numbers each)`);
