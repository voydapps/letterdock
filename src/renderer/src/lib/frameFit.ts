// Helpers that fit a message frame to its content (used by ReadingPane's HtmlFrame).

/**
 * Some senders hide what does not fit: a fixed-width wrapper with overflow:hidden around a wide table, or
 * table cells with text-overflow ellipsis. In a mail reader that cuts words in half with no way to see the
 * rest, so those boxes are opened up and the frame (or its wrapper) scrolls instead.
 * Only boxes that really cut a table sideways are touched (a table cell itself, or a box with a table inside
 * that is wider than the box). Carousels, decorative bleed, and boxes with no size (hidden preview text:
 * width:0 or max-height:0) stay as the sender made them.
 */
export function showClippedContent(doc: Document): void {
  const win = doc.defaultView;
  if (!win) return;
  const all = doc.body?.querySelectorAll<HTMLElement>('*');
  if (!all || all.length > 6000) return;
  for (const el of all) {
    if (el.scrollWidth <= el.clientWidth + 4 || el.clientWidth < 20 || el.clientHeight < 10)
      continue;
    const cs = win.getComputedStyle(el);
    if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') continue;
    const inTable = el.matches('td,th,table');
    if (
      !inTable &&
      ![...el.querySelectorAll('table')].some((t) => t.offsetWidth > el.clientWidth + 4)
    )
      continue;
    // Both axes: visible on one axis only would turn the other into auto (a scrollbar).
    el.style.setProperty('overflow', 'visible', 'important');
    el.style.setProperty('text-overflow', 'clip', 'important');
  }
}
