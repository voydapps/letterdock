// Parsing .eml files in the engine (DESIGN-SPEC 3.14.5): emlService.ts. No mail server needed.
import { describe, expect, it } from 'vitest';
import { EmlService, looksLikeEmail } from '../../src/engine/messages/emlService';
import { nullLogger } from '../../src/engine/logger';
import { EML_MAX_BYTES, EML_MAX_OPEN } from '../../src/shared/emlErrors';
import type { MessageBody } from '../../src/shared/ipc';

const CRLF = '\r\n';
const msg = (headers: string[], body: string) => headers.join(CRLF) + CRLF + CRLF + body;
let seq = 0;
const tok = () => `tok-${(++seq).toString().padStart(6, '0')}-abcd`;

function make() {
  const composed: { src: MessageBody; mode: string; files: { filename: string }[] }[] = [];
  const svc = new EmlService({ log: nullLogger() }, async (src, mode, files) => {
    composed.push({ src, mode, files });
    return { draftId: 'd1' };
  });
  const open = async (raw: string | Buffer, over: { token?: string; fileName?: string; mtimeMs?: number } = {}) => {
    const token = over.token ?? tok();
    const data = new Uint8Array(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw);
    const res = await svc.open({ token, data, fileName: over.fileName ?? 'm.eml', filePath: 'C:\\x\\m.eml', mtimeMs: over.mtimeMs ?? 1_700_000_000_000 });
    return { token, ...res };
  };
  return { svc, open, composed };
}

const rejectCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { appError?: { details?: string; code?: string } }).appError?.details;
  }
  return 'did not reject';
};

describe('looksLikeEmail', () => {
  it('accepts the start of a normal message, with a BOM, mbox line, blank lines or folded headers', () => {
    expect(looksLikeEmail(Buffer.from('From: a@b.com\r\nSubject: x\r\n\r\nhi'))).toBe(true);
    expect(looksLikeEmail(Buffer.from('\ufeffFrom: a@b.com\r\n\r\n', 'utf8'))).toBe(true);
    expect(looksLikeEmail(Buffer.from('\r\n\r\nSubject: x\n\nhi'))).toBe(true);
    expect(looksLikeEmail(Buffer.from('From sender@x.com Mon Oct  5 10:00:00 2026\nSubject: x\n\nhi'))).toBe(true);
    expect(looksLikeEmail(Buffer.from('Received: from a\r\n by b\r\n\twith smtp\r\nSubject: s\r\n\r\n'))).toBe(true);
    expect(looksLikeEmail(Buffer.from('X-Custom: 1\n\nbody'))).toBe(true);
  });

  it('rejects text, binary and files that only look a little like headers', () => {
    expect(looksLikeEmail(Buffer.from('hello world, this is a note\nsecond line'))).toBe(false);
    expect(looksLikeEmail(Buffer.from('Note: buy milk\n\nbody'))).toBe(false); // unknown header names only
    expect(looksLikeEmail(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]))).toBe(false);
    expect(looksLikeEmail(Buffer.from('{"json": true}'))).toBe(false);
    expect(looksLikeEmail(Buffer.from('<html><body>not mail</body></html>'))).toBe(false);
    expect(looksLikeEmail(Buffer.from(' leading space: x\r\n\r\n'))).toBe(false);
    expect(looksLikeEmail(Buffer.from('Subject: x\u0000y\r\n\r\n'))).toBe(false);
  });
});

describe('EmlService.open: parsing', () => {
  it('plain text message: header, body, no attachments, stand-in ids', async () => {
    const { svc, open } = make();
    const raw = msg(
      ['From: Jane Cooper <jane@acme.example>', 'To: Me <me@x.com>, bob@x.com', 'Cc: Carol <carol@x.com>', 'Subject: Hello there', 'Date: Mon, 05 Oct 2026 10:42:00 +0000', 'Message-ID: <abc@acme.example>', 'In-Reply-To: <prev@acme.example>', 'References: <a@x> <prev@acme.example>', 'Reply-To: Support <support@acme.example>', 'Bcc: Hidden <hidden@x.com>', 'Content-Type: text/plain; charset=utf-8'],
      'Line one\r\nLine two\r\n',
    );
    const { token, subject } = await open(raw, { fileName: 'hello.eml' });
    expect(subject).toBe('Hello there');
    const m = svc.get(token);
    expect(m.fileName).toBe('hello.eml');
    expect(m.filePath).toBe('C:\\x\\m.eml');
    expect(m.header).toMatchObject({
      id: -1, accountId: '', folderId: -1, subject: 'Hello there', seen: true, flagged: false, draft: false,
      from: { name: 'Jane Cooper', address: 'jane@acme.example' },
      messageIdHeader: '<abc@acme.example>',
      date: Date.parse('2026-10-05T10:42:00Z'),
      hasAttachments: false,
    });
    expect(m.header.to.map((a) => a.address)).toEqual(['me@x.com', 'bob@x.com']);
    expect(m.header.cc.map((a) => a.address)).toEqual(['carol@x.com']);
    expect(m.body.text).toContain('Line one');
    expect(m.body.html).toBeNull();
    expect(m.body.bcc.map((a) => a.address)).toEqual(['hidden@x.com']);
    expect(m.body.replyTo[0]?.address).toBe('support@acme.example');
    expect(m.body.inReplyTo).toBe('<prev@acme.example>');
    expect(m.body.references).toContain('<prev@acme.example>');
    expect(m.body).toMatchObject({ id: -1, senderImagesAllowed: false, truncated: false, hasRemoteImages: false, attachments: [] });
  });

  it('the result has the same fields as a mailbox message (MessageBody / MessageHeader)', async () => {
    const { svc, open } = make();
    const { token } = await open(msg(['From: a@b.com', 'Subject: s', 'Content-Type: text/plain'], 'x'));
    const m = svc.get(token);
    // The keys a mailbox MessageBody has (see shared/ipc.ts). A new field there must be decided here too.
    expect(Object.keys(m.body).sort()).toEqual(
      ['attachments', 'bcc', 'hasRemoteImages', 'header', 'html', 'id', 'inReplyTo', 'references', 'replyTo', 'senderImagesAllowed', 'text', 'truncated'],
    );
    expect(Object.keys(m.header).sort()).toEqual(
      ['accountId', 'answered', 'bodyCached', 'cc', 'date', 'draft', 'flagged', 'folderId', 'from', 'hasAttachments', 'id', 'messageIdHeader', 'seen', 'size', 'snippet', 'subject', 'to', 'uid'],
    );
  });

  it('HTML message keeps the raw HTML (the window sanitizes it) and sees remote images', async () => {
    const { svc, open } = make();
    const html = '<p onclick="steal()">Hi</p><script>alert(1)</script><img src="https://tracker.example.net/p.gif" width="1" height="1">';
    const { token } = await open(
      msg(['From: a@b.com', 'Subject: html', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8'], html),
    );
    const m = svc.get(token);
    expect(m.body.html).toContain('<script>'); // raw on purpose (ARCHITECTURE section 9); tests/renderer/emlFileSanitize.test.ts checks the window's sanitizer on it
    expect(m.body.hasRemoteImages).toBe(true);
  });

  it('multipart with attachments and an inline cid image', async () => {
    const { svc, open } = make();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const raw = [
      'From: a@b.com', 'Subject: parts', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="MIX"', '',
      '--MIX', 'Content-Type: multipart/related; boundary="REL"', '',
      '--REL', 'Content-Type: text/html; charset=utf-8', '', '<p>Logo: <img src="cid:logo123"></p>', '',
      '--REL', 'Content-Type: image/png', 'Content-ID: <logo123>', 'Content-Disposition: inline; filename="logo.png"', 'Content-Transfer-Encoding: base64', '', png.toString('base64'), '',
      '--REL--', '',
      '--MIX', 'Content-Type: application/pdf; name="invoice.pdf"', 'Content-Disposition: attachment; filename="invoice.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 fake').toString('base64'), '',
      '--MIX--', '',
    ].join(CRLF);
    const { token } = await open(raw);
    const m = svc.get(token);
    expect(m.header.hasAttachments).toBe(true);
    expect(m.body.attachments.map((a) => [a.filename, a.inline, a.contentId])).toEqual([
      ['logo.png', true, 'logo123'],
      ['invoice.pdf', false, null],
    ]);
    expect(m.body.attachments.map((a) => a.id)).toEqual([1, 2]);
    const cid = svc.cidData(token, 'logo123');
    expect(cid?.contentType).toBe('image/png');
    expect(Buffer.from(cid!.data).equals(png)).toBe(true);
    expect(svc.cidData(token, 'nope')).toBeNull();
    const att = svc.attachment(token, 2);
    expect(att.filename).toBe('invoice.pdf');
    expect(Buffer.from(att.data).toString()).toBe('%PDF-1.4 fake');
    expect(svc.attachments(token).map((a) => a.filename)).toEqual(['invoice.pdf']); // "Save all": not the inline image
    expect(() => svc.attachment(token, 99)).toThrow(/no longer in the message/);
  });

  it('a nested message stays an attachment named after its subject; it is never opened inside the outer one', async () => {
    const { svc, open } = make();
    let inner = msg(['From: in@x.com', 'Subject: Innermost', 'Content-Type: text/plain'], 'deep');
    for (let i = 0; i < 8; i++) {
      inner = [
        `From: lvl${i}@x.com`, `Subject: Level ${i}`, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B' + i + '"', '',
        '--B' + i, 'Content-Type: text/plain', '', `body ${i}`, '--B' + i, 'Content-Type: message/rfc822', '', inner, '', '--B' + i + '--', '',
      ].join(CRLF);
    }
    const { token } = await open(inner);
    const m = svc.get(token);
    expect(m.body.text).toContain('body 7');
    expect(m.body.attachments).toHaveLength(1); // the inner messages are not flattened into the outer list
    expect(m.body.attachments[0]).toMatchObject({ contentType: 'message/rfc822', inline: false });
    expect(m.body.attachments[0]!.filename).toBe('Level 6.eml');
    expect(Buffer.from(svc.attachment(token, 1).data).toString()).toContain('Subject: Level 6');
  });

  it('a bad or unknown charset does not fail', async () => {
    const { svc, open } = make();
    const { token } = await open(
      Buffer.concat([Buffer.from(['From: a@b.com', 'Subject: charset', 'Content-Type: text/plain; charset=bogus-9', '', ''].join(CRLF)), Buffer.from([0x63, 0x61, 0x66, 0xe9])]),
    );
    expect(svc.get(token).body.text).toContain('caf');
  });

  it('encoded subject and name are decoded', async () => {
    const { svc, open } = make();
    const { token } = await open(msg(['From: =?UTF-8?Q?J=C3=BCrgen?= <j@x.com>', 'Subject: =?UTF-8?B?Q2Fmw6k=?=', 'Content-Type: text/plain'], 'x'));
    expect(svc.get(token).header.subject).toBe('Café');
    expect(svc.get(token).header.from?.name).toBe('Jürgen');
  });

  it('a huge header value and a long address list are cut, not fatal', async () => {
    const { svc, open } = make();
    const many = Array.from({ length: 800 }, (_, i) => `u${i}@x.com`).join(', ');
    const { token } = await open(msg(['From: a@b.com', 'Subject: ' + 'S'.repeat(60_000), 'To: ' + many, 'Content-Type: text/plain'], 'x'));
    const m = svc.get(token);
    expect(m.header.subject.length).toBeLessThanOrEqual(2000);
    expect(m.header.to.length).toBe(500);
  });

  it('headers only: opens with no body; a missing Date uses the file time', async () => {
    const { svc, open } = make();
    const { token } = await open('Subject: only headers\r\nFrom: a@b.com\r\n', { mtimeMs: 1_650_000_000_000 });
    const m = svc.get(token);
    expect(m.header.subject).toBe('only headers');
    expect(m.header.date).toBe(1_650_000_000_000);
    expect(m.body.text === null || m.body.text === '').toBe(true);
  });

  it('an empty file is an empty message, not an error', async () => {
    const { svc, open } = make();
    for (const raw of ['', '  \r\n\r\n  ']) {
      const { token } = await open(raw);
      const m = svc.get(token);
      expect(m.header.subject).toBe('');
      expect(m.body).toMatchObject({ html: null, text: null, attachments: [], truncated: false });
    }
  });

  it('text that is not mail, and binary garbage, are "not an email"', async () => {
    const { open } = make();
    expect(await rejectCode(open('just some notes\nnothing like headers'))).toBe('notEmail');
    expect(await rejectCode(open(Buffer.from([1, 2, 3, 0, 255, 254, 10, 13, 0, 0, 7])))).toBe('notEmail');
    expect(await rejectCode(open('<?xml version="1.0"?><a/>'))).toBe('notEmail');
  });

  it('an Outlook .msg (OLE) file is refused by its first bytes', async () => {
    const { open } = make();
    expect(await rejectCode(open(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])))).toBe('msgUnsupported');
  });

  it('the size cap is enforced in the engine too', async () => {
    const { svc } = make();
    const big = new Uint8Array(EML_MAX_BYTES + 1);
    big.set(Buffer.from('Subject: x\r\n\r\n'));
    expect(await rejectCode(svc.open({ token: tok(), data: big, fileName: 'a.eml', filePath: 'C:\\a.eml', mtimeMs: 1 }))).toBe('tooLarge');
  });

  it('a message over the display cap opens without a body (like a mailbox message)', async () => {
    const { svc, open } = make();
    const pad = 'A'.repeat(26 * 1024 * 1024);
    const { token } = await open(msg(['From: a@b.com', 'Subject: huge', 'Content-Type: text/plain'], pad));
    const m = svc.get(token);
    expect(m.body).toMatchObject({ truncated: true, text: null, html: null });
    expect(m.header.subject).toBe('huge');
  }, 60_000);
});

describe('EmlService: tokens and lifecycle', () => {
  it('get after close is NOT_FOUND; a token cannot be used twice or be odd', async () => {
    const { svc, open } = make();
    const { token } = await open(msg(['From: a@b.com', 'Subject: s'], 'x'));
    expect(svc.size).toBe(1);
    svc.close(token);
    expect(svc.size).toBe(0);
    expect(() => svc.get(token)).toThrowError(/no longer available/);
    const t2 = tok();
    await open(msg(['From: a@b.com', 'Subject: s'], 'x'), { token: t2 });
    await expect(open(msg(['From: a@b.com', 'Subject: s'], 'x'), { token: t2 })).rejects.toBeTruthy();
    await expect(open('Subject: x\r\n\r\n', { token: '../../etc' })).rejects.toBeTruthy();
    expect(() => svc.rawSource('missing-token-1')).toThrow();
    expect(() => svc.cidData('missing-token-1', 'x')).toThrow();
  });

  it('each token has its own message', async () => {
    const { svc, open } = make();
    const a = await open(msg(['From: a@b.com', 'Subject: AAA'], 'x'));
    const b = await open(msg(['From: a@b.com', 'Subject: BBB'], 'x'));
    expect(svc.get(a.token).header.subject).toBe('AAA');
    expect(svc.get(b.token).header.subject).toBe('BBB');
    svc.close(a.token);
    expect(svc.get(b.token).header.subject).toBe('BBB');
  });

  it('keeps at most 15 messages', async () => {
    const { svc, open } = make();
    for (let i = 0; i < EML_MAX_OPEN; i++) await open(msg(['From: a@b.com', 'Subject: s'], 'x'));
    expect(await rejectCode(open(msg(['From: a@b.com', 'Subject: s'], 'x')))).toBe('tooManyOpen');
    expect(svc.size).toBe(EML_MAX_OPEN);
  });

  it('View source returns the exact text of the file', async () => {
    const { svc, open } = make();
    const raw = msg(['From: a@b.com', 'Subject: src'], 'hello');
    const { token } = await open(raw);
    expect(svc.rawSource(token).source).toBe(raw);
  });

  it('Forward hands over the attachments; Reply hands over none', async () => {
    const { svc, open, composed } = make();
    const raw = [
      'From: a@b.com', 'Subject: fw', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="M"', '',
      '--M', 'Content-Type: text/plain', '', 'see attached', '--M', 'Content-Type: text/plain; name="n.txt"', 'Content-Disposition: attachment; filename="n.txt"', '', 'file text', '--M--', '',
    ].join(CRLF);
    const { token } = await open(raw);
    await svc.composeFrom(token, 'forward');
    await svc.composeFrom(token, 'reply');
    await svc.composeFrom(token, 'replyAll');
    expect(composed.map((c) => [c.mode, c.files.map((f) => f.filename)])).toEqual([
      ['forward', ['n.txt']],
      ['reply', []],
      ['replyAll', []],
    ]);
    expect(composed[0]!.src.header.subject).toBe('fw');
  });
});
