import { APICallError } from "@ai-sdk/provider";
import { ContextTooLongError } from "./errors";

const CONTEXT_RE =
  /context\s*(length|window|size)|maximum\s*context|token\s*(limit|count).*exceed|too\s*many\s*tokens|prompt\s*is\s*too\s*long|context_length_exceeded|max_tokens|input.*too\s*long/i;

export function getHttpStatus(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) return error.statusCode;
  if (error && typeof error === "object" && "statusCode" in error) {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isContextTooLongError(error: unknown): boolean {
  if (error instanceof ContextTooLongError) return true;
  const status = getHttpStatus(error);
  const message = errorMessage(error);
  const body = error && typeof error === "object" && "responseBody" in error ? String((error as { responseBody?: unknown }).responseBody ?? "") : "";
  const text = `${message}\n${body}`;
  if (CONTEXT_RE.test(text)) return true;
  // Some providers return 400 with a clear message; avoid treating all 400s as context errors.
  if (status === 400 && /context|token/i.test(text) && /long|limit|exceed|max/i.test(text)) return true;
  return false;
}

/** 429 and 5xx are retryable; context-too-long is not. */
export function isRetryableProviderError(error: unknown): boolean {
  if (isContextTooLongError(error)) return false;
  if (APICallError.isInstance(error) && typeof error.isRetryable === "boolean") {
    // Still force-retry 429/5xx even if provider marks oddly.
    const status = error.statusCode;
    if (status === 429 || (typeof status === "number" && status >= 500)) return true;
    if (isContextTooLongError(error)) return false;
  }
  const status = getHttpStatus(error);
  return status === 429 || (typeof status === "number" && status >= 500 && status <= 599);
}

export type RetryOptions = {
  /** Number of retries after the first attempt (default 3 → up to 4 tries). */
  retries?: number;
  /** Base delay in ms for exponential backoff: base * 2^attempt. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with exponential backoff on 429/5xx.
 * Context-too-long errors are rethrown as ContextTooLongError without retry.
 */
export async function withRetries<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isContextTooLongError(error)) {
        throw new ContextTooLongError(errorMessage(error), { cause: error });
      }
      if (!isRetryableProviderError(error) || attempt === retries) throw error;
      const delayMs = baseDelayMs * 2 ** attempt;
      options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
