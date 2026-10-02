import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError } from "@ai-sdk/provider";
import { ContextTooLongError } from "../../src/ai/errors";
import { isContextTooLongError, isRetryableProviderError, withRetries } from "../../src/ai/retry";

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
