// "Save all" attachments of an opened .eml file: names are made safe, nothing is overwritten (emlSave.ts).
import { describe, expect, it } from 'vitest';
import { saveAttachmentsToFolder } from '../../src/main/emlSave';

function memory(existing: string[] = []) {
  const files = new Map<string, number>(existing.map((n) => [`C:\\out\\${n}`, 1]));
  return {
    files,
    deps: {
      async writeNew(path: string, data: Uint8Array) {
        if (files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        files.set(path, data.byteLength);
      },
    },
  };
}
const f = (filename: string, n = 3) => ({ filename, data: new Uint8Array(n) });

describe('saveAttachmentsToFolder', () => {
  it('writes every file into the chosen folder and counts them', async () => {
    const m = memory();
    expect(await saveAttachmentsToFolder('C:\\out', [f('a.pdf'), f('b.txt', 5)], m.deps)).toBe(2);
    expect([...m.files.keys()]).toEqual(['C:\\out\\a.pdf', 'C:\\out\\b.txt']);
  });

  it('never overwrites: a taken name gets (2), (3)...', async () => {
    const m = memory(['a.pdf', 'a (2).pdf']);
    await saveAttachmentsToFolder('C:\\out', [f('a.pdf'), f('a.pdf')], m.deps);
    expect([...m.files.keys()].sort()).toEqual([
      'C:\\out\\a (2).pdf',
      'C:\\out\\a (3).pdf',
      'C:\\out\\a (4).pdf',
      'C:\\out\\a.pdf',
    ]);
  });

  it('names from the file are made safe: no folders, reserved names, trailing dots', async () => {
    const m = memory();
    await saveAttachmentsToFolder(
      'C:\\out',
      [f('..\\..\\evil.exe'), f('C:\\Windows\\x.dll'), f('con.txt'), f('report. '), f('')],
      m.deps,
    );
    const names = [...m.files.keys()].map((p) => p.slice('C:\\out\\'.length));
    expect(names).toEqual(['_.._evil.exe', 'C__Windows_x.dll', '_con.txt', 'report', 'attachment']);
    for (const n of names) expect(n).not.toMatch(/[\\/:]/);
  });

  it('another write error stops with that error', async () => {
    const deps = {
      writeNew: async () => Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' })),
    };
    await expect(saveAttachmentsToFolder('C:\\out', [f('a')], deps)).rejects.toThrow('disk full');
  });
});
