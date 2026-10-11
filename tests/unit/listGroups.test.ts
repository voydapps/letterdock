import { describe, expect, it } from 'vitest';
import { BACK_FROM_SNOOZE, dateGroupOf, groupRuns } from '../../src/renderer/src/lib/listGroups';

const NOW = new Date(2026, 9, 13, 10, 24).getTime(); // Tue 13 Oct 2026
const at = (m: number, d: number, h = 9) => new Date(2026, m, d, h).getTime();

type Row = { id: string; date: number; snoozeReturnedAt?: number };
const labelsOf = (rows: Row[]) => groupRuns(rows, (m) => dateGroupOf(m, NOW)).map((g) => [g.label, g.items.map((r) => r.id)]);

describe('message list groups (snooze regression)', () => {
  it('mail back from snooze gets its own group; an unrelated July conversation keeps its place', () => {
    // List order from the engine: the returned July mail first (it sorts by the time it came back), then newest first.
    const rows: Row[] = [
      { id: 'back', date: at(6, 24), snoozeReturnedAt: NOW },
      { id: 'today1', date: at(9, 13, 8) },
      { id: 'today2', date: at(9, 13, 7) },
      { id: 'mcp', date: at(6, 20) },
    ];
    expect(labelsOf(rows)).toEqual([
      [BACK_FROM_SNOOZE, ['back']],
      ['Today', ['today1', 'today2']],
      ['July 2026', ['mcp']],
    ]);
  });

  it('never merges a later run into an earlier group with the same label', () => {
    const rows: Row[] = [
      { id: 'new', date: at(9, 13, 9) },
      { id: 'back', date: at(9, 1), snoozeReturnedAt: NOW - 1000 },
      { id: 'old', date: at(9, 12) },
    ];
    expect(labelsOf(rows).map(([l]) => l)).toEqual(['Today', BACK_FROM_SNOOZE, 'Yesterday']);
  });

  it('plain date order is unchanged', () => {
    const rows: Row[] = [
      { id: 'a', date: at(9, 13, 8) },
      { id: 'b', date: at(9, 12) },
      { id: 'c', date: at(6, 2) },
      { id: 'd', date: at(6, 1) },
    ];
    expect(labelsOf(rows)).toEqual([
      ['Today', ['a']],
      ['Yesterday', ['b']],
      ['July 2026', ['c', 'd']],
    ]);
  });
});
