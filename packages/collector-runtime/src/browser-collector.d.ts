/** Hand-written types for the JS runtime (kept in JS this phase, see 12). */
export interface Threshold {
  minActiveSeconds: number;
  minScrollDepth: number;
  minRevisitSeconds: number;
}

export interface PageIndex {
  lookup(canonicalUrl: string): Promise<{ captured: boolean }>;
}

export interface CaptureHints {
  fromSearch?: boolean;
  nearAiConversation?: boolean;
}

export interface NavigationMeta {
  openerTabId?: number;
  referrer?: string;
  transition?: "link" | "typed" | "back_forward" | "reload" | "other";
}

export interface PresencePayload {
  title: string;
  url: string;
  visibleSeconds: number;
  captured: boolean;
  platform?: string;
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
  activityEnabled?: boolean;
  category?: "learning_candidate" | "unrelated" | "neutral";
  tabId?: number | null;
  navigation?: NavigationMeta | null;
  captureHints?: CaptureHints | null;
  onPresence?: ((payload: PresencePayload) => void) | null;
  excluded?: boolean;
  conversationPlatforms?: Record<string, boolean> | null;
  onSearch?: ((url: string) => void) | null;
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
export function conversationIdFromUrl(url: string): string | null;
export function createExposureTracker(options: { root: Element; doc?: Document; win?: Window }): {
  snapshot(): {
    sections: { key: string; heading: string | null; chars: number; exposed_seconds: number; coverage: number }[];
    top_blocks: { fp: string; exposed_seconds: number }[];
    page_coverage: number;
  };
  stop(): void;
};
export function findContentRoot(doc?: Document): Element | null;
