// Reply / Reply all / Forward from a message opened from an .eml file (DESIGN-SPEC 3.14.3 / 3.14.5):
// the engine builds the draft at the click, with the default account, and compose needs no token after that.
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComposeDraft, EmlMessage } from '../../src/shared/ipc';
import { ComposeRepo } from '../../src/engine/db/repos/composeRepo';
import { createHarness, waitFor, type Harness } from '../fakes/engineHarness';
import { startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';

let imap: FakeImapServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  await imap?.close().catch(() => undefined);
  h = imap = null;
});

const handle = <T>(hh: Harness, ch: string, req?: unknown) => hh.engine.handle(ch, req) as Promise<T>;

const CRLF = '\r\n';
const FILE = [
  'From: Jane Cooper <jane@acme.example>',
  'To: Me <me@example.com>, Bob <bob@acme.example>',
  'Cc: Carol <carol@acme.example>, Me Again <ME@example.com>',
  'Reply-To: Support <support@acme.example>',
  'Subject: Invoice for October',
  'Message-ID: <inv-1@acme.example>',
  'References: <earlier@acme.example>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="M"',
  '',
  '--M',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Please see the attached invoice.',
  '--M',
  'Content-Type: application/pdf; name="inv.pdf"',
  'Content-Disposition: attachment; filename="inv.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-fake-invoice').toString('base64'),
  '--M--',
  '',
].join(CRLF);

async function boot(withAccount: boolean) {
  imap = await startFakeImap({ inbox: [] });
  h = await createHarness(imap);
  let acc = null;
  if (withAccount) {
    acc = await h.addAccount();
    await waitFor('folders', () => h!.engine.ctx.folders.rowByRole(acc!.id, 'sent'));
  }
  const token = 'file-token-0001';
  await handle(h, 'eml.open', {
    token,
    data: new Uint8Array(Buffer.from(FILE)),
    fileName: 'inv.eml',
    filePath: 'C:\\x\\inv.eml',
    mtimeMs: 1,
  });
  return { h, acc, token };
}

describe('eml.get / eml.compose through the engine', () => {
  it('eml.get answers the parsed message', async () => {
    const c = await boot(false);
    const m = await handle<EmlMessage>(c.h, 'eml.get', { token: c.token });
    expect(m.header.subject).toBe('Invoice for October');
    expect(m.body.attachments.map((a) => a.filename)).toEqual(['inv.pdf']);
  });

  it('reply: To = Reply-To, Re: subject, quoted text, default account, a saved draft that compose.prepare reopens', async () => {
    const c = await boot(true);
    const { draftId } = await handle<{ draftId: string }>(c.h, 'eml.compose', { token: c.token, mode: 'reply' });
    // The token is not needed any more: close the "window" first.
    await handle(c.h, 'eml.close', { token: c.token });
    const d = await handle<ComposeDraft>(c.h, 'compose.prepare', { mode: 'reply', draftId });
    expect(d.draftId).toBe(draftId);
    expect(d.accountId).toBe(c.acc!.id);
    expect(d.to).toEqual([{ name: 'Support', address: 'support@acme.example' }]);
    expect(d.cc).toEqual([]);
    expect(d.subject).toBe('Re: Invoice for October');
    expect(d.html).toContain('Please see the attached invoice.');
    expect(d.html).toContain('<blockquote');
    expect(d.attachments).toEqual([]);
    expect(d.inReplyToMessageId).toBeNull();
    // The draft is only a compose session: no row in the Drafts folder, nothing uploaded.
    const drafts = c.h.folderByRole(c.acc!.id, 'drafts');
    expect(c.h.folderMessages(drafts.id)).toHaveLength(0);
  });

  it('reply all: adds To and Cc, without any of your own addresses (any letter case)', async () => {
    const c = await boot(true);
    const { draftId } = await handle<{ draftId: string }>(c.h, 'eml.compose', { token: c.token, mode: 'replyAll' });
    const d = await handle<ComposeDraft>(c.h, 'compose.prepare', { mode: 'replyAll', draftId });
    expect(d.to.map((a) => a.address)).toEqual(['support@acme.example', 'bob@acme.example']);
    expect(d.cc.map((a) => a.address)).toEqual(['carol@acme.example']);
  });

  it('forward: Fwd: subject, empty recipients, the attachment is copied into the draft', async () => {
    const c = await boot(true);
    const { draftId } = await handle<{ draftId: string }>(c.h, 'eml.compose', { token: c.token, mode: 'forward' });
    await handle(c.h, 'eml.close', { token: c.token });
    const d = await handle<ComposeDraft>(c.h, 'compose.prepare', { mode: 'forward', draftId });
    expect(d.subject).toBe('Fwd: Invoice for October');
    expect(d.to).toEqual([]);
    expect(d.html).toContain('Please see the attached invoice.');
    expect(d.attachments).toHaveLength(1);
    expect(d.attachments[0]).toMatchObject({ filename: 'inv.pdf', contentType: 'application/pdf' });
    const stored = new ComposeRepo(c.h.engine.ctx.db).file(d.attachments[0]!.tokenId);
    expect(stored).toBeTruthy();
    expect((await readFile(stored!.path)).toString()).toBe('%PDF-fake-invoice');
  });

  it('with no account the engine says so', async () => {
    const c = await boot(false);
    await expect(handle(c.h, 'eml.compose', { token: c.token, mode: 'reply' })).rejects.toMatchObject({
      appError: { code: 'INVALID_INPUT', message: 'Add an account to reply.' },
    });
  });

  it('a closed message cannot be replied to', async () => {
    const c = await boot(true);
    await handle(c.h, 'eml.close', { token: c.token });
    await expect(handle(c.h, 'eml.compose', { token: c.token, mode: 'reply' })).rejects.toMatchObject({
      appError: { code: 'NOT_FOUND' },
    });
  });
});
