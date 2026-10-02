export type PresenceEntry = {
  title: string;
  url: string;
  visibleSeconds: number;
  captured: boolean;
  updatedAt: string;
};

/** In-memory presence map keyed by a client-supplied key (or URL). */
export class PresenceStore {
  private readonly entries = new Map<string, PresenceEntry>();
  private readonly ttlMs = 60_000;

  upsert(key: string, entry: Omit<PresenceEntry, "updatedAt">): PresenceEntry {
    const value: PresenceEntry = { ...entry, updatedAt: new Date().toISOString() };
    this.entries.set(key, value);
    return value;
  }

  list(): PresenceEntry[] {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (Date.parse(entry.updatedAt) < cutoff) this.entries.delete(key);
    }
    return [...this.entries.values()];
  }

  clear(): void {
    this.entries.clear();
  }
}
