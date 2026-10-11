// Group headers of the message list (DESIGN-SPEC 3.5 and 3.13.2).
import { groupLabel } from './format';

/** Header of mail that came back from snooze. Such mail is the first group of the Date sort (newest first). */
export const BACK_FROM_SNOOZE = 'Back from snooze';

export interface DateGroupOptions {
  /**
   * The engine put the mail that came back from snooze before the rest (Date sort, newest first, not a search).
   * Then the rows at the top that carry the "back from snooze" mark form one group.
   */
  floated: boolean;
  /**
   * Rows are conversations. The engine sorts a conversation by max(newest date, time it came back), so
   * a returned one that is not in the top group is grouped by that time, to stay in step with the order.
   */
  conversations: boolean;
}

type Dated = { date: number; snoozeReturnedAt?: number };

/** Runs of neighbouring rows with the same label, in list order (never reorders). */
export function groupRuns<T>(items: T[], labelOf: (m: T) => string): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const m of items) {
    const label = labelOf(m);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(m);
    else out.push({ label, items: [m] });
  }
  return out;
}

/**
 * Date groups of a list. The engine order is the only order: the leading rows that came back from snooze
 * form the one "Back from snooze" group, and every other row is grouped by the time it is sorted by, so a
 * date label cannot show up twice. Returns the groups with their rows.
 */
export function dateRuns<T extends Dated>(items: T[], now: number, opts: DateGroupOptions): { label: string; items: T[] }[] {
  let top = 0;
  if (opts.floated) while (top < items.length && items[top]!.snoozeReturnedAt) top++;
  const keyOf = (m: Dated) => (opts.conversations ? Math.max(m.date, m.snoozeReturnedAt ?? 0) : m.date);
  const out = top > 0 ? [{ label: BACK_FROM_SNOOZE, items: items.slice(0, top) }] : [];
  return [...out, ...groupRuns(items.slice(top), (m) => groupLabel(keyOf(m), now))];
}
