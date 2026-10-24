-- 019: when a message body was last OPENED by the user (epoch ms). The cache cleanup removes the
-- least recently opened bodies first. Before, it used fetched_at, which every open overwrote. The
-- background download (prefetch) stores bodies the user has not opened: those keep opened_at NULL
-- and count by their message date instead (ORDER BY COALESCE(opened_at, message.date_ms)), so
-- unread mail from today is not removed before mail read last week.
-- Existing bodies were downloaded because the user opened them: opened_at = fetched_at.
ALTER TABLE body ADD COLUMN opened_at INTEGER;
UPDATE body SET opened_at = fetched_at;
