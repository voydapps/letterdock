import { describe, expect, it } from 'vitest';
import { BACK_FROM_SNOOZE, dateRuns } from '../../src/renderer/src/lib/listGroups';

const NOW = new Date(2026, 9, 13, 10, 24).getTime(); // Tue 13 Oct 2026
const at = (m: number, d: number, h = 9) => new Date(2026, m, d, h).getTime();

type Row = { id: string; date: number; snoozeReturnedAt?: number };
const run = (rows: Row[], o: { floated?: boolean; conversations?: boolean } = {}) =>
  dateRuns(rows, NOW, { floated: o.floated ?? true, conversations: o.conversations ?? false }).map((g) => [g.label, g.items.map((r) => r.id)]);

describe('message list groups', () => {
  it('mail back from snooze is the one group at the top; an unrelated July conversation keeps its place', () => {
    // List order from the engine: the returned July mail first (newest return first), then newest first.
    const rows: Row[] = [
      { id: 'back', date: at(6, 24), snoozeReturnedAt: NOW },
      { id: 'today1', date: at(9, 13, 8) },
      { id: 'today2', date: at(9, 13, 7) },
      { id: 'mcp', date: at(6, 20) },
    ];
    expect(run(rows)).toEqual([
      [BACK_FROM_SNOOZE, ['back']],
      ['Today', ['today1', 'today2']],
      ['July 2026', ['mcp']],
    ]);
  });

  it('several returned rows make ONE group and "Today" shows once, so collapsing it hides all of Today', () => {
    const rows: Row[] = [
      { id: 'b1', date: at(9, 13, 9), snoozeReturnedAt: NOW },
      { id: 'b2', date: at(9, 1), snoozeReturnedAt: NOW - 1000 },
      { id: 't1', date: at(9, 13, 9) },
      { id: 't2', date: at(9, 13, 7) },
      { id: 'y', date: at(9, 12) },
    ];
    const labels = run(rows).map(([l]) => l);
    expect(labels).toEqual([BACK_FROM_SNOOZE, 'Today', 'Yesterday']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('conversations: a returned one that is not at the top is grouped by the time it is sorted by', () => {
    // 100+ returned conversations leave the rest in the paged query, sorted by max(date, return time).
    const rows: Row[] = [
      { id: 'new', date: at(9, 13, 9) },
      { id: 'late', date: at(9, 1), snoozeReturnedAt: at(9, 13, 8) },
      { id: 'old', date: at(9, 12) },
    ];
    expect(run(rows, { floated: false, conversations: true }).map(([l]) => l)).toEqual(['Today', 'Yesterday']);
  });

  it('oldest first and searches have no top group', () => {
    const rows: Row[] = [
      { id: 'old', date: at(6, 2) },
      { id: 'back', date: at(9, 12), snoozeReturnedAt: NOW },
    ];
    expect(run(rows, { floated: false }).map(([l]) => l)).toEqual(['July 2026', 'Yesterday']);
  });

  it('plain date order is unchanged', () => {
    const rows: Row[] = [
      { id: 'a', date: at(9, 13, 8) },
      { id: 'b', date: at(9, 12) },
      { id: 'c', date: at(6, 2) },
      { id: 'd', date: at(6, 1) },
    ];
    expect(run(rows)).toEqual([
      ['Today', ['a']],
      ['Yesterday', ['b']],
      ['July 2026', ['c', 'd']],
    ]);
  });
});
