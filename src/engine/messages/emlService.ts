// Messages opened from .eml files (DESIGN-SPEC 3.14). Main reads the bytes and hands them over under
// an opaque token; this service parses them (mailparser, 10 s limit) and answers in the same shape as
// mailbox mail, so the message window shows them with the same code. Nothing is written to a mailbox,
// the database or the search index. A message lives until its window closes (`close`).
import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from 'mailparser';
import type { Account, Address, AttachmentInfo, EmlComposeMode, EmlMessage, MessageBody, MessageHeader } from '../../shared/ipc';
import { EML_ERROR_TEXT, EML_MAX_BYTES, EML_MAX_OPEN, hasMsgMagic, type EmlErrorCode } from '../../shared/emlErrors';
import { AppException } from '../../shared/errors';
import type { EngineContext } from '../context';
import { hasRemoteImages, makeSnippet } from './bodyUtils';

/** Same display cap as mailbox mail (see MessageService). */
const MAX_DISPLAY_BYTES = 25 * 1024 * 1024;
const MAX_CID_BYTES = 2 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 10_000;
const MAX_ADDRESSES = 500;
const MAX_SUBJECT_CHARS = 2000;
/** Stand-in ids of a message that is not in a mailbox. Real ids are never negative. */
export const EML_HEADER_ID = -1;

/** The first bytes may carry a UTF-8 byte order mark. */
const BOM = [0xef, 0xbb, 0xbf];
const HEAD_BYTES = 64 * 1024;
const KNOWN_HEADERS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding',
  'received', 'return-path', 'delivered-to', 'reply-to', 'sender', 'in-reply-to', 'references', 'x-mailer', 'user-agent',
  'authentication-results', 'list-id', 'x-original-to', 'resent-from', 'importance', 'priority', 'thread-topic',
]);

/**
 * Does the start of the file look like the header block of an email? mailparser accepts any bytes
 * (a text file simply becomes a body), so "not an email" needs its own check: the file must start
 * with `Name: value` header lines, at least one of them a well-known mail header, and no binary
 * bytes. An mbox "From " line in front is allowed.
 */
export function looksLikeEmail(buf: Uint8Array): boolean {
  let start = 0;
  if (buf.length >= 3 && BOM.every((b, i) => buf[i] === b)) start = 3;
  const head = Buffer.from(buf.buffer, buf.byteOffset + start, Math.min(buf.length - start, HEAD_BYTES)).toString('latin1');
  const lines = head.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (i < lines.length && /^From \S/.test(lines[i]!)) i++; // mbox separator
  let sawKnown = false;
  let sawHeader = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '') break; // end of the header block
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0e-\x1f]/.test(line)) return false;
    if (/^[ \t]/.test(line)) {
      if (!sawHeader) return false;
      continue; // folded header line
    }
    const m = /^([A-Za-z][A-Za-z0-9-]*):/.exec(line);
    if (!m) return false;
    sawHeader = true;
    if (KNOWN_HEADERS.has(m[1]!.toLowerCase()) || /^x-/i.test(m[1]!)) sawKnown = true;
  }
  return sawHeader && sawKnown;
}

function isBlank(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    const c = buf[i]!;
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
  }
  return buf.length <= 4096;
}

function fail(code: EmlErrorCode): AppException {
  return new AppException('INVALID_INPUT', EML_ERROR_TEXT[code], { details: code });
}

function toAddresses(v: AddressObject | AddressObject[] | undefined): Address[] {
  if (!v) return [];
  const out: Address[] = [];
  const add = (e: { name?: string; address?: string; group?: unknown[] }): void => {
    if (out.length >= MAX_ADDRESSES) return;
    if (e.group) {
      for (const g of e.group as { name?: string; address?: string }[]) add(g);
      return;
    }
    const address = e.address?.trim();
    if (!address) return;
    const a: Address = { address: address.slice(0, 320) };
    const name = e.name?.trim();
    if (name) a.name = name.slice(0, 200);
    out.push(a);
  };
  for (const o of Array.isArray(v) ? v : [v]) for (const e of o.value) add(e);
  return out;
}

interface FileAttachment {
  info: AttachmentInfo;
  content: Buffer;
}

interface Entry {
  token: string;
  fileName: string;
  filePath: string;
  raw: Buffer;
  message: EmlMessage;
  attachments: FileAttachment[];
}

/** Rejects after `ms`. The parser cannot be cancelled; this only stops waiting for it. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(fail('unreadable')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Name for a nested message (message/rfc822) that has none: its Subject, else "message". */
async function nestedName(content: Buffer): Promise<string> {
  try {
    const p = await withTimeout(simpleParser(content.subarray(0, 16 * 1024)), 2000);
    const s = (p.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    return `${s || 'message'}.eml`;
  } catch {
    return 'message.eml';
  }
}

export type EmlComposeHook = (
  src: MessageBody,
  mode: EmlComposeMode,
  files: { filename: string; contentType: string; data: Uint8Array }[],
) => Promise<{ draftId: string }>;

export class EmlService {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly ctx: Pick<EngineContext, 'log'>,
    private readonly compose: EmlComposeHook,
  ) {}

  /** Number of messages kept in memory (tests). */
  get size(): number {
    return this.entries.size;
  }

  async open(req: { token: string; data: Uint8Array; fileName: string; filePath: string; mtimeMs: number }): Promise<{ subject: string }> {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(req.token) || this.entries.has(req.token)) {
      throw new AppException('INVALID_INPUT', 'The request was not valid.');
    }
    if (!(req.data instanceof Uint8Array)) throw fail('unreadable');
    if (this.entries.size >= EML_MAX_OPEN) throw fail('tooManyOpen');
    if (req.data.byteLength > EML_MAX_BYTES) throw fail('tooLarge');
    if (hasMsgMagic(req.data)) throw fail('msgUnsupported');
    const raw = Buffer.from(req.data.buffer, req.data.byteOffset, req.data.byteLength);
    // An empty file is an empty message, not an error (3.14.4).
    const empty = isBlank(raw);
    if (!empty && !looksLikeEmail(raw)) throw fail('notEmail');

    let parsed: ParsedMail | null = null;
    if (!empty) {
      try {
        parsed = await withTimeout(simpleParser(raw, { skipImageLinks: true }), PARSE_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof AppException) throw e;
        this.ctx.log.warn({ err: String((e as Error)?.message ?? e) }, 'could not parse an .eml file');
        throw fail('unreadable');
      }
    }
    const entry = await this.build(req, raw, parsed);
    this.entries.set(req.token, entry);
    return { subject: entry.message.header.subject };
  }

  private async build(
    req: { token: string; fileName: string; filePath: string; mtimeMs: number },
    raw: Buffer,
    parsed: ParsedMail | null,
  ): Promise<Entry> {
    const html = parsed && typeof parsed.html === 'string' ? parsed.html : null;
    const text = parsed?.text ?? null;
    const atts: FileAttachment[] = [];
    let index = 0;
    let named = 0;
    for (const a of (parsed?.attachments ?? []) as Attachment[]) {
      index++;
      const cid = a.cid ?? null;
      const inline = !!cid && !!html && html.includes(`cid:${cid}`);
      let filename = a.filename ?? null;
      const contentType = a.contentType || 'application/octet-stream';
      // A nested message is an attachment (never opened inside this one): give it a useful name.
      if (!filename && /^message\/rfc822$/i.test(contentType)) {
        // Only the first 20 are named from their subject, so many nested parts cannot stretch the 10 s limit.
        filename = ++named <= 20 ? await nestedName(a.content) : 'message.eml';
      }
      atts.push({
        info: { id: index, filename, contentType, size: a.size ?? a.content.length, contentId: cid, inline },
        content: a.content,
      });
    }
    const tooBig = raw.length > MAX_DISPLAY_BYTES;
    const date = parsed?.date && Number.isFinite(parsed.date.getTime()) ? parsed.date.getTime() : req.mtimeMs;
    const messageId = parsed?.messageId ?? null;
    const header: MessageHeader = {
      id: EML_HEADER_ID,
      accountId: '',
      folderId: -1,
      uid: 0,
      messageIdHeader: messageId,
      subject: (parsed?.subject ?? '').slice(0, MAX_SUBJECT_CHARS),
      from: toAddresses(parsed?.from)[0] ?? null,
      to: toAddresses(parsed?.to),
      cc: toAddresses(parsed?.cc),
      date,
      snippet: tooBig ? '' : makeSnippet(text, html),
      seen: true,
      flagged: false,
      answered: false,
      draft: false,
      hasAttachments: atts.some((a) => !a.info.inline),
      size: raw.length,
      bodyCached: true,
    };
    const refs = parsed?.references;
    const body: MessageBody = {
      id: EML_HEADER_ID,
      header,
      bcc: toAddresses(parsed?.bcc),
      replyTo: toAddresses(parsed?.replyTo),
      inReplyTo: parsed?.inReplyTo ?? null,
      references: Array.isArray(refs) ? refs.join(' ') : (refs ?? null),
      html: tooBig ? null : html,
      text: tooBig ? null : text,
      attachments: atts.map((a) => a.info),
      hasRemoteImages: tooBig ? false : hasRemoteImages(html),
      senderImagesAllowed: false, // "Always load" is for mailbox senders; a file only has "Load images"
      truncated: tooBig,
    };
    return {
      token: req.token,
      fileName: req.fileName,
      filePath: req.filePath,
      raw,
      message: { token: req.token, fileName: req.fileName, filePath: req.filePath, header, body },
      attachments: atts,
    };
  }

  private require(token: string): Entry {
    const e = this.entries.get(token);
    if (!e) throw new AppException('NOT_FOUND', 'This message is no longer available. Open the file again.');
    return e;
  }

  get(token: string): EmlMessage {
    return this.require(token).message;
  }

  close(token: string): void {
    this.entries.delete(token);
  }

  closeAll(): void {
    this.entries.clear();
  }

  cidData(token: string, contentId: string): { contentType: string; data: Uint8Array } | null {
    const a = this.require(token).attachments.find((x) => x.info.contentId === contentId);
    if (!a || a.content.length > MAX_CID_BYTES) return null;
    return { contentType: a.info.contentType, data: new Uint8Array(a.content) };
  }

  rawSource(token: string): { source: string } {
    return { source: this.require(token).raw.toString('utf8') };
  }

  attachment(token: string, attachmentId: number): { filename: string; contentType: string; data: Uint8Array } {
    const a = this.require(token).attachments.find((x) => x.info.id === attachmentId);
    if (!a) throw new AppException('NOT_FOUND', 'The attachment is no longer in the message.');
    return {
      filename: a.info.filename ?? `attachment-${a.info.id}`,
      contentType: a.info.contentType,
      data: new Uint8Array(a.content),
    };
  }

  attachments(token: string): { filename: string; contentType: string; data: Uint8Array }[] {
    return this.require(token)
      .attachments.filter((a) => !a.info.inline)
      .map((a) => ({
        filename: a.info.filename ?? `attachment-${a.info.id}`,
        contentType: a.info.contentType,
        data: new Uint8Array(a.content),
      }));
  }

  /** Reply / Reply all / Forward: the draft is built now, so compose never needs the token. */
  async composeFrom(token: string, mode: EmlComposeMode): Promise<{ draftId: string }> {
    const e = this.require(token);
    const files =
      mode === 'forward'
        ? e.attachments
            .filter((a) => !a.info.inline)
            .map((a) => ({
              filename: a.info.filename ?? `attachment-${a.info.id}`,
              contentType: a.info.contentType,
              data: a.content as Uint8Array,
            }))
        : [];
    return this.compose(e.message.body, mode, files);
  }
}

/** The account a reply from a file uses: the first one that is turned on (same as a new message). */
export function defaultAccount(accounts: Account[]): Account | undefined {
  return accounts.find((a) => a.enabled) ?? accounts[0];
}
