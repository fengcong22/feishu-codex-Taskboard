import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";

async function fixture(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-share-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuPackages: {
      packages: {
        "Auto-cut-A": {
          projectId: "auto-cut-a",
          workspacePath: directory,
          prompt: "fixture prompt",
        },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
    feishuWorkflowShareImport: async (configuration) => ({
      configuration,
      diagnostics: [],
      diagnosticsOk: true,
      dryRun: true,
    }),
    ...overrides,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, directory };
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

async function seedSubject(baseUrl, baseToken = "bas_share", fields = []) {
  const preview = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
    method: "POST",
    body: {
      baseToken,
      baseName: "共享配置 Base",
      sourceUrlLabel: "https://example.test/base/share",
      tables: [{ tableId: "tbl_chinese", tableName: "语文", fields }],
    },
  });
  assert.equal(preview.response.status, 201);
  const subjectKey = `${baseToken}:tbl_chinese`;
  const saved = await request(baseUrl, `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectKey)}`, {
    method: "PATCH",
    body: {
      trigger: { fieldId: "fld_progress", fieldName: "制作进度", startValue: "待制作", optionId: "opt_ready" },
      title: { fieldId: "fld_title", fieldName: "脚本名称" },
      execution: { mode: "automatic", concurrencyGroup: "autocut", maxConcurrent: 3, resourceGroups: ["jianying-desktop"] },
      packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
      upload: {
        enqueueMode: "automatic",
        artifactSourceMode: "watch_directory",
        artifactSourcePath: "C:\\Users\\admin\\Desktop\\Auto-Cut-待上传",
        targetId: "nas-primary",
        targetPath: "\\\\nas\\剪映草稿\\语文",
        uploadConcurrency: 2,
      },
    },
  });
  assert.equal(saved.response.status, 200);
  return subjectKey;
}

function phasedStage(id, optionId, value) {
  return {
    enabled: true,
    trigger: { fieldId: "fld_status", fieldName: "流程", optionId, value },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "修改意见" },
    audio: { mode: "video_original" },
    artifactTargetPath: `C:\\approved\\${id}`,
    nameSuffix: `_${value}`,
  };
}

function phasedMetadata(extraFields = []) {
  return {
    fields: [
      { fieldId: "fld_progress", fieldName: "制作进度", type: 3, uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待制作" }] },
      { fieldId: "fld_title", fieldName: "脚本名称", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_status", fieldName: "流程", type: 3, uiType: "SingleSelect", options: [
        { id: "opt_initial", name: "初稿" },
        { id: "opt_review", name: "初审修改" },
        { id: "opt_final", name: "终审修改" },
      ] },
      { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ...extraFields,
    ],
  };
}

function applyPhasedConfiguration(subject, stages, metadata) {
  Object.assign(subject, {
    statusField: { fieldId: "fld_status", fieldName: "流程" },
    documentField: { fieldId: "fld_document", fieldName: "素材文档" },
    namingField: { fieldId: "fld_name", fieldName: "命名" },
    stages,
    metadata,
  });
}

async function attachmentShareConfiguration(baseUrl, baseToken) {
  const metadata = phasedMetadata([
    { fieldId: "fld_imported_video", fieldName: "导入视频", type: 17, uiType: "Attachment", options: [] },
    { fieldId: "fld_imported_audio", fieldName: "导入音频", type: 17, uiType: "Attachment", options: [] },
  ]);
  const subjectKey = await seedSubject(baseUrl, baseToken, metadata.fields);
  const initial = phasedStage("initial", "opt_initial", "初稿");
  initial.videoSource = { kind: "base_attachment", fieldId: "fld_imported_video" };
  initial.audio = {
    mode: "replace_original",
    source: { kind: "base_attachment", fieldId: "fld_imported_audio" },
    durationToleranceSeconds: 3,
  };
  const configured = await request(
    baseUrl,
    `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectKey)}`,
    {
      method: "PATCH",
      body: {
        statusField: { fieldId: "fld_status", fieldName: "流程" },
        documentField: { fieldId: "fld_document", fieldName: "素材文档" },
        namingField: { fieldId: "fld_name", fieldName: "命名" },
        stages: {
          initial,
          first_review: phasedStage("first_review", "opt_review", "初审修改"),
          final_review: phasedStage("final_review", "opt_final", "终审修改"),
        },
      },
    },
  );
  assert.equal(configured.response.status, 200, JSON.stringify(configured.body));
  const exported = await request(baseUrl, "/api/local/feishu/workflow/share/export");
  assert.equal(exported.response.status, 200, JSON.stringify(exported.body));
  return { subjectKey, configuration: structuredClone(exported.body.configuration) };
}

function stagedFieldDiagnostics(body) {
  return body.diagnostics
    .filter((entry) => entry.code.startsWith("FIELD_") && entry.path?.includes(".stages."))
    .map((entry) => [entry.code, entry.path]);
}

for (const scenario of [
  { name: "bound stages without a common path", targetId: "historical-alias", missing: [], unbound: [] },
  { name: "missing enabled stage paths without an alias", targetId: null, missing: ["initial", "first_review"], unbound: ["initial", "first_review"] },
  { name: "the local common path fallback", targetId: "historical-alias", missing: ["first_review"], targetPath: "C:\\legacy-upload", unbound: [] },
  { name: "a historical snake-case local stage path", targetId: "historical-alias", missing: [], snakeCaseInitial: true, unbound: [] },
]) {
  test(`phased share upload diagnostics follow ${scenario.name}`, async () => {
    const fixtureData = await fixture();
    try {
      const baseToken = "bas_stage_upload_binding";
      const subjectKey = await seedSubject(fixtureData.baseUrl, baseToken, phasedMetadata().fields);
      const stages = {
        initial: phasedStage("initial", "opt_initial", "初稿"),
        first_review: phasedStage("first_review", "opt_review", "初审修改"),
        final_review: { ...phasedStage("final_review", "opt_final", "终审修改"), enabled: false, artifactTargetPath: null },
      };
      for (const stageId of scenario.missing) stages[stageId].artifactTargetPath = null;
      const configured = await request(
        fixtureData.baseUrl,
        `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectKey)}`,
        {
          method: "PATCH",
          body: {
            statusField: { fieldId: "fld_status", fieldName: "流程" },
            documentField: { fieldId: "fld_document", fieldName: "素材文档" },
            namingField: { fieldId: "fld_name", fieldName: "命名" },
            stages,
            upload: { targetId: scenario.targetId, targetPath: scenario.targetPath ?? null },
          },
        },
      );
      assert.equal(configured.response.status, 200, JSON.stringify(configured.body));
      const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
      assert.equal(exported.response.status, 200, JSON.stringify(exported.body));
      if (scenario.snakeCaseInitial) {
        const db = fixtureData.app.database.database;
        const row = db.prepare("SELECT config_json FROM feishu_subjects WHERE subject_key = ?").get(subjectKey);
        const local = JSON.parse(row.config_json);
        local.stages.initial.artifact_target_path = local.stages.initial.artifactTargetPath;
        delete local.stages.initial.artifactTargetPath;
        db.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
          .run(JSON.stringify(local), subjectKey);
      }
      for (const dryRun of [true, false]) {
        const imported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
          method: "POST",
          body: { configuration: exported.body.configuration, dryRun },
        });
        assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
        const diagnostics = imported.body.diagnostics.filter((entry) => entry.code === "UPLOAD_TARGET_PATH_UNBOUND");
        assert.deepEqual(
          diagnostics.map((entry) => entry.path),
          scenario.unbound.map((stageId) => `bases.${baseToken}.subjects.tbl_chinese.stages.${stageId}.artifactTargetPath`),
        );
        assert.doesNotMatch(JSON.stringify(diagnostics), /approved|legacy-upload/);
      }
      const catalog = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
      assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
      const importedStages = catalog.body.catalog[0].subjects[0].stages;
      for (const stageId of ["initial", "first_review"]) {
        assert.equal(importedStages[stageId].artifactTargetPath, stages[stageId].artifactTargetPath ?? scenario.targetPath ?? null);
      }
      assert.equal(importedStages.final_review.artifactTargetPath, null);
    } finally {
      await fixtureData.app.close();
      await rm(fixtureData.directory, { recursive: true, force: true });
    }
  });
}

test("workflow share export is schema-versioned and redacts machine-local paths", async () => {
  const fixtureData = await fixture();
  try {
    await seedSubject(fixtureData.baseUrl);
    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    assert.equal(exported.response.status, 200);
    assert.equal(exported.body.configuration.schemaVersion, 1);
    const subject = exported.body.configuration.bases[0].subjects[0];
    assert.equal(subject.baseToken, "bas_share");
    assert.equal(subject.tableName, "语文");
    assert.equal(subject.execution.maxConcurrent, 3);
    assert.equal(subject.packageRoute.packageAlias, "Auto-cut-A");
    assert.equal(subject.upload.artifactSourcePath, null);
    assert.equal(subject.upload.targetPath, null);
    const serialized = JSON.stringify(exported.body.configuration);
    assert.doesNotMatch(serialized, /Users\\admin|nas\\剪映草稿|workspacePath|appSecret|claimToken|taskHistory|logs/i);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("share import rejects a primitive upload object as a controlled client error", async () => {
  const fixtureData = await fixture();
  try {
    await seedSubject(fixtureData.baseUrl);
    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    const configuration = structuredClone(exported.body.configuration);
    configuration.bases[0].subjects[0].upload = "bad";

    const imported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: true },
    });
    assert.equal(imported.response.status, 400, JSON.stringify(imported.body));
    assert.equal(imported.body.error.code, "INVALID_SHARE_CONFIGURATION");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("share inspection never forwards a legacy snake-case stage destination to Bridge", async () => {
  let inspectedConfiguration = null;
  const fixtureData = await fixture({
    feishuWorkflowShareImport: async (configuration) => {
      inspectedConfiguration = structuredClone(configuration);
      return { configuration, diagnostics: [], diagnosticsOk: true, dryRun: true };
    },
  });
  try {
    await seedSubject(fixtureData.baseUrl, "bas_snake_inspection", phasedMetadata().fields);
    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    const configuration = structuredClone(exported.body.configuration);
    configuration.bases[0].subjects[0].stages.initial.artifact_target_path = "D:\\private\\bridge-inspection";

    const imported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: true },
    });
    assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
    const serialized = JSON.stringify(inspectedConfiguration);
    assert.doesNotMatch(serialized, /artifact_target_path/u);
    assert.doesNotMatch(serialized, /bridge-inspection/u);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow share import dry-run returns diagnostics without mutating the catalog", async () => {
  const fixtureData = await fixture();
  try {
    const subjectKey = await seedSubject(fixtureData.baseUrl);
    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    const before = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
    const configuration = structuredClone(exported.body.configuration);
    configuration.bases[0].subjects[0].packageRoute.packageAlias = "Auto-cut-小学语文";
    const dryRun = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: true },
    });
    assert.equal(dryRun.response.status, 200);
    assert.equal(dryRun.body.dryRun, true);
    assert.ok(Array.isArray(dryRun.body.diagnostics));
    assert.ok(dryRun.body.diagnostics.some((entry) => entry.code === "PACKAGE_ALIAS_UNAVAILABLE"));
    assert.equal(dryRun.body.configuration.bases[0].subjects[0].lifecycle, "draft");
    const after = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
    assert.deepEqual(after.body.catalog, before.body.catalog);
    assert.equal(subjectKey, "bas_share:tbl_chinese");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("automatic phased share configuration imports as a draft without local stage targets", async () => {
  const fixtureData = await fixture();
  try {
    const subjectKey = await seedSubject(fixtureData.baseUrl, "bas_phased_share", phasedMetadata().fields);
    const configured = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectKey)}`,
      {
        method: "PATCH",
        body: {
          statusField: { fieldId: "fld_status", fieldName: "流程" },
          documentField: { fieldId: "fld_document", fieldName: "素材文档" },
          namingField: { fieldId: "fld_name", fieldName: "命名" },
          stages: {
            initial: phasedStage("initial", "opt_initial", "初稿"),
            first_review: phasedStage("first_review", "opt_review", "初审修改"),
            final_review: phasedStage("final_review", "opt_final", "终审修改"),
          },
          execution: { mode: "manual", concurrencyGroup: "autocut", maxConcurrent: 1, resourceGroups: [] },
          upload: {
            enqueueMode: "automatic",
            artifactSourceMode: "driver_report",
            artifactSourcePath: "C:\\artifacts",
            targetId: null,
            targetPath: "C:\\upload",
            uploadConcurrency: 1,
          },
        },
      },
    );
    assert.equal(configured.response.status, 200, JSON.stringify(configured.body));

    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    const sharedSubject = exported.body.configuration.bases[0].subjects[0];
    assert.equal(sharedSubject.upload.enqueueMode, "automatic");
    assert.deepEqual(
      Object.values(sharedSubject.stages).map((stage) => stage.artifactTargetPath),
      [null, null, null],
    );

    const imported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration: exported.body.configuration, dryRun: true },
    });
    assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.configuration.bases[0].subjects[0].lifecycle, "draft");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("phased share export keeps independent active audio sources without UI draft state", async () => {
  const fixtureData = await fixture();
  try {
    const subjectKey = await seedSubject(fixtureData.baseUrl, "bas_audio_share", [
      { fieldId: "fld_status", fieldName: "流程", type: 3, uiType: "SingleSelect", options: [
        { id: "opt_initial", name: "初稿" },
        { id: "opt_review", name: "初审修改" },
        { id: "opt_final", name: "终审修改" },
      ] },
      { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_audio", fieldName: "配音", type: 17, uiType: "Attachment", options: [] },
    ]);
    const initial = phasedStage("initial", "opt_initial", "初稿");
    const firstReview = phasedStage("first_review", "opt_review", "初审修改");
    firstReview.audio = {
      mode: "replace_original",
      source: { kind: "docx_section", anchorText: "二、PPT草稿+翻录" },
      durationToleranceSeconds: 1.5,
    };
    const finalReview = phasedStage("final_review", "opt_final", "终审修改");
    finalReview.audio = {
      mode: "replace_original",
      source: { kind: "base_attachment", fieldId: "fld_audio" },
      durationToleranceSeconds: 3,
    };
    const configured = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectKey)}`,
      {
        method: "PATCH",
        body: {
          statusField: { fieldId: "fld_status", fieldName: "流程" },
          documentField: { fieldId: "fld_document", fieldName: "素材文档" },
          namingField: { fieldId: "fld_name", fieldName: "命名" },
          stages: { initial, first_review: firstReview, final_review: finalReview },
        },
      },
    );
    assert.equal(configured.response.status, 200, JSON.stringify(configured.body));

    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    const sharedStages = exported.body.configuration.bases[0].subjects[0].stages;
    assert.deepEqual(sharedStages.initial.audio, { mode: "video_original" });
    assert.deepEqual(sharedStages.first_review.audio, firstReview.audio);
    assert.deepEqual(sharedStages.final_review.audio, finalReview.audio);
    assert.doesNotMatch(JSON.stringify(exported.body.configuration), /audioDraft|temporary|cache/i);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("share import diagnoses staged attachment bindings against explicitly empty local metadata", async () => {
  const fixtureData = await fixture();
  try {
    await seedSubject(fixtureData.baseUrl, "bas_empty_attachment_metadata", []);
    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    const configuration = structuredClone(exported.body.configuration);
    const subject = configuration.bases[0].subjects[0];
    const initial = phasedStage("initial", "opt_initial", "初稿");
    initial.artifactTargetPath = null;
    initial.videoSource = { kind: "base_attachment", fieldId: "fld_imported_video" };
    initial.audio = {
      mode: "replace_original",
      source: { kind: "base_attachment", fieldId: "fld_imported_audio" },
      durationToleranceSeconds: 3,
    };
    const firstReview = phasedStage("first_review", "opt_review", "初审修改");
    firstReview.artifactTargetPath = null;
    const finalReview = phasedStage("final_review", "opt_final", "终审修改");
    finalReview.artifactTargetPath = null;
    applyPhasedConfiguration(subject, {
      initial,
      first_review: firstReview,
      final_review: finalReview,
    }, phasedMetadata([
      { fieldId: "fld_imported_video", fieldName: "导入视频", type: 17, uiType: "Attachment", options: [] },
      { fieldId: "fld_imported_audio", fieldName: "导入音频", type: 17, uiType: "Attachment", options: [] },
    ]));

    const dryRun = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: true },
    });
    assert.equal(dryRun.response.status, 200, JSON.stringify(dryRun.body));
    assert.deepEqual(
      dryRun.body.diagnostics
        .filter((entry) => entry.code.startsWith("FIELD_") && entry.path?.includes(".stages."))
        .map((entry) => [entry.code, entry.path]),
      [
        ["FIELD_NOT_FOUND", "bases.bas_empty_attachment_metadata.subjects.tbl_chinese.stages.initial.videoSource.fieldId"],
        ["FIELD_NOT_FOUND", "bases.bas_empty_attachment_metadata.subjects.tbl_chinese.stages.initial.audio.source.fieldId"],
      ],
    );

    const committed = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: false },
    });
    assert.equal(committed.response.status, 200, JSON.stringify(committed.body));
    const imported = committed.body.configuration.bases[0].subjects[0];
    assert.equal(imported.lifecycle, "draft");
    assert.equal(imported.stages.initial.videoSource.fieldId, "fld_imported_video");
    assert.equal(imported.stages.initial.audio.source.fieldId, "fld_imported_audio");
    assert.deepEqual(imported.metadata.fields, []);

    const saved = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(imported.subjectKey)}`,
      {
        method: "PATCH",
        body: { expectedVersion: imported.configVersion },
      },
    );
    assert.equal(saved.response.status, 400, JSON.stringify(saved.body));
    assert.equal(saved.body.error.code, "FIELD_NOT_FOUND");

    const enabled = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(imported.subjectKey)}/enable`,
      {
        method: "POST",
        body: { expectedVersion: imported.configVersion },
      },
    );
    assert.equal(enabled.response.status, 409, JSON.stringify(enabled.body));
    assert.equal(enabled.body.error.code, "FIELD_NOT_FOUND");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("share import treats a new subject's portable metadata as unverified", async () => {
  const fixtureData = await fixture();
  try {
    const { configuration } = await attachmentShareConfiguration(
      fixtureData.baseUrl,
      "bas_new_subject_source",
    );
    const base = configuration.bases[0];
    const subject = base.subjects[0];
    base.baseToken = "bas_new_subject_target";
    base.baseName = "新导入 Base";
    subject.baseToken = base.baseToken;
    subject.baseName = base.baseName;
    subject.subjectKey = `${base.baseToken}:${subject.tableId}`;
    subject.projectId = subjectProjectId(subject.subjectKey);

    const dryRun = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: true },
    });
    assert.equal(dryRun.response.status, 200, JSON.stringify(dryRun.body));
    assert.deepEqual(stagedFieldDiagnostics(dryRun.body), [
      ["FIELD_NOT_FOUND", "bases.bas_new_subject_target.subjects.tbl_chinese.stages.initial.videoSource.fieldId"],
      ["FIELD_NOT_FOUND", "bases.bas_new_subject_target.subjects.tbl_chinese.stages.initial.audio.source.fieldId"],
    ]);

    const committed = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: false },
    });
    assert.equal(committed.response.status, 200, JSON.stringify(committed.body));
    assert.deepEqual(stagedFieldDiagnostics(committed.body), stagedFieldDiagnostics(dryRun.body));
    const imported = committed.body.configuration.bases
      .find((candidate) => candidate.baseToken === base.baseToken)
      .subjects[0];
    assert.deepEqual(imported.metadata, { fields: [] });

    const saved = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(subject.subjectKey)}`,
      { method: "PATCH", body: { expectedVersion: imported.configVersion } },
    );
    assert.equal(saved.response.status, 400, JSON.stringify(saved.body));
    assert.equal(saved.body.error.code, "FIELD_NOT_FOUND");

    const enabled = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(subject.subjectKey)}/enable`,
      { method: "POST", body: { expectedVersion: imported.configVersion } },
    );
    assert.equal(enabled.response.status, 409, JSON.stringify(enabled.body));
    assert.equal(enabled.body.error.code, "FIELD_NOT_FOUND");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

for (const [label, metadataJson] of [
  ["missing fields", "{}"],
  ["malformed JSON", "{"],
]) {
  test(`share import fails closed when local metadata is ${label}`, async () => {
    const fixtureData = await fixture();
    try {
      const baseToken = `bas_unusable_${label === "missing fields" ? "empty" : "malformed"}`;
      const { subjectKey, configuration } = await attachmentShareConfiguration(fixtureData.baseUrl, baseToken);
      fixtureData.app.database.database
        .prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
        .run(metadataJson, subjectKey);

      const dryRun = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
        method: "POST",
        body: { configuration, dryRun: true },
      });
      assert.equal(dryRun.response.status, 200, JSON.stringify(dryRun.body));
      assert.deepEqual(stagedFieldDiagnostics(dryRun.body), [
        ["FIELD_NOT_FOUND", `bases.${baseToken}.subjects.tbl_chinese.stages.initial.videoSource.fieldId`],
        ["FIELD_NOT_FOUND", `bases.${baseToken}.subjects.tbl_chinese.stages.initial.audio.source.fieldId`],
      ]);

      const committed = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
        method: "POST",
        body: { configuration, dryRun: false },
      });
      assert.equal(committed.response.status, 200, JSON.stringify(committed.body));
      assert.deepEqual(stagedFieldDiagnostics(committed.body), stagedFieldDiagnostics(dryRun.body));
      const imported = committed.body.configuration.bases[0].subjects[0];
      assert.deepEqual(imported.metadata, { fields: [] });

      const saved = await request(
        fixtureData.baseUrl,
        `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectKey)}`,
        { method: "PATCH", body: { expectedVersion: imported.configVersion } },
      );
      assert.equal(saved.response.status, 400, JSON.stringify(saved.body));
      assert.equal(saved.body.error.code, "FIELD_NOT_FOUND");

      const enabled = await request(
        fixtureData.baseUrl,
        `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectKey)}/enable`,
        { method: "POST", body: { expectedVersion: imported.configVersion } },
      );
      assert.equal(enabled.response.status, 409, JSON.stringify(enabled.body));
      assert.equal(enabled.body.error.code, "FIELD_NOT_FOUND");
    } finally {
      await fixtureData.app.close();
      await rm(fixtureData.directory, { recursive: true, force: true });
    }
  });
}

test("share import diagnoses staged attachment bindings whose type conflicts with uiType", async () => {
  const fixtureData = await fixture();
  try {
    const metadata = phasedMetadata([
      { fieldId: "fld_text_video", fieldName: "视频文本", type: 1, uiType: "Attachment", options: [] },
      { fieldId: "fld_text_audio", fieldName: "音频文本", type: 17, uiType: "Text", options: [] },
    ]);
    await seedSubject(fixtureData.baseUrl, "bas_wrong_attachment_type", metadata.fields);
    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    const configuration = structuredClone(exported.body.configuration);
    const subject = configuration.bases[0].subjects[0];
    const initial = phasedStage("initial", "opt_initial", "初稿");
    initial.artifactTargetPath = null;
    const firstReview = phasedStage("first_review", "opt_review", "初审修改");
    firstReview.artifactTargetPath = null;
    firstReview.videoSource = { kind: "base_attachment", fieldId: "fld_text_video" };
    const finalReview = phasedStage("final_review", "opt_final", "终审修改");
    finalReview.artifactTargetPath = null;
    finalReview.audio = {
      mode: "replace_original",
      source: { kind: "base_attachment", fieldId: "fld_text_audio" },
      durationToleranceSeconds: 3,
    };
    applyPhasedConfiguration(subject, {
      initial,
      first_review: firstReview,
      final_review: finalReview,
    }, metadata);

    const dryRun = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: true },
    });
    assert.equal(dryRun.response.status, 200, JSON.stringify(dryRun.body));
    assert.deepEqual(
      dryRun.body.diagnostics
        .filter((entry) => entry.path?.includes(".stages."))
        .map((entry) => [entry.code, entry.path]),
      [
        ["FIELD_TYPE_INVALID", "bases.bas_wrong_attachment_type.subjects.tbl_chinese.stages.first_review.videoSource.fieldId"],
        ["FIELD_TYPE_INVALID", "bases.bas_wrong_attachment_type.subjects.tbl_chinese.stages.final_review.audio.source.fieldId"],
      ],
    );
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow share import commits only drafts and keeps local path bindings", async () => {
  const fixtureData = await fixture();
  try {
    const subjectKey = await seedSubject(fixtureData.baseUrl, "bas_source", phasedMetadata().fields);
    const localStages = {
      initial: phasedStage("initial", "opt_initial", "初稿"),
      first_review: phasedStage("first_review", "opt_review", "初审修改"),
      final_review: phasedStage("final_review", "opt_final", "终审修改"),
    };
    const configured = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectKey)}`,
      {
        method: "PATCH",
        body: {
          statusField: { fieldId: "fld_status", fieldName: "流程" },
          documentField: { fieldId: "fld_document", fieldName: "素材文档" },
          namingField: { fieldId: "fld_name", fieldName: "命名" },
          stages: localStages,
        },
      },
    );
    assert.equal(configured.response.status, 200, JSON.stringify(configured.body));
    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    const configuration = structuredClone(exported.body.configuration);
    configuration.bases[0].subjects[0].baseToken = "bas_source";
    configuration.bases[0].subjects[0].subjectKey = subjectKey;
    for (const [index, stageId] of ["initial", "first_review", "final_review"].entries()) {
      configuration.bases[0].subjects[0].stages[stageId].artifactTargetPath = `D:\\untrusted\\stage-${index}`;
    }
    const dryRun = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: true },
    });
    assert.equal(dryRun.response.status, 200, JSON.stringify(dryRun.body));
    assert.deepEqual(
      Object.values(dryRun.body.configuration.bases[0].subjects[0].stages)
        .map((stage) => stage.artifactTargetPath),
      [null, null, null],
    );
    const imported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: false },
    });
    assert.equal(imported.response.status, 200);
    assert.equal(imported.body.dryRun, false);
    assert.equal(imported.body.configuration.bases[0].subjects[0].lifecycle, "draft");
    const catalog = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
    const subject = catalog.body.catalog[0].subjects[0];
    assert.equal(subject.lifecycle, "draft");
    assert.equal(subject.upload.artifactSourcePath, "C:\\Users\\admin\\Desktop\\Auto-Cut-待上传");
    assert.equal(subject.upload.targetPath, "\\\\nas\\剪映草稿\\语文");
    assert.deepEqual(
      Object.fromEntries(Object.entries(subject.stages).map(([stageId, stage]) => [stageId, stage.artifactTargetPath])),
      Object.fromEntries(Object.entries(localStages).map(([stageId, stage]) => [stageId, stage.artifactTargetPath])),
    );
    assert.doesNotMatch(JSON.stringify(subject), /D:\\\\untrusted/u);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow share routes reject unsupported schemas and strip imported path/runtime fields", async () => {
  const fixtureData = await fixture();
  try {
    const badSchema = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration: { schemaVersion: 99, bases: [] }, dryRun: true },
    });
    assert.equal(badSchema.response.status, 400);
    assert.equal(badSchema.body.error.code, "UNSUPPORTED_SCHEMA_VERSION");

    const configuration = {
      schemaVersion: 1,
      bases: [{
        baseToken: "bas_untrusted",
        baseName: "不可信 Base",
        sourceUrlLabel: "https://user:secret@example.test/base?token=secret",
        metadataRefreshedAt: 1710000009000,
        subjects: [{
          subjectKey: "bas_untrusted:tbl_subject",
          baseToken: "bas_untrusted",
          baseName: "不可信 Base",
          tableId: "tbl_subject",
          tableName: "语文",
          displayEnabled: true,
          trigger: { fieldId: "fld_progress", fieldName: "进度", startValue: "待制作", optionId: null },
          title: { fieldId: null, fieldName: null },
          execution: { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] },
          packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
          upload: {
            enqueueMode: "manual", artifactSourceMode: "manual_select",
            artifactSourcePath: "C:\\secret\\source", targetId: "target", targetPath: "C:\\secret\\target", uploadConcurrency: 1,
          },
          metadata: { fields: [{ fieldId: "fld_progress", fieldName: "进度", workspacePath: "C:\\secret" }], claimToken: "secret" },
        }],
      }],
    };
    const imported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST", body: { configuration, dryRun: false },
    });
    assert.equal(imported.response.status, 200);
    const catalog = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
    const serialized = JSON.stringify(catalog.body.catalog);
    assert.doesNotMatch(serialized, /secret|workspacePath|claimToken|taskHistory/i);
    assert.equal(catalog.body.catalog[0].sourceUrlLabel, "https://example.test/base");
    assert.equal(catalog.body.catalog[0].metadataRefreshedAt, null);
    assert.deepEqual(catalog.body.catalog[0].subjects[0].metadata.fields, []);
    assert.equal(catalog.body.catalog[0].subjects[0].upload.artifactSourcePath, null);
    assert.equal(catalog.body.catalog[0].subjects[0].upload.targetPath, null);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});
