import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const SUBJECT = "bas_package_flow:tbl_chemistry";
const SUBJECT_ROUTE = `/api/local/feishu/workflow/subjects/${encodeURIComponent(SUBJECT)}`;
const DRAFT_ROUTE = `/api/local/feishu/subjects/${encodeURIComponent(SUBJECT)}/package-workflow-drafts/vm-chemistry`;
const VM = { id: "vm_pmo_review_video", version: 1 };
const fields = [
  { fieldId: "fld_vmid", fieldName: "原视频vmid", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_keep", fieldName: "保留时间段", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_review", fieldName: "审核意见", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_attachment", fieldName: "审核成片", type: 17, uiType: "Attachment", options: [] },
  { fieldId: "fld_name", fieldName: "视频名称", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_formula", fieldName: "课程名称", type: 20, uiType: "Formula", options: [] },
  { fieldId: "fld_status", fieldName: "状态", type: 3, uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待剪辑" }] },
];

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-workflow-api-"));
  const legacyWorkspace = path.join(directory, "legacy-workspace");
  const vmWorkspace = path.join(directory, "vm-workspace");
  await mkdir(legacyWorkspace);
  await mkdir(vmWorkspace);
  await writeFile(path.join(vmWorkspace, "PACKAGE-MANIFEST.json"), JSON.stringify({ interface: { workflowTemplate: VM } }));
  const syncs = [];
  const serverOptions = {
    dataDirectory: path.join(directory, "data"),
    codexExecutable: process.execPath,
    feishuPackages: { packages: {
      "Auto-cut-A": { projectId: "legacy-project", workspacePath: legacyWorkspace, prompt: "fixture prompt" },
      "vm-chemistry": { projectId: "vm-project", workspacePath: vmWorkspace, prompt: "fixture prompt", state: "draft", workflowTemplate: VM },
    } },
    feishuWorkflowSync: async (subject) => { syncs.push(structuredClone(subject)); return { ok: true }; },
    ...options,
  };
  let app = createTaskboardServer(serverOptions);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  let baseUrl = `http://127.0.0.1:${address.port}`;
  async function request(route, options = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers: { "content-type": "application/json", ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  const created = await request("/api/local/feishu/workflow/catalog", { method: "POST", body: {
    baseToken: "bas_package_flow", baseName: "测试学科", tables: [{ tableId: "tbl_chemistry", tableName: "化学", fields }],
  } });
  assert.equal(created.status, 201);
  return {
    get app() { return app; }, request, syncs, legacyWorkspace,
    get baseUrl() { return baseUrl; },
    async reopen() {
      await app.close();
      app = createTaskboardServer(serverOptions);
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      baseUrl = `http://127.0.0.1:${address.port}`;
    },
  };
}

test("VM package draft HTTP GET/PUT keeps the active old workflow and task queue unchanged", async (t) => {
  const f = await fixture(t);
  const initial = (await f.request(SUBJECT_ROUTE)).body.subject;
  assert.equal((await f.request(SUBJECT_ROUTE, { method: "PATCH", body: {
    expectedVersion: initial.configVersion, packageRoute: { packageAlias: "Auto-cut-A" },
  } })).status, 200);
  const subject = (await f.request(SUBJECT_ROUTE)).body.subject;
  const enabled = await f.request(`${SUBJECT_ROUTE}/enable`, { method: "POST", body: { expectedVersion: subject.configVersion } });
  assert.equal(enabled.status, 200);
  const originalSubject = (await f.request(SUBJECT_ROUTE)).body.subject;
  const originalSnapshots = f.app.database.database.prepare("SELECT * FROM feishu_subject_versions WHERE subject_key = ? ORDER BY version").all(SUBJECT);
  const syncCount = f.syncs.length;
  const first = await f.request(DRAFT_ROUTE);
  assert.equal(first.status, 200);
  assert.equal(first.body.revision, 0);
  assert.deepEqual(first.body.workflowTemplate, VM);
  assert.deepEqual(Object.keys(first.body.config.stages), ["initial", "review"]);
  const config = {
    ...first.body.config,
    fields: { vmidFieldId: "fld_vmid", outputAttachmentFieldId: "fld_attachment", namingFieldId: null },
    stages: {
      initial: { ...first.body.config.stages.initial, instructionFieldId: "fld_keep" },
      review: { ...first.body.config.stages.review, instructionFieldId: "fld_review", instructionAttachmentsFieldId: null },
    },
  };
  const saved = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 0, config } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.deepEqual((await f.request(DRAFT_ROUTE)).body, saved.body);
  const afterSave = (await f.request(SUBJECT_ROUTE)).body.subject;
  assert.equal(afterSave.preferredPackageAlias, "vm-chemistry");
  assert.deepEqual({ ...afterSave, preferredPackageAlias: originalSubject.preferredPackageAlias }, originalSubject);
  await f.reopen();
  assert.equal((await f.request(SUBJECT_ROUTE)).body.subject.preferredPackageAlias, "vm-chemistry");
  const stale = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 0, config } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  assert.deepEqual((await f.request(SUBJECT_ROUTE)).body.subject, afterSave);
  assert.deepEqual(f.app.database.database.prepare("SELECT * FROM feishu_subject_versions WHERE subject_key = ? ORDER BY version").all(SUBJECT), originalSnapshots);
  assert.equal(f.syncs.length, syncCount);
  assert.equal(f.app.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
});

test("VM naming and NAS archive HTTP configuration saves safely without bypassing preview enablement", async (t) => {
  const f = await fixture(t);
  const first = await f.request(DRAFT_ROUTE);
  const config = {
    ...first.body.config,
    fields: { ...first.body.config.fields, namingFieldId: "fld_name" },
    stages: {
      initial: { ...first.body.config.stages.initial, enabled: false },
      review: { ...first.body.config.stages.review },
    },
    finalArchive: {
      enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_ready",
      pathSource: "manual", directoryPath: "\\\\nas\\share\\具体目录", pathFieldId: null,
    },
  };
  const saved = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 0, config } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.config, config);
  await f.reopen();
  assert.deepEqual((await f.request(DRAFT_ROUTE)).body, saved.body);
  const unsafe = structuredClone(config);
  unsafe.finalArchive.directoryPath = "\\\\?\\UNC\\private-nas\\share";
  const rejected = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 1, config: unsafe } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "INVALID_FIELD");
  assert.doesNotMatch(JSON.stringify(rejected.body), /private-nas/);
  const enable = await f.request(`${DRAFT_ROUTE}/enable`, { method: "POST", body: {} });
  assert.equal(enable.status, 409);
  assert.equal(enable.body.error.code, "PACKAGE_WORKFLOW_NOT_READY");
  assert.deepEqual((await f.request(DRAFT_ROUTE)).body, saved.body);
  assert.equal(f.app.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  assert.equal(f.syncs.length, 0);
});

test("HTTP legacy archive reads keep the row intact until an explicit PMO directory repair", async (t) => {
  const f = await fixture(t);
  const config = (await f.request(DRAFT_ROUTE)).body.config;
  config.fields.namingFieldId = "fld_name";
  config.stages.initial.enabled = false;
  assert.equal((await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 0, config } })).status, 200);
  config.finalArchive = {
    enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_ready",
    rootPath: "W:\\old-parent", courseNameFieldId: "fld_formula",
  };
  f.app.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
    .run(JSON.stringify(config), SUBJECT);
  const before = f.app.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT);
  await f.reopen();
  const read = await f.request(DRAFT_ROUTE);
  assert.equal(read.status, 200);
  assert.equal(read.body.revision, 1);
  assert.equal(read.body.legacyArchivePathNeedsReview, true);
  assert.equal(read.body.config.finalArchive.directoryPath, null);
  assert.deepEqual(f.app.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT), before);
  const mixed = structuredClone(read.body.config);
  mixed.finalArchive.rootPath = "W:\\old-parent";
  const rejected = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 1, config: mixed } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "UNKNOWN_FIELD");
  read.body.config.finalArchive.pathSource = "pmo_field";
  read.body.config.finalArchive.pathFieldId = "fld_formula";
  const repaired = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 1, config: read.body.config } });
  assert.equal(repaired.status, 200);
  assert.equal(repaired.body.revision, 2);
  assert.equal(Object.hasOwn(repaired.body, "legacyArchivePathNeedsReview"), false);
  await f.reopen();
  assert.deepEqual((await f.request(DRAFT_ROUTE)).body, repaired.body);
  assert.equal((await f.request(`${DRAFT_ROUTE}/enable`, { method: "POST", body: {} })).body.error.code, "PACKAGE_WORKFLOW_NOT_READY");
  assert.equal(f.app.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  assert.equal(f.syncs.length, 0);
});

test("HTTP GET exposes conflicting old names without migration writes and PUT resolves the shared binding", async (t) => {
  const f = await fixture(t);
  const canonical = (await f.request(DRAFT_ROUTE)).body.config;
  const saved = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 0, config: canonical } });
  assert.equal(saved.status, 200);
  const legacy = structuredClone(canonical);
  delete legacy.fields.namingFieldId;
  legacy.stages.initial.namingFieldId = "fld_name";
  legacy.stages.review.namingFieldId = "fld_formula";
  legacy.finalArchive.namingFieldId = "fld_name";
  f.app.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
    .run(JSON.stringify(legacy), SUBJECT);
  const before = f.app.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT);
  await f.reopen();
  const read = await f.request(DRAFT_ROUTE);
  assert.equal(read.status, 200);
  assert.equal(read.body.revision, 1);
  assert.equal(read.body.legacyNamingConflict, true);
  assert.equal(read.body.config.fields.namingFieldId, null);
  assert.equal(Object.hasOwn(read.body.config.stages.initial, "namingFieldId"), false);
  assert.equal(Object.hasOwn(read.body.config.finalArchive, "namingFieldId"), false);
  assert.deepEqual(f.app.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT), before);
  const mixed = structuredClone(read.body.config);
  mixed.stages.initial.namingFieldId = "fld_name";
  const rejected = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 1, config: mixed } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "UNKNOWN_FIELD");
  read.body.config.fields.namingFieldId = "fld_formula";
  const repaired = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 1, config: read.body.config } });
  assert.equal(repaired.status, 200);
  assert.equal(repaired.body.revision, 2);
  assert.equal(Object.hasOwn(repaired.body, "legacyNamingConflict"), false);
  await f.reopen();
  assert.deepEqual((await f.request(DRAFT_ROUTE)).body, repaired.body);
  assert.equal(f.app.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  assert.equal(f.syncs.length, 0);
});

test("VM draft HTTP reads report legacy reviewer selection and canonical saves clear the migration notice", async (t) => {
  const f = await fixture(t);
  const config = {
    fields: { vmidFieldId: "fld_vmid", keepSegmentsFieldId: "fld_keep", reviewTextFieldId: "fld_review", reviewAttachmentsFieldId: "fld_attachment", outputAttachmentFieldId: "fld_attachment" },
    approval: { department: "动画组", reason: "切片剪辑" },
    stages: {
      initial: { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_ready" },
      first_review: { enabled: false, statusFieldId: null, triggerOptionId: null },
      final_review: { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_ready", instructionFieldId: "fld_keep" },
    },
  };
  const saved = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 0, config } });
  assert.equal(saved.status, 200);
  assert.deepEqual(Object.keys(saved.body.config.stages), ["initial", "review"]);
  assert.equal(Object.hasOwn(saved.body, "legacyReviewStage"), false);
  f.app.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
    .run(JSON.stringify(config), SUBJECT);
  const before = f.app.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT);
  const read = await f.request(DRAFT_ROUTE);
  assert.equal(read.status, 200);
  assert.equal(read.body.legacyReviewStage, "final_review");
  assert.equal(read.body.config.stages.review.instructionFieldId, "fld_keep");
  assert.equal(read.body.config.stages.review.instructionAttachmentsFieldId, "fld_attachment");
  assert.deepEqual(f.app.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT), before);
  const migrated = await f.request(DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 1, config: read.body.config } });
  assert.equal(migrated.status, 200);
  assert.equal(migrated.body.revision, 2);
  assert.equal(Object.hasOwn(migrated.body, "legacyReviewStage"), false);
  const enable = await f.request(`${DRAFT_ROUTE}/enable`, { method: "POST", body: {} });
  assert.equal(enable.status, 409);
  assert.equal(enable.body.error.code, "PACKAGE_WORKFLOW_NOT_READY");
  assert.equal(f.app.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  assert.equal(f.syncs.length, 0);
});

test("old workflow save cannot route a subject into the preview-only VM package", async (t) => {
  const f = await fixture(t);
  const before = (await f.request(SUBJECT_ROUTE)).body.subject;
  const saved = await f.request(SUBJECT_ROUTE, { method: "PATCH", body: {
    expectedVersion: before.configVersion,
    packageRoute: { routeMode: "fixed", packageAlias: "vm-chemistry", subjectCodeFieldId: null, branchMap: null },
  } });
  assert.equal(saved.status, 409);
  assert.equal(saved.body.error.code, "PACKAGE_WORKFLOW_NOT_READY");
  assert.deepEqual((await f.request(SUBJECT_ROUTE)).body.subject, before);
  assert.equal(f.syncs.length, 0);
});

test("shared workflow import cannot place VM package aliases in the old subject configuration", async (t) => {
  const f = await fixture(t);
  const before = (await f.request(SUBJECT_ROUTE)).body.subject;
  const exported = await f.request("/api/local/feishu/workflow/share/export");
  assert.equal(exported.status, 200);
  const configuration = exported.body.configuration ?? exported.body;
  configuration.bases[0].subjects[0].packageRoute.packageAlias = "vm-chemistry";
  for (const dryRun of [true, false]) {
    const imported = await f.request("/api/local/feishu/workflow/share/import", { method: "POST", body: { configuration, dryRun } });
    assert.equal(imported.status, 409);
    assert.equal(imported.body.error.code, "PACKAGE_WORKFLOW_NOT_READY");
    assert.deepEqual((await f.request(SUBJECT_ROUTE)).body.subject, before);
  }
  assert.equal(f.syncs.length, 0);
  assert.equal((await f.request(DRAFT_ROUTE)).body.revision, 0);
});

test("legacy subject enable rejects a VM package route already present on disk", async (t) => {
  const f = await fixture(t);
  const subject = (await f.request(SUBJECT_ROUTE)).body.subject;
  const existing = f.app.database.database.prepare("SELECT config_json FROM feishu_subjects WHERE subject_key = ?").get(SUBJECT);
  const config = JSON.parse(existing.config_json);
  config.packageRoute.packageAlias = "vm-chemistry";
  f.app.database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?").run(JSON.stringify(config), SUBJECT);
  const response = await f.request(`${SUBJECT_ROUTE}/enable`, { method: "POST", body: { expectedVersion: subject.configVersion } });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "PACKAGE_WORKFLOW_NOT_READY");
  assert.equal(f.syncs.length, 0);
  assert.equal((await f.request(SUBJECT_ROUTE)).body.subject.lifecycle, "draft");
});

test("on-disk VM declaration cannot hide behind a registry's legacy default", async (t) => {
  const f = await fixture(t);
  const initial = (await f.request(SUBJECT_ROUTE)).body.subject;
  assert.equal((await f.request(SUBJECT_ROUTE, { method: "PATCH", body: {
    expectedVersion: initial.configVersion, packageRoute: { packageAlias: "Auto-cut-A" },
  } })).status, 200);
  const before = (await f.request(SUBJECT_ROUTE)).body.subject;
  await writeFile(path.join(f.legacyWorkspace, "PACKAGE-MANIFEST.json"), JSON.stringify({ interface: { workflowTemplate: VM } }));
  const saved = await f.request(SUBJECT_ROUTE, { method: "PATCH", body: { expectedVersion: before.configVersion, title: { fieldId: null, fieldName: null } } });
  assert.equal(saved.status, 409);
  assert.equal(saved.body.error.code, "PACKAGE_WORKFLOW_NOT_READY");
  const enabled = await f.request(`${SUBJECT_ROUTE}/enable`, { method: "POST", body: { expectedVersion: before.configVersion } });
  assert.equal(enabled.status, 409);
  assert.equal(enabled.body.error.code, "PACKAGE_WORKFLOW_NOT_READY");
  assert.deepEqual((await f.request(SUBJECT_ROUTE)).body.subject, before);
});

test("draft HTTP routes enforce method, query, origin, host and closed configuration checks", async (t) => {
  const f = await fixture(t);
  const config = (await f.request(DRAFT_ROUTE)).body.config;
  for (const [route, options, code, status] of [
    [`${DRAFT_ROUTE}?token=forbidden`, {}, "UNKNOWN_QUERY_PARAMETER", 400],
    [DRAFT_ROUTE, { method: "POST", body: {} }, "METHOD_NOT_ALLOWED", 405],
    [DRAFT_ROUTE, { headers: { origin: "https://untrusted.example" } }, "INVALID_ORIGIN", 403],
    [DRAFT_ROUTE, { method: "PUT", body: { expectedRevision: 0, config: { ...config, token: "test-secret-value-93" } } }, "UNKNOWN_FIELD", 400],
    [DRAFT_ROUTE.replace("vm-chemistry", "missing"), {}, "PACKAGE_NOT_FOUND", 404],
  ]) {
    const result = await f.request(route, options);
    assert.equal(result.status, status);
    assert.equal(result.body.error.code, code);
    assert.doesNotMatch(JSON.stringify(result.body), /forbidden|test-secret-value-93/);
  }
  const invalidHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.baseUrl}${DRAFT_ROUTE}`, { headers: { host: "untrusted.example" } }, async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch (error) { reject(error); }
    });
    request.once("error", reject);
    request.end();
  });
  assert.equal(invalidHost.status, 403);
  assert.equal(invalidHost.body.error.code, "INVALID_HOST");
  const zip = await f.request(DRAFT_ROUTE.replace("vm-chemistry", "Auto-cut-A"));
  assert.equal(zip.status, 200);
  assert.deepEqual(zip.body.workflowTemplate, { id: "document_draft_zip", version: 1 });
  assert.equal(zip.body.config.packageRoute.packageAlias, "Auto-cut-A");
  assert.equal((await f.request(DRAFT_ROUTE)).body.revision, 0);
  assert.equal(f.syncs.length, 0);
});
