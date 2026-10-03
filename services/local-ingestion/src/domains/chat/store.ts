import type { DatabaseSync } from "node:sqlite";
import type { UIMessage } from "ai";
import type { ChatContext } from "@study-studio/shared";

type ChatMessageRow = {
  id: string;
  role: string;
  parts: string;
};

export type AppendChatMessage = {
  message: UIMessage;
  context?: ChatContext | null;
  model?: string | null;
  createdAt?: string;
};

/** Most recent `limit` messages of the session, oldest first. */
export function listMessages(db: DatabaseSync, sessionId: string, limit = 200): UIMessage[] {
  const rows = db
    .prepare("SELECT id, role, parts FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(sessionId, limit) as ChatMessageRow[];
  return rows.reverse().map((row) => ({ id: row.id, role: row.role as UIMessage["role"], parts: parseParts(row.parts) }));
}

/** Re-sending a message id (e.g. retry after the usage-limit prompt) replaces its parts. */
export function appendMessage(db: DatabaseSync, sessionId: string, input: AppendChatMessage): void {
  db.prepare(
    `INSERT INTO chat_messages (id, session_id, role, parts, context, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET parts = excluded.parts, context = excluded.context, model = excluded.model`
  ).run(
    input.message.id,
    sessionId,
    input.message.role,
    JSON.stringify(input.message.parts),
    input.context ? JSON.stringify(input.context) : null,
    input.model ?? null,
    input.createdAt ?? new Date().toISOString()
  );
}

/** Retrying a user message drops whatever (failed / partial) replies followed it. */
export function truncateAfter(db: DatabaseSync, sessionId: string, messageId: string): number {
  const row = db.prepare("SELECT created_at, rowid FROM chat_messages WHERE session_id = ? AND id = ?").get(sessionId, messageId) as
    { created_at: string; rowid: number } | undefined;
  if (!row) return 0;
  return Number(
    db
      .prepare("DELETE FROM chat_messages WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?))")
      .run(sessionId, row.created_at, row.created_at, row.rowid).changes
  );
}

export function clearMessages(db: DatabaseSync, sessionId: string): number {
  return Number(db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(sessionId).changes);
}

function parseParts(raw: string): UIMessage["parts"] {
  try {
    const parts = JSON.parse(raw) as unknown;
    return Array.isArray(parts) ? (parts as UIMessage["parts"]) : [];
  } catch {
    return [];
  }
}
