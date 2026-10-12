// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { buildSrcdoc, sanitizeEmailHtml } from '../../src/renderer/src/lib/sanitize';

const URL300 = 'https://example.com/' + 'a'.repeat(300);

// The table shape of a GitHub notification: a short "Status" column next to wide ones.
const STATUS_TABLE =
  '<table style="width:100%" cellpadding="4"><tr><th align="left">Status</th><th align="left">Job</th><th align="left">Run</th></tr>' +
  '<tr><td>Failed</td><td>build installer windows x64 with a long descriptive title that wraps</td>' +
  `<td><a href="https://example.com/r">${'https://github.com/org/repo/actions/runs/123456789/job/987654321'}</a></td></tr></table>`;
const CELL_URL = `<table style="width:100%"><tr><th>Status</th><th>Link</th></tr><tr><td>ok</td><td>${URL300}</td></tr></table>`;

const frame = (html: string): string => buildSrcdoc(sanitizeEmailHtml(html, {}).blocked, false);

describe('base CSS', () => {
  it('never uses overflow-wrap:anywhere (it squeezes table columns to one letter)', () => {
    const doc = buildSrcdoc('<p>x</p>', false);
    expect(doc).not.toMatch(/overflow-wrap:\s*anywhere|word-break:\s*(break-all|break-word)/);
    expect(doc).toContain('overflow-wrap:break-word');
  });
});

describe('softBreakCells (via sanitizeEmailHtml)', () => {
  const out = sanitizeEmailHtml(`<p>${URL300}</p>${CELL_URL}<pre><code></code></pre>`, {}).blocked;
  const root = new DOMParser().parseFromString(`<body>${out}</body>`, 'text/html').body;

  it('puts break points into a long unbroken run inside a table cell', () => {
    const td = root.querySelectorAll('td')[1]!;
    expect(td.querySelectorAll('wbr').length).toBeGreaterThan(10);
  });
  it('does not change the text, so copy and paste keep the real URL', () => {
    expect(root.querySelectorAll('td')[1]!.textContent).toBe(URL300);
  });
  it('leaves short words and text outside tables alone', () => {
    expect(root.querySelector('p')!.querySelector('wbr')).toBeNull();
    expect(root.querySelectorAll('th')[0]!.querySelector('wbr')).toBeNull();
    expect(root.querySelectorAll('td')[0]!.innerHTML).toBe('ok');
  });
});

describe('layout in a narrow frame (real Chromium; skipped when it is not installed)', () => {
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

  async function measure(doc: string): Promise<{ sw: number; cw: number; th: number }> {
    const page = await browser!.newPage({ viewport: { width: 360, height: 700 } });
    try {
      await page.setContent(doc);
      return await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        th: document.querySelector('th')?.getBoundingClientRect().height ?? 0,
      }));
    } finally {
      await page.close();
    }
  }
  // One text line (21px at 14px/1.5) plus the 8px cell padding.
  const ONE_LINE = 21 + 8 + 2;

  it('keeps the "Status" header on one line and does not scroll sideways', async (ctx) => {
    if (!browser) return ctx.skip();
    const r = await measure(frame(STATUS_TABLE));
    expect(r.th).toBeLessThanOrEqual(ONE_LINE);
    expect(r.sw).toBe(r.cw);
  });

  it('negative control: the old CSS squeezes the header (proves the test sees the bug)', async (ctx) => {
    if (!browser) return ctx.skip();
    const old = frame(STATUS_TABLE).replace('overflow-wrap:break-word', 'word-wrap:break-word;overflow-wrap:anywhere');
    const r = await measure(old);
    expect(r.th).toBeGreaterThan(ONE_LINE * 1.5);
  });

  const cases: [string, string][] = [
    ['a 300-char URL in a paragraph', `<p>${URL300}</p>`],
    ['a long URL in a table cell', CELL_URL],
    ['a wide 600px newsletter table', '<table width="600" style="width:600px"><tr><td>Hello</td><td>world</td></tr></table>'],
    ['a long line in a pre block', `<pre>${'x'.repeat(400)}</pre>`],
  ];
  for (const [name, html] of cases) {
    it(`no sideways scroll with ${name}`, async (ctx) => {
      if (!browser) return ctx.skip();
      const r = await measure(frame(html));
      expect(r.sw).toBe(r.cw);
    });
  }
});
