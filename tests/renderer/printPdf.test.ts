// @vitest-environment node
// Printing: a wide statement is scaled to the page and nothing is cut at the right edge (real Chromium; skipped
// when it is not installed). The page is rendered with print media at the width of one printed line.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { buildPrintDocument } from '../../src/main/print/printDocument';
import { wideStatementHtml } from '../../src/renderer/src/dev/wideStatementHtml';

const LINE_PX = 680; // A4 / Letter minus 15 mm margins, in CSS pixels
const input = { subject: 'Daily Confirmation', from: null, to: [], cc: [], date: 0, text: '' };
const URL300 = 'https://example.com/' + 'a'.repeat(300);

describe('print layout (real Chromium)', () => {
  let browser: Browser | null = null;
  beforeAll(async () => {
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch();
    } catch {
      browser = null;
    }
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function render(
    bodyHtml: string,
  ): Promise<{ sw: number; cw: number; pdfBytes: number; th: number }> {
    const page = await browser!.newPage({ viewport: { width: LINE_PX, height: 900 } });
    try {
      await page.emulateMedia({ media: 'print' });
      await page.setContent(buildPrintDocument({ ...input, bodyHtml }));
      const pdf = await page.pdf({
        format: 'A4',
        margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
        printBackground: true,
      });
      const r = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        th: document.querySelector('.mail-body th')?.getBoundingClientRect().height ?? 0,
      }));
      return { ...r, pdfBytes: pdf.length };
    } finally {
      await page.close();
    }
  }

  it('a wide statement fits the printed line', async (ctx) => {
    if (!browser) return ctx.skip();
    const r = await render(wideStatementHtml());
    expect(r.pdfBytes).toBeGreaterThan(1000);
    expect(r.sw).toBeLessThanOrEqual(r.cw);
  });

  it('a wide statement without nowrap cells fits too, with no one-letter columns', async (ctx) => {
    if (!browser) return ctx.skip();
    const r = await render(wideStatementHtml({ nowrap: false }));
    expect(r.sw).toBeLessThanOrEqual(r.cw);
    expect(r.th).toBeLessThan(60); // header cells stay one or two lines
  });

  it('a normal email with a long URL is not scaled and does not overflow', async (ctx) => {
    if (!browser) return ctx.skip();
    const r = await render(
      `<table width="600"><tr><td>Hello</td></tr></table><p>${URL300}</p><table width="100%"><tr><th>Status</th><th>Link</th></tr><tr><td>ok</td><td>${URL300}</td></tr></table>`,
    );
    expect(r.sw).toBeLessThanOrEqual(r.cw);
  });
});
