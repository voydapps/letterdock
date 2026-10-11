// Opens .eml files in message windows (DESIGN-SPEC 3.14). Order for each file: check the path, find
// out if that file is already open (then focus it), read the bytes, give them to the engine, and only
// then open the window, so a file that fails never leaves an empty window. The Electron and engine
// calls are passed in, so the rules can be tested without a window.
import { randomUUID } from 'node:crypto';
import {
  EML_ERROR_TEXT,
  EML_MAX_BATCH,
  EML_MAX_OPEN,
  emlBatchNotice,
  isEmlErrorCode,
  type EmlErrorCode,
} from '../shared/emlErrors';
import { toAppError } from '../shared/errors';
import type { EmlOpenError, EmlOpenRes } from '../shared/ipc';
import { readEmlBytes, resolveEmlPath, type EmlFs, nodeEmlFs } from './emlFile';

export interface EmlOpenerDeps {
  /** Gives the bytes to the engine (`eml.open`). Rejects with an AppError whose `details` is an EmlErrorCode. */
  engineOpen(req: { token: string; data: Uint8Array; fileName: string; filePath: string; mtimeMs: number }): Promise<unknown>;
  /** The window is gone, or opening failed: the engine forgets the message. */
  engineClose(token: string): Promise<unknown>;
  /** Opens the message window for the token. `onClosed` must run when that window closes. */
  openWindow(token: string, onClosed: () => void): { focus(): void };
  log?: { warn(o: object, msg: string): void };
  fs?: EmlFs;
}

interface Open {
  token: string;
  realPath: string;
  win: { focus(): void };
}

export class EmlOpener {
  private byKey = new Map<string, Open>();
  private byToken = new Map<string, { key: string; open: Open }>();
  /** Batches run one after the other, so two quick launches cannot open the same file twice. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: EmlOpenerDeps) {}

  /** The real path of an open file, by token (for "Show in folder"). */
  pathOf(token: string): string | null {
    return this.byToken.get(token)?.open.realPath ?? null;
  }

  get openCount(): number {
    return this.byToken.size;
  }

  /** Opens the first 5 of `paths`. Never throws: problems are in `errors`. */
  openPaths(paths: readonly unknown[]): Promise<EmlOpenRes> {
    const run = this.queue.then(() => this.run(paths));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(paths: readonly unknown[]): Promise<EmlOpenRes> {
    const total = paths.length;
    const res: EmlOpenRes = { opened: 0, total, notice: emlBatchNotice(total), errors: [] };
    for (const p of paths.slice(0, EML_MAX_BATCH)) {
      const err = await this.openOne(p);
      if (err === null) res.opened++;
      else res.errors.push(err);
    }
    return res;
  }

  private error(code: EmlErrorCode, fileName: string): EmlOpenError {
    return { code, message: EML_ERROR_TEXT[code], fileName };
  }

  private async openOne(input: unknown): Promise<EmlOpenError | null> {
    const fs = this.deps.fs ?? nodeEmlFs;
    const checked = await resolveEmlPath(input, fs);
    if (!checked.ok) return this.error(checked.code, checked.fileName);
    const file = checked.file;
    const existing = this.byKey.get(file.key);
    if (existing) {
      existing.win.focus();
      return null;
    }
    if (this.byToken.size >= EML_MAX_OPEN) return this.error('tooManyOpen', file.fileName);
    const read = await readEmlBytes(file, fs);
    if (!read.ok) return this.error(read.code, read.fileName);

    const token = randomUUID();
    try {
      await this.deps.engineOpen({
        token,
        data: read.data,
        fileName: file.fileName,
        filePath: file.realPath,
        mtimeMs: file.mtimeMs,
      });
    } catch (e) {
      const err = toAppError(e);
      const code = isEmlErrorCode(err.details) ? err.details : 'unreadable';
      if (code === 'unreadable') this.deps.log?.warn({ code: err.code }, 'the engine could not open an .eml file');
      return this.error(code, file.fileName);
    }
    const open: Open = { token, realPath: file.realPath, win: { focus: () => undefined } };
    try {
      open.win = this.deps.openWindow(token, () => this.release(token));
    } catch (e) {
      this.deps.log?.warn({ err: String(e) }, 'could not open the message window');
      void this.deps.engineClose(token).catch(() => undefined);
      return this.error('unreadable', file.fileName);
    }
    this.byKey.set(file.key, open);
    this.byToken.set(token, { key: file.key, open });
    return null;
  }

  /** The window closed: the file can be opened again and the engine forgets the message. */
  private release(token: string): void {
    const e = this.byToken.get(token);
    if (!e) return;
    this.byToken.delete(token);
    if (this.byKey.get(e.key) === e.open) this.byKey.delete(e.key);
    void this.deps.engineClose(token).catch(() => undefined);
  }
}
