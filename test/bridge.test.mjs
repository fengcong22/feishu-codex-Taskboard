import assert from "node:assert/strict";
import test from "node:test";

import { createBridge } from "../src/bridge.mjs";

const config = {
  tables: [{
    tableId: "tbl_a",
    name: "语文项目",
    mode: "manual",
    triggerField: "视频整体进度",
    triggerValue: "待剪辑",
    packageField: "自动剪辑项目包",
  }],
  packages: {
    "Auto-cut-copyA": {
      projectId: "auto-cut-copy-a",
      projectName: "Auto-cut-copyA",
      workspacePath: "D:\\trusted\\Auto-cut-copyA",
      prompt: "执行 A 流程。",
    },
  },
};

const event = {
  eventId: "evt_1",
  baseToken: "bas_demo",
  tableId: "tbl_a",
  recordId: "rec_1",
  recordTitle: "第一课",
  fieldName: "视频整体进度",
  beforeValue: "素材齐全",
  afterValue: "待剪辑",
  fields: { 自动剪辑项目包: "Auto-cut-copyA" },
};

function memoryStore() {
  const entries = new Map();
  return {
    get: async (key) => entries.get(key) ?? null,
    put: async (key, value) => { if (!entries.has(key)) entries.set(key, value); },
    replace: async (key, value) => { entries.set(key, value); },
  };
}

test("creates one ready task and replays its persisted outcome", async () => {
  const calls = [];
  const bridge = createBridge({
    config,
    store: memoryStore(),
    taskboard: {
      ensureProject: async (project) => calls.push(["project", project]),
      createTask: async (payload) => {
        calls.push(["task", payload]);
        return { id: "task_1", identifier: "AUTO-1" };
      },
    },
  });
  const first = await bridge.handle(event);
  const replay = await bridge.handle(event);
  assert.equal(first.kind, "ready");
  assert.equal(first.taskIdentifier, "AUTO-1");
  assert.deepEqual(replay, { ...first, duplicate: true });
  assert.equal(calls.filter(([kind]) => kind === "task").length, 1);
});

test("uses an injected current-record title before building the task", async () => {
  let payload;
  const bridge = createBridge({
    config: {
      ...config,
      tables: [{
        ...config.tables[0],
        titleField: "视频名称",
        titleFieldId: "fld_title",
        fallbackTitleField: "集合文档",
        fallbackTitleFieldId: "fld_collection",
      }],
    },
    store: memoryStore(),
    resolveRecordTitle: async () => "从当前记录读取的标题",
    taskboard: {
      ensureProject: async () => {},
      createTask: async (value) => {
        payload = value;
        return { id: "task_title", identifier: "AUTO-TITLE" };
      },
    },
  });
  await bridge.handle({ ...event, recordTitle: "" });
  assert.equal(payload.title, "[待剪辑] 从当前记录读取的标题");
});

test("falls back to the record id when current-record title lookup fails", async () => {
  let payload;
  const warnings = [];
  const bridge = createBridge({
    config,
    store: memoryStore(),
    resolveRecordTitle: async () => { throw new Error("lookup unavailable"); },
    logger: { warn: (message) => warnings.push(message) },
    taskboard: {
      ensureProject: async () => {},
      createTask: async (value) => {
        payload = value;
        return { id: "task_fallback", identifier: "AUTO-FALLBACK" };
      },
    },
  });
  await bridge.handle({ ...event, eventId: "evt_lookup_failure", recordTitle: "" });
  assert.equal(payload.title, "[待剪辑] rec_1");
  assert.match(warnings[0], /rec_1.*lookup unavailable/);
});

test("times out a title resolver that never settles and still creates the task", async () => {
  let payload;
  const warnings = [];
  const bridge = createBridge({
    config,
    store: memoryStore(),
    resolveRecordTitle: async () => new Promise(() => {}),
    titleLookupTimeoutMs: 10,
    logger: { warn: (message) => warnings.push(message) },
    taskboard: {
      ensureProject: async () => {},
      createTask: async (value) => {
        payload = value;
        return { id: "task_timeout", identifier: "AUTO-TIMEOUT" };
      },
    },
  });
  const outcome = await bridge.handle({ ...event, eventId: "evt_lookup_timeout", recordTitle: "" });
  assert.equal(outcome.taskIdentifier, "AUTO-TIMEOUT");
  assert.equal(payload.title, "[待剪辑] rec_1");
  assert.match(warnings[0], /timed out/);
});

test("persists ignored events without calling Taskboard", async () => {
  const bridge = createBridge({
    config,
    store: memoryStore(),
    taskboard: { ensureProject: assert.fail, createTask: assert.fail },
  });
  assert.deepEqual(await bridge.handle({ ...event, afterValue: "剪辑中" }), {
    kind: "ignored",
    reason: "new_value_not_trigger",
  });
});

test("creates a blocked task in the local project", async () => {
  let payload;
  const bridge = createBridge({
    config,
    store: memoryStore(),
    taskboard: {
      ensureProject: async () => assert.fail("blocked tasks do not create package projects"),
      createTask: async (value) => {
        payload = value;
        return { id: "blocked_1", identifier: "LOCAL-1" };
      },
    },
  });
  const result = await bridge.handle({ ...event, fields: {} });
  assert.equal(result.kind, "blocked");
  assert.equal(payload.projectId, "local");
  assert.equal(payload.status, "blocked");
});

test("leaves a pending marker when Taskboard is unavailable", async () => {
  const store = memoryStore();
  const bridge = createBridge({
    config,
    store,
    taskboard: {
      ensureProject: async () => { throw new Error("offline"); },
      createTask: assert.fail,
    },
  });
  await assert.rejects(() => bridge.handle(event), /offline/);
  assert.deepEqual(await store.get(event.eventId), { kind: "pending" });
});

test("reuses an existing Taskboard task while completing a pending event", async () => {
  const store = memoryStore();
  let created = 0;
  const bridge = createBridge({
    config,
    store,
    taskboard: {
      ensureProject: async () => {},
      findTaskByEventId: async () => ({ id: "task_existing", identifier: "AUTO-7" }),
      createTask: async () => { created += 1; return { id: "task_new", identifier: "AUTO-8" }; },
    },
  });
  await store.put(event.eventId, { kind: "pending" });
  const result = await bridge.handle(event);
  assert.equal(result.taskIdentifier, "AUTO-7");
  assert.equal(created, 0);
  assert.equal((await store.get(event.eventId)).kind, "ready");
});
