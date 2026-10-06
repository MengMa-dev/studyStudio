-- Per-stage input / output of each organize run, shown in the run detail pipeline view.
CREATE TABLE IF NOT EXISTS organize_traces (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  stage TEXT NOT NULL,
  step TEXT NOT NULL,
  item_ids TEXT,
  episode_id TEXT,
  entry_id TEXT,
  input TEXT,
  output TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT,
  PRIMARY KEY (run_id, seq)
);
