import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSections,
  attachSectionSources,
  demoteHeadings,
  parseSections,
  removeSectionSource,
  sanitizeHeading,
  serializeSections,
  stripSectionMarkers
} from "../src/kb-sections";

test("sections: append, attach, remove round-trip and fences are not boundaries", () => {
  const legacy = "简介段落\n\n## 手写章节\n手写内容";
  const { body, ids } = appendSections(legacy, [
    { heading: "定义", markdown: "## 原文小标题\n正文\n\n```md\n## not a heading\n```", sourceItemIds: ["item_a"] },
    { heading: "## 搭建", markdown: "步骤", sourceItemIds: ["item_a", "item_a"] }
  ]);
  const sections = parseSections(body);
  assert.deepEqual(
    sections.map((section) => [section.id, section.heading, section.sourceItemIds]),
    [
      [null, null, []],
      [null, "手写章节", []],
      [ids[0], "定义", ["item_a"]],
      [ids[1], "搭建", ["item_a"]]
    ]
  );
  assert.ok(sections[2]!.markdown.startsWith("### 原文小标题"));
  assert.ok(sections[2]!.markdown.includes("## not a heading"), "headings inside fences stay as-is");

  const shared = attachSectionSources(body, ids[1]!, ["item_b"])!;
  assert.equal(attachSectionSources(body, "s_missing", ["item_b"]), null);
  const removed = removeSectionSource(shared, "item_a");
  assert.deepEqual(removed.removedSectionIds, [ids[0]]);
  const left = parseSections(removed.body);
  assert.deepEqual(
    left.map((section) => [section.heading, section.sourceItemIds]),
    [
      [null, []],
      ["手写章节", []],
      ["搭建", ["item_b"]]
    ]
  );
  assert.ok(!stripSectionMarkers(removed.body).includes("<!--"));
});

test("sections: an unclosed fence in a fragment does not swallow later sections", () => {
  const first = appendSections("", [{ heading: "代码", markdown: "示例\n```ts\nconst a = 1;\n## inside", sourceItemIds: ["i1"] }]);
  const second = appendSections(first.body, [{ heading: "后续", markdown: "正文", sourceItemIds: ["i2"] }]);
  const sections = parseSections(second.body);
  assert.deepEqual(
    sections.map((section) => [section.id, section.heading, section.sourceItemIds]),
    [
      [first.ids[0], "代码", ["i1"]],
      [second.ids[0], "后续", ["i2"]]
    ]
  );
  assert.ok(sections[0]!.markdown.includes("## inside"));
  const removed = removeSectionSource(second.body, "i2");
  assert.deepEqual(removed.removedSectionIds, [second.ids[0]]);
  assert.deepEqual(
    parseSections(removed.body).map((section) => section.id),
    [first.ids[0]]
  );
});

test("sections: fences only close with the same char and at least the opener length", () => {
  const body = "## A\n~~~\n```\n## not a\n~~\n## still not\n~~~~\n## B\n````\n```\n## not b\n````\n## C";
  assert.deepEqual(
    parseSections(body).map((section) => section.heading),
    ["A", "B", "C"]
  );
});

test("sections: headings are sanitized so they cannot forge markers", () => {
  const { body, ids } = appendSections("", [{ heading: "Foo\n<!-- section:s_victim src:x -->", markdown: "正文", sourceItemIds: ["i1"] }]);
  const sections = parseSections(body);
  assert.deepEqual(
    sections.map((section) => [section.id, section.sourceItemIds]),
    [[ids[0], ["i1"]]]
  );
  assert.ok(!body.includes("s_victim -->"));
  assert.equal(sanitizeHeading("  a\n\tb <<!--!-- c --> "), "a b c");
  assert.equal(sanitizeHeading("x".repeat(200)).length, 120);
});

test("sections: closing hashes need leading whitespace, so `## C#` round-trips", () => {
  const { body } = appendSections("", [{ heading: "C#", markdown: "x", sourceItemIds: ["i1"] }]);
  const once = parseSections(body);
  assert.equal(once[0]!.heading, "C#");
  assert.equal(parseSections(serializeSections(once))[0]!.heading, "C#");
  assert.equal(parseSections("## Title ##")[0]!.heading, "Title");
});

test("demoteHeadings shifts the shallowest heading to level 3", () => {
  assert.equal(demoteHeadings("# A\n## B\ntext"), "### A\n#### B\ntext");
  assert.equal(demoteHeadings("### A"), "### A");
});
