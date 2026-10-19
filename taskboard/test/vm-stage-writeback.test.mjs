import assert from "node:assert/strict";
import test from "node:test";

import { createVmStageWriteback } from "../server/vm-stage-writeback.mjs";

function fixture(overrides = {}) {
  const run = { runId: "run_vm", taskId: "task_vm", stageId: "initial", subjectKey: "bas_vm:tbl_vm",
    configVersion: 4, state: "running", runnerStartedAt: "2026-10-14T10:00:00.000Z",
    productionOrigin: true, target: { baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm" } };
  const subject = { lifecycle: "enabled", subjectKey: "bas_vm:tbl_vm", baseToken: "bas_vm",
    tableId: "tbl_vm", configVersion: 4,
    workflowTemplate: { id: "vm_pmo_review_video", version: 1 },
    metadata: { fields: [{ fieldId: "fld_status", fieldName: "制作进度", type: 3,
      uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待剪辑" },
        { id: "opt_review", name: "待修改" }, { id: "opt_processing", name: "剪辑中" },
        { id: "opt_complete", name: "初稿完成" }] }] },
    vmWorkflow: { fields: { outputAttachmentFieldId: "fld_output" }, stages: {
      initial: { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_ready", writeback: {
        processing: { fieldId: "fld_status", optionId: "opt_processing" },
        completed: { fieldId: "fld_status", optionId: "opt_complete" },
      } }, review: { enabled: false },
    }, finalArchive: { enabled: false } } };
  const liveFields = [{ field_id: "fld_status", field_name: "制作进度", type: 3,
    ui_type: "SingleSelect", property: { options: [
      { id: "opt_ready", name: "待剪辑" }, { id: "opt_review", name: "待修改" },
      { id: "opt_processing", name: "剪辑中" }, { id: "opt_complete", name: "初稿完成" },
    ] } }];
  const delivery = { runId: "run_vm", taskId: "task_vm", state: "delivered",
    fileToken: "file_vm", target: { baseToken: "bas_vm", tableId: "tbl_vm",
      recordId: "rec_vm", fieldId: "fld_output" } };
  const values = { run, subject, liveFields, delivery, ...overrides };
  const enqueued = [];
  const service = createVmStageWriteback({
    resolveTrustedRun: async () => values.run,
    getActiveSubject: async () => values.subject,
    listFields: async () => values.liveFields,
    getDelivery: async () => values.delivery,
    isLatestStageRun: async () => values.latest !== false,
    enqueueWritebackIntent: async (intent) => { enqueued.push(intent); return { id: "intent_vm" }; },
  });
  return { values, service, enqueued };
}

test("registers processing only after a production VM runner actually starts", async () => {
  const { service, enqueued } = fixture();
  assert.deepEqual(await service.enqueue({ runId: "run_vm", moment: "processing" }), { id: "intent_vm" });
  assert.deepEqual(enqueued, [{ idempotencyKey: "vm:run_vm:processing", taskId: "task_vm",
    runId: "run_vm", courseBindingId: null,
    operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_processing",
      guard: { fieldId: "fld_status", optionIds: ["opt_ready", "opt_processing"] } } }]);
  for (const patch of [{ runnerStartedAt: null }, { state: "prepared" }, { productionOrigin: false }]) {
    const bad = fixture(); Object.assign(bad.values.run, patch);
    await assert.rejects(() => bad.service.enqueue({ runId: "run_vm", moment: "processing" }),
      (error) => error.code === "VM_WRITEBACK_UNTRUSTED");
    assert.equal(bad.enqueued.length, 0);
  }
});

test("registers completion only after matching MP4 delivery readback", async () => {
  const { service, enqueued } = fixture();
  await service.enqueue({ runId: "run_vm", moment: "completed" });
  assert.equal(enqueued[0].idempotencyKey, "vm:run_vm:completed");
  assert.equal(enqueued[0].operation.optionId, "opt_complete");
  assert.deepEqual(enqueued[0].operation.guard,
    { fieldId: "fld_status", optionIds: ["opt_processing", "opt_complete"] });
  for (const patch of [{ state: "binding" }, { fileToken: null }, { taskId: "other" },
    { target: { baseToken: "bas_vm", tableId: "tbl_vm", recordId: "other", fieldId: "fld_output" } }]) {
    const bad = fixture(); Object.assign(bad.values.delivery, patch);
    await assert.rejects(() => bad.service.enqueue({ runId: "run_vm", moment: "completed" }),
      (error) => error.code === "VM_WRITEBACK_DELIVERY_UNCONFIRMED");
    assert.equal(bad.enqueued.length, 0);
  }
});

test("review completion uses the frozen review-stage writeback option", async () => {
  const { values, service, enqueued } = fixture();
  values.run.stageId = "review";
  values.subject.vmWorkflow.stages.review = { enabled: true, writeback: {
    processing: { fieldId: "fld_status", optionId: "opt_processing" },
    completed: { fieldId: "fld_status", optionId: "opt_review_complete" },
  } };
  values.subject.metadata.fields[0].options.push({ id: "opt_review_complete", name: "第1稿完成" });
  values.liveFields[0].property.options.push({ id: "opt_review_complete", name: "第1稿完成" });
  values.subject.vmWorkflow.stages.review.statusFieldId = "fld_status";
  values.subject.vmWorkflow.stages.review.triggerOptionId = "opt_review";
  await service.enqueue({ runId: "run_vm", moment: "completed" });
  assert.equal(enqueued[0].operation.optionId, "opt_review_complete");
  assert.deepEqual(enqueued[0].operation.guard,
    { fieldId: "fld_status", optionIds: ["opt_processing", "opt_review_complete"] });
});

test("rejects delayed writeback from a stage task replaced by a later review round", async () => {
  const { service, enqueued } = fixture({ latest: false });
  await assert.rejects(() => service.enqueue({ runId: "run_vm", moment: "completed" }),
    { code: "VM_WRITEBACK_STAGE_ADVANCED", status: 409 });
  assert.equal(enqueued.length, 0);
});

test("fails closed when active config or live metadata changes", async () => {
  const mutations = [
    (v) => { v.subject.configVersion = 5; },
    (v) => { v.subject.lifecycle = "draft"; },
    (v) => { v.liveFields[0].field_name = "已改名进度"; },
    (v) => { v.liveFields[0].type = 4; },
    (v) => { v.liveFields[0].property.options.find((option) => option.id === "opt_processing").name = "已改名选项"; },
    (v) => { v.liveFields[0].property.options.push({ id: "opt_processing", name: "重复项" }); },
    (v) => { v.subject.vmWorkflow.stages.initial.writeback.processing.optionId = null; },
    (v) => { v.subject.metadata.fields = []; },
    (v) => { v.liveFields = []; },
  ];
  for (const mutate of mutations) {
    const { values, service, enqueued } = fixture(); mutate(values);
    await assert.rejects(() => service.enqueue({ runId: "run_vm", moment: "processing" }),
      (error) => /^VM_WRITEBACK_/u.test(error.code));
    assert.equal(enqueued.length, 0);
  }
});

test("rejects run and record identity mismatches before looking up metadata", async () => {
  for (const mutate of [
    (v) => { v.run.subjectKey = "bas_other:tbl_vm"; },
    (v) => { v.run.runId = "run_other"; },
    (v) => { v.run.target.recordId = "rec_other"; v.delivery.target.recordId = "rec_vm"; },
  ]) {
    const { values, service, enqueued } = fixture(); mutate(values);
    await assert.rejects(() => service.enqueue({ runId: "run_vm", moment: "completed" }),
      (error) => /^VM_WRITEBACK_/u.test(error.code));
    assert.equal(enqueued.length, 0);
  }
});

test("accepts durable VM orchestration states only with actual render start evidence", async () => {
  for (const state of ["rendering", "rendered", "delivery_pending", "delivery_confirmed"]) {
    const { values, service, enqueued } = fixture(); values.run.state = state;
    await service.enqueue({ runId: "run_vm", moment: "processing" });
    assert.equal(enqueued.length, 1);
    values.run.runnerStartedAt = null;
    await assert.rejects(service.enqueue({ runId: "run_vm", moment: "processing" }), { code: "VM_WRITEBACK_UNTRUSTED" });
  }
});

test("delayed processing dispatch preserves actual render start after a failed outcome", async () => {
  for (const state of ["blocked", "needs_attention"]) {
    const { values, service, enqueued } = fixture(); values.run.state = state;
    await service.enqueue({ runId: "run_vm", moment: "processing" });
    assert.equal(enqueued[0].operation.optionId, "opt_processing");
    await assert.rejects(service.enqueue({ runId: "run_vm", moment: "completed" }), { code: "VM_WRITEBACK_UNTRUSTED" });
    values.run.runnerStartedAt = null;
    await assert.rejects(service.enqueue({ runId: "run_vm", moment: "processing" }), { code: "VM_WRITEBACK_UNTRUSTED" });
  }
});
