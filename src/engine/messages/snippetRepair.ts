// One-time repair of list snippets that show code (Mailjet / MJML JSON, CSS, comments) instead of text.
// Mail whose body was never downloaded is reset by migration 016 (the snippet backfill fetches it
// again on the next sync). This job fixes the mail whose body IS stored: it builds the snippet again
// from the stored text/HTML with the fixed cleaning. Small batches with a pause, so a 50k mailbox
// is never blocked; progress is kept in the kv table, so a restart continues where it stopped.
import type { EngineContext } from '../context';
import { makeSnippet } from './bodyUtils';

const CHUNK = 100;
const PAUSE_MS = 15;
const KEY = 'snippet_repair_id';
const DONE = 'snippet_repair_done';

function getKv(ctx: EngineContext, key: string): string | null {
  const r = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
  return r?.v ?? null;
}
function setKv(ctx: EngineContext, key: string, value: string): void {
  ctx.db
    .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, value);
}

export class SnippetRepair {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private finished: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: EngineContext) {}

  start(): void {
    this.stopped = false;
    if (getKv(this.ctx, DONE) === '1') return;
    this.finished = new Promise<void>((resolve) => {
      const step = () => {
        this.timer = null;
        if (this.stopped) return resolve();
        try {
          const after = Number(getKv(this.ctx, KEY) ?? '0');
          const rows = this.ctx.messages.brokenCachedSnippets(after, CHUNK);
          if (rows.length === 0) {
            setKv(this.ctx, DONE, '1');
            return resolve();
          }
          this.ctx.messages.rewriteSnippets(
            rows.map((r) => ({ id: r.id, snippet: makeSnippet(r.text, r.html) })),
          );
          setKv(this.ctx, KEY, String(rows[rows.length - 1].id));
          this.ctx.hub.changed({
            folderIds: [...new Set(rows.map((r) => r.folderId))],
            updated: rows.map((r) => r.id),
          });
        } catch (e) {
          this.ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'snippet repair failed');
          return resolve();
        }
        this.timer = setTimeout(step, PAUSE_MS);
        this.timer.unref?.();
      };
      this.timer = setTimeout(step, 0);
      this.timer.unref?.();
    });
  }

  /** Resolves when every broken snippet is repaired (test hook). */
  whenDone(): Promise<void> {
    return this.finished;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
