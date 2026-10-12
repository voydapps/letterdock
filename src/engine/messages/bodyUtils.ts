// Pure helpers for cached bodies.

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '-',
  mdash: '-',
  hellip: '...',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  bull: '-',
  middot: '-',
  copy: '(c)',
  reg: '(R)',
  trade: '(TM)',
  zwnj: '',
  zwj: '',
  shy: '',
};

// HTML 4 Latin-1 names for U+00A0..U+00FF (accented letters in Italian, French, Spanish... mail).
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
const LATIN1_BY_NAME = new Map<string, string>(
  LATIN1.split(' ').map((n, i) => [n, String.fromCharCode(0xa0 + i)] as [string, string]),
);

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ' ';
      // Dashes and quotes become plain ASCII; other characters stay as they are.
      if (code === 0x2013 || code === 0x2014) return '-';
      if (code === 0x2018 || code === 0x2019) return "'";
      if (code === 0x201c || code === 0x201d) return '"';
      return String.fromCodePoint(code);
    }
    // Case matters for the letters (Eacute vs eacute); the punctuation names are lower case.
    return NAMED_ENTITIES[body.toLowerCase()] ?? LATIN1_BY_NAME.get(body) ?? ' ';
  });
}

// Characters marketing mails use as invisible padding after the preview text.
const INVISIBLE_CODES = new Set([0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x3164, 0xfeff, 0xffa0]);
const INVISIBLE_RANGES: [number, number][] = [
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfe00, 0xfe0f],
];

/** Removes the invisible characters (checked by code, so no regex class of combining characters is needed). */
function stripInvisible(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (INVISIBLE_CODES.has(c) || INVISIBLE_RANGES.some(([lo, hi]) => c >= lo && c <= hi)) continue;
    out += text[i];
  }
  return out;
}

/**
 * Cheap HTML to text for snippets and the search index. Not for display.
 * Works on cut-off HTML too (a 3 KB peek often ends inside <style> or <head>): blocks that never
 * close are dropped to the end, and when a <body> tag exists everything before it is ignored.
 */
export function stripHtml(html: string): string {
  let s = html
    // Comments, including Outlook conditional comments (<!--[if gte mso 9]><xml>...<![endif]-->).
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!--[\s\S]*$/, ' ')
    // Downlevel-revealed conditionals and doctype: <![if !mso]>, <![endif]>, <!DOCTYPE ...>
    .replace(/<![^>]*>/g, ' ');
  // Skip the document head when we can see where the body starts.
  const body = /<body\b[^>]*>/i.exec(s);
  if (body) s = s.slice(body.index + body[0].length);
  s = s
    .replace(/<(script|style|head|title|xml|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // MJML / Mailjet metadata blocks (the visible text is in <mj-text> and friends: keep those).
    .replace(/<(mj-head|mj-style|mj-attributes|mj-global-style|mj-font|mj-breakpoint|mj-title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // An unclosed block (cut-off input) swallows the rest of the text.
    .replace(/<(script|style|head|title|xml|noscript|template|mj-head|mj-style|mj-attributes|mj-global-style)\b[\s\S]*$/i, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    // A tag cut off at the end of the chunk.
    .replace(/<[^>]*$/, ' ');
  s = stripInvisible(decodeEntities(s));
  return stripCss(s).replace(/\s+/g, ' ').trim();
}

/** Remove CSS that leaked into text: at-rules ("@font-face {...}") and "selector { prop: value }" blocks. */
function stripCss(src: string): string {
  return src
    .replace(/@(?:font-face|media|import|charset|page|keyframes|supports|-[a-z]+-keyframes)\b[^{};]*(?:\{(?:[^{}]|\{[^{}]*\})*\}|;)/gi, ' ')
    .replace(/@(?:font-face|media|keyframes|supports)\b[^{}]*\{[\s\S]*$/gi, ' ')
    .replace(/[^{};]{0,80}\{\s*[a-z-]+\s*:[^{}]*\}/gi, ' ')
    .replace(/[^{};]{0,80}\{\s*[a-z-]+\s*:[^{}]*$/gi, ' ');
}

// Start of an embedded JSON object / array: {"key": ...  or  [{"key": ...
const JSON_OPEN = /[[{]\s*(?:\{\s*)?"[^"\\\r\n]{1,60}"\s*:/g;

/**
 * Remove JSON that leaked into text (Mailjet / MJML editor data, tracking blobs). A blob that is cut
 * off (partial fetch) is dropped to the end. One linear pass; no parser.
 */
export function stripJsonBlobs(src: string): string {
  if (!src.includes('"')) return src;
  JSON_OPEN.lastIndex = 0;
  let out = '';
  let pos = 0;
  for (;;) {
    JSON_OPEN.lastIndex = pos;
    const m = JSON_OPEN.exec(src);
    if (!m) break;
    out += src.slice(pos, m.index) + ' ';
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let i = m.index; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) return out; // cut off: nothing real follows
    pos = end + 1;
  }
  return out + src.slice(pos);
}

/** Does a stored snippet look like code instead of text? (Used by the repair job and the tests.) */
export const BROKEN_SNIPPET_LIKE = [
  '{%',
  '[{%',
  '%{"%',
  '%tagName%',
  '%mj-%',
  '%@media%',
  '%font-family:%',
  '%<!--%',
  '%<style%',
  '%<mj%',
];
export function looksBrokenSnippet(s: string): boolean {
  return /^\s*[[{]|tagName|mj-|@media|font-family:|<!--|<style|<mj|\{"/.test(s);
}

/** Remove image placeholders, links and "view in browser" lines from snippet text. */
export function cleanSnippetText(src: string): string {
  let s = stripCss(stripJsonBlobs(src))
    .replace(/\[\s*(?:image|img|inline image|cid)\b[^\]]*\]/gi, ' ')
    .replace(/\[\s*(?:image|img|inline image|cid)\b\S*/gi, ' ')
    // Links in angle brackets or square brackets, and bare URLs.
    .replace(/[<[(]\s*(?:https?:\/\/|www\.)[^\s>\])]*\s*[>\])]?/gi, ' ')
    .replace(/(?:https?:\/\/|www\.)\S*/gi, ' ');
  s = stripInvisible(s)
    .replace(/\uFFFD+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // "View in browser" style opening lines, possibly more than one.
  const lead =
    /^(?:(?:view|read|open)\s+(?:this\s+)?(?:email|message|newsletter|mail|it|online)?\s*(?:in|on)\s+(?:your\s+|a\s+)?(?:web\s+)?browser|having trouble (?:viewing|reading) this (?:email|message)\??(?: view it in your browser)?|(?:email )?not displaying (?:correctly|properly)\??(?: view it in your browser)?)[\s.:|-]*/i;
  for (let i = 0; i < 3; i++) {
    const next = s.replace(lead, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * `text` is the plain-text part (null when the message only has HTML: do not pass text that was
 * generated from the HTML). `max` caps the length.
 */
export function makeSnippet(text: string | null, html: string | null, max = 200): string {
  // A "plain text" part that is really HTML or MJML source: treat it as HTML.
  const textIsMarkup = !!text && /^\s*<(?:!doctype|html|head|body|mj-|mjml)/i.test(text);
  if (textIsMarkup && !html) return cleanSnippetText(stripHtml(text)).slice(0, max);
  const fromText = text && text.trim() && !textIsMarkup ? cleanSnippetText(text) : '';
  if (fromText) return fromText.slice(0, max);
  return html ? cleanSnippetText(stripHtml(html)).slice(0, max) : '';
}

/** Text stored in the search index, capped at 100 KB (ARCHITECTURE 5.5). */
export function ftsText(text: string | null, html: string | null): string {
  const src = text && text.trim() ? text : html ? stripHtml(html) : '';
  return src.slice(0, 100 * 1024);
}

/** Hint for the UI: does the HTML pull in remote content (http/https images, srcset, CSS url())? */
export function hasRemoteImages(html: string | null): boolean {
  if (!html) return false;
  return (
    /<(img|video|source|image|input)\b[^>]*\b(src|poster|srcset)\s*=\s*["']?\s*(https?:)?\/\//i.test(
      html,
    ) ||
    /\bbackground\s*=\s*["']?\s*https?:\/\//i.test(html) ||
    /url\(\s*["']?\s*(https?:)?\/\//i.test(html)
  );
}

export { safeFileName } from '../../shared/fileName';
export { isExecutableName } from '../../shared/safety';
