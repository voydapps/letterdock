// @vitest-environment jsdom
// Replied / forwarded marks in the list and reading pane, and the hover-only quick actions (DESIGN-SPEC 3.16).
import { readFileSync } from 'node:fs';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { ConversationRow, Folder } from '../../src/shared/ipc';
import { conversationItem, type ListItem } from '../../src/renderer/src/store/list';
import { repliedLabel, repliedNote } from '../../src/renderer/src/lib/format';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  id: 1,
  accountId: 1,
  folderId: 5,
  uid: 1,
  messageIdHeader: null,
  subject: 'Hello',
  from: { name: 'Anna', address: 'a@x.example' },
  to: [],
  cc: [],
  date: Date.parse('2026-10-05T10:42:00Z'),
  snippet: 'snip',
  seen: true,
  flagged: false,
  answered: false,
  draft: false,
  hasAttachments: false,
  size: null,
  bodyCached: true,
  threadId: null,
} as unknown as ListItem;

const folder = (role: string): Folder => ({ id: 5, accountId: 1, role, name: role }) as unknown as Folder;

async function renderRow(msg: ListItem, f: Folder | undefined): Promise<HTMLElement> {
  (window as unknown as { api: unknown }).api = { invoke: () => Promise.resolve({}), on: () => () => undefined };
  const { MessageRow } = await import('../../src/renderer/src/features/list/MessageList');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const noop = (): void => undefined;
  await act(async () => {
    createRoot(host).render(
      createElement(MessageRow, {
        msg,
        posinset: 1,
        setsize: 1,
        account: undefined,
        color: '#08f',
        folder: f,
        selected: false,
        focused: false,
        showBadge: false,
        density: 'comfortable',
        terms: [],
        snoozedView: false,
        onClick: noop,
        onMenu: noop,
        onOpen: noop,
      } as never),
    );
  });
  return host;
}

describe('replied and forwarded marks on a row', () => {
  const cases: [string, Partial<ListItem>, string, number][] = [
    ['replied', { answered: true }, 'Replied', 1],
    ['forwarded', { forwarded: true }, 'Forwarded', 1],
    ['both', { answered: true, forwarded: true }, 'Replied and forwarded', 2],
  ];
  for (const [name, flags, text, icons] of cases) {
    it(`shows "${text}" for ${name}`, async () => {
      const host = await renderRow({ ...base, ...flags }, folder('inbox'));
      const mark = host.querySelector('.ico .repl-ic');
      expect(mark?.getAttribute('title')).toBe(text);
      expect(mark?.getAttribute('aria-label')).toBe(text);
      expect(mark?.querySelectorAll('svg')).toHaveLength(icons);
      expect(host.querySelector('.ico')?.firstElementChild).toBe(mark);
      expect(host.querySelector('[role="option"]')?.getAttribute('aria-label')).toContain(text);
    });
  }
  it('shows nothing when neither flag is set', async () => {
    const host = await renderRow(base, folder('inbox'));
    expect(host.querySelector('.repl-ic')).toBeNull();
    expect(host.querySelector('[role="option"]')?.getAttribute('aria-label')).not.toMatch(/Replied|Forwarded/);
  });
  it('is hidden in Sent, Drafts and for a draft', async () => {
    for (const f of [folder('sent'), folder('drafts')]) {
      const host = await renderRow({ ...base, answered: true, forwarded: true }, f);
      expect(host.querySelector('.repl-ic')).toBeNull();
    }
    const host = await renderRow({ ...base, answered: true, draft: true }, folder('inbox'));
    expect(host.querySelector('.repl-ic')).toBeNull();
  });
  it('shows on a conversation row and adds the words to the row label', async () => {
    const conv = {
      threadId: 't',
      accountId: 1,
      count: 3,
      unreadCount: 0,
      hasFlag: false,
      hasAttachment: false,
      participants: [],
      latest: { id: 9, title: 'Thread', from: base.from, date: base.date, snippet: 's', fromMe: false },
      answered: true,
    } as unknown as ConversationRow;
    const item = conversationItem(conv, 5);
    const host = await renderRow(item, folder('inbox'));
    expect(host.querySelector('.repl-ic')?.getAttribute('aria-label')).toBe('Replied');
    expect(host.querySelector('[role="option"]')?.getAttribute('aria-label')).toContain('Replied, conversation with');
  });
});

describe('conversationItem mapping', () => {
  const row = (o: Partial<ConversationRow>): ConversationRow =>
    ({
      threadId: 't',
      accountId: 1,
      count: 2,
      unreadCount: 0,
      hasFlag: false,
      hasAttachment: false,
      participants: [],
      latest: { id: 9, title: 'T', from: null, date: 1, snippet: '', fromMe: false },
      ...o,
    }) as unknown as ConversationRow;
  it('maps answered and forwarded', () => {
    const i = conversationItem(row({ answered: true, forwarded: true }), 0);
    expect(i.answered).toBe(true);
    expect(i.forwarded).toBe(true);
  });
  it('leaves them off when the conversation has no mark', () => {
    const i = conversationItem(row({}), 0);
    expect(i.answered).toBe(false);
    expect('forwarded' in i).toBe(false);
  });
});

describe('texts', () => {
  it('has the labels and reading pane lines', () => {
    expect(repliedLabel(false, false)).toBe('');
    expect(repliedNote(true, false)).toBe('You replied to this message.');
    expect(repliedNote(false, true)).toBe('You forwarded this message.');
    expect(repliedNote(true, true)).toBe('You replied to and forwarded this message.');
    expect(repliedNote(false, false)).toBe('');
  });
});

describe('reading pane line', () => {
  it('renders a note with the text and nothing when neither flag is set', async () => {
    (window as unknown as { api: unknown }).api = { invoke: () => Promise.resolve({}), on: () => () => undefined };
    const { RepliedNote } = await import('../../src/renderer/src/features/reading/notices');
    const host = document.createElement('div');
    await act(async () => {
      createRoot(host).render(createElement(RepliedNote, { answered: true, forwarded: true }));
    });
    expect(host.querySelector('[role="note"]')?.textContent).toBe('You replied to and forwarded this message.');
    const empty = document.createElement('div');
    await act(async () => {
      createRoot(empty).render(createElement(RepliedNote, {}));
    });
    expect(empty.innerHTML).toBe('');
  });
});

describe('hover-only quick actions (CSS)', () => {
  const css = readFileSync('src/renderer/src/styles/app.css', 'utf8');
  it('shows the panel only on hover', () => {
    expect(css).toMatch(/\.row:hover \.hov\s*\{\s*display: flex;/);
    expect(css).not.toMatch(/\.row:focus-within \.hov/);
    expect(css).not.toMatch(/\.row\.focus \.hov/);
  });
  it('hides the panel when the device cannot hover', () => {
    expect(css).toMatch(/@media \(hover: none\)\s*\{\s*\.row \.hov\s*\{\s*display: none !important;/);
  });
  it('still hides the date and icons under the panel on hover', () => {
    expect(css).toMatch(/\.row:hover \.tm,\s*\.row:hover \.ico\s*\{\s*visibility: hidden;/);
  });
});
