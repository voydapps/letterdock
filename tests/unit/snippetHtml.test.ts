// Real report (0.6.15): a PayPal mail showed raw HTML in the preview line:
// </style><![endif]--><div class="acr-fragment is-locked" data-fragment-id="ajo:..."><table ...
import { describe, expect, it } from 'vitest';
import type { ImapFlow } from 'imapflow';
import Database from 'better-sqlite3';
import { migrate } from '../../src/engine/db/connection';
import { MIGRATIONS } from '../../src/engine/db/migrations';
import { fillSnippets, snippetOf } from '../../src/engine/imap/snippets';
import type { FetchedLike } from '../../src/engine/imap/parse';
import {
  looksBrokenSnippet,
  looksLikeMarkup,
  makeSnippet,
  stripHtml,
} from '../../src/engine/messages/bodyUtils';
import { SnippetRepair } from '../../src/engine/messages/snippetRepair';
import { header, makeCtx } from '../helpers';

const REAL = 'Paga un avviso in tempo: apri PayPal e conferma il pagamento entro domani';

const HEAD =
  '<!--[if mso]><style type="text/css"><!-- table,td{border-collapse:collapse} --> .x{a:b}</style><![endif]-->' +
  '<style>@media (max-width:600px){.c{width:100%!important}}</style>';
const FRAGMENT =
  '<div class="acr-fragment is-locked" data-fragment-id="ajo:ea780981-6ffe-4b9f-a188-b6ec51bc533a">' +
  '<table align="center" cellpadding="0" cellspacing="0" border="0" role="presentation" width="600">';
const FILLER =
  '<tr><td style="padding:0"><img src="https://x/y.png" width="1" height="1"></td></tr>'.repeat(
    120,
  );
const DOC = `<div>${HEAD}${FRAGMENT}${FILLER}<tr><td><p>${REAL}</p></td></tr></table></div>`;

const htmlPart = () => ({ part: '1', type: 'text/html', encoding: '7bit', charset: 'utf-8' });

describe('HTML in a plain-text slot or cut off in the middle', () => {
  it('root cause: the pre-damage input (conditional style block first) in a plain slot', () => {
    // Old code: stripCss ate "<!--[if mso]><style ...>table,td{...}" and left "</style><![endif]-->...".
    const t =
      '<!--[if mso]><style type="text/css">table,td{border-collapse:collapse}</style><![endif]--><div class="acr-fragment is-locked" data-fragment-id="a"><table align="center"';
    expect(makeSnippet(t, null)).toBe('');
    expect(makeSnippet(`${t}><tr><td>${REAL}</td></tr>`, null)).toBe(REAL);
  });
  it('real shapes seen in a mailbox: markup in the middle of plain text', () => {
    expect(
      makeSnippet(
        'Keep track of your Google Account <!--[if !mso]><!--> <!--[if false]><!--> You are receiving',
        null,
      ),
    ).toBe('Keep track of your Google Account You are receiving');
    expect(makeSnippet('Dear Client, <br><b>Notice</b> <br /> tomorrow', null)).toBe(
      'Dear Client, Notice tomorrow',
    );
    expect(makeSnippet('Hi <travis@x.com> and <tdavis@x.com>, <brian@x.com>', null)).toBe(
      'Hi <travis@x.com> and <tdavis@x.com>, <brian@x.com>',
    );
  });
  it('the exact reported text: orphan </style>, <![endif]-->, ACR fragment', () => {
    const t =
      '</style><![endif]--><div class="acr-fragment is-locked" data-fragment-id="ajo:ea78"><table align="center" cellpadding="0" cellspacing="0" border="0" role="presentation"';
    expect(makeSnippet(t, null)).toBe('');
    expect(makeSnippet(`${t}><tr><td>${REAL}</td></tr>`, null)).toBe(REAL);
  });
  it('orphan closers drop the CSS before them', () => {
    expect(stripHtml('.a{color:red} td{x:y} </style><![endif]--><p>Hello</p>')).toBe('Hello');
    expect(stripHtml('var a=1; </script><p>Hello</p>')).toBe('Hello');
    expect(stripHtml('x --> <p>Hello</p>')).toBe('x Hello');
  });
  it('a conditional style block whose inner comment closes early', () => {
    expect(makeSnippet(null, DOC)).toBe(REAL);
  });
  it('plain part that is an HTML fragment (no document start) is read as HTML', () => {
    expect(makeSnippet(DOC, null)).toBe(REAL);
    expect(makeSnippet('<table><tr><td>Hi there</td></tr></table>', null)).toBe('Hi there');
  });
  it('escaped markup in HTML text (decoded to tags) is stripped again', () => {
    expect(makeSnippet(null, '<p>&lt;div class=&quot;a&quot;&gt;Hi&lt;/div&gt;</p>')).toBe('Hi');
  });
  it('normal text with angle brackets stays', () => {
    expect(makeSnippet('Mail me <bob@x.com> or see <https://x.com/a> 3 < 5', null)).toBe(
      'Mail me <bob@x.com> or see 3 < 5',
    );
    expect(looksLikeMarkup('Hello <bob@x.com>')).toBe(false);
  });
  it('detector flags the surviving shapes', () => {
    for (const s of ['</style>', '<div class="a">', '<![endif]-->', 'a --> b', '<table align'])
      expect(looksBrokenSnippet(s)).toBe(true);
    expect(looksBrokenSnippet('Ciao, il tuo ordine è partito')).toBe(false);
  });
  it('HTML peek windows cut at 3 KB / 16 KB / mid-tag never leave tags', async () => {
    for (const cut of [200, 3072, 16384, 3079]) {
      const s = await snippetOf(htmlPart(), Buffer.from(DOC.slice(0, cut)), true);
      expect(looksBrokenSnippet(s)).toBe(false);
      expect(s).not.toMatch(/[<>]/);
    }
    expect(await snippetOf(htmlPart(), Buffer.from(DOC))).toBe(REAL);
    // A peek that starts inside the conditional block (orphan end).
    const tail = DOC.slice(DOC.indexOf('</style><![endif]-->'));
    expect(await snippetOf(htmlPart(), Buffer.from(tail))).toBe(REAL);
  });
  it('text/plain slot with the fragment, through snippetOf', async () => {
    const p = { part: '1', type: 'text/plain', encoding: '7bit', charset: 'utf-8' };
    expect(await snippetOf(p, Buffer.from(DOC))).toBe(REAL);
    expect(looksBrokenSnippet(await snippetOf(p, Buffer.from(DOC.slice(0, 3072)), true))).toBe(
      false,
    );
  });
});

describe('new-mail path (fillSnippets) with the PayPal shape', () => {
  const run = async (type: 'text/plain' | 'text/html', body: string) => {
    const { ctx, db } = makeCtx();
    db.exec(`INSERT INTO account (id,email,display_name,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,created_at)
             VALUES ('acc-1','a@x.com','A','generic','password','h',993,'ssl','h',465,'ssl','a',1);
             INSERT INTO folder (id,account_id,path,name,role) VALUES (1,'acc-1','INBOX','INBOX','inbox');`);
    const { added } = ctx.messages.upsertHeaders([header({ folderId: 1, uid: 1 })]);
    const fetched = [
      {
        uid: 1,
        bodyStructure: { type, part: '1', encoding: '7bit', parameters: { charset: 'utf-8' } },
      },
    ] as unknown as FetchedLike[];
    const client = {
      fetchAll: async (_s: string, q: { bodyParts: { key: string; maxLength: number }[] }) => [
        {
          uid: 1,
          bodyParts: new Map([
            [q.bodyParts[0].key, Buffer.from(body).subarray(0, q.bodyParts[0].maxLength)],
          ]),
        },
      ],
    } as unknown as ImapFlow;
    await fillSnippets(ctx, client, fetched, new Map([[1, added[0]]]));
    return (
      db.prepare('SELECT snippet FROM message WHERE id=?').get(added[0]) as { snippet: string }
    ).snippet;
  };
  it('text/html only (second, bigger peek finds the text)', async () => {
    expect(looksBrokenSnippet(await run('text/html', DOC))).toBe(false);
  });
  it('text/plain that holds cut-off HTML gives no tags', async () => {
    const s = await run('text/plain', `</style><![endif]-->${FRAGMENT}${FILLER}`);
    expect(s).not.toMatch(/[<>]/);
  });
});

describe('migration 017 and the repair rerun', () => {
  const seed = (db: Database.Database) =>
    db.exec(`INSERT INTO account (id,email,display_name,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,created_at)
             VALUES ('acc-1','a@x.com','A','generic','password','h',993,'ssl','h',465,'ssl','a',1);
             INSERT INTO folder (id,account_id,path,name,role) VALUES (1,'acc-1','INBOX','INBOX','inbox');`);
  const BAD =
    '</style><![endif]--><div class="acr-fragment is-locked" data-fragment-id="ajo:ea78"><table align="center"';

  it('clears HTML snippets of mail without a body, keeps the rest', () => {
    const db = new Database(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version < 17),
    );
    seed(db);
    const ins = db.prepare(
      "INSERT INTO message (account_id,folder_id,uid,subject,date_ms,internal_ms,snippet,snippet_checked,body_state) VALUES ('acc-1',1,?,?,5,5,?,1,?)",
    );
    ins.run(1, 'bad', BAD, 'none');
    ins.run(2, 'good', 'Ciao, il tuo ordine è partito', 'none');
    ins.run(3, 'bad cached', BAD, 'cached');
    ins.run(4, 'addr', 'Hi <travis@x.com> <tdavis@x.com> <brian@x.com> <diva@x.com>', 'none');
    ins.run(5, 'br', 'Dear Client, <br /> hello', 'none');
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(17);
    expect(
      db.prepare('SELECT uid, snippet, snippet_checked AS c FROM message ORDER BY uid').all(),
    ).toEqual([
      { uid: 1, snippet: '', c: 0 },
      { uid: 2, snippet: 'Ciao, il tuo ordine è partito', c: 1 },
      { uid: 3, snippet: BAD, c: 1 },
      { uid: 4, snippet: 'Hi <travis@x.com> <tdavis@x.com> <brian@x.com> <diva@x.com>', c: 1 },
      { uid: 5, snippet: '', c: 0 },
    ]);
  });

  it('repair runs again after the old marker was set, and rebuilds from the stored body', async () => {
    const { ctx, db } = makeCtx();
    seed(db);
    const { added } = ctx.messages.upsertHeaders([header({ folderId: 1, uid: 1 })]);
    ctx.messages.saveBody(
      added[0],
      { rawZ: null, text: DOC, html: null, snippet: BAD, attachments: [], ftsBodyText: '' },
      1,
    );
    db.prepare("INSERT INTO kv (k,v) VALUES ('snippet_repair_done','1')").run(); // 0.6.12 marker
    const repair = new SnippetRepair(ctx);
    repair.start();
    await repair.whenDone();
    expect(
      (db.prepare('SELECT snippet FROM message WHERE id=?').get(added[0]) as { snippet: string })
        .snippet,
    ).toBe(REAL);
  });
});
