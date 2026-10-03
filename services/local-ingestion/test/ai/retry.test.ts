import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError } from "@ai-sdk/provider";
import { ContextTooLongError } from "../../src/ai/errors";
import { isContextTooLongError, isRetryableProviderError, quotaCooldownMs, retryAfterMs, withRetries } from "../../src/ai/retry";

test("classifies 429/5xx as retryable and context-too-long as not", () => {
  assert.equal(isRetryableProviderError(new APICallError({ message: "rate", url: "u", requestBodyValues: {}, statusCode: 429, isRetryable: true })), true);
  assert.equal(isRetryableProviderError(new APICallError({ message: "boom", url: "u", requestBodyValues: {}, statusCode: 503, isRetryable: true })), true);
  assert.equal(isRetryableProviderError(new APICallError({ message: "bad", url: "u", requestBodyValues: {}, statusCode: 400, isRetryable: false })), false);
  assert.equal(isContextTooLongError(new Error("context_length_exceeded: max tokens")), true);
  assert.equal(isRetryableProviderError(new Error("context_length_exceeded")), false);
});

test("withRetries backs off on 429 then succeeds", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await withRetries(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new APICallError({ message: "rate", url: "u", requestBodyValues: {}, statusCode: 429, isRetryable: true });
      }
      return "ok";
    },
    {
      retries: 3,
      baseDelayMs: 10,
      sleep: async (ms) => {
        delays.push(ms);
      }
    }
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("withRetries does not retry context-too-long and wraps error", async () => {
  await assert.rejects(
    () =>
      withRetries(async () => {
        throw new APICallError({
          message: "This model's maximum context length was exceeded",
          url: "u",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false
        });
      }),
    (error: unknown) => error instanceof ContextTooLongError
  );
});

test("honors provider-requested wait from Retry-After or the error message, capped at 60s", async () => {
  const groq = new APICallError({
    message: "Rate limit reached for model on tokens per minute (TPM): Limit 8000. Please try again in 21.4125s. Need more tokens?",
    url: "u",
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true
  });
  assert.equal(retryAfterMs(groq), 21412.5);
  assert.equal(retryAfterMs(new Error("try again in 1m30s")), 60_000);
  assert.equal(retryAfterMs(new Error("try again in 350ms")), 350);
  const withHeader = new APICallError({
    message: "rate",
    url: "u",
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
    responseHeaders: { "retry-after": "7" }
  });
  assert.equal(retryAfterMs(withHeader), 7000);
  assert.equal(retryAfterMs(new Error("rate")), null);

  const delays: number[] = [];
  let attempts = 0;
  await withRetries(
    async () => {
      attempts += 1;
      if (attempts === 1) throw groq;
      return "ok";
    },
    { baseDelayMs: 10, sleep: async (ms) => void delays.push(ms) }
  );
  assert.deepEqual(delays, [21412.5]);
});

test("long provider waits are quota exhaustion: no retry, cooldown reported", async () => {
  const gemini = new APICallError({
    message:
      "You exceeded your current quota.\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 20\nPlease retry in 8h13m38.761570599s.",
    url: "u",
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true
  });
  assert.equal(retryAfterMs(gemini), 60_000);
  assert.equal(quotaCooldownMs(gemini), 8 * 3_600_000 + 13 * 60_000 + 38_761.570599);
  assert.equal(
    quotaCooldownMs(new APICallError({ message: "Please try again in 21s", url: "u", requestBodyValues: {}, statusCode: 429, isRetryable: true })),
    null
  );

  let attempts = 0;
  await assert.rejects(() =>
    withRetries(
      async () => {
        attempts += 1;
        throw gemini;
      },
      { retries: 3, sleep: async () => {} }
    )
  );
  assert.equal(attempts, 1);
});
