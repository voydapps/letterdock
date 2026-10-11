// Group headers of the message list (DESIGN-SPEC 3.5 and 3.13.2).
import { groupLabel } from './format';

/** Header of mail that came back from snooze. Such mail sits at the top of the Date sort, whatever its own date. */
export const BACK_FROM_SNOOZE = 'Back from snooze';

/** Group a row falls in under the Date sort: returned mail has its own group, the rest go by date. */
export function dateGroupOf(m: { date: number; snoozeReturnedAt?: number }, now: number): string {
  return m.snoozeReturnedAt ? BACK_FROM_SNOOZE : groupLabel(m.date, now);
}

/**
 * Runs of neighbouring rows with the same label, in list order. Rows are never moved to an earlier
 * group: the list order is what the engine sent (returned mail first), so a label can come back later.
 */
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
