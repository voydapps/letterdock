// Opening .eml files (DESIGN-SPEC 3.14): the limits and the exact error texts, in one place.
// Main, the engine, the viewer window and the tests all read from here.

/** Largest .eml file we open (3.14.4). */
export const EML_MAX_BYTES = 50 * 1024 * 1024;
/** At most this many files are opened by one action (3.14.2). */
export const EML_MAX_BATCH = 5;
/** Parsed message files kept in memory at the same time (each one needs its viewer window). */
export const EML_MAX_OPEN = 15;

export type EmlErrorCode =
  | 'unreadable'
  | 'notEmail'
  | 'tooLarge'
  | 'msgUnsupported'
  | 'wrongType'
  | 'tooManyOpen';

export const EML_ERROR_TEXT: Record<EmlErrorCode, string> = {
  unreadable: 'Letterdock could not read this file.',
  notEmail: 'This file does not look like an email message.',
  tooLarge: 'This file is too large to open (limit 50 MB).',
  msgUnsupported:
    'Outlook .msg files are not supported. In Outlook, use Save As and choose the .eml format, or forward the message as an attachment.',
  wrongType: 'Letterdock opens .eml files only.',
  tooManyOpen: 'Too many message files are open. Close some of them and try again.',
};

export function isEmlErrorCode(v: unknown): v is EmlErrorCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(EML_ERROR_TEXT, v);
}

/** "Opened the first 5 of 8 files." when more files arrived than one action opens; else null. */
export function emlBatchNotice(total: number): string | null {
  return total > EML_MAX_BATCH ? `Opened the first ${EML_MAX_BATCH} of ${total} files.` : null;
}

/** First bytes of an Outlook .msg file (an OLE compound document). */
export const MSG_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

export function hasMsgMagic(bytes: ArrayLike<number>): boolean {
  return bytes.length >= 4 && MSG_MAGIC.every((b, i) => bytes[i] === b);
}

/** One file that did not open, as shown in the error window (the name is only the file name, not the path). */
export interface EmlErrorItem {
  code: EmlErrorCode;
  fileName: string;
}

/** The error window lists at most this many files; one action opens 5 at most, so none is left out. */
export const EML_ERROR_WINDOW_MAX = 5;

/**
 * URL hash of the small error window: `emlerror=<code>&emlfile=<name>` once per file, in order.
 * A single error without a name (`emlerror=<code>`) is read too.
 */
export function emlErrorHashOf(items: readonly EmlErrorItem[]): string {
  const p = new URLSearchParams();
  for (const it of items.slice(0, EML_ERROR_WINDOW_MAX)) {
    p.append('emlerror', it.code);
    p.append('emlfile', it.fileName.slice(0, 260));
  }
  return p.toString();
}

/** Reads `emlErrorHashOf`. Unknown codes become `unreadable`; no entry at all gives an empty list. */
export function readEmlErrorHash(hash: string): { code: EmlErrorCode; fileName: string }[] {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const codes = p.getAll('emlerror').slice(0, EML_ERROR_WINDOW_MAX);
  const names = p.getAll('emlfile');
  return codes.map((c, i) => ({ code: isEmlErrorCode(c) ? c : 'unreadable', fileName: names[i] ?? '' }));
}
