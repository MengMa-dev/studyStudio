import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../../db/database.js";
import { AgentToolError } from "./errors.js";

/** Agent-sourced inbox items stored in the same shape as browser captures: one `conversation` item per Q&A turn (threaded by `meta.conversationId`), files as `document`. `site` records the agent. */

const MAX_FILE_BYTES = 1024 * 1024;

export type AgentTurn = { question: string; answer: string };

export type AddToInboxInput =
  | { agent: string; source: "conversation"; turns: AgentTurn[] }
  | { agent: string; source: "file"; filePath: string };

function readTextFile(filePath: string): string {
  if (!isAbsolute(filePath)) throw new AgentToolError("invalid_input", "file_path 必须是绝对路径");
  let size: number;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new AgentToolError("invalid_input", "file_path 不是文件");
    size = stat.size;
  } catch (error) {
    if (error instanceof AgentToolError) throw error;
    throw new AgentToolError("file_not_found", `无法读取文件：${filePath}`);
  }
  if (size > MAX_FILE_BYTES) throw new AgentToolError("file_too_large", `文件超过 ${MAX_FILE_BYTES / 1024} KB`);
  const text = readFileSync(filePath, "utf8");
  if (text.includes("\0")) throw new AgentToolError("unsupported_file", "仅支持文本文件");
  if (!text.trim()) throw new AgentToolError("invalid_input", "文件为空");
  return text;
}

export function addToInbox(db: DatabaseSync, input: AddToInboxInput, now: Date): string[] {
  const fileText = input.source === "file" ? readTextFile(input.filePath) : null;
  return withTransaction(db, () => {
    const insertItem = db.prepare(
      `INSERT INTO items(id, type, title, url, canonical_url, site, captured_at, is_strong_learning) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    );
    const insertContent = db.prepare(
      `INSERT INTO item_contents(item_id, markdown, plain_text, question, extractor, meta) VALUES (?, ?, ?, ?, 'agent', ?)`
    );
    const insertEvent = db.prepare(
      `INSERT INTO events(id, type, occurred_at, day, channel, site, url, canonical_url, item_id, payload, received_at)
       VALUES (?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`
    );
    const event = (type: string, at: string, url: string | null, itemId: string, payload: Record<string, unknown>) =>
      insertEvent.run(randomUUID(), type, at, at.slice(0, 10), input.agent, url, url, itemId, JSON.stringify(payload), now.toISOString());

    if (input.source === "file") {
      const id = randomUUID();
      const at = now.toISOString();
      const url = pathToFileURL(input.filePath).href;
      const title = basename(input.filePath);
      insertItem.run(id, "document", title, url, url, input.agent, at);
      insertContent.run(id, fileText, fileText, null, JSON.stringify({ filePath: input.filePath }));
      // The explicit "save this file" request is the learning signal; no reading time is known.
      event("page_session", at, url, id, {
        session: { domain: input.agent, category: "learning_candidate", url, title, startedAt: at, endedAt: at, visibleSeconds: 0, captured: true }
      });
      return [id];
    }
    const conversationId = `agent-${randomUUID()}`;
    return input.turns.map((turn, index) => {
      const id = randomUUID();
      // Distinct timestamps keep turn order stable when units are rebuilt by captured_at.
      const at = new Date(now.getTime() + index).toISOString();
      insertItem.run(id, "conversation", turn.question.slice(0, 120), null, null, input.agent, at);
      insertContent.run(id, turn.answer, turn.answer, turn.question, JSON.stringify({ conversationId }));
      event("assistant_response_completed", at, null, id, {
        conversationId,
        source: { channel: "agent", platform: input.agent },
        question: { preview: turn.question.slice(0, 200) },
        answer: { preview: turn.answer.slice(0, 200) }
      });
      return id;
    });
  });
}
