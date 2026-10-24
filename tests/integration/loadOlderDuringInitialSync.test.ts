// "Load older" while the first sync of the same account is still running (200 messages).
// Kept in its own file: a worker crash seen in this situation must not take other tests down.
// The first sync writes the folder cursors last, so "load older" has to wait for it.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

const DAY = 86_400_000;
const RECENT = 150;
const OLD = 50;
let server: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await server?.close().catch(() => undefined);
  h = server = null;
});

/** 150 messages inside the 30-day window and 50 far outside it (only "load older" fetches them). */
async function start(): Promise<void> {
  const now = Date.now();
  const msg = (i: number, daysAgo: number) => ({
    raw: rawMessage({
      subject: `M ${i}`,
      messageId: `<m${i}@fake.test>`,
      date: new Date(now - daysAgo * DAY - i * 1000),
    }),
    internaldate: new Date(now - daysAgo * DAY - i * 1000),
  });
  server = await startFakeImap({
    inbox: [
      ...Array.from({ length: OLD }, (_, i) => msg(i, 400)),
      ...Array.from({ length: RECENT }, (_, i) => msg(OLD + i, 2)),
    ],
  });
  h = await createHarness(server, { prefetchGapMs: 0 });
}

describe('loadOlder during the first sync', () => {
  it('waits for the first sync, then fetches the older page; history is not marked complete early', async () => {
    await start();
    const a = await h!.addAccount({ syncDays: 30 });
    await waitFor('first rows', () => h!.inboxMessages(a.id).length > 0);
    const inboxId = h!.folderByRole(a.id, 'inbox').id;
    // The first sync is not over: the cursors are still missing.
    expect(h!.engine.ctx.folders.syncState(inboxId)!.oldestSyncedUid).toBeNull();

    const res = (await h!.engine.handle('sync.loadOlder', { folderId: inboxId })) as {
      fetched: number;
      reachedStart: boolean;
    };
    expect(res).toEqual({ fetched: OLD, reachedStart: true });
    expect(h!.inboxMessages(a.id)).toHaveLength(RECENT + OLD);
    expect(h!.engine.ctx.folders.syncState(inboxId)!.historyComplete).toBe(true);
  });

  it('a second request for the same folder shares the running one; nothing is stored twice', async () => {
    await start();
    const a = await h!.addAccount({ syncDays: 30 });
    await waitFor('first rows', () => h!.inboxMessages(a.id).length > 0);
    const inboxId = h!.folderByRole(a.id, 'inbox').id;
    const calls = Array.from({ length: 4 }, async (_, i) => {
      await new Promise((r) => setTimeout(r, i * 3));
      return h!.engine.handle('sync.loadOlder', { folderId: inboxId });
    });
    const results = await Promise.all(calls);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(h!.inboxMessages(a.id)).toHaveLength(RECENT + OLD);
  });

  it('without cursors it neither fetches nor claims the start of the mailbox', async () => {
    await start();
    const a = await h!.addAccount({ syncDays: 30 });
    const inboxId = await waitFor('inbox row', () => h!.folderByRole(a.id, 'inbox').id);
    // Ask the lowest level directly: whatever the sync state, a folder without cursors is untouched.
    const { loadOlder } = await import('../../src/engine/imap/syncFolder');
    h!.engine.ctx.folders.resetSyncState(inboxId);
    const r = await loadOlder(h!.engine.ctx, null as never, inboxId);
    expect(r).toEqual({ fetched: 0, reachedStart: false });
    expect(h!.engine.ctx.folders.syncState(inboxId)!.historyComplete).toBe(false);
  });
});
