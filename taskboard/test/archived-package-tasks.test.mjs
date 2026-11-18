import assert from "node:assert/strict";
import { test } from "node:test";

import { archivedPackageTasks } from "../web/src/archivedPackageTasks.mjs";

const SUBJECT = "bas_board:tbl_chemistry";
const SCOPE = { subjectKey: SUBJECT, packageAlias: "vm-a" };

function task({
  id, archivedAt = "2026-11-18T00:00:00.000Z", subjectKey = SUBJECT, packageAlias = "vm-a",
  source = "feishu-base", title = id, status = "todo", externalKey,
} = {}) {
  return {
    id, title, status, archivedAt, externalKey: externalKey ?? null,
    feishuOrigin: { source, subjectKey, packageAlias },
  };
}

test("only tasks archived under the same subject and package are offered for restore", () => {
  const result = archivedPackageTasks([
    task({ id: "mine" }),
    task({ id: "other-subject", subjectKey: "bas_board:tbl_physics" }),
    task({ id: "other-package", packageAlias: "vm-b" }),
    task({ id: "simulated", source: "feishu-base-but-not" }),
  ], SCOPE);
  assert.deepEqual(result.visible.map(item => item.id), ["mine"]);
  assert.equal(result.total, 1);
});

test("live tasks are never listed: they are already on the board", () => {
  const result = archivedPackageTasks([
    task({ id: "live", archivedAt: null }),
    task({ id: "archived" }),
  ], SCOPE);
  assert.deepEqual(result.visible.map(item => item.id), ["archived"]);
});

test("ordinary tasks without a trusted origin are excluded", () => {
  const result = archivedPackageTasks([
    { id: "ordinary", archivedAt: "2026-11-18T00:00:00.000Z" },
    { id: "no-origin", archivedAt: "2026-11-18T00:00:00.000Z", feishuOrigin: null },
  ], SCOPE);
  assert.deepEqual(result.visible, []);
  assert.equal(result.total, 0);
});

test("newest archived comes first, so an accidental archive is on top", () => {
  const result = archivedPackageTasks([
    task({ id: "older", archivedAt: "2026-11-01T00:00:00.000Z" }),
    task({ id: "newest", archivedAt: "2026-11-18T00:00:00.000Z" }),
    task({ id: "middle", archivedAt: "2026-11-10T00:00:00.000Z" }),
  ], SCOPE);
  assert.deepEqual(result.visible.map(item => item.id), ["newest", "middle", "older"]);
});

test("search and filters narrow the list but the total still reports the rest", () => {
  const tasks = [
    task({ id: "lecture-a", title: "第一讲 剪辑" }),
    task({ id: "lecture-b", title: "第二讲 剪辑" }),
    task({ id: "lab", title: "实验课 剪辑" }),
  ];
  const searched = archivedPackageTasks(tasks, SCOPE, {
    search: "实验",
    matchSearch: (item, query) => item.title.includes(query),
  });
  assert.deepEqual(searched.visible.map(item => item.id), ["lab"]);
  assert.equal(searched.total, 1);

  const filtered = archivedPackageTasks(tasks, SCOPE, {
    filters: { statuses: ["done"] },
    matchFilters: (item, value) => value.statuses.includes(item.status),
  });
  assert.deepEqual(filtered.visible, []);
  assert.equal(filtered.total, 0);
});

test("the visible list is capped while the total keeps counting", () => {
  const tasks = Array.from({ length: 56 }, (_, index) => task({
    id: `t${String(index).padStart(3, "0")}`,
    archivedAt: new Date(Date.UTC(2026, 10, 18, 0, index)).toISOString(),
  }));
  const result = archivedPackageTasks(tasks, SCOPE, { limit: 50 });
  assert.equal(result.visible.length, 50);
  assert.equal(result.total, 56);
  assert.equal(result.visible[0].id, "t055", "the newest stays at the top of the capped list");
});

test("an incomplete scope never widens into another project's history", () => {
  const tasks = [task({ id: "any" })];
  assert.deepEqual(archivedPackageTasks(tasks, { subjectKey: "", packageAlias: "vm-a" }).visible, []);
  assert.deepEqual(archivedPackageTasks(tasks, { subjectKey: SUBJECT, packageAlias: "" }).visible, []);
  assert.deepEqual(archivedPackageTasks([], SCOPE).visible, []);
  assert.deepEqual(archivedPackageTasks(null, SCOPE).visible, []);
});
