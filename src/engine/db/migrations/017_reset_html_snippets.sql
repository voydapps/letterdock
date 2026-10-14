-- 017: some mails (for example PayPal) still showed HTML code in the list preview line, for example
-- "</style><![endif]--><div class="acr-fragment ..." (a plain-text part that was really cut-off HTML).
-- The cleaning is fixed. Here we clear the bad previews of mail whose body was never downloaded: the
-- background snippet backfill fetches them again on the next sync. Previews of downloaded mail are
-- rebuilt from the stored body by the background job SnippetRepair (it runs once more, new marker).
-- The search index copy of the preview is cleared too. Mail that does not match is not touched.
UPDATE message_fts SET snippet = ''
 WHERE rowid IN (SELECT id FROM message WHERE body_state = 'none' AND snippet <> '' AND (
        snippet LIKE '%</%' OR snippet LIKE '%<div %' OR snippet LIKE '%<div>%'
     OR snippet LIKE '%<table %' OR snippet LIKE '%<table>%' OR snippet LIKE '%<span %'
     OR snippet LIKE '%<span>%' OR snippet LIKE '%<td %' OR snippet LIKE '%<td>%'
     OR snippet LIKE '%<tr %' OR snippet LIKE '%<tr>%' OR snippet LIKE '%<img %'
     OR snippet LIKE '%<img>%' OR snippet LIKE '%<br %' OR snippet LIKE '%<br>%'
     OR snippet LIKE '%<br/%' OR snippet LIKE '%<body %' OR snippet LIKE '%<body>%'
     OR snippet LIKE '%<html%' OR snippet LIKE '%<![%' OR snippet LIKE '%<!--%'
     OR snippet LIKE '%-->%' OR snippet LIKE '%class="%' OR snippet LIKE '%<style%'));
UPDATE message SET snippet = '', snippet_checked = 0
 WHERE body_state = 'none' AND snippet <> '' AND (
        snippet LIKE '%</%' OR snippet LIKE '%<div %' OR snippet LIKE '%<div>%'
     OR snippet LIKE '%<table %' OR snippet LIKE '%<table>%' OR snippet LIKE '%<span %'
     OR snippet LIKE '%<span>%' OR snippet LIKE '%<td %' OR snippet LIKE '%<td>%'
     OR snippet LIKE '%<tr %' OR snippet LIKE '%<tr>%' OR snippet LIKE '%<img %'
     OR snippet LIKE '%<img>%' OR snippet LIKE '%<br %' OR snippet LIKE '%<br>%'
     OR snippet LIKE '%<br/%' OR snippet LIKE '%<body %' OR snippet LIKE '%<body>%'
     OR snippet LIKE '%<html%' OR snippet LIKE '%<![%' OR snippet LIKE '%<!--%'
     OR snippet LIKE '%-->%' OR snippet LIKE '%class="%' OR snippet LIKE '%<style%');
