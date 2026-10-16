// @vitest-environment jsdom
// In an unread-only list, the message you are reading stays in the list (shown as read) when it becomes read.
// It leaves when you move to another message or change the view. Marking several rows read at once is an
// explicit bulk action: those rows leave at once.
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationRow, MessageHeader } from '../../src/shared/ipc';

const header = (id: number, seen: boolean): MessageHeader =>
  ({
    id,
    accountId: 'a1',
    folderId: 1,
    uid: id,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: 'Sender', address: 's@example.com' },
    to: [],
    cc: [],
    date: 1_700_000_000_000 - id * 1000, // lower id = newer, so the order is 1, 2, 3 ...
    snippet: 's',
    seen,
    flagged: false,
    answered: false,
    draft: false,
    hasAttachments: false,
    size: 10,
    bodyCached: true,
    threadId: `t${id}`,
  }) as unknown as MessageHeader;

const IDS = [1, 2, 3, 4, 5];
const read = new Set<number>();
function setRead(id: number, on: boolean) {
  if (on) read.add(id);
  else read.delete(id);
}
const searchHits = [1, 2, 3];

function conv(id: number): ConversationRow {
  const h = header(id, false);
  return {
    threadId: `t${id}`,
    accountId: 'a1',
    messageIds: [id],
    unreadCount: read.has(id) ? 0 : 1,
    hasFlag: false,
    hasAttachment: false,
    latest: { id, title: h.subject, from: h.from, date: h.date, snippet: 's' },
  } as unknown as ConversationRow;
}

function installApi() {
  (window as unknown as { api: unknown }).api = {
    invoke: (channel: string, req: Record<string, unknown>) => {
      if (channel === 'messages.list' || channel === 'conversations.list') {
        const unreadOnly = req.unreadOnly === true || (req.scope as { kind: string }).kind === 'unifiedUnread';
        const ids = IDS.filter((id) => !unreadOnly || !read.has(id));
        const items = channel === 'messages.list' ? ids.map((id) => header(id, read.has(id))) : ids.map(conv);
        return Promise.resolve({ items, nextCursor: null, canLoadOlderFromServer: false, total: items.length });
      }
      if (channel === 'search.local') {
        const items = searchHits.filter((id) => !read.has(id)).map((id, i) => ({ ...header(id, false), rank: i }));
        return Promise.resolve({ items, parsedFilters: [], totalApprox: items.length, coverage: { messagesIndexed: 0, bodiesIndexed: 0 } });
      }
      if (channel === 'messages.apply') {
        const action = req.action as { type: string; read?: boolean };
        for (const id of req.messageIds as number[]) if (action.type === 'markRead') setRead(id, !!action.read);
        return Promise.resolve({ succeeded: req.messageIds, failed: [] });
      }
      if (channel === 'conversations.act') {
        const action = req.action as { type: string; read?: boolean };
        for (const t of req.threadIds as string[]) {
          const id = Number(t.slice(1));
          if (action.type === 'markRead') setRead(id, !!action.read);
        }
        return Promise.resolve({ succeeded: req.threadIds, failed: [], messageCount: 1 });
      }
      return Promise.resolve([]);
    },
    on: () => () => undefined,
  };
}

const mods = async () => ({
  list: (await import('../../src/renderer/src/store/list')).useList,
  actions: await import('../../src/renderer/src/lib/actions'),
  app: (await import('../../src/renderer/src/store/app')).useApp,
});

const ids = (l: { getState: () => { items: { id: number }[] } }) => l.getState().items.map((m) => m.id);

beforeEach(async () => {
  read.clear();
  installApi();
  const { list, app } = await mods();
  app.setState({
    settings: { groupConversations: false } as never,
    folders: [{ id: 1, accountId: 'a1', role: 'inbox', name: 'Inbox' }] as never,
  });
  list.setState({ key: '', items: [], selectedIds: [], stickyIds: [], search: null, scope: null, anchorId: null, focusId: null });
});

describe('open message stays in an unread-only list', () => {
  it('Unread view: read while open -> stays (as read); moving to the next one removes it', async () => {
    const { list, actions } = await mods();
    await list.getState().load({ kind: 'unread' }, false);
    expect(ids(list)).toEqual([1, 2, 3, 4, 5]);
    list.getState().selectOnly(2);
    await actions.applyToMessages([2], { type: 'markRead', read: true }); // the auto mark-as-read
    await list.getState().refresh(); // messages:changed
    expect(ids(list)).toEqual([1, 2, 3, 4, 5]);
    expect(list.getState().items.find((m) => m.id === 2)!.seen).toBe(true);
    // A later reload (for example another event) keeps it too.
    await list.getState().refresh();
    expect(ids(list)).toEqual([1, 2, 3, 4, 5]);
    // Keyboard "next": the row below the open one. The open one then leaves.
    const { items, focusId } = list.getState();
    const next = items[items.findIndex((m) => m.id === (focusId ?? 2)) + 1]!;
    list.getState().selectOnly(next.id);
    expect(next.id).toBe(3);
    expect(ids(list)).toEqual([1, 3, 4, 5]);
    await actions.applyToMessages([3], { type: 'markRead', read: true });
    await list.getState().refresh();
    expect(ids(list)).toEqual([1, 3, 4, 5]);
    list.getState().selectOnly(4);
    expect(ids(list)).toEqual([1, 4, 5]);
  });

  it('marking read from the toolbar on the open message behaves the same', async () => {
    const { list, actions } = await mods();
    await list.getState().load({ kind: 'unread' }, false);
    list.getState().selectOnly(1);
    await actions.applyToMessages([1], { type: 'markRead', read: true });
    await list.getState().refresh();
    expect(ids(list)).toEqual([1, 2, 3, 4, 5]);
    // Mark as unread again: it is a normal unread row and not sticky.
    await actions.applyToMessages([1], { type: 'markRead', read: false });
    await list.getState().refresh();
    expect(list.getState().items[0]!.seen).toBe(false);
    list.getState().selectOnly(2);
    expect(ids(list)).toEqual([1, 2, 3, 4, 5]);
  });

  it('"Filter: Unread" on a folder', async () => {
    const { list, actions } = await mods();
    await list.getState().load({ kind: 'folder', folderId: 1 }, true);
    list.getState().selectOnly(3);
    await actions.applyToMessages([3], { type: 'markRead', read: true });
    await list.getState().refresh();
    expect(ids(list)).toEqual([1, 2, 3, 4, 5]);
    list.getState().selectOnly(4);
    expect(ids(list)).toEqual([1, 2, 4, 5]);
  });

  it('an unfiltered folder list is untouched', async () => {
    const { list, actions } = await mods();
    await list.getState().load({ kind: 'folder', folderId: 1 }, false);
    list.getState().selectOnly(3);
    await actions.applyToMessages([3], { type: 'markRead', read: true });
    await list.getState().refresh();
    expect(ids(list)).toEqual([1, 2, 3, 4, 5]);
    expect(list.getState().stickyIds).toEqual([]);
  });

  it('conversations: a conversation that is fully read stays until you move on', async () => {
    const { list, actions, app } = await mods();
    app.setState({ settings: { groupConversations: true } as never });
    await list.getState().load({ kind: 'unread' }, false);
    expect(list.getState().grouped).toBe(true);
    list.getState().selectOnly(2);
    await actions.applyToMessages([2], { type: 'markRead', read: true });
    await list.getState().refresh();
    expect(ids(list)).toEqual([1, 2, 3, 4, 5]);
    expect(list.getState().items[1]!.conv!.unreadCount).toBe(0);
    list.getState().selectOnly(3);
    expect(ids(list)).toEqual([1, 3, 4, 5]);
  });

  it('search with is:unread', async () => {
    const { list, actions } = await mods();
    await list.getState().load({ kind: 'search', query: 'is:unread hello', accountId: null }, false);
    expect(ids(list)).toEqual([1, 2, 3]);
    list.getState().selectOnly(2);
    await actions.applyToMessages([2], { type: 'markRead', read: true });
    await list.getState().refresh();
    expect(ids(list)).toEqual([1, 2, 3]);
    list.getState().selectOnly(3);
    expect(ids(list)).toEqual([1, 3]);
  });

  it('bulk mark as read: the selected rows leave at once (nothing is open)', async () => {
    const { list, actions } = await mods();
    await list.getState().load({ kind: 'unread' }, false);
    list.getState().selectOnly(1);
    list.getState().toggle(2);
    list.getState().toggle(3);
    await actions.applyToMessages([1, 2, 3], { type: 'markRead', read: true });
    await list.getState().refresh();
    expect(ids(list)).toEqual([4, 5]);
  });

  it('marking others read while one stays open: the open one stays, the others leave', async () => {
    const { list, actions } = await mods();
    await list.getState().load({ kind: 'unread' }, false);
    list.getState().selectOnly(2); // 2 is open
    await actions.applyToMessages([2, 4, 5], { type: 'markRead', read: true });
    await list.getState().refresh();
    expect(ids(list)).toEqual([1, 2, 3]);
  });

  it('open row is read (sticky), then a multi-selection is marked read: the kept row stays while selected, the other leaves', async () => {
    const { list, actions } = await mods();
    await list.getState().load({ kind: 'unread' }, false);
    list.getState().selectOnly(2);
    await actions.applyToMessages([2], { type: 'markRead', read: true });
    await list.getState().refresh();
    list.getState().toggle(3); // now two rows are selected, nothing is "open"
    await actions.applyToMessages([2, 3], { type: 'markRead', read: true });
    await list.getState().refresh();
    expect(ids(list)).toEqual([1, 2, 3, 4, 5].filter((i) => ![3].includes(i)));
  });

  it('switching view drops the kept row', async () => {
    const { list, actions } = await mods();
    await list.getState().load({ kind: 'unread' }, false);
    list.getState().selectOnly(2);
    await actions.applyToMessages([2], { type: 'markRead', read: true });
    await list.getState().refresh();
    expect(ids(list)).toContain(2);
    await list.getState().load({ kind: 'folder', folderId: 1 }, false);
    await list.getState().load({ kind: 'unread' }, false);
    expect(ids(list)).toEqual([1, 3, 4, 5]);
    expect(list.getState().stickyIds).toEqual([]);
  });

  it('leaving the selection empty (Escape) also drops it', async () => {
    const { list, actions } = await mods();
    await list.getState().load({ kind: 'unread' }, false);
    list.getState().selectOnly(2);
    await actions.applyToMessages([2], { type: 'markRead', read: true });
    await list.getState().refresh();
    list.getState().clearSelection();
    expect(ids(list)).toEqual([1, 3, 4, 5]);
  });
});
