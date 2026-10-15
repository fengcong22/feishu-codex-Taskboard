import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTaskboardServer } from "../server/index.mjs";
import { createFeishuSubjectShareApi } from "../server/feishu-subject-share.mjs";
import { createFeishuWorkflowStore } from "../server/feishu-workflow-store.mjs";

const SOURCE = "bas_source:tbl_source";
const TARGET = "bas_target:tbl_target";
const SHARE = "/api/local/feishu/workflow/subject-share";
function fields(prefix) {
  return [
    { fieldId: `${prefix}_status`, fieldName: "状态", type: 3, uiType: "SingleSelect", options: [
      { id: `${prefix}_ready`, name: "待剪辑" }, { id: `${prefix}_processing`, name: "剪辑中" },
    ] },
    { fieldId: `${prefix}_doc`, fieldName: "文档", type: 1, uiType: "Text", options: [] },
    { fieldId: `${prefix}_name`, fieldName: "命名", type: 20, uiType: "Formula", options: [] },
    { fieldId: `${prefix}_attachment`, fieldName: "视频", type: 17, uiType: "Attachment", options: [] },
  ];
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "subject-share-"));
  const app = createTaskboardServer({ dataDirectory: directory, codexExecutable: process.execPath,
    feishuPackages: { packages: { "Auto-cut-A": { projectId: "auto-cut", workspacePath: directory, prompt: "test" } } },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(route, body, method = body ? "POST" : "GET") {
    const r = await fetch(`http://127.0.0.1:${address.port}${route}`, { method,
      headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  }
  for (const [baseToken, tableId, prefix] of [["bas_source", "tbl_source", "src"], ["bas_target", "tbl_target", "dst"]]) {
    const r = await request("/api/local/feishu/workflow/catalog", { baseToken, baseName: baseToken,
      tables: [{ tableId, tableName: tableId, fields: fields(prefix) }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const db = app.database.database;
  const snapshot = () => Object.fromEntries(["feishu_bases", "feishu_subjects", "feishu_subject_versions", "feishu_package_workflow_drafts", "feishu_subject_editing_preferences", "projects"].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  const getProfile = async (subjectKey = SOURCE) => (await request(`/api/local/feishu/subjects/${encodeURIComponent(subjectKey)}/package-workflow-drafts/Auto-cut-A`)).body;
  const profile = await getProfile();
  const route = await request(`/api/local/feishu/workflow/subjects/${encodeURIComponent(SOURCE)}`, { packageRoute: profile.config.packageRoute }, "PATCH");
  assert.equal(route.status, 200, JSON.stringify(route.body));
  const sourceRevision = (await getProfile()).revision;
  const saved = await request(`/api/local/feishu/subjects/${encodeURIComponent(SOURCE)}/package-workflow-drafts/Auto-cut-A`, {
    expectedRevision: sourceRevision, config: { ...profile.config,
      execution: { ...profile.config.execution, concurrencyGroup: "shared-draft" },
      upload: { ...profile.config.upload, artifactSourcePath: "C:\\private-source" },
    },
  }, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const target = (await request(`/api/local/feishu/workflow/subjects/${encodeURIComponent(TARGET)}`)).body.subject;
  const exportShare = () => request(`${SHARE}/export?subjectKey=${encodeURIComponent(SOURCE)}&packageAlias=Auto-cut-A`);
  const preview = (configuration, extra = {}) => request(`${SHARE}/import`, { configuration, targetSubjectKey: TARGET, expectedVersion: target.configVersion, dryRun: true, ...extra });
  const commit = (configuration, p, extra = {}) => request(`${SHARE}/import`, { configuration, targetSubjectKey: TARGET,
    expectedVersion: p.expectedVersion, expectedRevision: p.expectedRevision, dryRun: false, ...extra });
  return { request, db, database: app.database, snapshot, getProfile, exportShare, preview, commit, target };
}

test("subject export uses the selected saved draft and removes machine paths", async (t) => {
  const f = await fixture(t);
  const r = await f.exportShare();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.body.configuration;
  assert.equal(c.kind, "feishu-subject-workflow");
  assert.equal(c.source.subjectKey, SOURCE);
  assert.equal(c.config.execution.concurrencyGroup, "shared-draft");
  assert.equal(c.config.upload.artifactSourcePath, null);
  assert.doesNotMatch(JSON.stringify(c), /private-source|workspacePath|prompt/);
});

test("subject import remaps fields and options without changing source, catalog, or live target", async (t) => {
  const f = await fixture(t);
  const { body: exported } = await f.exportShare();
  const before = f.snapshot();
  const p = await f.preview(exported.configuration);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(f.snapshot(), before);
  const r = await f.commit(exported.configuration, p.body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = f.snapshot();
  for (const table of ["feishu_bases", "feishu_subjects", "feishu_subject_versions", "projects"]) assert.deepEqual(after[table], before[table]);
  const profile = await f.getProfile(TARGET);
  assert.equal(profile.config.statusField.fieldId, "dst_status");
  assert.equal(profile.config.stages.initial.trigger.optionId, "dst_ready");
  assert.equal(profile.config.namingField.fieldId, "dst_name");
  assert.equal(profile.config.execution.concurrencyGroup, "shared-draft");
  assert.equal(profile.config.upload.artifactSourcePath, null);
  assert.deepEqual(after.feishu_package_workflow_drafts.filter((r) => r.subject_key === SOURCE), before.feishu_package_workflow_drafts.filter((r) => r.subject_key === SOURCE));
});

test("legacy multi-subject input requires selection and never restores removed source subjects", async (t) => {
  const f = await fixture(t);
  const exported = await f.request("/api/local/feishu/workflow/share/export");
  const configuration = exported.body.configuration;
  const missing = await f.preview(configuration);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "SHARE_SOURCE_REQUIRED");
  await f.request(`/api/local/feishu/workflow/subjects/${encodeURIComponent(SOURCE)}`, {}, "DELETE");
  const before = f.snapshot();
  const p = await f.preview(configuration, { sourceSubjectKey: SOURCE });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const r = await f.commit(configuration, p.body, { sourceSubjectKey: SOURCE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(f.snapshot().feishu_subjects, before.feishu_subjects);
  assert.deepEqual(f.snapshot().feishu_bases, before.feishu_bases);
});

test("subject import rejects stale versions and revisions and removed targets", async (t) => {
  const f = await fixture(t);
  const { body: e } = await f.exportShare();
  const p = await f.preview(e.configuration);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const bad = await f.commit(e.configuration, p.body, { expectedVersion: p.body.expectedVersion + 1 });
  assert.equal(bad.status, 409);
  assert.equal((await f.commit(e.configuration, p.body)).status, 200);
  assert.equal((await f.commit(e.configuration, p.body)).status, 409);
  await f.request(`/api/local/feishu/workflow/subjects/${encodeURIComponent(TARGET)}`, {}, "DELETE");
  assert.equal((await f.preview(e.configuration)).status, 404);
});

test("ambiguous target names and options remain repairable rather than keeping source IDs", async (t) => {
  const f = await fixture(t);
  const { body: e } = await f.exportShare();
  const row = f.db.prepare("SELECT metadata_json FROM feishu_subjects WHERE subject_key=?").get(TARGET);
  const metadata = JSON.parse(row.metadata_json);
  metadata.fields.push({ ...metadata.fields.find((field) => field.fieldId === "dst_name"), fieldId: "dst_duplicate_name" });
  metadata.fields.find((field) => field.fieldId === "dst_status").options.push({ id: "dst_duplicate_ready", name: "待剪辑" });
  f.db.prepare("UPDATE feishu_subjects SET metadata_json=? WHERE subject_key=?").run(JSON.stringify(metadata), TARGET);
  const p = await f.preview(e.configuration);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.ok(p.body.diagnostics.some((d) => d.code === "FIELD_NOT_UNIQUE"));
  assert.ok(p.body.diagnostics.some((d) => d.code === "OPTION_NOT_UNIQUE"));
  assert.equal((await f.commit(e.configuration, p.body)).status, 200);
  const saved = await f.getProfile(TARGET);
  assert.match(saved.config.namingField.fieldId, /^pending_/);
  assert.match(saved.config.stages.initial.trigger.optionId, /^pending_/);
  assert.doesNotMatch(JSON.stringify(saved.config), /src_/);
  const repaired = { ...saved.config, namingField: { fieldId: "dst_name", fieldName: "命名" },
    stages: { ...saved.config.stages, initial: { ...saved.config.stages.initial,
      trigger: { fieldId: "dst_status", fieldName: "状态", optionId: "dst_ready", value: "待剪辑" } } },
  };
  const save = await f.request(`/api/local/feishu/subjects/${encodeURIComponent(TARGET)}/package-workflow-drafts/Auto-cut-A`, { expectedRevision: saved.revision, config: repaired }, "PUT");
  assert.equal(save.status, 200, JSON.stringify(save.body));
  assert.equal((await f.getProfile(TARGET)).config.namingField.fieldId, "dst_name");
});

test("reuse preserves target package paths and maps all delivery bindings", async (t) => {
  const f = await fixture(t);
  const local = await f.getProfile(TARGET);
  const save = await f.request(`/api/local/feishu/subjects/${encodeURIComponent(TARGET)}/package-workflow-drafts/Auto-cut-A`, {
    expectedRevision: local.revision, config: { ...local.config,
      upload: { ...local.config.upload, artifactSourcePath: "C:\\target-input", targetPath: "C:\\target-output" },
      delivery: { version: 1, rootPath: "C:\\target-delivery" },
    },
  }, "PUT");
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const { body: e } = await f.exportShare();
  e.configuration.config.delivery = { version: 1, rootPath: "C:\\untrusted", courseNaming: { mode: "field", fieldId: "src_name" },
    coursePathWriteback: { enabled: true, fieldId: "src_doc" },
    writeback: { initial: { onProcessing: [{ fieldId: "src_status", optionId: "src_processing" }] } },
    finalDirectoryTrigger: { enabled: true, fieldId: "src_status", optionId: "src_processing" },
  };
  const p = await f.preview(e.configuration);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await f.commit(e.configuration, p.body)).status, 200);
  const result = (await f.getProfile(TARGET)).config;
  assert.equal(result.upload.artifactSourcePath, "C:\\target-input");
  assert.equal(result.upload.targetPath, "C:\\target-output");
  assert.equal(result.delivery.rootPath, "C:\\target-delivery");
  assert.equal(result.delivery.courseNaming.fieldId, "dst_name");
  assert.equal(result.delivery.coursePathWriteback.fieldId, "dst_doc");
  assert.deepEqual(result.delivery.writeback.initial.onProcessing, [{ fieldId: "dst_status", optionId: "dst_processing" }]);
  assert.deepEqual(result.delivery.finalDirectoryTrigger, { enabled: true, fieldId: "dst_status", optionId: "dst_processing" });
});

test("VM reuse remaps stage, writeback, attachment, naming and archive fields without copying a directory", async (t) => {
  const f = await fixture(t);
  const template = { id: "vm_pmo_review_video", version: 1 };
  const store = createFeishuWorkflowStore({ database: f.database });
  const api = createFeishuSubjectShareApi({ database: f.database, workflowStore: store,
    packageStore: { get: async (alias) => alias === "vm" ? { alias, workflowTemplate: template } : null },
  });
  const initial = { enabled: true, statusFieldId: "src_status", triggerOptionId: "src_ready", instructionFieldId: "src_doc",
    writeback: { processing: { fieldId: "src_status", optionId: "src_processing" }, completed: { fieldId: null, optionId: null } },
  };
  const configuration = { kind: "feishu-subject-workflow", schemaVersion: 1,
    source: { subjectKey: SOURCE, baseName: "source", tableName: "source", metadata: { fields: fields("src") } },
    packageAlias: "vm", workflowTemplate: template, config: {
      fields: { vmidFieldId: "src_doc", outputAttachmentFieldId: "src_attachment", namingFieldId: "src_name" },
      approval: { department: "动画组", reason: "切片剪辑" },
      stages: { initial, review: { ...initial, enabled: false, instructionAttachmentsFieldId: "src_attachment" } },
      finalArchive: { enabled: true, statusFieldId: "src_status", triggerOptionId: "src_processing", pathSource: "manual", directoryPath: "C:\\untrusted", pathFieldId: null },
    },
  };
  const before = f.snapshot();
  const p = await api.handle({ method: "POST", pathname: `${SHARE}/import`, body: { configuration, targetSubjectKey: TARGET, expectedVersion: f.target.configVersion, dryRun: true } });
  assert.deepEqual(f.snapshot(), before);
  assert.equal(p.body.configuration.config.finalArchive.directoryPath, null);
  assert.ok(p.body.diagnostics.some((d) => d.code === "ARCHIVE_PATH_UNBOUND"));
  await api.handle({ method: "POST", pathname: `${SHARE}/import`, body: { configuration, targetSubjectKey: TARGET, expectedVersion: p.body.expectedVersion, expectedRevision: p.body.expectedRevision, dryRun: false } });
  const row = f.db.prepare("SELECT config_json FROM feishu_package_workflow_drafts WHERE subject_key=? AND package_alias='vm'").get(TARGET);
  const saved = JSON.parse(row.config_json);
  assert.equal(saved.fields.vmidFieldId, "dst_doc");
  assert.equal(saved.fields.namingFieldId, "dst_name");
  assert.equal(saved.stages.review.instructionAttachmentsFieldId, "dst_attachment");
  assert.equal(saved.stages.initial.writeback.processing.optionId, "dst_processing");
  assert.equal(saved.finalArchive.enabled, false);
  assert.equal(saved.finalArchive.directoryPath, null);
  assert.doesNotMatch(row.config_json, /src_|untrusted/);
  const localArchive = { ...saved, finalArchive: { ...saved.finalArchive, enabled: true, directoryPath: "C:\\target-archive" } };
  f.db.prepare("UPDATE feishu_package_workflow_drafts SET config_json=? WHERE subject_key=? AND package_alias='vm'").run(JSON.stringify(localArchive), TARGET);
  const again = await api.handle({ method: "POST", pathname: `${SHARE}/import`, body: { configuration, targetSubjectKey: TARGET, expectedVersion: f.target.configVersion, dryRun: true } });
  await api.handle({ method: "POST", pathname: `${SHARE}/import`, body: { configuration, targetSubjectKey: TARGET, expectedVersion: again.body.expectedVersion, expectedRevision: again.body.expectedRevision, dryRun: false } });
  const kept = JSON.parse(f.db.prepare("SELECT config_json FROM feishu_package_workflow_drafts WHERE subject_key=? AND package_alias='vm'").get(TARGET).config_json);
  assert.equal(kept.finalArchive.enabled, true);
  assert.equal(kept.finalArchive.directoryPath, "C:\\target-archive");
  const exported = await api.handle({ method: "GET", pathname: `${SHARE}/export`, query: new URLSearchParams({ subjectKey: TARGET, packageAlias: "vm" }) });
  assert.equal(exported.body.configuration.config.finalArchive.enabled, true);
  assert.equal(exported.body.configuration.config.finalArchive.directoryPath, null);
});

test("reusing into an active target changes only its editable profile and no execution snapshot", async (t) => {
  const f = await fixture(t);
  const chosen = await f.request(`/api/local/feishu/workflow/subjects/${encodeURIComponent(TARGET)}`, { packageRoute: (await f.getProfile(TARGET)).config.packageRoute }, "PATCH");
  const enabled = await f.request(`/api/local/feishu/workflow/subjects/${encodeURIComponent(TARGET)}/enable`, { expectedVersion: chosen.body.subject.configVersion });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const { body: e } = await f.exportShare();
  const before = f.snapshot();
  const p = await f.preview(e.configuration, { expectedVersion: enabled.body.subject.configVersion });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await f.commit(e.configuration, p.body)).status, 200);
  for (const table of ["feishu_subjects", "feishu_subject_versions", "projects"]) assert.deepEqual(f.snapshot()[table], before[table]);
  assert.equal((await f.getProfile(TARGET)).config.execution.concurrencyGroup, "shared-draft");
});

test("missing metadata maps required fields to repairable placeholders and removed Base rejects both endpoints", async (t) => {
  const f = await fixture(t);
  const { body: e } = await f.exportShare();
  f.db.prepare("UPDATE feishu_subjects SET metadata_json='{}' WHERE subject_key=?").run(TARGET);
  const p = await f.preview(e.configuration);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await f.commit(e.configuration, p.body)).status, 200);
  const profile = await f.getProfile(TARGET);
  assert.equal(profile.config.statusField.fieldId, "pending_status_field");
  assert.equal(profile.config.documentField.fieldId, "pending_document_field");
  assert.equal(profile.config.namingField.fieldId, "pending_naming_field");
  f.db.prepare("UPDATE feishu_bases SET removed_at='removed' WHERE base_token IN ('bas_source','bas_target')").run();
  assert.equal((await f.preview(e.configuration)).status, 404);
  assert.equal((await f.exportShare()).status, 404);
});

test("legacy files may omit subjectKey and preview explains missing enabled-stage destinations", async (t) => {
  const f = await fixture(t);
  const { body } = await f.request("/api/local/feishu/workflow/share/export");
  const selectedBase = body.configuration.bases.find((base) => base.baseToken === "bas_source");
  body.configuration.bases = [selectedBase];
  delete selectedBase.subjects[0].subjectKey;
  const p = await f.preview(body.configuration);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.source.subjectKey, SOURCE);
  assert.ok(p.body.diagnostics.some((d) => d.code === "UPLOAD_TARGET_PATH_UNBOUND" && d.path === "config.stages.initial.artifactTargetPath"));
});
