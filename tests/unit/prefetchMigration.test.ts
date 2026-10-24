import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/engine/db/connection';
import { MIGRATIONS } from '../../src/engine/db/migrations';

describe('migration 019 (body.opened_at)', () => {
  it('upgrades a 018 database: every downloaded body counts as opened when it was downloaded', () => {
    const before = MIGRATIONS.filter((m) => m.version < 19);
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, before);
    db.exec(`INSERT INTO account (id,email,display_name,provider,auth_type,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,created_at)
             VALUES ('a','a@x.com','A','generic','password','h',993,'ssl','h',465,'ssl','a',1);
             INSERT INTO folder (id,account_id,path,name,role) VALUES (1,'a','INBOX','INBOX','inbox');
             INSERT INTO message (account_id,folder_id,uid,subject,date_ms,internal_ms) VALUES ('a',1,1,'old mail',5,5);
             INSERT INTO message (account_id,folder_id,uid,subject,date_ms,internal_ms) VALUES ('a',1,2,'other',6,6);
             INSERT INTO body (message_pk,text_plain,html,fetched_at,size_bytes) VALUES (1,'t',NULL,4242,1);`);
    expect(db.pragma('user_version', { simple: true })).toBe(18);

    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(db.prepare('SELECT fetched_at, opened_at FROM body').get()).toEqual({
      fetched_at: 4242,
      opened_at: 4242,
    });
    // New bodies may have no "opened" time (downloaded in the background, not opened yet).
    db.exec(`INSERT INTO body (message_pk,text_plain,html,fetched_at,size_bytes) VALUES (2,'t',NULL,9,1);`);
    expect(db.prepare('SELECT opened_at FROM body WHERE message_pk = 2').get()).toEqual({
      opened_at: null,
    });
  });
});
