// The home page "New in X.Y.Z" chip is built from CHANGELOG.md by scripts/make-changelog-page.mjs.
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper without types
import { applyChip, heroChip, joinPhrases, parse, shortPhrase } from '../../scripts/lib/changelog.mjs';

const md = (...lines: string[]) => lines.join('\n');
const chipOf = (text: string) => heroChip(parse(text));

describe('shortPhrase', () => {
  it('takes the words before a colon in the first sentence and keeps capitals', () => {
    expect(shortPhrase('Unread count on the taskbar: the button shows a red number. You can turn it off.')).toBe('Unread count on the taskbar');
  });
  it('uses the first sentence when there is no colon in it (a later colon is ignored)', () => {
    expect(shortPhrase('New mail is downloaded in the background, so it opens at once. Note: pictures need your OK.')).toBe('New mail is downloaded in the background, so it opens at once');
  });
  it('removes parentheticals and backticks', () => {
    expect(shortPhrase('Open `.eml` files (also from Explorer) in Letterdock. More text.')).toBe('Open .eml files in Letterdock');
  });
});

describe('joinPhrases', () => {
  it('joins 1, 2 and 4 items', () => {
    expect(joinPhrases(['A'])).toBe('A.');
    expect(joinPhrases(['A', 'B'])).toBe('A and B.');
    expect(joinPhrases(['A', 'B', 'C', 'D'])).toBe('A, B, C and D.');
  });
});

describe('heroChip', () => {
  const six = md(
    '# Changelog',
    '',
    '## 0.6.19 - 2026-10-19',
    '### Fixed',
    '- Sharp icons.',
    '',
    '## 0.6.6 - 2026-10-11',
    '### New',
    '- Unread count on the taskbar: the button shows a number.',
    '- Hide an account from All inboxes: right-click the account.',
  );
  it('skips Fixed-only entries and builds the text from the newest entry with New', () => {
    const c = chipOf(six);
    expect(c.version).toBe('0.6.6');
    expect(c.html).toBe('<span class="chip">New in 0.6.6</span> Unread count on the taskbar and Hide an account from All inboxes.');
    expect(c.warnings).toEqual([]);
  });
  it('uses the last version of a range heading', () => {
    expect(chipOf(md('## 0.5.0 to 0.5.2 - 2026-01-01', '### New', '- Thing.')).version).toBe('0.5.2');
  });
  it('uses at most 4 bullets', () => {
    const c = chipOf(md('## 1.0.0 - 2026-01-01', '### New', '- A.', '- B.', '- C.', '- D.', '- E.'));
    expect(c.text).toBe('A, B, C and D.');
  });
  it('uses the override, escapes & < > and keeps quotes', () => {
    const c = chipOf(md('## 1.0.0 - 2026-01-01', '<!-- hero: Tom & "Jerry" <b>win</b>. -->', '### New', '- A.'));
    expect(c.html).toBe('<span class="chip">New in 1.0.0</span> Tom &amp; "Jerry" &lt;b&gt;win&lt;/b&gt;.');
  });
  it('drops items and warns when the auto text is over 110 characters', () => {
    const long = (n: string) => `- ${n} ${'word '.repeat(6).trim()}.`;
    const c = chipOf(md('## 1.0.0 - 2026-01-01', '### New', long('One'), long('Two'), long('Three'), long('Four')));
    expect(c.text.length).toBeLessThanOrEqual(110);
    expect(c.text).toBe('One word word word word word word, Two word word word word word word and Three word word word word word word.');
    expect(c.warnings.join(' ')).toContain('hero:');
  });
  it('warns when an override is too long', () => {
    const c = chipOf(md('## 1.0.0 - 2026-01-01', `<!-- hero: ${'x'.repeat(120)}. -->`, '### New', '- A.'));
    expect(c.warnings).toHaveLength(1);
  });
  it('ignores an override on an entry without New, with a warning', () => {
    const c = chipOf(md('## 2.0.0 - 2026-02-01', '<!-- hero: Ignored. -->', '### Fixed', '- Bug.', '', '## 1.0.0 - 2026-01-01', '### New', '- A.'));
    expect(c.text).toBe('A.');
    expect(c.warnings[0]).toContain('2.0.0');
  });
  it('fails when no entry has New', () => {
    expect(() => chipOf(md('## 1.0.0 - 2026-01-01', '### Fixed', '- Bug.'))).toThrow(/### New/);
  });
  it('rejects "--" in an override and hero lines that are not under the heading', () => {
    expect(() => parse(md('## 1.0.0 - 2026-01-01', '<!-- hero: a -- b -->', '### New', '- A.'))).toThrow();
    expect(() => parse(md('## 1.0.0 - 2026-01-01', '### New', '<!-- hero: late -->', '- A.'))).toThrow();
  });
});

describe('applyChip', () => {
  const page = '<p><!-- whatsnew:start --><span class="chip">New in 1</span> old<!-- whatsnew:end --> <a href="x">link</a></p>';
  it('is stale when the text between the markers differs, and replaces only that part', () => {
    const r = applyChip(page, '<span class="chip">New in 2</span> new.');
    expect(r.stale).toBe(true);
    expect(r.html).toBe('<p><!-- whatsnew:start --><span class="chip">New in 2</span> new.<!-- whatsnew:end --> <a href="x">link</a></p>');
    expect(applyChip(r.html, '<span class="chip">New in 2</span> new.').stale).toBe(false);
  });
  it('throws when a marker is missing', () => {
    expect(() => applyChip('<p>no markers</p>', 'x')).toThrow(/whatsnew/);
    expect(() => applyChip('<!-- whatsnew:start -->only start', 'x')).toThrow();
  });
});
