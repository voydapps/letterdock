// Builds build/icon.ico and build/icon.png from the SVG masters (DESIGN-SPEC 1.8).
// Every frame is drawn from vector at its own size (pixel-snapped flat design up to 28 px, the master above),
// never resampled from the 256 frame. The tray dot icon is built the same way (scripts/lib/tray-icon.mjs).
// Run with: npm run icons
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { APP_SIZES, APPICO_SIZES, TRAY_SIZES, buildIco, renderTrayPng } from './lib/tray-icon.mjs';

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const master = readFileSync(join(buildDir, 'icon.svg'));
const small = readFileSync(join(buildDir, 'icon-small.svg'));
const SIZES = APP_SIZES;

function render(size) {
  const svg = size <= 24 ? small : master;
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

const ico = await buildIco({ sizes: SIZES });
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


// Tray icon with the unread dot (DESIGN-SPEC 3.15): the plain tray icon is build/icon.ico itself.
writeFileSync(join(buildDir, 'tray-dot.ico'), await buildIco({ dot: true, sizes: TRAY_SIZES }));
console.log(`Wrote build/tray-dot.ico (${TRAY_SIZES.join(', ')})`);

// Logo in the custom title bars (16 CSS px): one pixel-snapped PNG per display scale (1, 1.25, 1.5, 1.75, 2, 2.5, 3),
// picked by the browser through srcset. An SVG scaled by the browser would blur at 125% and 150%.
const appicoDir = join(buildDir, '..', 'src', 'renderer', 'src', 'assets', 'appico');
mkdirSync(appicoDir, { recursive: true });
for (const px of APPICO_SIZES) writeFileSync(join(appicoDir, `appico-${px}.png`), renderTrayPng(px));
console.log(`Wrote src/renderer/src/assets/appico (${APPICO_SIZES.join(', ')} px)`);
