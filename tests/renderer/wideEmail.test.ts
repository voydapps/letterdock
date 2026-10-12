// @vitest-environment node
// Very wide emails (a statement with fixed 1000 px tables) must be scrollable sideways, not cut off.
// Runs the real app (Vite + the fake demo backend) in Chromium WITH real scrollbars. Skipped without Chromium.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { ViteDevServer } from 'vite';
import { showClippedContent } from '../../src/renderer/src/lib/frameFit';
import { WIDE_LAST_COLUMN, wideStatementHtml } from '../../src/renderer/src/dev/wideStatementHtml';

const root = resolve(__dirname, '..', '..');

describe('wide emails in the reading pane (real Chromium; skipped when it is not installed)', () => {
  let browser: Browser | null = null;
  let server: ViteDevServer | null = null;
  let base = '';
  beforeAll(async () => {
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
      const { createServer } = await import('vite');
      const react = (await import('@vitejs/plugin-react')).default;
      server = await createServer({
        root: join(root, 'src', 'renderer'),
        configFile: false,
        plugins: [react()],
        server: { host: '127.0.0.1', port: 0 },
        logLevel: 'error',
      });
      await server.listen();
      base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    } catch {
      browser = null;
    }
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function open(
    subject: string,
    theme: 'light' | 'dark',
  ): Promise<{ page: Page; close: () => Promise<void> }> {
    const ctx = await browser!.newContext({
      viewport: { width: 1400, height: 800 },
      colorScheme: theme,
      locale: 'en-US',
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/?fake=1&scenario=demo`);
    await page.waitForSelector('.panes');
    await page.getByText(subject).first().click();
    await page.waitForSelector('.mbody iframe');
    await page.waitForTimeout(1200);
    return { page, close: () => ctx.close() };
  }

  for (const theme of ['light', 'dark'] as const) {
    it(`statement (${theme}): the right side can be scrolled to, nothing is cut vertically`, async (ctx) => {
      if (!browser) return ctx.skip();
      const { page, close } = await open('Daily Confirmation', theme);
      try {
        const m = await page.evaluate((last) => {
          const f = document.querySelector<HTMLIFrameElement>('.mbody iframe')!;
          const w = f.parentElement!;
          const d = f.contentDocument!;
          const th = [...d.querySelectorAll('th')].find((t) => t.textContent === last)!;
          return {
            wrap: w.className,
            wrapSW: w.scrollWidth,
            wrapCW: w.clientWidth,
            wrapCH: w.clientHeight,
            frameW: f.getBoundingClientRect().width,
            frameH: f.getBoundingClientRect().height,
            docSH: d.documentElement.scrollHeight,
            docSW: d.documentElement.scrollWidth,
            docCW: d.documentElement.clientWidth,
            lastRight: th.getBoundingClientRect().right,
          };
        }, WIDE_LAST_COLUMN);
        expect(m.wrap).toBe('mscroll');
        expect(m.wrapSW).toBeGreaterThan(m.wrapCW);
        expect(m.frameW).toBeGreaterThan(m.wrapCW);
        expect(m.docSW).toBe(m.docCW); // the frame itself does not scroll: its wrapper does
        expect(m.lastRight).toBeLessThanOrEqual(m.frameW);
        expect(m.frameH).toBeGreaterThanOrEqual(m.docSH);
        expect(m.wrapCH).toBeGreaterThanOrEqual(m.frameH); // the wrapper does not cut the frame

        // Shift+wheel / touchpad swipe over the message and the arrow keys move it; the end shows the last column.
        const box = (await page.locator('.mbody iframe').boundingBox())!;
        await page.mouse.move(box.x + 100, box.y + 100);
        await page.mouse.wheel(200, 0);
        await page.waitForTimeout(250);
        const afterWheel = await page.evaluate(
          () => document.querySelector('.mscroll')!.scrollLeft,
        );
        expect(afterWheel).toBeGreaterThan(0);
        await page.locator('.mbody iframe').focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(150);
        expect(
          await page.evaluate(() => document.querySelector('.mscroll')!.scrollLeft),
        ).toBeGreaterThan(afterWheel);
        await page.mouse.wheel(3000, 0);
        await page.waitForTimeout(500);
        const end = await page.evaluate((last) => {
          const w = document.querySelector('.mscroll') as HTMLElement;
          const f = w.querySelector('iframe')!;
          const th = [...f.contentDocument!.querySelectorAll('th')].find(
            (t) => t.textContent === last,
          )!;
          const wr = w.getBoundingClientRect();
          const tr = th.getBoundingClientRect();
          return {
            reached: w.scrollLeft >= w.scrollWidth - w.clientWidth - 1,
            visible: f.getBoundingClientRect().left + tr.right <= wr.right + 1,
          };
        }, WIDE_LAST_COLUMN);
        expect(end.reached).toBe(true);
        expect(end.visible).toBe(true);
      } finally {
        await close();
      }
    }, 60_000);
  }

  it('a normal newsletter has no sideways scrollbar and keeps width:100%', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, close } = await open('5 small habits', 'light');
    try {
      const m = await page.evaluate(() => {
        const f = document.querySelector<HTMLIFrameElement>('.mbody iframe')!;
        const w = f.parentElement!;
        return {
          frameStyleW: f.style.width,
          sw: w.scrollWidth,
          cw: w.clientWidth,
          h: f.getBoundingClientRect().height,
          wh: w.getBoundingClientRect().height,
        };
      });
      expect(m.frameStyleW).toBe('');
      expect(m.sw).toBe(m.cw);
      expect(m.wh).toBe(m.h); // no scrollbar row added under the message
    } finally {
      await close();
    }
  }, 60_000);

  it('stays scrollable when the window gets narrower, and the last column stays reachable', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, close } = await open('Daily Confirmation', 'light');
    try {
      const before = await page.evaluate(() => document.querySelector('.mscroll')!.clientWidth);
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.waitForTimeout(800);
      const m = await page.evaluate(() => {
        const w = document.querySelector('.mscroll') as HTMLElement;
        w.scrollLeft = 99999;
        return {
          cw: w.clientWidth,
          sw: w.scrollWidth,
          left: w.scrollLeft,
          frameW: w.querySelector('iframe')!.getBoundingClientRect().width,
        };
      });
      expect(m.cw).toBeLessThan(before);
      expect(m.sw).toBe(m.frameW);
      expect(m.left).toBe(m.sw - m.cw);
    } finally {
      await close();
    }
  }, 60_000);

  describe('showClippedContent', () => {
    const run = async (html: string): Promise<{ box: string; pre: string }> => {
      const page = await browser!.newPage({ viewport: { width: 500, height: 400 } });
      try {
        await page.setContent(html);
        await page.evaluate(`(${showClippedContent.toString()})(document)`);
        return await page.evaluate(() => ({
          box: getComputedStyle(document.getElementById('box')!).overflowX,
          pre: getComputedStyle(document.getElementById('pre')!).overflowX,
        }));
      } finally {
        await page.close();
      }
    };
    it('opens a fixed-width box that cuts the table, but not a zero-size preview text box', async (ctx) => {
      if (!browser) return ctx.skip();
      const r = await run(
        '<div id="box" style="width:300px;overflow:hidden"><table width="900"><tr><td nowrap>Deposit/Withdrawal Commission</td></tr></table></div>' +
          '<div id="pre" style="max-height:0;width:0;overflow:hidden">Preview text that must stay hidden for a long time</div>',
      );
      expect(r.box).toBe('visible');
      expect(r.pre).toBe('hidden');
    });
    it('leaves a box alone when nothing is cut', async (ctx) => {
      if (!browser) return ctx.skip();
      const r = await run(
        '<div id="box" style="width:300px;overflow:hidden">short</div><div id="pre" style="overflow:hidden"></div>',
      );
      expect(r.box).toBe('hidden');
    });
    it('leaves a carousel (a wide row with no table) cut, as the sender made it', async (ctx) => {
      if (!browser) return ctx.skip();
      const r = await run(
        '<div id="box" style="width:300px;overflow:hidden"><div style="width:1200px;height:50px">slides</div></div><div id="pre"></div>',
      );
      expect(r.box).toBe('hidden');
    });
    it('opens a table cell with an ellipsis that cuts its text', async (ctx) => {
      if (!browser) return ctx.skip();
      const r = await run(
        '<table style="table-layout:fixed;width:100px"><tr><td id="box" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Deposit/Withdrawal and more text</td></tr></table><div id="pre"></div>',
      );
      expect(r.box).toBe('visible');
    });
  });

  it('the fixture is a statement with fixed 1000 px tables', () => {
    const html = wideStatementHtml();
    expect(html).toContain('width="1000"');
    expect(html).toContain('nowrap');
    expect(wideStatementHtml({ nowrap: false })).not.toContain('nowrap');
  });
});
