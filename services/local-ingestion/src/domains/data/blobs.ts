import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export type StoredBlob = { sha256: string; size: number; path: string };

/**
 * Store binary data under blobs/<aa>/<sha256>. Skips rewrite when the file already exists.
 * Returns null when dataDir is unavailable (in-memory mode).
 */
export function storeBlob(dataDir: string | null, data: Buffer, _mime?: string): StoredBlob | null {
  if (!dataDir) return null;
  const sha256 = sha256Hex(data);
  const dir = join(dataDir, "blobs", sha256.slice(0, 2));
  const path = join(dir, sha256);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, data);
  }
  return { sha256, size: data.length, path: `blobs/${sha256.slice(0, 2)}/${sha256}` };
}

/** Persist inline data URLs from media entries; never downloads remote URLs. */
export function storeInlineMedia(
  dataDir: string | null,
  media: unknown[] | undefined
): { kind: string; sha256: string | null; mime: string | null; size: number | null; source_url: string | null }[] {
  if (!media?.length) return [];
  const results: { kind: string; sha256: string | null; mime: string | null; size: number | null; source_url: string | null }[] = [];
  for (const entry of media) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { type?: string; url?: string; alt?: string; data?: string; mime?: string };
    const kind = item.type ?? "image";
    const sourceUrl = typeof item.url === "string" ? item.url : null;
    if (typeof item.data === "string" && item.data.length > 0) {
      const buffer = Buffer.from(item.data, item.data.startsWith("data:") ? "utf8" : "base64");
      const payload = item.data.startsWith("data:") && item.data.includes(",") ? Buffer.from(item.data.slice(item.data.indexOf(",") + 1), "base64") : buffer;
      const stored = storeBlob(dataDir, payload, item.mime);
      results.push({
        kind,
        sha256: stored?.sha256 ?? null,
        mime: item.mime ?? null,
        size: stored?.size ?? payload.length,
        source_url: sourceUrl
      });
      continue;
    }
    if (sourceUrl?.startsWith("data:") && sourceUrl.includes(",")) {
      const [, meta, b64] = /^(data:[^;]+;base64),(.+)$/.exec(sourceUrl) ?? [];
      if (b64) {
        const payload = Buffer.from(b64, "base64");
        const mime = meta?.slice(5, meta.indexOf(";")) || item.mime || null;
        const stored = storeBlob(dataDir, payload, mime ?? undefined);
        results.push({
          kind,
          sha256: stored?.sha256 ?? null,
          mime,
          size: stored?.size ?? payload.length,
          source_url: sourceUrl.slice(0, 64)
        });
        continue;
      }
    }
    results.push({ kind, sha256: null, mime: item.mime ?? null, size: null, source_url: sourceUrl });
  }
  return results;
}
