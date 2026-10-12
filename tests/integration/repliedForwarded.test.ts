// DESIGN-SPEC 3.16: replied / forwarded marks. Local `flag_forwarded` (migration 015), set after a
// real send, set by the server keyword `$Forwarded`, never cleared by sync; conversation rows take
// the flags of their LATEST message.
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/engine/db/connection';
import { MIGRATIONS } from '../../src/engine/db/migrations';
import { rowToHeader } from '../../src/engine/db/repos/messageRepo';
import type { ComposeDraft, ListConversationsRes, SendReq, SendRes } from '../../src/shared/ipc';
import { createHarness, waitFor, type Harness, type HarnessOptions } from '../fakes/engineHarness';
import { rawMessage, startFakeImap, type FakeImapServer } from '../fakes/fakeImapServer';
import { startFakeSmtp, type FakeSmtpServer } from '../fakes/fakeSmtpServer';

let imap: FakeImapServer | null = null;
let smtp: FakeSmtpServer | null = null;
let h: Harness | null = null;

afterEach(async () => {
  await h?.engine.compose.shutdown().catch(() => undefined);
  await h?.cleanup();
  await imap?.close().catch(() => undefined);
  await smtp?.close().catch(() => undefined);
  h = imap = smtp = null;
});

const HOUR = 3_600_000;
const t0 = Date.now() - 48 * HOUR;

async function boot(harness: Omit<HarnessOptions, 'smtp'> = {}) {
  imap = await startFakeImap({
    inbox: [
      {
        raw: rawMessage({
          subject: 'Lunch?',
          from: 'Alice <alice@example.com>',
          to: 'Me <me@example.com>',
          messageId: '<orig-1@example.com>',
          date: new Date(t0 + HOUR),
        }),
        internaldate: new Date(t0 + HOUR),
      },
      {
        raw: rawMessage({
          subject: 'Budget',
          from: 'Anna <anna@example.com>',
          messageId: '<b1@x>',
          date: new Date(t0 + 2 * HOUR),
        }),
        internaldate: new Date(t0 + 2 * HOUR),
      },
      {
        raw: rawMessage({
          subject: 'Re: Budget',
          from: 'Bob <bob@example.com>',
          messageId: '<b2@x>',
          inReplyTo: '<b1@x>',
          references: '<b1@x>',
          date: new Date(t0 + 5 * HOUR),
        }),
        internaldate: new Date(t0 + 5 * HOUR),
      },
    ],
  });
  smtp = await startFakeSmtp();
  h = await createHarness(imap, { smtp, ...harness });
  h.engine.ctx.draftPushDelayMs = 0;
  const acc = await h.addAccount({ smtp: { host: smtp.host, port: smtp.port, security: smtp.security } });
  await waitFor('inbox synced', () => h!.inboxMessages(acc.id).length === 3);
  await waitFor('folders', () => h!.engine.ctx.folders.rowByRole(acc.id, 'sent'));
  await h.engine.actions.drain();
  const msg = (subject: string) => h!.inboxMessages(acc.id).find((m) => m.subject === subject)!;
  const row = (subject: string) => h!.engine.ctx.messages.row(msg(subject).id)!;
  return { h, imap, smtp, acc, msg, row };
}

const call = <T>(hh: Harness, ch: string, req?: unknown) => hh.engine.handle(ch, req) as Promise<T>;
const serverFlags = (srv: FakeImapServer, uid: number) =>
  srv.mailbox('INBOX').messages.find((m) => m.uid === uid)!.flags;
const reqOf = (d: ComposeDraft, over: Partial<SendReq> = {}): SendReq => ({
  draftId: d.draftId,
  accountId: d.accountId,
  to: d.to,
  cc: d.cc,
  bcc: d.bcc,
  subject: d.subject,
  html: d.html,
  attachmentTokens: d.attachments.map((a) => a.tokenId),
  ...over,
});
const prepare = (hh: Harness, mode: 'reply' | 'forward', sourceMessageId: number) =>
  call<ComposeDraft>(hh, 'compose.prepare', { mode, sourceMessageId });
const forwardTo = { to: [{ address: 'friend@example.com' }] };

describe('migration 015 (message.flag_forwarded)', () => {
  it('upgrades a 014 database: every existing message is not forwarded', () => {
    const before = MIGRATIONS.filter((m) => m.version < 15);
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, before);
    db.exec(`INSERT INTO account (id,email,display_name,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,created_at)
             VALUES ('a','a@x.com','A','generic','password','h',993,'ssl','h',465,'ssl','a',1);
             INSERT INTO folder (id,account_id,path,name,role) VALUES (1,'a','INBOX','INBOX','inbox');
             INSERT INTO message (account_id,folder_id,uid,subject,date_ms,internal_ms,flag_answered) VALUES ('a',1,1,'old mail',5,5,1);`);
    expect(db.pragma('user_version', { simple: true })).toBe(14);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT flag_answered, flag_forwarded FROM message').get()).toEqual({
      flag_answered: 1,
      flag_forwarded: 0,
    });
  });
});

describe('headers', () => {
  it('expose forwarded only when true', async () => {
    const c = await boot();
    const before = c.h.engine.ctx.messages.headers([c.msg('Lunch?').id])[0]!;
    expect('forwarded' in before).toBe(false);
    c.h.engine.ctx.messages.setFlagColumn([before.id], 'flag_forwarded', true);
    const after = c.h.engine.ctx.messages.headers([before.id])[0]!;
    expect(after.forwarded).toBe(true);
    expect(rowToHeader({ ...c.row('Lunch?'), flag_forwarded: 0 })).not.toHaveProperty('forwarded');
  });
});

describe('markReplied', () => {
  it('forward: sets the local mark and queues $Forwarded on the server', async () => {
    const c = await boot();
    const src = c.msg('Lunch?');
    c.h.events.length = 0;
    c.h.engine.actions.markReplied(src.id, 'forwarded');
    expect(c.row('Lunch?').flag_forwarded).toBe(1);
    expect(c.row('Lunch?').flag_answered).toBe(0);
    await waitFor('list refresh event', () =>
      c.h.events.some(
        (e) => e.type === 'messages:changed' && (e.updated as number[] | undefined)?.includes(src.id),
      ),
    );
    await c.h.engine.actions.drain();
    await waitFor('server $Forwarded', () => serverFlags(c.imap, src.uid).includes('$Forwarded'));
  });

  it('reply: sets flag_answered, queues \\Answered, leaves flag_forwarded alone', async () => {
    const c = await boot();
    const src = c.msg('Lunch?');
    c.h.engine.actions.markReplied(src.id, 'answered');
    expect(c.row('Lunch?').flag_answered).toBe(1);
    expect(c.row('Lunch?').flag_forwarded).toBe(0);
    await c.h.engine.actions.drain();
    await waitFor('server \\Answered', () => serverFlags(c.imap, src.uid).includes('\\Answered'));
  });

  it('a server that refuses the keyword never clears the local mark', async () => {
    const c = await boot();
    const src = c.msg('Lunch?');
    c.imap.rejectCommands(['UID STORE']);
    c.h.engine.actions.markReplied(src.id, 'forwarded');
    await c.h.engine.actions.drain();
    expect(serverFlags(c.imap, src.uid)).not.toContain('$Forwarded');
    expect(c.row('Lunch?').flag_forwarded).toBe(1);
    expect(c.h.engine.ctx.messages.headers([src.id])[0]!.forwarded).toBe(true);
  });
});

describe('marks only after a real send', () => {
  it('a sent forward marks the original; a sent reply marks it answered', async () => {
    const c = await boot();
    const fwd = await prepare(c.h, 'forward', c.msg('Lunch?').id);
    await call<SendRes>(c.h, 'compose.send', reqOf(fwd, forwardTo));
    await waitFor('forward marked', () => c.row('Lunch?').flag_forwarded === 1);
    expect(c.row('Lunch?').flag_answered).toBe(0);

    const rep = await prepare(c.h, 'reply', c.msg('Budget').id);
    await call<SendRes>(c.h, 'compose.send', reqOf(rep));
    await waitFor('reply marked', () => c.row('Budget').flag_answered === 1);
    expect(c.row('Budget').flag_forwarded).toBe(0);
  });

  it('undo send: cancelling inside the delay marks nothing', async () => {
    const c = await boot({ settings: { undoSendDelayMs: 20_000 } });
    const fwd = await prepare(c.h, 'forward', c.msg('Lunch?').id);
    const res = await call<SendRes>(c.h, 'compose.send', reqOf(fwd, forwardTo));
    await call(c.h, 'outbox.cancel', { outboxId: res.outboxId });
    await new Promise((r) => setTimeout(r, 500));
    expect(c.row('Lunch?').flag_forwarded).toBe(0);
    expect(c.row('Lunch?').flag_answered).toBe(0);
  });

  it('a failed send marks nothing, and the retry that works marks it', async () => {
    const c = await boot();
    c.smtp.failNextData(10);
    const fwd = await prepare(c.h, 'forward', c.msg('Lunch?').id);
    const res = await call<SendRes>(c.h, 'compose.send', reqOf(fwd, forwardTo));
    await waitFor('failed', async () => {
      const list = (await call(c.h, 'outbox.list')) as { state: string }[];
      return list[0]?.state === 'failed';
    });
    expect(c.row('Lunch?').flag_forwarded).toBe(0);
    c.smtp.failNextData(0);
    await call(c.h, 'outbox.retry', { outboxId: res.outboxId });
    await waitFor('marked after the real send', () => c.row('Lunch?').flag_forwarded === 1);
  });
});

describe('sync and $Forwarded', () => {
  it('sets the mark from the server keyword (any case) and never clears it', async () => {
    const c = await boot();
    const src = c.msg('Lunch?');
    const inbox = c.h.folderByRole(c.acc.id, 'inbox');
    await c.imap.setFlags('INBOX', src.uid, { add: ['$forwarded'] });
    await waitFor('mark from server', async () => {
      await call(c.h, 'sync.folder', { folderId: inbox.id });
      return c.row('Lunch?').flag_forwarded === 1;
    });
    // Another client (or Gmail) drops the keyword: the local mark stays.
    await c.imap.setFlags('INBOX', src.uid, { remove: ['$forwarded'] });
    await c.imap.setFlags('INBOX', src.uid, { add: ['\\Seen'] });
    await waitFor('later flag change synced', async () => {
      await call(c.h, 'sync.folder', { folderId: inbox.id });
      return c.row('Lunch?').flag_seen === 1;
    });
    expect(c.row('Lunch?').flag_forwarded).toBe(1);
    expect(JSON.parse(c.row('Lunch?').keywords_json)).toEqual([]);
  });

  it('\\Answered keeps following the server', async () => {
    const c = await boot();
    const src = c.msg('Lunch?');
    const inbox = c.h.folderByRole(c.acc.id, 'inbox');
    await c.imap.setFlags('INBOX', src.uid, { add: ['\\Answered'] });
    await waitFor('answered from server', async () => {
      await call(c.h, 'sync.folder', { folderId: inbox.id });
      return c.row('Lunch?').flag_answered === 1;
    });
    await c.imap.setFlags('INBOX', src.uid, { remove: ['\\Answered'] });
    await waitFor('answered cleared by server', async () => {
      await call(c.h, 'sync.folder', { folderId: inbox.id });
      return c.row('Lunch?').flag_answered === 0;
    });
  });
});

describe('moves', () => {
  it('the mark survives an archive and the sync of the destination folder (Gmail drops the keyword)', async () => {
    const c = await boot();
    const src = c.msg('Lunch?');
    c.h.engine.actions.markReplied(src.id, 'forwarded');
    c.imap.rejectNext(['UID STORE']); // the server never keeps the keyword
    await call(c.h, 'messages.apply', { messageIds: [src.id], action: { type: 'archive' } });
    await c.h.engine.actions.drain();
    const archive = await waitFor('archive folder', () => c.h.engine.ctx.folders.rowByRole(c.acc.id, 'archive'));
    await call(c.h, 'sync.folder', { folderId: archive.id });
    await waitFor('message arrived in archive', () =>
      c.h.folderMessages(archive.id).some((m) => m.subject === 'Lunch?'),
    );
    const moved = c.h.folderMessages(archive.id).find((m) => m.subject === 'Lunch?')!;
    expect(c.h.engine.ctx.messages.headers([moved.id])[0]!.forwarded).toBe(true);
  });
});

describe('conversation rows', () => {
  it('take the flags of the LATEST message, so a new incoming reply removes the mark', async () => {
    const c = await boot();
    const list = async () =>
      (
        await call<ListConversationsRes>(c.h, 'conversations.list', {
          scope: { kind: 'unifiedInbox' },
          cursor: null,
          limit: 50,
        })
      ).items.find((i) => i.latest.title === 'Budget')!;
    const repo = c.h.engine.ctx.messages;

    // I replied to the first message, then Bob wrote again: the newest message is not marked.
    repo.setFlagColumn([c.msg('Budget').id], 'flag_answered', true);
    repo.setFlagColumn([c.msg('Budget').id], 'flag_forwarded', true);
    let row = await list();
    expect(row.latest.id).toBe(c.msg('Re: Budget').id);
    expect(row).not.toHaveProperty('answered');
    expect(row).not.toHaveProperty('forwarded');

    repo.setFlagColumn([c.msg('Re: Budget').id], 'flag_answered', true);
    row = await list();
    expect(row.answered).toBe(true);
    expect(row).not.toHaveProperty('forwarded');

    repo.setFlagColumn([c.msg('Re: Budget').id], 'flag_forwarded', true);
    row = await list();
    expect(row.answered).toBe(true);
    expect(row.forwarded).toBe(true);
  });
});
