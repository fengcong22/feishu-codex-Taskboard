import assert from "node:assert/strict";
import test from "node:test";

import { decideRecordChange } from "../src/decide-event.mjs";
import { normalizeBitableRecordChanged } from "../src/feishu-event.mjs";
import {
  buildTrustedTaskPayload,
} from "../src/task-payload.mjs";
import {
  createFeishuControlledContextReader,
  readControlledRecordContext,
} from "../src/feishu-record-reader.mjs";
import { createBridgeServer } from "../src/server.mjs";
import { createBridge } from "../src/bridge.mjs";
import { JsonStateStore } from "../src/state-store.mjs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const subject = {
  subjectKey: "bas_demo:tbl_math",
  configVersion: 7,
  lifecycle: "enabled",
  baseToken: "bas_demo",
  tableId: "tbl_math",
  tableName: "数学",
  statusField: { fieldId: "fld_status", fieldName: "制作进度" },
  documentField: { fieldId: "fld_document", fieldName: "集合文档" },
  namingField: { fieldId: "fld_name", fieldName: "命名" },
  stages: {
    initial: {
      enabled: true,
      trigger: { fieldId: "fld_status", optionId: "opt_initial", value: "待初稿" },
      videoSource: { kind: "docx_section", anchorText: "录屏" },
      reviewSource: { kind: "docx_section", anchorText: "修改意见" },
      audio: { mode: "video_original" },
      nameSuffix: "_初稿",
    },
    first_review: {
      enabled: true,
      trigger: { fieldId: "fld_status", optionId: "opt_first", value: "待初审修改" },
      videoSource: { kind: "docx_section", anchorText: "初审视频" },
      reviewSource: { kind: "docx_section", anchorText: "初审意见" },
      audio: { mode: "video_original" },
      nameSuffix: "_初审修改",
    },
    final_review: {
      enabled: false,
      trigger: { fieldId: "fld_status", optionId: "opt_final", value: "待终审修改" },
      videoSource: { kind: "docx_section", anchorText: "终审视频" },
      reviewSource: { kind: "docx_section", anchorText: "终审意见" },
      audio: { mode: "video_original" },
      nameSuffix: "_终审修改",
    },
  },
  execution: { mode: "automatic", enqueueMode: "automatic" },
  packageRoute: { packageAlias: "Auto-cut-lite" },
  upload: { enqueueMode: "automatic" },
};

function edge(beforeOptionId, afterOptionId, overrides = {}) {
  return {
    eventId: "evt-1",
    baseToken: "bas_demo",
    tableId: "tbl_math",
    recordId: "rec-1",
    recordTitle: "第一课",
    statusFieldId: "fld_status",
    fieldId: "fld_status",
    fieldName: "制作进度",
    beforePresent: true,
    afterPresent: true,
    beforeOptionId,
    afterOptionId,
    beforeValue: beforeOptionId,
    afterValue: afterOptionId,
    eventOccurredAt: 1500,
    eventOccurredAtPresent: true,
    fields: {},
    fieldValuesById: {},
    ...overrides,
  };
}

test("registers only a non-target to enabled stage target edge", () => {
  const result = decideRecordChange(subject, edge("opt_other", "opt_initial"));
  assert.equal(result.kind, "register");
  assert.equal(result.stageId, "initial");
  assert.equal(result.archiveWaiting, false);
  assert.equal(decideRecordChange(subject, edge("opt_initial", "opt_initial")).kind, "ignored");
});

test("archives the old stage before registering a stage-to-stage move", () => {
  const result = decideRecordChange(subject, edge("opt_initial", "opt_first"));
  assert.equal(result.kind, "register");
  assert.equal(result.stageId, "first_review");
  assert.equal(result.archiveWaiting, true);
  assert.equal(result.previousStageId, "initial");
});

test("fails closed when either side of the status edge is absent", () => {
  const result = decideRecordChange(subject, { ...edge("opt_other", "opt_initial"), beforePresent: false });
  assert.deepEqual({ kind: result.kind, reasonCode: result.reasonCode }, {
    kind: "blocked",
    reasonCode: "MISSING_STATUS_EDGE",
  });
});

test("normalizes option ids and provider occurrence time without erasing presence", () => {
  const payload = {
    header: { event_id: "evt-provider" },
    event: {
      file_token: "bas_demo",
      table_id: "tbl_math",
      record_id: "rec-1",
      create_time: 1788652800000,
      action_list: [{
        action: "record_edited",
        before_value: [{ field_id: "fld_status", field_value: JSON.stringify("opt_other") }],
        after_value: [{ field_id: "fld_status", field_value: JSON.stringify("opt_initial") }],
      }],
    },
  };
  const [event] = normalizeBitableRecordChanged(payload, {
    ...subject,
    triggerField: "制作进度",
    triggerFieldId: "fld_status",
    triggerValue: "待初稿",
    triggerOptionId: "opt_initial",
  });
  assert.equal(event.beforePresent, true);
  assert.equal(event.afterPresent, true);
  assert.equal(event.beforeOptionId, "opt_other");
  assert.equal(event.afterOptionId, "opt_initial");
  assert.equal(event.statusFieldId, "fld_status");
  assert.equal(event.eventOccurredAt, 1788652800000);
  assert.equal(event.eventOccurredAtPresent, true);
});

test("controlled context reads only configured fields and retains invalid values as data", async () => {
  const calls = [];
  const reader = createFeishuControlledContextReader({
    client: {
      bitable: { v1: { appTableRecord: { get: async (request) => {
        calls.push(request);
        return { code: 0, data: { record: { fields: {
          集合文档: ["https://guanghe.feishu.cn/docx/one", "https://guanghe.feishu.cn/docx/two"],
          命名: "",
        } } } };
      } } } },
    },
    searchNaming: async () => ({ provedUnique: false }),
  });
  const result = await readControlledRecordContext(reader, {
    ...subject,
    documentField: { fieldId: "fld_document", fieldName: "集合文档" },
    namingField: { fieldId: "fld_name", fieldName: "命名" },
  }, { baseToken: "bas_demo", tableId: "tbl_math", recordId: "rec-1" });
  assert.deepEqual(result.documentLinks, [
    "https://guanghe.feishu.cn/docx/one",
    "https://guanghe.feishu.cn/docx/two",
  ]);
  assert.equal(result.namingDisplayValue, "");
  assert.equal(result.namingValueUnique, false);
  assert.equal(calls[0].path.record_id, "rec-1");
});

test("trusted task payload contains binding and context but no executable path", () => {
  const payload = buildTrustedTaskPayload({
    kind: "register",
    subject,
    stageId: "initial",
    configVersion: 7,
    packageAlias: "Auto-cut-lite",
    event: edge("opt_other", "opt_initial"),
  }, {
    documentLinks: ["https://guanghe.feishu.cn/docx/one"],
    namingDisplayValue: "课程001",
    namingValueUnique: true,
  });
  assert.equal(payload.binding.stageId, "initial");
  assert.equal(payload.controlledContext.namingDisplayValue, "课程001");
  assert.equal(Object.hasOwn(payload, "workspacePath"), false);
  assert.equal(Object.hasOwn(payload, "prompt"), false);
  assert.equal(Object.hasOwn(payload, "artifactTargetPath"), false);
});

test("controlled context endpoint requires Taskboard identity and shared secret", async (t) => {
  const app = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    bridgeSecret: "bridge-secret",
    getSubjectVersion: async (key, version) => key === subject.subjectKey && version === 7 ? subject : null,
    readControlledContext: async () => ({
      documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true,
    }),
  });
  const address = await app.listen();
  t.after(app.close);
  const body = {
    subjectKey: subject.subjectKey,
    configVersion: 7,
    baseToken: "bas_demo",
    tableId: "tbl_math",
    recordId: "rec-1",
  };
  const denied = await fetch(`http://127.0.0.1:${address.port}/api/feishu/workflow/controlled-context`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(denied.status, 403);
  const allowed = await fetch(`http://127.0.0.1:${address.port}/api/feishu/workflow/controlled-context`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-feishu-bridge-client": "taskboard",
      "x-feishu-bridge-secret": "bridge-secret",
    },
    body: JSON.stringify(body),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), {
    documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true,
  });
});

test("workflow sync returns a portable subject and never echoes local destinations", async (t) => {
  const app = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    bridgeSecret: "bridge-secret",
    syncSubject: async (value) => value,
  });
  const address = await app.listen();
  t.after(app.close);
  const response = await fetch(`http://127.0.0.1:${address.port}/api/feishu/workflow/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-feishu-bridge-client": "taskboard",
      "x-feishu-bridge-secret": "bridge-secret",
    },
    body: JSON.stringify({
      lifecycle: "enabled",
      expectedVersion: 1,
      subject: {
        subjectKey: subject.subjectKey,
        configVersion: 7,
        baseToken: subject.baseToken,
        tableId: subject.tableId,
        stages: { initial: { artifactTargetPath: "D:\\private" } },
      },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.subject.stages?.initial?.artifactTargetPath, undefined);
});

test("registers a phased task through the dedicated route after archiving the prior stage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-phased-bridge-"));
  const order = [];
  const bridge = createBridge({
    config: {
      delivery: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 1000, pollIntervalMs: 100 },
      tables: [subject],
      packages: { "Auto-cut-lite": { projectId: "p", projectName: "p", workspacePath: "D:\\trusted", prompt: "fixed" } },
    },
    store: new JsonStateStore(path.join(dir, "state.json")),
    workflowStore: { resolveSubjectVersionAt: async () => subject },
    readControlledContext: async () => ({ documentLinks: ["https://guanghe.feishu.cn/docx/one"], namingDisplayValue: "课程001", namingValueUnique: true }),
    taskboard: {
      listFeishuTasks: async () => [],
      registerFeishuStageTask: async (payload) => { order.push(`register:${payload.binding.stageId}`); return { id: "task-1", identifier: "FEI-1" }; },
    },
  });
  const result = await bridge.handle(edge("opt_initial", "opt_first", { eventId: "evt-move" }));
  assert.equal(result.kind, "register");
  assert.deepEqual(order, ["register:first_review"]);
});

test("archives a previous stage when the new target stage is disabled", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-phased-bridge-"));
  const order = [];
  const waiting = {
    id: "task-old",
    identifier: "FEI-OLD",
    version: 3,
    status: "todo",
    archivedAt: null,
    feishuOrigin: {
      baseToken: "bas_demo",
      tableId: "tbl_math",
      recordId: "rec-1",
      statusFieldId: "fld_status",
      stageId: "initial",
    },
  };
  const disabledFinal = structuredClone(subject);
  disabledFinal.stages.final_review.enabled = false;
  const bridge = createBridge({
    config: {
      delivery: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 1000, pollIntervalMs: 100 },
      tables: [disabledFinal],
      packages: { "Auto-cut-lite": { projectId: "p", projectName: "p", workspacePath: "D:\\trusted", prompt: "fixed" } },
    },
    store: new JsonStateStore(path.join(dir, "state.json")),
    workflowStore: { resolveSubjectVersionAt: async () => disabledFinal },
    taskboard: {
      listFeishuTasks: async () => [waiting],
      getTask: async () => waiting,
      archiveFeishuTask: async () => { order.push("archive"); return { ...waiting, archivedAt: new Date().toISOString() }; },
      registerFeishuStageTask: async () => { order.push("register"); return { id: "new", identifier: "FEI-NEW" }; },
    },
  });
  const result = await bridge.handle(edge("opt_initial", "opt_final", { eventId: "evt-disabled-target" }));
  assert.equal(result.kind, "ignored");
  assert.deepEqual(order, ["archive"]);
});

test("retries a phased registration from its persisted subject and context snapshot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "feishu-phased-bridge-"));
  let resolveCalls = 0;
  let contextCalls = 0;
  let registerCalls = 0;
  let clock = 1000;
  const bridge = createBridge({
    config: {
      delivery: { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 1000, pollIntervalMs: 100 },
      tables: [subject],
      packages: { "Auto-cut-lite": { projectId: "p", projectName: "p", workspacePath: "D:\\trusted", prompt: "fixed" } },
    },
    store: new JsonStateStore(path.join(dir, "state.json")),
    workflowStore: {
      resolveSubjectVersionAt: async () => { resolveCalls += 1; return subject; },
    },
    readControlledContext: async () => { contextCalls += 1; return { documentLinks: ["https://guanghe.feishu.cn/docx/one"], namingDisplayValue: "课程001", namingValueUnique: true }; },
    taskboard: {
      registerFeishuStageTask: async () => {
        registerCalls += 1;
        if (registerCalls === 1) throw Object.assign(new Error("temporary"), { code: "TASKBOARD_UNAVAILABLE" });
        return { id: "task-1", identifier: "FEI-1" };
      },
    },
    random: () => 0.5,
    now: () => clock,
  });
  const first = await bridge.handle(edge("opt_other", "opt_initial", { eventId: "evt-retry" }));
  assert.equal(first.kind, "pending");
  // The event is due immediately in this fixture; processDue claims the same
  // persisted record without resolving the current workflow again.
  clock = 2000;
  const second = await bridge.processDue();
  assert.equal(second.kind, "register");
  assert.equal(resolveCalls, 1);
  assert.equal(contextCalls, 1);
  assert.equal(registerCalls, 2);
});
