import { apiRequest } from "./api";

export type ConnectionState = "online" | "offline" | "unauthorized" | "unknown";

export type Connectivity = {
  state: ConnectionState;
  checkedAt: number;
  error?: string;
};

const SESSION_KEY = "connectivity";

let memory: Connectivity = { state: "unknown", checkedAt: 0 };

export function getConnectivity(): Connectivity {
  return memory;
}

export async function restoreConnectivity(): Promise<Connectivity> {
  const stored = (await browser.storage.session.get(SESSION_KEY)) as { connectivity?: Connectivity };
  if (stored.connectivity) memory = stored.connectivity;
  return memory;
}

async function persist(next: Connectivity): Promise<Connectivity> {
  memory = next;
  await browser.storage.session.set({ [SESSION_KEY]: next }).catch(() => {});
  return memory;
}

export async function checkConnectivity(): Promise<Connectivity> {
  const result = await apiRequest("/v1/pairing", { timeoutMs: 3_000 });
  if (result.status === 401) return persist({ state: "unauthorized", checkedAt: Date.now(), error: "配对令牌无效" });
  if (result.ok) return persist({ state: "online", checkedAt: Date.now() });
  return persist({ state: "offline", checkedAt: Date.now(), error: result.error ?? `HTTP ${result.status}` });
}

export async function markOffline(error?: string): Promise<Connectivity> {
  return persist({ state: "offline", checkedAt: Date.now(), error });
}

export async function markUnauthorized(): Promise<Connectivity> {
  return persist({ state: "unauthorized", checkedAt: Date.now(), error: "配对令牌无效" });
}

/** When offline and recently checked, skip another health probe and enqueue immediately. */
export function shouldEnqueueWithoutSend(): boolean {
  return memory.state !== "online" && memory.state !== "unknown" && Date.now() - memory.checkedAt < 30_000;
}
