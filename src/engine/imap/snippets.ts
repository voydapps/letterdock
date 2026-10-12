// List snippets during header sync: peek at the first few KB of the text part (BODY.PEEK, so the
// server never sets \Seen). Best effort: any failure just leaves the snippet empty until the
// message body is opened.
import type { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { EngineContext } from '../context';
import type { FolderRow } from '../db/repos/folderRepo';
import { makeSnippet } from '../messages/bodyUtils';
import { pickSnippetPart, type FetchedLike, type SnippetPart } from './parse';
import { toSequenceSet } from './syncDiff';

const PEEK_BYTES = 3072;
/** HTML mails often start with a long <head>/<style>: ask again with more bytes when 3 KB showed no text. */
const PEEK_BYTES_HTML = 16384;

/** A cut-off quoted-printable chunk can end inside an "=XX" escape: drop the half escape. */
function trimPartialQp(bytes: Buffer): Buffer {
  let end = bytes.length;
  // "=" or "=X" at the very end (X = hex digit).
  if (end >= 1 && bytes[end - 1] === 0x3d) end -= 1;
  else if (
    end >= 2 &&
    bytes[end - 2] === 0x3d &&
    /[0-9a-f]/i.test(String.fromCharCode(bytes[end - 1]))
  )
    end -= 2;
  return end === bytes.length ? bytes : bytes.subarray(0, end);
}

export async function snippetOf(
  part: SnippetPart,
  bytes: Buffer,
  truncated = false,
): Promise<string> {
  const qp = part.encoding.toLowerCase() === 'quoted-printable';
  const body = truncated && qp ? trimPartialQp(bytes) : bytes;
  const head =
    `Content-Type: ${part.type}${part.charset ? `; charset="${part.charset}"` : ''}\r\n` +
    `Content-Transfer-Encoding: ${part.encoding}\r\n\r\n`;
  const parsed = await simpleParser(Buffer.concat([Buffer.from(head), body]));
  if (part.type === 'text/html') {
    // mailparser also turns the HTML into text (with "<url>" links and the CSS of a cut-off
    // <style>); ignore that and strip the HTML ourselves.
    const html = typeof parsed.html === 'string' ? parsed.html : '';
    return makeSnippet(null, html);
  }
  return makeSnippet(parsed.text ?? null, null);
}

type Own = (uid: number) => SnippetPart | undefined;

/**
 * Peek at one body part of these messages. HTML gets a second, bigger peek when the first showed no
 * text. Returns the snippets found and the uids that fetched fine but have no usable text.
 */
async function peekGroup(
  client: ImapFlow,
  key: string,
  uids: number[],
  own: Own,
  fallbackSize: boolean,
  idByUid: Map<number, number>,
): Promise<{ got: { id: number; uid: number; snippet: string }[]; empty: number[] }> {
  const got: { id: number; uid: number; snippet: string }[] = [];
  const empty: number[] = [];
  let pending = uids;
  for (const maxLength of fallbackSize ? [PEEK_BYTES, PEEK_BYTES_HTML] : [PEEK_BYTES]) {
    if (pending.length === 0) break;
    const rows = (await client.fetchAll(
      toSequenceSet(pending),
      { uid: true, bodyParts: [{ key, start: 0, maxLength }] },
      { uid: true },
    )) as unknown as { uid: number; bodyParts?: Map<string, Buffer> }[];
    const again: number[] = [];
    for (const r of rows) {
      const buf = r.bodyParts?.get(key.toLowerCase()) ?? r.bodyParts?.get(key);
      const id = idByUid.get(r.uid);
      const part = own(r.uid);
      if (!buf || id === undefined || !part) continue;
      const truncated = buf.length >= maxLength;
      const snippet = await snippetOf(part, buf, truncated).catch(() => '');
      if (snippet) got.push({ id, uid: r.uid, snippet });
      else if (truncated && part.type === 'text/html' && maxLength < PEEK_BYTES_HTML)
        again.push(r.uid);
      else empty.push(r.uid);
    }
    pending = again;
  }
  return { got, empty };
}

/** `fetched` are header rows just upserted; `ids` maps uid -> message id for the added rows. */
export async function fillSnippets(
  ctx: EngineContext,
  client: ImapFlow,
  fetched: FetchedLike[],
  idByUid: Map<number, number>,
  /** Set to `failed: true` when a server fetch failed (the rows may work next time). */
  stats?: { failed: boolean },
): Promise<number[]> {
  const parts = new Map<number, SnippetPart>();
  const byKey = new Map<string, { part: SnippetPart; uids: number[] }>();
  for (const m of fetched) {
    if (!idByUid.has(m.uid)) continue;
    const part = pickSnippetPart(m.bodyStructure);
    if (!part) continue;
    parts.set(m.uid, part);
    const g = byKey.get(part.part) ?? { part, uids: [] };
    g.uids.push(m.uid);
    byKey.set(part.part, g);
  }
  const out: { id: number; snippet: string }[] = [];
  // Messages whose plain-text part gave nothing usable (empty, or code): try their HTML part.
  const fallbacks = new Map<string, { part: SnippetPart; uids: number[] }>();
  for (const [key, g] of byKey) {
    try {
      // Per-message encoding/charset can differ inside one group; use that message's own part.
      const res = await peekGroup(
        client,
        key,
        g.uids,
        (uid) => parts.get(uid) ?? g.part,
        g.part.type === 'text/html',
        idByUid,
      );
      for (const r of res.got) out.push({ id: r.id, snippet: r.snippet });
      for (const uid of res.empty) {
        const fb = parts.get(uid)?.fallback;
        if (!fb) continue;
        const f = fallbacks.get(fb.part) ?? { part: fb, uids: [] };
        f.uids.push(uid);
        fallbacks.set(fb.part, f);
      }
    } catch (e) {
      if (stats) stats.failed = true;
      ctx.log.debug({ err: (e as Error).message }, 'snippet peek failed');
    }
  }
  for (const [key, g] of fallbacks) {
    try {
      const res = await peekGroup(
        client,
        key,
        g.uids,
        (uid) => parts.get(uid)?.fallback ?? g.part,
        true,
        idByUid,
      );
      for (const r of res.got) out.push({ id: r.id, snippet: r.snippet });
    } catch (e) {
      if (stats) stats.failed = true;
      ctx.log.debug({ err: (e as Error).message }, 'snippet fallback peek failed');
    }
  }
  if (out.length > 0) ctx.messages.setSnippets(out);
  return out.map((o) => o.id);
}

export const BACKFILL_BATCH = 50;

/**
 * Background backfill for rows synced before snippets existed. Takes one batch of the newest rows
 * with an empty snippet in the folder that is open on `client`. Returns how many rows it looked at
 * (0 = nothing left to do). Rows with no text part, or whose message is gone, are marked as checked.
 * A fetch that failed (network) is not marked, so a later run tries again.
 */
export async function backfillSnippetBatch(
  ctx: EngineContext,
  client: ImapFlow,
  folder: FolderRow,
  limit = BACKFILL_BATCH,
): Promise<number> {
  const todo = ctx.messages.snippetTodo(folder.id, limit);
  if (todo.length === 0) return 0;
  const idByUid = new Map(todo.map((t) => [t.uid, t.id] as const));
  const rows = (await client.fetchAll(
    toSequenceSet([...idByUid.keys()]),
    { uid: true, bodyStructure: true },
    { uid: true },
  )) as unknown as FetchedLike[];
  const stats = { failed: false };
  const filled = await fillSnippets(ctx, client, rows, idByUid, stats);
  const tried = stats.failed ? filled : todo.map((t) => t.id);
  ctx.messages.markSnippetChecked(tried);
  if (filled.length > 0) ctx.hub.changed({ folderIds: [folder.id], updated: filled });
  if (stats.failed) throw new Error('snippet peek failed');
  return todo.length;
}
