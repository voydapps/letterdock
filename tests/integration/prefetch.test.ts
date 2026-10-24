// Background download of mail bodies (prefetch): DESIGN-SPEC 2026-10-24.
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountStatus, MessageBody } from '../../src/shared/ipc';
import { createHarness, waitFor, waitForInboxCursors, type Harness } from '../fakes/engineHarness';
import {
  rawMessage,
  startFakeImap,
  type FakeImapServer,
  type SeedMessage,
} from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close();
  h = null;
  server = null;
});

const DAY = 86_400_000;
const HOUR = 3_600_000;

function mk(
  subject: string,
  o: { ageMs?: number; atMs?: number; text?: string; flags?: string[] } = {},
): SeedMessage {
  const date = new Date(o.atMs ?? Date.now() - (o.ageMs ?? 0));
  return {
    raw: rawMessage({
      subject,
      messageId: `<${subject.replace(/\W+/g, '-')}@fake.test>`,
      date,
      text: o.text ?? `Body of ${subject}`,
    }),
    flags: o.flags ?? [],
    internaldate: date,
  };
}

const q = (hh: Harness, sql: string, ...args: unknown[]) =>
  hh.engine.ctx.db.prepare(sql).all(...args) as Record<string, unknown>[];
const cachedSubjects = (hh: Harness): string[] =>
  q(hh, "SELECT subject FROM message WHERE body_state='cached' ORDER BY subject").map(
    (r) => r.subject as string,
  );
const idOf = (hh: Harness, subject: string): number =>
  q(hh, 'SELECT id FROM message WHERE subject = ?', subject)[0]!.id as number;
const openedAt = (hh: Harness, subject: string): number | null | 'nobody' => {
  const r = q(hh, 'SELECT b.opened_at AS o FROM body b JOIN message m ON m.id=b.message_pk WHERE m.subject=?', subject)[0];
  return r ? (r.o as number | null) : 'nobody';
};
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** Start the loop now (the settings hook clears the start delay) and wait for the condition. */
async function kickUntil(hh: Harness, what: string, cond: () => boolean, timeout = 20_000) {
  await waitFor(
    what,
    () => {
      hh.engine.sessions.prefetchNow();
      return cond();
    },
    timeout,
  );
}

/** Tick the settings hook for a while (it starts the loop as soon as the first sync is settled). */
async function kickFor(hh: Harness, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    hh.engine.sessions.prefetchNow();
    await settle(40);
  }
}

describe('prefetch: what and in which order', () => {
  it('downloads the backfill newest first, unread first within a day, and only the window', async () => {
    // UTC midnight of a day, plus hours: two messages of the same day, the older one unread.
    const dayAt = (daysAgo: number, hour: number) => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime() - daysAgo * DAY + hour * HOUR;
    };
    server = await startFakeImap({
      inbox: [
        mk('SameDay read', { atMs: dayAt(2, 10), flags: ['\\Seen'] }),
        mk('SameDay unread', { atMs: dayAt(2, 8) }),
        mk('Newest', { atMs: dayAt(1, 9) }),
        mk('Week old', { atMs: dayAt(6, 9), flags: ['\\Seen'] }),
        mk('Too old', { atMs: dayAt(60, 9) }),
      ],
    });
    h = await createHarness(server);
    const acc = await h.addAccount({ syncDays: 400 });
    await waitFor('five rows', () => h!.inboxMessages(acc.id).length === 5);
    await waitForInboxCursors(h, [acc.id]);

    const order: string[] = [];
    const ctx = h.engine.ctx;
    const orig = ctx.prefetchMessage!;
    ctx.prefetchMessage = async (id) => {
      order.push((q(h!, 'SELECT subject FROM message WHERE id=?', id)[0]!.subject as string));
      return orig(id);
    };
    await kickUntil(h, 'window downloaded', () => order.length >= 4);
    await settle(300);
    expect(order).toEqual(['Newest', 'SameDay unread', 'SameDay read', 'Week old']);
    expect(cachedSubjects(h)).toEqual(['Newest', 'SameDay read', 'SameDay unread', 'Week old']);
    // The 60 day old one is outside the default 30 days.
    expect(q(h, "SELECT body_state FROM message WHERE subject='Too old'")[0]!.body_state).toBe('none');
    // Prefetched mail is not "opened".
    expect(openedAt(h, 'Newest')).toBeNull();
  });

  it('skips mail over 1 MB and mail that waits for a move on this PC', async () => {
    server = await startFakeImap({
      inbox: [
        mk('Big', { text: 'x'.repeat(1_100_000) }),
        mk('Small one'),
        mk('Moving'),
      ],
    });
    h = await createHarness(server);
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 3);
    await waitForInboxCursors(h, [acc.id]);
    // A pending move on this PC gives the row a placeholder uid <= 0.
    const mv = idOf(h, 'Moving');
    h.engine.ctx.db.prepare('UPDATE message SET uid = -id WHERE id = ?').run(mv);
    await kickUntil(h, 'small one cached', () => cachedSubjects(h!).includes('Small one'));
    await settle(400);
    expect(cachedSubjects(h)).toEqual(['Small one']);
    // The big one still opens on demand.
    const body = (await h.engine.handle('messages.get', { messageId: idOf(h, 'Big') })) as MessageBody;
    expect(body.text!.length).toBeGreaterThan(1_000_000);
  });

  it('downloads new mail when it arrives (any age, Inbox only)', async () => {
    server = await startFakeImap({ inbox: [mk('Existing')] });
    h = await createHarness(server, { prefetchStartDelayMs: 0 });
    h.settings.prefetchDays = 7;
    const acc = await h.addAccount({ syncDays: 400 });
    await waitFor('existing cached', () => cachedSubjects(h!).includes('Existing'));
    await waitForInboxCursors(h, [acc.id]);
    server.deliver('INBOX', mk('Arrived', { ageMs: 40 * DAY })); // far outside the 7 days
    server.deliver('Sent', mk('Sent copy'));
    await waitFor('arrival cached', () => cachedSubjects(h!).includes('Arrived'), 30_000);
    expect(openedAt(h, 'Arrived')).toBeNull();
    expect(cachedSubjects(h)).not.toContain('Sent copy');
  });
});

describe('prefetch: the settings choice', () => {
  it('Off, 7, 30, 90 days and all mail', async () => {
    server = await startFakeImap({
      inbox: [
        mk('d3', { ageMs: 3 * DAY }),
        mk('d20', { ageMs: 20 * DAY }),
        mk('d60', { ageMs: 60 * DAY }),
        mk('d200', { ageMs: 200 * DAY }),
      ],
    });
    h = await createHarness(server);
    h.settings.prefetchDays = 0;
    const acc = await h.addAccount({ syncDays: 400 });
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 4);
    await waitForInboxCursors(h, [acc.id]);
    await settle(300);
    // Off: nothing, and the loop does not run.
    for (let i = 0; i < 3; i++) await h.engine.applySettings();
    await settle(400);
    expect(cachedSubjects(h)).toEqual([]);

    const step = async (days: 7 | 30 | 90 | -1, expected: string[]) => {
      h!.settings.prefetchDays = days;
      await kickUntil(h!, `days ${days}`, () => cachedSubjects(h!).length >= expected.length);
      await settle(300);
      expect(cachedSubjects(h!)).toEqual(expected);
    };
    await step(7, ['d3']);
    await step(30, ['d20', 'd3']);
    await step(90, ['d20', 'd3', 'd60']);
    await step(-1, ['d20', 'd200', 'd3', 'd60']);
  });

  it('saving another setting does not start the download early; a bigger window does', async () => {
    server = await startFakeImap({ inbox: [mk('Recent'), mk('Month old', { ageMs: 20 * DAY })] });
    h = await createHarness(server); // the 20 s start delay is long here
    h.settings.prefetchDays = 7;
    const acc = await h.addAccount({ syncDays: 400 });
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 2);
    await waitForInboxCursors(h, [acc.id]);
    await settle(500);
    for (let i = 0; i < 5; i++) {
      h.settings.maxBodyCacheMB = 2048 + i; // any other setting
      await h.engine.applySettings();
      await settle(100);
    }
    expect(cachedSubjects(h)).toEqual([]);
    h.settings.prefetchDays = 30;
    await waitFor('bigger window starts at once', () => {
      void h!.engine.applySettings();
      return cachedSubjects(h!).length === 2;
    });
  });

  it('turning it off stops a running download; downloaded mail stays', async () => {
    server = await startFakeImap({
      inbox: Array.from({ length: 8 }, (_, i) => mk(`m${i}`, { ageMs: i * HOUR })),
    });
    h = await createHarness(server, { prefetchGapMs: 250 });
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 8);
    await waitForInboxCursors(h, [acc.id]);
    await kickUntil(h, 'two cached', () => cachedSubjects(h!).length >= 2);
    h.settings.prefetchDays = 0;
    await h.engine.applySettings();
    await settle(600); // one message may still be in flight
    const n = cachedSubjects(h).length;
    await settle(900);
    expect(cachedSubjects(h).length).toBe(n);
    expect(n).toBeLessThan(8);
  });

  it('a muted account (not in All inboxes) gets new mail but no backfill', async () => {
    server = await startFakeImap({ inbox: [mk('Old one'), mk('Old two')] });
    h = await createHarness(server, { prefetchStartDelayMs: 0 });
    const acc = await h.addAccount();
    await h.engine.handle('accounts.update', { accountId: acc.id, patch: { inUnified: false } });
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 2);
    await waitForInboxCursors(h, [acc.id]);
    await settle(500);
    expect(cachedSubjects(h)).toEqual([]);
    server.deliver('INBOX', mk('Fresh'));
    await waitFor('arrival cached', () => cachedSubjects(h!).includes('Fresh'), 30_000);
    await settle(300);
    expect(cachedSubjects(h)).toEqual(['Fresh']);
  });
});

describe('prefetch: opening during the download', () => {
  it('shares one download with the open and marks the message as opened', async () => {
    server = await startFakeImap({ inbox: [mk('Only')] });
    h = await createHarness(server);
    const acc = await h.addAccount();
    await waitFor('row', () => h!.inboxMessages(acc.id).length === 1);
    await waitForInboxCursors(h, [acc.id]);
    await waitFor('snippet', () => h!.inboxMessages(acc.id)[0]!.snippet.length > 0);
    const held = server.holdCommands(['UID FETCH']);
    await kickUntil(h, 'prefetch fetch is waiting on the server', () => held.held() === 1);
    const id = idOf(h, 'Only');
    const opening = h.engine.handle('messages.get', { messageId: id }) as Promise<MessageBody>;
    await settle(300);
    expect(held.held()).toBe(1); // no second download
    held.release();
    const body = await opening;
    expect(body.text).toContain('Body of Only');
    expect(openedAt(h, 'Only')).toBeTypeOf('number');
  });

  it('an open of a message the download has not started yet goes first, once', async () => {
    server = await startFakeImap({
      inbox: [mk('A', { ageMs: 1 * HOUR }), mk('B', { ageMs: 2 * HOUR }), mk('C', { ageMs: 3 * HOUR })],
    });
    h = await createHarness(server, { prefetchGapMs: 50 });
    h.settings.maxWorkConnectionsPerAccount = 1;
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 3);
    await waitForInboxCursors(h, [acc.id]);
    await waitFor('snippets', () => h!.inboxMessages(acc.id).every((m) => m.snippet.length > 0));
    const held = server.holdCommands(['UID FETCH']);
    await kickUntil(h, 'A is being fetched', () => held.held() === 1);
    const opening = h.engine.handle('messages.get', { messageId: idOf(h, 'C') }) as Promise<MessageBody>;
    await settle(200);
    held.release();
    expect((await opening).text).toContain('Body of C');
    await kickUntil(h, 'all cached', () => cachedSubjects(h!).length === 3);
    expect(openedAt(h, 'C')).toBeTypeOf('number');
    expect(openedAt(h, 'B')).toBeNull();
    expect(openedAt(h, 'A')).toBeNull();
  });

  it('runs one download at a time per account', async () => {
    server = await startFakeImap({
      inbox: Array.from({ length: 6 }, (_, i) => mk(`m${i}`, { ageMs: i * HOUR })),
    });
    h = await createHarness(server);
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 6);
    await waitForInboxCursors(h, [acc.id]);
    let now = 0;
    let max = 0;
    const orig = h.engine.ctx.prefetchMessage!;
    h.engine.ctx.prefetchMessage = async (id) => {
      max = Math.max(max, ++now);
      try {
        return await orig(id);
      } finally {
        now--;
      }
    };
    await kickUntil(h, 'all cached', () => cachedSubjects(h!).length === 6);
    expect(max).toBe(1);
  });
});

describe('prefetch: cache size and eviction order', () => {
  it('stops at 90% of the cache size and never removes anything', async () => {
    const text = (n: number) => `${n} ` + 'lorem ipsum '.repeat(8000); // about 96 KB
    server = await startFakeImap({
      inbox: Array.from({ length: 16 }, (_, i) => mk(`big${String(i).padStart(2, '0')}`, { ageMs: i * HOUR, text: text(i) })),
    });
    h = await createHarness(server);
    h.settings.maxBodyCacheMB = 1;
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 16);
    await waitForInboxCursors(h, [acc.id]);
    const ctx = h.engine.ctx;
    let evictions = 0;
    const evict = ctx.messages.evictBodies.bind(ctx.messages);
    ctx.messages.evictBodies = (ids) => {
      evictions++;
      evict(ids);
    };
    await kickUntil(h, 'download stopped by the limit', () => cachedSubjects(h!).length >= 9);
    await settle(1800); // the pause between messages grows with the CPU time of the last one
    const n = cachedSubjects(h).length;
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThan(16);
    expect(ctx.messages.bodyCacheBytes()).toBeLessThan(1.15 * 1024 * 1024);
    expect(evictions).toBe(0);
    // Stopped for good: the next ticks do not bring more.
    for (let i = 0; i < 3; i++) await h.engine.applySettings();
    await settle(500);
    expect(cachedSubjects(h).length).toBe(n);
    // A bigger limit lets it go on.
    h.settings.maxBodyCacheMB = 50;
    await kickUntil(h, 'rest downloaded', () => cachedSubjects(h!).length === 16);
  });

  it('removes by last opened, and never-opened mail counts by its message date', async () => {
    server = await startFakeImap({
      inbox: [
        mk('opened last week, mail 40 days old', { ageMs: 40 * DAY }),
        mk('never opened, mail 10 days old', { ageMs: 10 * DAY }),
        mk('never opened, mail of today'),
        mk('opened yesterday, mail of today'),
      ],
    });
    h = await createHarness(server);
    const acc = await h.addAccount({ syncDays: 400 });
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 4);
    await waitForInboxCursors(h, [acc.id]);
    const ctx = h.engine.ctx;
    const body = { text: 't', html: null, snippet: 's', attachments: [], ftsBodyText: 't' };
    const now = Date.now();
    const sub = (s: string) => idOf(h!, s);
    ctx.messages.saveBody(sub('opened last week, mail 40 days old'), body, now - 7 * DAY);
    ctx.messages.saveBody(sub('opened yesterday, mail of today'), body, now - 1 * DAY);
    // Prefetched just now: fetched_at is "now" for both, opened_at stays empty.
    ctx.messages.saveBody(sub('never opened, mail 10 days old'), body, now, { prefetched: true });
    ctx.messages.saveBody(sub('never opened, mail of today'), body, now, { prefetched: true });
    const order = ctx.messages
      .cachedBodiesOldestFirst(10)
      .map((r) => ctx.messages.row(r.id)!.subject);
    expect(order).toEqual([
      'never opened, mail 10 days old', // counts by its date: 10 days ago
      'opened last week, mail 40 days old', // opened 7 days ago: the 40 day old date does not count
      'opened yesterday, mail of today',
      'never opened, mail of today',
    ]);
    // Opening it later gives it an opened time.
    ctx.messages.touchBody(sub('never opened, mail 10 days old'), now + 5);
    expect(openedAt(h, 'never opened, mail 10 days old')).toBe(now + 5);
  });
});

describe('prefetch: pauses', () => {
  it('drops the queue when offline and picks it up again online', async () => {
    server = await startFakeImap({
      inbox: Array.from({ length: 6 }, (_, i) => mk(`m${i}`, { ageMs: i * HOUR })),
    });
    h = await createHarness(server, { prefetchGapMs: 300, prefetchStartDelayMs: 0 });
    const acc = await h.addAccount();
    await waitFor('first cached', () => cachedSubjects(h!).length >= 1);
    await h.engine.handle('system.networkChanged', { online: false });
    await settle(400); // a message that was in flight may finish
    const n = cachedSubjects(h).length;
    await settle(800);
    expect(cachedSubjects(h).length).toBe(n);
    expect(n).toBeLessThan(6);
    expect(h.engine.sessions.get(acc.id).getStatus().prefetch).toBeUndefined();
    await h.engine.handle('system.networkChanged', { online: true });
    await waitFor('all cached after reconnect', () => cachedSubjects(h!).length === 6, 40_000);
  });

  it('on battery the backfill waits but new mail still downloads', async () => {
    server = await startFakeImap({ inbox: [mk('Old one'), mk('Old two')] });
    h = await createHarness(server, { prefetchStartDelayMs: 0 });
    await h.engine.handle('system.powerChanged', { onBattery: true });
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 2);
    await waitForInboxCursors(h, [acc.id]);
    await settle(600);
    expect(cachedSubjects(h)).toEqual([]);
    server.deliver('INBOX', mk('Fresh'));
    await waitFor('arrival cached', () => cachedSubjects(h!).includes('Fresh'), 30_000);
    await settle(400);
    expect(cachedSubjects(h)).toEqual(['Fresh']);
    await h.engine.handle('system.powerChanged', { onBattery: false });
    await waitFor('backfill goes on on mains power', () => cachedSubjects(h!).length === 3);
  });

  it('a server rate-limit answer pauses the account for the pause time', async () => {
    let clock = Date.now();
    server = await startFakeImap({ inbox: [mk('One'), mk('Two')] });
    h = await createHarness(server, { now: () => clock, prefetchPauseMs: 600_000 });
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 2);
    await waitForInboxCursors(h, [acc.id]);
    await waitFor('snippets', () => h!.inboxMessages(acc.id).every((m) => m.snippet.length > 0));
    server.rejectNext(['UID FETCH'], { times: 1, text: 'Too many commands, slow down', code: 'THROTTLED' });
    await kickFor(h, 800);
    expect(cachedSubjects(h)).toEqual([]);
    // Still inside the 10 minutes: a new tick does nothing.
    clock += 5 * 60_000;
    h.engine.sessions.prefetchNow();
    await settle(500);
    expect(cachedSubjects(h)).toEqual([]);
    clock += 6 * 60_000;
    await kickUntil(h, 'download resumes after the pause', () => cachedSubjects(h!).length === 2);
  });
});

describe('prefetch: mail that changes while it downloads', () => {
  it('a message deleted on the server is skipped and the download goes on', async () => {
    server = await startFakeImap({ inbox: [mk('First', { ageMs: 1 * HOUR }), mk('Second', { ageMs: 2 * HOUR })] });
    h = await createHarness(server);
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 2);
    await waitForInboxCursors(h, [acc.id]);
    await waitFor('snippets', () => h!.inboxMessages(acc.id).every((m) => m.snippet.length > 0));
    // Gone from the server before the download asks for it (this PC has not synced yet).
    const first = h.inboxMessages(acc.id).find((m) => m.subject === 'First')!;
    await server.expunge('INBOX', first.uid);
    await kickUntil(h, 'Second cached', () => cachedSubjects(h!).includes('Second'));
    expect(cachedSubjects(h)).toEqual(['Second']);
    await settle(300);
    // No retry loop on the missing one.
    expect(q(h, "SELECT body_state FROM message WHERE subject='First'")[0]!.body_state).toBe('none');
  });

  it('a message removed on this PC during the download leaves no body or files behind', async () => {
    server = await startFakeImap({ inbox: [mk('Gone', { ageMs: 1 * HOUR }), mk('Stays', { ageMs: 2 * HOUR })] });
    h = await createHarness(server);
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 2);
    await waitForInboxCursors(h, [acc.id]);
    await waitFor('snippets', () => h!.inboxMessages(acc.id).every((m) => m.snippet.length > 0));
    const held = server.holdCommands(['UID FETCH']);
    await kickUntil(h, 'fetch waits', () => held.held() === 1);
    h.engine.ctx.db.prepare("DELETE FROM message WHERE subject = 'Gone'").run();
    held.release();
    await kickUntil(h, 'other cached', () => cachedSubjects(h!).includes('Stays'));
    expect(q(h, "SELECT COUNT(*) AS n FROM body")[0]!.n).toBe(1);
  });

  it('a rebuilt mailbox (new UIDVALIDITY) never stores the wrong body; the queue is rebuilt from the new rows', async () => {
    server = await startFakeImap({ inbox: [mk('Old A', { ageMs: 1 * HOUR }), mk('Old B', { ageMs: 2 * HOUR })] });
    h = await createHarness(server);
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 2);
    await waitForInboxCursors(h, [acc.id]);
    await waitFor('snippets', () => h!.inboxMessages(acc.id).every((m) => m.snippet.length > 0));
    const held = server.holdCommands(['UID FETCH']);
    await kickUntil(h, 'fetch waits', () => held.held() === 1);
    // The server now holds different mail under the same UIDs.
    server.resetMailbox('INBOX', [mk('New X', { ageMs: 1 * HOUR }), mk('New Y', { ageMs: 2 * HOUR })]);
    held.release();
    await settle(500);
    expect(cachedSubjects(h)).toEqual([]); // nothing from the wrong mailbox
    const inbox = h.folderByRole(acc.id, 'inbox');
    await h.engine.sessions.get(acc.id).syncFolderById(inbox.id);
    await waitFor('rows rebuilt', () => h!.inboxMessages(acc.id).some((m) => m.subject === 'New X'));
    await kickUntil(h, 'new rows cached', () => cachedSubjects(h!).length === 2);
    for (const r of q(h, "SELECT m.subject AS s, b.text_plain AS t FROM message m JOIN body b ON b.message_pk=m.id")) {
      expect((r.t as string).trim()).toBe(`Body of ${r.s as string}`);
    }
  });
});

describe('prefetch: progress text', () => {
  it('shows a count only for a real backfill (more than 20), and clears it when done', async () => {
    server = await startFakeImap({
      inbox: Array.from({ length: 24 }, (_, i) => mk(`p${String(i).padStart(2, '0')}`, { ageMs: i * HOUR })),
    });
    h = await createHarness(server, { prefetchGapMs: 100 });
    const acc = await h.addAccount();
    await waitFor('rows', () => h!.inboxMessages(acc.id).length === 24);
    await waitForInboxCursors(h, [acc.id]);
    expect(h.engine.sessions.get(acc.id).getStatus().prefetch).toBeUndefined();
    let mid: { done: number; total: number } | undefined;
    await kickUntil(h, 'progress appears', () => (mid = h!.engine.sessions.get(acc.id).getStatus().prefetch) !== undefined);
    expect(mid!.total).toBe(24);
    expect(mid!.done).toBeLessThan(24);
    const statuses = (await h.engine.handle('accounts.statuses', undefined)) as AccountStatus[];
    expect(statuses[0]!.prefetch?.total).toBe(24);
    await waitFor('all cached', () => cachedSubjects(h!).length === 24, 40_000);
    await waitFor('progress cleared', () => h!.engine.sessions.get(acc.id).getStatus().prefetch === undefined);
    // The status event after the last message no longer carries it.
    const last = h.eventsOfType('account:status').at(-1)!;
    expect(last.status.prefetch).toBeUndefined();
    expect(h.eventsOfType('account:status').some((e) => e.status.prefetch !== undefined)).toBe(true);
  });

  it('shows nothing for a few messages or a single new one', async () => {
    server = await startFakeImap({ inbox: [mk('a'), mk('b'), mk('c')] });
    h = await createHarness(server, { prefetchStartDelayMs: 0, prefetchGapMs: 100 });
    const acc = await h.addAccount();
    server.deliver('INBOX', mk('d'));
    await waitFor('all cached', () => cachedSubjects(h!).length === 4, 30_000);
    expect(h.eventsOfType('account:status').some((e) => e.status.prefetch !== undefined)).toBe(false);
    expect(h.engine.sessions.get(acc.id).getStatus().prefetch).toBeUndefined();
  });
});
