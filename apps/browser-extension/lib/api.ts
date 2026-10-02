import {
  DEFAULT_ACTIVITY_TRACKING,
  DEFAULT_CAPTURE_RULES,
  DEFAULT_CONVERSATION_PLATFORMS,
  collectorSettingsSchema,
  type CollectorSettings
} from "@study-studio/shared";
import { META_KEYS, getMeta, setMeta } from "./db";

export type ConnectionConfig = {
  ingestionUrl: string;
  pairingToken: string;
};

export const DEFAULT_CONNECTION: ConnectionConfig = {
  ingestionUrl: "http://127.0.0.1:43118",
  pairingToken: ""
};

export const FALLBACK_SETTINGS: CollectorSettings = collectorSettingsSchema.parse({
  captureRules: DEFAULT_CAPTURE_RULES,
  activityTracking: DEFAULT_ACTIVITY_TRACKING,
  conversationPlatforms: DEFAULT_CONVERSATION_PLATFORMS,
  exclusionRules: [],
  builtinListPageRules: [],
  domainCategoryVersion: 1
});

export async function readConnection(): Promise<ConnectionConfig> {
  const stored = await browser.storage.local.get(DEFAULT_CONNECTION);
  return {
    ingestionUrl: String(stored.ingestionUrl ?? DEFAULT_CONNECTION.ingestionUrl).replace(/\/$/, ""),
    pairingToken: String(stored.pairingToken ?? "")
  };
}

export async function writeConnection(config: ConnectionConfig): Promise<void> {
  await browser.storage.local.set({
    ingestionUrl: config.ingestionUrl.replace(/\/$/, ""),
    pairingToken: config.pairingToken.trim()
  });
}

export type ApiResult<T = unknown> = {
  ok: boolean;
  status: number;
  body: T | null;
  etag?: string | null;
  error?: string;
};

export async function apiRequest<T = unknown>(
  path: string,
  { method = "GET", body, headers = {}, timeoutMs = 3_000 }: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<ApiResult<T>> {
  const { ingestionUrl, pairingToken } = await readConnection();
  if (!pairingToken) return { ok: false, status: 0, body: null, error: "未配置配对令牌" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${ingestionUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${pairingToken}`,
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const etag = response.headers.get("etag");
    if (response.status === 304) return { ok: true, status: 304, body: null, etag };
    const payload = (await response.json().catch(() => null)) as T | null;
    return { ok: response.ok, status: response.status, body: payload, etag };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export async function loadCachedSettings(): Promise<CollectorSettings> {
  const cached = await getMeta<CollectorSettings>(META_KEYS.settings);
  if (!cached) return FALLBACK_SETTINGS;
  const parsed = collectorSettingsSchema.safeParse(cached);
  return parsed.success ? parsed.data : FALLBACK_SETTINGS;
}

export async function refreshSettings(): Promise<CollectorSettings> {
  const etag = await getMeta<string>(META_KEYS.settingsEtag);
  const result = await apiRequest<CollectorSettings>("/v1/settings", {
    headers: etag ? { "if-none-match": etag } : {},
    timeoutMs: 5_000
  });
  if (result.status === 304) return loadCachedSettings();
  if (!result.ok || !result.body) return loadCachedSettings();
  const parsed = collectorSettingsSchema.safeParse(result.body);
  if (!parsed.success) return loadCachedSettings();
  await setMeta(META_KEYS.settings, parsed.data);
  if (result.etag) await setMeta(META_KEYS.settingsEtag, result.etag);
  return parsed.data;
}
