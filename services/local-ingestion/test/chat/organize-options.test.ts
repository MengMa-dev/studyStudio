import { test } from "node:test";
import assert from "node:assert/strict";
import { organizeRunRequestSchema, type ChatContext, type ChatOrganizeOption } from "@study-studio/shared";
import { resolveOrganizeOptions, type OrganizeLookups, type OrganizeTarget } from "../../src/domains/chat/tools/organize-options.js";

const lookups: OrganizeLookups = {
  entryName: (id) => (id === "kb-1" ? "重排" : null),
  itemTitle: (id) => (id === "item-1" ? "RAG 入门" : null)
};

function resolve(context: ChatContext, target: OrganizeTarget): ChatOrganizeOption[] {
  const options = resolveOrganizeOptions(context, target, lookups);
  for (const option of options) organizeRunRequestSchema.parse(option);
  return options;
}

const scopes = (options: ChatOrganizeOption[]) => options.map((option) => option.scope);
const labels = (options: ChatOrganizeOption[]) => options.map((option) => option.label);

const entryPage: ChatContext = { page: "entry", entryId: "kb-1" };
const itemPage: ChatContext = { page: "item", itemId: "item-1" };

test("「帮我整理该页知识点」: current pre-fills item / entry with the target name", () => {
  assert.deepEqual(resolve(itemPage, "current"), [{ scope: "item", label: "当前条目", itemIds: ["item-1"], entryIds: [], targetName: "RAG 入门" }]);
  assert.deepEqual(resolve(entryPage, "current"), [{ scope: "entry", label: "当前知识点", itemIds: [], entryIds: ["kb-1"], targetName: "重排" }]);
});

test("「整理」on entry detail: current entry / all pending / full", () => {
  const options = resolve(entryPage, "ask");
  assert.deepEqual(scopes(options), ["entry", "kb_pending", "kb_all"]);
  assert.deepEqual(labels(options), ["当前知识点", "所有未整理内容", "全量"]);
  assert.equal(options[0]!.targetName, "重排");
});

test("「整理」on inbox / wiki: pending / full / selected only when something is selected", () => {
  assert.deepEqual(scopes(resolve({ page: "inbox" }, "ask")), ["inbox_pending", "inbox_all"]);
  const inbox = resolve({ page: "inbox", selectedItemIds: ["a", "b", "a"] }, "ask");
  assert.deepEqual(scopes(inbox), ["inbox_pending", "inbox_all", "inbox_selected"]);
  assert.deepEqual(inbox[2]!.itemIds, ["a", "b"]);
  assert.equal(inbox[2]!.label, "已选（2 条）");

  assert.deepEqual(scopes(resolve({ page: "wiki", selectedEntryIds: [] }, "ask")), ["kb_pending", "kb_all"]);
  const wiki = resolve({ page: "wiki", selectedEntryIds: ["kb-1"] }, "ask");
  assert.deepEqual(scopes(wiki), ["kb_pending", "kb_all", "kb_selected"]);
  assert.deepEqual(wiki[2]!.entryIds, ["kb-1"]);
});

test("「整理」on other pages: inbox pending / full", () => {
  for (const page of ["home", "progress", "runs"] as const) {
    assert.deepEqual(scopes(resolve({ page }, "ask")), ["inbox_pending", "inbox_all"], page);
  }
  assert.deepEqual(scopes(resolve(itemPage, "ask")), ["inbox_pending", "inbox_all"]);
});

test("pending / all follow the page: knowledge base pages use kb_*, others inbox_*", () => {
  assert.deepEqual(scopes(resolve({ page: "inbox" }, "pending")), ["inbox_pending"]);
  assert.deepEqual(scopes(resolve({ page: "home" }, "pending")), ["inbox_pending"]);
  assert.deepEqual(scopes(resolve(itemPage, "pending")), ["inbox_pending"]);
  assert.deepEqual(scopes(resolve({ page: "wiki" }, "pending")), ["kb_pending"]);
  assert.deepEqual(scopes(resolve(entryPage, "pending")), ["kb_pending"]);

  assert.deepEqual(scopes(resolve({ page: "progress" }, "all")), ["inbox_all"]);
  assert.deepEqual(scopes(resolve({ page: "inbox" }, "all")), ["inbox_all"]);
  assert.deepEqual(scopes(resolve({ page: "wiki" }, "all")), ["kb_all"]);
  assert.deepEqual(scopes(resolve(entryPage, "all")), ["kb_all"]);
});

test("selected uses the page's selection", () => {
  assert.deepEqual(resolve({ page: "inbox", selectedItemIds: ["a"] }, "selected"), [
    { scope: "inbox_selected", label: "已选（1 条）", itemIds: ["a"], entryIds: [] }
  ]);
  assert.deepEqual(resolve({ page: "wiki", selectedEntryIds: ["x", "y"] }, "selected"), [
    { scope: "kb_selected", label: "已选（2 个知识点）", itemIds: [], entryIds: ["x", "y"] }
  ]);
});

test("degrades to ask: current off detail pages / missing object, selected without selection", () => {
  assert.deepEqual(scopes(resolve({ page: "home" }, "current")), ["inbox_pending", "inbox_all"]);
  assert.deepEqual(scopes(resolve({ page: "wiki", selectedEntryIds: ["kb-1"] }, "current")), ["kb_pending", "kb_all", "kb_selected"]);
  assert.deepEqual(scopes(resolve({ page: "item" }, "current")), ["inbox_pending", "inbox_all"]);
  assert.deepEqual(scopes(resolve({ page: "item", itemId: "gone" }, "current")), ["inbox_pending", "inbox_all"]);
  assert.deepEqual(scopes(resolve({ page: "entry", entryId: "gone" }, "current")), ["kb_pending", "kb_all"], "deleted entry drops the current option");

  assert.deepEqual(scopes(resolve({ page: "inbox" }, "selected")), ["inbox_pending", "inbox_all"]);
  assert.deepEqual(scopes(resolve({ page: "wiki" }, "selected")), ["kb_pending", "kb_all"]);
  assert.deepEqual(scopes(resolve(entryPage, "selected")), ["entry", "kb_pending", "kb_all"]);
  assert.deepEqual(scopes(resolve({ page: "home", selectedItemIds: ["a"] }, "selected")), ["inbox_pending", "inbox_all"]);
});
