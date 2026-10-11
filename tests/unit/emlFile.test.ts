// Path rules, size cap and .msg detection for .eml files (DESIGN-SPEC 3.14.4 / 3.14.5): emlFile.ts
import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EML_ERROR_TEXT, EML_MAX_BYTES, emlBatchNotice, hasMsgMagic } from '../../src/shared/emlErrors';
import { readEmlBytes, resolveEmlPath, type EmlFs } from '../../src/main/emlFile';

/** A fake file system: path -> entry. `link` points to another path. */
function fakeFs(files: Record<string, { size: number; dir?: boolean; link?: string; head?: Buffer; fail?: boolean }>): EmlFs {
  const find = (p: string) => files[p];
  return {
    async realpath(p) {
      const f = find(p);
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return f.link ?? p;
    },
    async stat(p) {
      const f = find(p);
      if (!f) throw new Error('ENOENT');
      return { isFile: () => !f.dir, size: f.size, mtimeMs: 1000 };
    },
    async readHead(p, max) {
      const f = find(p);
      if (!f || f.fail) throw new Error('EACCES');
      return (f.head ?? Buffer.alloc(f.size, 0x41)).subarray(0, max);
    },
  };
}

describe('resolveEmlPath (fake file system)', () => {
  const ok = { 'C:\\m\\a.eml': { size: 10 } };

  it('accepts a regular .eml file and gives a key that ignores letter case', async () => {
    const r = await resolveEmlPath('C:\\m\\a.eml', fakeFs(ok));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.file.fileName).toBe('a.eml');
      expect(r.file.key).toBe('c:\\m\\a.eml');
      expect(r.file.size).toBe(10);
    }
  });

  it('a symbolic link is followed; the name shown is the name the user opened', async () => {
    const fs = fakeFs({ 'C:\\m\\link.eml': { size: 5, link: 'C:\\real\\Target.eml' }, 'C:\\real\\Target.eml': { size: 5 } });
    const r = await resolveEmlPath('C:\\m\\link.eml', fs);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.file.realPath).toBe('C:\\real\\Target.eml');
      expect(r.file.fileName).toBe('link.eml');
      expect(r.file.key).toBe('c:\\real\\target.eml');
    }
  });

  it('a link that points to a device is refused', async () => {
    const fs = fakeFs({ 'C:\\m\\evil.eml': { size: 5, link: '\\\\.\\COM1' } });
    expect(await resolveEmlPath('C:\\m\\evil.eml', fs)).toMatchObject({ ok: false, code: 'unreadable' });
  });

  it('a folder named like a mail file is refused', async () => {
    const fs = fakeFs({ 'C:\\m\\dir.eml': { size: 0, dir: true } });
    expect(await resolveEmlPath('C:\\m\\dir.eml', fs)).toMatchObject({ ok: false, code: 'unreadable' });
  });

  it('a missing file, a relative path, a device path and a path with control characters are unreadable', async () => {
    const fs = fakeFs(ok);
    for (const p of ['C:\\m\\missing.eml', 'a.eml', '\\\\.\\COM1\\a.eml', 'C:\\m\\a\n.eml', '', 42, null]) {
      expect(await resolveEmlPath(p, fs), String(p)).toMatchObject({ ok: false, code: 'unreadable' });
    }
  });

  it('a network path (UNC) is accepted when the file exists', async () => {
    const fs = fakeFs({ '\\\\srv\\share\\a.eml': { size: 3 } });
    expect((await resolveEmlPath('\\\\srv\\share\\a.eml', fs)).ok).toBe(true);
  });

  it('other extensions: "opens .eml files only"; .msg has its own answer', async () => {
    const fs = fakeFs({ 'C:\\m\\a.txt': { size: 1 }, 'C:\\m\\b.msg': { size: 1 }, 'C:\\m\\c.MSG': { size: 1 }, 'C:\\m\\noext': { size: 1 } });
    expect(await resolveEmlPath('C:\\m\\a.txt', fs)).toMatchObject({ ok: false, code: 'wrongType', fileName: 'a.txt' });
    expect(await resolveEmlPath('C:\\m\\noext', fs)).toMatchObject({ ok: false, code: 'wrongType' });
    expect(await resolveEmlPath('C:\\m\\b.msg', fs)).toMatchObject({ ok: false, code: 'msgUnsupported' });
    expect(await resolveEmlPath('C:\\m\\c.MSG', fs)).toMatchObject({ ok: false, code: 'msgUnsupported' });
  });

  it('size cap: 50 MB is fine, one byte more is too large (checked before reading)', async () => {
    const fs = fakeFs({
      'C:\\m\\edge.eml': { size: EML_MAX_BYTES },
      'C:\\m\\big.eml': { size: EML_MAX_BYTES + 1, fail: true },
    });
    expect((await resolveEmlPath('C:\\m\\edge.eml', fs)).ok).toBe(true);
    expect(await resolveEmlPath('C:\\m\\big.eml', fs)).toMatchObject({ ok: false, code: 'tooLarge' });
  });
});

describe('readEmlBytes (fake file system)', () => {
  const resolved = (size: number) => ({ realPath: 'C:\\m\\a.eml', key: 'c:\\m\\a.eml', fileName: 'a.eml', size, mtimeMs: 1 });

  it('returns the bytes', async () => {
    const fs = fakeFs({ 'C:\\m\\a.eml': { size: 4, head: Buffer.from('Hi: x') } });
    const r = await readEmlBytes(resolved(5), fs);
    expect(r.ok && r.data.toString()).toBe('Hi: x');
  });

  it('an Outlook .msg file with the name .eml is found by its first bytes', async () => {
    const head = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const fs = fakeFs({ 'C:\\m\\a.eml': { size: head.length, head } });
    expect(await readEmlBytes(resolved(head.length), fs)).toMatchObject({ ok: false, code: 'msgUnsupported' });
  });

  it('a file that grew over the cap since the size check is too large', async () => {
    const fs = fakeFs({ 'C:\\m\\a.eml': { size: EML_MAX_BYTES + 5, head: Buffer.alloc(EML_MAX_BYTES + 5) } });
    // The size check said "small"; the read is capped at size + 1, so a lie of a few bytes is tolerated,
    // but nothing above the cap is ever returned.
    const r = await readEmlBytes(resolved(EML_MAX_BYTES + 1), fs);
    expect(r).toMatchObject({ ok: false, code: 'tooLarge' });
  });

  it('a read error is "could not read"', async () => {
    const fs = fakeFs({ 'C:\\m\\a.eml': { size: 4, fail: true } });
    expect(await readEmlBytes(resolved(4), fs)).toMatchObject({ ok: false, code: 'unreadable' });
  });
});

describe('real files', () => {
  let dir = '';
  beforeAll(async () => {
    // The temp folder may be an 8.3 short path (RUNNER~1): use its canonical form, like the code does.
    dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'letterdock-eml-')));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a small real file and rejects a real folder', async () => {
    const f = join(dir, 'mail.eml');
    await writeFile(f, 'Subject: hi\r\n\r\nbody');
    const r = await resolveEmlPath(f);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const b = await readEmlBytes(r.file);
      expect(b.ok && b.data.toString()).toBe('Subject: hi\r\n\r\nbody');
    }
    const d = join(dir, 'folder.eml');
    await mkdir(d);
    expect(await resolveEmlPath(d)).toMatchObject({ ok: false, code: 'unreadable' });
  });

  it('follows a real symbolic link when this PC allows creating one', async () => {
    const target = join(dir, 'target.eml');
    const link = join(dir, 'link.eml');
    await writeFile(target, 'Subject: t\r\n\r\nx');
    try {
      await symlink(target, link, 'file');
    } catch {
      return; // Windows without the symlink privilege: the fake file system test above covers the rule
    }
    const r = await resolveEmlPath(link);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.realPath.toLowerCase()).toBe(realpathSync.native(target).toLowerCase());
  });

  it('treats the 8.3 short and long forms of one file as the same file (same key)', async () => {
    if (process.platform !== 'win32') return;
    const f = join(dir, 'a-rather-long-file-name.eml');
    await writeFile(f, 'Subject: s\r\n\r\nx');
    let short: string;
    try {
      short = execSync(`for %I in ("${f}") do @echo %~sI`, { encoding: 'utf8' }).trim();
    } catch {
      return;
    }
    if (!short || short.toLowerCase() === f.toLowerCase()) return; // 8.3 names are off on this volume
    const a = await resolveEmlPath(f);
    const b = await resolveEmlPath(short);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.file.key).toBe(a.file.key);
  });
});

describe('texts and helpers', () => {
  it('the error texts are the exact words of the spec', () => {
    expect(EML_ERROR_TEXT.tooLarge).toBe('This file is too large to open (limit 50 MB).');
    expect(EML_ERROR_TEXT.unreadable).toBe('Letterdock could not read this file.');
    expect(EML_ERROR_TEXT.notEmail).toBe('This file does not look like an email message.');
    expect(EML_ERROR_TEXT.wrongType).toBe('Letterdock opens .eml files only.');
    expect(EML_ERROR_TEXT.msgUnsupported).toBe(
      'Outlook .msg files are not supported. In Outlook, use Save As and choose the .eml format, or forward the message as an attachment.',
    );
  });

  it('batch notice appears only above 5 files', () => {
    expect(emlBatchNotice(5)).toBeNull();
    expect(emlBatchNotice(8)).toBe('Opened the first 5 of 8 files.');
  });

  it('hasMsgMagic', () => {
    expect(hasMsgMagic(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toBe(true);
    expect(hasMsgMagic(Buffer.from([0xd0, 0xcf, 0x11]))).toBe(false);
    expect(hasMsgMagic(Buffer.from('From: x'))).toBe(false);
  });
});
