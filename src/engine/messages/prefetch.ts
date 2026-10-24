// Background download of message bodies (DESIGN-SPEC 2026-10-24 "prefetch"). One Prefetcher per
// account, owned by its AccountSession. It uses the same path as opening a message
// (MessageService.prefetch -> fetchAndCache) on the 'background' lane of the account's work pool.
//
// Rules, in short: Inbox only; one message in flight; a pause between messages; it yields to any
// queued user or sync job; it never prunes the body cache (it stops at 90% of the cap instead);
// new arrivals first, then the backfill (newest first).
import type { EngineContext } from '../context';

export const MAX_PREFETCH_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;
const START_DELAY_MS = 20_000;
const GAP_MS = 250;
const RATE_LIMIT_PAUSE_MS = 10 * 60_000;
const CAP_RATIO = 0.9;
const QUEUE_REFILL = 200;
const ARRIVALS_MAX = 500;
const QUIET_POLL_MS = 100;
/** Progress text is only for a real backfill, never for a few new messages. */
export const PROGRESS_MIN_QUEUED = 20;
const PROGRESS_EMIT_MS = 5000;
/** Re-read the real cache size after this many downloads (in between it is counted up). */
const SIZE_REFRESH_EVERY = 25;
/** Gap = at least GAP_MS and 9x the CPU time of the last message: at most about 10% of one core. */
const CPU_GAP_FACTOR = 9;
const MAX_CONSECUTIVE_ERRORS = 5;

export type PrefetchResult =
  | { kind: 'ok'; bytes: number }
  /** Nothing to do for this message (cached already, too big, being opened, moved on this PC). */
  | { kind: 'skip' }
  /** The message is gone from the server or the folder was rebuilt. Not retried this session. */
  | { kind: 'gone' }
  /** The server said "too many requests" or similar. Pause the account. */
  | { kind: 'rateLimited' }
  /** The connection broke. The session reconnects and starts the prefetch again. */
  | { kind: 'offline' }
  | { kind: 'error' };

export interface PrefetchHost {
  accountId: string;
  /** The session is connected and can take commands. */
  ready(): boolean;
  /** A 'user' or 'sync' job waits in the pool (prefetch lets it go first). */
  userWorkQueued(): boolean;
  onBattery(): boolean;
  /** Progress or pause state changed: tell the UI (throttled by the caller). */
  statusChanged(): void;
}

export interface PrefetchProgress {
  done: number;
  total: number;
}

export class Prefetcher {
  private stopped = true;
  private started = false;
  private running = false;
  private epoch = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  /** New mail from sync, newest last. Ids only. */
  private arrivals: number[] = [];
  /** The backfill batch (ids and uids only), refilled from SQL when empty. */
  private queue: { id: number; key: string }[] = [];
  /** Not found / failed this session (id, uid and folder UIDVALIDITY): left out of the SQL so the loop cannot spin on them. A rebuilt folder gives the same ids new uids. */
  private skipped = new Set<string>();
  private pausedUntil = 0;
  private usedBytes = -1;
  private sinceSizeRefresh = 0;
  private errorsInRow = 0;
  private progress: PrefetchProgress | null = null;
  private lastEmit = 0;

  constructor(
    private readonly ctx: EngineContext,
    private readonly host: PrefetchHost,
  ) {}

  /** Progress for the status bar (null = nothing to show). */
  getProgress(): PrefetchProgress | null {
    return this.progress ? { ...this.progress } : null;
  }

  /** The session finished its first sync (same point as the snippet backfill). */
  start(): void {
    this.stopped = false;
    if (this.started) {
      this.kick();
      return;
    }
    this.started = true;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.kick();
    }, this.ctx.prefetchStartDelayMs ?? START_DELAY_MS);
    this.startTimer.unref?.();
  }

  /** The session stopped (offline, disabled, removed): drop the queue; start() rebuilds it. */
  stop(): void {
    this.stopped = true;
    this.started = false;
    this.epoch++;
    this.arrivals = [];
    this.queue = [];
    this.progress = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.startTimer = null;
    this.resumeTimer = null;
    this.cancelSleep();
  }

  /** Something changed (setting, power, sync tick, new mail): run the loop if it is not running. */
  kick(): void {
    if (this.stopped || !this.started || this.running) return;
    if (this.startTimer) return; // the first run waits for its delay
    void this.run();
  }

  /** The setting changed. A bigger window starts at once (no 20 s delay). */
  onSettingsChanged(): void {
    if (this.stopped || !this.started) return;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.queue = []; // the window may be different now
    this.kick();
  }

  /** The sync stored new Inbox mail. */
  noteArrivals(ids: number[]): void {
    if (this.stopped || ids.length === 0) return;
    if (this.days() === 0) return;
    for (const id of ids) this.arrivals.push(id);
    if (this.arrivals.length > ARRIVALS_MAX) this.arrivals.splice(0, this.arrivals.length - ARRIVALS_MAX);
    if (this.progress) this.progress.total += ids.length;
    this.kick();
  }

  // ---------- the loop ----------

  private days(): number {
    return this.ctx.settings().prefetchDays;
  }

  private muted(): boolean {
    return this.ctx.accounts.get(this.host.accountId)?.inUnified === false;
  }

  private backfillAllowed(): boolean {
    return this.days() !== 0 && !this.muted() && !this.host.onBattery();
  }

  private cutoff(): number {
    const d = this.days();
    return d > 0 ? this.ctx.now() - d * DAY_MS : Number.MIN_SAFE_INTEGER;
  }

  private alive(epoch: number): boolean {
    return !this.stopped && epoch === this.epoch && this.host.ready();
  }

  private async run(): Promise<void> {
    this.running = true;
    const epoch = this.epoch;
    try {
      await this.loop(epoch);
    } catch (e) {
      this.ctx.log.debug({ err: String((e as Error)?.message ?? e) }, 'prefetch stopped');
    } finally {
      this.running = false;
      if (epoch === this.epoch) this.setProgress(null, true);
    }
  }

  private async loop(epoch: number): Promise<void> {
    this.usedBytes = -1;
    this.sinceSizeRefresh = 0;
    this.errorsInRow = 0;
    if (this.days() === 0 || this.capReached()) return;
    this.initProgress();
    for (;;) {
      if (!this.alive(epoch) || this.days() === 0) return;
      if (this.ctx.now() < this.pausedUntil) return;
      if (this.capReached()) return;
      const item = this.next();
      if (item === null) return;
      const { id } = item;
      const key = item.key;
      // Let a waiting user or sync job go first.
      while (this.alive(epoch) && this.host.userWorkQueued()) await this.sleep(QUIET_POLL_MS);
      if (!this.alive(epoch)) return;
      const cpu0 = process.cpuUsage();
      const res = await this.ctx.prefetchMessage!(id);
      if (epoch !== this.epoch) return;
      switch (res.kind) {
        case 'ok':
          this.errorsInRow = 0;
          this.usedBytes += res.bytes;
          this.sinceSizeRefresh++;
          break;
        case 'skip':
          break;
        case 'gone':
          this.skipped.add(key);
          break;
        case 'rateLimited':
          this.pause();
          return;
        case 'offline':
          return;
        case 'error':
          this.skipped.add(key);
          if (++this.errorsInRow >= MAX_CONSECUTIVE_ERRORS) {
            this.pause();
            return;
          }
          break;
      }
      if (this.progress) {
        this.progress.done++;
        this.setProgress(this.progress, false);
      }
      const cpu = process.cpuUsage(cpu0);
      const cpuMs = (cpu.user + cpu.system) / 1000;
      await this.sleep(Math.max(this.ctx.prefetchGapMs ?? GAP_MS, Math.round(cpuMs * CPU_GAP_FACTOR)));
    }
  }

  /** Pause the account (server rate limit, repeated errors) and come back later. */
  private pause(): void {
    const ms = this.ctx.prefetchPauseMs ?? RATE_LIMIT_PAUSE_MS;
    this.pausedUntil = this.ctx.now() + ms;
    this.ctx.log.info({ accountId: this.host.accountId, ms }, 'background download paused');
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.errorsInRow = 0;
      this.kick();
    }, ms);
    this.resumeTimer.unref?.();
  }

  /** Stop at 90% of the cap. Never prune: that is the cache cleanup's job. */
  private capReached(): boolean {
    if (this.usedBytes < 0 || this.sinceSizeRefresh >= SIZE_REFRESH_EVERY) {
      this.usedBytes = this.ctx.messages.bodyCacheBytes();
      this.sinceSizeRefresh = 0;
    }
    return this.usedBytes >= this.ctx.settings().maxBodyCacheMB * 1024 * 1024 * CAP_RATIO;
  }

  /** The next message id: new arrivals first, then the backfill. */
  private next(): { id: number; key: string } | null {
    const acc = this.host.accountId;
    while (this.arrivals.length > 0) {
      const id = this.arrivals.pop()!; // newest arrival first
      const key = this.ctx.messages.prefetchEligible(acc, id, MAX_PREFETCH_BYTES);
      if (key !== null && !this.skipped.has(key)) return { id, key };
      if (this.progress) this.progress.total = Math.max(this.progress.done, this.progress.total - 1);
    }
    if (!this.backfillAllowed()) return null;
    for (;;) {
      if (this.queue.length === 0) {
        this.queue = this.ctx.messages.prefetchNextIds(
          acc,
          this.cutoff(),
          MAX_PREFETCH_BYTES,
          QUEUE_REFILL,
          [...this.skipped],
        );
        if (this.queue.length === 0) return null;
        this.queue.reverse(); // pop() takes the newest
      }
      const q = this.queue.pop()!;
      const key = this.ctx.messages.prefetchEligible(acc, q.id, MAX_PREFETCH_BYTES);
      if (key === q.key && !this.skipped.has(key)) return q;
    }
  }

  // ---------- progress ----------

  private initProgress(): void {
    this.progress = null;
    if (!this.backfillAllowed()) return;
    const total = this.ctx.messages.prefetchCount(
      this.host.accountId,
      this.cutoff(),
      MAX_PREFETCH_BYTES,
      [...this.skipped],
    );
    if (total > PROGRESS_MIN_QUEUED) this.setProgress({ done: 0, total }, true);
  }

  private setProgress(p: PrefetchProgress | null, force: boolean): void {
    const hadProgress = this.progress !== null;
    this.progress = p;
    if (!hadProgress && p === null) return;
    const now = Date.now();
    if (force || now - this.lastEmit >= PROGRESS_EMIT_MS) {
      this.lastEmit = now;
      this.host.statusChanged();
    }
  }

  // ---------- timing ----------

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        this.wake = null;
        resolve();
      }, ms);
      this.sleepTimer.unref?.();
    });
  }

  private cancelSleep(): void {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}
