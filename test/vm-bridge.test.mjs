import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createBridge } from "../src/bridge.mjs";
import { JsonStateStore } from "../src/state-store.mjs";
import { validateSubjectConfig } from "../src/workflow-config.mjs";
import { configuredTables } from "../src/decide-event.mjs";
import { normalizeBitableRecordChanged } from "../src/feishu-event.mjs";

const writeback = () => ({ processing: { fieldId: null, optionId: null },
  completed: { fieldId: null, optionId: null } });

function subject(overrides = {}) {
  return validateSubjectConfig({
    baseToken: "bas_vm", baseName: "课程库", tableId: "tbl_vm", tableName: "化学",
    lifecycle: "enabled", configVersion: 2,
    workflowTemplate: { id: "vm_pmo_review_video", version: 1 },
    statusField: { fieldId: "fld_status", fieldName: "进度", type: "single_select",
      options: [{ optionId: "opt_wait", value: "待制作" }, { optionId: "opt_ready", value: "待剪辑" },
        { optionId: "opt_done", value: "剪辑中" }] },
    execution: { mode: "automatic", concurrencyGroup: "vm", maxConcurrent: 1, resourceGroups: [] },
    packageRoute: { routeMode: "fixed", packageAlias: "auto-cut-slicing", subjectCodeFieldId: null, branchMap: null },
    vmWorkflow: {
      fields: { vmidFieldId: "fld_vmid", outputAttachmentFieldId: "fld_output", namingFieldId: "fld_title" },
      approval: { department: "动画组", reason: "切片剪辑" },
      stages: {
        initial: { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_ready",
          instructionFieldId: "fld_instruction", writeback: writeback() },
        review: { enabled: false, statusFieldId: null, triggerOptionId: null,
          instructionFieldId: null, instructionAttachmentsFieldId: null, writeback: writeback() },
      },
      finalArchive: { enabled: false, statusFieldId: null, triggerOptionId: null,
        pathSource: "manual", directoryPath: null, pathFieldId: null },
    },
    ...overrides,
  });
}

function edge(beforeOptionId = "opt_wait", afterOptionId = "opt_ready", overrides = {}) {
  return {
    eventId: "evt_vm", baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm",
    fieldId: "fld_status", statusFieldId: "fld_status", beforePresent: true, afterPresent: true,
    beforeOptionId, afterOptionId, eventOccurredAt: 1000, eventOccurredAtPresent: true,
    fields: {}, fieldValuesById: {},
    ...overrides,
  };
}

async function fixture(t, taskboard, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-bridge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = subject();
  const store = new JsonStateStore(path.join(directory, "state.json"));
  const bridge = createBridge({
    config: { tables: [active] }, store, taskboard,
    workflowStore: { resolveSubjectVersionAt: async () => active },
    logger: { info() {}, warn() {}, error() {} },
    ...options,
  });
  return { bridge, store, active };
}

test("VM initial entry registers through its dedicated narrow Taskboard route once", async (t) => {
  const calls = [];
  const { bridge, store } = await fixture(t, {
    findTaskByBinding: async () => null,
    registerFeishuVmTask: async (payload) => {
      calls.push(payload);
      return { id: "task_vm", identifier: "VM-1" };
    },
  });
  const first = await bridge.handle(edge());
  assert.equal(first.kind, "register");
  assert.equal(first.taskId, "task_vm");
  assert.deepEqual(calls, [{
    event: { eventId: "evt_vm", baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm",
      statusFieldId: "fld_status", beforeOptionId: "opt_wait", afterOptionId: "opt_ready", occurredAt: 1000 },
    binding: { subjectKey: "bas_vm:tbl_vm", configVersion: 2, stageId: "initial" },
  }]);
  assert.equal((await bridge.handle(edge())).duplicate, true);
  assert.equal(calls.length, 1);
  assert.equal((await store.get("evt_vm")).deliveryState, "succeeded");
});

test("VM review entry registers the review stage and archives only the prior todo stage", async (t) => {
  const registrations = [], archived = [];
  const { bridge, active } = await fixture(t, {
    findTaskByBinding: async () => null,
    listFeishuTasks: async () => [{ id: "initial_todo", status: "todo", archivedAt: null,
      feishuOrigin: { baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm",
        statusFieldId: "fld_status", stageId: "initial", packageAlias: "auto-cut-slicing" } }],
    getTask: async () => ({ id: "initial_todo", status: "todo", archivedAt: null,
      feishuOrigin: { baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm",
        statusFieldId: "fld_status", stageId: "initial", packageAlias: "auto-cut-slicing" } }),
    archiveFeishuTask: async (task) => { archived.push(task.id); return task; },
    registerFeishuVmTask: async (payload) => { registrations.push(payload); return { id: "review_task", identifier: "VM-2" }; },
  });
  active.statusField.options.push({ optionId: "opt_review", value: "待修改" });
  active.vmWorkflow.stages.review = { enabled: true, statusFieldId: "fld_status",
    triggerOptionId: "opt_review", instructionFieldId: "fld_review_instruction",
    instructionAttachmentsFieldId: null, writeback: writeback() };
  const result = await bridge.handle(edge("opt_ready", "opt_review", { eventId: "evt_review" }));
  assert.equal(result.kind, "register", JSON.stringify(result));
  assert.equal(result.stageId, "review");
  assert.equal(registrations[0].binding.stageId, "review");
  assert.deepEqual(archived, ["initial_todo"]);
});

test("VM final archive edge uses a dedicated Taskboard operation without creating a clipping task", async (t) => {
  const calls = [];
  const configured = subject();
  configured.statusField.options.push({ optionId: "opt_archive", value: "待归档" });
  configured.vmWorkflow.finalArchive = { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_archive",
    pathSource: "manual", directoryPath: "D:\\archive", pathFieldId: null };
  const { bridge, store } = await fixture(t, {
    archiveFeishuVmFinalVideo: async (payload) => {
      calls.push(payload);
      return { id: "archive_job", eventId: "evt_archive", state: "pending",
        subjectKey: "bas_vm:tbl_vm", configVersion: 2 };
    },
  }, { config: { tables: [configured] }, workflowStore: { resolveSubjectVersionAt: async () => configured } });
  const result = await bridge.handle(edge("opt_done", "opt_archive", { eventId: "evt_archive",
    beforeOptionIds: ["opt_done"], afterOptionIds: ["opt_archive"] }));
  assert.equal(result.kind, "final_archive", JSON.stringify({ result, calls }));
  assert.equal(result.archiveJobId, "archive_job");
  assert.deepEqual(calls, [{
    event: { eventId: "evt_archive", baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm",
      statusFieldId: "fld_status", beforeOptionIds: ["opt_done"], afterOptionIds: ["opt_archive"], occurredAt: 1000 },
    binding: { subjectKey: "bas_vm:tbl_vm", configVersion: 2 },
  }]);
});

test("manual recovery replays only a real final-archive dead letter with its exact source identity", async (t) => {
  const calls = [];
  const configured = subject();
  configured.statusField.options.push({ optionId: "opt_archive", value: "待归档" });
  configured.vmWorkflow.finalArchive = { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_archive",
    pathSource: "manual", directoryPath: null, pathFieldId: null };
  const source = { runId: "run_1", deliveryId: "delivery_1", artifactId: "artifact_1",
    sha256: "a".repeat(64), bytes: 20_368_266 };
  let attempts = 0;
  const { bridge, store } = await fixture(t, {
    archiveFeishuVmFinalVideo: async (payload) => {
      attempts += 1;
      calls.push(payload);
      if (attempts === 1) throw Object.assign(new Error("offline"), { status: 503 });
      return { id: "archive_job", eventId: "evt_archive_recovery", state: "pending",
        subjectKey: "bas_vm:tbl_vm", configVersion: 2 };
    },
  }, {
    config: { tables: [configured], delivery: { maxAttempts: 1, initialDelayMs: 5, maxDelayMs: 5,
      leaseMs: 1_000, pollIntervalMs: 100 } },
    workflowStore: { resolveSubjectVersionAt: async () => configured },
  });
  const archiveEvent = edge("opt_done", "opt_archive", { eventId: "evt_archive_recovery",
    beforeOptionIds: ["opt_done"], afterOptionIds: ["opt_archive"] });
  assert.equal((await bridge.handle(archiveEvent)).kind, "dead_letter");
  const before = await store.get(archiveEvent.eventId);
  assert.equal(before.deliveryState, "dead_letter");

  const queued = await bridge.retryFinalArchiveDeadLetter(archiveEvent.eventId, source);
  assert.equal(queued.deliveryState, "retry_wait");
  assert.equal(queued.attempts, 0);
  assert.equal((await store.get(archiveEvent.eventId)).decisionSnapshot.kind, "final_archive");
  assert.equal((await store.get(archiveEvent.eventId)).lastError.code, before.lastError.code);

  const replay = await bridge.processDue();
  assert.equal(replay.kind, "final_archive");
  assert.deepEqual(calls[1].expectedSource, source);
  assert.equal(calls[1].event.eventId, archiveEvent.eventId);
});

test("manual recovery rejects a different source identity after one has been frozen", async (t) => {
  const configured = subject();
  configured.statusField.options.push({ optionId: "opt_archive", value: "待归档" });
  configured.vmWorkflow.finalArchive = { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_archive",
    pathSource: "manual", directoryPath: null, pathFieldId: null };
  const { bridge } = await fixture(t, {
    archiveFeishuVmFinalVideo: async () => { throw Object.assign(new Error("offline"), { status: 503 }); },
  }, {
    config: { tables: [configured], delivery: { maxAttempts: 1, initialDelayMs: 5, maxDelayMs: 5,
      leaseMs: 1_000, pollIntervalMs: 100 } },
    workflowStore: { resolveSubjectVersionAt: async () => configured },
  });
  const archiveEvent = edge("opt_done", "opt_archive", { eventId: "evt_archive_guard",
    beforeOptionIds: ["opt_done"], afterOptionIds: ["opt_archive"] });
  await bridge.handle(archiveEvent);
  const source = { runId: "run_1", deliveryId: "delivery_1", artifactId: "artifact_1",
    sha256: "b".repeat(64), bytes: 20_368_266 };
  await bridge.retryFinalArchiveDeadLetter(archiveEvent.eventId, source);
  await assert.rejects(
    bridge.retryFinalArchiveDeadLetter(archiveEvent.eventId, { ...source, sha256: "c".repeat(64) }),
    { code: "FINAL_ARCHIVE_RECOVERY_CONFLICT" },
  );
});

test("manual recovery refuses initial-stage dead letters and simulated archive events", async (t) => {
  const configured = subject();
  configured.statusField.options.push({ optionId: "opt_archive", value: "待归档" });
  configured.vmWorkflow.finalArchive = { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_archive",
    pathSource: "manual", directoryPath: null, pathFieldId: null };
  const { bridge, store } = await fixture(t, {
    findTaskByBinding: async () => null,
    registerFeishuVmTask: async () => { throw Object.assign(new Error("offline"), { status: 503 }); },
    archiveFeishuVmFinalVideo: assert.fail,
  }, { config: { tables: [configured], delivery: { maxAttempts: 1, initialDelayMs: 5, maxDelayMs: 5,
    leaseMs: 1_000, pollIntervalMs: 100 } }, workflowStore: { resolveSubjectVersionAt: async () => configured } });
  const source = { runId: "run_1", deliveryId: "delivery_1", artifactId: "artifact_1",
    sha256: "b".repeat(64), bytes: 42 };
  assert.equal((await bridge.handle(edge("opt_wait", "opt_ready", {
    beforeOptionIds: ["opt_wait"], afterOptionIds: ["opt_ready"],
  }))).kind, "dead_letter");
  await assert.rejects(bridge.retryFinalArchiveDeadLetter("evt_vm", source), { code: "FINAL_ARCHIVE_RECOVERY_NOT_ALLOWED" });
  assert.equal((await store.get("evt_vm")).deliveryState, "dead_letter");
  const simulated = edge("opt_done", "opt_archive", { eventId: "evt_sim_archive", deliverySource: "simulation",
    beforeOptionIds: ["opt_done"], afterOptionIds: ["opt_archive"] });
  assert.equal((await bridge.handle(simulated)).kind, "ignored");
  await assert.rejects(bridge.retryFinalArchiveDeadLetter(simulated.eventId, source), { code: "FINAL_ARCHIVE_RECOVERY_NOT_ALLOWED" });
  assert.equal((await store.get(simulated.eventId)).deliveryProvenance.source, "simulation");
});

test("VM same-field SDK edges register initial and review rounds independently from final archive", async (t) => {
  const operations = [];
  const configured = subject();
  configured.statusField.options.push(
    { optionId: "opt_wait_review", value: "待审核" },
    { optionId: "opt_review", value: "审核修改" },
    { optionId: "opt_archive", value: "归档" },
  );
  configured.vmWorkflow.stages.review = { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_review",
    instructionFieldId: "fld_review_instruction", instructionAttachmentsFieldId: null, writeback: writeback() };
  configured.vmWorkflow.finalArchive = { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_archive",
    pathSource: "manual", directoryPath: "D:\\archive", pathFieldId: null };
  const { bridge, store } = await fixture(t, {
    findTaskByBinding: async () => null,
    listFeishuTasks: async () => [],
    registerFeishuVmTask: async (payload) => {
      operations.push({ kind: "register", eventId: payload.event.eventId, stageId: payload.binding.stageId });
      return { id: `task_${payload.event.eventId}`, identifier: "VM-1" };
    },
    archiveFeishuVmFinalVideo: async (payload) => {
      operations.push({ kind: "final_archive", eventId: payload.event.eventId });
      return { id: "archive_job", eventId: payload.event.eventId, state: "pending",
        subjectKey: "bas_vm:tbl_vm", configVersion: 2 };
    },
  }, { config: { tables: [configured] }, workflowStore: { resolveSubjectVersionAt: async () => configured } });
  function sdkEdge(eventId, before, after) {
    return normalizeBitableRecordChanged({ header: { event_id: eventId },
      event: { file_token: "bas_vm", table_id: "tbl_vm", record_id: "rec_vm", create_time: 1000,
        action_list: [{ action: "record_edited",
          before_value: [{ field_id: "fld_status", field_value: JSON.stringify(before) }],
          after_value: [{ field_id: "fld_status", field_value: JSON.stringify(after) }],
        }] },
    }, configured)[0];
  }
  for (const [eventId, before, after, kind] of [
    ["evt_initial", "opt_wait", "opt_ready", "register"],
    ["evt_processing", "opt_ready", "opt_done", "ignored"],
    ["evt_review_one", "opt_wait_review", "opt_review", "register"],
    ["evt_review_repeat", "opt_review", "opt_review", "ignored"],
    ["evt_final_archive", "opt_wait_review", "opt_archive", "final_archive"],
    ["evt_review_two", "opt_archive", "opt_review", "register"],
  ]) {
    const result = await bridge.handle(sdkEdge(eventId, before, after));
    assert.equal(result.kind, kind, eventId);
  }
  assert.equal((await bridge.handle(sdkEdge("evt_review_two", "opt_archive", "opt_review"))).duplicate, true);
  assert.equal((await bridge.handle({ ...sdkEdge("evt_sim_review", "opt_wait_review", "opt_review"),
    deliverySource: "simulation" })).kind, "ignored");
  assert.deepEqual(operations, [
    { kind: "register", eventId: "evt_initial", stageId: "initial" },
    { kind: "register", eventId: "evt_review_one", stageId: "review" },
    { kind: "final_archive", eventId: "evt_final_archive" },
    { kind: "register", eventId: "evt_review_two", stageId: "review" },
  ]);
  assert.equal((await store.get("evt_review_two")).deliveryState, "succeeded");
});

test("VM simulation cannot invoke registration or archive", async (t) => {
  let calls = 0;
  const { bridge } = await fixture(t, {
    registerFeishuVmTask: async () => { calls += 1; throw new Error("unexpected"); },
    listFeishuTasks: async () => { calls += 1; throw new Error("unexpected"); },
  });
  assert.equal((await bridge.handle(edge("opt_wait", "opt_ready", {
    eventId: "evt_sim_entry", deliverySource: "simulation",
  }))).kind, "ignored");
  assert.equal((await bridge.handle(edge("opt_ready", "opt_done", {
    eventId: "evt_sim_exit", deliverySource: "simulation",
  }))).kind, "ignored");
  assert.equal(calls, 0);
});

test("VM initial exit archives matching VM todo task and preserves old ZIP or started tasks", async (t) => {
  const calls = [];
  const waiting = { id: "todo_vm", status: "todo", archivedAt: null,
    feishuOrigin: { baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm",
      statusFieldId: "fld_status", stageId: "initial", packageAlias: "auto-cut-slicing" } };
  const started = { ...waiting, id: "started_vm", status: "in_progress" };
  const oldZip = { ...waiting, id: "old_zip", feishuOrigin: { ...waiting.feishuOrigin, packageAlias: "old-zip" } };
  const legacy = { ...waiting, id: "legacy", feishuOrigin: { ...waiting.feishuOrigin, packageAlias: undefined } };
  const { bridge } = await fixture(t, {
    listFeishuTasks: async () => [waiting, started, oldZip, legacy],
    getTask: async (id) => [waiting, started, oldZip, legacy].find((task) => task.id === id),
    archiveFeishuTask: async (task) => { calls.push(task.id); return { ...task, archivedAt: "now" }; },
  });
  const result = await bridge.handle(edge("opt_ready", "opt_done", { eventId: "evt_exit" }));
  assert.equal(result.kind, "ignored");
  assert.deepEqual(calls, ["todo_vm"]);
});

test("VM entry fails closed when dedicated Taskboard route is unavailable", async (t) => {
  const { bridge, store } = await fixture(t, { registerFeishuStageTask: async () => {
    throw new Error("old route must not be used");
  } });
  const result = await bridge.handle(edge());
  assert.equal(result.kind, "pending");
  assert.equal((await store.get("evt_vm")).deliveryState, "retry_wait");
});

test("VM retry after Bridge restart uses the frozen config and never reads ZIP context", async (t) => {
  let clock = 1000;
  let contextCalls = 0;
  const { bridge, store } = await fixture(t, {
    registerFeishuVmTask: async () => { throw Object.assign(new Error("temporary"), { status: 503 }); },
  }, { now: () => clock, readControlledContext: async () => { contextCalls += 1; return {}; } });
  assert.equal((await bridge.handle(edge())).kind, "pending");
  const saved = await store.get("evt_vm");
  assert.equal(saved.decisionSnapshot.configVersion, 2);
  assert.equal(saved.decisionSnapshot.controlledContext, null);
  const requests = [];
  clock = saved.nextAttemptAt;
  const restarted = createBridge({
    config: { tables: [] }, store, now: () => clock,
    workflowStore: { resolveSubjectVersionAt: async () => { throw new Error("must not resolve newer config"); } },
    readControlledContext: async () => { contextCalls += 1; return {}; },
    taskboard: { registerFeishuVmTask: async (payload) => {
      requests.push(payload); return { id: "task_vm", identifier: "VM-1" };
    } },
  });
  assert.equal((await restarted.processDue()).kind, "register");
  assert.deepEqual(requests.map((payload) => payload.binding), [
    { subjectKey: "bas_vm:tbl_vm", configVersion: 2, stageId: "initial" },
  ]);
  assert.equal(contextCalls, 0);
});

test("active VM workflow normalizes SDK events and routes the option edge", async (t) => {
  let requests = 0;
  const { bridge, active } = await fixture(t, { registerFeishuVmTask: async () => {
    requests += 1; return { id: "task_vm", identifier: "VM-1" };
  } });
  const tables = configuredTables({ workflow: { bases: [{ baseToken: "bas_vm", subjects: [active] }] } });
  assert.equal(tables.length, 1);
  const events = normalizeBitableRecordChanged({
    header: { event_id: "evt_sdk" },
    event: { file_token: "bas_vm", table_id: "tbl_vm", record_id: "rec_vm", create_time: 1000,
      action_list: [{ action: "record_edited",
        before_value: [{ field_id: "fld_status", field_value: '"opt_wait"' }],
        after_value: [{ field_id: "fld_status", field_value: '"opt_ready"' }],
      }] },
  }, tables[0]);
  assert.equal(events.length, 1);
  assert.equal((await bridge.handle(events[0])).kind, "register");
  assert.equal(requests, 1);
});
