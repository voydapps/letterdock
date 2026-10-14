// List snippets must never show code: Mailjet / MJML editor JSON, MSO comments, CSS, truncated blobs.
// Real report: sender "Giunti Editore", snippet {"tagName":"mj-global-style","attributes":{"h1:color":...
import { describe, expect, it } from 'vitest';
import type { ImapFlow } from 'imapflow';
import Database from 'better-sqlite3';
import { migrate } from '../../src/engine/db/connection';
import { MIGRATIONS } from '../../src/engine/db/migrations';
import { fillSnippets, snippetOf } from '../../src/engine/imap/snippets';
import type { FetchedLike, SnippetPart } from '../../src/engine/imap/parse';
import { pickSnippetPart } from '../../src/engine/imap/parse';
import {
  looksBrokenSnippet,
  makeSnippet,
  stripHtml,
  stripJsonBlobs,
} from '../../src/engine/messages/bodyUtils';
import { SnippetRepair } from '../../src/engine/messages/snippetRepair';
import { header, makeCtx } from '../helpers';

const MJ_JSON =
  '{"tagName":"mj-global-style","attributes":{"h1:color":"#000000","h1:font-family":"Helvetica, sans-serif"},' +
  '"children":[{"tagName":"mj-text","attributes":{"font-size":"14px"},"content":"x {y} \\"z\\""}]}';
const REAL = 'Quali storie ti faranno venire i brividi? Scopri le novità di Halloween 🕯';

const plain = (): SnippetPart => ({
  part: '1',
  type: 'text/plain',
  encoding: '7bit',
  charset: 'utf-8',
});

describe('stripJsonBlobs', () => {
  it('removes a balanced object, strings with braces and escaped quotes included', () => {
    expect(stripJsonBlobs(`Hello ${MJ_JSON} world`).replace(/\s+/g, ' ')).toBe('Hello world');
  });
  it('drops a blob that was cut off, to the end', () => {
    expect(stripJsonBlobs('Hi {"tagName":"mj-global-style","attributes":{"h1:col').trim()).toBe(
      'Hi',
    );
  });
  it('removes arrays of objects and leaves normal braces and quotes alone', () => {
    expect(stripJsonBlobs('A [{"a":1},{"b":2}] B').replace(/\s+/g, ' ')).toBe('A B');
    expect(stripJsonBlobs('He said "hi" {not json} and [1, 2]')).toBe(
      'He said "hi" {not json} and [1, 2]',
    );
  });
});

describe('snippet from HTML with code in it', () => {
  it('Mailjet / MJML: JSON in a hidden body element and in <head> is ignored', () => {
    const doc =
      `<html><head><title>t</title><script type="application/json">${MJ_JSON}</script><style>.a{color:red}</style></head>` +
      `<body><div style="display:none">${MJ_JSON}</div><table><tr><td>${REAL}</td></tr></table></body></html>`;
    expect(makeSnippet(null, doc)).toBe(REAL);
  });
  it('JSON in the head, entity-encoded, and the head is cut off: nothing, not code', () => {
    const doc = `<html><head><meta charset="utf-8"><script type="application/json">${MJ_JSON.replace(/"/g, '&quot;')}`;
    expect(makeSnippet(null, doc)).toBe('');
    expect(makeSnippet(null, doc.slice(0, 120))).toBe('');
  });
  it('unclosed <template> / <noscript> and <mj-*> metadata blocks', () => {
    expect(makeSnippet(null, `<body><template>${MJ_JSON}`)).toBe('');
    expect(makeSnippet(null, '<noscript>{"a":1}')).toBe('');
    expect(
      stripHtml(
        '<mjml><mj-head><mj-attributes><mj-all font-family="Arial"/></mj-attributes><mj-style>.x{a:b}</mj-style></mj-head><mj-body><mj-text>Visible words</mj-text></mj-body></mjml>',
      ),
    ).toBe('Visible words');
  });
  it('MSO conditional comments and CSS in <style>', () => {
    const doc =
      '<html><head><!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->' +
      '<style>@media (max-width:600px){.c{width:100%!important}} h1{font-family:Arial}</style></head>' +
      '<body><!--[if mso]><table><tr><td><![endif]--><p>Ciao Maria,</p><!--[if mso]></td></tr></table><![endif]--><p>il tuo ordine &egrave; partito</p></body></html>';
    expect(makeSnippet(null, doc)).toBe('Ciao Maria, il tuo ordine è partito');
  });
  it('keeps a display:none preheader (Gmail and Outlook show it) without its padding characters', () => {
    const pad = '&zwnj;&nbsp;'.repeat(40) + '͏‌ '.repeat(20);
    const doc = `<body><div style="display:none;max-height:0">Preheader: sconto del 20% &amp; spedizione gratis${pad}</div><h1>Titolo</h1></body>`;
    expect(makeSnippet(null, doc)).toBe('Preheader: sconto del 20% & spedizione gratis Titolo');
  });
  it('decodes entities and keeps emoji', () => {
    expect(makeSnippet(null, '<p>Caff&#232; &amp; t&#xE8; &#x1F600; &lt;3</p>')).toBe(
      'Caffè & tè 😀 <3',
    );
  });
  it('truncated partial HTML (cut in a tag, a comment, a style)', () => {
    expect(
      makeSnippet(null, '<body><p>Visible text here</p><a href="https://example.com/very/lo'),
    ).toBe('Visible text here');
    expect(makeSnippet(null, '<body><p>Visible text here</p><!-- tracking {"a":1')).toBe(
      'Visible text here',
    );
    expect(makeSnippet(null, '<body><p>Visible text here</p><style>.a{color:')).toBe(
      'Visible text here',
    );
  });
});

describe('snippet from the plain-text part', () => {
  it('real text is used as it is', () => {
    expect(makeSnippet(`${REAL}\r\n\r\nSee you soon.`, '<p>other</p>')).toBe(
      `${REAL} See you soon.`,
    );
  });
  it('a plain part that is only JSON falls through to the HTML text', () => {
    expect(makeSnippet(MJ_JSON, `<body><p>${REAL}</p></body>`)).toBe(REAL);
  });
  it('a plain part that is only JSON and no HTML gives nothing', () => {
    expect(makeSnippet(MJ_JSON, null)).toBe('');
    expect(makeSnippet(MJ_JSON.slice(0, 90), null)).toBe('');
  });
  it('a "plain" part that is really HTML source is read as HTML', () => {
    expect(
      makeSnippet(
        '<html><head><style>.a{b:c}</style></head><body><p>Hello there</p></body></html>',
        null,
      ),
    ).toBe('Hello there');
  });
  it('snippetOf on a plain part with JSON first and real text after', async () => {
    expect(await snippetOf(plain(), Buffer.from(`${MJ_JSON}\r\n\r\n${REAL}`))).toBe(REAL);
  });
});

describe('fillSnippets: plain part is code, the HTML part is used', () => {
  it('fetches the HTML part for those messages only', async () => {
    const { ctx, db } = makeCtx();
    db.exec(`INSERT INTO account (id,email,display_name,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,created_at)
             VALUES ('acc-1','a@x.com','A','generic','password','h',993,'ssl','h',465,'ssl','a',1);
             INSERT INTO folder (id,account_id,path,name,role) VALUES (1,'acc-1','INBOX','INBOX','inbox');`);
    const { added } = ctx.messages.upsertHeaders([
      header({ folderId: 1, uid: 1 }),
      header({ folderId: 1, uid: 2 }),
    ]);
    const struct = {
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain', part: '1', encoding: '7bit', parameters: { charset: 'utf-8' } },
        { type: 'text/html', part: '2', encoding: '7bit', parameters: { charset: 'utf-8' } },
      ],
    };
    expect(pickSnippetPart(struct as never)?.fallback?.part).toBe('2');
    const fetched = [1, 2].map((uid) => ({
      uid,
      bodyStructure: struct,
    })) as unknown as FetchedLike[];
    const bodies: Record<string, Record<number, string>> = {
      '1': { 1: MJ_JSON, 2: 'Plain real text for two' },
      '2': { 1: `<body><p>${REAL}</p></body>`, 2: '<body><p>unused</p></body>' },
    };
    const asked: string[] = [];
    const client = {
      fetchAll: async (set: string, q: { bodyParts: { key: string }[] }) => {
        const key = q.bodyParts[0].key;
        const uids = set.split(',').flatMap((x) => {
          const [a, b] = x.split(':').map(Number);
          return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
        });
        asked.push(`${key}:${uids.join('+')}`);
        return uids.map((uid) => ({
          uid,
          bodyParts: new Map([[key, Buffer.from(bodies[key][uid])]]),
        }));
      },
    } as unknown as ImapFlow;
    const idByUid = new Map([
      [1, added[0]],
      [2, added[1]],
    ]);
    await fillSnippets(ctx, client, fetched, idByUid);
    const snip = (id: number) =>
      (db.prepare('SELECT snippet FROM message WHERE id=?').get(id) as { snippet: string }).snippet;
    expect(snip(added[0])).toBe(REAL);
    expect(snip(added[1])).toBe('Plain real text for two');
    expect(asked).toEqual(['1:1+2', '2:1']);
  });
});

describe('SnippetRepair and migration 016', () => {
  const seed = (db: Database.Database) =>
    db.exec(`INSERT INTO account (id,email,display_name,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,created_at)
             VALUES ('acc-1','a@x.com','A','generic','password','h',993,'ssl','h',465,'ssl','a',1);
             INSERT INTO folder (id,account_id,path,name,role) VALUES (1,'acc-1','INBOX','INBOX','inbox');`);

  it('migration 016 clears code snippets of mail without a body, keeps good ones', () => {
    const db = new Database(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 16),
    );
    seed(db);
    const ins = db.prepare(
      "INSERT INTO message (account_id,folder_id,uid,subject,date_ms,internal_ms,snippet,snippet_checked,body_state) VALUES ('acc-1',1,?,?,5,5,?,1,?)",
    );
    ins.run(1, 'bad', MJ_JSON.slice(0, 200), 'none');
    ins.run(2, 'bad css', '@media only screen { .a {} } hello', 'none');
    ins.run(3, 'good', 'Ciao, il tuo ordine è partito', 'none');
    ins.run(4, 'bad cached', MJ_JSON.slice(0, 200), 'cached');
    expect(migrate(db)).toBe(MIGRATIONS.length);
    const rows = db
      .prepare('SELECT uid, snippet, snippet_checked AS c FROM message ORDER BY uid')
      .all();
    expect(rows).toEqual([
      { uid: 1, snippet: '', c: 0 },
      { uid: 2, snippet: '', c: 0 },
      { uid: 3, snippet: 'Ciao, il tuo ordine è partito', c: 1 },
      { uid: 4, snippet: MJ_JSON.slice(0, 200), c: 1 }, // has a body: the job rebuilds it
    ]);
  });

  it('rebuilds code snippets of downloaded mail from the stored body, in batches, once', async () => {
    const { ctx, db } = makeCtx();
    seed(db);
    const n = 230; // more than two batches
    const { added } = ctx.messages.upsertHeaders(
      Array.from({ length: n }, (_, i) => header({ folderId: 1, uid: i + 1 })),
    );
    const store = (id: number, text: string | null, html: string | null, snippet: string) =>
      ctx.messages.saveBody(
        id,
        { rawZ: null, text, html, snippet, attachments: [], ftsBodyText: '' },
        1,
      );
    added.forEach((id, i) => {
      if (i % 2 === 0)
        store(id, MJ_JSON, `<body><p>${REAL} ${i}</p></body>`, MJ_JSON.slice(0, 200));
      else store(id, `Fine text ${i}`, null, `Fine text ${i}`);
    });
    const repair = new SnippetRepair(ctx);
    repair.start();
    await repair.whenDone();
    const snips = db.prepare('SELECT id, snippet FROM message ORDER BY id').all() as {
      id: number;
      snippet: string;
    }[];
    snips.forEach((r, i) => {
      expect(looksBrokenSnippet(r.snippet)).toBe(false);
      expect(r.snippet).toBe(i % 2 === 0 ? `${REAL} ${i}` : `Fine text ${i}`);
    });
    expect(db.prepare("SELECT v FROM kv WHERE k='snippet_repair_done_v2'").get()).toEqual({ v: '1' });
    // A second start does nothing (done marker).
    db.prepare('UPDATE message SET snippet=? WHERE id=?').run('{"x":1}', added[0]);
    const again = new SnippetRepair(ctx);
    again.start();
    await again.whenDone();
    expect(
      (db.prepare('SELECT snippet FROM message WHERE id=?').get(added[0]) as { snippet: string })
        .snippet,
    ).toBe('{"x":1}');
  });

  it('resumes from the saved position and updates the search index copy', async () => {
    const { ctx, db } = makeCtx();
    seed(db);
    const { added } = ctx.messages.upsertHeaders([
      header({ folderId: 1, uid: 1 }),
      header({ folderId: 1, uid: 2 }),
    ]);
    for (const id of added) {
      ctx.messages.saveBody(
        id,
        {
          rawZ: null,
          text: 'Real words here',
          html: null,
          snippet: '{"a":"b"}',
          attachments: [],
          ftsBodyText: '',
        },
        1,
      );
    }
    db.prepare("INSERT INTO kv (k,v) VALUES ('snippet_repair_id_v2', ?)").run(String(added[0]));
    const repair = new SnippetRepair(ctx);
    repair.start();
    await repair.whenDone();
    const get = (id: number) =>
      (db.prepare('SELECT snippet FROM message WHERE id=?').get(id) as { snippet: string }).snippet;
    expect(get(added[0])).toBe('{"a":"b"}'); // before the saved position
    expect(get(added[1])).toBe('Real words here');
    expect(
      (
        db.prepare('SELECT snippet FROM message_fts WHERE rowid=?').get(added[1]) as {
          snippet: string;
        }
      ).snippet,
    ).toBe('Real words here');
  });
});
