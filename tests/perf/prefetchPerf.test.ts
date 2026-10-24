// Opt-in measurement of the background download (prefetch) on a 5,000-message backfill:
//   PERF_PREFETCH=1 npx vitest run tests/perf/prefetchPerf.test.ts
// Uses the fake IMAP server in this same process, so the CPU number includes the fake server's work
// (an upper bound for the engine). The pause between messages is 0 here: with the real 250 ms pause
// 5,000 messages take 20+ minutes by design. `npm test` and `npm run perf` skip this file.
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { createHarness, waitFor, waitForInboxCursors } from '../fakes/engineHarness';
import { rawMessage, startFakeImap } from '../fakes/fakeImapServer';

const N = Number(process.env['PERF_PREFETCH_N'] ?? 5000);
const mb = () => Math.round(process.memoryUsage().rss / 1048576);

describe.skipIf(!process.env['PERF_PREFETCH'])('prefetch backfill', () => {
  it(`downloads ${N} messages`, async () => {
    const body = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40);
    const now = Date.now();
    const server = await startFakeImap({
      inbox: Array.from({ length: N }, (_, i) => ({
        raw: rawMessage({
          subject: `Perf message ${i}`,
          messageId: `<perf${i}@fake.test>`,
          text: `${i} ${body}`,
          date: new Date(now - i * 60_000),
        }),
        flags: ['\\Seen'],
        internaldate: new Date(now - i * 60_000),
      })),
    });
    const h = await createHarness(server, { prefetchGapMs: 0 });
    try {
      h.settings.prefetchDays = -1;
      const acc = await h.addAccount({ syncDays: 3650 });
      const db = h.engine.ctx.db;
      const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      const rows = () => count('SELECT COUNT(*) n FROM message');
      const cached = () => count("SELECT COUNT(*) n FROM message WHERE body_state='cached'");
      await waitForInboxCursors(h, [acc.id]); // initial sync finished (rows appear before that)
      const inboxId = h.folderByRole(acc.id, 'inbox').id;
      while (rows() < N) {
        await h.engine.handle('sync.loadOlder', { folderId: inboxId });
      }
      const startCached = cached();
      const rss0 = mb();
      const cpu0 = process.cpuUsage();
      const t0 = performance.now();
      const samples: { done: number; rss: number }[] = [];
      let nextSample = 1000;
      await waitFor(
        'all downloaded',
        () => {
          h.engine.sessions.prefetchNow();
          const c = cached() - startCached;
          if (c >= nextSample) {
            samples.push({ done: c, rss: mb() });
            nextSample += 1000;
          }
          return c >= N;
        },
        3_600_000,
      );
      const wall = performance.now() - t0;
      const cpu = process.cpuUsage(cpu0);
      const res = {
        messages: N,
        gapMs: 0,
        wallSeconds: +(wall / 1000).toFixed(1),
        wallMsPerMessage: +(wall / N).toFixed(2),
        cpuMsPerMessage: +((cpu.user + cpu.system) / 1000 / N).toFixed(2),
        rssMbBefore: rss0,
        rssMbAfter: mb(),
        rssMbEveryThousand: samples,
        bodyCacheMb: Math.round(h.engine.ctx.messages.bodyCacheBytes() / 1048576),
      };
      console.log('PREFETCH-PERF', JSON.stringify(res));
      const out = process.env['PERF_PREFETCH_OUT'];
      if (out) writeFileSync(out, JSON.stringify(res, null, 2));
    } finally {
      await h.cleanup();
      await server.close();
    }
  }, 3_600_000);
});
