import assert from "node:assert/strict";
import { test } from "node:test";
import { testProviderConnection } from "../../src/ai/test-connection";

test("testProviderConnection succeeds for mock and lists models", async () => {
  const result = await testProviderConnection({
    id: "mock",
    name: "Mock",
    type: "mock",
    baseUrl: null,
    defaultModel: "deterministic"
  });
  assert.equal(result.ok, true);
  assert.ok((result.models?.length ?? 0) >= 1);
});
