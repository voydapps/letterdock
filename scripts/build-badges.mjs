// Builds the unread-number sprite strips: build/badges/badge-<size>.png (DESIGN-SPEC 3.15).
// Run with: npm run badges   [-- --sheet <path.png>]
//
// One strip per size (16/20/24/28/32/40/48 px). Each strip is a row of 99 square cells, cell n-1 is the
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
// --sheet <path>: also writes a contact sheet made from the finished strips (see writeSheet).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_FILE = join(root, 'build', 'fonts', 'selawkb.ttf');
const FONT_FAMILY = 'Selawik';
const OUT_DIR = join(root, 'build', 'badges');
export const SIZES = [16, 20, 24, 28, 32, 40, 48];
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
const strips = {};
for (const size of SIZES) {
  const png = renderStrip(size);
  writeFileSync(join(OUT_DIR, `badge-${size}.png`), png);
  strips[size] = PNG.sync.read(png);
}
console.log(`Wrote build/badges/badge-<size>.png for ${SIZES.join(', ')} (${COUNT} numbers each)`);

// ------------------------------------------------------------------ contact sheet
const sheetArg = process.argv.indexOf('--sheet');
if (sheetArg !== -1) {
  const out = process.argv[sheetArg + 1];
  if (!out) throw new Error('--sheet needs a path');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, PNG.sync.write(writeSheet()));
  console.log(`Wrote contact sheet ${out}`);
}

/** The cell of number n from a strip, as premultiplied float RGBA in a {w,h,data} image. */
function cellOf(size, n) {
  const s = strips[size];
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * s.width + (n - 1) * size + x) * 4;
      const o = (y * size + x) * 4;
      const a = s.data[i + 3] / 255;
      data[o] = (s.data[i] / 255) * a;
      data[o + 1] = (s.data[i + 1] / 255) * a;
      data[o + 2] = (s.data[i + 2] / 255) * a;
      data[o + 3] = a;
    }
  }
  return { w: size, h: size, data };
}

/** Lanczos3 resize (what Electron does to the overlay before it goes to Windows: see header of unreadBadge.ts). */
function lanczos(img, tw, th) {
  const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  const k = (x) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0);
  const pass = (src, sw, sh, nw, nh, horizontal) => {
    const out = new Float32Array((horizontal ? nw * sh : sw * nh) * 4);
    const scale = (horizontal ? sw : sh) / (horizontal ? nw : nh);
    const fscale = Math.max(1, scale);
    const outLen = horizontal ? nw : nh;
    for (let o = 0; o < outLen; o++) {
      const centre = (o + 0.5) * scale;
      const lo = Math.floor(centre - 3 * fscale);
      const hi = Math.ceil(centre + 3 * fscale);
      const wts = [];
      let sum = 0;
      for (let i = lo; i <= hi; i++) {
        const w = k((i + 0.5 - centre) / fscale);
        wts.push([Math.min(Math.max(i, 0), (horizontal ? sw : sh) - 1), w]);
        sum += w;
      }
      const other = horizontal ? sh : sw;
      for (let t = 0; t < other; t++) {
        for (let c = 0; c < 4; c++) {
          let acc = 0;
          for (const [i, w] of wts) {
            const si = horizontal ? (t * sw + i) * 4 + c : (i * sw + t) * 4 + c;
            acc += src[si] * w;
          }
          const di = horizontal ? (t * nw + o) * 4 + c : (o * sw + t) * 4 + c;
          out[di] = acc / sum;
        }
      }
    }
    return out;
  };
  const h = pass(img.data, img.w, img.h, tw, img.h, true);
  const v = pass(h, tw, img.h, tw, th, false);
  for (let i = 0; i < v.length; i++) v[i] = Math.min(1, Math.max(0, v[i]));
  return { w: tw, h: th, data: v };
}

function writeSheet() {
  const NUMS = [1, 7, 9, 26, 42, 88, 99];
  const BGS = [
    [0x20, 0x20, 0x20],
    [0xf3, 0xf3, 0xf3],
  ];
  const PAD = 8;
  // Rows: every size at 1:1 and 4x (nearest), plus "what Electron sends": each size Lanczos3'd to 16 px.
  const blocks = [];
  for (const size of SIZES) blocks.push({ cells: NUMS.map((n) => cellOf(size, n)), zoom: 1 });
  for (const size of SIZES) blocks.push({ cells: NUMS.map((n) => cellOf(size, n)), zoom: 4 });
  for (const size of SIZES) {
    blocks.push({ cells: NUMS.map((n) => (size === 16 ? cellOf(16, n) : lanczos(cellOf(size, n), 16, 16))), zoom: 1 });
  }
  for (const size of SIZES) {
    blocks.push({ cells: NUMS.map((n) => (size === 16 ? cellOf(16, n) : lanczos(cellOf(size, n), 16, 16))), zoom: 4 });
  }
  const bandW = Math.max(...blocks.map((b) => b.cells.reduce((s, c) => s + c.w * b.zoom + PAD, PAD)));
  const rowH = blocks.map((b) => b.cells[0].h * b.zoom + PAD);
  const gap = 16;
  const height = rowH.reduce((a, b) => a + b, 0) + gap * 3;
  const width = bandW * 2;
  const png = new PNG({ width, height });
  // background bands
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bg = BGS[x < bandW ? 0 : 1];
      const o = (y * width + x) * 4;
      png.data[o] = bg[0];
      png.data[o + 1] = bg[1];
      png.data[o + 2] = bg[2];
      png.data[o + 3] = 255;
    }
  }
  let y0 = 0;
  blocks.forEach((b, bi) => {
    if (bi === SIZES.length * 2 || bi === SIZES.length || bi === SIZES.length * 3) y0 += gap;
    for (let band = 0; band < 2; band++) {
      const bg = BGS[band];
      let x0 = band * bandW + PAD;
      for (const c of b.cells) {
        for (let y = 0; y < c.h * b.zoom; y++) {
          for (let x = 0; x < c.w * b.zoom; x++) {
            const si = (Math.floor(y / b.zoom) * c.w + Math.floor(x / b.zoom)) * 4;
            const a = c.data[si + 3];
            const o = ((y0 + PAD / 2 + y) * width + x0 + x) * 4;
            for (let ch = 0; ch < 3; ch++) png.data[o + ch] = Math.round((c.data[si + ch] + (bg[ch] / 255) * (1 - a)) * 255);
          }
        }
        x0 += c.w * b.zoom + PAD;
      }
    }
    y0 += rowH[bi];
  });
  return png;
}
