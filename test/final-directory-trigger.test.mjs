import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridge } from "../src/bridge.mjs";
import { configuredTables, decideRecordChange } from "../src/decide-event.mjs";
import { JsonStateStore } from "../src/state-store.mjs";
import { normalizeBitableRecordChanged } from "../src/feishu-event.mjs";

const subject = {
  subjectKey: "bas_final:tbl_course",
  configVersion: 3,
  lifecycle: "enabled",
  baseToken: "bas_final",
  tableId: "tbl_course",
  tableName: "课程",
  statusField: { fieldId: "fld_status", fieldName: "剪辑状态" },
  documentField: { fieldId: "fld_document", fieldName: "素材文档" },
  namingField: { fieldId: "fld_name", fieldName: "课程名称" },
  stages: {
    initial: {
      enabled: true,
      trigger: { fieldId: "fld_status", optionId: "opt_initial", value: "待初稿" },
      videoSource: { kind: "docx_section", anchorText: "视频" },
      reviewSource: { kind: "docx_section", anchorText: "意见" },
      audio: { mode: "video_original" },
      nameSuffix: "_初稿",
    },
    first_review: {
      enabled: false,
      trigger: { fieldId: "fld_status", optionId: "opt_review", value: "待初审" },
      videoSource: { kind: "docx_section", anchorText: "视频" },
      reviewSource: { kind: "docx_section", anchorText: "意见" },
      audio: { mode: "video_original" },
      nameSuffix: "_初审修改",
    },
    final_review: {
      enabled: false,
      trigger: { fieldId: "fld_status", optionId: "opt_review_final", value: "待终审" },
      videoSource: { kind: "docx_section", anchorText: "视频" },
      reviewSource: { kind: "docx_section", anchorText: "意见" },
      audio: { mode: "video_original" },
      nameSuffix: "_终审修改",
    },
  },
  execution: { mode: "manual" },
  packageRoute: { packageAlias: "Auto-cut-lite" },
  upload: { enabled: false, enqueueMode: "manual" },
  delivery: {
    version: 1,
    rootPath: null,
    courseNaming: { mode: "reuse_artifact_naming", fieldId: null },
    coursePathWriteback: { enabled: false, fieldId: null },
    writeback: {},
    finalDirectoryTrigger: { enabled: true, fieldId: "fld_final", optionId: "opt_final" },
  },
};

function edge(beforeOptionId, afterOptionId, overrides = {}) {
  return {
    eventId: "evt-final-directory",
    baseToken: "bas_final",
    tableId: "tbl_course",
    recordId: "rec_course_1",
    fieldId: "fld_final",
    fieldName: "成片状态",
    statusFieldId: "fld_final",
    beforePresent: true,
    afterPresent: true,
    beforeOptionId,
    afterOptionId,
    beforeValue: beforeOptionId,
    afterValue: afterOptionId,
    eventOccurredAt: 1_700_000_000_000,
    eventOccurredAtPresent: true,
    fields: {},
    fieldValuesById: {},
    ...overrides,
  };
}

test("an explicitly enabled final-directory rule emits only on entry to its configured option", () => {
  const entered = decideRecordChange(subject, edge("opt_other", "opt_final"));
  assert.equal(entered.kind, "directory_operation");
  assert.equal(entered.operationKind, "ensure_final_directory");
  assert.equal(entered.subjectKey, subject.subjectKey);
  assert.equal(entered.configVersion, subject.configVersion);

  const unchanged = decideRecordChange(subject, edge("opt_final", "opt_final"));
  assert.equal(unchanged.kind, "ignored");
  assert.equal(unchanged.reason, "already_at_final_directory_trigger");
  assert.equal(decideRecordChange(subject, edge("opt_final", "opt_other")).kind, "ignored");
  assert.equal(
    decideRecordChange(subject, edge("opt_other", "opt_final", { fieldId: "fld_other" })).kind,
    "ignored",
  );
  assert.equal(
    decideRecordChange({ ...subject, delivery: { ...subject.delivery, finalDirectoryTrigger: { enabled: false, fieldId: "fld_final", optionId: "opt_final" } } }, edge("opt_other", "opt_final")).kind,
    "ignored",
  );
});

test("event normalization preserves the configured final-directory select edge", () => {
  const [event] = normalizeBitableRecordChanged({
    header: { event_id: "evt-final-normalized" },
    event: {
      file_token: "bas_final",
      table_id: "tbl_course",
      record_id: "rec_course_1",
      action_list: [{
        action: "record_edited",
        before_value: [{ field_id: "fld_final", field_value: JSON.stringify("opt_other") }],
        after_value: [{ field_id: "fld_final", field_value: JSON.stringify("opt_final") }],
      }],
    },
  }, subject);
  assert.deepEqual(
    {
      fieldId: event.fieldId,
      statusFieldId: event.statusFieldId,
      beforeOptionId: event.beforeOptionId,
      afterOptionId: event.afterOptionId,
    },
    {
      fieldId: "fld_final",
      statusFieldId: "fld_final",
      beforeOptionId: "opt_other",
      afterOptionId: "opt_final",
    },
  );
});

test("event normalization preserves both a stage edge and final-directory edge in one record action", () => {
  const events = normalizeBitableRecordChanged({
    header: { event_id: "evt-combined-edges" },
    event: {
      file_token: "bas_final",
      table_id: "tbl_course",
      record_id: "rec_course_1",
      action_list: [{
        action: "record_edited",
        before_value: [
          { field_id: "fld_status", field_value: JSON.stringify("opt_other") },
          { field_id: "fld_final", field_value: JSON.stringify("opt_other") },
        ],
        after_value: [
          { field_id: "fld_status", field_value: JSON.stringify("opt_initial") },
          { field_id: "fld_final", field_value: JSON.stringify("opt_final") },
        ],
      }],
    },
  }, subject);

  assert.deepEqual(events.map((event) => event.fieldId), ["fld_status", "fld_final"]);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 2);
  assert.deepEqual(events.map((event) => decideRecordChange(subject, event).kind), ["register", "directory_operation"]);
});

test("the active workflow listener emits stable events for both watched select fields", () => {
  const [table] = configuredTables({
    workflow: {
      bases: [{ baseToken: subject.baseToken, subjects: [subject] }],
    },
  });
  const payload = {
    header: { event_id: "evt-active-workflow-combined" },
    event: {
      file_token: subject.baseToken,
      table_id: subject.tableId,
      record_id: "rec_course_1",
      action_list: [{
        action: "record_edited",
        before_value: [
          { field_id: "fld_status", field_value: JSON.stringify("opt_other") },
          { field_id: "fld_final", field_value: JSON.stringify("opt_other") },
        ],
        after_value: [
          { field_id: "fld_status", field_value: JSON.stringify("opt_initial") },
          { field_id: "fld_final", field_value: JSON.stringify("opt_final") },
        ],
      }],
    },
  };

  const events = normalizeBitableRecordChanged(payload, table);
  const replay = normalizeBitableRecordChanged(payload, table);

  assert.deepEqual(events.map((event) => event.fieldId), ["fld_status", "fld_final"]);
  assert.deepEqual(events.map((event) => event.eventId), [
    "evt-active-workflow-combined",
    "evt-active-workflow-combined:fld_final",
  ]);
  assert.deepEqual(replay.map((event) => event.eventId), events.map((event) => event.eventId));
  assert.deepEqual(events.map((event) => decideRecordChange(subject, event).kind), ["register", "directory_operation"]);
});

test("a stage event keeps its id when the final-directory trigger setting changes", () => {
  const payload = {
    header: { event_id: "evt-stage-id-stability" },
    event: {
      file_token: subject.baseToken,
      table_id: subject.tableId,
      record_id: "rec_course_1",
      action_list: [{
        action: "record_edited",
        before_value: [
          { field_id: "fld_status", field_value: JSON.stringify("opt_other") },
          { field_id: "fld_final", field_value: JSON.stringify("opt_other") },
        ],
        after_value: [
          { field_id: "fld_status", field_value: JSON.stringify("opt_initial") },
          { field_id: "fld_final", field_value: JSON.stringify("opt_final") },
        ],
      }],
    },
  };
  const tableWithFinalTrigger = {
    ...subject,
    triggerField: subject.statusField.fieldName,
    triggerFieldId: subject.statusField.fieldId,
  };
  const tableWithoutFinalTrigger = {
    ...tableWithFinalTrigger,
    delivery: {
      ...subject.delivery,
      finalDirectoryTrigger: { ...subject.delivery.finalDirectoryTrigger, enabled: false },
    },
  };

  const [statusWithFinalTrigger] = normalizeBitableRecordChanged(payload, tableWithFinalTrigger);
  const [statusWithoutFinalTrigger] = normalizeBitableRecordChanged(payload, tableWithoutFinalTrigger);

  assert.equal(statusWithFinalTrigger.fieldId, "fld_status");
  assert.equal(statusWithFinalTrigger.eventId, statusWithoutFinalTrigger.eventId);
});

test("a final-directory trigger uses the dedicated Taskboard operation without task registration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "final-directory-trigger-"));
  try {
    const calls = { directory: [], registration: 0, create: 0 };
    const bridge = createBridge({
      config: {
        tables: [subject],
        packages: {
          "Auto-cut-lite": {
            projectId: "autocut-lite",
            projectName: "Auto-Cut Lite",
            workspacePath: directory,
            prompt: "trusted prompt",
          },
        },
        delivery: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, leaseMs: 1_000, pollIntervalMs: 100 },
      },
      workflowStore: { resolveSubjectVersionAt: async () => subject },
      store: new JsonStateStore(path.join(directory, "state.json")),
      readControlledContext: async () => ({
        documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true, courseName: "课程001",
      }),
      taskboard: {
        ensureFinalDirectory: async (payload) => {
          calls.directory.push(payload);
          return { id: "directory-op-1", state: "succeeded" };
        },
        registerFeishuStageTask: async () => { calls.registration += 1; },
        createFeishuTask: async () => { calls.create += 1; },
      },
    });

    const outcome = await bridge.handle(edge("opt_other", "opt_final"));
    assert.deepEqual(outcome, {
      kind: "directory_operation",
      operationKind: "ensure_final_directory",
      operationId: "directory-op-1",
      subjectKey: subject.subjectKey,
      configVersion: subject.configVersion,
    });
    assert.equal(calls.registration, 0);
    assert.equal(calls.create, 0);
    assert.deepEqual(calls.directory, [{
      event: {
        eventId: "evt-final-directory",
        baseToken: "bas_final",
        tableId: "tbl_course",
        recordId: "rec_course_1",
        fieldId: "fld_final",
        beforeOptionId: "opt_other",
        afterOptionId: "opt_final",
        occurredAt: 1_700_000_000_000,
      },
      binding: { subjectKey: subject.subjectKey, configVersion: subject.configVersion },
      controlledContext: {
        documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true, courseName: "课程001",
      },
    }]);
    assert.deepEqual(await bridge.handle(edge("opt_other", "opt_final")), { ...outcome, duplicate: true });
    assert.equal(calls.directory.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a simulated final-directory trigger has no Taskboard or filesystem side effect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "final-directory-simulation-"));
  try {
    let operations = 0;
    const bridge = createBridge({
      config: {
        tables: [subject],
        packages: {
          "Auto-cut-lite": {
            projectId: "autocut-lite",
            projectName: "Auto-Cut Lite",
            workspacePath: directory,
            prompt: "trusted prompt",
          },
        },
        delivery: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, leaseMs: 1_000, pollIntervalMs: 100 },
      },
      workflowStore: { resolveSubjectVersionAt: async () => subject },
      store: new JsonStateStore(path.join(directory, "state.json")),
      readControlledContext: async () => ({
        documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true, courseName: "课程001",
      }),
      taskboard: { ensureFinalDirectory: async () => { operations += 1; } },
    });
    assert.deepEqual(
      await bridge.handle(edge("opt_other", "opt_final", { eventId: "evt-final-directory-sim", deliverySource: "simulation" })),
      { kind: "ignored", reason: "simulation_forbidden" },
    );
    assert.equal(operations, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
