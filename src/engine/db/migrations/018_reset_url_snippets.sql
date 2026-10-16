-- 018: some previews started with a long web address (for example Amazon: "music.amazon.com?ref_=pe_...
-- Dear Dmytro ..."). The cleaning now drops addresses at the start. Here we clear those previews for
-- mail whose body was never downloaded: the background snippet backfill fetches them again on the
-- next sync. Previews of downloaded mail are rebuilt from the stored body by SnippetRepair (new
-- marker v3). The search index copy is cleared too. Other mail is not touched.
-- "Starts with an address" = after leading separators, the first word is http://..., https://...,
-- www.... or host.tld followed by / ? or #.
UPDATE message_fts SET snippet = ''
 WHERE rowid IN (SELECT id FROM message
   WHERE body_state = 'none' AND snippet <> '' AND (
        lower(ltrim(snippet, ' <[(|:*>-')) LIKE 'http://%'
     OR lower(ltrim(snippet, ' <[(|:*>-')) LIKE 'https://%'
     OR lower(ltrim(snippet, ' <[(|:*>-')) LIKE 'www.%'
     OR substr(lower(ltrim(snippet, ' <[(|:*>-')), 1,
          instr(lower(ltrim(snippet, ' <[(|:*>-')) || ' ', ' ') - 1) GLOB '*[a-z0-9].[a-z][a-z]*[/?#]*'));
UPDATE message SET snippet = '', snippet_checked = 0
 WHERE body_state = 'none' AND snippet <> '' AND (
        lower(ltrim(snippet, ' <[(|:*>-')) LIKE 'http://%'
     OR lower(ltrim(snippet, ' <[(|:*>-')) LIKE 'https://%'
     OR lower(ltrim(snippet, ' <[(|:*>-')) LIKE 'www.%'
     OR substr(lower(ltrim(snippet, ' <[(|:*>-')), 1,
          instr(lower(ltrim(snippet, ' <[(|:*>-')) || ' ', ' ') - 1) GLOB '*[a-z0-9].[a-z][a-z]*[/?#]*');
