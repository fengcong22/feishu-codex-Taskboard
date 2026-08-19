import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridge } from "../src/bridge.mjs";
import { JsonStateStore } from "../src/state-store.mjs";

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

async function stateFilename() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-bridge-durable-"));
  return path.join(directory, "state.json");
}

function memoryStore() {
  const entries = new Map();
  const clone = (value) => value === undefined ? value : structuredClone(value);
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
    record.lease = { ownerId, leaseUntil: now + leaseMs };
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
    claimNextDue: async ({ ownerId, now, leaseMs }) => {
      const due = [...entries.values()]
        .map((value) => normalize(value.eventId, value, now))
        .filter((value) => (value.deliveryState === "pending"
          || value.deliveryState === "retry_wait")
          && value.event !== null
          && (value.nextAttemptAt === null || value.nextAttemptAt <= now))
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!due) return null;
      entries.set(due.eventId, due);
      return claim(due, ownerId, now, leaseMs).record;
    },
    complete: async (eventId, { ownerId, decision, outcome, now }) => {
      const record = entries.get(eventId);
      if (!record || record.deliveryState !== "processing"
        || record.lease?.ownerId !== ownerId || record.lease.leaseUntil <= now) {
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
    fail: async (eventId, { ownerId, error, nextAttemptAt, deadLetter, now }) => {
      const record = entries.get(eventId);
      if (!record || record.deliveryState !== "processing"
        || record.lease?.ownerId !== ownerId || record.lease.leaseUntil <= now) {
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
    recoverExpiredLeases: async ({ now }) => {
      let count = 0;
      for (const record of entries.values()) {
        if (record.deliveryState === "processing" && record.lease?.leaseUntil <= now) {
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
