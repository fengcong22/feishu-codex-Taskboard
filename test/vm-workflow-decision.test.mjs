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

function sharedProgressSubject() {
  const configured = subject();
  configured.statusField.options.push(
    { optionId: "opt_wait_review", value: "待审核" },
    { optionId: "opt_review", value: "审核修改" },
    { optionId: "opt_archive", value: "归档" },
  );
  configured.vmWorkflow.stages.review = {
    enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_review",
  };
  configured.vmWorkflow.finalArchive = {
    enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_archive",
    pathSource: "manual", directoryPath: "D:\\archive", pathFieldId: null,
  };
  return configured;
}

function sharedProgressEvent(beforeOptionId, afterOptionId, overrides = {}) {
  return event({ beforeOptionId, afterOptionId,
    beforeOptionIds: [beforeOptionId], afterOptionIds: [afterOptionId], ...overrides });
}

for (const { name, before, after, kind, stageId, previousStageId, statusConstraint } of [
  { name: "pending to edit registers initial", before: "opt_wait", after: "opt_edit", kind: "register", stageId: "initial" },
  { name: "edit to processing leaves only waiting initial tasks", before: "opt_edit", after: "opt_done",
    kind: "archive_waiting", stageId: "initial", previousStageId: "initial", statusConstraint: "todo" },
  { name: "waiting review to review registers review", before: "opt_wait_review", after: "opt_review", kind: "register", stageId: "review" },
  { name: "repeated review does not register again", before: "opt_review", after: "opt_review", kind: "ignored" },
  { name: "waiting review to archive dispatches final archive", before: "opt_wait_review", after: "opt_archive", kind: "final_archive" },
  { name: "archive to review registers a new review", before: "opt_archive", after: "opt_review", kind: "register", stageId: "review" },
  { name: "review to processing leaves only waiting review tasks", before: "opt_review", after: "opt_done",
    kind: "archive_waiting", stageId: "review", previousStageId: "review", statusConstraint: "todo" },
]) {
  test(`shared progress field: ${name}`, () => {
    const actual = decideVmInitialRecordChange(sharedProgressSubject(), sharedProgressEvent(before, after));
    assert.equal(actual.kind, kind);
    assert.equal(actual.stageId, stageId);
    assert.equal(actual.previousStageId, previousStageId);
    assert.equal(actual.statusConstraint, statusConstraint);
    if (kind === "final_archive") assert.equal(actual.archive.triggerOptionId, "opt_archive");
  });
}

test("shared progress field still requires a proven archive edge before stage dispatch", () => {
  for (const malformed of [
    { beforePresent: false }, { afterPresent: false }, { beforeOptionIds: undefined },
    { afterOptionIds: undefined }, { beforeOptionIds: ["opt_unknown"] },
    { afterOptionIds: ["opt_review", "opt_review"] }, { eventId: "invalid id" },
    { recordId: "invalid id" }, { fieldId: "fld_other" }, { statusFieldId: "fld_other" },
  ]) {
    const actual = decideVmInitialRecordChange(sharedProgressSubject(),
      sharedProgressEvent("opt_wait_review", "opt_review", malformed));
    assert.equal(actual.kind, "blocked");
  }
});

test("shared stage dispatch rejects contradictory or multiple single-select option evidence", () => {
  for (const malformed of [
    { beforeOptionIds: ["opt_wait"] }, { afterOptionIds: ["opt_done"] },
    { beforeOptionIds: ["opt_wait_review", "opt_done"] },
    { afterOptionIds: ["opt_review", "opt_done"] },
    { beforeOptionIds: [] }, { afterOptionIds: [] },
  ]) {
    const actual = decideVmInitialRecordChange(sharedProgressSubject(),
      sharedProgressEvent("opt_wait_review", "opt_review", malformed));
    assert.equal(actual.kind, "blocked");
  }
});

test("shared progress field rejects untrusted sources before every dispatch", () => {
  for (const [before, after] of [
    ["opt_wait", "opt_edit"], ["opt_wait_review", "opt_review"], ["opt_wait_review", "opt_archive"],
  ]) {
    assert.equal(decideVmInitialRecordChange(sharedProgressSubject(),
      sharedProgressEvent(before, after, { deliverySource: "simulation" })).kind, "ignored");
    assert.equal(decideVmInitialRecordChange(sharedProgressSubject(),
      sharedProgressEvent(before, after, { deliverySource: "untrusted" })).kind, "blocked");
  }
});

test("separate stage fields remain independent from a multi-select archive field", () => {
  const configured = sharedProgressSubject();
  configured.reviewStatusField = { fieldId: "fld_review", type: "single_select", options: [
    { optionId: "opt_wait_review" }, { optionId: "opt_review" }, { optionId: "opt_done" },
  ] };
  configured.vmWorkflow.stages.review.statusFieldId = "fld_review";
  configured.vmWorkflow.finalArchive.statusFieldId = "fld_archive";
  configured.metadata = { fields: [{ fieldId: "fld_archive", type: "multi_select", options: [
    { id: "opt_keep" }, { id: "opt_archive" },
  ] }] };

  assert.equal(decideVmInitialRecordChange(configured, sharedProgressEvent("opt_wait", "opt_edit")).stageId, "initial");
  const review = decideVmInitialRecordChange(configured, sharedProgressEvent("opt_wait_review", "opt_review", {
    fieldId: "fld_review", statusFieldId: "fld_review",
  }));
  assert.equal(review.kind, "register");
  assert.equal(review.stageId, "review");
  assert.equal(review.archiveWaiting, undefined);
  const archiveEdge = event({ fieldId: "fld_archive", statusFieldId: "fld_archive",
    beforeOptionId: null, afterOptionId: null, beforeOptionIds: ["opt_keep"], afterOptionIds: ["opt_keep", "opt_archive"] });
  assert.equal(decideVmInitialRecordChange(configured, archiveEdge).kind, "final_archive");
  assert.equal(decideVmInitialRecordChange(configured, { ...archiveEdge,
    beforeOptionIds: ["opt_archive", "opt_keep"], afterOptionIds: ["opt_keep"] }).kind, "ignored");
  assert.equal(decideVmInitialRecordChange(configured, { ...archiveEdge,
    beforeOptionIds: [], afterOptionIds: ["opt_keep"] }).kind, "ignored");
});

test("registers an initial VM task only for an enabled, trusted option edge", () => {
  const actual = decideVmInitialRecordChange(subject(), event());
  assert.equal(actual.kind, "register");
  assert.equal(actual.stageId, "initial");
  assert.equal(actual.subjectKey, "bas_test:tbl_test");
  assert.equal(actual.configVersion, 2);
  assert.equal(actual.packageAlias, "auto-cut-slicing");
  assert.equal(actual.event.eventId, "evt_test");
});

test("registers an enabled review round only when its own status option is entered", () => {
  const configured = subject({
    statusField: { ...subject().statusField, options: [
      ...subject().statusField.options, { optionId: "opt_review", value: "审核修改" },
    ] },
    vmWorkflow: { ...subject().vmWorkflow, stages: { ...subject().vmWorkflow.stages,
      review: { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_review" } } },
  });
  const actual = decideVmInitialRecordChange(configured, event({ afterOptionId: "opt_review" }));
  assert.equal(actual.kind, "register");
  assert.equal(actual.stageId, "review");
  assert.equal(decideVmInitialRecordChange(configured,
    event({ beforeOptionId: "opt_review", afterOptionId: "opt_done" })).previousStageId, "review");
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

test("rejects final archive or non-single-select initial activation", () => {
  for (const changed of [
    { statusField: { fieldId: "fld_status", type: "multi_select",
      options: [{ optionId: "opt_wait" }, { optionId: "opt_edit" }] } },
  ]) {
    assert.equal(decideVmInitialRecordChange(subject(changed), event()).kind, "blocked");
  }
});

test("routes only an absent-to-present final archive option edge, including multi-select fields", () => {
  const configured = subject({
    metadata: { fields: [{ fieldId: "fld_archive", type: 4, uiType: "MultiSelect", options: [
      { id: "opt_keep", name: "保留" }, { id: "opt_archive", name: "归档" },
    ] }] },
    vmWorkflow: { ...subject().vmWorkflow, finalArchive: { enabled: true, statusFieldId: "fld_archive",
      triggerOptionId: "opt_archive", pathSource: "manual", directoryPath: "D:\\archive", pathFieldId: null } },
  });
  const change = event({ fieldId: "fld_archive", statusFieldId: "fld_archive",
    beforeOptionId: null, afterOptionId: null,
    beforeOptionIds: ["opt_keep"], afterOptionIds: ["opt_archive", "opt_keep"] });
  const actual = decideVmInitialRecordChange(configured, change);
  assert.equal(actual.kind, "final_archive");
  assert.equal(actual.archive.statusFieldId, "fld_archive");
  assert.equal(decideVmInitialRecordChange(configured, { ...change,
    beforeOptionIds: ["opt_archive"], afterOptionIds: ["opt_archive", "opt_keep"] }).kind, "ignored");
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
