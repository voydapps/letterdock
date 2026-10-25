// Pure helpers for scripts/make-changelog-page.mjs (kept apart so tests can import them without side effects).
export const GROUPS = ['New', 'Faster', 'Changed', 'Fixed'];
export const HERO_MAX = 110;
export const CHIP_START = '<!-- whatsnew:start -->';
export const CHIP_END = '<!-- whatsnew:end -->';

/** Reads CHANGELOG.md. An optional `<!-- hero: text -->` line directly under a version heading becomes entry.hero. */
export function parse(md) {
  const entries = [];
  let entry = null;
  let group = null;
  md.replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
    const fail = (msg) => {
      throw new Error(`CHANGELOG.md line ${i + 1}: ${msg}`);
    };
    if (!line.trim() || line.startsWith('# ')) return;
    let m;
    if ((m = /^## (.+) - (\d{4}-\d{2}-\d{2})$/.exec(line))) {
      entry = { label: m[1], date: m[2], groups: [], hero: null };
      group = null;
      entries.push(entry);
    } else if ((m = /^<!-- hero: (.+?) -->$/.exec(line))) {
      if (!entry || entry.groups.length || entry.hero !== null) fail('a hero line must come directly under the version heading (once)');
      if (m[1].includes('--')) fail('a hero line must not contain "--"');
      entry.hero = m[1].trim();
    } else if (line.startsWith('<!--')) {
      fail(`cannot read "${line}" (hero lines look like: <!-- hero: Your text. -->)`);
    } else if ((m = /^### (.+)$/.exec(line))) {
      if (!entry) fail('a group needs a version heading before it');
      if (!GROUPS.includes(m[1])) fail(`unknown group "${m[1]}" (use ${GROUPS.join(', ')})`);
      if (entry.groups.length && GROUPS.indexOf(entry.groups.at(-1).name) >= GROUPS.indexOf(m[1])) fail('groups must be in the order New, Faster, Changed, Fixed');
      group = { name: m[1], items: [] };
      entry.groups.push(group);
    } else if ((m = /^- (.+)$/.exec(line))) {
      if (!group) fail('a bullet needs a group before it');
      group.items.push(m[1]);
    } else fail(`cannot read "${line}"`);
  });
  if (!entries.length) throw new Error('CHANGELOG.md has no versions');
  return entries;
}

/** Only & < > are escaped: straight quotes are safe in text. */
export const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "0.5.0 to 0.5.2" -> "0.5.2" (the last version number in the heading). */
export function lastVersion(label) {
  const all = label.match(/\d+(?:\.\d+)+/g);
  return all ? all.at(-1) : label;
}

/** One New bullet -> a short phrase: text before a colon in the first sentence, else the first sentence. */
export function shortPhrase(bullet) {
  let s = bullet.replace(/`/g, '');
  const dot = s.search(/\.(\s|$)/);
  const first = dot === -1 ? s : s.slice(0, dot);
  const colon = first.indexOf(':');
  s = colon !== -1 ? first.slice(0, colon) : first;
  return s.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').replace(/\.$/, '').trim();
}

export function joinPhrases(items) {
  if (items.length === 1) return `${items[0]}.`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}.`;
}

/**
 * The home page chip for the newest entry that has "### New" (first in file order).
 * Returns { version, text, html, warnings }. text is plain (not escaped); html is the exact content between the markers.
 */
export function heroChip(entries) {
  const entry = entries.find((e) => e.groups.some((g) => g.name === 'New'));
  if (!entry) throw new Error('CHANGELOG.md has no entry with a "### New" section, so the home page chip has nothing to show');
  const warnings = [];
  for (const e of entries) {
    if (e.hero !== null && e !== entry && !e.groups.some((g) => g.name === 'New')) {
      warnings.push(`CHANGELOG ${e.label}: the hero line is ignored because this entry has no "### New" section`);
    }
  }
  const version = lastVersion(entry.label);
  let text;
  if (entry.hero !== null) {
    text = entry.hero;
    if (text.length > HERO_MAX) warnings.push(`hero text for ${version} is ${text.length} characters (limit ${HERO_MAX}); shorten the hero line`);
  } else {
    const bullets = entry.groups.find((g) => g.name === 'New').items.slice(0, 4);
    const phrases = bullets.map(shortPhrase).filter(Boolean);
    let n = phrases.length;
    text = joinPhrases(phrases.slice(0, n));
    while (text.length > HERO_MAX && n > 1) {
      n--;
      text = joinPhrases(phrases.slice(0, n));
    }
    if (n < phrases.length) warnings.push(`hero text for ${version} was cut to ${n} item(s) to fit ${HERO_MAX} characters; add <!-- hero: Your text. --> under the version heading for better wording`);
    if (text.length > HERO_MAX) warnings.push(`hero text for ${version} is ${text.length} characters (limit ${HERO_MAX}); add <!-- hero: Your text. --> under the version heading`);
  }
  return { version, text, html: `<span class="chip">New in ${escText(version)}</span> ${escText(text)}`, warnings };
}

/** Puts chipHtml between the markers of index.html. Throws when a marker is missing. Returns { html, current, stale }. */
export function applyChip(indexHtml, chipHtml) {
  const a = indexHtml.indexOf(CHIP_START);
  const b = indexHtml.indexOf(CHIP_END);
  if (a === -1 || b === -1 || b < a) throw new Error(`site/index.html needs ${CHIP_START} and ${CHIP_END} around the "New in" chip`);
  const from = a + CHIP_START.length;
  const current = indexHtml.slice(from, b);
  return { html: indexHtml.slice(0, from) + chipHtml + indexHtml.slice(b), current, stale: current !== chipHtml };
}
