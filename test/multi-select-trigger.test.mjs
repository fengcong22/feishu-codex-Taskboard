import assert from "node:assert/strict";
import test from "node:test";

import { decideRecordChange, zipPackageWorkflowErrorCode } from "../src/decide-event.mjs";
import { normalizeBitableRecordChanged } from "../src/feishu-event.mjs";
import { validateSubjectConfig } from "../src/workflow-config.mjs";

function subjectConfig(type = "multi_select") {
  const stage = (optionId, value) => ({
    enabled: true,
    trigger: { fieldId: "fld_progress", optionId, value },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "意见" },
    audio: { mode: "video_original" },
    nameSuffix: `_${value}`,
  });
  return {
    subjectKey: "bas_multi:tbl_multi", configVersion: 3, lifecycle: "enabled",
    baseToken: "bas_multi", tableId: "tbl_multi", tableName: "Multi-select progress",
    statusField: {
      fieldId: "fld_progress", fieldName: "剪辑进度", type,
      options: [
        { id: "opt_draft", name: "可剪初稿" }, { id: "opt_first", name: "可改初审" },
        { id: "opt_final", name: "可改终审" }, { id: "opt_note", name: "已备注" },
      ],
    },
    documentField: { fieldId: "fld_doc", fieldName: "审核文档" },
    namingField: { fieldId: "fld_name", fieldName: "课程名" },
    stages: {
      initial: stage("opt_draft", "可剪初稿"),
      first_review: stage("opt_first", "可改初审"),
      final_review: stage("opt_final", "可改终审"),
    },
    execution: { mode: "manual" },
    upload: { enqueueMode: "manual" },
    packageRoute: { packageAlias: "auto-cut-autoedit" },
  };
}

function setEdge(beforeOptionIds, afterOptionIds) {
  const one = (ids) => (ids.length === 1 ? ids[0] : null);
  return {
    eventId: "evt-multi", baseToken: "bas_multi", tableId: "tbl_multi", recordId: "rec_1",
    fieldId: "fld_progress", statusFieldId: "fld_progress", fieldName: "剪辑进度",
    beforePresent: beforeOptionIds.length > 0, afterPresent: afterOptionIds.length > 0,
    beforeOptionId: one(beforeOptionIds), afterOptionId: one(afterOptionIds),
    beforeOptionIds, afterOptionIds, beforeValue: "", afterValue: "",
    eventOccurredAt: 1, eventOccurredAtPresent: true, fields: {}, fieldValuesById: {},
  };
}

test("ticking a stage option on a multi-select field registers that stage", () => {
  const subject = subjectConfig();
  const fromEmpty = decideRecordChange(subject, setEdge([], ["opt_draft"]));
  assert.equal(fromEmpty.kind, "register");
  assert.equal(fromEmpty.stageId, "initial");
  const alongside = decideRecordChange(subject, setEdge(["opt_note"], ["opt_note", "opt_first"]));
  assert.equal(alongside.kind, "register");
  assert.equal(alongside.stageId, "first_review");
  assert.equal(alongside.archiveWaiting, false);
  const moved = decideRecordChange(subject, setEdge(["opt_first", "opt_note"], ["opt_note", "opt_final"]));
  assert.equal(moved.kind, "register");
  assert.equal(moved.stageId, "final_review");
  assert.equal(moved.previousStageId, "first_review");
});

test("unticking, unrelated options and two new stages at once do not start a run", () => {
  const subject = subjectConfig();
  const left = decideRecordChange(subject, setEdge(["opt_first", "opt_note"], ["opt_note"]));
  assert.equal(left.kind, "archive_waiting");
  assert.equal(left.stageId, "first_review");
  assert.equal(decideRecordChange(subject, setEdge(["opt_draft"], ["opt_draft", "opt_note"])).kind, "ignored");
  const both = decideRecordChange(subject, setEdge([], ["opt_first", "opt_final"]));
  assert.equal(both.kind, "blocked");
  assert.equal(both.reasonCode, "AMBIGUOUS_STATUS_EDGE");
  assert.equal(decideRecordChange(subject, { ...setEdge([], ["opt_draft"]), afterOptionIds: undefined }).reasonCode,
    "MISSING_STATUS_EDGE");
});

test("a single-select field keeps its strict edge rule", () => {
  const subject = subjectConfig("single_select");
  // single-select from an empty value is still not a known edge
  assert.equal(decideRecordChange(subject, setEdge([], ["opt_draft"])).reasonCode, "MISSING_STATUS_EDGE");
  assert.equal(decideRecordChange(subject, setEdge(["opt_note"], ["opt_draft"])).stageId, "initial");
});

test("the Bridge event carries the option sets of a multi-select field", () => {
  const [event] = normalizeBitableRecordChanged({
    header: { event_id: "evt-raw" },
    event: {
      file_token: "bas_multi", table_id: "tbl_multi", record_id: "rec_1", create_time: 1,
      action_list: [{
        action: "record_edited",
        before_value: [{ field_id: "fld_progress", field_value: '["opt_note"]' }],
        after_value: [{ field_id: "fld_progress", field_value: '["opt_note","opt_first"]' }],
      }],
    },
  }, subjectConfig());
  assert.deepEqual(event.afterOptionIds, ["opt_first", "opt_note"]);
  assert.equal(decideRecordChange(subjectConfig(), event).stageId, "first_review");
});

test("workflow config keeps the multi-select type of a stage trigger field", () => {
  assert.equal(validateSubjectConfig(subjectConfig()).statusField.type, "multi_select");
  assert.equal(validateSubjectConfig(subjectConfig("single_select")).statusField.type, "single_select");
});

test("document_edit_zip packages route like the Lite ZIP flow, VM packages do not", () => {
  assert.equal(zipPackageWorkflowErrorCode({ workflowTemplate: { id: "document_edit_zip", version: 1 }, artifactKind: "edit_zip" }), null);
  assert.equal(zipPackageWorkflowErrorCode({}), null);
  assert.equal(zipPackageWorkflowErrorCode({ workflowTemplate: { id: "vm_pmo_review_video", version: 1 } }), "PACKAGE_WORKFLOW_MISMATCH");
  assert.equal(zipPackageWorkflowErrorCode({ workflowTemplate: { id: "document_edit_zip", version: 1 } }), null);
  assert.equal(zipPackageWorkflowErrorCode({ workflowTemplate: { id: "document_edit_zip", version: 1 }, artifactKind: "zip" }), "PACKAGE_WORKFLOW_UNSUPPORTED");
});
