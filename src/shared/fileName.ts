// Pure helpers for file names the user sees in a save dialog. No node / electron imports.

import { replaceControlChars } from './safety';

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A name that is safe as a Windows file name: no path parts, no reserved characters or names. */
export function safeFileStem(raw: string | null | undefined, fallback: string, maxLength = 120): string {
  let n = replaceControlChars((raw ?? '').replace(/\s+/g, ' '), '_') // line breaks and tabs in a subject become one space
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!n) n = fallback;
  if (RESERVED.test(n)) n = '_' + n;
  if (n.length > maxLength) n = n.slice(0, maxLength).replace(/[. ]+$/, '');
  return n || fallback;
}

/** Default file name for "Save as .eml": the subject (cleaned), else "message". */
export function emlFileName(subject: string | null | undefined): string {
  return `${safeFileStem(subject, 'message', 100)}.eml`;
}

/** Make an attachment name safe to use as a Windows file name. */
export function safeFileName(name: string | null | undefined, fallback = 'attachment'): string {
  let n = replaceControlChars(name ?? '', '_')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!n) n = fallback;
  if (RESERVED.test(n)) n = '_' + n;
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}
