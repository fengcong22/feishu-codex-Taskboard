import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createFeishuWorkflowStore } from "../server/feishu-workflow-store.mjs";
import { createFeishuPackageWorkflowDrafts } from "../server/feishu-package-workflow-drafts.mjs";
import { validateSubjectConfig, portableSubject } from "../../src/workflow-config.mjs";

const KEY = "bas_vm:tbl_vm";
const TEMPLATE = { id: "vm_pmo_review_video", version: 1 };
const URL = `/api/local/feishu/subjects/${encodeURIComponent(KEY)}/package-workflow-drafts/vm`;
const fields = [
  { fieldId: "fld_vmid", fieldName: "原视频vmid", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_name", fieldName: "视频名", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_instruction", fieldName: "初稿意见", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_review_instruction", fieldName: "审核意见", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_output", fieldName: "成片", type: 17, uiType: "Attachment", options: [] },
  { fieldId: "fld_status", fieldName: "制作进度", type: 3, uiType: "SingleSelect", options: [
    { id: "opt_other", name: "准备" }, { id: "opt_initial", name: "待剪辑" },
    { id: "opt_review", name: "待修改" },
    { id: "opt_processing", name: "处理中" }, { id: "opt_complete", name: "完成" }, { id: "opt_archive", name: "归档" },
  ] },
];
const preview = () => ({ baseToken: "bas_vm", baseName: "测试", tables: [
  { tableId: "tbl_vm", tableName: "VM 测试", fields: structuredClone(fields) }] });

async function fixture(t, { ready = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-activation-"));
  const database = new TaskboardDatabase(path.join(directory, "state.sqlite"));
  const calls = [];
  let syncError = null, readiness = ready, beforeReady = null;
  const store = createFeishuWorkflowStore({ database, packageAliases: async () => ["vm", "zip"],
    validateVmWorkflowActivation: async (input) => { if (beforeReady) await beforeReady(input); return readiness; },
    syncSubject: async (subject, options) => {
      if (syncError) throw syncError;
      const { metadata: _metadata, projectId: _projectId, ...bridge } = subject;
      calls.push({ subject: validateSubjectConfig(bridge), options });
    },
  });
  const api = createFeishuPackageWorkflowDrafts({ database, workflowStore: store,
    packageStore: { get: async (alias) => ({ alias, state: "enabled", workflowTemplate: alias === "vm" ? TEMPLATE : undefined }) } });
  await store.upsertBasePreview(preview());
  const draft = (await api.handle({ method: "GET", pathname: URL })).body;
  const config = { ...draft.config, fields: { vmidFieldId: "fld_vmid", namingFieldId: "fld_name", outputAttachmentFieldId: "fld_output" },
    stages: { initial: { ...draft.config.stages.initial, enabled: true, statusFieldId: "fld_status",
      triggerOptionId: "opt_initial", instructionFieldId: "fld_instruction", writeback: {
        processing: { fieldId: "fld_status", optionId: "opt_processing" },
        completed: { fieldId: "fld_status", optionId: "opt_complete" } } }, review: draft.config.stages.review } };
  await api.handle({ method: "PUT", pathname: URL, body: { expectedRevision: 0, config } });
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  return { database, store, api, config, calls,
    failSync(error) { syncError = error; }, setReady(value) { readiness = value; }, onReady(fn) { beforeReady = fn; },
    enable(expectedVersion = 1, expectedRevision = 1) { return api.handle({ method: "POST", pathname: `${URL}/enable`, body: { expectedVersion, expectedRevision } }); },
    save(config, expectedRevision = 1) { return api.handle({ method: "PUT", pathname: URL, body: { expectedRevision, config } }); },
  };
}

test("VM profile activation freezes a canonical initial-only version and syncs without ZIP configuration", async (t) => {
  const f = await fixture(t);
  const enabled = (await f.enable()).body.subject;
  assert.equal(enabled.configVersion, 2);
  assert.equal(enabled.activePackageAlias, "vm");
  assert.equal(enabled.execution.mode, "automatic");
  assert.deepEqual(enabled.workflowTemplate, TEMPLATE);
  assert.deepEqual(enabled.vmWorkflow, f.config);
  assert.equal(enabled.upload, undefined);
  assert.equal(enabled.stages, undefined);
  assert.equal(enabled.documentField, undefined);
  assert.deepEqual(enabled.metadata.fields, fields);
  const snapshot = f.database.getFeishuSubjectVersion(KEY, 2);
  assert.deepEqual(snapshot.vmWorkflow, f.config);
  assert.equal(snapshot.lifecycle, "enabled");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].subject.statusField.options[1].value, "待剪辑");
  assert.deepEqual(portableSubject(f.calls[0].subject).vmWorkflow, f.config);
});

test("VM activation supports a configured final archive alongside the editing stages", async (t) => {
  const f = await fixture(t);
  const config = structuredClone(f.config);
  config.finalArchive = { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_archive",
    pathSource: "manual", directoryPath: "D:\\vm-archive", pathFieldId: null };
  await f.save(config);
  const enabled = (await f.enable(1, 2)).body.subject;
  assert.equal(enabled.vmWorkflow.finalArchive.enabled, true);
  assert.equal(enabled.vmWorkflow.finalArchive.directoryPath, "D:\\vm-archive");
});

test("VM activation freezes and syncs an enabled review stage", async (t) => {
  const f = await fixture(t);
  const config = structuredClone(f.config);
  config.stages.review = {
    ...config.stages.review,
    enabled: true,
    statusFieldId: "fld_status",
    triggerOptionId: "opt_review",
    instructionFieldId: "fld_review_instruction",
    writeback: {
      processing: { fieldId: "fld_status", optionId: "opt_processing" },
      completed: { fieldId: "fld_status", optionId: "opt_complete" },
    },
  };
  await f.save(config);
  const enabled = (await f.enable(1, 2)).body.subject;
  assert.deepEqual(enabled.vmWorkflow.stages.review, config.stages.review);
  assert.deepEqual(f.database.getFeishuSubjectVersion(KEY, 2).vmWorkflow.stages.review,
    config.stages.review);
  assert.deepEqual(f.calls[0].subject.vmWorkflow.stages.review, config.stages.review);
});

test("VM activation fails closed without runtime readiness and never synchronizes", async (t) => {
  const f = await fixture(t, { ready: false });
  await assert.rejects(f.enable(), { code: "PACKAGE_WORKFLOW_NOT_READY" });
  assert.equal((await f.store.getSubject(KEY)).configVersion, 1);
  assert.equal(f.calls.length, 0);
});

test("VM activation rechecks subject and profile revisions after asynchronous readiness", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.enable(1, 0), { code: "VERSION_CONFLICT" });
  await assert.rejects(f.enable(2, 1), { code: "VERSION_CONFLICT" });
  let changed = false;
  f.onReady(async () => { if (!changed) { changed = true; await f.save(f.config); } });
  await assert.rejects(f.enable(), { code: "VERSION_CONFLICT" });
  assert.equal(f.calls.length, 0);
});

test("failed Bridge validation rolls back VM subject and history", async (t) => {
  const f = await fixture(t);
  const before = await f.store.getSubject(KEY);
  const versions = f.database.listFeishuSubjectVersions(KEY);
  f.failSync(Object.assign(new Error("unavailable"), { code: "FEISHU_METADATA_UNAVAILABLE" }));
  await assert.rejects(f.enable(), { code: "FEISHU_METADATA_UNAVAILABLE" });
  assert.deepEqual(await f.store.getSubject(KEY), before);
  assert.deepEqual(f.database.listFeishuSubjectVersions(KEY), versions);
});

test("VM profile draft edits do not replace enabled snapshot and disable closes it", async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.save({ ...f.config, approval: { department: "动画组", reason: "另一次申请" } });
  assert.equal((await f.store.getSubject(KEY)).configVersion, 2);
  assert.equal(f.database.getFeishuSubjectVersion(KEY, 2).vmWorkflow.approval.reason, f.config.approval.reason);
  const disabled = await f.store.disableSubject(KEY, 2);
  assert.equal(disabled.configVersion, 3);
  assert.equal(disabled.lifecycle, "disabled");
  assert.ok(f.database.getFeishuSubjectVersion(KEY, 2).closedAt);
  assert.equal(disabled.activePackageAlias, null);
});

test("VM activation rejects missing required bindings", async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (config) => { config.fields.namingFieldId = null; },
    (config) => { config.stages.initial.instructionFieldId = null; },
    (config) => { config.approval.department = ""; },
  ]) {
    const config = structuredClone(f.config); mutate(config);
    const revision = (await f.api.handle({ method: "GET", pathname: URL })).body.revision;
    await f.save(config, revision);
    await assert.rejects(f.enable(1, revision + 1), (error) => ["VM_WORKFLOW_NOT_READY", "INVALID_FIELD"].includes(error.code));
  }
  assert.equal(f.calls.length, 0);
});

test("metadata refresh preserves VM bindings as a draft while the enabled snapshot stays frozen", async (t) => {
  const f = await fixture(t);
  await f.enable();
  const refreshed = preview();
  refreshed.tables[0].fields = refreshed.tables[0].fields.filter((field) => field.fieldId !== "fld_instruction");
  await f.store.upsertBasePreview(refreshed, { refreshExistingOnly: true });
  const current = await f.store.getSubject(KEY);
  assert.equal(current.lifecycle, "draft");
  assert.equal(current.configVersion, 3);
  assert.deepEqual(current.workflowTemplate, TEMPLATE);
  assert.equal(current.activeConfigVersion, 2);
  assert.equal(current.vmWorkflow.stages.initial.instructionFieldId, "fld_instruction");
  await assert.rejects(f.enable(3), (error) => ["VM_WORKFLOW_NOT_READY", "INVALID_FIELD"].includes(error.code));
});

test("ZIP profiles remain independently editable after switching the subject to VM", async (t) => {
  const f = await fixture(t);
  const zipUrl = URL.replace(/\/vm$/u, "/zip");
  const before = (await f.api.handle({ method: "GET", pathname: zipUrl })).body;
  await f.api.handle({ method: "PUT", pathname: zipUrl, body: { expectedRevision: 0, config: before.config } });
  await f.enable();
  const after = (await f.api.handle({ method: "GET", pathname: zipUrl })).body;
  assert.deepEqual(after.config, before.config);
  assert.equal(after.config.vmWorkflow, undefined);
  assert.equal(after.config.workflowTemplate, undefined);
});
