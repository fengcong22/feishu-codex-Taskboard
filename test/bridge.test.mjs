import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createBridge } from "../src/bridge.mjs";
import { JsonStateStore } from "../src/state-store.mjs";

const config = {
  // Legacy generic task creation is enabled only for these historical unit
  // fixtures.  Production config is normalized by validateConfig(), which
  // drops this test-only escape hatch and therefore fails closed.
  allowLegacyTaskCreation: true,
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

const policy = {
  maxAttempts: 2,
  initialDelayMs: 5,
  maxDelayMs: 5,
  leaseMs: 10,
  pollIntervalMs: 100,
};

const unavailable = () => Object.assign(new Error("offline"), {
  code: "TASKBOARD_UNAVAILABLE",
  status: 0,
});

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

const retryEvent = { ...event, eventId: "evt_retry" };

function metadataMarker(overrides = {}) {
  const metadata = {
    source: "feishu-base",
    eventId: "evt_ready",
    baseToken: "bas_demo",
    tableId: "tbl_a",
    recordId: "rec_1",
    triggerField: "视频整体进度",
    triggerValue: "待剪辑",
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->`;
}

function lifecycleTask(id, overrides = {}) {
  return {
    id,
    identifier: id.toUpperCase(),
    version: 1,
    status: "todo",
    archivedAt: null,
    description: metadataMarker(),
    ...overrides,
  };
}

async function stateFilename() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-bridge-durable-"));
  return path.join(directory, "state.json");
}

function memoryStore() {
  const entries = new Map();
  const clone = (value) => value === undefined ? value : structuredClone(value);
  const tokenMatches = (record, token) => typeof token === "string" && token === record.lease?.token;
  const newRecord = (value, now) => ({
    schemaVersion: 2,
    eventId: value.eventId,
    event: clone(value),
    deliveryState: "pending",
    decision: null,
    attempts: 0,
    nextAttemptAt: null,
    lease: null,
    lastError: null,
    failureHistory: [],
    outcome: null,
    createdAt: now,
    updatedAt: now,
  });
  const normalize = (eventId, value, now, event) => {
    if (value?.schemaVersion === 2) return value;
    if (value?.kind === "pending") return event ? newRecord(event, now) : {
      schemaVersion: 2,
      eventId,
      event: null,
      deliveryState: "dead_letter",
      decision: null,
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: { code: "LEGACY_EVENT_SNAPSHOT_MISSING", status: 0, at: now },
      failureHistory: [],
      outcome: null,
      createdAt: now,
      updatedAt: now,
    };
    return {
      schemaVersion: 2,
      eventId,
      event: null,
      deliveryState: "succeeded",
      decision: value?.kind ?? null,
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: clone(value),
      createdAt: now,
      updatedAt: now,
    };
  };
  const claim = (record, ownerId, now, leaseMs) => {
    if (["succeeded", "dead_letter"].includes(record.deliveryState)) {
      return { kind: "terminal", record: clone(record) };
    }
    if (record.deliveryState === "processing" && record.lease?.leaseUntil > now) {
      return { kind: "deferred", record: clone(record) };
    }
    if (record.deliveryState === "retry_wait" && record.nextAttemptAt > now) {
      return { kind: "deferred", record: clone(record) };
    }
    record.deliveryState = "processing";
    record.attempts += 1;
    record.nextAttemptAt = null;
    record.lease = { ownerId, token: randomUUID(), leaseUntil: now + leaseMs };
    record.updatedAt = now;
    return { kind: "claimed", record: clone(record) };
  };
  return {
    get: async (key) => clone(entries.get(key) ?? null),
    put: async (key, value) => { if (!entries.has(key)) entries.set(key, clone(value)); },
    replace: async (key, value) => { entries.set(key, clone(value)); },
    claimEvent: async (value, { ownerId, now, leaseMs }) => {
      let record = entries.get(value.eventId);
      if (!record) record = newRecord(value, now);
      else {
        record = normalize(value.eventId, record, now, value);
        if (record.deliveryState === "dead_letter"
          && record.lastError?.code === "LEGACY_EVENT_SNAPSHOT_MISSING") {
          record = newRecord(value, now);
        }
      }
      entries.set(value.eventId, record);
      return claim(record, ownerId, now, leaseMs);
    },
    claimNextDue: async ({ ownerId, now, leaseMs, excludeEventIds }) => {
      const due = [...entries.values()]
        .map((value) => normalize(value.eventId, value, now))
        .filter((value) => (value.deliveryState === "pending"
          || value.deliveryState === "retry_wait")
          && value.event !== null
          && !(excludeEventIds instanceof Set && excludeEventIds.has(value.eventId))
          && (value.nextAttemptAt === null || value.nextAttemptAt <= now))
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!due) return null;
      entries.set(due.eventId, due);
      return claim(due, ownerId, now, leaseMs).record;
    },
    complete: async (eventId, { ownerId, token, decision, outcome, now }) => {
      const record = entries.get(eventId);
      if (!record || record.deliveryState !== "processing"
        || record.lease?.ownerId !== ownerId
        || record.lease.leaseUntil <= now
        || !tokenMatches(record, token)) {
        throw new Error(`lease is not owned by ${ownerId}`);
      }
      record.deliveryState = "succeeded";
      record.decision = decision;
      record.outcome = clone(outcome);
      record.nextAttemptAt = null;
      record.lease = null;
      record.updatedAt = now;
      return clone(record);
    },
    fail: async (eventId, { ownerId, token, error, nextAttemptAt, deadLetter, now }) => {
      const record = entries.get(eventId);
      if (!record || record.deliveryState !== "processing"
        || record.lease?.ownerId !== ownerId
        || record.lease.leaseUntil <= now
        || !tokenMatches(record, token)) {
        throw new Error(`lease is not owned by ${ownerId}`);
      }
      const summary = { code: error.code, status: error.status ?? 0, at: error.at ?? now };
      record.lastError = summary;
      record.failureHistory.push(summary);
      record.deliveryState = deadLetter ? "dead_letter" : "retry_wait";
      record.nextAttemptAt = deadLetter ? null : nextAttemptAt;
      record.lease = null;
      record.updatedAt = now;
      return clone(record);
    },
    renewLease: async (eventId, { ownerId, token, now, leaseMs }) => {
      const record = entries.get(eventId);
      if (!record || record.deliveryState !== "processing"
        || record.lease?.ownerId !== ownerId
        || record.lease?.token !== token
        || record.lease.leaseUntil <= now) {
        throw new Error(`lease is not owned by ${ownerId}`);
      }
      record.lease.leaseUntil = now + leaseMs;
      record.updatedAt = now;
      return clone(record);
    },
    recoverExpiredLeases: async ({ now, excludeEventIds }) => {
      let count = 0;
      for (const record of entries.values()) {
        if (record.deliveryState === "processing"
          && !(excludeEventIds instanceof Set && excludeEventIds.has(record.eventId))
          && record.lease?.leaseUntil <= now) {
          record.deliveryState = "pending";
          record.lease = null;
          record.nextAttemptAt = null;
          record.updatedAt = now;
          count += 1;
        }
      }
      return count;
    },
    getQueueStats: async () => {
      const stats = { pending: 0, processing: 0, retryWait: 0, deadLetter: 0 };
      for (const record of entries.values()) {
        if (record.schemaVersion !== 2) continue;
        if (record.deliveryState === "pending") stats.pending += 1;
        if (record.deliveryState === "processing") stats.processing += 1;
        if (record.deliveryState === "retry_wait") stats.retryWait += 1;
        if (record.deliveryState === "dead_letter") stats.deadLetter += 1;
      }
      return stats;
    },
  };
}

function fakeIntervals() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setInterval(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    clearInterval(id) {
      callbacks.delete(id);
    },
    async fireAll() {
      for (const callback of callbacks.values()) await callback();
    },
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

test("uses an explicit package catalog when the Bridge config has no package definitions", async () => {
  const calls = [];
  const bridge = createBridge({
    config: { ...config, packages: undefined },
    packageCatalog: config.packages,
    store: memoryStore(),
    taskboard: {
      ensureProject: async (project) => calls.push(["project", project]),
      createTask: async (payload) => {
        calls.push(["task", payload]);
        return { id: "task_registry", identifier: "AUTO-REGISTRY" };
      },
    },
  });
  const result = await bridge.handle({ ...event, eventId: "evt_registry_catalog" });
  assert.equal(result.taskIdentifier, "AUTO-REGISTRY");
  assert.equal(calls.filter(([kind]) => kind === "task").length, 1);
});

test("reloads the trusted package catalog for each new event", async () => {
  let catalog = structuredClone(config.packages);
  const created = [];
  const bridge = createBridge({
    config: { ...config, packages: undefined },
    getPackageCatalog: async () => catalog,
    store: memoryStore(),
    taskboard: {
      ensureProject: async () => {},
      createTask: async (payload) => {
        created.push(payload);
        return { id: `task_${created.length}`, identifier: `AUTO-${created.length}` };
      },
    },
  });

  const first = await bridge.handle({ ...event, eventId: "evt_dynamic_catalog_enabled" });
  assert.equal(first.kind, "ready");
  assert.equal(created.length, 1);

  catalog = {};
  const disabled = await bridge.handle({ ...event, eventId: "evt_dynamic_catalog_disabled" });
  assert.equal(disabled.kind, "blocked");
  assert.equal(created.length, 2);
  assert.equal(created[1].status, "blocked");

  catalog = {
    "Auto-cut-小学语文": {
      projectId: "auto-cut-primary-school-chinese",
      projectName: "小学语文 Auto-Cut",
      workspacePath: "D:\\trusted\\Auto-cut-primary-school-chinese",
      prompt: "执行小学语文流程。",
    },
  };
  const enabled = await bridge.handle({
    ...event,
    eventId: "evt_dynamic_catalog_reenabled",
    fields: { 自动剪辑项目包: "Auto-cut-小学语文" },
  });
  assert.equal(enabled.kind, "ready");
  assert.equal(enabled.packageAlias, "Auto-cut-小学语文");
  assert.equal(created.length, 3);
});

test("uses the Taskboard Feishu provenance route when it is available", async () => {
  const calls = [];
  const bridge = createBridge({
    config,
    store: memoryStore(),
    taskboard: {
      ensureProject: async () => {},
      createTask: async () => {
        throw new Error("generic task route must not be used for Feishu events");
      },
      createFeishuTask: async (payload) => {
        calls.push(payload);
        return { id: "task_feishu", identifier: "AUTO-FEISHU" };
      },
    },
  });
  const result = await bridge.handle({ ...event, eventId: "evt_provenance" });
  assert.equal(result.taskIdentifier, "AUTO-FEISHU");
  assert.equal(calls.length, 1);
  assert.match(calls[0].description, /feishu-codex-task:v1:/);
});

test("fails closed when the dedicated Feishu provenance route is unavailable", async () => {
  const store = memoryStore();
  const bridge = createBridge({
    config: { ...config, allowLegacyTaskCreation: false, delivery: policy },
    store,
    taskboard: {
      ensureProject: async () => {},
      createTask: async () => ({ id: "task_generic", identifier: "AUTO-GENERIC" }),
    },
  });
  const result = await bridge.handle({ ...event, eventId: "evt_missing_provenance_route" });
  assert.equal(result.kind, "pending");
  assert.equal(result.deliveryState, "retry_wait");
  assert.equal((await store.get("evt_missing_provenance_route")).lastError.code,
    "TASKBOARD_PROVENANCE_ROUTE_UNAVAILABLE");
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
  const warning = JSON.parse(warnings[0]);
  assert.equal(warning.component, "bridge-delivery");
  assert.equal(warning.errorCode, "FEISHU_TITLE_LOOKUP_FAILED");
  assert.doesNotMatch(warnings[0], /rec_1|lookup unavailable/);
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
  assert.equal(JSON.parse(warnings[0]).errorCode, "FEISHU_TITLE_LOOKUP_TIMEOUT");
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

test("archives matching waiting tasks when a record leaves 待剪辑 and leaves execution tasks alone", async () => {
  const waiting = lifecycleTask("task_waiting");
  const running = lifecycleTask("task_running", { status: "in_progress" });
  const tasks = [waiting, running];
  const archived = [];
  let listed = 0;
  const bridge = createBridge({
    config,
    store: memoryStore(),
    taskboard: {
      async listTasks(options) {
        listed += 1;
        assert.deepEqual(options, { archived: "false" });
        return tasks.filter((task) => task.archivedAt === null);
      },
      async getTask(id) { return tasks.find((task) => task.id === id); },
      async archiveTask(task) {
        archived.push(task.id);
        task.archivedAt = "2026-08-20T00:00:00.000Z";
        return task;
      },
      createTask: assert.fail,
      ensureProject: assert.fail,
    },
  });
  const left = {
    ...event,
    eventId: "evt_left_trigger",
    beforeValue: "待剪辑",
    afterValue: "剪辑中",
    fields: {},
  };
  assert.deepEqual(await bridge.handle(left), {
    kind: "ignored",
    reason: "left_trigger",
  });
  assert.deepEqual(archived, ["task_waiting"]);
  assert.equal(running.archivedAt, null);
  assert.equal(listed, 1);
  assert.deepEqual(await bridge.handle(left), {
    kind: "ignored",
    reason: "left_trigger",
    duplicate: true,
  });
  assert.equal(listed, 1);
});

test("retries a temporary archive failure and completes the leave event", async () => {
  let now = 0;
  let available = false;
  let task = lifecycleTask("task_retry_archive");
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store: memoryStore(),
    now: () => now,
    random: () => 0.5,
    taskboard: {
      async listTasks() {
        if (!available) throw unavailable();
        return task.archivedAt === null ? [task] : [];
      },
      async getTask() { return task; },
      async archiveTask(value) {
        if (!available) throw unavailable();
        value.archivedAt = "now";
        return value;
      },
    },
  });
  const left = {
    ...event,
    eventId: "evt_archive_retry",
    beforeValue: "待剪辑",
    afterValue: "剪辑中",
    fields: {},
  };
  assert.deepEqual(await bridge.handle(left), {
    kind: "pending",
    deliveryState: "retry_wait",
    attempts: 1,
    retryAt: 5,
  });
  now = 5;
  available = true;
  assert.deepEqual(await bridge.processDue(), {
    kind: "ignored",
    reason: "left_trigger",
  });
  assert.equal(task.archivedAt, "now");
});

test("reuses the first archive subject when the table trigger is edited during retry", async () => {
  const filename = await stateFilename();
  let now = 0;
  let activeConfig = { ...config, delivery: policy };
  const task = lifecycleTask("task_frozen_archive");
  let available = false;
  const bridge = createBridge({
    config: activeConfig,
    getConfig: async () => activeConfig,
    store: new JsonStateStore(filename),
    now: () => now,
    random: () => 0.5,
    taskboard: {
      async listTasks() {
        if (!available) throw unavailable();
        return task.archivedAt === null ? [task] : [];
      },
      async getTask() { return task; },
      async archiveTask(value) {
        value.archivedAt = "frozen";
        return value;
      },
    },
  });
  const left = {
    ...event,
    eventId: "evt_frozen_archive",
    beforeValue: "待剪辑",
    afterValue: "剪辑中",
    fields: {},
  };
  assert.equal((await bridge.handle(left)).deliveryState, "retry_wait");
  const snapshot = (await (new JsonStateStore(filename)).get(left.eventId)).decisionSnapshot;
  assert.equal(snapshot.action, "archive");
  activeConfig = {
    ...activeConfig,
    tables: [{
      ...activeConfig.tables[0],
      name: "改名后的项目",
      triggerField: "其他字段",
      triggerValue: "新的开始值",
    }],
  };
  now = 5;
  available = true;
  assert.deepEqual(await bridge.processDue(), {
    kind: "ignored",
    reason: "left_trigger",
  });
  assert.equal(task.archivedAt, "frozen");
});

test("replays partial archival safely without touching already archived tasks", async () => {
  let now = 0;
  let failedOnce = false;
  const first = lifecycleTask("task_partial_1");
  const second = lifecycleTask("task_partial_2");
  const tasks = [first, second];
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store: memoryStore(),
    now: () => now,
    random: () => 0.5,
    taskboard: {
      async listTasks() { return tasks.filter((task) => task.archivedAt === null); },
      async getTask(id) { return tasks.find((task) => task.id === id); },
      async archiveTask(value) {
        if (value.id === second.id && !failedOnce) {
          failedOnce = true;
          throw unavailable();
        }
        value.archivedAt = "now";
        return value;
      },
    },
  });
  const left = {
    ...event,
    eventId: "evt_partial_archive",
    beforeValue: "待剪辑",
    afterValue: "剪辑中",
    fields: {},
  };
  assert.equal((await bridge.handle(left)).deliveryState, "retry_wait");
  assert.equal(first.archivedAt, "now");
  assert.equal(second.archivedAt, null);
  now = 5;
  assert.deepEqual(await bridge.processDue(), {
    kind: "ignored",
    reason: "left_trigger",
  });
  assert.equal(first.archivedAt, "now");
  assert.equal(second.archivedAt, "now");
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

test("creates blocked events through the dedicated Feishu provenance route", async () => {
  let payload;
  const bridge = createBridge({
    config: { ...config, allowLegacyTaskCreation: false },
    store: memoryStore(),
    taskboard: {
      ensureProject: async () => assert.fail("blocked tasks do not create a subject project"),
      createTask: async () => assert.fail("blocked events must not use the generic route"),
      createFeishuTask: async (value) => {
        payload = value;
        return { id: "blocked_feishu", identifier: "AUTO-BLOCKED" };
      },
    },
  });
  const result = await bridge.handle({ ...event, eventId: "evt_blocked_provenance", fields: {} });
  assert.equal(result.kind, "blocked");
  assert.equal(result.taskIdentifier, "AUTO-BLOCKED");
  assert.equal(payload.projectId, "local");
  assert.equal(payload.status, "blocked");
});

test("defers a temporary Taskboard failure then creates exactly one task when due", async () => {
  let now = 0;
  let available = false;
  const store = memoryStore();
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => now,
    random: () => 0.5,
    taskboard: {
      findTaskByEventId: async () => null,
      ensureProject: async () => { if (!available) throw unavailable(); },
      createTask: async () => ({ id: "task_1", identifier: "AUTO-1" }),
    },
  });
  assert.deepEqual(await bridge.handle(retryEvent), {
    kind: "pending",
    deliveryState: "retry_wait",
    attempts: 1,
    retryAt: 5,
  });
  assert.deepEqual(await bridge.getQueueStats(), {
    pending: 0,
    processing: 0,
    retryWait: 1,
    deadLetter: 0,
  });
  now = 5;
  available = true;
  assert.equal((await bridge.processDue()).taskIdentifier, "AUTO-1");
  assert.equal((await bridge.processDue()), null);
});

test("reuses the first create decision after a retry even when routing config changes", async () => {
  const filename = await stateFilename();
  let now = 0;
  let activeConfig = {
    ...config,
    delivery: policy,
    tables: [{ ...config.tables[0], configVersion: 7 }],
    packages: {
      ...config.packages,
      "Auto-cut-copyB": {
        projectId: "auto-cut-copy-b",
        projectName: "Auto-cut-copyB",
        workspacePath: "D:\\trusted\\Auto-cut-copyB",
        prompt: "执行 B 流程。",
      },
    },
  };
  const projects = [];
  const payloads = [];
  let firstAttempt = true;
  const bridge = createBridge({
    config: activeConfig,
    getConfig: async () => activeConfig,
    store: new JsonStateStore(filename),
    now: () => now,
    random: () => 0.5,
    taskboard: {
      findTaskByEventId: async () => null,
      ensureProject: async (project) => {
        projects.push(project);
        if (firstAttempt) {
          firstAttempt = false;
          throw unavailable();
        }
      },
      createTask: async (payload) => {
        payloads.push(payload);
        return { id: "task_frozen", identifier: "AUTO-FROZEN" };
      },
    },
  });

  assert.deepEqual(await bridge.handle({ ...event, eventId: "evt_frozen_create" }), {
    kind: "pending",
    deliveryState: "retry_wait",
    attempts: 1,
    retryAt: 5,
  });
  const firstSnapshot = (await (new JsonStateStore(filename)).get("evt_frozen_create")).decisionSnapshot;
  assert.equal(firstSnapshot.kind, "ready");
  assert.equal(firstSnapshot.packageAlias, "Auto-cut-copyA");

  activeConfig = {
    ...activeConfig,
    tables: [{
      ...activeConfig.tables[0],
      name: "改名后的项目",
      mode: "automatic",
      triggerValue: "改后的开始值",
      packageField: "另一个项目包字段",
      configVersion: 8,
    }],
  };
  now = 5;
  const result = await bridge.processDue();
  assert.equal(result.taskIdentifier, "AUTO-FROZEN");
  assert.equal(projects.length, 2);
  assert.equal(projects[0].workspacePath, "D:\\trusted\\Auto-cut-copyA");
  assert.equal(projects[1].workspacePath, "D:\\trusted\\Auto-cut-copyA");
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].description, /手动点击启动/);
  assert.match(payloads[0].description, /Auto-cut-copyA/);
});

for (const [label, mutatePackage] of [
  ["workspacePath", (packageConfig) => ({
    ...packageConfig,
    workspacePath: "D:\\trusted\\Auto-cut-copyA-replaced",
  })],
  ["prompt", (packageConfig) => ({
    ...packageConfig,
    prompt: "执行被替换的流程。",
  })],
]) {
  test(`dead-letters a retry when the aliased package ${label} changes`, async () => {
    const filename = await stateFilename();
    let now = 0;
    let activeConfig = { ...config, delivery: policy };
    let ensureProjectCalls = 0;
    let createTaskCalls = 0;
    const bridge = createBridge({
      config: activeConfig,
      getConfig: async () => activeConfig,
      store: new JsonStateStore(filename),
      now: () => now,
      random: () => 0.5,
      taskboard: {
        findTaskByEventId: async () => null,
        ensureProject: async () => {
          ensureProjectCalls += 1;
          throw unavailable();
        },
        createTask: async () => {
          createTaskCalls += 1;
          return { id: "unexpected", identifier: "UNEXPECTED" };
        },
      },
    });

    const eventId = `evt_package_${label}_changed`;
    assert.deepEqual(await bridge.handle({ ...event, eventId }), {
      kind: "pending",
      deliveryState: "retry_wait",
      attempts: 1,
      retryAt: 5,
    });

    const originalPackage = activeConfig.packages["Auto-cut-copyA"];
    activeConfig = {
      ...activeConfig,
      packages: {
        ...activeConfig.packages,
        "Auto-cut-copyA": mutatePackage(originalPackage),
      },
    };
    now = 5;

    assert.deepEqual(await bridge.processDue(), {
      kind: "dead_letter",
      deliveryState: "dead_letter",
      attempts: 2,
      errorCode: "DECISION_SNAPSHOT_PACKAGE_UNAVAILABLE",
    });
    const stored = await (new JsonStateStore(filename)).get(eventId);
    assert.equal(stored.deliveryState, "dead_letter");
    assert.equal(stored.lastError.code, "DECISION_SNAPSHOT_PACKAGE_UNAVAILABLE");
    assert.equal(ensureProjectCalls, 1);
    assert.equal(createTaskCalls, 0);
  });
}

test("migrates an older retry record without a decision snapshot before side effects", async () => {
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  const claim = await store.claimEvent({ ...event, eventId: "evt_legacy_retry_snapshot" }, {
    ownerId: "old-worker",
    now: 0,
    leaseMs: policy.leaseMs,
  });
  await store.fail("evt_legacy_retry_snapshot", {
    ownerId: "old-worker",
    token: claim.record.lease.token,
    error: unavailable(),
    nextAttemptAt: 5,
    deadLetter: false,
    now: 0,
  });
  let now = 5;
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => now,
    taskboard: {
      findTaskByEventId: async () => null,
      ensureProject: async () => {},
      createTask: async () => ({ id: "task_migrated", identifier: "AUTO-MIGRATED" }),
    },
  });
  assert.equal((await bridge.processDue()).taskIdentifier, "AUTO-MIGRATED");
  const migrated = await store.get("evt_legacy_retry_snapshot");
  assert.equal(migrated.decisionSnapshot?.kind, "ready");
  assert.equal(migrated.decisionSnapshot?.packageAlias, "Auto-cut-copyA");
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
  const result = await bridge.handle(event);
  assert.equal(result.taskIdentifier, "AUTO-7");
  assert.equal(created, 0);
  assert.equal((await store.get(event.eventId)).deliveryState, "succeeded");
});

test("persists ignored events as succeeded and never schedules them", async () => {
  const store = memoryStore();
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    taskboard: { ensureProject: assert.fail, createTask: assert.fail },
  });
  const ignored = { ...event, eventId: "evt_ignored_durable", afterValue: "剪辑中" };
  assert.deepEqual(await bridge.handle(ignored), {
    kind: "ignored",
    reason: "new_value_not_trigger",
  });
  assert.equal((await store.get(ignored.eventId)).deliveryState, "succeeded");
  assert.equal(await bridge.processDue(), null);
});

test("retries a blocked decision only when its Taskboard task creation fails", async () => {
  let now = 0;
  let available = false;
  let ensured = 0;
  let created = 0;
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store: memoryStore(),
    now: () => now,
    random: () => 0.5,
    taskboard: {
      findTaskByEventId: async () => null,
      ensureProject: async () => { ensured += 1; },
      createTask: async () => {
        created += 1;
        if (!available) throw unavailable();
        return { id: "blocked_2", identifier: "LOCAL-2" };
      },
    },
  });
  const blocked = { ...event, eventId: "evt_blocked_retry", fields: {} };
  assert.deepEqual(await bridge.handle(blocked), {
    kind: "pending",
    deliveryState: "retry_wait",
    attempts: 1,
    retryAt: 5,
  });
  now = 5;
  available = true;
  const result = await bridge.processDue();
  assert.equal(result.kind, "blocked");
  assert.equal(result.taskIdentifier, "LOCAL-2");
  assert.equal(ensured, 0);
  assert.equal(created, 2);
});

test("moves controlled repeated delivery failures to dead letter", async () => {
  let now = 0;
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store: memoryStore(),
    now: () => now,
    random: () => 0.5,
    taskboard: {
      findTaskByEventId: async () => null,
      ensureProject: async () => { throw unavailable(); },
      createTask: assert.fail,
    },
  });
  assert.equal((await bridge.handle({ ...retryEvent, eventId: "evt_dead_letter" })).deliveryState, "retry_wait");
  now = 5;
  assert.deepEqual(await bridge.processDue(), {
    kind: "dead_letter",
    deliveryState: "dead_letter",
    attempts: 2,
    errorCode: "TASKBOARD_UNAVAILABLE",
  });
  assert.equal(await bridge.processDue(), null);
});

test("completes a retry from an existing Taskboard task without creating another", async () => {
  let now = 0;
  let existing = false;
  let created = 0;
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store: memoryStore(),
    now: () => now,
    random: () => 0.5,
    taskboard: {
      findTaskByEventId: async () => existing
        ? { id: "task_existing_retry", identifier: "AUTO-9" }
        : null,
      ensureProject: async () => { throw unavailable(); },
      createTask: async () => { created += 1; return { id: "unexpected", identifier: "AUTO-X" }; },
    },
  });
  assert.equal((await bridge.handle({ ...retryEvent, eventId: "evt_existing_retry" })).deliveryState, "retry_wait");
  now = 5;
  existing = true;
  const result = await bridge.processDue();
  assert.equal(result.taskIdentifier, "AUTO-9");
  assert.equal(created, 0);
});

test("returns a duplicate marker when a succeeded event is replayed", async () => {
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store: memoryStore(),
    taskboard: {
      ensureProject: async () => {},
      createTask: async () => ({ id: "task_duplicate", identifier: "AUTO-DUP" }),
    },
  });
  const first = await bridge.handle({ ...event, eventId: "evt_durable_duplicate" });
  assert.deepEqual(await bridge.handle({ ...event, eventId: "evt_durable_duplicate" }), {
    ...first,
    duplicate: true,
  });
});

test("recovers an expired delivery lease and then processes its due event", async () => {
  let now = 10;
  const store = memoryStore();
  await store.claimEvent({ ...event, eventId: "evt_recovered" }, {
    ownerId: "crashed-instance",
    now: 0,
    leaseMs: policy.leaseMs,
  });
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => now,
    taskboard: {
      ensureProject: async () => {},
      createTask: async () => ({ id: "task_recovered", identifier: "AUTO-RECOVERED" }),
    },
  });
  assert.equal(await bridge.recover(), 1);
  assert.equal((await bridge.processDue()).taskIdentifier, "AUTO-RECOVERED");
  now = 11;
});

test("does not create a second task when two Bridge instances share a durable state file", async () => {
  const filename = await stateFilename();
  let releaseCreate;
  const createReleased = new Promise((resolve) => { releaseCreate = resolve; });
  let enteredCreate;
  const createEntered = new Promise((resolve) => { enteredCreate = resolve; });
  let created = 0;
  const taskboard = {
    findTaskByEventId: async () => null,
    ensureProject: async () => {},
    createTask: async () => {
      created += 1;
      enteredCreate();
      await createReleased;
      return { id: "task_shared", identifier: "AUTO-SHARED" };
    },
  };
  const bridgeOne = createBridge({
    config: { ...config, delivery: policy },
    store: new JsonStateStore(filename),
    taskboard,
    now: () => 0,
    ownerId: "bridge-one",
  });
  const bridgeTwo = createBridge({
    config: { ...config, delivery: policy },
    store: new JsonStateStore(filename),
    taskboard,
    now: () => 0,
    ownerId: "bridge-two",
  });
  const first = bridgeOne.handle({ ...event, eventId: "evt_cross_instance" });
  await createEntered;
  const second = await bridgeTwo.handle({ ...event, eventId: "evt_cross_instance" });
  assert.deepEqual(second, {
    kind: "pending",
    deliveryState: "processing",
    attempts: 1,
  });
  assert.equal(created, 1);
  releaseCreate();
  assert.equal((await first).taskIdentifier, "AUTO-SHARED");
  assert.equal(created, 1);
});

test("serializes an expired same-event delivery across Bridge instances", async () => {
  const filename = await stateFilename();
  let releaseCreate;
  const createReleased = new Promise((resolve) => { releaseCreate = resolve; });
  let firstCreateEntered;
  const firstEntered = new Promise((resolve) => { firstCreateEntered = resolve; });
  let created = 0;
  const taskboard = {
    findTaskByEventId: async () => (created > 0
      ? { id: "task_1", identifier: "AUTO-1" }
      : null),
    ensureProject: async () => {},
    createTask: async () => {
      created += 1;
      firstCreateEntered();
      await createReleased;
      return { id: `task_${created}`, identifier: `AUTO-${created}` };
    },
  };
  const timersOne = fakeIntervals();
  const storeOne = new JsonStateStore(filename);
  const storeTwo = new JsonStateStore(filename);
  const bridgeOne = createBridge({
    config: { ...config, delivery: policy },
    store: storeOne,
    taskboard,
    now: () => 0,
    ownerId: "expired-one",
    timers: timersOne,
  });
  const bridgeTwo = createBridge({
    config: { ...config, delivery: policy },
    store: storeTwo,
    taskboard,
    now: () => policy.leaseMs + 1,
    ownerId: "expired-two",
    timers: fakeIntervals(),
  });

  const first = bridgeOne.handle({ ...event, eventId: "evt_expired_cross_instance" });
  await firstEntered;
  const second = bridgeTwo.handle({ ...event, eventId: "evt_expired_cross_instance" });
  await Promise.resolve();
  assert.equal(created, 1);

  releaseCreate();
  const firstResult = await first;
  const secondResult = await second;
  assert.equal(created, 1);
  const taskResults = [firstResult, secondResult].filter((result) => result.taskIdentifier);
  assert.equal(taskResults.filter((result) => !result.duplicate).length, 1);
  assert.equal(taskResults.every((result) => result.taskIdentifier === "AUTO-1"), true);
  assert.ok([firstResult, secondResult].some((result) => (
    result.kind === "pending" || result.duplicate === true
  )));
});

test("renews a long-running lease before another Bridge can recover it", async () => {
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  const timers = fakeIntervals();
  let now = 0;
  let releaseCreate;
  const createReleased = new Promise((resolve) => { releaseCreate = resolve; });
  let enteredCreate;
  const createEntered = new Promise((resolve) => { enteredCreate = resolve; });
  let created = 0;
  const taskboard = {
    findTaskByEventId: async () => null,
    ensureProject: async () => {},
    createTask: async () => {
      created += 1;
      enteredCreate();
      await createReleased;
      return { id: "task_lease", identifier: "AUTO-LEASE" };
    },
  };
  const bridgeOne = createBridge({
    config: { ...config, delivery: policy },
    store,
    taskboard,
    now: () => now,
    ownerId: "bridge-lease-one",
    timers,
  });
  const first = bridgeOne.handle({ ...event, eventId: "evt_lease_heartbeat" });
  await createEntered;

  now = Math.floor(policy.leaseMs / 2);
  await timers.fireAll();
  const heartbeatRecord = await store.get("evt_lease_heartbeat");
  const renewedLeaseUntil = heartbeatRecord.lease?.leaseUntil ?? null;

  now = policy.leaseMs + 1;

  const bridgeTwo = createBridge({
    config: { ...config, delivery: policy },
    store: new JsonStateStore(filename),
    taskboard,
    now: () => now,
    ownerId: "bridge-lease-two",
  });
  const recovered = await bridgeTwo.recover();
  const due = recovered === 0 ? await bridgeTwo.processDue() : "recovered";

  releaseCreate();
  const firstResult = await first.catch((error) => error);
  assert.equal(renewedLeaseUntil, Math.floor(policy.leaseMs / 2) + policy.leaseMs);
  assert.equal(recovered, 0);
  assert.equal(due, null);
  assert.equal(firstResult.taskIdentifier, "AUTO-LEASE");
  assert.equal(created, 1);
  assert.equal(timers.callbacks.size, 0);
});

test("renews an expired but unreclaimed lease with its fencing token", async () => {
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  const timers = fakeIntervals();
  let now = 0;
  let releaseFind;
  const findReleased = new Promise((resolve) => { releaseFind = resolve; });
  let enteredFind;
  const findEntered = new Promise((resolve) => { enteredFind = resolve; });
  let created = 0;
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => now,
    ownerId: "late-heartbeat",
    timers,
    taskboard: {
      findTaskByEventId: async () => {
        enteredFind();
        await findReleased;
        return null;
      },
      ensureProject: async () => {},
      createTask: async () => {
        created += 1;
        return { id: "task_late_heartbeat", identifier: "AUTO-LATE-HEARTBEAT" };
      },
    },
  });

  const operation = bridge.handle({ ...event, eventId: "evt_late_heartbeat" });
  await findEntered;
  now = policy.leaseMs + 1;
  await timers.fireAll();
  releaseFind();

  const result = await operation;
  assert.equal(result.taskIdentifier, "AUTO-LATE-HEARTBEAT");
  assert.equal(created, 1);
  assert.equal(timers.callbacks.size, 0);
});

test("renews a lease that expires while waiting for the event lock", async () => {
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  const timers = fakeIntervals();
  let now = 0;
  const originalEventLock = store.withEventLock.bind(store);
  store.withEventLock = async (eventId, operation) => {
    now = policy.leaseMs + 1;
    return originalEventLock(eventId, operation);
  };
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => now,
    ownerId: "event-lock-late-heartbeat",
    timers,
    taskboard: {
      findTaskByEventId: async () => null,
      ensureProject: async () => {},
      createTask: async () => ({ id: "task_event_lock_late", identifier: "AUTO-EVENT-LOCK-LATE" }),
    },
  });

  const result = await bridge.handle({ ...event, eventId: "evt_event_lock_late" });
  assert.equal(result.taskIdentifier, "AUTO-EVENT-LOCK-LATE");
  assert.equal(timers.callbacks.size, 0);
});

test("waits for an in-flight heartbeat renewal before returning", async () => {
  const store = memoryStore();
  const timers = fakeIntervals();
  let releaseRenew;
  const renewReleased = new Promise((resolve) => { releaseRenew = resolve; });
  let renewEntered;
  const renewEnteredPromise = new Promise((resolve) => { renewEntered = resolve; });
  store.renewLease = async () => {
    renewEntered();
    await renewReleased;
    return { lease: { leaseUntil: 100 } };
  };
  const originalComplete = store.complete.bind(store);
  store.complete = async (...args) => {
    const result = await originalComplete(...args);
    void timers.fireAll();
    await renewEnteredPromise;
    return result;
  };

  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => 0,
    ownerId: "heartbeat-stop-wait",
    timers,
    taskboard: {
      findTaskByEventId: async () => null,
      ensureProject: async () => {},
      createTask: async () => ({ id: "task_stop_wait", identifier: "AUTO-STOP-WAIT" }),
    },
  });

  const operation = bridge.handle({ ...event, eventId: "evt_heartbeat_stop_wait" });
  await renewEnteredPromise;
  const status = await Promise.race([
    operation.then(() => "settled"),
    delay(20).then(() => "waiting"),
  ]);
  assert.equal(status, "waiting");

  releaseRenew();
  const result = await operation;
  assert.equal(result.taskIdentifier, "AUTO-STOP-WAIT");
  assert.equal(timers.callbacks.size, 0);
});

test("returns a durable pending result when the heartbeat loses its lease", async () => {
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  const timers = fakeIntervals();
  let now = 0;
  let releaseCreate;
  const createReleased = new Promise((resolve) => { releaseCreate = resolve; });
  let enteredCreate;
  const createEntered = new Promise((resolve) => { enteredCreate = resolve; });
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => now,
    ownerId: "heartbeat-lost",
    timers,
    taskboard: {
      findTaskByEventId: async () => null,
      ensureProject: async () => {},
      createTask: async () => {
        enteredCreate();
        await createReleased;
        return { id: "task_lost", identifier: "AUTO-LOST" };
      },
    },
  });
  const originalRenew = store.renewLease.bind(store);
  store.renewLease = async () => {
    throw Object.assign(new Error("lease replaced"), { code: "LEASE_NOT_OWNED" });
  };
  const operation = bridge.handle({ ...event, eventId: "evt_heartbeat_lost" });
  await createEntered;
  await timers.fireAll();
  releaseCreate();
  const result = await operation;
  assert.equal(result.kind, "pending");
  assert.equal(result.deliveryState, "processing");
  assert.equal(timers.callbacks.size, 0);
  store.renewLease = originalRenew;
});

test("does not start a Taskboard side effect after a lease expires during renewal", async () => {
  const store = memoryStore();
  const timers = fakeIntervals();
  let now = 0;
  let releaseFind;
  const findReleased = new Promise((resolve) => { releaseFind = resolve; });
  let markFindEntered;
  const findEntered = new Promise((resolve) => { markFindEntered = resolve; });
  let releaseRenew;
  const renewReleased = new Promise((resolve) => { releaseRenew = resolve; });
  let markRenewEntered;
  const renewEntered = new Promise((resolve) => { markRenewEntered = resolve; });
  let created = 0;
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => now,
    ownerId: "heartbeat-expired-before-side-effect",
    timers,
    taskboard: {
      findTaskByEventId: async () => {
        markFindEntered();
        await findReleased;
        return null;
      },
      ensureProject: async () => {},
      createTask: async () => {
        created += 1;
        return { id: "task_expired", identifier: "AUTO-EXPIRED" };
      },
    },
  });
  const originalRenew = store.renewLease.bind(store);
  store.renewLease = async (...args) => {
    markRenewEntered();
    await renewReleased;
    throw Object.assign(new Error("renewal remained fenced"), { code: "LEASE_NOT_OWNED" });
  };

  const operation = bridge.handle({ ...event, eventId: "evt_expired_before_side_effect" });
  await findEntered;
  const timerRun = timers.fireAll();
  await renewEntered;
  now = policy.leaseMs + 1;
  releaseFind();
  releaseRenew();
  await timerRun;
  const result = await operation;

  assert.equal(created, 0);
  assert.equal(result.kind, "pending");
  assert.equal(result.deliveryState, "processing");
  store.renewLease = originalRenew;
});

test("persists event-lock timeouts for bounded compensation", async () => {
  for (const [index, code] of ["STATE_LOCK_TIMEOUT", "EVENT_LOCK_TIMEOUT"].entries()) {
    let now = 0;
    const store = memoryStore();
    store.withEventLock = async () => {
      throw Object.assign(new Error("event lock busy"), { code });
    };
    const bridge = createBridge({
      config: { ...config, delivery: policy },
      store,
      now: () => now,
      random: () => 0.5,
      ownerId: `event-lock-timeout-${index}`,
      taskboard: {
        ensureProject: assert.fail,
        createTask: assert.fail,
      },
    });
    assert.deepEqual(await bridge.handle({ ...event, eventId: `evt_event_lock_timeout_${index}` }), {
      kind: "pending",
      deliveryState: "retry_wait",
      attempts: 1,
      retryAt: 5,
    });
    now = 5;
    assert.deepEqual(await bridge.processDue(), {
      kind: "dead_letter",
      deliveryState: "dead_letter",
      attempts: 2,
      errorCode: code,
    });
  }
});

test("treats transient heartbeat renewal errors as bounded delivery failures", async () => {
  let now = 0;
  const timers = fakeIntervals();
  const store = memoryStore();
  store.renewLease = async () => {
    throw Object.assign(new Error("state lock busy"), { code: "STATE_LOCK_TIMEOUT" });
  };
  let releaseFind;
  const findReleased = new Promise((resolve) => { releaseFind = resolve; });
  let enteredFind;
  const findEntered = new Promise((resolve) => { enteredFind = resolve; });
  let ensured = 0;
  let created = 0;
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => now,
    timers,
    random: () => 0.5,
    ownerId: "heartbeat-timeout",
    taskboard: {
      findTaskByEventId: async () => {
        enteredFind();
        await findReleased;
        return null;
      },
      ensureProject: async () => { ensured += 1; },
      createTask: async () => {
        created += 1;
        return { id: "unexpected", identifier: "UNEXPECTED" };
      },
    },
  });
  const operation = bridge.handle({ ...event, eventId: "evt_heartbeat_timeout" });
  await findEntered;
  assert.equal(timers.callbacks.size, 1);
  await timers.fireAll();
  releaseFind();
  assert.deepEqual(await operation, {
    kind: "pending",
    deliveryState: "retry_wait",
    attempts: 1,
    retryAt: 5,
  });
  assert.equal(ensured, 0);
  assert.equal(created, 0);
});

test("tracks due delivery so same-Bridge replay and recovery cannot reclaim it", async () => {
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  let now = 0;
  const claim = await store.claimEvent({ ...event, eventId: "evt_due_active" }, {
    ownerId: "seed",
    now,
    leaseMs: policy.leaseMs,
  });
  await store.fail("evt_due_active", {
    ownerId: "seed",
    token: claim.record.lease.token,
    error: { code: "TASKBOARD_UNAVAILABLE" },
    nextAttemptAt: 1,
    deadLetter: false,
    now,
  });
  now = 1;
  const timers = fakeIntervals();
  let releaseCreate;
  const createReleased = new Promise((resolve) => { releaseCreate = resolve; });
  let enteredCreate;
  const createEntered = new Promise((resolve) => { enteredCreate = resolve; });
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => now,
    ownerId: "due-owner",
    timers,
    taskboard: {
      findTaskByEventId: async () => null,
      ensureProject: async () => {},
      createTask: async () => {
        enteredCreate();
        await createReleased;
        return { id: "task_due", identifier: "AUTO-DUE" };
      },
    },
  });
  const due = bridge.processDue();
  await enteredCreate;
  const replay = await bridge.handle({ ...event, eventId: "evt_due_active" });
  assert.deepEqual(replay, {
    kind: "pending",
    deliveryState: "processing",
    attempts: 2,
  });
  assert.equal(await bridge.recover(), 0);
  releaseCreate();
  assert.equal((await due).taskIdentifier, "AUTO-DUE");
});
