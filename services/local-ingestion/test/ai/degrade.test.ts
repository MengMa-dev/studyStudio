import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { prepareSchemaForProvider, schemaHintForPrompt } from "../../src/ai/schema-wrap";

test("JSON-mode degradation adds schema hint and keeps wrapped union", () => {
  const schema = z.discriminatedUnion("decision", [
    z.object({ decision: z.literal("new"), name: z.string() }),
    z.object({ decision: z.literal("reject"), reason: z.string() })
  ]);
  const prepared = prepareSchemaForProvider(schema, true);
  const hint = schemaHintForPrompt(prepared.schema);
  assert.match(hint, /JSON Schema/);
  assert.match(hint, /result/);
  // Local validation path: parse model JSON then unwrap
  const raw = JSON.parse('{"result":{"decision":"new","name":"HITL"}}');
  const parsed = prepared.schema.parse(raw);
  assert.deepEqual("result" in parsed ? parsed.result : parsed, { decision: "new", name: "HITL" });
});
