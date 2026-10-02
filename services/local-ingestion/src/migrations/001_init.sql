-- M1 schema: core tables from 02, without chat_messages or search-derived tables.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  day TEXT NOT NULL,
  channel TEXT,
  site TEXT,
  url TEXT,
  canonical_url TEXT,
  session_id TEXT,
  item_id TEXT,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_day ON events(day, occurred_at);
CREATE INDEX IF NOT EXISTS events_item ON events(item_id);
CREATE INDEX IF NOT EXISTS events_type_day ON events(type, day);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('webpage', 'conversation', 'document')),
  title TEXT,
  url TEXT,
  canonical_url TEXT,
  site TEXT,
  captured_at TEXT NOT NULL,
  reason TEXT,
  is_strong_learning INTEGER DEFAULT 0,
  read_status TEXT NOT NULL DEFAULT 'unread',
  organize_status TEXT NOT NULL DEFAULT 'pending',
  dirty INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  edited_at TEXT,
  reading_total_seconds INTEGER DEFAULT 0,
  reading_session_count INTEGER DEFAULT 0,
  last_read_at TEXT,
  doc_pages INTEGER,
  doc_read_pages INTEGER,
  deleted_at TEXT,
  capture_session_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS items_canonical ON items(canonical_url) WHERE type = 'webpage' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS item_contents (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  markdown TEXT,
  plain_text TEXT,
  sanitized_html TEXT,
  question TEXT,
  reasoning TEXT,
  extractor TEXT,
  meta TEXT,
  original_markdown TEXT
);

CREATE TABLE IF NOT EXISTS reading_sessions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  started_at TEXT,
  seconds INTEGER NOT NULL,
  is_first INTEGER NOT NULL DEFAULT 0,
  pages TEXT
);

CREATE TABLE IF NOT EXISTS item_exposure (
  item_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  heading TEXT,
  chars INTEGER,
  exposed_seconds INTEGER,
  coverage REAL,
  top_blocks TEXT,
  updated_at TEXT,
  PRIMARY KEY (item_id, section_key)
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  kind TEXT,
  sha256 TEXT,
  mime TEXT,
  size INTEGER,
  source_url TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  item_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('fuzzy', 'item', 'entry')),
  target_id TEXT,
  text TEXT NOT NULL,
  origin TEXT NOT NULL,
  derived_from TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS kb_categories (
  id TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  sort INTEGER
);

CREATE TABLE IF NOT EXISTS kb_entries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_id TEXT,
  kind TEXT,
  aliases TEXT,
  summary TEXT,
  body_markdown TEXT,
  completeness TEXT,
  mastery REAL,
  mastery_source TEXT DEFAULT 'auto',
  user_edited INTEGER DEFAULT 0,
  stale INTEGER DEFAULT 0,
  orphan INTEGER DEFAULT 0,
  patch_count INTEGER DEFAULT 0,
  updated_at TEXT,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS kb_edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  type TEXT NOT NULL,
  PRIMARY KEY (src, dst, type)
);

CREATE TABLE IF NOT EXISTS kb_edge_sources (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  type TEXT NOT NULL,
  item_id TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS kb_entry_sources (
  entry_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  evidence TEXT,
  source_kind TEXT,
  added_at TEXT,
  PRIMARY KEY (entry_id, item_id)
);

CREATE TABLE IF NOT EXISTS kb_ignore (
  name TEXT PRIMARY KEY,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS organize_results (
  item_id TEXT PRIMARY KEY,
  summary TEXT,
  points TEXT,
  model TEXT,
  prompt_version TEXT,
  input_hash TEXT,
  run_id TEXT,
  updated_at TEXT,
  episode_id TEXT,
  decision TEXT,
  route TEXT,
  value_score REAL,
  target_entry_ids TEXT,
  output TEXT,
  reject_reason TEXT,
  reason TEXT,
  override TEXT
);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  started_at TEXT,
  ended_at TEXT,
  active_seconds INTEGER,
  status TEXT NOT NULL,
  is_learning INTEGER,
  confidence REAL,
  topic TEXT,
  learning_goal TEXT,
  judge_output TEXT,
  run_id TEXT,
  prompt_version TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS episode_items (
  episode_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (episode_id, item_id)
);

CREATE TABLE IF NOT EXISTS organize_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT,
  scope TEXT,
  requirement TEXT,
  status TEXT,
  started_at TEXT,
  finished_at TEXT,
  stats TEXT,
  tokens INTEGER,
  model TEXT
);

CREATE TABLE IF NOT EXISTS organize_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT,
  target_id TEXT,
  status TEXT,
  attempts INTEGER,
  error TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT,
  base_url TEXT,
  default_model TEXT,
  status TEXT,
  checked_at TEXT
);

CREATE TABLE IF NOT EXISTS task_models (
  task TEXT PRIMARY KEY,
  provider_id TEXT,
  model TEXT,
  fallback_provider_id TEXT,
  fallback_model TEXT
);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  task TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  calls INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  PRIMARY KEY (day, task, provider_id)
);

CREATE TABLE IF NOT EXISTS trash (
  id TEXT PRIMARY KEY,
  kind TEXT,
  target_ids TEXT,
  snapshot TEXT,
  deleted_at TEXT,
  expires_at TEXT
);
