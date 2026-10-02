import http from "node:http";
import { mkdir, appendFile, writeFile, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { validateEvent } from "@study-studio/collector-contract";

const MAX_BODY_BYTES = 20 * 1024 * 1024;

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

async function listDirectory(path) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/** Only learning behaviour reaches the timeline; plain navigation such as `page_opened` is dropped. */
const LEARNING_EVENT_TYPES = new Set(["user_message_sent", "assistant_response_completed", "webpage_captured", "user_note"]);
/** Later stays on a captured page shorter than this are not reading time; the capturing stay always counts. */
const MIN_REVISIT_SECONDS = 60;

/** Timeline keeps facts and references; full bodies live only in inbox. */
function timelineEntry(event, artifact) {
  if (event.type === "webpage_captured") {
    const { content, ...rest } = event;
    return {
      ...rest,
      content: { title: content.title, canonicalUrl: content.canonicalUrl, contentHash: content.contentHash, extractor: content.extractor },
      artifact
    };
  }
  if (event.type === "assistant_response_completed") {
    const { answer, ...rest } = event;
    return { ...rest, answer: { contentHash: answer.contentHash, preview: answer.plainText.slice(0, 200) }, artifact };
  }
  return event;
}

export async function createIngestionServer({ dataDir, pairingToken, minRevisitSeconds = MIN_REVISIT_SECONDS }) {
  if (!pairingToken) throw new Error("pairingToken is required");
  const paths = {
    timeline: join(dataDir, "timeline"),
    conversations: join(dataDir, "inbox", "conversations"),
    webpages: join(dataDir, "inbox", "webpages"),
    state: join(dataDir, "state")
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));

  const seenEventIds = new Set();
  for (const file of (await listDirectory(paths.timeline)).filter((name) => name.endsWith(".jsonl"))) {
    for (const line of (await readFile(join(paths.timeline, file), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        seenEventIds.add(JSON.parse(line).id);
      } catch {
        /* skip corrupt line */
      }
    }
  }
  /** One inbox entry per canonical URL: reopening a captured page never captures it again. */
  const webpageIndex = new Map();
  for (const folder of await listDirectory(paths.webpages)) {
    const metadata = await readJson(join(paths.webpages, folder, "metadata.json"), null);
    const canonicalUrl = metadata?.content?.canonicalUrl;
    if (canonicalUrl && !webpageIndex.has(canonicalUrl)) webpageIndex.set(canonicalUrl, `inbox/webpages/${folder}`);
  }

  let queue = Promise.resolve();
  const serialized = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  async function persistArtifact(event) {
    if (event.type === "assistant_response_completed") {
      const relative = `inbox/conversations/qa-${event.id}`;
      const folder = join(dataDir, relative);
      await mkdir(join(folder, "assets"), { recursive: true });
      await writeFile(join(folder, "record.json"), JSON.stringify(event, null, 2));
      await writeFile(join(folder, "question.md"), event.question?.plainText ?? "");
      await writeFile(join(folder, "answer.md"), event.answer.markdown ?? event.answer.plainText);
      await writeFile(join(folder, "answer.txt"), event.answer.plainText);
      await writeFile(join(folder, "answer.html"), event.answer.sanitizedHtml ?? "");
      return { artifact: relative };
    }
    if (event.type === "webpage_captured") {
      const { content } = event;
      const relative = `inbox/webpages/page-${event.id}`;
      const folder = join(dataDir, relative);
      await mkdir(join(folder, "assets"), { recursive: true });
      const { markdown, plainText, sanitizedHtml, ...contentMeta } = content;
      await writeFile(
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
      await writeFile(join(folder, "content.md"), markdown ?? "");
      await writeFile(join(folder, "content.txt"), plainText);
      await writeFile(join(folder, "content.html"), sanitizedHtml ?? "");
      webpageIndex.set(content.canonicalUrl, relative);
      return { artifact: relative };
    }
    return {};
  }

  async function appendTimeline(event, entry) {
    await appendFile(join(paths.timeline, `${event.occurredAt.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`);
    seenEventIds.add(event.id);
  }

  /** Adds the stay's visible time to the captured page's `readingStats`. */
  async function recordReadingTime(event) {
    const ignored = { status: 202, body: { accepted: true, ignored: true } };
    const artifact = webpageIndex.get(event.source.canonicalUrl);
    if (!artifact) return ignored;
    const metadataPath = join(dataDir, artifact, "metadata.json");
    const metadata = await readJson(metadataPath, null);
    if (!metadata) return ignored;
    const seconds = Math.floor(event.readingSignals.activeDurationSeconds);
    const capturingStay = Boolean(event.sessionId) && event.sessionId === metadata.sessionId;
    if (seconds <= 0 || (!capturingStay && seconds < minRevisitSeconds)) return ignored;

    const stats = metadata.readingStats ?? { totalActiveSeconds: 0, sessionCount: 0 };
    metadata.readingStats = {
      totalActiveSeconds: stats.totalActiveSeconds + seconds,
      sessionCount: stats.sessionCount + 1,
      lastReadAt: event.occurredAt
    };
    await writeJsonAtomic(metadataPath, metadata);
    await appendTimeline(event, { ...event, artifact, countedSeconds: seconds, totalActiveSeconds: metadata.readingStats.totalActiveSeconds });
    return { status: 201, body: { accepted: true, id: event.id, artifact, readingStats: metadata.readingStats } };
  }

  async function ingest(event) {
    if (seenEventIds.has(event.id)) return { status: 200, body: { accepted: true, duplicate: true } };
    if (event.type === "reading_session_closed") return recordReadingTime(event);
    if (!LEARNING_EVENT_TYPES.has(event.type)) return { status: 202, body: { accepted: true, ignored: true } };
    if (event.type === "webpage_captured" && webpageIndex.has(event.content.canonicalUrl)) {
      return { status: 200, body: { accepted: true, duplicatePage: true, artifact: webpageIndex.get(event.content.canonicalUrl) } };
    }
    const result = await persistArtifact(event);
    await appendTimeline(event, timelineEntry(event, result.artifact));
    return { status: 201, body: { accepted: true, id: event.id, ...result } };
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true });
    if (request.headers.authorization !== `Bearer ${pairingToken}`) return json(response, 401, { error: "unauthorized" });
    try {
      if (request.method === "GET" && url.pathname === "/v1/pairing") return json(response, 200, { paired: true });
      if (request.method === "POST" && url.pathname === "/v1/events") {
        const event = await readBody(request);
        const validationError = validateEvent(event);
        if (validationError) return json(response, 422, { error: validationError });
        const { status, body } = await serialized(() => ingest(event));
        return json(response, status, body);
      }
      if (request.method === "GET" && url.pathname === "/v1/pages") {
        const canonicalUrl = url.searchParams.get("canonicalUrl");
        if (!canonicalUrl || !/^https?:\/\//.test(canonicalUrl)) return json(response, 422, { error: "canonicalUrl is invalid" });
        return json(response, 200, { captured: webpageIndex.has(canonicalUrl) });
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      return json(response, error.status ?? 400, { error: error instanceof Error ? error.message : "invalid_request" });
    }
  });

  return {
    server,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}
