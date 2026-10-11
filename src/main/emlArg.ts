// .eml files given on the command line (pure helpers; the Electron calls live in index.ts).
// Windows starts `Letterdock.exe "C:\path\mail.eml"` for Open with and for a double-click.

import { win32 } from 'node:path';
import { hasControlChars } from '../shared/safety';

/** Longest path Windows allows (extended-length). Anything longer is not a real path. */
const MAX_PATH_CHARS = 32767;

function stripQuotes(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/** Windows device paths (`\\.\COM1`, `\\?\GLOBALROOT\...`) are never a mail file. `\\?\C:\...` is fine. */
export function isDevicePath(p: string): boolean {
  if (/^\\\\\.\\/.test(p)) return true;
  if (/^\\\\\?\\/.test(p)) return !/^\\\\\?\\(?:[A-Za-z]:\\|UNC\\)/i.test(p);
  return false;
}

/**
 * `C:\dir\file`, `\\server\share\file` or `\\?\C:\dir\file`. A path like `\file` or `C:file` depends
 * on the current folder: not accepted.
 */
export function isFullWindowsPath(p: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (/^\\\\\?\\(?:[A-Za-z]:\\|UNC\\)/i.test(p)) return true;
  return /^\\\\[^\\/?.][^\\/]*[\\/][^\\/]+/.test(p);
}

/** The lower-case extension of the last path part, with the dot ("" when none). */
export function fileExtension(p: string): string {
  return win32.extname(p).toLowerCase();
}

/**
 * Finds the .eml files in a command line: arguments that are a full path ending in `.eml` (any
 * case). Flags (`--hidden`), `mailto:` links and everything else are ignored. A pair of quotes
 * around the path is removed. The same file twice (any letter case) is returned once.
 */
export function findEmlArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of argv) {
    if (typeof raw !== 'string') continue;
    const arg = stripQuotes(raw.trim()).trim();
    if (arg.length === 0 || arg.length > MAX_PATH_CHARS) continue;
    if (arg.startsWith('-')) continue;
    if (/^mailto:/i.test(arg)) continue;
    if (hasControlChars(arg)) continue;
    if (fileExtension(arg) !== '.eml') continue;
    if (!isFullWindowsPath(arg) || isDevicePath(arg)) continue;
    const key = win32.normalize(arg).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(arg);
  }
  return out;
}
