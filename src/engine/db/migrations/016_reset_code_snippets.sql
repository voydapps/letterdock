-- 016: some newsletters (Mailjet / MJML) showed template code in the list preview line, for example
-- {"tagName":"mj-global-style", ...}. The cleaning is fixed. Here we clear the bad previews of mail
-- whose body was never downloaded: the background snippet backfill then fetches them again on the
-- next sync. Previews of downloaded mail are rebuilt from the stored body by the background job
-- SnippetRepair (src/engine/messages/snippetRepair.ts), because that needs code, not SQL.
-- The search index copy of the preview is cleared too. Mail that does not match is not touched.
UPDATE message_fts SET snippet = ''
 WHERE rowid IN (SELECT id FROM message WHERE body_state = 'none' AND snippet <> '' AND (
        snippet LIKE '{%' OR snippet LIKE '[{%' OR snippet LIKE '%{"%'
     OR snippet LIKE '%tagName%' OR snippet LIKE '%mj-%' OR snippet LIKE '%@media%'
     OR snippet LIKE '%font-family:%' OR snippet LIKE '%<!--%' OR snippet LIKE '%<style%'
     OR snippet LIKE '%<mj%'));
UPDATE message SET snippet = '', snippet_checked = 0
 WHERE body_state = 'none' AND snippet <> '' AND (
        snippet LIKE '{%' OR snippet LIKE '[{%' OR snippet LIKE '%{"%'
     OR snippet LIKE '%tagName%' OR snippet LIKE '%mj-%' OR snippet LIKE '%@media%'
     OR snippet LIKE '%font-family:%' OR snippet LIKE '%<!--%' OR snippet LIKE '%<style%'
     OR snippet LIKE '%<mj%');
