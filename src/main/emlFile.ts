// Checks and reads a .eml file for the viewer (DESIGN-SPEC 3.14.5). Main only reads bytes: it does
// not parse MIME and does not render anything. The file system calls are passed in, so the rules can
// be tested without touching the disk.
import { open, realpath, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { EML_MAX_BYTES, hasMsgMagic, type EmlErrorCode } from '../shared/emlErrors';
import { hasControlChars } from '../shared/safety';
import { fileExtension, isDevicePath, isFullWindowsPath } from './emlArg';

export interface EmlFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
  /** Reads at most `max` bytes from the start of the file. */
  readHead(path: string, max: number): Promise<Buffer>;
}

export const nodeEmlFs: EmlFs = {
  realpath: (p) => realpath(p),
  stat: (p) => stat(p),
  async readHead(p, max) {
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.allocUnsafe(max);
      let got = 0;
      while (got < max) {
        const { bytesRead } = await fh.read(buf, got, max - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    } finally {
      await fh.close();
    }
  },
};

export interface ResolvedEml {
  /** The real path (symbolic links followed). */
  realPath: string;
  /** Same file, same key: lower-case normalized real path. */
  key: string;
  /** Name as the user knows it (the name they opened, not the link target). */
  fileName: string;
  size: number;
  mtimeMs: number;
}

export type EmlCheck<T> = ({ ok: true } & T) | { ok: false; code: EmlErrorCode; fileName: string };

function nameOf(p: string): string {
  return win32.basename(typeof p === 'string' ? p : '') || 'file';
}

/**
 * Step 1, before any byte is read. The path must be a full Windows path (not a device), have the
 * extension `.eml`, and point (after following links) to a regular file of at most 50 MB.
 * `.msg` gets its own answer; any other extension is "Letterdock opens .eml files only."
 */
export async function resolveEmlPath(input: unknown, fs: EmlFs = nodeEmlFs): Promise<EmlCheck<{ file: ResolvedEml }>> {
  if (typeof input !== 'string') return { ok: false, code: 'unreadable', fileName: 'file' };
  const fileName = nameOf(input);
  const fail = (code: EmlErrorCode): EmlCheck<{ file: ResolvedEml }> => ({ ok: false, code, fileName });
  if (input.length === 0 || input.length > 32767 || hasControlChars(input)) return fail('unreadable');
  const ext = fileExtension(input);
  if (ext === '.msg') return fail('msgUnsupported');
  if (ext !== '.eml') return fail('wrongType');
  if (!isFullWindowsPath(input) || isDevicePath(input)) return fail('unreadable');
  let real: string;
  let st: Awaited<ReturnType<EmlFs['stat']>>;
  try {
    real = await fs.realpath(input);
    // The target of a link may be a device or a folder: look at the real thing.
    if (isDevicePath(real)) return fail('unreadable');
    st = await fs.stat(real);
  } catch {
    return fail('unreadable');
  }
  if (!st.isFile()) return fail('unreadable');
  if (st.size > EML_MAX_BYTES) return fail('tooLarge');
  return {
    ok: true,
    file: { realPath: real, key: win32.normalize(real).toLowerCase(), fileName, size: st.size, mtimeMs: st.mtimeMs },
  };
}

/**
 * Step 2: the bytes (never more than 50 MB: the file may have grown since the size check). An Outlook
 * .msg file with the wrong name is found by its first bytes.
 */
export async function readEmlBytes(file: ResolvedEml, fs: EmlFs = nodeEmlFs): Promise<EmlCheck<{ data: Buffer }>> {
  let data: Buffer;
  try {
    data = await fs.readHead(file.realPath, Math.min(EML_MAX_BYTES + 1, file.size + 1));
  } catch {
    return { ok: false, code: 'unreadable', fileName: file.fileName };
  }
  if (data.length > EML_MAX_BYTES) return { ok: false, code: 'tooLarge', fileName: file.fileName };
  if (hasMsgMagic(data)) return { ok: false, code: 'msgUnsupported', fileName: file.fileName };
  return { ok: true, data };
}
