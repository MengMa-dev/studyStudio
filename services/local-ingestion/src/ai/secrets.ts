import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Same shape `scripts/setup-dev-ai.js` writes: `{ providers: { [id]: { apiKey } } }`. */
type SecretsData = {
  providers?: Record<string, { apiKey?: string | null } | undefined>;
  [key: string]: unknown;
};

export const SECRETS_FILE = "secrets.json";

export function secretsPathFor(dataDir: string | null): string | null {
  return dataDir ? join(dataDir, SECRETS_FILE) : null;
}

/** API keys live outside SQLite (06 S11): `secrets.json`, mode 0600. `path: null` keeps keys in memory (tests). */
export class SecretsFile {
  readonly path: string | null;
  private memory: SecretsData = {};

  constructor(path: string | null) {
    this.path = path;
  }

  private read(): SecretsData {
    if (!this.path) return this.memory;
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as SecretsData) : {};
    } catch {
      return {};
    }
  }

  private write(data: SecretsData): void {
    if (!this.path) {
      this.memory = data;
      return;
    }
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  getApiKey(providerId: string): string | null {
    const key = this.read().providers?.[providerId]?.apiKey;
    return typeof key === "string" && key.length > 0 ? key : null;
  }

  setApiKey(providerId: string, apiKey: string | null): void {
    const data = this.read();
    const providers = { ...data.providers };
    if (apiKey) providers[providerId] = { ...providers[providerId], apiKey };
    else delete providers[providerId];
    this.write({ ...data, providers });
  }
}

/** `sk-…abcd`; short keys reveal nothing. */
export function maskApiKey(apiKey: string | null | undefined): string | null {
  if (!apiKey) return null;
  if (apiKey.length < 12) return "••••";
  return `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`;
}
