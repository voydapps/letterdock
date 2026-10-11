// Text lines of a new-mail toast (DESIGN-SPEC 3.13.3a). Pure functions.

const LINE_CAP = 160;

/** Cuts at a word boundary and adds "…" when the text is longer than `max`. */
export function capLine(s: string, max = LINE_CAP): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const space = t.lastIndexOf(' ', max - 1);
  // A very early space would leave almost nothing: cut hard then.
  const cut = space >= max / 2 ? space : max - 1;
  return `${t.slice(0, cut).trimEnd()}…`;
}

/**
 * Second line of the toast: the snippet without a leading copy of the subject (many mails start
 * with their subject). Returns '' when nothing useful is left.
 */
export function previewLine(subject: string, snippet: string): string {
  const sub = subject.replace(/\s+/g, ' ').trim();
  let snip = snippet.replace(/\s+/g, ' ').trim();
  if (sub && snip.slice(0, sub.length).toLowerCase() === sub.toLowerCase()) {
    snip = snip.slice(sub.length).replace(/^[\s\-–—:]+/, '');
  }
  if (!snip || snip.toLowerCase() === sub.toLowerCase()) return '';
  return snip;
}

/** The lines under the title: subject, then the snippet when it adds something. */
export function mailLines(subject: string, snippet: string): string[] {
  const sub = subject.replace(/\s+/g, ' ').trim();
  const lines = [capLine(sub || '(no subject)')];
  const p = previewLine(sub, snippet);
  if (p) lines.push(capLine(p));
  return lines;
}
