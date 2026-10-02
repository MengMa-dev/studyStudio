/** Hand-written types for the JS runtime (kept in JS this phase, see 12). */
export interface Threshold {
  minActiveSeconds: number;
  minScrollDepth: number;
  minRevisitSeconds: number;
}

export interface PageIndex {
  lookup(canonicalUrl: string): Promise<{ captured: boolean }>;
}

export interface InstallOptions {
  emit(event: Record<string, unknown>): void;
  channel: "browser_extension" | "desktop_browser";
  isStrongLearning?: boolean;
  threshold?: Partial<Threshold>;
  pageIndex?: PageIndex | null;
  doc?: Document;
  win?: Window;
  navigationPollMs?: number;
  checkIntervalMs?: number;
  debounceMs?: number;
}

export interface InstalledCollector {
  readonly mode: string | null;
  addNote(text: string): void;
  stop(): void;
}

export const DEFAULT_THRESHOLD: Threshold;
export function installCollector(options: InstallOptions): InstalledCollector;
export function extractPageContent(doc: Document): Record<string, unknown> | null;
export function canonicalUrlOf(doc: Document, win: Window): string;
export function normalizeUrl(url: string): string;
export function contentHash(text: string): string;
