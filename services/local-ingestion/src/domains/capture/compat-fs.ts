import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CollectorEvent, EventOf } from "@study-studio/shared";

/**
 * Temporary filesystem mirror so unupdated extension / desktop bridge tests that still
 * read `timeline/` + `inbox/` keep working until those consumers move to SQLite.
 * SQLite remains the source of truth; these files are write-only and never read back.
 */
export function writeCompatArtifact(
  dataDir: string | null,
  event: CollectorEvent,
  itemId: string,
  extra: { countedSeconds?: number; totalActiveSeconds?: number } = {}
): void {
  if (!dataDir) return;
  try {
    if (event.type === "webpage_captured") writeWebpage(dataDir, event, itemId);
    else if (event.type === "assistant_response_completed") writeConversation(dataDir, event, itemId);
    appendTimeline(dataDir, event, itemId, extra);
  } catch {
    /* compat writes must never fail ingest */
  }
}

function writeWebpage(dataDir: string, event: EventOf<"webpage_captured">, itemId: string): void {
  const relative = `inbox/webpages/page-${itemId}`;
  const folder = join(dataDir, relative);
  mkdirSync(join(folder, "assets"), { recursive: true });
  const { markdown, plainText, sanitizedHtml, ...contentMeta } = event.content;
  writeFileSync(
    join(folder, "metadata.json"),
    JSON.stringify(
      {
        id: event.id,
        occurredAt: event.occurredAt,
        source: event.source,
        sessionId: event.sessionId,
        reason: event.reason,
        readingSignals: event.readingSignals,
        readingStats: { totalActiveSeconds: 0, sessionCount: 0 },
        content: contentMeta
      },
      null,
      2
    )
  );
  writeFileSync(join(folder, "content.md"), markdown ?? "");
  writeFileSync(join(folder, "content.txt"), plainText);
  writeFileSync(join(folder, "content.html"), sanitizedHtml ?? "");
}

function writeConversation(dataDir: string, event: EventOf<"assistant_response_completed">, itemId: string): void {
  const relative = `inbox/conversations/qa-${itemId}`;
  const folder = join(dataDir, relative);
  mkdirSync(join(folder, "assets"), { recursive: true });
  writeFileSync(join(folder, "record.json"), JSON.stringify(event, null, 2));
  writeFileSync(join(folder, "question.md"), event.question?.plainText ?? "");
  writeFileSync(join(folder, "answer.md"), event.answer.markdown ?? event.answer.plainText);
  writeFileSync(join(folder, "answer.txt"), event.answer.plainText);
  writeFileSync(join(folder, "answer.html"), event.answer.sanitizedHtml ?? "");
}

function appendTimeline(dataDir: string, event: CollectorEvent, itemId: string | null, extra: { countedSeconds?: number; totalActiveSeconds?: number }): void {
  const day = event.occurredAt.slice(0, 10);
  const dir = join(dataDir, "timeline");
  mkdirSync(dir, { recursive: true });
  const artifact =
    event.type === "webpage_captured" && itemId
      ? `inbox/webpages/page-${itemId}`
      : event.type === "assistant_response_completed" && itemId
        ? `inbox/conversations/qa-${itemId}`
        : event.type === "reading_session_closed" && itemId
          ? `inbox/webpages/page-${itemId}`
          : undefined;

  let entry: unknown;
  if (event.type === "webpage_captured") {
    const { content, ...rest } = event;
    entry = {
      ...rest,
      content: {
        title: content.title,
        canonicalUrl: content.canonicalUrl,
        contentHash: content.contentHash,
        extractor: content.extractor
      },
      artifact
    };
  } else if (event.type === "assistant_response_completed") {
    const { answer, ...rest } = event;
    entry = { ...rest, answer: { contentHash: answer.contentHash, preview: answer.plainText.slice(0, 200) }, artifact };
  } else if (event.type === "reading_session_closed") {
    entry = { ...event, artifact, ...extra };
  } else if (event.type === "user_note") {
    entry = event;
  } else {
    return;
  }

  appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(entry)}\n`);
}

/** Update readingStats inside the mirrored metadata.json when reading time is counted. */
export function updateCompatReadingStats(
  dataDir: string | null,
  itemId: string,
  stats: { totalActiveSeconds: number; sessionCount: number; lastReadAt: string }
): void {
  if (!dataDir) return;
  const metadataPath = join(dataDir, "inbox/webpages", `page-${itemId}`, "metadata.json");
  if (!existsSync(metadataPath)) return;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { readingStats?: unknown };
    metadata.readingStats = stats;
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  } catch {
    /* ignore */
  }
}
