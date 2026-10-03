-- C1: single-session chat history (09). parts = AI SDK UIMessage.parts JSON so a reload replays cards and citations.

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  context TEXT,
  model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
