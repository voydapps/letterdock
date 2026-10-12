-- 015: "Forwarded" mark (DESIGN-SPEC 3.16). A local flag, set when this app forwards a message and
-- when the server reports the $Forwarded keyword. Sync never clears it (Gmail drops the keyword).
-- One default-0 column: SQLite adds it without rewriting the table.
ALTER TABLE message ADD COLUMN flag_forwarded INTEGER NOT NULL DEFAULT 0;
