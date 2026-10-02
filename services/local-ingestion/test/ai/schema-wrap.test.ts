import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { isTopLevelUnion, prepareSchemaForProvider, unwrapUnionResult, wrapUnionSchema } from "../../src/ai/schema-wrap";

const decisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("new"), name: z.string() }),
  z.object({ decision: z.literal("reject"), reason: z.string() })
]);

test("detects top-level union and wraps for openai-compatible", () => {
  assert.equal(isTopLevelUnion(decisionSchema), true);
  assert.equal(isTopLevelUnion(z.object({ x: z.string() })), false);

  const prepared = prepareSchemaForProvider(decisionSchema, true);
  assert.equal(prepared.wrapped, true);
  assert.match(prepared.systemSuffix, /result/);

  const parsed = prepared.schema.parse({ result: { decision: "new", name: "HITL" } });
  assert.deepEqual(unwrapUnionResult(parsed, true), { decision: "new", name: "HITL" });
});

test("does not wrap for google/ollama/mock", () => {
  const prepared = prepareSchemaForProvider(decisionSchema, false);
  assert.equal(prepared.wrapped, false);
  assert.equal(prepared.systemSuffix, "");
  const parsed = prepared.schema.parse({ decision: "reject", reason: "off_topic" });
  assert.deepEqual(unwrapUnionResult(parsed, false), { decision: "reject", reason: "off_topic" });
});

test("wrapUnionSchema round-trips", () => {
  const wrapped = wrapUnionSchema(decisionSchema);
  const value = wrapped.parse({ result: { decision: "new", name: "a" } });
  assert.equal(value.result.decision, "new");
});
