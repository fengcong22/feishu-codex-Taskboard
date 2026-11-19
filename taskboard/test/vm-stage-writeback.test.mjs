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

function materialFixture() {
  const x = fixture();
  for (const options of [x.values.subject.metadata.fields[0].options, x.values.liveFields[0].property.options]) {
    options.push({ id: "opt_source", name: "素材已就绪" }, { id: "opt_failed", name: "下载失败" });
  }
  Object.assign(x.values.subject.vmWorkflow.stages.initial.writeback, {
    materialsReady: { fieldId: "fld_status", optionId: "opt_source" },
    downloadFailed: { fieldId: "fld_status", optionId: "opt_failed" },
  });
  Object.assign(x.values.run, { state: "ready", runnerStartedAt: undefined,
    acquisition: { sha256: "a".repeat(64) } });
  return x;
}

test("materials ready is written before render evidence and only from the trigger", async () => {
  const { service, enqueued } = materialFixture();
  await service.enqueue({ runId: "run_vm", moment: "materials_ready" });
  assert.deepEqual(enqueued[0], { idempotencyKey: "vm:run_vm:materials_ready", taskId: "task_vm",
    runId: "run_vm", courseBindingId: null, operation: { type: "single_select", fieldId: "fld_status",
      optionId: "opt_source", guard: { fieldId: "fld_status", optionIds: ["opt_ready", "opt_source"] } } });
  const waiting = materialFixture();
  Object.assign(waiting.values.run, { state: "waiting_materials", acquisition: undefined });
  await assert.rejects(() => waiting.service.enqueue({ runId: "run_vm", moment: "materials_ready" }),
    { code: "VM_WRITEBACK_UNTRUSTED" });
});

test("download failed requires the failed run and is keyed by its cause", async () => {
  const x = materialFixture();
  Object.assign(x.values.run, { state: "blocked", errorCode: "VM_DOWNLOAD_FAILED", acquisition: undefined });
  await x.service.enqueue({ runId: "run_vm", moment: "download_failed", slot: "auto" });
  await x.service.enqueue({ runId: "run_vm", moment: "download_failed", slot: `e${"b".repeat(32)}` });
  assert.deepEqual(x.enqueued.map((entry) => entry.idempotencyKey),
    ["vm:run_vm:download_failed:auto", `vm:run_vm:download_failed:e${"b".repeat(32)}`]);
  assert.deepEqual(x.enqueued[0].operation.guard,
    { fieldId: "fld_status", optionIds: ["opt_ready", "opt_source", "opt_failed"] });
  await assert.rejects(() => x.service.enqueue({ runId: "run_vm", moment: "download_failed", slot: "../x" }),
    { code: "VM_WRITEBACK_INPUT_INVALID" });
  x.values.run.errorCode = "VM_PMO_CONFIG_CHANGED";
  await assert.rejects(() => x.service.enqueue({ runId: "run_vm", moment: "download_failed", slot: "auto" }),
    { code: "VM_WRITEBACK_UNTRUSTED" });
});

test("processing also accepts both source statuses and unbound source options fail closed", async () => {
  const x = materialFixture();
  Object.assign(x.values.run, { state: "running", runnerStartedAt: "2026-10-14T10:00:00.000Z" });
  await x.service.enqueue({ runId: "run_vm", moment: "processing" });
  // A run that reported a failed download and then continued from the material it produced still
  // starts editing from the "下载失败" option; the guard must accept it alongside "素材已就绪".
  assert.deepEqual(x.enqueued[0].operation.guard,
    { fieldId: "fld_status", optionIds: ["opt_ready", "opt_source", "opt_failed", "opt_processing"] });
  const unbound = fixture();
  Object.assign(unbound.values.run, { state: "ready", runnerStartedAt: undefined, acquisition: {} });
  await assert.rejects(() => unbound.service.enqueue({ runId: "run_vm", moment: "materials_ready" }),
    { code: "VM_WRITEBACK_BINDING_MISSING" });
});

function notesFixture(text = "【AI 处理说明 · 初稿】\n结果：已停止") {
  const x = fixture();
  x.values.run = { ...x.values.run, state: "blocked", errorCode: "AI_INTENT_MISSING" };
  delete x.values.run.runnerStartedAt;
  x.values.subject.vmWorkflow.fields.aiNotesFieldId = "fld_notes";
  x.values.subject.metadata.fields.push({ fieldId: "fld_notes", fieldName: "AI 处理说明", type: 1, uiType: "Text" });
  x.values.liveFields.push({ field_id: "fld_notes", field_name: "AI 处理说明", type: 1, ui_type: "Text" });
  const service = createVmStageWriteback({
    resolveTrustedRun: async () => x.values.run, getActiveSubject: async () => x.values.subject,
    listFields: async () => x.values.liveFields, getDelivery: async () => x.values.delivery,
    isLatestStageRun: async () => true, enqueueWritebackIntent: async (intent) => intent,
    aiNotesText: async () => x.values.text, notesSlot: (value) => value ? `n${"a".repeat(31)}${value.length % 10}` : null,
  });
  x.values.text = text;
  return { ...x, service, slot: `n${"a".repeat(31)}${text.length % 10}` };
}

test("AI notes are written as text before render evidence and keyed by their content", async () => {
  const x = notesFixture();
  const intent = await x.service.plan({ runId: "run_vm", moment: "ai_notes", slot: x.slot });
  assert.equal(intent.idempotencyKey, `vm:run_vm:ai_notes:${x.slot}`);
  assert.deepEqual(intent.operation, { type: "text", fieldId: "fld_notes", value: x.values.text });
  // A queued note whose run evidence changed since no longer matches its slot.
  x.values.text = "different";
  await assert.rejects(x.service.plan({ runId: "run_vm", moment: "ai_notes", slot: x.slot }),
    { code: "VM_WRITEBACK_STAGE_ADVANCED" });
});

test("AI notes fail closed without a configured text field or in an unfinished run", async () => {
  const unbound = notesFixture();
  delete unbound.values.subject.vmWorkflow.fields.aiNotesFieldId;
  await assert.rejects(unbound.service.plan({ runId: "run_vm", moment: "ai_notes", slot: unbound.slot }),
    { code: "VM_WRITEBACK_BINDING_MISSING" });
  const retyped = notesFixture();
  retyped.values.liveFields.at(-1).type = 3;
  await assert.rejects(retyped.service.plan({ runId: "run_vm", moment: "ai_notes", slot: retyped.slot }),
    { code: "VM_WRITEBACK_FIELD_CHANGED" });
  const running = notesFixture();
  running.values.run.state = "planning";
  await assert.rejects(running.service.plan({ runId: "run_vm", moment: "ai_notes", slot: running.slot }),
    { code: "VM_WRITEBACK_UNTRUSTED" });
  await assert.rejects(running.service.plan({ runId: "run_vm", moment: "ai_notes", slot: "auto" }),
    { code: "VM_WRITEBACK_INPUT_INVALID" });
});
