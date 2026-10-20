import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TaskboardDatabase } from "../server/database.mjs";
import { createFeishuWorkflowStore } from "../server/feishu-workflow-store.mjs";
import { createFeishuPackageWorkflowDrafts } from "../server/feishu-package-workflow-drafts.mjs";

const SUBJECT = "bas_profiles:tbl_math";
const OTHER = "bas_profiles:tbl_physics";
const fields = [
  { fieldId: "fld_status", fieldName: "状态", type: 3, uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待剪辑" }] },
  { fieldId: "fld_doc", fieldName: "文档", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
];
const preview = () => ({ baseToken: "bas_profiles", baseName: "测试", tables: [
  { tableId: "tbl_math", tableName: "数学", fields: structuredClone(fields) },
  { tableId: "tbl_physics", tableName: "物理", fields: structuredClone(fields) },
] });
const url = (alias, subjectKey = SUBJECT) => `/api/local/feishu/subjects/${encodeURIComponent(subjectKey)}/package-workflow-drafts/${encodeURIComponent(alias)}`;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-zip-profiles-"));
  const filename = path.join(directory, "state.sqlite");
  const packages = new Map(["zip-a", "zip-b", "Auto-cut-A"].map((alias) => [alias, { alias, state: "enabled" }]));
  packages.set("vm", { alias: "vm", state: "enabled", workflowTemplate: { id: "vm_pmo_review_video", version: 1 } });
  const synced = [];
  let syncError = null;
  let beforeValidate = null;
  let database, store, api;
  function open() {
    database = new TaskboardDatabase(filename);
    store = createFeishuWorkflowStore({ database,
      packageAliases: async () => [...packages.values()].filter((p) => p.state === "enabled").map((p) => p.alias),
      validatePackageWorkflow: async () => { if (beforeValidate) await beforeValidate(); },
      syncSubject: async (subject, options) => {
        if (syncError) throw syncError;
        synced.push({ subject: structuredClone(subject), options });
      },
    });
    api = createFeishuPackageWorkflowDrafts({ database, workflowStore: store, packageStore: { get: async (alias) => packages.get(alias) } });
  }
  open();
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  await store.upsertBasePreview(preview());
  return {
    get database() { return database; }, get store() { return store; }, packages, synced,
    failSync(error) { syncError = error; }, onValidate(callback) { beforeValidate = callback; },
    reopen() { database.close(); open(); },
    get(alias = "zip-a", subject = SUBJECT) { return api.handle({ method: "GET", pathname: url(alias, subject) }).then((r) => r.body); },
    put(alias, config, expectedRevision = 0, subject = SUBJECT) { return api.handle({ method: "PUT", pathname: url(alias, subject), body: { expectedRevision, config } }).then((r) => r.body); },
    enable(alias, expectedRevision, expectedVersion) { return api.handle({ method: "POST", pathname: `${url(alias)}/enable`, body: { expectedRevision, expectedVersion } }); },
  };
}

test("ZIP profiles save independently without changing subjects, active versions or Bridge", async (t) => {
  const f = await fixture(t);
  const initial = await f.store.saveSubjectDraft(SUBJECT, { packageRoute: (await f.get("Auto-cut-A")).config.packageRoute });
  const active = await f.store.enableSubject(SUBJECT, initial.configVersion);
  const before = await f.store.getSubject(SUBJECT);
  const first = await f.get();
  assert.equal(first.revision, 0);
  assert.equal(first.config.execution.mode, "manual");
  assert.equal(first.config.upload.artifactSourcePath, null);
  assert.equal(first.config.delivery, undefined);
  assert.equal(first.config.packageRoute.packageAlias, "zip-a");
  const saved = await f.put("zip-a", { ...first.config, upload: { ...first.config.upload, targetPath: "C:\\zip-a" } });
  assert.equal(saved.revision, 1);
  await f.put("zip-b", { ...(await f.get("zip-b")).config, title: { fieldId: "fld_name", fieldName: "命名" } });
  await f.put("zip-a", { ...(await f.get("zip-a", OTHER)).config, execution: { ...first.config.execution, concurrencyGroup: "physics" } }, 0, OTHER);
  f.reopen();
  assert.deepEqual(await f.get(), saved);
  assert.equal((await f.get("zip-b")).config.upload.targetPath, null);
  assert.equal((await f.get("zip-a", OTHER)).config.execution.concurrencyGroup, "physics");
  const after = await f.store.getSubject(SUBJECT);
  assert.deepEqual(after.packageRoute, before.packageRoute);
  assert.equal(after.lifecycle, before.lifecycle);
  assert.equal(after.configVersion, before.configVersion);
  assert.equal(after.preferredPackageAlias, "zip-b");
  assert.equal(before.activePackageAlias, "Auto-cut-A");
  assert.equal(before.activeConfigVersion, active.configVersion);
  assert.equal(f.synced.length, 1);
});

test("saved ZIP editing package survives restart without changing the active route", async (t) => {
  const f = await fixture(t);
  const before = await f.store.getSubject(SUBJECT);
  const profile = await f.get("zip-b");
  await f.put("zip-b", profile.config);
  f.reopen();
  const subject = await f.store.getSubject(SUBJECT);
  assert.equal(subject.preferredPackageAlias, "zip-b");
  assert.equal(subject.packageRoute.packageAlias, before.packageRoute.packageAlias);
  assert.equal(subject.configVersion, before.configVersion);
  assert.equal(subject.lifecycle, before.lifecycle);
  assert.equal((await f.store.listCatalog())[0].subjects[0].preferredPackageAlias, "zip-b");

  f.database.database.prepare("DELETE FROM feishu_subject_editing_preferences WHERE subject_key = ?")
    .run(SUBJECT);
  f.reopen();
  assert.equal((await f.store.getSubject(SUBJECT)).preferredPackageAlias, "zip-b");
});

test("ZIP activation checks independent revisions and uses the next global subject version", async (t) => {
  const f = await fixture(t);
  const a = await f.put("zip-a", (await f.get()).config);
  const b = await f.put("zip-b", (await f.get("zip-b")).config);
  const initial = await f.store.getSubject(SUBJECT);
  await assert.rejects(f.enable("zip-a", 0, initial.configVersion), (e) => e.code === "VERSION_CONFLICT" && e.details.actualRevision === 1);
  const enabledA = (await f.enable("zip-a", a.revision, initial.configVersion)).body.subject;
  assert.equal(enabledA.configVersion, initial.configVersion + 1);
  assert.equal(enabledA.activePackageAlias, "zip-a");
  await assert.rejects(f.enable("zip-b", b.revision, initial.configVersion), (e) => e.code === "VERSION_CONFLICT" && e.details.actualVersion === enabledA.configVersion);
  const enabledB = (await f.enable("zip-b", b.revision, enabledA.configVersion)).body.subject;
  assert.equal(enabledB.configVersion, enabledA.configVersion + 1);
  assert.equal(enabledB.activePackageAlias, "zip-b");
  assert.equal(f.synced[1].options.expectedVersion, enabledA.configVersion);
  assert.equal((await f.get()).revision, a.revision);
  const versions = f.database.database.prepare("SELECT version, closed_at FROM feishu_subject_versions WHERE subject_key = ? AND lifecycle = 'enabled' ORDER BY version").all(SUBJECT);
  assert.ok(versions[0].closed_at);
  assert.equal(versions[1].closed_at, null);
});

test("ZIP activation rolls back completely when Bridge rejects synchronization", async (t) => {
  const f = await fixture(t);
  const a = await f.put("zip-a", (await f.get()).config);
  const enabled = (await f.enable("zip-a", a.revision, 1)).body.subject;
  const b = await f.put("zip-b", (await f.get("zip-b")).config);
  const beforeVersions = f.database.database.prepare("SELECT * FROM feishu_subject_versions").all();
  const beforeFailure = await f.store.getSubject(SUBJECT);
  f.failSync(Object.assign(new Error("offline"), { code: "BRIDGE_UNAVAILABLE" }));
  await assert.rejects(f.enable("zip-b", b.revision, enabled.configVersion), (e) => e.code === "BRIDGE_UNAVAILABLE");
  assert.deepEqual(await f.store.getSubject(SUBJECT), beforeFailure);
  assert.deepEqual(f.database.database.prepare("SELECT * FROM feishu_subject_versions").all(), beforeVersions);
  assert.deepEqual(await f.get("zip-b"), b);
});

test("legacy saves, imports and metadata refresh update the matching profile and invalidate stale editors", async (t) => {
  const f = await fixture(t);
  const a = await f.put("zip-a", (await f.get()).config);
  await f.store.saveSubjectDraft(SUBJECT, { expectedVersion: 1, packageRoute: a.config.packageRoute, execution: { concurrencyGroup: "legacy" } });
  const legacy = await f.get();
  assert.equal(legacy.revision, a.revision + 1);
  assert.equal(legacy.config.execution.concurrencyGroup, "legacy");
  await assert.rejects(f.put("zip-a", a.config, a.revision), (e) => e.code === "VERSION_CONFLICT");
  const share = await f.store.exportShareable();
  share.bases[0].subjects.find((s) => s.subjectKey === SUBJECT).execution.concurrencyGroup = "imported";
  await f.store.importShareable(share);
  assert.equal((await f.get()).config.execution.concurrencyGroup, "imported");
  const refreshed = preview();
  refreshed.tables[0].fields[0].options = [];
  const beforeRefresh = await f.get();
  await f.store.upsertBasePreview(refreshed, { refreshExistingOnly: true });
  const after = await f.get();
  assert.equal(after.revision, beforeRefresh.revision + 1);
  assert.equal(after.config.stages.initial.trigger.optionId, "pending_initial_option");
});

test("migration restores each package's latest historical snapshot without rewriting versions", async (t) => {
  const f = await fixture(t);
  await f.store.saveSubjectDraft(SUBJECT, { packageRoute: { packageAlias: "zip-a" }, upload: { targetPath: "C:\\history-a" } });
  await f.store.saveSubjectDraft(SUBJECT, { packageRoute: { packageAlias: "zip-b" }, upload: { targetPath: "C:\\history-b" } });
  f.database.database.prepare("DELETE FROM feishu_package_workflow_drafts").run();
  const versions = f.database.database.prepare("SELECT * FROM feishu_subject_versions").all();
  assert.equal((await f.get()).config.upload.targetPath, "C:\\history-a");
  assert.equal((await f.get("zip-b")).config.upload.targetPath, "C:\\history-b");
  assert.deepEqual(f.database.database.prepare("SELECT * FROM feishu_subject_versions").all(), versions);
});

test("ZIP profile validation rejects identity injection, cross-package routes and stale metadata", async (t) => {
  const f = await fixture(t);
  const config = (await f.get()).config;
  for (const key of ["metadata", "subjectKey", "configVersion", "lifecycle", "credentials", "displayEnabled"]) {
    await assert.rejects(f.put("zip-a", { ...config, [key]: "injected" }), (e) => e.code === "UNKNOWN_FIELD");
  }
  await assert.rejects(f.put("zip-a", { ...config, packageRoute: { ...config.packageRoute, packageAlias: "zip-b" } }), (e) => e.code === "PACKAGE_WORKFLOW_MISMATCH");
  const a = await f.put("zip-a", config);
  f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?").run(JSON.stringify({ fields: fields.filter((field) => field.fieldId !== "fld_status") }), SUBJECT);
  assert.equal((await f.get()).config.trigger.fieldId, "fld_status");
  await assert.rejects(f.enable("zip-a", a.revision, 1), (e) => ["TRIGGER_FIELD_NOT_FOUND", "FIELD_NOT_FOUND"].includes(e.code));
  assert.equal(f.synced.length, 0);
  await assert.rejects(f.enable("vm", 0, 1), (e) => e.code === "PACKAGE_WORKFLOW_NOT_READY");
});

test("activation rechecks the profile after asynchronous package validation", async (t) => {
  const f = await fixture(t);
  const a = await f.put("zip-a", (await f.get()).config);
  let called = false;
  f.onValidate(async () => {
    if (called) return;
    called = true;
    await f.put("zip-a", { ...a.config, execution: { ...a.config.execution, concurrencyGroup: "newer" } }, a.revision);
  });
  await assert.rejects(f.enable("zip-a", a.revision, 1), (e) => e.code === "VERSION_CONFLICT");
  assert.equal((await f.store.getSubject(SUBJECT)).configVersion, 1);
  assert.equal(f.synced.length, 0);
});

test("metadata refresh and disable retain independent edits to the active package profile", async (t) => {
  const f = await fixture(t);
  const a = await f.put("zip-a", (await f.get()).config);
  const active = (await f.enable("zip-a", a.revision, 1)).body.subject;
  await f.put("zip-a", { ...a.config, execution: { ...a.config.execution, concurrencyGroup: "new-draft" }, upload: { ...a.config.upload, targetPath: "C:\\draft-only" } }, a.revision);
  const refreshed = preview();
  refreshed.tables[0].fields[0].options = [];
  await f.store.upsertBasePreview(refreshed, { refreshExistingOnly: true });
  const afterRefresh = await f.get();
  assert.equal(afterRefresh.config.execution.concurrencyGroup, "new-draft");
  assert.equal(afterRefresh.config.upload.targetPath, "C:\\draft-only");
  assert.equal(afterRefresh.config.stages.initial.trigger.optionId, "pending_initial_option");
  assert.equal((await f.store.getSubject(SUBJECT)).activeConfigVersion, active.configVersion);
  const latest = await f.store.getSubject(SUBJECT);
  await f.store.disableSubject(SUBJECT, latest.configVersion);
  assert.deepEqual(await f.get(), afterRefresh);
});

test("ZIP activation requires saved drafts, enabled packages and bound artifact sources", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.enable("zip-a", 0, 1), (e) => e.code === "PACKAGE_WORKFLOW_DRAFT_UNSAVED");
  const original = (await f.get()).config;
  const saved = await f.put("zip-a", { ...original, upload: { ...original.upload, artifactSourceMode: "driver_report" } });
  await assert.rejects(f.enable("zip-a", saved.revision, 1), (e) => e.code === "ARTIFACT_SOURCE_PATH_UNBOUND");
  const valid = await f.put("zip-a", original, saved.revision);
  f.packages.get("zip-a").state = "disabled";
  await assert.rejects(f.enable("zip-a", valid.revision, 1), (e) => e.code === "UNKNOWN_PACKAGE_ALIAS");
  assert.equal((await f.store.getSubject(SUBJECT)).configVersion, 1);
  assert.equal(f.synced.length, 0);
});

test("removed aliases retain inaccessible profiles and template changes cannot reuse another profile", async (t) => {
  const f = await fixture(t);
  const saved = await f.put("zip-a", (await f.get()).config);
  f.packages.delete("zip-a");
  await assert.rejects(f.get(), (e) => e.code === "PACKAGE_NOT_FOUND");
  f.packages.set("zip-a", { alias: "zip-a", state: "enabled", workflowTemplate: { id: "vm_pmo_review_video", version: 1 } });
  const vm = await f.get();
  assert.equal(vm.revision, 0);
  assert.ok(vm.config.fields);
  f.packages.set("zip-a", { alias: "zip-a", state: "enabled" });
  assert.deepEqual(await f.get(), saved);
});

test("ZIP corruption is readable only as an error and never overwritten by a stale save", async (t) => {
  const f = await fixture(t);
  const saved = await f.put("zip-a", (await f.get()).config);
  f.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = '[]' WHERE package_alias = 'zip-a'").run();
  await assert.rejects(f.get(), (e) => e.code === "PACKAGE_WORKFLOW_DRAFT_INVALID");
  await assert.rejects(f.put("zip-a", saved.config, saved.revision), (e) => e.code === "PACKAGE_WORKFLOW_DRAFT_INVALID");
  await assert.rejects(f.enable("zip-a", saved.revision, 1), (e) => e.code === "PACKAGE_WORKFLOW_DRAFT_INVALID");
  assert.equal(f.database.database.prepare("SELECT config_json FROM feishu_package_workflow_drafts WHERE package_alias = 'zip-a'").get().config_json, "[]");
});

test("shared round-trip retains machine directories saved only in the matching package draft", async (t) => {
  const f = await fixture(t);
  const config = (await f.get()).config;
  const a = await f.put("zip-a", { ...config, delivery: { version: 1, rootPath: "C:\\active-delivery" } });
  await f.put("zip-a", {
    ...a.config,
    upload: { ...a.config.upload, artifactSourcePath: "C:\\draft-source", targetPath: "C:\\draft-upload" },
    stages: { ...a.config.stages, initial: { ...a.config.stages.initial, artifactTargetPath: "C:\\draft-stage" } },
    delivery: { ...a.config.delivery, rootPath: "C:\\draft-delivery" },
  }, a.revision);
  await f.store.saveSubjectDraft(SUBJECT, {
    expectedVersion: 1,
    packageRoute: { ...config.packageRoute, packageAlias: "zip-a" },
  });
  const beforeImport = await f.get();
  const shared = await f.store.exportShareable();
  shared.bases[0].subjects.find((s) => s.subjectKey === SUBJECT).execution.concurrencyGroup = "portable-update";
  await f.store.importShareable(shared);
  const imported = await f.get();
  assert.equal(imported.config.upload.artifactSourcePath, "C:\\draft-source");
  assert.equal(imported.config.upload.targetPath, "C:\\draft-upload");
  assert.equal(imported.config.stages.initial.artifactTargetPath, "C:\\draft-stage");
  assert.equal(imported.config.delivery.rootPath, "C:\\draft-delivery");
  assert.equal(imported.config.execution.concurrencyGroup, "portable-update");
  assert.equal(imported.revision, beforeImport.revision + 1);
  assert.equal((await f.store.getSubject(SUBJECT)).activeConfigVersion, null);
  assert.equal(f.synced.length, 0);
});

test("shared import restores target package paths and never copies the current package's directories", async (t) => {
  const f = await fixture(t);
  const a = await f.get();
  await f.store.saveSubjectDraft(SUBJECT, {
    packageRoute: a.config.packageRoute, upload: { targetPath: "C:\\package-a" }, delivery: { version: 1, rootPath: "C:\\package-a-delivery" },
  });
  const shared = await f.store.exportShareable();
  const importedSubject = shared.bases[0].subjects.find((s) => s.subjectKey === SUBJECT);
  importedSubject.packageRoute.packageAlias = "zip-b";
  const b = (await f.get("zip-b")).config;
  await f.put("zip-b", { ...b, upload: { ...b.upload, targetPath: "C:\\package-b" }, delivery: { version: 1, rootPath: "C:\\package-b-delivery" } });
  await f.store.importShareable(shared);
  assert.equal((await f.get("zip-b")).config.upload.targetPath, "C:\\package-b");
  assert.equal((await f.get("zip-b")).config.delivery.rootPath, "C:\\package-b-delivery");
  assert.equal((await f.get()).config.upload.targetPath, "C:\\package-a");
  f.packages.set("zip-new", { alias: "zip-new", state: "enabled" });
  importedSubject.packageRoute.packageAlias = "zip-new";
  await f.store.importShareable(shared);
  const fresh = await f.get("zip-new");
  assert.equal(fresh.config.upload.targetPath, null);
  assert.equal(fresh.config.delivery.rootPath, null);
  assert.equal(fresh.config.stages.initial.artifactTargetPath, null);
});

test("partial legacy PATCH preserves untouched fields saved in the associated independent profile", async (t) => {
  const f = await fixture(t);
  const initial = await f.get("Auto-cut-A");
  const saved = await f.put("Auto-cut-A", {
    ...initial.config, execution: { ...initial.config.execution, concurrencyGroup: "independent-edit" },
    upload: { ...initial.config.upload, targetPath: "C:\\saved-only" },
  }, initial.revision);
  const patched = await f.store.saveSubjectDraft(SUBJECT, {
    expectedVersion: 1, packageRoute: initial.config.packageRoute, title: { fieldId: "fld_name", fieldName: "命名" },
  });
  assert.equal(patched.execution.concurrencyGroup, "independent-edit");
  assert.equal(patched.upload.targetPath, "C:\\saved-only");
  const profile = await f.get("Auto-cut-A");
  assert.equal(profile.revision, saved.revision + 1);
  assert.equal(profile.config.execution.concurrencyGroup, "independent-edit");
  assert.equal(profile.config.upload.targetPath, "C:\\saved-only");
  assert.equal(profile.config.title.fieldId, "fld_name");
  assert.equal(f.synced.length, 0);
});

test("ZIP draft saves retain empty required bindings while activation stays strict and active snapshots stay unchanged", async (t) => {
  const f = await fixture(t);
  const subject = await f.store.saveSubjectDraft(SUBJECT, { packageRoute: (await f.get("Auto-cut-A")).config.packageRoute });
  await f.store.enableSubject(SUBJECT, subject.configVersion);
  const before = await f.store.getSubject(SUBJECT);
  const complete = (await f.get()).config;
  const missing = structuredClone(complete);
  missing.documentField = { fieldId: "", fieldName: "" };
  missing.namingField = { fieldId: null, fieldName: null };
  missing.statusField = { fieldId: "", fieldName: "" };
  missing.stages.initial.trigger = { fieldId: "", fieldName: "", optionId: null, value: "" };
  for (const stageId of ["first_review", "final_review"]) missing.stages[stageId].trigger = { fieldId: null, fieldName: null, optionId: null, value: null };
  missing.stages.initial.videoSource = { kind: "base_attachment", fieldId: "" };
  missing.stages.initial.audio = { mode: "replace_original", source: { kind: "base_attachment", fieldId: null }, durationToleranceSeconds: 3 };
  const saved = await f.put("zip-a", missing);
  assert.equal(saved.config.documentField.fieldId, "pending_document_field");
  assert.equal(saved.config.namingField.fieldId, "pending_naming_field");
  assert.equal(saved.config.statusField.fieldId, "pending_status_field");
  assert.equal(saved.config.stages.initial.trigger.optionId, "pending_initial_option");
  assert.equal(saved.config.stages.initial.videoSource.fieldId, "pending_attachment_field");
  assert.equal(saved.config.stages.initial.audio.source.fieldId, "pending_attachment_field");
  assert.deepEqual(await f.get(), saved);
  assert.deepEqual((await f.store.getSubject(SUBJECT)).activeConfigVersion, before.activeConfigVersion);
  assert.equal((await f.store.getSubject(SUBJECT)).configVersion, before.configVersion);
  await assert.rejects(f.enable("zip-a", saved.revision, before.configVersion), (e) => ["FIELD_NOT_FOUND", "TRIGGER_FIELD_NOT_FOUND"].includes(e.code));
  const repaired = await f.put("zip-a", complete, saved.revision);
  const enabled = await f.enable("zip-a", repaired.revision, before.configVersion);
  assert.equal(enabled.body.subject.lifecycle, "enabled");
});

test("pending ZIP bindings do not suppress validation of selected fields, options or audio", async (t) => {
  const f = await fixture(t);
  const config = (await f.get()).config;
  const partial = { ...config, documentField: { fieldId: "pending_document_field", fieldName: "待配置" } };
  for (const [name, modify, code] of [
    ["invalid status", (c) => { c.statusField = { fieldId: "missing_status", fieldName: "状态" }; c.stages.initial.trigger.fieldId = "missing_status"; }, "FIELD_NOT_FOUND"],
    ["wrong status type", (c) => { c.statusField = { fieldId: "fld_doc", fieldName: "文档" }; c.stages.initial.trigger.fieldId = "fld_doc"; c.stages.initial.trigger.fieldName = "文档"; }, "FIELD_TYPE_INVALID"],
    ["invalid option", (c) => { c.stages.initial.trigger.optionId = "missing_option"; }, "TRIGGER_OPTION_NOT_FOUND"],
    ["wrong attachment", (c) => { c.stages.initial.videoSource = { kind: "base_attachment", fieldId: "fld_doc" }; }, "FIELD_TYPE_INVALID"],
    ["bad audio", (c) => { c.stages.initial.audio = { mode: "arbitrary" }; }, "INVALID_FIELD"],
  ]) {
    const value = structuredClone(partial); modify(value);
    await assert.rejects(f.put("zip-a", value), (e) => e.code === code, name);
  }
  const duplicateFields = [...structuredClone(fields), structuredClone(fields[0])];
  f.database.database.prepare("UPDATE feishu_subjects SET metadata_json=? WHERE subject_key=?").run(JSON.stringify({ fields: duplicateFields }), SUBJECT);
  await assert.rejects(f.put("zip-a", partial), (e) => e.code === "FIELD_NOT_UNIQUE");
  const duplicateOptions = structuredClone(fields);
  duplicateOptions[0].options.push({ id: "opt_ready", name: "重复" });
  f.database.database.prepare("UPDATE feishu_subjects SET metadata_json=? WHERE subject_key=?").run(JSON.stringify({ fields: duplicateOptions }), SUBJECT);
  await assert.rejects(f.put("zip-a", partial), (e) => e.code === "TRIGGER_OPTION_NOT_UNIQUE");
});

test("legacy ZIP draft PATCH preserves empty bindings as pending and can later be repaired and enabled", async (t) => {
  const f = await fixture(t);
  const subject = await f.store.saveSubjectDraft(SUBJECT, { packageRoute: (await f.get("Auto-cut-A")).config.packageRoute });
  const active = await f.store.enableSubject(SUBJECT, subject.configVersion);
  const saved = await f.store.saveSubjectDraft(SUBJECT, { expectedVersion: active.configVersion,
    documentField: { fieldId: null, fieldName: null }, namingField: { fieldId: "", fieldName: "" },
  });
  assert.equal(saved.documentField.fieldId, "pending_document_field");
  assert.equal(saved.namingField.fieldId, "pending_naming_field");
  assert.equal(saved.activeConfigVersion, active.configVersion);
  await assert.rejects(f.store.enableSubject(SUBJECT, saved.configVersion), (e) => e.code === "FIELD_NOT_FOUND");
  const repaired = await f.store.saveSubjectDraft(SUBJECT, { expectedVersion: saved.configVersion,
    documentField: subject.documentField, namingField: subject.namingField,
  });
  assert.equal((await f.store.enableSubject(SUBJECT, repaired.configVersion)).lifecycle, "enabled");
});

test("legacy PATCH keeps its current baseline for a new alias while independent defaults remain manual", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.store.getSubject(SUBJECT)).execution.mode, "automatic");
  assert.equal((await f.get()).config.execution.mode, "manual");
  const patched = await f.store.saveSubjectDraft(SUBJECT, { expectedVersion: 1, packageRoute: { packageAlias: "zip-a" } });
  assert.equal(patched.execution.mode, "automatic");
  assert.equal((await f.get()).config.execution.mode, "automatic");
});
