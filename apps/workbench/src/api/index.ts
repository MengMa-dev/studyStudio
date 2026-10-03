import { mockApi } from "./mock/client";
import { realApi } from "./real/client";

/** Mock is default in Vite dev; set VITE_MOCK=0 to hit the real local service. */
export function useMockApi(): boolean {
  if (import.meta.env.VITE_MOCK === "0" || import.meta.env.VITE_MOCK === "false") return false;
  if (import.meta.env.VITE_MOCK === "1" || import.meta.env.VITE_MOCK === "true") return true;
  return import.meta.env.DEV;
}

export type WorkbenchApi = typeof mockApi;
export const api: WorkbenchApi = useMockApi() ? mockApi : realApi;

export { mockApi, resetMockState, getMockState } from "./mock/client";
