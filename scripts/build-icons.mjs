// Builds build/icon.ico and build/icon.png from the SVG masters (DESIGN-SPEC 1.8).
// Sizes up to 24px use the flat small design; 32px and up use the master.
// Run with: npm run icons
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const master = readFileSync(join(buildDir, 'icon.svg'));
const small = readFileSync(join(buildDir, 'icon-small.svg'));
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

function render(size) {
  const svg = size <= 24 ? small : master;
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

const ico = await pngToIco(SIZES.map(render));
writeFileSync(join(buildDir, 'icon.ico'), ico);
writeFileSync(join(buildDir, 'icon.png'), render(512));
// Renderer favicon (served from src/renderer/public).
writeFileSync(join(buildDir, '..', 'src', 'renderer', 'public', 'favicon.png'), render(64));
console.log(`Wrote build/icon.ico (${SIZES.join(', ')}) , build/icon.png (512) and the renderer favicon`);

// Icons on the Windows notification buttons (DESIGN-SPEC 3.13.3a): build/toast/*.svg -> build/toast-icons/<name>-<theme>.png.
// 48x48, transparent. "-light" = dark glyph for a light toast, "-dark" = white glyph for a dark toast.
const TOAST_ICONS = ['read', 'archive', 'delete'];
const TOAST_COLORS = { light: '#1f1f1f', dark: '#ffffff' };
mkdirSync(join(buildDir, 'toast-icons'), { recursive: true });
for (const name of TOAST_ICONS) {
  const svg = readFileSync(join(buildDir, 'toast', `${name}.svg`), 'utf8');
  for (const [theme, color] of Object.entries(TOAST_COLORS)) {
    const png = new Resvg(svg.replaceAll('currentColor', color), { fitTo: { mode: 'width', value: 48 } }).render().asPng();
    writeFileSync(join(buildDir, 'toast-icons', `${name}-${theme}.png`), png);
  }
}
console.log('Wrote build/toast-icons (read, archive, delete; light and dark; 48 px)');
