-- M5/M6: entry dirty flag after manual edits; run scope for retry and progress recovery.

ALTER TABLE kb_entries ADD COLUMN dirty INTEGER DEFAULT 0;
ALTER TABLE organize_runs ADD COLUMN scope_ids TEXT;
ALTER TABLE organize_runs ADD COLUMN progress TEXT;
