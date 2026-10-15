import assert from "node:assert/strict";
import test from "node:test";

import { decideVmInitialRecordChange } from "../src/vm-workflow-decision.mjs";

function subject(overrides = {}) {
  return {
    lifecycle: "enabled",
    workflowTemplate: { id: "vm_pmo_review_video", version: 1 },
    baseToken: "bas_test",
    tableId: "tbl_test",
    subjectKey: "bas_test:tbl_test",
    configVersion: 2,
    packageRoute: { packageAlias: "auto-cut-slicing" },
    statusField: { fieldId: "fld_status", fieldName: "制作进度", type: "single_select",
      options: [{ optionId: "opt_wait", value: "待处理" },
        { optionId: "opt_edit", value: "待剪辑" }, { optionId: "opt_done", value: "已完成" }] },
    vmWorkflow: {
      stages: {
        initial: { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_edit" },
        review: { enabled: false, statusFieldId: null, triggerOptionId: null },
      },
      finalArchive: { enabled: false },
    },
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    eventId: "evt_test",
    baseToken: "bas_test",
    tableId: "tbl_test",
    recordId: "rec_test",
    fieldId: "fld_status",
    statusFieldId: "fld_status",
    beforePresent: true,
    afterPresent: true,
    beforeOptionId: "opt_wait",
    afterOptionId: "opt_edit",
    ...overrides,
  };
}

test("registers an initial VM task only for an enabled, trusted option edge", () => {
  const actual = decideVmInitialRecordChange(subject(), event());
  assert.equal(actual.kind, "register");
  assert.equal(actual.stageId, "initial");
  assert.equal(actual.subjectKey, "bas_test:tbl_test");
  assert.equal(actual.configVersion, 2);
  assert.equal(actual.packageAlias, "auto-cut-slicing");
  assert.equal(actual.event.eventId, "evt_test");
});

test("VM decision accepts a controlled Chinese package alias and rejects paths", () => {
  assert.equal(decideVmInitialRecordChange(subject({ packageRoute: { packageAlias: "Auto-cut-化学" } }), event()).kind, "register");
  for (const packageAlias of ["../package", "D:\\private", "some package", "$(command)"]) {
    assert.equal(decideVmInitialRecordChange(subject({ packageRoute: { packageAlias } }), event()).kind, "blocked");
  }
});

test("leaving the initial trigger yields a todo-only archive intent", () => {
  const actual = decideVmInitialRecordChange(subject(), event({ beforeOptionId: "opt_edit", afterOptionId: "opt_done" }));
  assert.equal(actual.kind, "archive_waiting");
  assert.equal(actual.stageId, "initial");
  assert.equal(actual.previousStageId, "initial");
  assert.equal(actual.statusConstraint, "todo");
});

test("does not re-register unchanged or unrelated option edges", () => {
  assert.equal(decideVmInitialRecordChange(subject(), event({ beforeOptionId: "opt_edit" })).kind, "ignored");
  assert.equal(decideVmInitialRecordChange(subject(), event({ afterOptionId: "opt_done" })).kind, "ignored");
  assert.equal(decideVmInitialRecordChange(subject(), event({ fieldId: "fld_other", statusFieldId: "fld_other" })).kind, "ignored");
  assert.equal(decideVmInitialRecordChange(subject(), event({ tableId: "tbl_other" })).kind, "ignored");
});

test("blocks an unproven status edge", () => {
  for (const changed of [
    { beforePresent: false }, { afterPresent: false }, { beforeOptionId: null },
    { statusFieldId: "fld_other" }, { fieldId: "fld_other" },
  ]) {
    const actual = decideVmInitialRecordChange(subject(), event(changed));
    assert.notEqual(actual.kind, "register");
    assert.notEqual(actual.kind, "archive_waiting");
  }
});

test("simulations cannot register or archive production tasks", () => {
  for (const edge of [event(), event({ beforeOptionId: "opt_edit", afterOptionId: "opt_done" })]) {
    assert.equal(decideVmInitialRecordChange(subject(), { ...edge, deliverySource: "simulation" }).kind, "ignored");
  }
});

test("rejects non-active, unknown, and malformed workflow identities", () => {
  for (const changed of [
    { lifecycle: "draft" }, { workflowTemplate: undefined },
    { workflowTemplate: { id: "document_draft_zip", version: 1 } },
    { workflowTemplate: { id: "vm_pmo_review_video", version: 99 } },
    { workflowTemplate: { id: "vm_pmo_review_video", version: 1, extra: true } },
    { configVersion: null }, { packageRoute: { packageAlias: null } },
  ]) {
    assert.equal(decideVmInitialRecordChange(subject(changed), event()).kind, "blocked");
  }
});

test("rejects review, final archive, or non-single-select initial activation", () => {
  for (const changed of [
    { vmWorkflow: { ...subject().vmWorkflow, stages: { ...subject().vmWorkflow.stages,
      review: { enabled: true, statusFieldId: "fld_review", triggerOptionId: "opt_review" } } } },
    { vmWorkflow: { ...subject().vmWorkflow, finalArchive: { enabled: true } } },
    { statusField: { fieldId: "fld_status", type: "multi_select",
      options: [{ optionId: "opt_wait" }, { optionId: "opt_edit" }] } },
  ]) {
    assert.equal(decideVmInitialRecordChange(subject(changed), event()).kind, "blocked");
  }
});

test("malformed portable status field fails closed without throwing", () => {
  for (const statusField of [null, {}, { fieldId: "fld_status", options: null },
    { fieldId: "fld_status", type: "single_select", options: {} }]) {
    assert.equal(decideVmInitialRecordChange(subject({ statusField }), event()).kind, "blocked");
  }
});

test("unknown or ambiguous option IDs cannot trigger task effects", () => {
  assert.equal(decideVmInitialRecordChange(subject(), event({ beforeOptionId: "opt_unknown" })).kind, "blocked");
  assert.equal(decideVmInitialRecordChange(subject(), event({ afterOptionId: "opt_unknown" })).kind, "blocked");
  const duplicate = subject({ statusField: { fieldId: "fld_status", type: "single_select",
    options: [{ optionId: "opt_wait" }, { optionId: "opt_edit" }, { optionId: "opt_edit" }] } });
  assert.equal(decideVmInitialRecordChange(duplicate, event()).kind, "blocked");
});
