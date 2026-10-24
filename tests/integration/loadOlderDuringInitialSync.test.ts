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

  /** Every folder has had its first sync (so no other folder is still syncing in the background). */
  async function waitForBootstrap(accountId: string): Promise<void> {
    await waitFor('all folders synced once', () =>
      h!.engine.ctx.folders
        .rowsForAccount(accountId)
        .filter((f) => f.selectable === 1)
        .every((f) => f.uidvalidity !== null),
    );
    await new Promise((r) => setTimeout(r, 100));
  }

  /** Count jobs that run at the same time on the account (sync and load older both use `run`). */
  function watchRuns(accountId: string) {
    const session = h!.engine.sessions.get(accountId);
    const orig = session.run.bind(session);
    const st = { cur: 0, max: 0, failNext: false };
    (session as unknown as { run: typeof orig }).run = (async (prio, fn) => {
      // Only the two folder writers count (not backfills, folder discovery, ...).
      if (!/loadOlder|syncFolder/.test(fn.toString())) return orig(prio, fn);
      st.cur++;
      st.max = Math.max(st.max, st.cur);
      try {
        await new Promise((r) => setTimeout(r, 15)); // widen the window for an overlap
        if (st.failNext) {
          st.failNext = false;
          throw new Error('boom');
        }
        return await orig(prio, fn);
      } finally {
        st.cur--;
      }
    }) as typeof orig;
    return st;
  }

  it('a sync that starts during a load older queues behind it (never two writers)', async () => {
    await start();
    const a = await h!.addAccount({ syncDays: 30 });
    await waitForBootstrap(a.id);
    const inboxId = h!.folderByRole(a.id, 'inbox').id;
    const st = watchRuns(a.id);
    const older = h!.engine.handle('sync.loadOlder', { folderId: inboxId });
    const syncs = [1, 2, 3].map(() => h!.engine.sessions.get(a.id).syncFolderById(inboxId));
    await Promise.all([older, ...syncs]);
    expect(st.max).toBe(1);
    expect(h!.inboxMessages(a.id)).toHaveLength(RECENT + OLD);
  });

  it('an error inside the locked section gives the lock back', async () => {
    await start();
    const a = await h!.addAccount({ syncDays: 30 });
    await waitForBootstrap(a.id);
    const inboxId = h!.folderByRole(a.id, 'inbox').id;
    const st = watchRuns(a.id);
    st.failNext = true;
    await expect(h!.engine.handle('sync.loadOlder', { folderId: inboxId })).rejects.toBeTruthy();
    const res = (await h!.engine.handle('sync.loadOlder', { folderId: inboxId })) as { fetched: number };
    expect(res.fetched).toBe(OLD);
    await h!.engine.sessions.get(a.id).syncFolderById(inboxId);
  });
});
