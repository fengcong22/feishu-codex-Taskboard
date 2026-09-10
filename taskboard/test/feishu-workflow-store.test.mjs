import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createFeishuWorkflowStore, subjectProjectId } from "../server/feishu-workflow-store.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-workflow-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const store = createFeishuWorkflowStore({ database });
  return { directory, database, store };
}

function preview() {
  return {
    baseToken: "bas_demo",
    baseName: "学科 Base",
    sourceUrlLabel: "https://example.test/base/bas_demo",
    metadataRefreshedAt: 1710000000000,
    tables: [{
      tableId: "tbl_math",
      tableName: "数学",
      fields: [
        { fieldId: "fld_status", fieldName: "待制作", type: 3, uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待制作" }] },
      ],
    }],
  };
}

function subjectPatch() {
  return {
    displayEnabled: true,
    trigger: { fieldId: "fld_status", fieldName: "待制作", startValue: "待制作", optionId: "opt_ready" },
    title: { fieldId: null, fieldName: null },
    execution: { mode: "manual", concurrencyGroup: "autocut", maxConcurrent: 1, resourceGroups: [] },
    packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
    upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
  };
}

function phasedPreview({ attachmentField = { fieldId: "fld_audio", fieldName: "音频", type: 17, uiType: "Attachment", options: [] } } = {}) {
  return {
    ...preview(),
    tables: [{
      ...preview().tables[0],
      fields: [
        ...preview().tables[0].fields,
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
        attachmentField,
      ],
    }],
  };
}

function phasedStage(stageId, optionId, value) {
  return {
    enabled: true,
    trigger: { fieldId: "fld_status", fieldName: "待制作", optionId, value },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "修改意见" },
    audio: { mode: "replace_original", source: { kind: "base_attachment", fieldId: "fld_audio" } },
    artifactTargetPath: `C:\\approved\\${stageId}`,
    nameSuffix: `_${value}`,
  };
}

function phasedPatch() {
  return {
    ...subjectPatch(),
    statusField: { fieldId: "fld_status", fieldName: "待制作" },
    documentField: { fieldId: "fld_document", fieldName: "素材文档" },
    namingField: { fieldId: "fld_name", fieldName: "命名" },
    stages: {
      initial: phasedStage("initial", "opt_ready", "待制作"),
      first_review: { ...phasedStage("first_review", "opt_review", "初审"), enabled: false, trigger: { fieldId: null, fieldName: null, optionId: null, value: null } },
      final_review: { ...phasedStage("final_review", "opt_final", "终审"), enabled: false, trigger: { fieldId: null, fieldName: null, optionId: null, value: null } },
    },
  };
}

test("catalog preview creates independent Base/subject rows and deterministic project ids", async () => {
  const { directory, database, store } = await fixture();
  try {
    const catalog = await store.upsertBasePreview(preview());
    assert.equal(catalog.baseToken, "bas_demo");
    assert.equal(catalog.subjects.length, 1);
    assert.equal(catalog.subjects[0].subjectKey, "bas_demo:tbl_math");
    assert.equal(catalog.subjects[0].projectId, subjectProjectId("bas_demo:tbl_math"));
    assert.match(catalog.subjects[0].projectId, /^feishu-[a-f0-9]{16}$/);
    assert.equal(subjectProjectId("bas_demo:tbl_demo"), "feishu-a20370a3de0f8d3b");
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_bases").get().count, 1);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_subjects").get().count, 1);
    const again = await store.listCatalog();
    assert.deepEqual(again, [catalog]);
    const projectId = subjectProjectId("bas_demo:tbl_math");
    assert.equal(database.getProject(projectId).source, "feishu");
    database.database.prepare("UPDATE projects SET source = 'local' WHERE id = ?").run(projectId);
    await store.upsertBasePreview(preview());
    assert.equal(database.getProject(projectId).source, "feishu");
    assert.throws(
      () => database.setProjectArchived(projectId, true),
      (error) => error.code === "PROJECT_ARCHIVE_FORBIDDEN",
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog preview strips source URL credentials and fragments before persistence", async () => {
  const { directory, database, store } = await fixture();
  try {
    const catalog = await store.upsertBasePreview({
      ...preview(),
      sourceUrlLabel: "https://user:secret@example.test/base/bas_demo?token=secret#fragment",
    });
    assert.equal(catalog.sourceUrlLabel, "https://example.test/base/bas_demo");
    const stored = database.database
      .prepare("SELECT source_url_label FROM feishu_bases WHERE base_token = ?")
      .get("bas_demo");
    assert.equal(stored.source_url_label, "https://example.test/base/bas_demo");
    const listed = await store.listCatalog();
    assert.equal(listed[0].sourceUrlLabel, "https://example.test/base/bas_demo");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog reads sanitize legacy source URL labels before returning them", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    database.database.prepare("UPDATE feishu_bases SET source_url_label = ? WHERE base_token = ?")
      .run("https://user:secret@example.test/base/bas_demo?token=secret#fragment", "bas_demo");

    const listed = await store.listCatalog();
    assert.equal(listed[0].sourceUrlLabel, "https://example.test/base/bas_demo");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog preview rejects malformed Base and table identifiers even without subjects", async () => {
  const { directory, database, store } = await fixture();
  try {
    await assert.rejects(
      () => store.upsertBasePreview({
        ...preview(),
        baseToken: "bas:secret",
        tables: [],
      }),
      (error) => error.code === "INVALID_FIELD" && error.status === 400,
    );
    await assert.rejects(
      () => store.upsertBasePreview({
        ...preview(),
        tables: [{ tableId: "tbl:secret", tableName: "数学", fields: [] }],
      }),
      (error) => error.code === "INVALID_FIELD" && error.status === 400,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing existing metadata validates and versions changed subject display data", async () => {
  const { directory, database, store } = await fixture();
  try {
    const first = await store.upsertBasePreview(preview());
    const before = first.subjects[0];
    const refreshed = await store.upsertBasePreview({
      ...preview(),
      baseName: "学科 Base 2",
      metadataRefreshedAt: 1710000001000,
      tables: [{
        ...preview().tables[0],
        tableName: "数学（更新）",
        fields: [{ fieldId: "fld_status", fieldName: "待制作", type: 3, uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待制作" }, { id: "opt_done", name: "已完成" }] }],
      }],
    });
    const after = refreshed.subjects[0];
    assert.equal(after.baseName, "学科 Base 2");
    assert.equal(after.tableName, "数学（更新）");
    assert.equal(after.configVersion, before.configVersion + 1);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_subject_versions WHERE subject_key = ?").get(after.subjectKey).count, 2);
    const stable = await store.upsertBasePreview({
      ...preview(),
      baseName: "学科 Base 2",
      metadataRefreshedAt: 1710000001000,
      tables: [{
        ...preview().tables[0],
        tableName: "数学（更新）",
        fields: [{ fieldId: "fld_status", fieldName: "待制作", type: 3, uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待制作" }, { id: "opt_done", name: "已完成" }] }],
      }],
    });
    assert.equal(stable.subjects[0].configVersion, after.configVersion);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing an enabled subject demotes it to draft until it is re-enabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-refresh-enabled-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const calls = [];
  const store = createFeishuWorkflowStore({
    database,
    packageAliases: async () => ["Auto-cut-A"],
    syncSubject: async (subject, options) => calls.push({ subject, options }),
  });
  try {
    await store.upsertBasePreview(preview());
    const draft = await store.saveSubjectDraft("bas_demo:tbl_math", subjectPatch());
    const enabled = await store.enableSubject("bas_demo:tbl_math", draft.configVersion);
    assert.equal(enabled.lifecycle, "enabled");

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      baseName: "学科 Base refreshed",
      tables: [{
        ...preview().tables[0],
        tableName: "数学（刷新）",
        fields: [
          ...preview().tables[0].fields,
          { fieldId: "fld_title", fieldName: "标题", type: 1, uiType: "Text", options: [] },
        ],
      }],
    });
    const next = refreshed.subjects[0];
    assert.equal(next.lifecycle, "draft");
    assert.equal(next.configVersion, enabled.configVersion + 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.lifecycle, "enabled");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps renamed phased metadata separate until an explicit repair patch is saved", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-refresh-renamed-options-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const store = createFeishuWorkflowStore({
    database,
    packageAliases: async () => ["Auto-cut-A"],
  });
  try {
    const original = phasedPreview();
    original.tables[0].fields = original.tables[0].fields.map((field) => (
      field.fieldId === "fld_status"
        ? {
          ...field,
          fieldName: "流程状态",
          options: [
            { id: "opt_ready", name: "初稿" },
            { id: "opt_review", name: "初审修改" },
            { id: "opt_final", name: "终审修改" },
          ],
        }
        : field
    ));
    await store.upsertBasePreview(original);

    const patch = phasedPatch();
    patch.trigger = { fieldId: "fld_status", fieldName: "流程状态", startValue: "初稿", optionId: "opt_ready" };
    patch.statusField = { fieldId: "fld_status", fieldName: "流程状态" };
    patch.documentField = { fieldId: "fld_document", fieldName: "素材文档" };
    patch.namingField = { fieldId: "fld_name", fieldName: "命名" };
    patch.stages.initial.trigger = { fieldId: "fld_status", fieldName: "流程状态", optionId: "opt_ready", value: "初稿" };
    patch.stages.initial.nameSuffix = "_自定义后缀";
    patch.stages.first_review = {
      ...phasedStage("first_review", "opt_review", "初审修改"),
      trigger: { fieldId: "fld_status", fieldName: "流程状态", optionId: "opt_review", value: "初审修改" },
    };
    patch.stages.final_review = {
      ...phasedStage("final_review", "opt_final", "终审修改"),
      trigger: { fieldId: "fld_status", fieldName: "流程状态", optionId: "opt_final", value: "终审修改" },
    };
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", patch);
    const enabled = await store.enableSubject(saved.subjectKey, saved.configVersion);

    const refreshedMetadata = structuredClone(original);
    refreshedMetadata.metadataRefreshedAt = 1710000001000;
    refreshedMetadata.tables[0].fields = refreshedMetadata.tables[0].fields.map((field) => {
      if (field.fieldId === "fld_status") {
        return {
          ...field,
          fieldName: "新流程状态",
          options: field.options.map((option) => ({ ...option, name: `新${option.name}` })),
        };
      }
      if (field.fieldId === "fld_document") return { ...field, fieldName: "新素材文档" };
      if (field.fieldId === "fld_name") return { ...field, fieldName: "新命名" };
      return field;
    });

    const refreshed = await store.upsertBasePreview(refreshedMetadata);
    const subject = refreshed.subjects[0];
    assert.equal(subject.lifecycle, "draft");
    assert.equal(subject.configVersion, enabled.configVersion + 1);
    assert.deepEqual(subject.statusField, { fieldId: "fld_status", fieldName: "流程状态" });
    assert.deepEqual(subject.documentField, { fieldId: "fld_document", fieldName: "素材文档" });
    assert.deepEqual(subject.namingField, { fieldId: "fld_name", fieldName: "命名" });
    assert.deepEqual(Object.values(subject.stages).map((stage) => stage.trigger), [
      { fieldId: "fld_status", fieldName: "流程状态", optionId: "opt_ready", value: "初稿" },
      { fieldId: "fld_status", fieldName: "流程状态", optionId: "opt_review", value: "初审修改" },
      { fieldId: "fld_status", fieldName: "流程状态", optionId: "opt_final", value: "终审修改" },
    ]);
    assert.deepEqual(subject.trigger, {
      fieldId: "fld_status",
      fieldName: "流程状态",
      startValue: "初稿",
      optionId: "opt_ready",
    });
    assert.equal(subject.stages.initial.nameSuffix, "_自定义后缀");
    assert.equal(subject.stages.initial.audio.source.fieldId, "fld_audio");
    const refreshedStatus = subject.metadata.fields.find((field) => field.fieldId === "fld_status");
    assert.equal(refreshedStatus.fieldName, "新流程状态");
    assert.deepEqual(refreshedStatus.options.map((option) => option.name), ["新初稿", "新初审修改", "新终审修改"]);

    await assert.rejects(
      () => store.saveSubjectDraft(subject.subjectKey, { expectedVersion: subject.configVersion }),
      (error) => error.code === "TRIGGER_OPTION_NOT_FOUND" && error.status === 400,
    );
    await assert.rejects(
      () => store.enableSubject(subject.subjectKey, subject.configVersion),
      (error) => error.code === "TRIGGER_OPTION_NOT_FOUND" && error.status === 409,
    );

    const repairPatch = structuredClone(patch);
    repairPatch.expectedVersion = subject.configVersion;
    repairPatch.trigger = { fieldId: "fld_status", fieldName: "新流程状态", startValue: "新初稿", optionId: "opt_ready" };
    repairPatch.statusField = { fieldId: "fld_status", fieldName: "新流程状态" };
    repairPatch.documentField = { fieldId: "fld_document", fieldName: "新素材文档" };
    repairPatch.namingField = { fieldId: "fld_name", fieldName: "新命名" };
    for (const stage of Object.values(repairPatch.stages)) {
      stage.trigger.fieldName = "新流程状态";
      stage.trigger.value = `新${stage.trigger.value}`;
    }
    const repaired = await store.saveSubjectDraft(subject.subjectKey, repairPatch);
    assert.equal(repaired.stages.initial.nameSuffix, "_自定义后缀");
    assert.equal(repaired.stages.initial.audio.source.fieldId, "fld_audio");
    const reenabled = await store.enableSubject(repaired.subjectKey, repaired.configVersion);
    assert.equal(reenabled.lifecycle, "enabled");
    assert.equal(reenabled.stages.initial.trigger.value, "新初稿");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps unresolved phased option bindings as a blocked repairable draft after metadata refresh", async () => {
  const { directory, database, store } = await fixture();
  try {
    const original = phasedPreview();
    await store.upsertBasePreview(original);
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());
    const enabled = await store.enableSubject(saved.subjectKey, saved.configVersion);

    const refreshedMetadata = structuredClone(original);
    refreshedMetadata.metadataRefreshedAt = 1710000001000;
    refreshedMetadata.tables[0].fields = refreshedMetadata.tables[0].fields.map((field) => (
      field.fieldId === "fld_status" ? { ...field, options: [] } : field
    ));

    const refreshed = await store.upsertBasePreview(refreshedMetadata);
    const subject = refreshed.subjects[0];
    assert.equal(subject.lifecycle, "draft");
    assert.equal(subject.configVersion, enabled.configVersion + 1);
    assert.deepEqual(subject.stages.initial.trigger, {
      fieldId: "fld_status",
      fieldName: "待制作",
      optionId: "opt_ready",
      value: "待制作",
    });
    assert.deepEqual(subject.trigger, {
      fieldId: "fld_status",
      fieldName: "待制作",
      startValue: "待制作",
      optionId: "opt_ready",
    });
    assert.deepEqual(
      subject.metadata.fields.find((field) => field.fieldId === "fld_status").options,
      [],
    );

    await assert.rejects(
      () => store.saveSubjectDraft(subject.subjectKey, { expectedVersion: subject.configVersion }),
      (error) => error.code === "TRIGGER_OPTION_NOT_FOUND",
    );
    await assert.rejects(
      () => store.enableSubject(subject.subjectKey, subject.configVersion),
      (error) => error.code === "TRIGGER_OPTION_NOT_FOUND",
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects phased save and enable when a configured metadata option id is duplicated", async () => {
  const { directory, database, store } = await fixture();
  try {
    const original = phasedPreview();
    await store.upsertBasePreview(original);
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());
    const enabled = await store.enableSubject(saved.subjectKey, saved.configVersion);

    const duplicate = structuredClone(original);
    duplicate.metadataRefreshedAt = 1710000004000;
    duplicate.tables[0].fields = duplicate.tables[0].fields.map((field) => (
      field.fieldId === "fld_status"
        ? { ...field, options: [{ id: "opt_ready", name: "待制作" }, { id: "opt_ready", name: "重复待制作" }] }
        : field
    ));
    const refreshed = await store.upsertBasePreview(duplicate);
    const draft = refreshed.subjects[0];
    assert.equal(draft.lifecycle, "draft");

    await assert.rejects(
      () => store.saveSubjectDraft(draft.subjectKey, { expectedVersion: draft.configVersion }),
      (error) => error.code === "TRIGGER_OPTION_NOT_UNIQUE" && error.status === 400,
    );
    await assert.rejects(
      () => store.enableSubject(draft.subjectKey, draft.configVersion),
      (error) => error.code === "TRIGGER_OPTION_NOT_UNIQUE" && error.status === 409,
    );
    assert.equal((await store.getSubject(draft.subjectKey)).configVersion, enabled.configVersion + 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects phased save and enable when a configured metadata field id is duplicated", async () => {
  const { directory, database, store } = await fixture();
  try {
    const original = phasedPreview();
    await store.upsertBasePreview(original);
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());
    const enabled = await store.enableSubject(saved.subjectKey, saved.configVersion);

    const duplicate = structuredClone(original);
    duplicate.metadataRefreshedAt = 1710000004500;
    duplicate.tables[0].fields.push({
      ...structuredClone(duplicate.tables[0].fields.find((field) => field.fieldId === "fld_status")),
      fieldName: "重复流程字段",
    });
    const refreshed = await store.upsertBasePreview(duplicate);
    const draft = refreshed.subjects[0];

    await assert.rejects(
      () => store.saveSubjectDraft(draft.subjectKey, { expectedVersion: draft.configVersion }),
      (error) => error.code === "FIELD_NOT_UNIQUE" && error.status === 400,
    );
    await assert.rejects(
      () => store.enableSubject(draft.subjectKey, draft.configVersion),
      (error) => error.code === "TRIGGER_FIELD_NOT_UNIQUE" && error.status === 409,
    );
    assert.equal((await store.getSubject(draft.subjectKey)).configVersion, enabled.configVersion + 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("derives the legacy trigger from the first enabled phased stage on direct repair saves", async () => {
  const { directory, database, store } = await fixture();
  try {
    const original = phasedPreview();
    await store.upsertBasePreview(original);
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());
    const enabled = await store.enableSubject(saved.subjectKey, saved.configVersion);

    const renamed = structuredClone(original);
    renamed.metadataRefreshedAt = 1710000005000;
    renamed.tables[0].fields = renamed.tables[0].fields.map((field) => (
      field.fieldId === "fld_status"
        ? { ...field, options: [{ id: "opt_ready", name: "新初稿" }] }
        : field
    ));
    const refreshed = await store.upsertBasePreview(renamed);
    const draft = refreshed.subjects[0];
    const repaired = await store.saveSubjectDraft(draft.subjectKey, {
      expectedVersion: draft.configVersion,
      statusField: { fieldId: "fld_status", fieldName: "待制作" },
      stages: {
        initial: {
          trigger: { fieldId: "fld_status", fieldName: "待制作", optionId: "opt_ready", value: "新初稿" },
        },
      },
    });

    assert.deepEqual(repaired.trigger, {
      fieldId: "fld_status",
      fieldName: "待制作",
      startValue: "新初稿",
      optionId: "opt_ready",
    });
    const reenabled = await store.enableSubject(repaired.subjectKey, repaired.configVersion);
    assert.equal(reenabled.lifecycle, "enabled");
    assert.equal(reenabled.configVersion, enabled.configVersion + 3);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("metadata refresh preserves an independently stale legacy trigger until repair save", async () => {
  const { directory, database, store } = await fixture();
  try {
    const original = phasedPreview();
    await store.upsertBasePreview(original);
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());
    const stale = structuredClone(saved);
    stale.trigger = { fieldId: "fld_status", fieldName: "旧状态", startValue: "旧值", optionId: "opt_ready" };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(stale), stale.subjectKey);

    const refreshedMetadata = structuredClone(original);
    refreshedMetadata.metadataRefreshedAt = 1710000006000;
    refreshedMetadata.tables[0].fields = refreshedMetadata.tables[0].fields.map((field) => (
      field.fieldId === "fld_status" ? { ...field, fieldName: "刷新状态" } : field
    ));
    const refreshed = await store.upsertBasePreview(refreshedMetadata);
    assert.deepEqual(refreshed.subjects[0].trigger, stale.trigger);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("metadata refresh keeps the previous enabled version routable until re-enable", async () => {
  const { directory, database, store } = await fixture();
  try {
    const original = phasedPreview();
    await store.upsertBasePreview(original);
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());
    const enabled = await store.enableSubject(saved.subjectKey, saved.configVersion);
    const refreshed = await store.upsertBasePreview({
      ...original,
      metadataRefreshedAt: 1710000006500,
      tables: [{ ...original.tables[0], fields: original.tables[0].fields.map((field) => (
        field.fieldId === "fld_status" ? { ...field, fieldName: "刷新状态" } : field
      )) }],
    });
    assert.equal(refreshed.subjects[0].lifecycle, "draft");
    const versionRow = database.database.prepare(
      "SELECT enabled_at, closed_at FROM feishu_subject_versions WHERE subject_key = ? AND version = ?",
    ).get(enabled.subjectKey, enabled.configVersion);
    assert.equal(versionRow.closed_at, null);
    const routed = database.resolveFeishuSubjectVersionAt(enabled.subjectKey, versionRow.enabled_at + 1);
    assert.equal(routed?.configVersion, enabled.configVersion);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("known empty or malformed metadata blocks phased draft saves", async () => {
  const { directory, database, store } = await fixture();
  try {
    const original = phasedPreview();
    await store.upsertBasePreview(original);
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());
    for (const [metadataRefreshedAt, fields] of [
      [1710000007000, []],
      [1710000008000, [
        { fieldId: "fld_status", fieldName: "流程", type: 3, uiType: "SingleSelect" },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ]],
    ]) {
      const refreshed = await store.upsertBasePreview({
        ...original,
        metadataRefreshedAt,
        tables: [{ ...original.tables[0], fields }],
      });
      await assert.rejects(
        () => store.saveSubjectDraft(refreshed.subjects[0].subjectKey, { expectedVersion: refreshed.subjects[0].configVersion }),
        (error) => ["FIELD_NOT_FOUND", "TRIGGER_OPTION_NOT_FOUND"].includes(error.code) && error.status === 400,
      );
    }
    assert.equal((await store.getSubject(saved.subjectKey)).lifecycle, "draft");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("database Feishu archive reports a missing task as TASK_NOT_FOUND", async () => {
  const { directory, database } = await fixture();
  try {
    assert.throws(
      () => database.archiveFeishuTask("missing-task", 1, { type: "system", id: "test", name: "test" }),
      (error) => error.code === "TASK_NOT_FOUND" && error.status === 404,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("subject draft save increments version and enable/disable use optimistic checks", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    const key = "bas_demo:tbl_math";
    const draft = await store.saveSubjectDraft(key, subjectPatch());
    assert.equal(draft.lifecycle, "draft");
    assert.equal(draft.configVersion, 2);
    const enabled = await store.enableSubject(key, draft.configVersion);
    assert.equal(enabled.lifecycle, "enabled");
    assert.equal(enabled.configVersion, 3);
    await assert.rejects(
      () => store.disableSubject(key, draft.configVersion),
      (error) => error.code === "VERSION_CONFLICT" && error.status === 409,
    );
    const disabled = await store.disableSubject(key, enabled.configVersion);
    assert.equal(disabled.lifecycle, "disabled");
    assert.equal(disabled.configVersion, 4);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_subject_versions").get().count, 4);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabling driver reporting requires an artifact source path", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    const draft = await store.saveSubjectDraft("bas_demo:tbl_math", {
      ...subjectPatch(),
      upload: {
        ...subjectPatch().upload,
        artifactSourceMode: "driver_report",
        artifactSourcePath: null,
      },
    });

    await assert.rejects(
      () => store.enableSubject(draft.subjectKey, draft.configVersion),
      (error) => error.code === "ARTIFACT_SOURCE_PATH_UNBOUND" && error.status === 409,
    );
    const current = await store.getSubject(draft.subjectKey);
    assert.equal(current.lifecycle, "draft");
    assert.equal(current.configVersion, draft.configVersion);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("subject draft accepts a human-readable upload target alias", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    const draft = await store.saveSubjectDraft("bas_demo:tbl_math", {
      ...subjectPatch(),
      upload: {
        ...subjectPatch().upload,
        targetId: "0901上传测试",
        targetPath: "W:\\[剪映草稿]\\高中历史\\01初版草稿",
      },
    });
    assert.equal(draft.upload.targetId, "0901上传测试");
    assert.equal(draft.upload.targetPath, "W:\\[剪映草稿]\\高中历史\\01初版草稿");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabling rejects trigger fields and select options missing from refreshed Base metadata", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    const missingField = await store.saveSubjectDraft("bas_demo:tbl_math", {
      ...subjectPatch(),
      trigger: { fieldId: "fld_missing", fieldName: "不存在", startValue: "待制作", optionId: null },
    });
    await assert.rejects(
      () => store.enableSubject(missingField.subjectKey, missingField.configVersion),
      (error) => error.code === "TRIGGER_FIELD_NOT_FOUND" && error.status === 409,
    );

    const missingOption = await store.saveSubjectDraft("bas_demo:tbl_math", {
      ...subjectPatch(),
      expectedVersion: missingField.configVersion,
      trigger: { fieldId: "fld_status", fieldName: "待制作", startValue: "不存在", optionId: "opt_missing" },
    });
    await assert.rejects(
      () => store.enableSubject(missingOption.subjectKey, missingOption.configVersion),
      (error) => error.code === "TRIGGER_OPTION_NOT_FOUND" && error.status === 409,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("subject draft snake_case phased patch overwrites persisted camelCase values", async () => {
  const { directory, database, store } = await fixture();
  try {
    const basePreview = phasedPreview();
    basePreview.tables[0].fields.push(
      {
        fieldId: "fld_status_next",
        fieldName: "新流程",
        type: 3,
        uiType: "SingleSelect",
        options: [{ id: "opt_next", name: "新阶段" }],
      },
      { fieldId: "fld_document_next", fieldName: "新素材文档", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_name_next", fieldName: "新命名", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_audio_next", fieldName: "新音频", type: 17, uiType: "Attachment", options: [] },
    );
    await store.upsertBasePreview(basePreview);
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());

    const updated = await store.saveSubjectDraft(saved.subjectKey, {
      expectedVersion: saved.configVersion,
      statusField: { field_id: "fld_status_next", field_name: "新流程" },
      documentField: { field_id: "fld_document_next", field_name: "新素材文档" },
      namingField: { field_id: "fld_name_next", field_name: "新命名" },
      stages: {
        initial: {
          trigger: {
            field_id: "fld_status_next",
            field_name: "新流程",
            option_id: "opt_next",
            start_value: "新阶段",
          },
          video_source: { kind: "base_attachment", field_id: "fld_audio_next" },
          review_source: { kind: "docx_section", anchor_text: "新修改意见" },
          audio: {
            mode: "replace_original",
            source: { kind: "base_attachment", field_id: "fld_audio_next" },
            duration_tolerance_seconds: 1.25,
          },
          artifact_target_path: "C:\\approved\\updated",
          name_suffix: "_新阶段",
        },
      },
    });

    assert.deepEqual(updated.statusField, { fieldId: "fld_status_next", fieldName: "新流程" });
    assert.deepEqual(updated.documentField, { fieldId: "fld_document_next", fieldName: "新素材文档" });
    assert.deepEqual(updated.namingField, { fieldId: "fld_name_next", fieldName: "新命名" });
    assert.deepEqual(updated.stages.initial.trigger, {
      fieldId: "fld_status_next",
      fieldName: "新流程",
      optionId: "opt_next",
      value: "新阶段",
    });
    assert.deepEqual(updated.stages.initial.videoSource, { kind: "base_attachment", fieldId: "fld_audio_next" });
    assert.deepEqual(updated.stages.initial.reviewSource, { kind: "docx_section", anchorText: "新修改意见" });
    assert.deepEqual(updated.stages.initial.audio, {
      mode: "replace_original",
      source: { kind: "base_attachment", fieldId: "fld_audio_next" },
      durationToleranceSeconds: 1.25,
    });
    assert.equal(updated.stages.initial.artifactTargetPath, "C:\\approved\\updated");
    assert.equal(updated.stages.initial.nameSuffix, "_新阶段");
    assert.doesNotMatch(JSON.stringify(updated), /(?:field_id|field_name|option_id|start_value|video_source|review_source|anchor_text|duration_tolerance_seconds|artifact_target_path|name_suffix)/u);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("subject draft canonicalizes top-level trigger snake_case aliases", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", subjectPatch());
    const updated = await store.saveSubjectDraft(saved.subjectKey, {
      expectedVersion: saved.configVersion,
      trigger: { field_id: "fld_status", field_name: "待制作", start_value: "待制作", option_id: "opt_ready" },
    });
    assert.deepEqual(updated.trigger, {
      fieldId: "fld_status",
      fieldName: "待制作",
      startValue: "待制作",
      optionId: "opt_ready",
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("subject draft rejects conflicting phased aliases and unknown keys hidden in snake_case patches", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(phasedPreview());
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());

    const rejectedPatches = [
      {
        patch: { stages: { initial: { nameSuffix: "_safe", name_suffix: "_conflict" } } },
        path: "stages.initial.nameSuffix",
      },
      {
        patch: { stages: { initial: { video_source: { kind: "docx_section", anchor_text: "safe", command: "run" } } } },
        path: "stages.initial.videoSource.command",
      },
      {
        patch: { stages: { initial: { audio: { source: { kind: "base_attachment", field_id: "fld_audio", credential: "secret" } } } } },
        path: "stages.initial.audio.source.credential",
      },
      {
        patch: { statusField: { fieldId: "fld_status", field_id: "fld_other" } },
        path: "statusField.fieldId",
      },
      { patch: { statusField: { command: "run" } }, path: "statusField.command" },
      { patch: { documentField: { credential: "secret" } }, path: "documentField.credential" },
      { patch: { namingField: { executable: "tool.exe" } }, path: "namingField.executable" },
    ];

    for (const { patch, path: rejectedPath } of rejectedPatches) {
      await assert.rejects(
        () => store.saveSubjectDraft(saved.subjectKey, { expectedVersion: saved.configVersion, ...patch }),
        (error) => ["INVALID_FIELD", "UNKNOWN_FIELD"].includes(error?.code)
          && error.status === 400
          && error.message.includes(rejectedPath),
        rejectedPath,
      );
    }
    assert.equal((await store.getSubject(saved.subjectKey)).configVersion, saved.configVersion);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains stale phased attachment bindings after refresh but rejects save and enable", async () => {
  const { directory, database, store } = await fixture();
  try {
    const basePreview = phasedPreview({
      attachmentField: { fieldId: "fld_audio", fieldName: "音频", type: 17, uiType: "Attachment", options: [] },
    });
    await store.upsertBasePreview(basePreview);
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());
    const enabled = await store.enableSubject(saved.subjectKey, saved.configVersion);
    assert.equal(enabled.lifecycle, "enabled");

    const removed = await store.upsertBasePreview({
      ...basePreview,
      metadataRefreshedAt: 1710000002000,
      tables: [{ ...basePreview.tables[0], fields: basePreview.tables[0].fields.filter((field) => field.fieldId !== "fld_audio") }],
    });
    const stale = removed.subjects[0];
    assert.equal(stale.lifecycle, "draft");
    assert.equal(stale.stages.initial.audio.source.fieldId, "fld_audio");

    await assert.rejects(
      () => store.saveSubjectDraft(stale.subjectKey, { expectedVersion: stale.configVersion }),
      (error) => error.code === "FIELD_NOT_FOUND" && error.status === 409,
    );
    await assert.rejects(
      () => store.enableSubject(stale.subjectKey, stale.configVersion),
      (error) => error.code === "FIELD_NOT_FOUND" && error.status === 409,
    );

    const changedType = await store.upsertBasePreview({
      ...basePreview,
      metadataRefreshedAt: 1710000003000,
      tables: [{
        ...basePreview.tables[0],
        fields: basePreview.tables[0].fields.map((field) => (
          field.fieldId === "fld_audio" ? { ...field, type: 1, uiType: "Text" } : field
        )),
      }],
    });
    const wrongType = changedType.subjects[0];
    assert.equal(wrongType.stages.initial.audio.source.fieldId, "fld_audio");
    await assert.rejects(
      () => store.saveSubjectDraft(wrongType.subjectKey, { expectedVersion: wrongType.configVersion }),
      (error) => error.code === "FIELD_TYPE_INVALID" && error.status === 409,
    );
    await assert.rejects(
      () => store.enableSubject(wrongType.subjectKey, wrongType.configVersion),
      (error) => error.code === "FIELD_TYPE_INVALID" && error.status === 409,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("display visibility toggles independently without changing lifecycle or config version", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(preview());
    const key = "bas_demo:tbl_math";
    const before = await store.getSubject(key);
    assert.equal(before.displayEnabled, false);
    assert.equal(before.lifecycle, "draft");
    const shown = await store.setSubjectDisplayEnabled(key, true);
    assert.equal(shown.displayEnabled, true);
    assert.equal(shown.lifecycle, "draft");
    assert.equal(shown.configVersion, before.configVersion);
    const enabled = await store.saveSubjectDraft(key, subjectPatch());
    const hidden = await store.setSubjectDisplayEnabled(key, false);
    assert.equal(hidden.displayEnabled, false);
    assert.equal(hidden.lifecycle, enabled.lifecycle);
    assert.equal(hidden.configVersion, enabled.configVersion);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_subject_versions").get().count, 2);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("lifecycle transition synchronizes with Bridge before committing locally", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-sync-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const calls = [];
  const store = createFeishuWorkflowStore({
    database,
    packageAliases: async () => ["Auto-cut-A"],
    syncSubject: async (subject, options) => {
      calls.push({ subject, options });
      if (options.lifecycle === "disabled") throw new Error("bridge unavailable");
    },
  });
  try {
    await store.upsertBasePreview(preview());
    const draft = await store.saveSubjectDraft("bas_demo:tbl_math", subjectPatch());
    const enabled = await store.enableSubject("bas_demo:tbl_math", draft.configVersion);
    assert.equal(enabled.lifecycle, "enabled");
    assert.equal(calls[0].options.lifecycle, "enabled");
    await assert.rejects(
      () => store.disableSubject("bas_demo:tbl_math", enabled.configVersion),
      /bridge unavailable/,
    );
    assert.equal((await store.getSubject("bas_demo:tbl_math")).lifecycle, "enabled");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
