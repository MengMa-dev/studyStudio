import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  HOME_API,
  homeSummaryResponseSchema,
  NOTES_API,
  notesListResponseSchema,
  noteSchema,
  overviewResponseSchema,
  TIMELINE_API,
  timelineResponseSchema
} from "@study-studio/shared";
import { getOverview, getTimeline } from "../../src/domains/timeline/timeline.js";
import { getHomeSummary } from "../../src/domains/home/home.js";
import { localDay } from "../../src/domains/timeline/time.js";
import { localAt, setup } from "./helpers.js";

test("notes CRUD for all three scopes", async (t) => {
  const { call, db, page } = await setup(t);
  const itemId = page("https://docs.example.com/a", "A", "2026-10-01T02:00:00.000Z");
  db.prepare("INSERT INTO kb_entries(id, name) VALUES ('e1', '重排')").run();

  const fuzzy = noteSchema.parse((await call("POST", NOTES_API.create, { scope: "fuzzy", targetId: "ignored", text: " 想搞清楚重排 " })).body);
  assert.deepEqual([fuzzy.scope, fuzzy.targetId, fuzzy.text, fuzzy.origin, fuzzy.usedAt], ["fuzzy", null, "想搞清楚重排", "workbench", null]);
  const onItem = noteSchema.parse((await call("POST", NOTES_API.create, { scope: "item", targetId: itemId, text: "看第二节" })).body);
  const onEntry = noteSchema.parse((await call("POST", NOTES_API.create, { scope: "entry", targetId: "e1", text: "补充例子", origin: "derived" })).body);
  assert.equal(onEntry.origin, "derived");

  assert.equal((await call("POST", NOTES_API.create, { scope: "item", targetId: "missing", text: "x" })).status, 422);
  assert.equal((await call("POST", NOTES_API.create, { scope: "entry", text: "x" })).status, 422);
  assert.equal((await call("POST", NOTES_API.create, { scope: "fuzzy", text: "" })).status, 422);

  const all = notesListResponseSchema.parse((await call("GET", NOTES_API.list)).body);
  assert.equal(all.notes.length, 3);
  const forItem = notesListResponseSchema.parse((await call("GET", `${NOTES_API.list}?scope=item&targetId=${itemId}`)).body);
  assert.deepEqual(
    forItem.notes.map((note) => note.id),
    [onItem.id]
  );

  db.prepare("UPDATE items SET organize_status = 'ingested', dirty = 0 WHERE id = ?").run(itemId);
  db.prepare("UPDATE notes SET used_at = '2026-10-01T03:00:00.000Z' WHERE id = ?").run(onItem.id);
  const edited = noteSchema.parse((await call("PATCH", NOTES_API.patch(onItem.id), { text: "看第三节" })).body);
  assert.equal(edited.text, "看第三节");
  assert.equal(edited.usedAt, null, "editing a used note clears used_at");
  assert.ok(edited.updatedAt);
  assert.equal(db.prepare("SELECT dirty FROM items WHERE id = ?").get(itemId)!.dirty, 1, "notes on organized items leave them dirty");
  assert.equal((await call("PATCH", NOTES_API.patch("missing"), { text: "x" })).status, 404);

  const removed = await call("DELETE", NOTES_API.delete(fuzzy.id));
  assert.deepEqual(z.object({ ok: z.literal(true) }).parse(removed.body), { ok: true });
  assert.equal((await call("DELETE", NOTES_API.delete(fuzzy.id))).status, 404);
  assert.equal(notesListResponseSchema.parse((await call("GET", `${NOTES_API.list}?scope=fuzzy`)).body).notes.length, 0);
});

test("timeline aggregates per day; overview and home statistics", async (t) => {
  const { call, db, page, read, qa, note } = await setup(t);
  const now = new Date();
  now.setHours(15, 0, 0, 0);

  // Today: page read twice (5 + 3 min), a QA of 2 min, a fuzzy note and an item note.
  const today1 = page("https://zhihu.example.com/q/1", "交叉编码器", localAt(now, 0, 9), "s1");
  read("https://zhihu.example.com/q/1", localAt(now, 0, 9, 5), 300, "s1");
  read("https://zhihu.example.com/q/1", localAt(now, 0, 11, 3), 180, "s2");
  const qaId = qa(localAt(now, 0, 10), localAt(now, 0, 10, 2), "什么是重排？");
  const fuzzyId = note("重排要和召回分开理解", localAt(now, 0, 12));
  note("这一段讲 cross-encoder", localAt(now, 0, 12, 30), "https://zhihu.example.com/q/1");
  // Yesterday: 10 minutes on MDN; an overlong QA capped at 10 minutes.
  page("https://developer.example.net/io", "IntersectionObserver", localAt(now, 1, 9), "s3");
  read("https://developer.example.net/io", localAt(now, 1, 9, 10), 600, "s3");
  qa(localAt(now, 1, 20), localAt(now, 1, 21), "向量召回和重排的区别", "https://chatgpt.com/c/1");
  // Three days ago: a gap day before it breaks the streak.
  page("https://old.example.com/x", "Old", localAt(now, 3, 9), "s4");
  read("https://old.example.com/x", localAt(now, 3, 9, 2), 120, "s4");
  db.prepare("INSERT INTO kb_entries(id, name, mastery) VALUES ('w1', '弱', 0.1), ('s1', '强', 0.9), ('n1', '未知', NULL)").run();

  const timeline = getTimeline(db, {}, now);
  assert.equal(timeline.days.length, 3);
  const [day0, day1, day3] = timeline.days;
  assert.match(day0!.label, /^今天 · /);
  assert.match(day1!.label, /^昨天 · /);
  assert.equal(day0!.minutes, 10, "8 min reading + 2 min QA");
  assert.equal(day1!.minutes, 20, "10 min reading + QA capped at 10 min");
  assert.equal(day3!.minutes, 2);

  const pageRow = day0!.rows.find((row) => row.itemId === today1)!;
  assert.equal(pageRow.type, "webpage");
  assert.equal(pageRow.durationSeconds, 480);
  assert.deepEqual(pageRow.tags, ["已收集", "阅读 2 次"]);
  assert.equal(pageRow.startedAt, localAt(now, 0, 9));
  const qaRow = day0!.rows.find((row) => row.itemId === qaId)!;
  assert.deepEqual(
    [qaRow.type, qaRow.title, qaRow.site, qaRow.durationSeconds, qaRow.startedAt],
    ["conversation", "DeepSeek · 什么是重排？", "DeepSeek", 120, localAt(now, 0, 10)]
  );
  const fuzzyRow = day0!.rows.find((row) => row.type === "fuzzy")!;
  assert.equal(fuzzyRow.noteId, fuzzyId);
  assert.equal(day0!.rows.length, 3, "item-bound notes stay off the timeline");
  assert.deepEqual(
    day0!.rows.map((row) => row.startedAt),
    [...day0!.rows.map((row) => row.startedAt)].sort().reverse()
  );

  const onlyFuzzy = getTimeline(db, { types: "fuzzy" }, now);
  assert.deepEqual(
    onlyFuzzy.days.map((day) => [day.rows.length, day.minutes]),
    [[1, 10]]
  );
  const yesterday = localDay(localAt(now, 1, 12));
  const narrowed = getTimeline(db, { from: yesterday, to: yesterday }, now);
  assert.deepEqual(
    narrowed.days.map((day) => [day.day, day.rows.length]),
    [[yesterday, 2]]
  );

  const overview = getOverview(db, {}, now);
  assert.deepEqual(overview.today, { minutes: 10, pages: 1, qa: 1, notes: 2, streak: 2 });
  assert.equal(overview.week.length, 7);
  assert.equal(overview.week[6]!.day, "今天");
  assert.deepEqual(
    overview.week.slice(-2).map((day) => day.minutes),
    [20, 10]
  );
  assert.deepEqual(overview.sources, [
    { name: "ChatGPT", minutes: 10 },
    { name: "developer.example.net", minutes: 10 },
    { name: "zhihu.example.com", minutes: 8 },
    { name: "DeepSeek", minutes: 2 },
    { name: "old.example.com", minutes: 2 }
  ]);
  assert.deepEqual(overview.pending, { unread: 5, pendingOrganize: 5, weakEntries: 1 });

  const home = getHomeSummary(db, now);
  assert.equal(home.greetingPeriod, "afternoon");
  assert.equal(home.knowledgeEntryCount, 3);
  assert.deepEqual(home.today, overview.today);

  timelineResponseSchema.parse((await call("GET", `${TIMELINE_API.timeline}?types=webpage,conversation`)).body);
  overviewResponseSchema.parse((await call("GET", `${TIMELINE_API.overview}?from=2026-09-01&to=2026-09-30`)).body);
  homeSummaryResponseSchema.parse((await call("GET", HOME_API.summary)).body);
});
