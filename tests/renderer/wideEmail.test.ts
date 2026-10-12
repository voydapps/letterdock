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
    height = 800,
  ): Promise<{ page: Page; close: () => Promise<void> }> {
    const ctx = await browser!.newContext({
      viewport: { width: 1400, height },
      colorScheme: theme,
      locale: 'en-US',
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/?fake=1&scenario=demo`);
    await page.waitForSelector('.panes');
    await page.getByText(subject).first().click();
    await page.waitForSelector(subject === 'Weekend plans' ? '.cexp.on' : '.mbody iframe');
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
        expect(m.wrap).toBe('mscroll wide');
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
      expect(await page.evaluate(() => document.querySelector<HTMLElement>('.mbar')!.hidden)).toBe(
        true,
      );
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

  it('a pinned sideways scrollbar is on screen while the top of a long wide message is visible', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, close } = await open('Daily Confirmation', 'light', 450);
    try {
      await page.evaluate(() => {
        document.querySelector('.rpane, .rin')?.parentElement?.scrollTo?.(0, 0);
      });
      const m = await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('.mbar')!;
        const wrap = document.querySelector<HTMLElement>('.mscroll')!;
        const br = bar.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        return {
          hidden: bar.hidden,
          barBottom: br.bottom,
          barTop: br.top,
          vh: window.innerHeight,
          wrapBottom: wr.bottom,
          wide: wrap.classList.contains('wide'),
          fade: getComputedStyle(document.querySelector('.mfade')!).opacity,
          barSW: bar.scrollWidth,
          barCW: bar.clientWidth,
        };
      });
      expect(m.hidden).toBe(false);
      expect(m.wide).toBe(true);
      expect(m.wrapBottom).toBeGreaterThan(m.vh); // the end of the message (where its own bar would be) is below the screen
      expect(m.barBottom).toBeLessThanOrEqual(m.vh + 1); // the pinned bar is on screen
      expect(m.barTop).toBeGreaterThan(0);
      expect(m.barSW).toBeGreaterThan(m.barCW);
      expect(m.fade).toBe('1'); // more to the right
      // Scrolling the pinned bar moves the message, and the other way round.
      const box = (await page.locator('.mbar').boundingBox())!;
      await page.mouse.move(box.x + 100, box.y + 5);
      await page.mouse.wheel(250, 0);
      await page.waitForTimeout(300);
      const left = await page.evaluate(() => ({
        wrap: document.querySelector('.mscroll')!.scrollLeft,
        bar: document.querySelector('.mbar')!.scrollLeft,
      }));
      expect(left.wrap).toBeGreaterThan(0);
      expect(left.bar).toBe(left.wrap);
      await page.evaluate(() => {
        document.querySelector('.mbar')!.scrollLeft = 99999;
      });
      await page.waitForTimeout(300);
      const end = await page.evaluate(() => ({
        wrap: document.querySelector('.mscroll')!.scrollLeft,
        max:
          document.querySelector('.mscroll')!.scrollWidth -
          document.querySelector('.mscroll')!.clientWidth,
        fade: getComputedStyle(document.querySelector('.mfade')!).opacity,
      }));
      expect(end.wrap).toBe(end.max);
      expect(end.fade).toBe('0'); // nothing more to the right
    } finally {
      await close();
    }
  }, 60_000);

  it('the frame returns to width:100% with no bar when the pane gets wider than the statement', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, close } = await open('Daily Confirmation', 'light');
    try {
      await page.addStyleTag({ content: '.rin{max-width:none!important}' });
      await page.setViewportSize({ width: 2600, height: 800 });
      await page.waitForTimeout(1000);
      const m = await page.evaluate(() => {
        const f = document.querySelector<HTMLIFrameElement>('.mbody iframe')!;
        const w = f.parentElement!;
        return {
          fw: f.style.width,
          sw: w.scrollWidth,
          cw: w.clientWidth,
          wide: w.classList.contains('wide'),
          barHidden: document.querySelector<HTMLElement>('.mbar')!.hidden,
        };
      });
      expect(m.fw).toBe('');
      expect(m.sw).toBe(m.cw);
      expect(m.wide).toBe(false);
      expect(m.barHidden).toBe(true);
      // And back to narrow: it scrolls again.
      await page.setViewportSize({ width: 1400, height: 800 });
      await page.addStyleTag({ content: '.rin{max-width:760px!important}' });
      await page.waitForTimeout(1000);
      expect(
        await page.evaluate(() => document.querySelector('.mscroll')!.classList.contains('wide')),
      ).toBe(true);
    } finally {
      await close();
    }
  }, 60_000);

  it('the keyboard focus ring is on the wrapper, so it is fully visible on a wide frame', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, close } = await open('Daily Confirmation', 'light');
    try {
      let found = false;
      await page
        .locator('.mbody')
        .first()
        .evaluate((el) => (el.previousElementSibling as HTMLElement | null)?.focus?.());
      for (let i = 0; i < 40 && !found; i++) {
        await page.keyboard.press('Tab');
        found = await page.evaluate(() => document.activeElement?.tagName === 'IFRAME');
      }
      expect(found).toBe(true);
      const o = await page.evaluate(() => {
        const w = document.querySelector('.mscroll') as HTMLElement;
        const f = w.querySelector('iframe')!;
        return {
          wrapOutline: getComputedStyle(w).outlineStyle,
          frameOutline: getComputedStyle(f).outlineStyle,
        };
      });
      expect(o.wrapOutline).toBe('solid');
      expect(o.frameOutline).toBe('none');
    } finally {
      await close();
    }
  }, 60_000);

  it('an open conversation card does not clip, so the pinned bar of a wide message can stick (and still clips while opening)', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, close } = await open('Weekend plans', 'light');
    try {
      await page.waitForSelector('.cexp.on > .cexp-in');
      await page.waitForTimeout(500);
      const ov = await page.evaluate(
        () => getComputedStyle(document.querySelector('.cexp.on > .cexp-in')!).overflowX,
      );
      expect(ov).toBe('visible');
      const closed = await page.evaluate(() => {
        const el = document.querySelector('.cexp:not(.on) > .cexp-in');
        return el ? getComputedStyle(el).overflowX : 'hidden';
      });
      expect(closed).toBe('hidden');
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
