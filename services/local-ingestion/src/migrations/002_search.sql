-- M4: retrieval index tables (chunks + FTS). chunks_vec (vec0) is created in code after loading sqlite-vec.

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  tokens INTEGER,
  UNIQUE (owner_type, owner_id, seq)
);

CREATE INDEX IF NOT EXISTS chunks_owner ON chunks (owner_type, owner_id);

-- Contentless FTS5: rowid aligns with chunks.rowid; seg_text is Intl.Segmenter pre-tokenized.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  seg_text,
  content='',
  tokenize='unicode61'
);

-- Trigram fallback for short queries / professional terms Segmenter may split.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
  text,
  content='',
  tokenize='trigram'
);
