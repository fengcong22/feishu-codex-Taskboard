import assert from "node:assert/strict";
import test from "node:test";

import {
  matchesWaitingFeishuTask,
  selectWaitingFeishuTasks,
} from "../src/task-lifecycle.mjs";

const event = {
  eventId: "evt_leave_1",
  baseToken: "bas_demo",
  tableId: "tbl_a",
  recordId: "rec_1",
};

const table = {
  triggerField: "视频整体进度",
  triggerFieldId: "fld_progress",
  triggerValue: "待剪辑",
};

function marker(metadata) {
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->`;
}

function task(overrides = {}, metadata = {
  source: "feishu-base",
  eventId: "evt_ready_1",
  baseToken: "bas_demo",
  tableId: "tbl_a",
  recordId: "rec_1",
  triggerField: "视频整体进度",
  triggerFieldId: "fld_progress",
  triggerValue: "待剪辑",
}) {
  return {
    id: "task_1",
    identifier: "AUTO-1",
    version: 4,
    status: "todo",
    archivedAt: null,
    description: marker(metadata),
    ...overrides,
  };
}

test("matches an active todo task for the same Feishu trigger flow", () => {
  assert.equal(matchesWaitingFeishuTask(task(), { event, table }), true);
});

test("selects only matching unarchived todo tasks", () => {
  const tasks = [
    task({ id: "todo-match" }),
    task({ id: "in-progress", status: "in_progress" }),
    task({ id: "review", status: "in_review" }),
    task({ id: "done", status: "done" }),
    task({ id: "archived", archivedAt: "2026-08-20T00:00:00.000Z" }),
    task({ id: "other-record" }, { ...JSON.parse(Buffer.from(task().description.match(/v1:([^ ]+)/)[1], "base64url").toString("utf8")), recordId: "rec_other" }),
  ];
  assert.deepEqual(selectWaitingFeishuTasks(tasks, { event, table }).map(({ id }) => id), ["todo-match"]);
});

test("does not match title-only lookalikes or malformed metadata", () => {
  assert.equal(matchesWaitingFeishuTask(
    task({ title: "[待剪辑] 第一课", description: "待剪辑" }),
    { event, table },
  ), false);
  assert.equal(matchesWaitingFeishuTask(
    task({ description: marker({ source: "feishu-base", eventId: "evt_leave_1" }) }),
    { event, table },
  ), false);
});

test("uses trigger field name for old metadata without a field id", () => {
  const oldMetadata = {
    source: "feishu-base",
    eventId: "evt_old",
    baseToken: "bas_demo",
    tableId: "tbl_a",
    recordId: "rec_1",
    triggerField: "视频整体进度",
    triggerValue: "待剪辑",
  };
  assert.equal(matchesWaitingFeishuTask(task({ description: marker(oldMetadata) }), { event, table }), true);
});

test("prefers configured field ids when both sides provide them", () => {
  const metadata = {
    source: "feishu-base",
    eventId: "evt_other_field",
    baseToken: "bas_demo",
    tableId: "tbl_a",
    recordId: "rec_1",
    triggerField: "视频整体进度",
    triggerFieldId: "fld_other",
    triggerValue: "待剪辑",
  };
  assert.equal(matchesWaitingFeishuTask(task({ description: marker(metadata) }), { event, table }), false);
});

test("fails closed when the Base token is absent", () => {
  assert.equal(matchesWaitingFeishuTask(
    task({ description: marker({
      source: "feishu-base",
      eventId: "evt_missing_base",
      tableId: "tbl_a",
      recordId: "rec_1",
      triggerField: "视频整体进度",
      triggerValue: "待剪辑",
      baseToken: "",
    }) }),
    { event, table },
  ), false);
  assert.equal(matchesWaitingFeishuTask(
    task({ description: marker({
      source: "feishu-base",
      eventId: "evt_missing_base_both",
      tableId: "tbl_a",
      recordId: "rec_1",
      triggerField: "视频整体进度",
      triggerValue: "待剪辑",
    }) }),
    { event: { ...event, baseToken: undefined }, table },
  ), false);
});

test("archives only matching todo tasks and fences every Taskboard call", async () => {
  const listed = [
    task({ id: "task_waiting" }),
    task({ id: "task_running", status: "in_progress" }),
  ];
  const calls = [];
  let fences = 0;
  const taskboard = {
    async listTasks(options) { calls.push(["list", options]); return listed; },
    async getTask(id) { calls.push(["get", id]); return listed.find((candidate) => candidate.id === id); },
    async archiveTask(value) { calls.push(["archive", value.id, value.version]); return { ...value, archivedAt: "now" }; },
  };
  const result = await (await import("../src/task-lifecycle.mjs")).archiveWaitingFeishuTasks(
    taskboard,
    { event, table },
    { ensureActive: async () => { fences += 1; } },
  );
  assert.deepEqual(result, { archivedCount: 1 });
  assert.deepEqual(calls, [
    ["list", { archived: "false" }],
    ["get", "task_waiting"],
    ["archive", "task_waiting", 4],
  ]);
  assert.equal(fences, 6);
});

test("skips a task that enters execution after a version conflict", async () => {
  const candidate = task({ id: "task_racing" });
  let reads = 0;
  let archived = 0;
  const taskboard = {
    async listTasks() { return [candidate]; },
    async getTask() {
      reads += 1;
      return reads === 1 ? { ...candidate } : { ...candidate, version: 5, status: "in_progress" };
    },
    async archiveTask() {
      archived += 1;
      throw Object.assign(new Error("stale"), { code: "VERSION_CONFLICT", status: 409 });
    },
  };
  const result = await (await import("../src/task-lifecycle.mjs")).archiveWaitingFeishuTasks(
    taskboard,
    { event, table },
  );
  assert.deepEqual(result, { archivedCount: 0 });
  assert.equal(reads, 2);
  assert.equal(archived, 1);
});

test("retries a version conflict once when the reread is still todo", async () => {
  const candidate = task({ id: "task_retry_version" });
  let reads = 0;
  const archivedVersions = [];
  const taskboard = {
    async listTasks() { return [candidate]; },
    async getTask() {
      reads += 1;
      return { ...candidate, version: reads === 1 ? 4 : 5 };
    },
    async archiveTask(value) {
      archivedVersions.push(value.version);
      if (archivedVersions.length === 1) {
        throw Object.assign(new Error("stale"), { code: "VERSION_CONFLICT", status: 409 });
      }
      return { ...value, version: 6, archivedAt: "now" };
    },
  };
  const result = await (await import("../src/task-lifecycle.mjs")).archiveWaitingFeishuTasks(
    taskboard,
    { event, table },
  );
  assert.deepEqual(result, { archivedCount: 1 });
  assert.deepEqual(archivedVersions, [4, 5]);
  assert.equal(reads, 2);
});

test("treats a missing candidate as already absent and rethrows unrelated errors", async () => {
  const missing = task({ id: "task_missing" });
  const taskboard = {
    async listTasks() { return [missing]; },
    async getTask() { throw Object.assign(new Error("gone"), { code: "TASK_NOT_FOUND", status: 404 }); },
    archiveTask: assert.fail,
  };
  assert.deepEqual(
    await (await import("../src/task-lifecycle.mjs")).archiveWaitingFeishuTasks(taskboard, { event, table }),
    { archivedCount: 0 },
  );

  const failure = Object.assign(new Error("offline"), { code: "TASKBOARD_UNAVAILABLE" });
  await assert.rejects(
    () => (async () => {
      const failing = {
        async listTasks() { return [missing]; },
        async getTask() { throw failure; },
      };
      return (await import("../src/task-lifecycle.mjs")).archiveWaitingFeishuTasks(failing, { event, table });
    })(),
    (error) => error === failure,
  );
});

test("treats an archive-time TASK_NOT_FOUND as an already absent task", async () => {
  const candidate = task({ id: "task_removed_while_archiving" });
  const taskboard = {
    async listTasks() { return [candidate]; },
    async getTask() { return candidate; },
    async archiveTask() {
      throw Object.assign(new Error("gone"), { code: "TASK_NOT_FOUND", status: 404 });
    },
  };
  assert.deepEqual(
    await (await import("../src/task-lifecycle.mjs")).archiveWaitingFeishuTasks(taskboard, { event, table }),
    { archivedCount: 0 },
  );
});

test("uses HTTP status fallbacks when Taskboard omits a structured error code", async () => {
  const missing = task({ id: "task_http_missing" });
  const missingBoard = {
    async listTasks() { return [missing]; },
    async getTask() { throw Object.assign(new Error("gone"), { status: 404 }); },
    archiveTask: assert.fail,
  };
  assert.deepEqual(
    await (await import("../src/task-lifecycle.mjs")).archiveWaitingFeishuTasks(missingBoard, { event, table }),
    { archivedCount: 0 },
  );

  const racing = task({ id: "task_http_conflict" });
  let reads = 0;
  let archived = 0;
  const conflictBoard = {
    async listTasks() { return [racing]; },
    async getTask() {
      reads += 1;
      return reads === 1 ? racing : { ...racing, status: "in_progress", version: 2 };
    },
    async archiveTask() {
      archived += 1;
      throw Object.assign(new Error("stale"), { status: 409 });
    },
  };
  assert.deepEqual(
    await (await import("../src/task-lifecycle.mjs")).archiveWaitingFeishuTasks(conflictBoard, { event, table }),
    { archivedCount: 0 },
  );
  assert.equal(reads, 2);
  assert.equal(archived, 1);
});
