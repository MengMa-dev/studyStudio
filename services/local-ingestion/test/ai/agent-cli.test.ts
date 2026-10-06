import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { generateObject, generateText, jsonSchema, tool } from "ai";
import { z } from "zod";
import { cliCommand, createAgentLanguageModel, parseCliOutput, parseToolCalls, renderPrompt } from "../../src/ai/agent-cli.js";

test("renderPrompt flattens messages and adds JSON / tool protocols", () => {
  const text = renderPrompt({
    prompt: [
      { role: "system", content: "SYS" },
      { role: "user", content: [{ type: "text", text: "Q" }] }
    ],
    responseFormat: { type: "json", schema: { type: "object" } },
    tools: [{ type: "function", name: "search", description: "搜", inputSchema: { type: "object" } }]
  });
  assert.match(text, /## 系统指令\nSYS/);
  assert.match(text, /## 用户\nQ/);
  assert.match(text, /- search：搜/);
  assert.match(text, /"tool_calls"/);
  assert.match(text, /只输出一个 JSON 值.*\n\{"type":"object"\}/);
});

test("parseToolCalls / parseCliOutput", () => {
  assert.deepEqual(parseToolCalls('```json\n{"tool_calls":[{"name":"a","input":{"q":1}}]}\n```'), [{ name: "a", input: { q: 1 } }]);
  assert.equal(parseToolCalls("普通回答"), null);
  assert.equal(parseToolCalls('{"answer":1}'), null);
  assert.deepEqual(parseCliOutput("claude", 'log\n{"type":"result","is_error":false,"result":"hi","usage":{"input_tokens":3,"output_tokens":1}}', null), {
    text: "hi",
    inputTokens: 3,
    outputTokens: 1
  });
  assert.throws(() => parseCliOutput("cursor", '{"type":"result","is_error":true,"result":"Authentication required"}', null), /Authentication/);
  assert.equal(parseCliOutput("codex", "noise", " final \n").text, "final");
  assert.ok(cliCommand("cursor", null, "P", "/w").args.includes("ask"));
  assert.deepEqual(cliCommand("claude", "sonnet", "P", "/w").args.slice(-2), ["--model", "sonnet"]);
  assert.equal(cliCommand("codex", null, "P", "/w").stdin, "P");
});

function fakeCursorAgent(t: { after: (fn: () => void) => void }, results: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "ss-fake-agent-"));
  const counter = join(dir, "n");
  writeFileSync(counter, "0");
  const lines = results.map(
    (result, index) => `[ "$n" = "${index}" ] && printf '%s\\n' '${JSON.stringify({ type: "result", is_error: false, result }).replace(/'/g, "'\\''")}'`
  );
  writeFileSync(join(dir, "cursor-agent"), `#!/bin/sh\nn=$(cat ${counter}); echo $((n+1)) > ${counter}\n${lines.join("\n")}\nexit 0\n`);
  chmodSync(join(dir, "cursor-agent"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previous}`;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("agent model: structured output and tool-call round trip through the AI SDK", async (t) => {
  fakeCursorAgent(t, ['```json\n{"title":"向量检索"}\n```', '{"tool_calls":[{"name":"search","input":{"q":"rag"}}]}', "答案见 [1]"]);
  const model = createAgentLanguageModel("cursor", "default");

  const object = await generateObject({ model, schema: z.object({ title: z.string() }), prompt: "抽取标题", maxRetries: 0 });
  assert.deepEqual(object.object, { title: "向量检索" });

  let searched: unknown = null;
  const result = await generateText({
    model,
    prompt: "什么是 RAG",
    maxRetries: 0,
    stopWhen: ({ steps }) => steps.length >= 3,
    tools: {
      search: tool({
        description: "检索",
        inputSchema: jsonSchema<{ q: string }>({ type: "object", properties: { q: { type: "string" } } }),
        execute: async (input) => {
          searched = input;
          return [{ ref: 1 }];
        }
      })
    }
  });
  assert.deepEqual(searched, { q: "rag" });
  assert.equal(result.text, "答案见 [1]");
});
