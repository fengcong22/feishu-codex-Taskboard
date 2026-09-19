import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridge } from "../src/bridge.mjs";
import { configuredTables, decideRecordChange } from "../src/decide-event.mjs";
import { normalizeBitableRecordChanged } from "../src/feishu-event.mjs";
import { JsonStateStore } from "../src/state-store.mjs";

function subjectConfig() {
  const stage = (fieldId, optionId, value) => ({
    enabled: true,
    trigger: { fieldId, optionId, value },
    videoSource: { kind: "docx_section", anchorText: "video" },
    reviewSource: { kind: "docx_section", anchorText: "review" },
    audio: { mode: "video_original" },
    nameSuffix: `_${value}`,
  });
  return {
    subjectKey: "bas_dual:tbl_dual", configVersion: 7, lifecycle: "enabled",
    baseToken: "bas_dual", tableId: "tbl_dual", tableName: "Dual status subject",
    statusField: {
      fieldId: "fld_initial", fieldName: "Initial progress",
      options: [{ id: "opt_shared", name: "Initial ready" }],
    },
    reviewStatusField: {
      fieldId: "fld_review", fieldName: "Review progress",
      options: [{ id: "opt_shared", name: "Review ready" }, { id: "opt_final", name: "Final ready" }],
    },
    documentField: { fieldId: "fld_doc", fieldName: "Document" },
    namingField: { fieldId: "fld_name", fieldName: "Course" },
    stages: {
      initial: stage("fld_initial", "opt_shared", "Initial ready"),
      first_review: stage("fld_review", "opt_shared", "Review ready"),
      final_review: stage("fld_review", "opt_final", "Final ready"),
    },
    execution: { mode: "manual" },
    upload: { enqueueMode: "manual" },
    packageRoute: { packageAlias: "auto-cut" },
    delivery: {
      version: 1,
      finalDirectoryTrigger: { enabled: true, fieldId: "fld_final_directory", optionId: "opt_directory" },
    },
  };
}

function eventPayload() {
  return {
    header: { event_id: "evt-dual" },
    event: {
      file_token: "bas_dual", table_id: "tbl_dual", record_id: "rec_dual", create_time: 1500,
      action_list: [{
        action: "record_edited",
        before_value: [
          { field_id: "fld_initial", field_value: '"opt_other"' },
          { field_id: "fld_review", field_value: '"opt_other"' },
          { field_id: "fld_final_directory", field_value: '"opt_other"' },
        ],
        after_value: [
          { field_id: "fld_initial", field_value: '"opt_shared"' },
          { field_id: "fld_review", field_value: '"opt_shared"' },
          { field_id: "fld_final_directory", field_value: '"opt_directory"' },
        ],
      }],
    },
  };
}

function edge(fieldId, beforeOptionId, afterOptionId) {
  return {
    eventId: `evt-${fieldId}`, baseToken: "bas_dual", tableId: "tbl_dual", recordId: "rec_dual",
    fieldId, statusFieldId: fieldId, fieldName: fieldId,
    beforePresent: true, afterPresent: true, beforeOptionId, afterOptionId,
    beforeValue: beforeOptionId, afterValue: afterOptionId,
    eventOccurredAt: 1500, eventOccurredAtPresent: true, fields: {}, fieldValuesById: {},
  };
}

test("the active listener retains both status field definitions", () => {
  const subject = subjectConfig();
  const [table] = configuredTables({ workflow: { bases: [{ baseToken: subject.baseToken, subjects: [subject] }] } });
  assert.deepEqual(table.reviewStatusField, subject.reviewStatusField);
  assert.equal(table.triggerFieldId, "fld_initial");
});

test("a draft keeps listening to both fields from the enabled snapshot", () => {
  const subject = subjectConfig();
  const draft = { ...subject, lifecycle: "draft", reviewStatusField: { fieldId: "fld_next" }, activeSnapshot: subject };
  const [table] = configuredTables({ workflow: { bases: [{ baseToken: subject.baseToken, subjects: [draft] }] } });
  assert.deepEqual(table.reviewStatusField, subject.reviewStatusField);
});

test("one action emits initial, review and final-directory events with independently stable IDs", () => {
  const subject = subjectConfig();
  const events = normalizeBitableRecordChanged(eventPayload(), subject);
  assert.deepEqual(events.map((event) => event.fieldId), ["fld_initial", "fld_review", "fld_final_directory"]);
  assert.deepEqual(events.map((event) => event.eventId), ["evt-dual", "evt-dual:fld_review", "evt-dual:fld_final_directory"]);
  assert.deepEqual(normalizeBitableRecordChanged(eventPayload(), subject), events);
  const withoutReview = { ...subject };
  delete withoutReview.reviewStatusField;
  const priorEvents = normalizeBitableRecordChanged(eventPayload(), withoutReview);
  assert.equal(priorEvents[0].eventId, events[0].eventId);
  assert.equal(priorEvents.at(-1).eventId, events.at(-1).eventId);
});

for (const mode of ["batched", "headerless"]) {
  test(`${mode} event IDs remain stable when the review field is enabled`, () => {
    const payload = eventPayload();
    if (mode === "batched") {
      payload.event.action_list.push({ ...payload.event.action_list[0], record_id: "rec_second" });
    } else {
      delete payload.header;
    }
    const subject = subjectConfig();
    const withoutReview = { ...subject };
    delete withoutReview.reviewStatusField;
    const priorEvents = normalizeBitableRecordChanged(payload, withoutReview);
    const events = normalizeBitableRecordChanged(payload, subject);
    const existingFields = events.filter((event) => event.fieldId !== "fld_review");
    assert.deepEqual(existingFields.map((event) => event.eventId), priorEvents.map((event) => event.eventId));
    assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
  });
}

test("field display values use options from their own status field", () => {
  const [event] = normalizeBitableRecordChanged({
    ...eventPayload(),
    event: { ...eventPayload().event, action_list: [{
      before_value: [{ field_id: "fld_review", field_value: '"opt_other"' }],
      after_value: [{ field_id: "fld_review", field_value: '"opt_shared"' }],
    }] },
  }, subjectConfig());
  assert.equal(event.afterValue, "Review ready");
  assert.equal(event.fieldName, "Review progress");
});

test("matching an option ID also requires the stage's field ID", () => {
  const subject = subjectConfig();
  const initial = decideRecordChange(subject, edge("fld_initial", "opt_other", "opt_shared"));
  const review = decideRecordChange(subject, edge("fld_review", "opt_other", "opt_shared"));
  assert.equal(initial.stageId, "initial");
  assert.equal(review.kind, "register");
  assert.equal(review.stageId, "first_review");
  assert.equal(review.table.triggerFieldId, "fld_review");
  assert.equal(review.table.triggerField, "Review progress");
  assert.equal(review.archiveWaiting, false);
  assert.equal(decideRecordChange(subject, edge("fld_initial", "opt_other", "opt_final")).kind, "ignored");
  assert.equal(decideRecordChange(subject, {
    ...edge("fld_review", "opt_other", "opt_shared"), statusFieldId: "fld_initial",
  }).kind, "ignored");
});

test("review stage transitions and departures retain the review archive scope", () => {
  const subject = subjectConfig();
  const move = decideRecordChange(subject, edge("fld_review", "opt_shared", "opt_final"));
  assert.equal(move.kind, "register");
  assert.equal(move.stageId, "final_review");
  assert.equal(move.previousStageId, "first_review");
  assert.equal(move.table.triggerFieldId, "fld_review");
  const departure = decideRecordChange(subject, edge("fld_review", "opt_shared", "opt_other"));
  assert.equal(departure.kind, "archive_waiting");
  assert.equal(departure.stageId, "first_review");
  assert.equal(departure.table.triggerFieldId, "fld_review");
});

test("old shared-field configurations still emit one event and move between stages", () => {
  const subject = subjectConfig();
  delete subject.reviewStatusField;
  subject.stages.first_review.trigger = { fieldId: "fld_initial", optionId: "opt_review", value: "Review ready" };
  subject.stages.final_review.trigger.fieldId = "fld_initial";
  const result = decideRecordChange(subject, edge("fld_initial", "opt_shared", "opt_review"));
  assert.equal(result.kind, "register");
  assert.equal(result.stageId, "first_review");
  assert.equal(result.previousStageId, "initial");
  subject.reviewStatusField = subject.statusField;
  assert.deepEqual(decideRecordChange(subject, edge("fld_initial", "opt_shared", "opt_review")).stageId, result.stageId);
  assert.equal(normalizeBitableRecordChanged(eventPayload(), subject).filter((event) => event.fieldId === "fld_initial").length, 1);
});

for (const afterOptionId of ["opt_other", "opt_final"]) {
  test(`review departure to ${afterOptionId} archives only waiting review tasks`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-dual-field-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const subject = subjectConfig();
    const tasks = [
      ["initial", "fld_initial", "initial", "todo"],
      ["review", "fld_review", "first_review", "todo"],
      ["running-review", "fld_review", "first_review", "in_progress"],
      ["other-field-review", "fld_initial", "first_review", "todo"],
    ].map(([id, statusFieldId, stageId, status]) => ({
      id, identifier: id, status, archivedAt: null, version: 1,
      feishuOrigin: { baseToken: subject.baseToken, tableId: subject.tableId, recordId: "rec_dual", statusFieldId, stageId },
    }));
    const calls = { listed: [], archived: [], registered: [] };
    const bridge = createBridge({
      config: {
        tables: [subject],
        packages: { "auto-cut": { projectId: "auto-cut", projectName: "Auto Cut", workspacePath: directory, prompt: "fixed" } },
        delivery: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1, leaseMs: 1000, pollIntervalMs: 100 },
      },
      store: new JsonStateStore(path.join(directory, "state.json")),
      workflowStore: { resolveSubjectVersionAt: async () => subject },
      readControlledContext: async () => ({ documentLinks: [], namingDisplayValue: "Course 1", namingValueUnique: true }),
      taskboard: {
        listFeishuTasks: async (scope) => { calls.listed.push(scope); return tasks; },
        getTask: async (id) => tasks.find((task) => task.id === id),
        archiveFeishuTask: async (task) => { calls.archived.push(task.id); return { ...task, archivedAt: 1 }; },
        registerFeishuStageTask: async (payload) => { calls.registered.push(payload); return { id: "new", identifier: "NEW-1" }; },
      },
    });
    const event = edge("fld_review", "opt_shared", afterOptionId);
    const outcome = await bridge.handle(event);
    assert.equal(outcome.kind, afterOptionId === "opt_final" ? "register" : "ignored");
    assert.deepEqual(calls.archived, ["review"]);
    assert.equal(calls.listed[0].statusFieldId, "fld_review");
    assert.equal(calls.listed[0].stageId, "first_review");
    if (afterOptionId === "opt_final") {
      assert.equal(calls.registered[0].binding.stageId, "final_review");
      assert.equal(calls.registered[0].event.statusFieldId, "fld_review");
    }
  });
}
