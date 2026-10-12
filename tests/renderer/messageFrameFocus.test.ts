// The message frame / body is focused by code when a viewer window opens. That must not draw a ring
// (a white frame in the dark theme); keyboard focus keeps the app ring.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/renderer/src/styles/app.css', 'utf8');

describe('message frame focus ring', () => {
  it('has no ring for focus by code, on the frame or the body', () => {
    expect(css).toMatch(/\.mbody\[data-autofocus\]:focus-visible\s*\{[^}]*box-shadow:\s*none/);
    expect(css).toMatch(/\.mbody iframe:focus-visible\s*\{[^}]*outline:\s*none[^}]*box-shadow:\s*none/);
  });
  it('draws the app-coloured ring on the scroll wrapper (fully visible on a wide frame), set for keyboard focus only', () => {
    expect(css).toMatch(/\.mscroll\[data-kb='1'\]\s*\{[^}]*outline:\s*2px solid var\(--ring-o\)/);
    const pane = readFileSync('src/renderer/src/features/reading/ReadingPane.tsx', 'utf8');
    expect(pane).toContain("hasAttribute('data-autofocus')"); // code focus (viewer window) shows no ring
  });
  for (const f of ['ViewerApp', 'EmlViewerApp']) {
    it(`${f} marks its code focus and clears the mark on blur`, () => {
      const src = readFileSync(`src/renderer/src/features/viewer/${f}.tsx`, 'utf8');
      expect(src).toContain("setAttribute('data-autofocus', '')");
      expect(src).toContain("removeAttribute('data-autofocus')");
    });
  }
});
