import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySqlite } from "./sqlite";

test("node:sqlite supports WAL, FTS5 (unicode61 + trigram) and sqlite-vec", () => {
  for (const result of verifySqlite()) assert.ok(result.ok, `${result.name}: ${result.detail}`);
});
