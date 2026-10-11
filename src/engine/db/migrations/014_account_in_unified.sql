-- 014: "Include in All inboxes" per account (DESIGN-SPEC 2, sidebar rules). 1 = the account's Inbox
-- mail shows in All inboxes / Unread / Flagged, the unread badge and new-mail notifications (the
-- default, so every existing account stays as it was). 0 = hidden from those; its own folders are
-- unchanged. One default-1 column: SQLite adds it without rewriting the table.
ALTER TABLE account ADD COLUMN in_unified INTEGER NOT NULL DEFAULT 1;
