// @vitest-environment jsdom
// "Mark as unread" on the message you are reading stays. The auto mark-as-read timer starts when a message is
// opened (selection change), not each time its seen flag changes.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/main/settings';
import type { MessageHeader } from '../../src/shared/ipc';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const header = (id: number, seen: boolean): MessageHeader =>
  ({
    id,
    accountId: 'a1',
    folderId: 'f1',
    uid: id,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: 'Sender', address: 's@example.com' },
    to: [],
    cc: [],
    date: 1_700_000_000_000 + id,
    snippet: 'snippet',
    seen,
    flagged: false,
    answered: false,
    draft: false,
    hasAttachments: false,
    size: 10,
    bodyCached: true,
    threadId: `t${id}`,
  }) as unknown as MessageHeader;

/** What the "server" thinks, per message id. The fake `messages.apply` changes it. */
const server = new Map<number, boolean>();
const applied: { id: number; read: boolean }[] = [];
let convSeen: Record<number, boolean> = {};
let bodyDelay = 0;

function installApi() {
  (window as unknown as { api: unknown }).api = {
    invoke: (channel: string, req: Record<string, unknown>) => {
      if (channel === 'messages.get') {
        const id = req.messageId as number;
        return new Promise((resolve) => setTimeout(resolve, bodyDelay)).then(() => ({
          id,
          header: header(id, server.get(id) ?? false),
          bcc: [],
          replyTo: [],
          inReplyTo: null,
          references: null,
          html: null,
          text: 'Hello',
          attachments: [],
          hasRemoteImages: false,
          senderImagesAllowed: false,
          truncated: false,
        }));
      }
      if (channel === 'messages.apply') {
        const action = req.action as { type: string; read?: boolean };
        const ids = req.messageIds as number[];
        if (action.type === 'markRead') {
          for (const id of ids) {
            applied.push({ id, read: !!action.read });
            server.set(id, !!action.read);
            convSeen[id] = !!action.read;
          }
        }
        return Promise.resolve({ succeeded: ids, failed: [] });
      }
      if (channel === 'conversations.get') {
        const msgs = [11, 12].map((id) => ({
          header: header(id, convSeen[id] ?? id === 11),
          folderId: 'f1',
          folderRole: 'inbox',
          folderName: 'Inbox',
          inCurrentFolder: true,
          isDraft: false,
          fromMe: false,
        }));
        return Promise.resolve({ threadId: 't1', accountId: 'a1', subject: 'Thread', count: 2, messages: msgs });
      }
      return Promise.resolve([]);
    },
    on: () => () => undefined,
  };
}

async function setup(markReadDelayMs: number) {
  const { useApp } = await import('../../src/renderer/src/store/app');
  useApp.setState({
    settings: { ...DEFAULT_SETTINGS, markReadDelayMs },
    accounts: [{ id: 'a1', email: 's@example.com', displayName: 'A', enabled: true, inUnified: true }] as never,
    folders: [{ id: 'f1', accountId: 'a1', role: 'inbox', name: 'Inbox' }] as never,
  });
  return useApp;
}

async function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return { host, root };
}

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  server.clear();
  applied.length = 0;
  convSeen = {};
  bodyDelay = 0;
  installApi();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('single message: auto mark as read vs Mark as unread', () => {
  it('reads after the delay, stays unread after a manual Mark as unread, and reads again when opened anew', async () => {
    await setup(1500);
    const { useList } = await import('../../src/renderer/src/store/list');
    const { ReadingPane } = await import('../../src/renderer/src/features/reading/ReadingPane');
    const { applyToMessages } = await import('../../src/renderer/src/lib/actions');
    server.set(1, false);
    server.set(2, true);
    useList.setState({ items: [header(1, false), header(2, true)] as never, selectedIds: [1] });
    const { root } = await mount(createElement(ReadingPane));
    await tick(100); // the body loads

    await tick(1000);
    expect(applied).toEqual([]); // not yet
    await tick(600);
    expect(applied).toEqual([{ id: 1, read: true }]);
    expect(useList.getState().items[0]!.seen).toBe(true);

    // The user marks it unread (Ctrl+U, the toolbar or the menu all run this action).
    await act(async () => {
      await applyToMessages([1], { type: 'markRead', read: false });
    });
    expect(useList.getState().items[0]!.seen).toBe(false);
    await tick(5000);
    expect(applied).toEqual([
      { id: 1, read: true },
      { id: 1, read: false },
    ]);
    expect(useList.getState().items[0]!.seen).toBe(false);

    // Another message and back: opening it anew starts the timer again.
    await act(async () => useList.setState({ selectedIds: [2] }));
    await tick(100);
    await act(async () => useList.setState({ selectedIds: [1] }));
    await tick(100);
    await tick(1600);
    expect(applied[applied.length - 1]).toEqual({ id: 1, read: true });
    expect(useList.getState().items[0]!.seen).toBe(true);
    await act(async () => root.unmount());
  });

  it('Mark as read then unread before the delay is over cancels the pending timer', async () => {
    await setup(1500);
    const { useList } = await import('../../src/renderer/src/store/list');
    const { ReadingPane } = await import('../../src/renderer/src/features/reading/ReadingPane');
    server.set(1, false);
    useList.setState({ items: [header(1, false)] as never, selectedIds: [1] });
    const { root } = await mount(createElement(ReadingPane));
    await tick(500);
    await act(async () => useList.getState().patch([1], { seen: true }));
    await act(async () => useList.getState().patch([1], { seen: false }));
    await tick(5000);
    expect(applied).toEqual([]);
    await act(async () => root.unmount());
  });

  it('Mark as unread while the body is still loading is not undone when the body arrives', async () => {
    await setup(1500);
    bodyDelay = 500;
    const { useList } = await import('../../src/renderer/src/store/list');
    const { ReadingPane } = await import('../../src/renderer/src/features/reading/ReadingPane');
    server.set(1, true);
    useList.setState({ items: [header(1, true)] as never, selectedIds: [1] });
    const { root } = await mount(createElement(ReadingPane));
    await tick(100);
    await act(async () => useList.getState().patch([1], { seen: false })); // Ctrl+U before the body is here
    await tick(500); // the body arrives
    await tick(5000);
    expect(applied).toEqual([]);
    expect(useList.getState().items[0]!.seen).toBe(false);
    await act(async () => root.unmount());
  });

  it('"Immediately" reads at once and lets Mark as unread stay; "Never" does not read', async () => {
    await setup(0);
    const { useList } = await import('../../src/renderer/src/store/list');
    const { ReadingPane } = await import('../../src/renderer/src/features/reading/ReadingPane');
    const { applyToMessages } = await import('../../src/renderer/src/lib/actions');
    const { useApp } = await import('../../src/renderer/src/store/app');
    server.set(1, false);
    useList.setState({ items: [header(1, false)] as never, selectedIds: [1] });
    const { root } = await mount(createElement(ReadingPane));
    await tick(100);
    await tick(100);
    expect(applied).toEqual([{ id: 1, read: true }]);
    await act(async () => {
      await applyToMessages([1], { type: 'markRead', read: false });
    });
    await tick(5000);
    expect(useList.getState().items[0]!.seen).toBe(false);
    expect(applied.length).toBe(2);
    await act(async () => root.unmount());

    applied.length = 0;
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, markReadDelayMs: -1 } });
    useList.setState({ items: [header(1, false)] as never, selectedIds: [1] });
    const second = await mount(createElement(ReadingPane));
    await tick(5000);
    expect(applied).toEqual([]);
    await act(async () => second.root.unmount());
  });
});

describe('conversation card: auto mark as read vs Mark as unread', () => {
  it('reads the open unread card after the delay and does not read it again after it is marked unread', async () => {
    const useApp = await setup(1500);
    // The card waits until it is at least half visible.
    class IO {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() {
        this.cb([{ isIntersecting: true, intersectionRatio: 1 }]);
      }
      disconnect() {}
      unobserve() {}
    }
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO;
    const { ConversationView } = await import('../../src/renderer/src/features/reading/ConversationView');
    const { applyToRealMessages } = await import('../../src/renderer/src/lib/actions');
    const { useList } = await import('../../src/renderer/src/store/list');
    useList.setState({ items: [], selectedIds: [] });
    const reload = () => act(async () => useApp.setState({ epoch: useApp.getState().epoch + 1 }));

    const { host, root } = await mount(createElement(ConversationView, { threadId: 't1', accountId: 'a1' }));
    await tick(100);
    const card = () => host.querySelector('section[data-mid="12"]')!;
    expect(card().classList.contains('unread')).toBe(true);
    await tick(1000);
    expect(applied).toEqual([]);
    await tick(600);
    expect(applied).toEqual([{ id: 12, read: true }]);
    await reload();
    await tick(300);
    expect(card().classList.contains('unread')).toBe(false);

    // Mark it unread; the conversation reloads from the engine.
    await act(async () => {
      await applyToRealMessages([12], { type: 'markRead', read: false });
    });
    await reload();
    await tick(300);
    await tick(5000);
    expect(applied).toEqual([
      { id: 12, read: true },
      { id: 12, read: false },
    ]);
    expect(card().classList.contains('unread')).toBe(true);

    // Close the card and open it again: the timer runs again.
    await act(async () => card().querySelector<HTMLButtonElement>('button.chead')!.click());
    await tick(100);
    await act(async () => card().querySelector<HTMLButtonElement>('button.chead')!.click());
    await tick(1700);
    expect(applied[applied.length - 1]).toEqual({ id: 12, read: true });
    await act(async () => root.unmount());
  });
});
