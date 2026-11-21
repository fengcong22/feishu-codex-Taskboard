import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { normalizePackageOptions } from "../shared/feishu-package-options.mjs";

const SUBJECT = "bas_options:tbl_civics";
const TARGET = "bas_options:tbl_politics";
const EDIT = "auto-cut-autoedit";
const LITE = "Auto-cut-lite";
const SHARE = "/api/local/feishu/workflow/subject-share";
const OPTIONS = { selfEdit: true, defaultSfx: true, bgm: false, preset: "civics-medium" };
const fields = [
  { fieldId: "fld_status", fieldName: "流程", type: 3, uiType: "SingleSelect", options: [
    { id: "opt_other", name: "其他" }, { id: "opt_initial", name: "初稿" },
  ] },
  { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
];

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-options-"));
  const editWorkspace = path.join(directory, "autoedit");
  const liteWorkspace = path.join(directory, "lite");
  const zipSource = path.join(directory, "zip-source");
  await Promise.all([mkdir(editWorkspace), mkdir(liteWorkspace), mkdir(zipSource)]);
  await writeFile(path.join(editWorkspace, "PACKAGE-MANIFEST.json"), JSON.stringify({
    embedded_runtime: { version: "0.1.0" },
    interface: { workflowTemplate: { id: "document_edit_zip", version: 1 }, artifactKind: "edit_zip", zipOutput: { relativeDirectory: "output" } },
  }));
  const synced = [];
  const record = (alias, workspacePath, extra = {}) => ({
    alias, name: alias, projectId: alias.toLowerCase(), workspacePath, zipSourceDirectory: zipSource,
    prompt: "trusted package prompt", state: "enabled", revision: 1, maxConcurrent: 1, ...extra,
  });
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuPackages: { packages: {
      [EDIT]: record(EDIT, editWorkspace, { workflowTemplate: { id: "document_edit_zip", version: 1 } }),
      [LITE]: record(LITE, liteWorkspace),
    } },
    feishuWorkflowSync: async (subject, options) => { synced.push({ subject: structuredClone(subject), options }); return { ok: true }; },
    feishuWorkflowShareImport: async () => ({ diagnostics: [] }),
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(route, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const catalog = await request("/api/local/feishu/workflow/catalog", { baseToken: "bas_options", baseName: "选项测试",
    tables: [
      { tableId: "tbl_civics", tableName: "道法", fields: structuredClone(fields) },
      { tableId: "tbl_politics", tableName: "政治", fields: structuredClone(fields) },
    ] });
  assert.equal(catalog.status, 201, JSON.stringify(catalog.body));
  const profileRoute = (alias, subjectKey = SUBJECT) => `/api/local/feishu/subjects/${encodeURIComponent(subjectKey)}/package-workflow-drafts/${encodeURIComponent(alias)}`;
  const subjectRoute = (subjectKey = SUBJECT) => `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectKey)}`;
  return {
    app, synced, request, profileRoute, subjectRoute,
    getSubject: async (subjectKey = SUBJECT) => (await request(subjectRoute(subjectKey))).body.subject,
    getProfile: async (alias, subjectKey = SUBJECT) => (await request(profileRoute(alias, subjectKey))).body,
    /** A complete, enable-ready profile for `alias` with the given extra config. */
    async saveProfile(alias, extra = {}, subjectKey = SUBJECT) {
      const profile = (await request(profileRoute(alias, subjectKey))).body;
      const stage = (base) => ({ ...base, artifactTargetPath: path.join(directory, "stage-output") });
      const config = {
        ...profile.config,
        statusField: { fieldId: "fld_status", fieldName: "流程" },
        documentField: { fieldId: "fld_document", fieldName: "素材文档" },
        namingField: { fieldId: "fld_name", fieldName: "命名" },
        stages: Object.fromEntries(Object.entries(profile.config.stages).map(([stageId, value]) => [stageId, stage({
          ...value,
          enabled: stageId === "initial",
          ...(stageId === "initial" ? { trigger: { fieldId: "fld_status", fieldName: "流程", optionId: "opt_initial", value: "初稿" } } : {}),
        })])),
        upload: { ...profile.config.upload, artifactSourceMode: "driver_report", artifactSourcePath: zipSource },
        ...extra,
      };
      return request(profileRoute(alias, subjectKey), { expectedRevision: profile.revision, config }, "PUT");
    },
    async enableProfile(alias, subjectKey = SUBJECT) {
      const profile = (await request(profileRoute(alias, subjectKey))).body;
      const subject = (await request(subjectRoute(subjectKey))).body.subject;
      return request(`${profileRoute(alias, subjectKey)}/enable`, { expectedRevision: profile.revision, expectedVersion: subject.configVersion });
    },
    versions: (subjectKey = SUBJECT) => app.database.database
      .prepare("SELECT version, lifecycle, snapshot_json FROM feishu_subject_versions WHERE subject_key = ? ORDER BY version")
      .all(subjectKey).map((row) => ({ version: row.version, lifecycle: row.lifecycle, snapshot: JSON.parse(row.snapshot_json) })),
  };
}

test("package options are canonical, nullable while drafting and complete when required", () => {
  assert.deepEqual(normalizePackageOptions({}), { selfEdit: null, defaultSfx: null, bgm: null, preset: null });
  assert.deepEqual(normalizePackageOptions(OPTIONS, { requireComplete: true }), OPTIONS);
  for (const preset of ["politics-fine", "civics-medium", "english-dub", "general-medium"]) {
    assert.equal(normalizePackageOptions({ ...OPTIONS, preset }, { requireComplete: true }).preset, preset);
  }
  for (const [value, code] of [
    [{ ...OPTIONS, preset: "civics" }, "INVALID_FIELD"],
    [{ ...OPTIONS, bgm: "false" }, "INVALID_FIELD"],
    [{ ...OPTIONS, bgm: 0 }, "INVALID_FIELD"],
    [{ ...OPTIONS, music: true }, "UNKNOWN_FIELD"],
    [["civics-medium"], "INVALID_FIELD"],
  ]) assert.throws(() => normalizePackageOptions(value), { code });
  for (const key of Object.keys(OPTIONS)) {
    assert.throws(() => normalizePackageOptions({ ...OPTIONS, [key]: null }, { requireComplete: true }), { code: "PACKAGE_OPTIONS_REQUIRED" });
  }
});

test("only a document_edit_zip package profile accepts package options", async (t) => {
  const f = await fixture(t);
  const lite = await f.saveProfile(LITE, { packageOptions: OPTIONS });
  assert.equal(lite.status, 400, JSON.stringify(lite.body));
  assert.equal(lite.body.error.code, "PACKAGE_OPTIONS_UNSUPPORTED");
  assert.equal((await f.getProfile(LITE)).revision, 0);

  const invalid = await f.saveProfile(EDIT, { packageOptions: { ...OPTIONS, preset: "math-fine" } });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal(invalid.body.error.code, "INVALID_FIELD");

  // A draft may leave options unset; it is saved as an explicit null.
  const draft = await f.saveProfile(EDIT, { packageOptions: { selfEdit: false } });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.deepEqual(draft.body.config.packageOptions, { selfEdit: false, defaultSfx: null, bgm: null, preset: null });
  assert.deepEqual((await f.getProfile(EDIT)).config.packageOptions, draft.body.config.packageOptions);
});

test("enabling a document_edit_zip subject requires every package option", async (t) => {
  const f = await fixture(t);
  for (const packageOptions of [undefined, { ...OPTIONS, defaultSfx: null }, { ...OPTIONS, preset: null }]) {
    const saved = await f.saveProfile(EDIT, packageOptions ? { packageOptions } : {});
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const before = await f.getSubject();
    const enabled = await f.enableProfile(EDIT);
    assert.equal(enabled.status, 409, JSON.stringify(enabled.body));
    assert.equal(enabled.body.error.code, "PACKAGE_OPTIONS_REQUIRED");
    assert.deepEqual(await f.getSubject(), before);
  }
  assert.equal(f.synced.length, 0);

  assert.equal((await f.saveProfile(EDIT, { packageOptions: OPTIONS })).status, 200);
  const enabled = await f.enableProfile(EDIT);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.subject.lifecycle, "enabled");
  assert.deepEqual(enabled.body.subject.packageOptions, OPTIONS);
  // Bridge receives the same validated options, and the active version freezes them.
  assert.deepEqual(f.synced.at(-1).subject.packageOptions, OPTIONS);
  assert.deepEqual(f.versions().at(-1).snapshot.packageOptions, OPTIONS);
});

test("a Lite subject enables without package options and keeps none", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.saveProfile(LITE)).status, 200);
  const enabled = await f.enableProfile(LITE);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(Object.hasOwn(enabled.body.subject, "packageOptions"), false);
  assert.equal(Object.hasOwn(f.synced.at(-1).subject, "packageOptions"), false);
});

test("changing package options produces a new configuration version", async (t) => {
  const f = await fixture(t);
  await f.saveProfile(EDIT, { packageOptions: OPTIONS });
  const first = (await f.enableProfile(EDIT)).body.subject;
  const changed = { ...OPTIONS, bgm: true, preset: "politics-fine" };
  const saved = await f.saveProfile(EDIT, { packageOptions: changed });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const second = await f.enableProfile(EDIT);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.subject.configVersion, first.configVersion + 1);
  assert.deepEqual(second.body.subject.packageOptions, changed);
  const enabled = f.versions().filter((entry) => entry.lifecycle === "enabled");
  assert.deepEqual(enabled.map((entry) => entry.snapshot.packageOptions), [OPTIONS, changed]);

  // A legacy subject PATCH that only changes the options is a new draft version as well.
  const patched = await f.request(f.subjectRoute(), {
    expectedVersion: second.body.subject.configVersion, packageOptions: { ...changed, selfEdit: false },
  }, "PATCH");
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.subject.configVersion, second.body.subject.configVersion + 1);
  assert.equal(patched.body.subject.lifecycle, "draft");
  assert.equal(patched.body.subject.packageOptions.selfEdit, false);
});

test("legacy PATCH keeps options off non-autoedit packages", async (t) => {
  const f = await fixture(t);
  const subject = await f.getSubject();
  const route = { routeMode: "fixed", packageAlias: EDIT, subjectCodeFieldId: null, branchMap: null };
  const edit = await f.request(f.subjectRoute(), { expectedVersion: subject.configVersion, packageRoute: route, packageOptions: OPTIONS }, "PATCH");
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual(edit.body.subject.packageOptions, OPTIONS);

  // Explicit options for a Lite package are refused; inherited ones do not follow the switch.
  const explicit = await f.request(f.subjectRoute(), {
    expectedVersion: edit.body.subject.configVersion, packageRoute: { ...route, packageAlias: LITE }, packageOptions: OPTIONS,
  }, "PATCH");
  assert.equal(explicit.status, 400, JSON.stringify(explicit.body));
  assert.equal(explicit.body.error.code, "PACKAGE_OPTIONS_UNSUPPORTED");
  const lite = await f.request(f.subjectRoute(), {
    expectedVersion: edit.body.subject.configVersion, packageRoute: { ...route, packageAlias: LITE },
  }, "PATCH");
  assert.equal(lite.status, 200, JSON.stringify(lite.body));
  assert.equal(Object.hasOwn(lite.body.subject, "packageOptions"), false);

  // Clearing with null removes the options.
  const back = await f.request(f.subjectRoute(), {
    expectedVersion: lite.body.subject.configVersion, packageRoute: route, packageOptions: null,
  }, "PATCH");
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(Object.hasOwn(back.body.subject, "packageOptions"), false);
});

test("subject share export and import keep the package options", async (t) => {
  const f = await fixture(t);
  await f.saveProfile(EDIT, { packageOptions: OPTIONS });
  const exported = await f.request(`${SHARE}/export?subjectKey=${encodeURIComponent(SUBJECT)}&packageAlias=${EDIT}`);
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.deepEqual(exported.body.configuration.config.packageOptions, OPTIONS);
  assert.deepEqual(exported.body.configuration.workflowTemplate, { id: "document_edit_zip", version: 1 });

  const target = await f.getSubject(TARGET);
  const preview = await f.request(`${SHARE}/import`, {
    configuration: exported.body.configuration, targetSubjectKey: TARGET, expectedVersion: target.configVersion, dryRun: true,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const committed = await f.request(`${SHARE}/import`, {
    configuration: exported.body.configuration, targetSubjectKey: TARGET,
    expectedVersion: preview.body.expectedVersion, expectedRevision: preview.body.expectedRevision, dryRun: false,
  });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.deepEqual((await f.getProfile(EDIT, TARGET)).config.packageOptions, OPTIONS);

  // A Lite share cannot smuggle the options in.
  const lite = structuredClone(exported.body.configuration);
  lite.packageAlias = LITE;
  lite.workflowTemplate = { id: "document_draft_zip", version: 1 };
  lite.config.packageRoute.packageAlias = LITE;
  const rejected = await f.request(`${SHARE}/import`, {
    configuration: lite, targetSubjectKey: TARGET, expectedVersion: target.configVersion, dryRun: true,
  });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, "PACKAGE_OPTIONS_UNSUPPORTED");
});

test("workflow catalog export and import keep the package options", async (t) => {
  const f = await fixture(t);
  const subject = await f.getSubject();
  const route = { routeMode: "fixed", packageAlias: EDIT, subjectCodeFieldId: null, branchMap: null };
  const patched = await f.request(f.subjectRoute(), { expectedVersion: subject.configVersion, packageRoute: route, packageOptions: OPTIONS }, "PATCH");
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const exported = await f.request("/api/local/feishu/workflow/share/export");
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const shared = exported.body.configuration.bases[0].subjects.find((entry) => entry.subjectKey === SUBJECT);
  assert.deepEqual(shared.packageOptions, OPTIONS);

  const changed = structuredClone(exported.body.configuration);
  changed.bases[0].subjects.find((entry) => entry.subjectKey === SUBJECT).packageOptions = { ...OPTIONS, preset: "general-medium" };
  const imported = await f.request("/api/local/feishu/workflow/share/import", { configuration: changed, dryRun: false });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const after = await f.getSubject();
  assert.deepEqual(after.packageOptions, { ...OPTIONS, preset: "general-medium" });
  assert.equal(after.configVersion, patched.body.subject.configVersion + 1);

  const lite = structuredClone(exported.body.configuration);
  const liteSubject = lite.bases[0].subjects.find((entry) => entry.subjectKey === SUBJECT);
  liteSubject.packageRoute.packageAlias = LITE;
  const rejected = await f.request("/api/local/feishu/workflow/share/import", { configuration: lite, dryRun: true });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.code, "PACKAGE_OPTIONS_UNSUPPORTED");
});
