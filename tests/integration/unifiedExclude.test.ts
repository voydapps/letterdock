// Engine integration: "Mute in All inboxes" (Account.inUnified = false, DESIGN-SPEC 2 sidebar rules).
// Two accounts on one fake server, so both Inboxes hold the same four messages. The excluded account
// disappears from every unified view, count and notification; its own folders are not touched.
import { afterEach, describe, expect, it } from 'vitest';
import { scopeFilter } from '../../src/engine/db/repos/messageRepo';
import type {
  Account,
  FolderCounts,
  ListConversationsRes,
  ListMessagesRes,
  ListScope,
  SearchRes,
} from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let server: FakeImapServer | null = null;
let h: Harness | null = null;
const clock = { offset: 0, now: () => Date.now() + clock.offset };
const HOUR = 3_600_000;

afterEach(async () => {
  await h?.cleanup();
  await server?.close().catch(() => undefined);
  h = server = null;
  clock.offset = 0;
});

const ago = (hours: number) => new Date(Date.now() - hours * HOUR);
const call = <T>(ch: string, req?: unknown) => h!.engine.handle(ch, req) as Promise<T>;

async function boot() {
  server = await startFakeImap({
    inbox: [
      { raw: rawMessage({ subject: 'Plan', messageId: '<p1@x>', date: ago(10), from: 'Alice <alice@example.com>' }), flags: ['\\Seen', '\\Flagged'] },
      { raw: rawMessage({ subject: 'Lunch', messageId: '<l1@x>', date: ago(9), from: 'Carol <carol@example.com>' }) },
      { raw: rawMessage({ subject: 'Invoice', messageId: '<i1@x>', date: ago(8), from: 'Dan <dan@example.com>' }), flags: ['\\Flagged'] },
      { raw: rawMessage({ subject: 'News', messageId: '<n1@x>', date: ago(7), from: 'Eve <eve@example.com>' }), flags: ['\\Seen'] },
    ],
  });
  h = await createHarness(server, { now: clock.now });
  const a = await h.addAccount({ email: 'a@example.com', displayName: 'Alpha' });
  const b = await h.addAccount({ email: 'b@example.com', displayName: 'Beta' });
  await waitFor('both synced', () => h!.inboxMessages(a.id).length === 4 && h!.inboxMessages(b.id).length === 4);
  await waitFor('quiet', () => h!.engine.sessions.statuses().every((s) => s.state === 'online'));
  await h.engine.actions.drain();
  return { a, b };
}

const setIn = (accountId: string, inUnified: boolean) =>
  call<Account>('accounts.update', { accountId, patch: { inUnified } });
const msgs = (scope: ListScope, over: object = {}) =>
  call<ListMessagesRes>('messages.list', { scope, cursor: null, limit: 50, ...over });
const convs = (scope: ListScope, over: object = {}) =>
  call<ListConversationsRes>('conversations.list', { scope, cursor: null, limit: 50, ...over });
const accountsOf = (items: { accountId: string }[]) => [...new Set(items.map((m) => m.accountId))].sort();
const idOf = (accountId: string, subject: string) =>
  (h!.engine.ctx.db.prepare('SELECT id FROM message WHERE account_id = ? AND subject = ?').get(accountId, subject) as { id: number }).id;
const U: ListScope = { kind: 'unifiedInbox' };
const UU: ListScope = { kind: 'unifiedUnread' };
const UF: ListScope = { kind: 'unifiedFlagged' };

describe('Account.inUnified', () => {
  it('is true by default, can be changed with accounts.update and is kept', async () => {
    const { a, b } = await boot();
    expect(a.inUnified).toBe(true);
    expect((await setIn(b.id, false)).inUnified).toBe(false);
    const list = await call<Account[]>('accounts.list');
    expect(list.map((x) => x.inUnified)).toEqual([true, false]);
    expect((await setIn(b.id, true)).inUnified).toBe(true);
  });
});

describe('unified views without the excluded account', () => {
  it('messages: All inboxes, Unread and Flagged leave it out, with totals; toggling back restores them', async () => {
    const { a, b } = await boot();
    expect((await msgs(U)).total).toBe(8);
    expect((await msgs(UU)).total).toBe(4);
    expect((await msgs(UF)).items).toHaveLength(4);

    await setIn(b.id, false);
    const all = await msgs(U);
    expect(accountsOf(all.items)).toEqual([a.id]);
    expect(all.items).toHaveLength(4);
    expect(all.total).toBe(4);
    const unread = await msgs(UU);
    expect(accountsOf(unread.items)).toEqual([a.id]);
    expect(unread.total).toBe(2);
    expect((await msgs(U, { unreadOnly: true })).total).toBe(2);
    const flagged = await msgs(UF);
    expect(accountsOf(flagged.items)).toEqual([a.id]);
    expect(flagged.items.map((m) => m.subject).sort()).toEqual(['Invoice', 'Plan']);

    // The account's own Inbox and folder views are not affected.
    const own = await msgs({ kind: 'accountInbox', accountId: b.id });
    expect(own.items).toHaveLength(4);
    expect(own.total).toBe(4);
    const inbox = h!.folderByRole(b.id, 'inbox');
    expect((await msgs({ kind: 'folder', folderId: inbox.id })).items).toHaveLength(4);
    expect((await msgs({ kind: 'accountInbox', accountId: b.id }, { unreadOnly: true })).total).toBe(2);

    await setIn(b.id, true);
    expect((await msgs(U)).total).toBe(8);
    expect((await msgs(UU)).total).toBe(4);
    expect((await msgs(UF)).items).toHaveLength(4);
  });

  it('paging stays correct (a second page never shows the excluded account)', async () => {
    const { a, b } = await boot();
    await setIn(b.id, false);
    const p1 = await msgs(U, { limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await msgs(U, { limit: 3, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(accountsOf([...p1.items, ...p2.items])).toEqual([a.id]);
  });

  it('conversations: the same, and the own Inbox still lists them', async () => {
    const { a, b } = await boot();
    expect((await convs(U)).items).toHaveLength(8);
    await setIn(b.id, false);
    const all = await convs(U);
    expect(all.items).toHaveLength(4);
    expect(accountsOf(all.items)).toEqual([a.id]);
    expect(all.total).toBe(4);
    const unread = await convs(UU);
    expect(accountsOf(unread.items)).toEqual([a.id]);
    expect(unread.items).toHaveLength(2);
    const flagged = await convs(UF);
    expect(accountsOf(flagged.items)).toEqual([a.id]);
    expect(flagged.items).toHaveLength(2);
    expect((await convs({ kind: 'accountInbox', accountId: b.id })).items).toHaveLength(4);
    await setIn(b.id, true);
    expect((await convs(U)).items).toHaveLength(8);
  });

  it('pinned and returned-from-snooze groups leave the excluded account out', async () => {
    const { a, b } = await boot();
    for (const acc of [a, b]) {
      await call('pin.set', { messageIds: [idOf(acc.id, 'Plan')], pinned: true });
      await call('snooze.set', { messageIds: [idOf(acc.id, 'Lunch')], until: clock.now() + HOUR });
    }
    clock.offset = 2 * HOUR;
    await h!.engine.light.snooze.recheck();

    const both = await msgs(U);
    expect(both.pinned!.map((m) => m.accountId).sort()).toEqual([a.id, b.id].sort());
    expect(both.items.filter((m) => m.snoozeReturnedAt !== undefined)).toHaveLength(2);

    await setIn(b.id, false);
    const only = await msgs(U);
    expect(only.pinned!.map((m) => m.accountId)).toEqual([a.id]);
    expect(only.items.filter((m) => m.snoozeReturnedAt !== undefined).map((m) => m.accountId)).toEqual([a.id]);
    expect(accountsOf(only.items)).toEqual([a.id]);
    // Conversation mode: the pinned and returned groups too.
    const c = await convs(U);
    expect(accountsOf(c.items)).toEqual([a.id]);
    expect(accountsOf(c.pinned ?? [])).toEqual([a.id]);
    // Its own Inbox still has its pin and its returned message.
    const own = await msgs({ kind: 'accountInbox', accountId: b.id });
    expect(own.pinned).toHaveLength(1);
    expect(own.items.filter((m) => m.snoozeReturnedAt !== undefined)).toHaveLength(1);
  });

  it('Mark all read in a unified view does not touch the excluded account', async () => {
    const { a, b } = await boot();
    await setIn(b.id, false);
    await call('messages.markAllRead', { scope: UU });
    await h!.engine.actions.drain();
    expect((await msgs({ kind: 'accountInbox', accountId: a.id }, { unreadOnly: true })).total).toBe(0);
    expect((await msgs({ kind: 'accountInbox', accountId: b.id }, { unreadOnly: true })).total).toBe(2);
  });

  it('search still finds mail of an excluded account (search is an explicit action)', async () => {
    const { b } = await boot();
    await setIn(b.id, false);
    const res = await call<SearchRes>('search.local', { query: 'Invoice', limit: 50, offset: 0 });
    expect(res.items.some((m) => m.accountId === b.id)).toBe(true);
  });
});

describe('counts', () => {
  it('unifiedInboxUnread drops the account; its folder counts stay; a counts:changed event is sent', async () => {
    const { b } = await boot();
    expect((await call<FolderCounts>('folders.counts')).unifiedInboxUnread).toBe(4);
    h!.events.length = 0;
    await setIn(b.id, false);
    const c = await call<FolderCounts>('folders.counts');
    expect(c.unifiedInboxUnread).toBe(2);
    const bInbox = h!.folderByRole(b.id, 'inbox');
    expect(c.perFolder.find((f) => f.folderId === bInbox.id)!.unread).toBe(2);
    await waitFor('counts event', () =>
      h!.eventsOfType('counts:changed').some((e) => e.unifiedInboxUnread === 2),
    );
    expect(h!.eventsOfType('accounts:changed').length).toBeGreaterThan(0);
    await setIn(b.id, true);
    expect((await call<FolderCounts>('folders.counts')).unifiedInboxUnread).toBe(4);
  });
});

describe('notifications', () => {
  it('new mail of an excluded account is not announced; the others are; including it again announces it', async () => {
    const { a, b } = await boot();
    await setIn(b.id, false);
    h!.events.length = 0;
    server!.deliver('INBOX', { raw: rawMessage({ subject: 'Fresh 1', from: 'Bob <bob@example.com>' }) });
    await waitFor('a announced', () => h!.eventsOfType('notify:newMail').some((e) => e.accountId === a.id));
    await waitFor('b synced', () => h!.inboxMessages(b.id).length === 5);
    await new Promise((r) => setTimeout(r, 400));
    expect(h!.eventsOfType('notify:newMail').map((e) => e.accountId)).toEqual([a.id]);

    await setIn(b.id, true);
    h!.events.length = 0;
    server!.deliver('INBOX', { raw: rawMessage({ subject: 'Fresh 2', from: 'Bob <bob@example.com>' }) });
    await waitFor('both announced', () => new Set(h!.eventsOfType('notify:newMail').map((e) => e.accountId)).size === 2);
  });

  it('snoozed mail coming back is not announced for an excluded account (the lists still refresh)', async () => {
    const { a, b } = await boot();
    for (const acc of [a, b]) {
      await call('snooze.set', { messageIds: [idOf(acc.id, 'Plan')], until: clock.now() + HOUR });
    }
    await setIn(b.id, false);
    h!.events.length = 0;
    clock.offset = 2 * HOUR;
    await h!.engine.light.snooze.recheck();
    expect(h!.eventsOfType('snooze:returned').map((e) => e.accountId)).toEqual([a.id]);
    expect(h!.eventsOfType('snooze:changed').map((e) => e.accountId).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('query plans', () => {
  it('the unified list uses the same indexes with and without an excluded account', async () => {
    const { b } = await boot();
    const db = h!.engine.ctx.db;
    const plan = (excluded: string[]) => {
      const f = scopeFilter({ kind: 'unifiedInbox' }, false, excluded);
      return (
        db
          .prepare(`EXPLAIN QUERY PLAN SELECT m.* ${f.from} WHERE ${f.where} ORDER BY m.date_ms DESC, m.id DESC LIMIT 51`)
          .all(f.params) as { detail: string }[]
      ).map((r) => r.detail);
    };
    const indexes = (rows: string[]) =>
      rows.flatMap((d) => [...d.matchAll(/USING (?:COVERING )?INDEX (\w+)/g)].map((m) => m[1]!)).sort();
    const without = plan([]);
    const withEx = plan([b.id]);
    expect(indexes(withEx)).toEqual(indexes(without));
    expect(indexes(without).length).toBeGreaterThan(0);
  });
});
