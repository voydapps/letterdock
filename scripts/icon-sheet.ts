// Contact sheet of the window icon with the unread badge (DESIGN-SPEC 3.15 addendum 2026-10-12).
// Run from the repo root: npx esbuild scripts/icon-sheet.ts --bundle --platform=node --format=cjs --outfile=<tmp>/icon-sheet.cjs
//      node <tmp>/icon-sheet.cjs <out.png>
// Rows: the 96 px composite shrunk to 16/24/32/36/48/64 px (what Windows shows: it only shrinks) and kept at 96,
// then 16/24/32 px enlarged 4x (nearest) to look at the pixels. Dark and light backgrounds, 1/9/26/99 unread, and
// the plain icon as the first column.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { ICON_BASE_PX, compositeBadge, largestFrame, premulFrame, resizePremul, type PremulImage } from '../src/main/iconBadge';
import { parseIco } from '../src/main/trayIcon';
import { ICON_BADGE_PX, stripCropRect } from '../src/main/badgeStrips';

const root = process.cwd(); // run from the repo root
const out = process.argv[2];
if (!out) throw new Error('usage: icon-sheet <out.png>');

const frame = largestFrame(parseIco(readFileSync(join(root, 'build', 'icon.ico'))));
if (!frame) throw new Error('no icon frame');
const base = resizePremul(premulFrame(frame), ICON_BASE_PX);
const strip = PNG.sync.read(readFileSync(join(root, 'build', 'badges', `badge-${ICON_BADGE_PX}.png`)));

function cell(text: string): PremulImage {
  const r = stripCropRect(ICON_BADGE_PX, text);
  const data = Buffer.alloc(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const i = (y * strip.width + r.x + x) * 4;
      const o = (y * r.width + x) * 4;
      const a = strip.data[i + 3];
      data[o] = Math.round((strip.data[i + 2] * a) / 255); // PNG is RGBA, bitmaps are BGRA
      data[o + 1] = Math.round((strip.data[i + 1] * a) / 255);
      data[o + 2] = Math.round((strip.data[i] * a) / 255);
      data[o + 3] = a;
    }
  }
  return { size: r.width, data };
}

const texts = ['', '1', '9', '26', '99'];
const icons = texts.map((t) => (t ? compositeBadge(base, cell(t)) : base));
const BGS = [
  [0x20, 0x20, 0x20],
  [0xf3, 0xf3, 0xf3],
];
const rows: { size: number; zoom: number }[] = [
  { size: 96, zoom: 1 },
  { size: 64, zoom: 1 },
  { size: 48, zoom: 1 },
  { size: 36, zoom: 1 },
  { size: 32, zoom: 1 },
  { size: 24, zoom: 1 },
  { size: 16, zoom: 1 },
  { size: 32, zoom: 4 },
  { size: 24, zoom: 4 },
  { size: 16, zoom: 4 },
];
const PAD = 10;
const bandW = icons.length * (128 + PAD) + PAD;
const rowH = rows.map((r) => r.size * r.zoom + PAD);
const width = bandW * 2;
const height = rowH.reduce((a, b) => a + b, PAD);
const png = new PNG({ width, height });
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
let y0 = PAD;
rows.forEach((row, ri) => {
  for (let band = 0; band < 2; band++) {
    const bg = BGS[band];
    icons.forEach((img, ii) => {
      const small = resizePremul(img, row.size);
      const x0 = band * bandW + PAD + ii * (128 + PAD);
      for (let y = 0; y < row.size * row.zoom; y++) {
        for (let x = 0; x < row.size * row.zoom; x++) {
          const si = (Math.floor(y / row.zoom) * row.size + Math.floor(x / row.zoom)) * 4;
          const a = small.data[si + 3] / 255;
          const o = ((y0 + y) * width + x0 + x) * 4;
          // premultiplied BGRA over the background, written as RGB
          png.data[o] = Math.round(small.data[si + 2] + bg[0] * (1 - a));
          png.data[o + 1] = Math.round(small.data[si + 1] + bg[1] * (1 - a));
          png.data[o + 2] = Math.round(small.data[si] + bg[2] * (1 - a));
        }
      }
    });
  }
  y0 += rowH[ri];
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, PNG.sync.write(png));
console.log(`Wrote ${out}`);
