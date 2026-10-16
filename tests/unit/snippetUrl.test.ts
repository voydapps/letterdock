// Real report (0.6.16): an Amazon Music mail showed a tracking address as the preview start:
// "music.amazon.com?ref_=pe_198314180_1375663910_Control Dear Dmytro Voytyuk, We noticed ..."
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/engine/db/connection';
import { MIGRATIONS } from '../../src/engine/db/migrations';
import { cleanSnippetText, makeSnippet } from '../../src/engine/messages/bodyUtils';
import { SnippetRepair } from '../../src/engine/messages/snippetRepair';
import { header, makeCtx } from '../helpers';

const TEXT = 'Dear Dmytro, we noticed that you are not using your Prime membership.';
const TRACK = 'music.amazon.com?ref_=pe_198314180_1375663910_Control';

describe('web addresses in the preview', () => {
  it('the Amazon shape: a bare-host tracking line first', () => {
    expect(makeSnippet(`${TRACK}\n\n${TEXT}`, null)).toBe(TEXT);
    expect(makeSnippet(`${TRACK} ${TEXT}`, null)).toBe(TEXT);
  });
  it('https:// first line, <https://...> and www. first', () => {
    expect(makeSnippet(`https://example.com/a/b?x=1&y=2\n${TEXT}`, null)).toBe(TEXT);
    expect(makeSnippet(`<https://example.com/a?x=1>\n${TEXT}`, null)).toBe(TEXT);
    expect(makeSnippet(`www.example.com/offers ${TEXT}`, null)).toBe(TEXT);
  });
  it('"View this email in your browser: https://..." and several lines in a row', () => {
    expect(
      makeSnippet(`View this email in your browser: https://x.com/v?id=9\n${TEXT}`, null),
    ).toBe(TEXT);
    expect(makeSnippet(`View in browser: ${TRACK}\n${TRACK}\n- ${TEXT}`, null)).toBe(TEXT);
    expect(makeSnippet(`| https://a.com/x | ${TEXT}`, null)).toBe(TEXT);
  });
  it('a long tracking address in the middle is removed', () => {
    expect(
      makeSnippet('Hello Anna, see shop.example.com/track?u=123&v=456 for details', null),
    ).toBe('Hello Anna, see for details');
    expect(
      makeSnippet('Hello, open example.com/very/long/path/without/query/string/here today', null),
    ).toBe('Hello, open today');
  });
  it('a long address inside brackets leaves no dangling bracket (real shape)', () => {
    expect(
      makeSnippet(
        'La richiesta n.1459321 (servicedesk.namirial.com/hc/requests/1459321) è aperta',
        null,
      ),
    ).toBe('La richiesta n.1459321 è aperta');
  });
  it('short human mentions stay', () => {
    expect(makeSnippet('Order on amazon.com or visit example.org today', null)).toBe(
      'Order on amazon.com or visit example.org today',
    );
    expect(makeSnippet('Go to example.com/sale now', null)).toBe('Go to example.com/sale now');
  });
  it('email addresses stay', () => {
    expect(makeSnippet('Write to anna@example.com or bob.smith@mail.example.com now', null)).toBe(
      'Write to anna@example.com or bob.smith@mail.example.com now',
    );
    expect(makeSnippet('anna@example.com wrote: hello', null)).toBe(
      'anna@example.com wrote: hello',
    );
  });
  it('markdown links keep their text', () => {
    expect(makeSnippet('Please [read the terms](https://x.com/t?a=1) first', null)).toBe(
      'Please read the terms first',
    );
    expect(cleanSnippetText('[https://x.com/a](https://x.com/a) Hello')).toBe('Hello');
  });
  it('a plain part with only a URL falls back to the HTML text, or to nothing', () => {
    expect(makeSnippet(TRACK, null)).toBe('');
    expect(makeSnippet('https://example.com/a?b=c', `<p>${TEXT}</p>`)).toBe(TEXT);
    expect(makeSnippet('<https://example.com>', null)).toBe('');
  });
  it('normal text is not changed', () => {
    expect(makeSnippet('Version 2.0/3.1 is out, e.g. today. Ok?', null)).toBe(
      'Version 2.0/3.1 is out, e.g. today. Ok?',
    );
    expect(makeSnippet('- not a list, just text', null)).toBe('not a list, just text');
  });
});

describe('migration 018 and repair v3', () => {
  const seed = (db: Database.Database) =>
    db.exec(`INSERT INTO account (id,email,display_name,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,created_at)
             VALUES ('acc-1','a@x.com','A','generic','password','h',993,'ssl','h',465,'ssl','a',1);
             INSERT INTO folder (id,account_id,path,name,role) VALUES (1,'acc-1','INBOX','INBOX','inbox');`);

  it('clears previews that start with an address (no body only)', () => {
    const db = new Database(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 18),
    );
    seed(db);
    const ins = db.prepare(
      "INSERT INTO message (account_id,folder_id,uid,subject,date_ms,internal_ms,snippet,snippet_checked,body_state) VALUES ('acc-1',1,?,?,5,5,?,1,?)",
    );
    const rows: [string, string, string][] = [
      ['amazon', `${TRACK} Dear Dmytro`, 'none'],
      ['https', 'https://x.com/a Hello', 'none'],
      ['angle', '<https://claude.ai> Hi, As of April', 'none'],
      ['www', 'WWW.Example.com Hello', 'none'],
      ['cached', `${TRACK} Dear Dmytro`, 'cached'],
      ['good', 'Dear Dmytro, see amazon.com', 'none'],
      ['mention', 'amazon.com is closing today', 'none'],
      ['mid', 'Hello example.com/x?y=1 there', 'none'],
      ['email', 'anna@example.com wrote', 'none'],
    ];
    rows.forEach((r, i) => ins.run(i + 1, r[0], r[1], r[2]));
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(18);
    const got = db
      .prepare(
        "SELECT subject, snippet <> '' AS kept, snippet_checked AS c FROM message ORDER BY uid",
      )
      .all();
    expect(got).toEqual([
      { subject: 'amazon', kept: 0, c: 0 },
      { subject: 'https', kept: 0, c: 0 },
      { subject: 'angle', kept: 0, c: 0 },
      { subject: 'www', kept: 0, c: 0 },
      { subject: 'cached', kept: 1, c: 1 },
      { subject: 'good', kept: 1, c: 1 },
      { subject: 'mention', kept: 1, c: 1 },
      { subject: 'mid', kept: 1, c: 1 },
      { subject: 'email', kept: 1, c: 1 },
    ]);
  });

  it('repair v3 rebuilds cached mail whose preview starts with an address, once', async () => {
    const { ctx, db } = makeCtx();
    seed(db);
    const { added } = ctx.messages.upsertHeaders([
      header({ folderId: 1, uid: 1 }),
      header({ folderId: 1, uid: 2 }),
    ]);
    const store = (id: number, text: string, snippet: string) =>
      ctx.messages.saveBody(
        id,
        { rawZ: null, text, html: null, snippet, attachments: [], ftsBodyText: '' },
        1,
      );
    store(added[0], `${TRACK}\n\n${TEXT}`, `${TRACK} ${TEXT}`);
    store(added[1], 'Hello there', 'Hello there');
    db.prepare("INSERT INTO kv (k,v) VALUES ('snippet_repair_done_v2','1')").run(); // 0.6.16 marker
    const repair = new SnippetRepair(ctx);
    repair.start();
    await repair.whenDone();
    const snip = (id: number) =>
      (db.prepare('SELECT snippet FROM message WHERE id=?').get(id) as { snippet: string }).snippet;
    expect(snip(added[0])).toBe(TEXT);
    expect(snip(added[1])).toBe('Hello there');
    expect(db.prepare("SELECT v FROM kv WHERE k='snippet_repair_done_v3'").get()).toEqual({
      v: '1',
    });
  });
});
