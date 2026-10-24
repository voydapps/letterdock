// Shutting the engine down while a first sync and a "load older" are running must end cleanly:
// running jobs lose their connection, and nothing uses the database or a socket after the close.
import { describe, expect, it } from 'vitest';
import { createHarness, waitFor } from '../fakes/engineHarness';
import { rawMessage, startFakeImap } from '../fakes/fakeImapServer';

describe('shutdown while syncing', () => {
  it('ends cleanly with a first sync and a load older in flight', async () => {
    const now = Date.now();
    const server = await startFakeImap({
      inbox: Array.from({ length: 200 }, (_, i) => ({
        raw: rawMessage({ subject: `M ${i}`, messageId: `<m${i}@fake.test>`, date: new Date(now - i * 60_000) }),
        internaldate: new Date(now - i * 60_000),
      })),
    });
    const h = await createHarness(server, { prefetchGapMs: 0 });
    h.settings.prefetchDays = -1;
    const errors: unknown[] = [];
    const onErr = (e: unknown) => errors.push(e);
    process.on('unhandledRejection', onErr);
    try {
      const a = await h.addAccount({ syncDays: 3650 });
      await waitFor('first rows', () => h.inboxMessages(a.id).length > 0);
      const inboxId = h.folderByRole(a.id, 'inbox').id;
      const older = h.engine.handle('sync.loadOlder', { folderId: inboxId }).catch(() => undefined);
      await h.cleanup();
      await older;
      await server.close().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      expect(errors).toEqual([]);
    } finally {
      process.off('unhandledRejection', onErr);
    }
  });
});
