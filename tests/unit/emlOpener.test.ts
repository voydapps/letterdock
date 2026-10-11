// Opening several .eml files, focus of a file that is already open, and the token lifecycle:
// emlOpener.ts with a fake engine and fake windows.
import { describe, expect, it, vi } from 'vitest';
import { EmlOpener } from '../../src/main/emlOpener';
import type { EmlFs } from '../../src/main/emlFile';
import { makeError } from '../../src/shared/errors';

function setup(files: Record<string, { size?: number; head?: Buffer }> = {}) {
  const fs: EmlFs = {
    async realpath(p) {
      if (!files[p]) throw new Error('ENOENT');
      return p;
    },
    async stat(p) {
      return { isFile: () => true, size: files[p]?.size ?? 10, mtimeMs: 5 };
    },
    async readHead(p) {
      return files[p]?.head ?? Buffer.from('Subject: x\r\n\r\nbody');
    },
  };
  const opened: { token: string; fileName: string; filePath: string; data: number }[] = [];
  const closedTokens: string[] = [];
  const windows = new Map<string, { focus: ReturnType<typeof vi.fn>; close: () => void }>();
  let engineFail: { code: string; details?: string } | null = null;
  const opener = new EmlOpener({
    fs,
    engineOpen: async (r) => {
      if (engineFail) throw makeError('INVALID_INPUT', 'x', engineFail.details ? { details: engineFail.details } : {});
      opened.push({ token: r.token, fileName: r.fileName, filePath: r.filePath, data: r.data.byteLength });
    },
    engineClose: async (t) => {
      closedTokens.push(t);
    },
    openWindow: (token, onClosed) => {
      const w = { focus: vi.fn(), close: onClosed };
      windows.set(token, w);
      return w;
    },
  });
  return {
    opener,
    opened,
    closedTokens,
    windows,
    failEngineWith: (details: string | undefined) => (engineFail = { code: 'INVALID_INPUT', ...(details ? { details } : {}) }),
    okEngine: () => (engineFail = null),
  };
}

const paths = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`C:\\m\\${i + 1}.eml`, {}]));

const PATH1 = 'C:\\m\\1.eml';

describe('EmlOpener', () => {
  it('opens a file: a token is given to the engine and to the window, never the path in the token', async () => {
    const t = setup(paths(1));
    const res = await t.opener.openPaths(['C:\\m\\1.eml']);
    expect(res).toEqual({ opened: 1, total: 1, notice: null, errors: [] });
    expect(t.opened).toHaveLength(1);
    const { token, fileName, filePath } = t.opened[0]!;
    expect(fileName).toBe('1.eml');
    expect(filePath).toBe('C:\\m\\1.eml');
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(token).not.toContain('1.eml');
    expect(t.windows.has(token)).toBe(true);
    expect(t.opener.pathOf(token)).toBe('C:\\m\\1.eml');
  });

  it('opens at most 5 files and tells how many there were', async () => {
    const t = setup(paths(8));
    const res = await t.opener.openPaths(Array.from({ length: 8 }, (_, i) => `C:\\m\\${i + 1}.eml`));
    expect(res.opened).toBe(5);
    expect(res.total).toBe(8);
    expect(res.notice).toBe('Opened the first 5 of 8 files.');
    expect(t.opened).toHaveLength(5);
  });

  it('the same file opened again focuses its window (also with other letter case)', async () => {
    const t = setup({ ...paths(1), 'c:\\M\\1.EML': {} });
    await t.opener.openPaths(['C:\\m\\1.eml']);
    const token = t.opened[0]!.token;
    const res = await t.opener.openPaths(['C:\\m\\1.eml']);
    expect(res.opened).toBe(1);
    expect(t.opened).toHaveLength(1);
    expect(t.windows.get(token)!.focus).toHaveBeenCalledTimes(1);
  });

  it('the same file twice in one batch opens one window', async () => {
    const t = setup(paths(1));
    const res = await t.opener.openPaths(['C:\\m\\1.eml', 'C:\\m\\1.eml']);
    expect(res.opened).toBe(2);
    expect(t.opened).toHaveLength(1);
  });

  it('two quick launches with the same file still open one window', async () => {
    const t = setup(paths(1));
    const [a, b] = await Promise.all([t.opener.openPaths(['C:\\m\\1.eml']), t.opener.openPaths(['C:\\m\\1.eml'])]);
    expect(a.opened + b.opened).toBe(2);
    expect(t.opened).toHaveLength(1);
  });

  it('the token is freed when the window closes, and the file can be opened again', async () => {
    const t = setup(paths(1));
    await t.opener.openPaths(['C:\\m\\1.eml']);
    const token = t.opened[0]!.token;
    expect(t.opener.openCount).toBe(1);
    t.windows.get(token)!.close();
    expect(t.closedTokens).toEqual([token]);
    expect(t.opener.pathOf(token)).toBeNull();
    expect(t.opener.openCount).toBe(0);
    await t.opener.openPaths(['C:\\m\\1.eml']);
    expect(t.opened).toHaveLength(2);
    expect(t.opened[1]!.token).not.toBe(token);
  });

  it('a closed window that is reported twice frees the engine once', async () => {
    const t = setup(paths(1));
    await t.opener.openPaths(['C:\\m\\1.eml']);
    const token = t.opened[0]!.token;
    t.windows.get(token)!.close();
    t.windows.get(token)!.close();
    expect(t.closedTokens).toEqual([token]);
  });

  it('reports each problem with the exact text and does not stop the other files', async () => {
    const t = setup({ ...paths(1), 'C:\\m\\x.txt': {}, 'C:\\m\\o.msg': {} });
    const res = await t.opener.openPaths(['C:\\m\\x.txt', 'C:\\m\\o.msg', 'C:\\m\\gone.eml', 'C:\\m\\1.eml']);
    expect(res.opened).toBe(1);
    expect(res.errors.map((e) => e.code)).toEqual(['wrongType', 'msgUnsupported', 'unreadable']);
    expect(res.errors[0]).toEqual({ code: 'wrongType', message: 'Letterdock opens .eml files only.', fileName: 'x.txt' });
  });

  it('an .msg file with the name .eml is found by its first bytes', async () => {
    const t = setup({ 'C:\\m\\o.eml': { head: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]) } });
    const res = await t.opener.openPaths(['C:\\m\\o.eml']);
    expect(res.errors[0]?.code).toBe('msgUnsupported');
    expect(t.opened).toHaveLength(0);
  });

  it('no window opens when the engine refuses the file, and its reason is shown', async () => {
    const t = setup(paths(2));
    t.failEngineWith('notEmail');
    const res = await t.opener.openPaths(['C:\\m\\1.eml']);
    expect(res.errors[0]).toMatchObject({ code: 'notEmail', message: 'This file does not look like an email message.' });
    expect(t.windows.size).toBe(0);
    expect(t.opener.openCount).toBe(0);
    // an unknown engine problem becomes "could not read"
    t.failEngineWith(undefined);
    const res2 = await t.opener.openPaths(['C:\\m\\2.eml']);
    expect(res2.errors[0]?.code).toBe('unreadable');
    // and the file can be tried again
    t.okEngine();
    expect((await t.opener.openPaths(['C:\\m\\1.eml'])).opened).toBe(1);
  });

  it('a window that cannot be created frees the message in the engine', async () => {
    const files = paths(1);
    const closed: string[] = [];
    const opener = new EmlOpener({
      fs: {
        realpath: async (p) => (files[p] ? p : Promise.reject(new Error('x'))),
        stat: async () => ({ isFile: () => true, size: 3, mtimeMs: 1 }),
        readHead: async () => Buffer.from('A: b'),
      },
      engineOpen: async () => undefined,
      engineClose: async (t) => {
        closed.push(t);
      },
      openWindow: () => {
        throw new Error('no window');
      },
    });
    const res = await opener.openPaths(['C:\\m\\1.eml']);
    expect(res.errors[0]?.code).toBe('unreadable');
    expect(closed).toHaveLength(1);
    expect(opener.openCount).toBe(0);
  });

  it('at most 15 files stay open at the same time', async () => {
    const t = setup(paths(20));
    for (let i = 1; i <= 20; i += 5) {
      await t.opener.openPaths(Array.from({ length: 5 }, (_, k) => `C:\\m\\${i + k}.eml`));
    }
    expect(t.opener.openCount).toBe(15);
    const res = await t.opener.openPaths(['C:\\m\\20.eml']);
    expect(res.errors[0]).toMatchObject({ code: 'tooManyOpen' });
  });

  it('the 15-window cap still counts windows that went dead in an engine restart, until they close', async () => {
    const t = setup(paths(20));
    for (let i = 1; i <= 15; i += 5) {
      await t.opener.openPaths(Array.from({ length: 5 }, (_, k) => `C:\\m\\${i + k}.eml`));
    }
    const oldTokens = t.opened.map((o) => o.token);
    t.opener.forgetAll();
    expect(t.opener.openCount).toBe(15);
    // 15 dead windows are still on screen: no new window yet.
    const full = await t.opener.openPaths(['C:\\m\\16.eml']);
    expect(full.errors[0]).toMatchObject({ code: 'tooManyOpen' });
    // The same file can open again once a dead window closes (the count is by window, not by file).
    t.windows.get(oldTokens[0]!)!.close();
    expect(t.opener.openCount).toBe(14);
    expect(t.closedTokens).toEqual([]);
    const again = await t.opener.openPaths(['C:\\m\\1.eml']);
    expect(again).toMatchObject({ opened: 1, errors: [] });
    expect(t.opener.openCount).toBe(15);
    expect((await t.opener.openPaths(['C:\\m\\17.eml'])).errors[0]).toMatchObject({ code: 'tooManyOpen' });
    // Closing a live window frees the engine as usual.
    t.windows.get(t.opened[t.opened.length - 1]!.token)!.close();
    expect(t.closedTokens).toHaveLength(1);
    expect(t.opener.openCount).toBe(14);
  });

  it('non-string input is "could not read" and never throws', async () => {
    const t = setup();
    const res = await t.opener.openPaths([42, null, {}]);
    expect(res.errors.map((e) => e.code)).toEqual(['unreadable', 'unreadable', 'unreadable']);
  });

  it('after an engine restart the same file opens again in a fresh window (the old token is dead)', async () => {
    const t = setup(paths(1));
    await t.opener.openPaths([PATH1]);
    const oldToken = t.opened[0]!.token;
    t.opener.forgetAll();
    expect(t.opener.pathOf(oldToken)).toBeNull();
    const res = await t.opener.openPaths([PATH1]);
    expect(res).toMatchObject({ opened: 1, errors: [] });
    expect(t.opened).toHaveLength(2);
    expect(t.opened[1]!.token).not.toBe(oldToken);
    expect(t.windows.get(oldToken)!.focus).not.toHaveBeenCalled();
    // The dead window is still on screen, so it still counts until it closes.
    expect(t.opener.openCount).toBe(2);
    // Closing the dead window later does not touch the new one and does not call the engine.
    t.windows.get(oldToken)!.close();
    expect(t.opener.openCount).toBe(1);
    expect(t.closedTokens).toEqual([]);
    // The new window is still found by a third open.
    await t.opener.openPaths([PATH1]);
    expect(t.opened).toHaveLength(2);
  });
});
