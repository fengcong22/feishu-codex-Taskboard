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
