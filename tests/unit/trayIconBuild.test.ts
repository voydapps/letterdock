// The icon files are built per size (DESIGN-SPEC 3.15): every frame Windows can ask for at 100-250 % is there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseIco } from '../../src/main/trayIcon';
// @ts-expect-error plain .mjs build helper
import { APP_SIZES, TRAY_SIZES, APPICO_SIZES, buildIco, gridSvg } from '../../scripts/lib/tray-icon.mjs';

const WANTED = [16, 20, 24, 28, 32, 36, 40, 48, 64, 256];
const sizesOf = (buf: Buffer) => [...parseIco(buf).keys()].sort((a, b) => a - b);

describe('icon build output', () => {
  it('the build script asks for every Windows scale size', () => {
    expect([...TRAY_SIZES]).toEqual(WANTED);
    expect([...APP_SIZES]).toEqual(WANTED);
    expect([...APPICO_SIZES]).toEqual([16, 20, 24, 28, 32, 40, 48]);
  });

  it('builds an .ico with one frame per size, with and without the dot', async () => {
    for (const dot of [false, true]) {
      const ico = (await buildIco({ dot, sizes: [16, 20, 24, 32] })) as Buffer;
      expect(sizesOf(ico)).toEqual([16, 20, 24, 32]);
    }
  });

  it('the dot changes the bottom-right of every frame and nothing at the top-left', async () => {
    const plain = parseIco((await buildIco({ sizes: [16, 24] })) as Buffer);
    const dotted = parseIco((await buildIco({ dot: true, sizes: [16, 24] })) as Buffer);
    for (const s of [16, 24]) {
      const p = plain.get(s)!.bgra;
      const d = dotted.get(s)!.bgra;
      expect(d.subarray(0, 4)).toEqual(p.subarray(0, 4));
      const o = ((s - 5) * s + (s - 5)) * 4;
      expect([d[o], d[o + 1], d[o + 2]]).toEqual([0x1c, 0x2b, 0xc4]); // BADGE_RED (BGR)
    }
  });

  it('small frames use whole-pixel edges (no fractions in the rectangles)', () => {
    for (const s of [16, 20, 24, 28]) {
      const svg = gridSvg(s) as string;
      for (const m of svg.matchAll(/<rect ([^>]*)>/g)) {
        for (const a of (' ' + m[1]).matchAll(/(?:^| )(?:x|y|width|height)="([d.]+)"/g)) expect(Number(a[1]) % 1).toBe(0);
      }
    }
  });

  it('the committed icon.ico and tray-dot.ico have every frame', () => {
    for (const f of ['icon.ico', 'tray-dot.ico']) {
      expect(sizesOf(readFileSync(join(__dirname, '..', '..', 'build', f)))).toEqual(WANTED);
    }
  });
});
