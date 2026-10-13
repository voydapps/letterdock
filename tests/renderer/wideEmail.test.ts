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
    width = 1400,
    query = '',
    scenario = '',
  ): Promise<{ page: Page; close: () => Promise<void> }> {
    const ctx = await browser!.newContext({
      viewport: { width, height },
      colorScheme: theme,
      locale: 'en-US',
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/?fake=1&scenario=demo${query}`);
    await page.waitForSelector('.panes');
    if (scenario) {
      await page.evaluate((n) => (window as unknown as { __fakeScenario: (x: string) => void }).__fakeScenario(n), scenario);
      await page.waitForTimeout(800);
    }
    await page.getByText(subject).first().click();
    await page.waitForSelector(subject === 'Weekend plans' ? '.cexp.on' : '.mbody iframe, .cvirt .ccard.open');
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

  // Pictures go to SHOTS_DIR when it is set (a one-off look, not part of the normal run).
  const shot = async (page: Page, name: string): Promise<void> => {
    if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, name) });
  };
  const state = (page: Page) =>
    page.evaluate((last) => {
      const f = document.querySelector<HTMLIFrameElement>('.mbody iframe')!;
      const w = f.parentElement!;
      const g = document.querySelector<HTMLElement>('.rin')!;
      const rbx = document.querySelector('.rbody') as HTMLElement;
      const cs = getComputedStyle(rbx);
      const contentL = rbx.getBoundingClientRect().left + rbx.clientLeft + parseFloat(cs.paddingLeft);
      const contentR = rbx.getBoundingClientRect().left + rbx.clientLeft + rbx.clientWidth - parseFloat(cs.paddingRight);
      const th = [...f.contentDocument!.querySelectorAll('th')].find((t) => t.textContent === last)!;
      return {
        frameStyleW: f.style.width,
        wrapClass: w.className,
        sw: w.scrollWidth,
        cw: w.clientWidth,
        grown: g.dataset.grown ?? '',
        lm: g.getBoundingClientRect().left - contentL,
        rm: contentR - g.getBoundingClientRect().right,
        headL: document.querySelector('.rsub')!.getBoundingClientRect().left,
        bodyL: w.getBoundingClientRect().left,
        rinW: document.querySelector('.rin')!.getBoundingClientRect().width,
        rinL: document.querySelector('.rin')!.getBoundingClientRect().left,
        subW: document.querySelector('.rsub')!.getBoundingClientRect().width,
        barHidden: document.querySelector<HTMLElement>('.mbar')!.hidden,
        fade: getComputedStyle(document.querySelector('.mfade')!).opacity,
        lastRight: f.getBoundingClientRect().left + th.getBoundingClientRect().right,
        wrapRight: w.getBoundingClientRect().right,
      };
    }, WIDE_LAST_COLUMN);

  for (const theme of ['light', 'dark'] as const) {
    it(`a wide window shows the whole statement without sideways scrolling (${theme})`, async (ctx) => {
      if (!browser) return ctx.skip();
      const { page, close } = await open('Daily Confirmation', theme, 800, 1900);
      try {
        const m = await state(page);
        expect(m.grown).toBe('1');
        expect(m.rinW).toBeGreaterThan(760); // the column (header and body together) grew
        expect(m.subW).toBeGreaterThan(760);
        expect(Math.abs(m.lm - m.rm)).toBeLessThanOrEqual(1); // still centred: equal margins
        expect(m.headL).toBeCloseTo(m.bodyL, 0); // header and body share the left edge
        expect(m.wrapClass).toBe('mscroll'); // no sideways scrolling
        expect(m.sw).toBeLessThanOrEqual(m.cw);
        expect(m.frameStyleW).toBe('');
        expect(m.barHidden).toBe(true);
        expect(m.fade).toBe('0');
        expect(m.lastRight).toBeLessThanOrEqual(m.wrapRight); // the last column is on screen
        // It is stable: nothing changes while we wait (no loop between growing and measuring).
        await page.waitForTimeout(600);
        expect((await state(page)).rinW).toBe(m.rinW);
        // The date and the "Show original colors" button sit at the right edge of the widened column.
        const edges = await page.evaluate(() => {
          const col = document.querySelector('.rin')!.getBoundingClientRect();
          const btn = document.querySelector('.mtoggle button')?.getBoundingClientRect();
          const body = document.querySelector('.mscroll')!.getBoundingClientRect();
          return { colRight: col.right, btnRight: btn?.right ?? null, bodyRight: body.right };
        });
        expect(edges.bodyRight).toBeLessThanOrEqual(edges.colRight + 1);
        if (theme === 'dark') {
          expect(edges.btnRight).not.toBeNull();
          expect(edges.btnRight!).toBeCloseTo(edges.colRight, 0);
        }
        await shot(page, theme === 'light' ? 'wide-fit-1900.png' : 'wide-fit-1900-dark.png');
      } finally {
        await close();
      }
    }, 60_000);
  }

  it('a narrow window still scrolls sideways, and a normal email keeps its column in both', async (ctx) => {
    if (!browser) return ctx.skip();
    const narrow = await open('Daily Confirmation', 'light', 800, 1400);
    try {
      const m = await state(narrow.page);
      expect(m.grown).toBe('');
      expect(m.wrapClass).toBe('mscroll wide');
      expect(m.barHidden).toBe(false);
      expect(m.fade).toBe('1');
      expect(Math.abs(m.lm - m.rm)).toBeLessThanOrEqual(1);
      expect(m.headL).toBeCloseTo(m.bodyL, 0);
      await shot(narrow.page, 'wide-narrow.png');
    } finally {
      await narrow.close();
    }
    for (const width of [1400, 1900]) {
      const { page, close } = await open('5 small habits', 'light', 800, width);
      try {
        const m = await page.evaluate(() => ({
          rin: document.querySelector('.rin')!.getBoundingClientRect().width,
          lm: (() => {
            const rb = document.querySelector('.rbody') as HTMLElement;
            return document.querySelector('.rin')!.getBoundingClientRect().left - (rb.getBoundingClientRect().left + rb.clientLeft + parseFloat(getComputedStyle(rb).paddingLeft));
          })(),
          rm: (() => {
            const rb = document.querySelector('.rbody') as HTMLElement;
            return rb.getBoundingClientRect().left + rb.clientLeft + rb.clientWidth - parseFloat(getComputedStyle(rb).paddingRight) - document.querySelector('.rin')!.getBoundingClientRect().right;
          })(),
          sub: document.querySelector('.rsub')!.getBoundingClientRect().left,
          body: document.querySelector('.mscroll')!.getBoundingClientRect().left,
          grown: document.querySelector<HTMLElement>('.rin')!.dataset.grown ?? '',
          style: document.querySelector<HTMLElement>('.rin')!.getAttribute('style') ?? '',
        }));
        expect(m.grown).toBe('');
        expect(m.style).toBe('');
        expect(m.rin).toBeLessThanOrEqual(760);
        expect(Math.abs(m.lm - m.rm)).toBeLessThanOrEqual(1); // centred: equal margins
        expect(m.sub).toBeCloseTo(m.body, 0);
        if (width === 1900) {
          expect(m.rin).toBe(760);
          await shot(page, 'normal-1900.png');
        }
      } finally {
        await close();
      }
    }
  }, 90_000);

  it('follows the window size: grows when it gets wider, scrolls again when narrower', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, close } = await open('Daily Confirmation', 'light', 800, 1400);
    try {
      expect((await state(page)).wrapClass).toBe('mscroll wide');
      await page.setViewportSize({ width: 1900, height: 800 });
      await page.waitForTimeout(900);
      const wide = await state(page);
      expect(wide.wrapClass).toBe('mscroll');
      expect(wide.grown).toBe('1');
      await page.setViewportSize({ width: 1400, height: 800 });
      await page.waitForTimeout(900);
      const back = await state(page);
      expect(back.wrapClass).toBe('mscroll wide');
      expect(back.grown).toBe('');
      expect(Math.abs(back.lm - back.rm)).toBeLessThanOrEqual(1);
      // In between: always centred, header and body aligned.
      await page.setViewportSize({ width: 1600, height: 800 });
      await page.waitForTimeout(900);
      const mid = await state(page);
      expect(mid.lm).toBeGreaterThanOrEqual(-1);
      expect(Math.abs(mid.lm - mid.rm)).toBeLessThanOrEqual(1);
      expect(mid.headL).toBeCloseTo(mid.bodyL, 0);
    } finally {
      await close();
    }
  }, 60_000);

  it('the message window uses the full window width for a wide email', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, close } = await open('Daily Confirmation', 'light', 800, 1900);
    try {
      const id = await page.evaluate(async () => {
        const l = await (window as unknown as { api: { invoke: (c: string, a: unknown) => Promise<{ items: { id: string; subject: string }[] }> } }).api.invoke('messages.list', { scope: { kind: 'unifiedInbox' }, cursor: null, limit: 100 });
        return l.items.find((m) => m.subject.startsWith('Daily Confirmation'))!.id;
      });
      const w = await page.context().newPage();
      await w.goto(`${base}/viewer.html?fake=1&scenario=demo#msg=${id}`);
      await w.waitForSelector('.mbody iframe');
      await w.waitForTimeout(1500);
      const m = await w.evaluate(() => {
        const g = document.querySelector<HTMLElement>('.rin')!;
        const wrap = document.querySelector<HTMLElement>('.mscroll')!;
        return {
          grown: g.dataset.grown ?? '',
          cls: wrap.className,
          sw: wrap.scrollWidth,
          cw: wrap.clientWidth,
          lm: g.getBoundingClientRect().left,
          rm: window.innerWidth - g.getBoundingClientRect().right,
          head: document.querySelector('.rsub')!.getBoundingClientRect().left,
          body: wrap.getBoundingClientRect().left,
        };
      });
      expect(m.grown).toBe('1');
      expect(m.cls).toBe('mscroll');
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      expect(m.head).toBeCloseTo(m.body, 0);
      expect(Math.abs(m.lm - m.rm)).toBeLessThanOrEqual(20); // centred (the window's own scrollbar is on the right)
      await w.close();
    } finally {
      await close();
    }
  }, 60_000);

  it('a conversation of over 50 messages (virtual list) grows the wide card and keeps the list in order', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, close } = await open('Release checklist', 'light', 800, 1900, '', 'longThread');
    try {
      await page.waitForSelector('.cvirt .ccard.open .mbody iframe');
      await page.waitForTimeout(1500);
      const layout = () =>
        page.evaluate(() => {
          const items = [...document.querySelectorAll<HTMLElement>('.cvitem')].map((el) => {
            const r = el.getBoundingClientRect();
            const card = el.querySelector<HTMLElement>('.ccard')!;
            return { top: r.top, bottom: r.bottom, h: r.height, cardH: card.getBoundingClientRect().height, grown: document.querySelector<HTMLElement>('.rin')!.dataset.grown ?? '', cardRight: card.getBoundingClientRect().right };
          });
          const rb = document.querySelector('.rbody') as HTMLElement;
          const wrap = [...document.querySelectorAll<HTMLElement>('.cvirt .ccard.open .mscroll')].pop();
          return { items, rbRight: rb.getBoundingClientRect().right, rbSW: rb.scrollWidth, rbCW: rb.clientWidth, wrapClass: wrap?.className ?? '', virtH: document.querySelector<HTMLElement>('.cvirt')!.getBoundingClientRect().height };
        });
      const check = (l: Awaited<ReturnType<typeof layout>>) => {
        expect(l.items.length).toBeGreaterThan(0);
        for (let i = 1; i < l.items.length; i++) expect(l.items[i]!.top).toBeGreaterThanOrEqual(l.items[i - 1]!.bottom - 1); // no overlap
        for (const it of l.items) {
          expect(it.h).toBeGreaterThanOrEqual(it.cardH); // the measured row holds its card
          expect(it.cardRight).toBeLessThanOrEqual(l.rbRight + 1);
        }
        expect(l.rbSW).toBeLessThanOrEqual(l.rbCW + 1); // the pane itself does not scroll sideways
      };
      const l1 = await layout();
      check(l1);
      expect(l1.items.some((x) => x.grown === '1')).toBe(true);
      expect(l1.wrapClass).toBe('mscroll'); // fits: no sideways scroll
      // Scroll up through the list (cards come and go), then open a wide message in the middle.
      await page.evaluate(() => { const rb = document.querySelector('.rbody')!; rb.scrollTop = rb.scrollHeight / 2; });
      await page.waitForTimeout(600);
      check(await layout());
      await page.evaluate(() => { const rb = document.querySelector('.rbody')!; rb.scrollTop = 0; });
      await page.waitForTimeout(600);
      check(await layout());
      // Narrow window: the same list scrolls the wide card sideways and stays in order.
      await page.setViewportSize({ width: 1400, height: 800 });
      await page.evaluate(() => { const rb = document.querySelector('.rbody')!; rb.scrollTop = rb.scrollHeight; });
      await page.waitForTimeout(1000);
      const l2 = await layout();
      check(l2);
      expect(l2.wrapClass).toBe('mscroll wide');
    } finally {
      await close();
    }
  }, 90_000);

  it('a conversation with a wide message: the column widens (centred) and all cards share it', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, close } = await open('Weekend plans', 'light', 800, 1900, '&widecard=1');
    try {
      await page.waitForSelector('.ccard.open .mbody iframe');
      await page.waitForTimeout(1200);
      const m = await page.evaluate(() => {
        const cards = [...document.querySelectorAll<HTMLElement>('.ccard')].map((c) => ({
          w: c.getBoundingClientRect().width,
          left: c.getBoundingClientRect().left,
          grown: document.querySelector<HTMLElement>('.rin')!.dataset.grown ?? '',
        }));
        const wrap = document.querySelector<HTMLElement>('.ccard.open .mscroll')!;
        return { cards, wrapClass: wrap.className, sw: wrap.scrollWidth, cw: wrap.clientWidth };
      });
      // The wide message widens the whole column: all cards are wider than 760 and share the same edges (centred).
      expect(m.cards.length).toBeGreaterThan(1);
      for (const c of m.cards) {
        expect(c.grown).toBe('1');
        expect(c.w).toBeGreaterThan(760);
        expect(c.left).toBeCloseTo(m.cards[0]!.left, 0);
        expect(c.w).toBeCloseTo(m.cards[0]!.w, 0);
      }
      expect(m.wrapClass).toBe('mscroll');
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      await shot(page, 'wide-card-1900.png');
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
