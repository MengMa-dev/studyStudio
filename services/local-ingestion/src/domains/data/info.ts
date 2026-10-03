import { randomUUID } from "node:crypto";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DataInfoResponse } from "@study-studio/shared";
import type { AppDatabase } from "../../db/database.js";
import type { AuthState } from "../../http/auth.js";
import type { PresenceStore } from "../capture/presence.js";

/** Extension counts as connected when it synced or sent a heartbeat this recently. */
export const EXTENSION_ONLINE_MS = 5 * 60 * 1000;

function sizeOf(path: string): number {
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const name of readdirSync(path)) total += sizeOf(join(path, name));
    return total;
  } catch {
    return 0;
  }
}

export function maskToken(token: string): string {
  if (token.length <= 12) return "•".repeat(token.length);
  return `${token.slice(0, 8)}••••••••••••${token.slice(-4)}`;
}

export type ExtensionStatus = { connected: boolean; lastSeenAt: string | null };

/** Last capture request received (events) or presence heartbeat, whichever is newer. */
export function extensionStatus(appDb: AppDatabase, presence: PresenceStore, now = new Date()): ExtensionStatus {
  const lastEvent = (appDb.db.prepare("SELECT MAX(received_at) AS at FROM events").get() as { at: string | null }).at;
  const candidates = [lastEvent, ...presence.list().map((entry) => entry.updatedAt)].filter((value): value is string => Boolean(value));
  const lastSeenAt = candidates.sort().at(-1) ?? null;
  const connected = lastSeenAt !== null && now.getTime() - Date.parse(lastSeenAt) <= EXTENSION_ONLINE_MS;
  return { connected, lastSeenAt };
}

export type DataInfoContext = { appDb: AppDatabase; auth: AuthState; presence: PresenceStore; port: number };

export function getDataInfo(ctx: DataInfoContext, now = new Date()): DataInfoResponse {
  const { appDb } = ctx;
  const sqliteVersion = (appDb.db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  const dataDir = appDb.dataDir ?? "";
  const sizeBytes = appDb.dataDir
    ? ["studystudio.db", "studystudio.db-wal", "studystudio.db-shm", "blobs"].reduce((sum, name) => sum + sizeOf(join(dataDir, name)), 0)
    : 0;
  const itemCount = Number((appDb.db.prepare("SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL").get() as { n: number }).n);
  const extension = extensionStatus(appDb, ctx.presence, now);
  return {
    address: `127.0.0.1:${ctx.port}`,
    uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
    sqliteVersion,
    dataDir,
    sizeBytes,
    itemCount,
    extensionConnected: extension.connected,
    extensionLastSeenAt: extension.lastSeenAt,
    extensionPendingCount: 0,
    pairingTokenMasked: maskToken(ctx.auth.pairingToken),
    pairingToken: ctx.auth.pairingToken
  };
}

/** New token takes effect immediately; the old one is rejected from the next request on. */
export function resetPairingToken(appDb: AppDatabase, auth: AuthState): { token: string; masked: string } {
  const token = randomUUID();
  if (appDb.dataDir) writeFileSync(join(appDb.dataDir, ".pairing-token"), token, { mode: 0o600 });
  auth.pairingToken = token;
  return { token, masked: maskToken(token) };
}
