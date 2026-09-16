import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { STAGE_IDS, createFeishuWorkflowStore, subjectProjectId } from "../server/feishu-workflow-store.mjs";

async function fixture(storeOptions = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-workflow-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const store = createFeishuWorkflowStore({ database, ...storeOptions });
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

function defaultTable({ tableId, tableName, prefix }) {
  return {
    tableId,
    tableName,
    fields: [
      {
        fieldId: `${prefix}_status`,
        fieldName: `${tableName}流程状态`,
        type: 3,
        uiType: "SingleSelect",
        options: [
          { id: `${prefix}_draft`, name: `${prefix}初稿` },
          { id: `${prefix}_first_review`, name: `${prefix}初审修改` },
          { id: `${prefix}_final_review`, name: `${prefix}终审修改` },
        ],
      },
      { fieldId: `${prefix}_document`, fieldName: `${tableName}素材文档`, type: 1, uiType: "Text", options: [] },
      { fieldId: `${prefix}_naming`, fieldName: `${tableName}命名`, type: 1, uiType: "Text", options: [] },
      { fieldId: `${prefix}_attachment`, fieldName: `${tableName}视频`, type: 17, uiType: "Attachment", options: [] },
    ],
  };
}

for (const fieldsAvailable of [true, false]) {
  test(`newly discovered subjects default to automatic drafts with ${fieldsAvailable ? "complete" : "missing"} metadata`, async () => {
    let syncCalls = 0;
    const { directory, database, store } = await fixture({
      syncSubject: async () => { syncCalls += 1; },
    });
    try {
      const metadata = phasedPreview();
      if (!fieldsAvailable) metadata.tables[0].fields = [];
      const catalog = await store.upsertBasePreview(metadata);
      const subject = catalog.subjects[0];

      assert.deepEqual(subject.execution, {
        mode: "automatic",
        concurrencyGroup: "default",
        maxConcurrent: 1,
        resourceGroups: [],
      });
      assert.equal(subject.lifecycle, "draft");
      assert.equal(subject.displayEnabled, false);
      assert.equal(subject.upload.enqueueMode, "manual");
      assert.equal(syncCalls, 0);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const mode of ["manual", "automatic"]) {
  test(`metadata refresh and restoration preserve an existing ${mode} subject's execution settings`, async () => {
    const { directory, database, store } = await fixture();
    try {
      const metadata = phasedPreview();
      const catalog = await store.upsertBasePreview(metadata);
      const subject = catalog.subjects[0];
      const execution = { mode, concurrencyGroup: "existing", maxConcurrent: 2, resourceGroups: ["cpu"] };
      await store.saveSubjectDraft(subject.subjectKey, {
        expectedVersion: subject.configVersion,
        execution,
      });

      const unchanged = await store.upsertBasePreview(metadata);
      assert.deepEqual(unchanged.subjects[0].execution, execution);
      const changedMetadata = {
        ...metadata,
        tables: [{ ...metadata.tables[0], tableName: "数学（已刷新）" }],
      };
      const refreshed = await store.upsertBasePreview(changedMetadata);
      assert.deepEqual(refreshed.subjects[0].execution, execution);

      await store.removeSubject(subject.subjectKey);
      const restored = await store.upsertBasePreview(changedMetadata);
      assert.deepEqual(restored.subjects[0].execution, execution);
      assert.equal(restored.subjects[0].lifecycle, "disabled");

      await store.removeSubject(subject.subjectKey);
      const restoredWithChanges = await store.upsertBasePreview(metadata);
      assert.deepEqual(restoredWithChanges.subjects[0].execution, execution);
      assert.equal(restoredWithChanges.subjects[0].lifecycle, "disabled");
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const removed of [false, true]) {
  test(`refreshing a ${removed ? "removed" : "persisted"} legacy subject without execution keeps the manual fallback`, async () => {
    const { directory, database, store } = await fixture();
    try {
      const metadata = phasedPreview();
      const catalog = await store.upsertBasePreview(metadata);
      const subject = catalog.subjects[0];
      if (removed) await store.removeSubject(subject.subjectKey);
      const legacy = { ...subject };
      for (const field of ["execution", "statusField", "documentField", "namingField", "stages"]) {
        delete legacy[field];
      }
      database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
        .run(JSON.stringify(legacy), subject.subjectKey);

      const refreshed = await store.upsertBasePreview(metadata);
      assert.equal(refreshed.subjects[0].execution.mode, "manual");
      assert.equal(refreshed.subjects[0].lifecycle, removed ? "disabled" : "draft");
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const legacyShape of [false, true]) {
  test(`a shared ${legacyShape ? "legacy" : "phased"} configuration without execution imports as a manual draft`, async () => {
    const source = await fixture();
    const target = await fixture();
    try {
      await source.store.upsertBasePreview(phasedPreview());
      const configuration = await source.store.exportShareable();
      const sharedSubject = configuration.bases[0].subjects[0];
      delete sharedSubject.execution;
      if (legacyShape) {
        for (const field of ["statusField", "documentField", "namingField", "stages"]) delete sharedSubject[field];
      }

      const dryRun = await target.store.importShareable(configuration, { dryRun: true });
      assert.equal(dryRun.configuration.bases[0].subjects[0].execution.mode, "manual");
      const imported = await target.store.importShareable(configuration);
      assert.equal(imported.catalog[0].subjects[0].execution.mode, "manual");
      assert.equal(imported.catalog[0].subjects[0].lifecycle, "draft");
    } finally {
      source.database.close();
      target.database.close();
      await rm(source.directory, { recursive: true, force: true });
      await rm(target.directory, { recursive: true, force: true });
    }
  });
}

test("new tables receive complete phased defaults with independent field and option bindings", async () => {
  const { directory, database, store } = await fixture();
  try {
    const mathTable = defaultTable({ tableId: "tbl_math", tableName: "数学", prefix: "math" });
    const historyTable = defaultTable({ tableId: "tbl_history", tableName: "历史", prefix: "history" });
    const catalog = await store.upsertBasePreview({
      ...preview(),
      tables: [mathTable, historyTable],
    });

    assert.equal(catalog.subjects.length, 2);
    for (const [subject, table, prefix] of [
      [catalog.subjects.find((entry) => entry.tableId === "tbl_math"), mathTable, "math"],
      [catalog.subjects.find((entry) => entry.tableId === "tbl_history"), historyTable, "history"],
    ]) {
      assert.equal(subject.lifecycle, "draft");
      assert.deepEqual(subject.statusField, {
        fieldId: `${prefix}_status`,
        fieldName: `${table.tableName}流程状态`,
      });
      assert.deepEqual(subject.documentField, {
        fieldId: `${prefix}_document`,
        fieldName: `${table.tableName}素材文档`,
      });
      assert.deepEqual(subject.namingField, {
        fieldId: `${prefix}_naming`,
        fieldName: `${table.tableName}命名`,
      });
      assert.deepEqual(Object.keys(subject.stages), ["initial", "first_review", "final_review"]);

      const expectedStages = [
        ["initial", true, `${prefix}_draft`, `${prefix}初稿`, "_初稿"],
        ["first_review", false, `${prefix}_first_review`, `${prefix}初审修改`, "_初审修改"],
        ["final_review", false, `${prefix}_final_review`, `${prefix}终审修改`, "_终审修改"],
      ];
      for (const [stageId, enabled, optionId, value, nameSuffix] of expectedStages) {
        assert.deepEqual(subject.stages[stageId], {
          enabled,
          trigger: {
            fieldId: `${prefix}_status`,
            fieldName: `${table.tableName}流程状态`,
            optionId,
            value,
          },
          videoSource: { kind: "docx_section", anchorText: "录屏" },
          reviewSource: { kind: "docx_section", anchorText: "修改意见" },
          audio: { mode: "video_original" },
          artifactTargetPath: null,
          nameSuffix,
        });
      }
    }

    const mathSubject = catalog.subjects.find((subject) => subject.tableId === "tbl_math");
    const historySubject = catalog.subjects.find((subject) => subject.tableId === "tbl_history");
    assert.notEqual(mathSubject.statusField.fieldId, historySubject.statusField.fieldId);
    assert.notEqual(mathSubject.stages.initial.trigger.optionId, historySubject.stages.initial.trigger.optionId);
    assert.equal(mathSubject.metadata.fields.some((field) => field.fieldId === "history_status"), false);
    assert.equal(historySubject.metadata.fields.some((field) => field.fieldId === "math_status"), false);
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM feishu_subjects").get().count, 2);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("status-only table keeps missing document and naming bindings pending and cannot be enabled", async () => {
  let syncCalls = 0;
  const { directory, database, store } = await fixture({
    syncSubject: async () => { syncCalls += 1; },
  });
  try {
    const catalog = await store.upsertBasePreview(preview());
    const subject = catalog.subjects[0];

    assert.deepEqual(subject.statusField, { fieldId: "fld_status", fieldName: "待制作" });
    assert.deepEqual(subject.documentField, { fieldId: "pending_document_field", fieldName: "待配置" });
    assert.deepEqual(subject.namingField, { fieldId: "pending_naming_field", fieldName: "待配置" });
    assert.deepEqual(Object.keys(subject.stages), ["initial", "first_review", "final_review"]);

    await assert.rejects(
      () => store.enableSubject(subject.subjectKey, subject.configVersion),
      (error) => ["FIELD_NOT_FOUND", "TRIGGER_FIELD_NOT_FOUND"].includes(error.code),
    );
    const unchanged = await store.getSubject(subject.subjectKey);
    assert.equal(unchanged.lifecycle, "draft");
    assert.equal(unchanged.configVersion, subject.configVersion);
    assert.equal(syncCalls, 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing a legacy subject upgrades it to phased defaults while preserving local settings", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_math", tableName: "数学", prefix: "legacy" });
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [table],
    });
    const key = initial.subjects[0].subjectKey;
    const legacyExecution = {
      mode: "automatic",
      concurrencyGroup: "legacy-group",
      maxConcurrent: 3,
      resourceGroups: ["legacy-cpu"],
    };
    const legacyPackageRoute = {
      routeMode: "fixed",
      packageAlias: "Legacy-Pack",
      subjectCodeFieldId: null,
      branchMap: { legacy: "Legacy-Branch" },
    };
    const legacyUpload = {
      enqueueMode: "automatic",
      artifactSourceMode: "watch_directory",
      artifactSourcePath: "C:\\legacy\\input",
      targetId: "legacy-target",
      targetPath: "D:\\legacy\\output",
      uploadConcurrency: 4,
    };
    const legacy = {
      ...initial.subjects[0],
      displayEnabled: true,
      trigger: { fieldId: "legacy_status", fieldName: "数学流程状态", startValue: "legacy初稿", optionId: "legacy_draft" },
      title: { fieldId: "legacy_title", fieldName: "旧标题" },
      execution: legacyExecution,
      packageRoute: legacyPackageRoute,
      upload: legacyUpload,
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET display_enabled = ?, config_json = ? WHERE subject_key = ?")
      .run(1, JSON.stringify(legacy), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001000,
      tables: [{
        ...table,
        tableName: "数学（刷新）",
        fields: [...table.fields, { fieldId: "legacy_extra", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });
    const migrated = refreshed.subjects[0];

    assert.equal(migrated.lifecycle, "draft");
    assert.equal(migrated.configVersion, initial.subjects[0].configVersion + 1);
    assert.equal(migrated.displayEnabled, true);
    assert.deepEqual(migrated.trigger, legacy.trigger);
    assert.deepEqual(migrated.title, legacy.title);
    assert.deepEqual(migrated.execution, legacyExecution);
    assert.deepEqual(migrated.packageRoute, legacyPackageRoute);
    assert.deepEqual(migrated.upload, legacyUpload);
    assert.deepEqual(migrated.statusField, { fieldId: "legacy_status", fieldName: "数学流程状态" });
    assert.deepEqual(migrated.documentField, { fieldId: "legacy_document", fieldName: "数学素材文档" });
    assert.deepEqual(migrated.namingField, { fieldId: "legacy_naming", fieldName: "数学命名" });
    assert.equal(Object.keys(migrated.stages).length, 3);
    assert.deepEqual(migrated.stages.initial.trigger, {
      fieldId: "legacy_status",
      fieldName: "数学流程状态",
      optionId: "legacy_draft",
      value: "legacy初稿",
    });
    assert.equal(migrated.stages.initial.artifactTargetPath, legacyUpload.targetPath);
    const reenabled = await store.enableSubject(migrated.subjectKey, migrated.configVersion);
    assert.equal(reenabled.lifecycle, "enabled");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy migration projects a retained manual upload target onto the enabled stage", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_manual_upload", tableName: "手动上传", prefix: "manual-upload" });
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = initial.subjects[0];
    const targetPath = "D:\\legacy-manual-upload";
    const legacy = {
      ...subject,
      upload: {
        ...subject.upload,
        enqueueMode: "manual",
        targetId: "legacy-manual-target",
        targetPath,
      },
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), subject.subjectKey);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001100,
      tables: [table],
    });
    const migrated = refreshed.subjects[0];

    assert.equal(migrated.upload.enqueueMode, "manual");
    assert.equal(migrated.upload.targetPath, targetPath);
    assert.equal(migrated.stages.initial.enabled, true);
    assert.equal(migrated.stages.initial.artifactTargetPath, targetPath);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy migration keeps its uniquely matched trigger field and non-first option when re-enabled", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = {
      tableId: "tbl_legacy_trigger",
      tableName: "旧触发配置",
      fields: [
        {
          fieldId: "fld_unrelated_status",
          fieldName: "无关状态",
          type: 3,
          uiType: "SingleSelect",
          options: [{ id: "opt_unrelated", name: "无关选项" }],
        },
        {
          fieldId: "fld_legacy_status",
          fieldName: "实际流程状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_legacy_other", name: "其他" },
            { id: "opt_legacy_ready", name: "待剪辑" },
            { id: "opt_legacy_review", name: "待审核" },
          ],
        },
        { fieldId: "fld_legacy_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_legacy_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const key = initial.subjects[0].subjectKey;
    const legacy = {
      ...initial.subjects[0],
      trigger: {
        fieldId: "fld_legacy_status",
        fieldName: "实际流程状态",
        startValue: "待剪辑",
        optionId: "opt_legacy_ready",
      },
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001250,
      tables: [{
        ...table,
        fields: [...table.fields, { fieldId: "fld_note", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });
    const migrated = refreshed.subjects[0];

    assert.deepEqual(migrated.statusField, {
      fieldId: "fld_legacy_status",
      fieldName: "实际流程状态",
    });
    assert.deepEqual(migrated.stages.initial.trigger, {
      fieldId: "fld_legacy_status",
      fieldName: "实际流程状态",
      optionId: "opt_legacy_ready",
      value: "待剪辑",
    });

    const reenabled = await store.enableSubject(key, migrated.configVersion);
    assert.deepEqual(reenabled.trigger, legacy.trigger);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy migration preserves snake_case trigger bindings", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_legacy_snake_trigger", tableName: "旧蛇形触发", prefix: "legacy-snake" });
    table.fields[0].options = [
      { id: "legacy-snake_other", name: "其他" },
      { id: "legacy-snake_ready", name: "待剪辑" },
      { id: "legacy-snake_final", name: "终审修改" },
    ];
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const key = initial.subjects[0].subjectKey;
    const legacy = {
      ...initial.subjects[0],
      trigger: {
        field_id: "legacy-snake_status",
        field_name: "旧状态",
        start_value: "待剪辑",
        option_id: "legacy-snake_ready",
      },
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001295,
      tables: [table],
    });
    const migrated = refreshed.subjects[0];

    assert.deepEqual(migrated.statusField, {
      fieldId: "legacy-snake_status",
      fieldName: "旧蛇形触发流程状态",
    });
    assert.deepEqual(migrated.stages.initial.trigger, {
      fieldId: "legacy-snake_status",
      fieldName: "旧蛇形触发流程状态",
      optionId: "legacy-snake_ready",
      value: "待剪辑",
    });
    const reenabled = await store.enableSubject(key, migrated.configVersion);
    assert.equal(reenabled.trigger.optionId, "legacy-snake_ready");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy migration refreshes the label of a uniquely matched option before re-enabling", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_legacy_renamed_option", tableName: "旧选项改名", prefix: "renamed-option" });
    table.fields[0].options = [
      { id: "renamed-option_other", name: "其他" },
      { id: "renamed-option_ready", name: "新待剪辑" },
      { id: "renamed-option_review", name: "待审核" },
    ];
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const key = initial.subjects[0].subjectKey;
    const legacy = {
      ...initial.subjects[0],
      trigger: {
        fieldId: "renamed-option_status",
        fieldName: "旧状态名称",
        startValue: "旧待剪辑",
        optionId: "renamed-option_ready",
      },
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001260,
      tables: [{
        ...table,
        fields: [...table.fields, { fieldId: "fld_rename_note", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });
    const migrated = refreshed.subjects[0];

    assert.deepEqual(migrated.trigger, {
      fieldId: "renamed-option_status",
      fieldName: "旧选项改名流程状态",
      startValue: "新待剪辑",
      optionId: "renamed-option_ready",
    });
    const reenabled = await store.enableSubject(key, migrated.configVersion);
    assert.equal(reenabled.lifecycle, "enabled");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy migration resolves a missing option id by one unique start value", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_legacy_value", tableName: "旧值触发", prefix: "legacy-value" });
    table.fields[0].options = [
      { id: "opt_other", name: "其他" },
      { id: "opt_ready", name: "待剪辑" },
      { id: "opt_review", name: "待审核" },
    ];
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const key = initial.subjects[0].subjectKey;
    const legacy = {
      ...initial.subjects[0],
      trigger: {
        fieldId: "legacy-value_status",
        fieldName: "旧值触发流程状态",
        startValue: "待剪辑",
        optionId: null,
      },
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001275,
      tables: [{
        ...table,
        fields: [...table.fields, { fieldId: "fld_value_note", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });
    const migrated = refreshed.subjects[0];

    assert.equal(migrated.stages.initial.trigger.optionId, "opt_ready");
    assert.equal(migrated.stages.initial.trigger.value, "待剪辑");
    const reenabled = await store.enableSubject(key, migrated.configVersion);
    assert.equal(reenabled.trigger.optionId, "opt_ready");
    assert.equal(reenabled.trigger.startValue, "待剪辑");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy migration keeps an ambiguous start value repairable instead of guessing the first option", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_legacy_ambiguous", tableName: "旧歧义触发", prefix: "legacy-ambiguous" });
    table.fields[0].options = [
      { id: "opt_ready_a", name: "待剪辑" },
      { id: "opt_ready_b", name: "待剪辑" },
      { id: "opt_review", name: "待审核" },
    ];
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const key = initial.subjects[0].subjectKey;
    const legacy = {
      ...initial.subjects[0],
      trigger: {
        fieldId: "legacy-ambiguous_status",
        fieldName: "旧歧义触发流程状态",
        startValue: "待剪辑",
        optionId: null,
      },
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001285,
      tables: [{
        ...table,
        fields: [...table.fields, { fieldId: "fld_ambiguous_note", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });
    const migrated = refreshed.subjects[0];

    assert.equal(migrated.stages.initial.trigger.optionId, "pending_initial_option");
    assert.equal(migrated.stages.initial.trigger.value, "待剪辑");
    assert.equal(migrated.trigger.optionId, "pending_initial_option");
    await assert.rejects(
      () => store.enableSubject(key, migrated.configVersion),
      (error) => error.code === "TRIGGER_OPTION_NOT_FOUND" && error.status === 409,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy migration keeps a missing trigger field repairable instead of selecting another status field", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_legacy_missing", tableName: "旧缺失触发", prefix: "available" });
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const key = initial.subjects[0].subjectKey;
    const legacy = {
      ...initial.subjects[0],
      trigger: {
        fieldId: "fld_removed_status",
        fieldName: "已删除流程状态",
        startValue: "待剪辑",
        optionId: "opt_removed_ready",
      },
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001290,
      tables: [{
        ...table,
        fields: [...table.fields, { fieldId: "fld_missing_note", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });
    const migrated = refreshed.subjects[0];

    assert.deepEqual(migrated.statusField, {
      fieldId: "fld_removed_status",
      fieldName: "已删除流程状态",
    });
    assert.deepEqual(migrated.stages.initial.trigger, {
      fieldId: "fld_removed_status",
      fieldName: "已删除流程状态",
      optionId: "opt_removed_ready",
      value: "待剪辑",
    });
    await assert.rejects(
      () => store.enableSubject(key, migrated.configVersion),
      (error) => error.code === "TRIGGER_FIELD_NOT_FOUND" && error.status === 409,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing a disabled legacy subject preserves disabled lifecycle while adding phased defaults", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_math", tableName: "数学", prefix: "legacy-disabled" });
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [table],
    });
    const key = initial.subjects[0].subjectKey;
    const legacy = {
      ...initial.subjects[0],
      lifecycle: "disabled",
      trigger: { fieldId: "legacy_status", fieldName: "旧状态", startValue: "旧值", optionId: "legacy_draft" },
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET lifecycle = ?, config_json = ? WHERE subject_key = ?")
      .run("disabled", JSON.stringify(legacy), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001500,
      tables: [{
        ...table,
        tableName: "数学（停用刷新）",
        fields: [...table.fields, { fieldId: "legacy_disabled_extra", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });
    const migrated = refreshed.subjects[0];

    assert.equal(migrated.lifecycle, "disabled");
    assert.equal(migrated.configVersion, initial.subjects[0].configVersion + 1);
    assert.equal(Object.keys(migrated.stages).length, 3);
    assert.deepEqual(migrated.statusField, { fieldId: "legacy_status", fieldName: "旧状态" });
    assert.deepEqual(migrated.stages.initial.trigger, {
      fieldId: "legacy_status",
      fieldName: "旧状态",
      optionId: "legacy_draft",
      value: "旧值",
    });
    await assert.rejects(
      () => store.enableSubject(key, migrated.configVersion),
      (error) => error.code === "TRIGGER_FIELD_NOT_FOUND" && error.status === 409,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing a partial phased subject fills missing bindings without discarding existing stage settings", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_partial", tableName: "部分配置", prefix: "partial" });
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [table],
    });
    const key = initial.subjects[0].subjectKey;
    const partial = {
      ...initial.subjects[0],
      statusField: { fieldId: "partial_status", fieldName: "旧状态字段名" },
      stages: {
        initial: {
          ...initial.subjects[0].stages.initial,
          enabled: true,
          nameSuffix: "_保留后缀",
        },
      },
    };
    delete partial.documentField;
    delete partial.namingField;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ?, metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(partial), JSON.stringify({ fields: table.fields }), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001800,
      tables: [{
        ...table,
        tableName: "部分配置（刷新）",
        fields: [...table.fields, { fieldId: "partial_notes", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });
    const repaired = refreshed.subjects[0];

    assert.deepEqual(repaired.statusField, partial.statusField);
    assert.deepEqual(repaired.documentField, { fieldId: "partial_document", fieldName: "部分配置素材文档" });
    assert.deepEqual(repaired.namingField, { fieldId: "partial_naming", fieldName: "部分配置命名" });
    assert.equal(Object.keys(repaired.stages).length, 3);
    assert.equal(repaired.stages.initial.nameSuffix, "_保留后缀");
    assert.equal(repaired.stages.first_review.trigger.fieldName, "旧状态字段名");
    assert.equal(repaired.stages.final_review.trigger.fieldName, "旧状态字段名");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing a structurally complete but incomplete stage repairs its nested defaults", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_nested_partial", tableName: "嵌套配置", prefix: "nested" });
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [table],
    });
    const key = initial.subjects[0].subjectKey;
    const partial = {
      ...initial.subjects[0],
      stages: {
        ...initial.subjects[0].stages,
        first_review: {
          enabled: false,
        },
      },
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ?, metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(partial), JSON.stringify({ fields: table.fields }), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001850,
      tables: [{
        ...table,
        tableName: "嵌套配置（刷新）",
        fields: [...table.fields, { fieldId: "nested_notes", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });
    const repaired = refreshed.subjects[0];

    assert.equal(repaired.tableName, "嵌套配置（刷新）");
    assert.deepEqual(repaired.stages.first_review, {
      ...initial.subjects[0].stages.first_review,
      enabled: false,
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing a malformed phased descriptor falls back to metadata defaults", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_malformed_descriptor", tableName: "描述符配置", prefix: "descriptor" });
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [table],
    });
    const key = initial.subjects[0].subjectKey;
    const malformed = {
      ...initial.subjects[0],
      statusField: {},
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ?, metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(malformed), JSON.stringify({ fields: table.fields }), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001860,
      tables: [{ ...table, tableName: "描述符配置（刷新）" }],
    });
    const repaired = refreshed.subjects[0];

    assert.deepEqual(repaired.statusField, {
      fieldId: "descriptor_status",
      fieldName: "描述符配置流程状态",
    });
    assert.equal(repaired.tableName, "描述符配置（刷新）");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [descriptorKey, malformedName] of [
  ["statusField", ""],
  ["documentField", null],
  ["namingField", "   "],
]) {
  test(`refreshing ${descriptorKey} with a valid id but missing name rebuilds it from table metadata`, async () => {
    const { directory, database, store } = await fixture();
    try {
      const table = defaultTable({
        tableId: `tbl_missing_${descriptorKey}`,
        tableName: "字段名修复",
        prefix: `missing-${descriptorKey}`,
      });
      const initial = await store.upsertBasePreview({
        ...preview(),
        tables: [table],
      });
      const key = initial.subjects[0].subjectKey;
      const malformed = {
        ...initial.subjects[0],
        [descriptorKey]: {
          ...initial.subjects[0][descriptorKey],
          fieldName: malformedName,
        },
      };
      database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
        .run(JSON.stringify(malformed), key);

      const refreshed = await store.upsertBasePreview({
        ...preview(),
        metadataRefreshedAt: 1710000001862,
        tables: [table],
      });
      const repaired = refreshed.subjects[0];
      const expectedFieldId = initial.subjects[0][descriptorKey].fieldId;
      const metadataField = table.fields.find((field) => (
        field.fieldId === expectedFieldId
      ));

      assert.deepEqual(repaired[descriptorKey], {
        fieldId: expectedFieldId,
        fieldName: metadataField.fieldName,
      });
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("refreshing a malformed status descriptor derives it from consistent stage triggers", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_mismatched_trigger", tableName: "状态触发配置", prefix: "mismatch" });
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [table],
    });
    const key = initial.subjects[0].subjectKey;
    const malformed = {
      ...initial.subjects[0],
      statusField: { fieldId: "", fieldName: "" },
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ?, metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(malformed), JSON.stringify({ fields: table.fields }), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001867,
      tables: [{ ...table, tableName: "状态触发配置（刷新）" }],
    });
    const repaired = refreshed.subjects[0];

    for (const stage of Object.values(repaired.stages)) {
      assert.equal(stage.trigger.fieldId, "mismatch_status");
      assert.equal(stage.trigger.fieldName, "状态触发配置流程状态");
    }
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing a superficially complete but invalid phased descriptor repairs its values", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_invalid_descriptor", tableName: "非法描述符", prefix: "invalid" });
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [table],
    });
    const key = initial.subjects[0].subjectKey;
    const malformed = {
      ...initial.subjects[0],
      statusField: { fieldId: null, fieldName: null },
      stages: {
        ...initial.subjects[0].stages,
        initial: {
          ...initial.subjects[0].stages.initial,
          nameSuffix: "",
        },
      },
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ?, metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(malformed), JSON.stringify({ fields: table.fields }), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001865,
      tables: [{ ...table, tableName: "非法描述符（刷新）" }],
    });
    const repaired = refreshed.subjects[0];

    assert.deepEqual(repaired.statusField, {
      fieldId: "invalid_status",
      fieldName: "非法描述符流程状态",
    });
    assert.equal(repaired.stages.initial.nameSuffix, "_初稿");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing a stage missing nested source settings preserves its valid custom fields", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_malformed_stage", tableName: "阶段配置", prefix: "stage" });
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [table],
    });
    const key = initial.subjects[0].subjectKey;
    const malformedStage = { ...initial.subjects[0].stages.first_review };
    delete malformedStage.videoSource;
    const malformed = {
      ...initial.subjects[0],
      stages: {
        ...initial.subjects[0].stages,
        first_review: { ...malformedStage, nameSuffix: "_保留阶段后缀" },
      },
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ?, metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(malformed), JSON.stringify({ fields: table.fields }), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001870,
      tables: [{ ...table, tableName: "阶段配置（刷新）" }],
    });
    const repaired = refreshed.subjects[0];

    assert.deepEqual(repaired.stages.first_review.videoSource, {
      kind: "docx_section",
      anchorText: "录屏",
    });
    assert.equal(repaired.stages.first_review.nameSuffix, "_保留阶段后缀");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("tables without a usable status field keep the legacy lifecycle removable and restorable", async () => {
  const { directory, database, store } = await fixture();
  try {
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [{ tableId: "tbl_empty", tableName: "待配置学科", fields: [] }],
    });
    const subject = initial.subjects[0];

    await store.removeSubject(subject.subjectKey);
    assert.deepEqual((await store.listCatalog())[0].subjects, []);

    const restored = await store.upsertBasePreview({
      ...preview(),
      tables: [{ tableId: "tbl_empty", tableName: "待配置学科", fields: [] }],
    });
    assert.equal(restored.subjects[0].subjectKey, subject.subjectKey);
    assert.equal(restored.subjects[0].lifecycle, "disabled");
    assert.equal(database.getProject(subject.projectId).archivedAt, null);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pending phased defaults bind to table metadata when a later refresh provides usable fields", async () => {
  const { directory, database, store } = await fixture();
  try {
    const empty = await store.upsertBasePreview({
      ...preview(),
      tables: [{ tableId: "tbl_pending", tableName: "稍后配置", fields: [] }],
    });
    const pending = empty.subjects[0];
    assert.equal(pending.statusField.fieldId, "pending_status_field");
    assert.equal(pending.stages.initial.trigger.optionId, "pending_initial_option");

    const table = defaultTable({ tableId: "tbl_pending", tableName: "稍后配置", prefix: "later" });
    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001900,
      tables: [table],
    });
    const repaired = refreshed.subjects[0];

    assert.deepEqual(repaired.statusField, { fieldId: "later_status", fieldName: "稍后配置流程状态" });
    assert.deepEqual(repaired.documentField, { fieldId: "later_document", fieldName: "稍后配置素材文档" });
    assert.deepEqual(repaired.namingField, { fieldId: "later_naming", fieldName: "稍后配置命名" });
    assert.deepEqual(repaired.stages.initial.trigger, {
      fieldId: "later_status",
      fieldName: "稍后配置流程状态",
      optionId: "later_draft",
      value: "later初稿",
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing a legacy subject replaces a malformed trigger with the derived initial stage trigger", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_malformed_legacy", tableName: "旧配置修复", prefix: "legacy-repair" });
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [table],
    });
    const key = initial.subjects[0].subjectKey;
    const legacy = {
      ...initial.subjects[0],
      trigger: {
        fieldId: "legacy-repair_status",
        fieldName: "",
        startValue: "   ",
        optionId: "legacy-repair_draft",
      },
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001950,
      tables: [table],
    });
    const repaired = refreshed.subjects[0];

    assert.deepEqual(repaired.trigger, {
      fieldId: "legacy-repair_status",
      fieldName: "旧配置修复流程状态",
      startValue: "legacy-repair初稿",
      optionId: "legacy-repair_draft",
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing an old pending trigger derives it from the first enabled stage", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_old_pending", tableName: "旧占位配置", prefix: "old-pending" });
    const initial = await store.upsertBasePreview({
      ...preview(),
      tables: [table],
    });
    const key = initial.subjects[0].subjectKey;
    const pending = {
      ...initial.subjects[0],
      trigger: {
        fieldId: "pending",
        fieldName: "待配置",
        startValue: "待配置",
        optionId: null,
      },
      stages: {
        ...initial.subjects[0].stages,
        initial: { ...initial.subjects[0].stages.initial, enabled: false },
        first_review: { ...initial.subjects[0].stages.first_review, enabled: true },
      },
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(pending), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000001975,
      tables: [{
        ...table,
        fields: [...table.fields, { fieldId: "old-pending_note", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });
    const repaired = refreshed.subjects[0];

    assert.equal(repaired.stages.initial.enabled, false);
    assert.equal(repaired.stages.first_review.enabled, true);
    assert.deepEqual(repaired.trigger, {
      fieldId: "old-pending_status",
      fieldName: "旧占位配置流程状态",
      startValue: "old-pending初审修改",
      optionId: "old-pending_first_review",
    });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("importing a legacy shared subject creates a complete phased draft on a new machine", async () => {
  const source = await fixture();
  const target = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_shared_legacy", tableName: "共享旧配置", prefix: "shared-legacy" });
    await source.store.upsertBasePreview({
      ...preview(),
      baseToken: "bas_shared_legacy",
      tables: [table],
    });
    const configuration = await source.store.exportShareable();
    const legacy = configuration.bases[0].subjects[0];
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;

    const dryRun = await target.store.importShareable(configuration, { dryRun: true });
    const previewSubject = dryRun.configuration.bases[0].subjects[0];
    assert.deepEqual(Object.keys(previewSubject.stages), ["initial", "first_review", "final_review"]);
    assert.deepEqual(previewSubject.statusField, {
      fieldId: "shared-legacy_status",
      fieldName: "共享旧配置流程状态",
    });

    const committed = await target.store.importShareable(configuration);
    const imported = committed.catalog[0].subjects[0];
    assert.equal(imported.lifecycle, "draft");
    assert.deepEqual(Object.keys(imported.stages), ["initial", "first_review", "final_review"]);
    assert.deepEqual(imported.documentField, {
      fieldId: "shared-legacy_document",
      fieldName: "共享旧配置素材文档",
    });
    assert.deepEqual(imported.namingField, {
      fieldId: "shared-legacy_naming",
      fieldName: "共享旧配置命名",
    });
  } finally {
    source.database.close();
    target.database.close();
    await rm(source.directory, { recursive: true, force: true });
    await rm(target.directory, { recursive: true, force: true });
  }
});

test("importing a legacy shared subject with null phased keys creates a complete phased draft", async () => {
  const source = await fixture();
  const target = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_shared_null_legacy", tableName: "共享空旧配置", prefix: "shared-null" });
    await source.store.upsertBasePreview({
      ...preview(),
      baseToken: "bas_shared_null_legacy",
      tables: [table],
    });
    const configuration = await source.store.exportShareable();
    const legacy = configuration.bases[0].subjects[0];
    legacy.statusField = null;
    legacy.documentField = null;
    legacy.namingField = null;
    legacy.stages = null;

    const dryRun = await target.store.importShareable(configuration, { dryRun: true });
    const previewSubject = dryRun.configuration.bases[0].subjects[0];
    assert.deepEqual(Object.keys(previewSubject.stages), ["initial", "first_review", "final_review"]);
    assert.deepEqual(previewSubject.statusField, {
      fieldId: "shared-null_status",
      fieldName: "共享空旧配置流程状态",
    });

    const committed = await target.store.importShareable(configuration);
    const imported = committed.catalog[0].subjects[0];
    assert.equal(imported.lifecycle, "draft");
    assert.deepEqual(Object.keys(imported.stages), ["initial", "first_review", "final_review"]);
    assert.deepEqual(imported.documentField, {
      fieldId: "shared-null_document",
      fieldName: "共享空旧配置素材文档",
    });
    assert.deepEqual(imported.namingField, {
      fieldId: "shared-null_naming",
      fieldName: "共享空旧配置命名",
    });
  } finally {
    source.database.close();
    target.database.close();
    await rm(source.directory, { recursive: true, force: true });
    await rm(target.directory, { recursive: true, force: true });
  }
});

test("explicit phased share rejects an unknown stage instead of silently repairing it", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_strict_share", tableName: "严格共享", prefix: "strict-share" });
    await store.upsertBasePreview({ ...preview(), tables: [table] });
    const configuration = await store.exportShareable();
    configuration.bases[0].subjects[0].stages.unexpected = { enabled: false };

    await assert.rejects(
      () => store.importShareable(configuration, { dryRun: true }),
      (error) => error.code === "INVALID_SHARE_CONFIGURATION" && error.status === 400,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy share import preserves a trigger on the second single-select field and a non-first option", async () => {
  const source = await fixture();
  const target = await fixture();
  try {
    const table = {
      tableId: "tbl_legacy_trigger",
      tableName: "旧触发器",
      fields: [
        {
          fieldId: "fld_decoy_status",
          fieldName: "无关状态",
          type: 3,
          uiType: "SingleSelect",
          options: [{ id: "opt_decoy", name: "无关选项" }],
        },
        {
          fieldId: "fld_real_status",
          fieldName: "制作进度",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_other", name: "其他" },
            { id: "opt_ready", name: "待剪辑" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_naming", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    await source.store.upsertBasePreview({
      ...preview(),
      baseToken: "bas_legacy_trigger",
      tables: [table],
    });
    const configuration = await source.store.exportShareable();
    const legacy = configuration.bases[0].subjects[0];
    legacy.trigger = {
      fieldId: "fld_real_status",
      fieldName: "制作进度",
      startValue: "待剪辑",
      optionId: "opt_ready",
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;

    const imported = await target.store.importShareable(configuration, { dryRun: true });
    const subject = imported.configuration.bases[0].subjects[0];
    assert.deepEqual(subject.statusField, {
      fieldId: "fld_real_status",
      fieldName: "制作进度",
    });
    assert.deepEqual(subject.stages.initial.trigger, {
      fieldId: "fld_real_status",
      fieldName: "制作进度",
      optionId: "opt_ready",
      value: "待剪辑",
    });
  } finally {
    source.database.close();
    target.database.close();
    await rm(source.directory, { recursive: true, force: true });
    await rm(target.directory, { recursive: true, force: true });
  }
});

test("repairing a partial phased subject derives stage options from its persisted status field", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = {
      tableId: "tbl_partial_status",
      tableName: "部分阶段配置",
      fields: [
        {
          fieldId: "fld_decoy_status",
          fieldName: "无关状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_decoy_a", name: "无关 A" },
            { id: "opt_decoy_b", name: "无关 B" },
            { id: "opt_decoy_c", name: "无关 C" },
          ],
        },
        {
          fieldId: "fld_real_status",
          fieldName: "流程状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_real_initial", name: "初稿" },
            { id: "opt_real_review", name: "初审修改" },
            { id: "opt_real_final", name: "终审修改" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_naming", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = initial.subjects[0];
    const partial = {
      ...subject,
      statusField: { fieldId: "fld_real_status", fieldName: "流程状态" },
      documentField: { fieldId: "fld_document", fieldName: "素材文档" },
      namingField: { fieldId: "fld_naming", fieldName: "命名" },
      trigger: {
        fieldId: "fld_real_status",
        fieldName: "流程状态",
        startValue: "初稿",
        optionId: "opt_real_initial",
      },
    };
    delete partial.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(partial), subject.subjectKey);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000003200,
      tables: [table],
    });
    const repaired = refreshed.subjects[0];
    assert.deepEqual(repaired.statusField, { fieldId: "fld_real_status", fieldName: "流程状态" });
    assert.deepEqual(
      ["initial", "first_review", "final_review"].map((stageId) => repaired.stages[stageId].trigger.optionId),
      ["opt_real_initial", "opt_real_review", "opt_real_final"],
    );
    assert.ok(Object.values(repaired.stages).every((stage) => stage.trigger.fieldId === "fld_real_status"));
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repairing missing stages preserves a non-first top-level trigger as the initial phase", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = {
      tableId: "tbl_partial_nonfirst_option",
      tableName: "部分非首选项",
      fields: [
        {
          fieldId: "fld_status",
          fieldName: "流程状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_other", name: "其他" },
            { id: "opt_ready", name: "待剪辑" },
            { id: "opt_final", name: "终审修改" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = initial.subjects[0];
    const partial = {
      ...subject,
      trigger: {
        fieldId: "fld_status",
        fieldName: "流程状态",
        startValue: "待剪辑",
        optionId: "opt_ready",
      },
    };
    delete partial.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(partial), subject.subjectKey);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000003250,
      tables: [table],
    });
    const repaired = refreshed.subjects[0];
    assert.deepEqual(repaired.stages.initial.trigger, {
      fieldId: "fld_status",
      fieldName: "流程状态",
      optionId: "opt_ready",
      value: "待剪辑",
    });

    const enabled = await store.enableSubject(repaired.subjectKey, repaired.configVersion);
    assert.equal(enabled.trigger.optionId, "opt_ready");
    assert.equal(enabled.trigger.startValue, "待剪辑");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repairing a partial phased subject derives a missing status field from its existing triggers", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = {
      tableId: "tbl_partial_trigger_status",
      tableName: "缺少状态绑定",
      fields: [
        {
          fieldId: "fld_decoy_status",
          fieldName: "无关状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_decoy_initial", name: "无关初稿" },
            { id: "opt_decoy_review", name: "无关初审" },
            { id: "opt_decoy_final", name: "无关终审" },
          ],
        },
        {
          fieldId: "fld_real_status",
          fieldName: "流程状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_real_initial", name: "初稿" },
            { id: "opt_real_review", name: "初审修改" },
            { id: "opt_real_final", name: "终审修改" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_naming", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = initial.subjects[0];
    const optionByStage = {
      initial: ["opt_real_initial", "初稿"],
      first_review: ["opt_real_review", "初审修改"],
      final_review: ["opt_real_final", "终审修改"],
    };
    const partial = {
      ...subject,
      trigger: {
        fieldId: "fld_real_status",
        fieldName: "流程状态",
        startValue: "初稿",
        optionId: "opt_real_initial",
      },
      documentField: { fieldId: "fld_document", fieldName: "素材文档" },
      namingField: { fieldId: "fld_naming", fieldName: "命名" },
      stages: Object.fromEntries(STAGE_IDS.map((stageId) => [stageId, {
        ...subject.stages[stageId],
        trigger: {
          fieldId: "fld_real_status",
          fieldName: "流程状态",
          optionId: optionByStage[stageId][0],
          value: optionByStage[stageId][1],
        },
      }])),
    };
    delete partial.statusField;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(partial), subject.subjectKey);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000003300,
      tables: [table],
    });
    const repaired = refreshed.subjects[0];

    assert.deepEqual(repaired.statusField, { fieldId: "fld_real_status", fieldName: "流程状态" });
    assert.ok(Object.values(repaired.stages).every((stage) => stage.trigger.fieldId === "fld_real_status"));
    assert.deepEqual(
      STAGE_IDS.map((stageId) => repaired.stages[stageId].trigger.optionId),
      ["opt_real_initial", "opt_real_review", "opt_real_final"],
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repairing a missing status field stays pending when persisted trigger fields disagree", async () => {
  let syncCalls = 0;
  const { directory, database, store } = await fixture({
    syncSubject: async () => { syncCalls += 1; },
  });
  try {
    const table = {
      tableId: "tbl_conflicting_trigger_fields",
      tableName: "冲突触发字段",
      fields: [
        {
          fieldId: "fld_live_status",
          fieldName: "当前流程状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_live", name: "初稿" },
            { id: "opt_live_review", name: "初审修改" },
            { id: "opt_live_final", name: "终审修改" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_naming", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = initial.subjects[0];
    const partial = {
      ...subject,
      trigger: {
        fieldId: "fld_live_status",
        fieldName: "当前流程状态",
        startValue: "初稿",
        optionId: "opt_live",
      },
      stages: {
        ...subject.stages,
        initial: {
          ...subject.stages.initial,
          trigger: {
            fieldId: "fld_removed_status",
            fieldName: "已删除流程状态",
            optionId: "opt_removed",
            value: "旧初稿",
          },
        },
      },
    };
    delete partial.statusField;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(partial), subject.subjectKey);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000003350,
      tables: [table],
    });
    const repaired = refreshed.subjects[0];

    assert.equal(repaired.statusField.fieldId, "pending_status_field");
    assert.equal(repaired.stages.initial.trigger.fieldId, "pending_status_field");
    assert.equal(repaired.stages.initial.trigger.optionId, "pending_initial_option");
    await assert.rejects(
      () => store.enableSubject(repaired.subjectKey, repaired.configVersion),
      (error) => ["FIELD_NOT_FOUND", "TRIGGER_FIELD_NOT_FOUND"].includes(error.code),
    );
    assert.equal(syncCalls, 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repairing an initial stage without a usable trigger preserves the top-level trigger", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = {
      tableId: "tbl_partial_initial_trigger",
      tableName: "缺少初稿触发器",
      fields: [
        {
          fieldId: "fld_status",
          fieldName: "流程状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_other", name: "其他" },
            { id: "opt_ready", name: "待剪辑" },
            { id: "opt_final", name: "终审修改" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_naming", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = initial.subjects[0];
    const partial = {
      ...subject,
      trigger: {
        fieldId: "fld_status",
        fieldName: "流程状态",
        startValue: "待剪辑",
        optionId: "opt_ready",
      },
      stages: {
        ...subject.stages,
        initial: { enabled: true },
      },
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(partial), subject.subjectKey);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000003400,
      tables: [table],
    });
    const repaired = refreshed.subjects[0];

    assert.deepEqual(repaired.stages.initial.trigger, {
      fieldId: "fld_status",
      fieldName: "流程状态",
      optionId: "opt_ready",
      value: "待剪辑",
    });
    const enabled = await store.enableSubject(repaired.subjectKey, repaired.configVersion);
    assert.equal(enabled.trigger.optionId, "opt_ready");
    assert.equal(enabled.trigger.startValue, "待剪辑");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repairing a stale initial trigger does not reroute a valid top-level trigger", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = {
      tableId: "tbl_stale_initial_trigger",
      tableName: "初稿触发器过期",
      fields: [
        {
          fieldId: "fld_live_status",
          fieldName: "流程状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_first", name: "初稿" },
            { id: "opt_second", name: "待剪辑" },
            { id: "opt_final", name: "终审修改" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_naming", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = initial.subjects[0];
    const stale = {
      ...subject,
      trigger: {
        fieldId: "fld_live_status",
        fieldName: "流程状态",
        startValue: "待剪辑",
        optionId: "opt_second",
      },
      stages: {
        ...subject.stages,
        initial: {
          ...subject.stages.initial,
          trigger: {
            fieldId: "fld_removed_status",
            fieldName: "已删除流程状态",
            optionId: "opt_removed",
            value: "旧初稿",
          },
        },
      },
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(stale), subject.subjectKey);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000003450,
      tables: [table],
    });
    const repaired = refreshed.subjects[0];

    assert.deepEqual(repaired.stages.initial.trigger, {
      fieldId: "fld_live_status",
      fieldName: "流程状态",
      optionId: "opt_second",
      value: "待剪辑",
    });
    const enabled = await store.enableSubject(repaired.subjectKey, repaired.configVersion);
    assert.equal(enabled.trigger.optionId, "opt_second");
    assert.equal(enabled.trigger.startValue, "待剪辑");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("repairing stale top-level and initial triggers stays blocked instead of choosing the first option", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = {
      tableId: "tbl_stale_all_triggers",
      tableName: "全部触发器过期",
      fields: [
        {
          fieldId: "fld_live_status",
          fieldName: "流程状态",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "opt_first", name: "初稿" },
            { id: "opt_second", name: "待剪辑" },
            { id: "opt_final", name: "终审修改" },
          ],
        },
        { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "fld_naming", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = initial.subjects[0];
    const stale = {
      ...subject,
      trigger: {
        fieldId: "fld_removed_status",
        fieldName: "已删除流程状态",
        startValue: "旧初稿",
        optionId: "opt_removed",
      },
      stages: {
        ...subject.stages,
        initial: {
          ...subject.stages.initial,
          trigger: {
            fieldId: "fld_removed_status",
            fieldName: "已删除流程状态",
            optionId: "opt_removed",
            value: "旧初稿",
          },
        },
      },
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(stale), subject.subjectKey);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000003460,
      tables: [table],
    });
    const repaired = refreshed.subjects[0];

    assert.equal(repaired.stages.initial.trigger.optionId, "pending_initial_option");
    assert.notEqual(repaired.stages.initial.trigger.optionId, "opt_first");
    await assert.rejects(
      () => store.enableSubject(repaired.subjectKey, repaired.configVersion),
      (error) => error.code === "TRIGGER_OPTION_NOT_FOUND" && error.status === 409,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabling a phased draft with pending bindings fails before Bridge synchronization", async () => {
  let syncCalls = 0;
  const { directory, database, store } = await fixture({
    syncSubject: async () => { syncCalls += 1; },
  });
  try {
    const table = defaultTable({ tableId: "tbl_pending_enable", tableName: "待修复", prefix: "pending-enable" });
    const catalog = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = catalog.subjects[0];
    const pending = {
      ...subject,
      documentField: { fieldId: "pending_document_field", fieldName: "待配置" },
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(pending), subject.subjectKey);

    await assert.rejects(
      () => store.enableSubject(subject.subjectKey, subject.configVersion),
      (error) => {
        assert.equal(error.code, "FIELD_NOT_FOUND");
        return true;
      },
    );
    const unchanged = await store.getSubject(subject.subjectKey);
    assert.equal(unchanged.lifecycle, "draft");
    assert.equal(unchanged.configVersion, subject.configVersion);
    assert.equal(syncCalls, 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy share import projects the retained local upload target onto enabled stages", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_legacy_upload", tableName: "旧上传配置", prefix: "legacy-upload" });
    const catalog = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = catalog.subjects[0];
    const targetPath = "D:\\local\\legacy-upload";
    const legacy = {
      ...subject,
      upload: {
        ...subject.upload,
        enqueueMode: "automatic",
        targetId: "local-target",
        targetPath,
      },
    };
    delete legacy.statusField;
    delete legacy.documentField;
    delete legacy.namingField;
    delete legacy.stages;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), subject.subjectKey);

    const shared = await store.exportShareable();
    assert.equal(shared.bases[0].subjects[0].upload.targetPath, null);
    const committed = await store.importShareable(shared);
    const imported = committed.catalog[0].subjects[0];
    assert.equal(imported.upload.targetPath, targetPath);
    assert.equal(imported.stages.initial.artifactTargetPath, targetPath);
    const enabled = await store.enableSubject(imported.subjectKey, imported.configVersion);
    assert.equal(enabled.lifecycle, "enabled");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("share export strips legacy snake-case stage destination paths", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_snake_export", tableName: "旧路径键", prefix: "snake-export" });
    const catalog = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = catalog.subjects[0];
    const legacy = structuredClone(subject);
    delete legacy.stages.initial.artifactTargetPath;
    legacy.stages.initial.artifact_target_path = "D:\\private\\snake-export";
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), subject.subjectKey);

    const exported = await store.exportShareable();
    const serialized = JSON.stringify(exported);
    assert.doesNotMatch(serialized, /artifact_target_path/u);
    assert.doesNotMatch(serialized, /D:\\\\private/u);
    assert.equal(exported.bases[0].subjects[0].stages.initial.artifactTargetPath, null);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("share import preserves a legacy snake-case stage destination only on its local subject", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_snake_local", tableName: "本机旧路径", prefix: "snake-local" });
    const catalog = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const subject = catalog.subjects[0];
    const targetPath = "D:\\private\\local-stage";
    const legacy = structuredClone(subject);
    delete legacy.stages.initial.artifactTargetPath;
    legacy.stages.initial.artifact_target_path = targetPath;
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), subject.subjectKey);

    const shared = await store.exportShareable();
    assert.doesNotMatch(JSON.stringify(shared), /local-stage/u);
    const imported = await store.importShareable(shared);
    assert.equal(imported.catalog[0].subjects[0].stages.initial.artifactTargetPath, targetPath);
    assert.equal(imported.catalog[0].subjects[0].stages.initial.artifact_target_path, undefined);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("phased automatic upload enables using stage destinations without a common target", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(phasedPreview());
    const patch = phasedPatch();
    patch.upload.enqueueMode = "automatic";
    patch.stages.first_review.artifactTargetPath = null;
    patch.stages.final_review.artifactTargetPath = null;
    const draft = await store.saveSubjectDraft("bas_demo:tbl_math", patch);
    const enabled = await store.enableSubject(draft.subjectKey, draft.configVersion);
    assert.equal(enabled.lifecycle, "enabled");
    assert.equal(enabled.upload.targetPath, null);
    assert.equal(enabled.upload.targetId, null);
    assert.equal(enabled.stages.initial.artifactTargetPath, patch.stages.initial.artifactTargetPath);
    assert.equal(enabled.stages.first_review.artifactTargetPath, null);
    assert.equal(enabled.stages.final_review.artifactTargetPath, null);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("phased automatic upload rejects a missing enabled stage destination without changing the draft", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(phasedPreview());
    const patch = phasedPatch();
    patch.upload.enqueueMode = "automatic";
    patch.stages.initial.artifactTargetPath = null;
    const draft = await store.saveSubjectDraft("bas_demo:tbl_math", patch);
    await assert.rejects(
      () => store.enableSubject(draft.subjectKey, draft.configVersion),
      (error) => error.code === "INVALID_FIELD" && /stage 'initial'.*artifactTargetPath/u.test(error.message),
    );
    const current = await store.getSubject(draft.subjectKey);
    assert.equal(current.lifecycle, "draft");
    assert.equal(current.configVersion, draft.configVersion);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy automatic upload still requires and uses its common destination", async () => {
  const { directory, database, store } = await fixture();
  try {
    const catalog = await store.upsertBasePreview(preview());
    const legacy = { ...catalog.subjects[0], ...subjectPatch() };
    for (const field of ["statusField", "documentField", "namingField", "stages"]) delete legacy[field];
    legacy.upload.enqueueMode = "automatic";
    const persist = () => database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), legacy.subjectKey);
    persist();
    await assert.rejects(
      () => store.enableSubject(legacy.subjectKey, legacy.configVersion),
      (error) => error.code === "UPLOAD_TARGET_NOT_CONFIGURED",
    );
    legacy.upload.targetPath = "C:\\approved\\legacy";
    persist();
    const enabled = await store.enableSubject(legacy.subjectKey, legacy.configVersion);
    assert.equal(enabled.upload.targetPath, legacy.upload.targetPath);
    assert.equal(enabled.stages, undefined);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    await store.upsertBasePreview(phasedPreview());
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

test("draft mutations keep the previous enabled version routable until an explicit lifecycle transition", async () => {
  const { directory, database, store } = await fixture();
  try {
    const original = phasedPreview();
    await store.upsertBasePreview(original);
    const saved = await store.saveSubjectDraft("bas_demo:tbl_math", phasedPatch());
    const enabled = await store.enableSubject(saved.subjectKey, saved.configVersion);

    const assertEnabledVersionOpen = () => {
      const versionRow = database.database.prepare(
        "SELECT enabled_at, closed_at FROM feishu_subject_versions WHERE subject_key = ? AND version = ?",
      ).get(enabled.subjectKey, enabled.configVersion);
      assert.equal(versionRow.closed_at, null);
      const routed = database.resolveFeishuSubjectVersionAt(enabled.subjectKey, versionRow.enabled_at);
      assert.equal(routed?.configVersion, enabled.configVersion);
    };

    await store.upsertBasePreview({
      ...original,
      metadataRefreshedAt: 1710000006500,
      baseName: "刷新 Base",
    });
    assertEnabledVersionOpen();

    const refreshedAgain = await store.upsertBasePreview({
      ...original,
      metadataRefreshedAt: 1710000006600,
      baseName: "刷新 Base",
      tables: [{
        ...original.tables[0],
        tableName: "刷新数学",
        fields: [
          ...original.tables[0].fields,
          { fieldId: "fld_notes", fieldName: "备注", type: 1, uiType: "Text", options: [] },
        ],
      }],
    });
    assert.equal(refreshedAgain.subjects[0].lifecycle, "draft");
    assertEnabledVersionOpen();

    const repaired = await store.saveSubjectDraft(enabled.subjectKey, {
      expectedVersion: refreshedAgain.subjects[0].configVersion,
      execution: { ...refreshedAgain.subjects[0].execution, concurrencyGroup: "repaired" },
    });
    assertEnabledVersionOpen();

    const shared = await store.exportShareable();
    await store.importShareable(shared);
    assertEnabledVersionOpen();

    const imported = await store.getSubject(enabled.subjectKey);
    const reenabled = await store.enableSubject(imported.subjectKey, imported.configVersion);
    const closedOriginal = database.database.prepare(
      "SELECT closed_at FROM feishu_subject_versions WHERE subject_key = ? AND version = ?",
    ).get(enabled.subjectKey, enabled.configVersion);
    assert.equal(Number.isSafeInteger(closedOriginal.closed_at), true);

    const editedAgain = await store.saveSubjectDraft(reenabled.subjectKey, {
      expectedVersion: reenabled.configVersion,
      execution: { ...reenabled.execution, concurrencyGroup: "edited-again" },
    });
    const reenabledRow = database.database.prepare(
      "SELECT enabled_at, closed_at FROM feishu_subject_versions WHERE subject_key = ? AND version = ?",
    ).get(reenabled.subjectKey, reenabled.configVersion);
    assert.equal(reenabledRow.closed_at, null);
    assert.equal(
      database.resolveFeishuSubjectVersionAt(reenabled.subjectKey, reenabledRow.enabled_at)?.configVersion,
      reenabled.configVersion,
    );

    await store.disableSubject(editedAgain.subjectKey, editedAgain.configVersion);
    const closedReenabled = database.database.prepare(
      "SELECT closed_at FROM feishu_subject_versions WHERE subject_key = ? AND version = ?",
    ).get(reenabled.subjectKey, reenabled.configVersion);
    assert.equal(Number.isSafeInteger(closedReenabled.closed_at), true);
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
    await store.upsertBasePreview(phasedPreview());
    const key = "bas_demo:tbl_math";
    const draft = await store.saveSubjectDraft(key, subjectPatch());
    assert.equal(draft.lifecycle, "draft");
    assert.equal(draft.configVersion, 2);
    // A legacy-shaped patch must not make a newly imported table lose its
    // complete phased editor configuration; those phase keys remain
    // persisted with bindings derived from this table only.
    assert.deepEqual(draft.statusField, { fieldId: "fld_status", fieldName: "待制作" });
    assert.deepEqual(Object.keys(draft.stages), ["initial", "first_review", "final_review"]);
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

test("legacy upload patches bind a missing initial stage destination without removing phased config", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(phasedPreview());
    const key = "bas_demo:tbl_math";
    const configured = await store.saveSubjectDraft(key, subjectPatch());
    const enabled = await store.enableSubject(key, configured.configVersion);
    const targetPath = "D:\\legacy-upload-target";

    const draft = await store.saveSubjectDraft(key, {
      expectedVersion: enabled.configVersion,
      upload: {
        ...enabled.upload,
        enqueueMode: "automatic",
        targetId: "legacy-target",
        targetPath,
      },
    });

    assert.deepEqual(Object.keys(draft.stages), ["initial", "first_review", "final_review"]);
    assert.equal(draft.stages.initial.artifactTargetPath, targetPath);
    const reenabled = await store.enableSubject(key, draft.configVersion);
    assert.equal(reenabled.lifecycle, "enabled");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy manual upload patches bind the subject target to the enabled phase", async () => {
  const { directory, database, store } = await fixture();
  try {
    await store.upsertBasePreview(phasedPreview());
    const key = "bas_demo:tbl_math";
    const configured = await store.saveSubjectDraft(key, subjectPatch());
    const targetPath = "D:\\legacy-manual-target";

    const draft = await store.saveSubjectDraft(key, {
      expectedVersion: configured.configVersion,
      upload: {
        ...configured.upload,
        enqueueMode: "manual",
        targetId: "legacy-manual-target",
        targetPath,
      },
    });

    assert.equal(draft.upload.enqueueMode, "manual");
    assert.equal(draft.stages.initial.artifactTargetPath, targetPath);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy upload patches retain their projected destination through pending refresh", async () => {
  const { directory, database, store } = await fixture();
  try {
    const empty = await store.upsertBasePreview({
      ...preview(),
      tables: [{ tableId: "tbl_pending_upload", tableName: "待配置上传", fields: [] }],
    });
    const key = empty.subjects[0].subjectKey;
    const targetPath = "D:\\pending-upload-target";
    const draft = await store.saveSubjectDraft(key, {
      upload: {
        ...empty.subjects[0].upload,
        enqueueMode: "automatic",
        targetId: "pending-target",
        targetPath,
      },
    });
    assert.equal(draft.stages.initial.artifactTargetPath, targetPath);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      tables: [{
        tableId: "tbl_pending_upload",
        tableName: "待配置上传",
        fields: [
          { fieldId: "pending_status", fieldName: "流程", type: 3, uiType: "SingleSelect", options: [
            { id: "pending_initial", name: "初稿" },
            { id: "pending_review", name: "初审修改" },
            { id: "pending_final", name: "终审修改" },
          ] },
          { fieldId: "pending_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
          { fieldId: "pending_naming", fieldName: "命名", type: 1, uiType: "Text", options: [] },
        ],
      }],
    });
    assert.equal(refreshed.subjects[0].stages.initial.artifactTargetPath, targetPath);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("metadata refresh preserves real field and option ids that begin with pending", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = {
      tableId: "tbl_real_pending_ids",
      tableName: "真实 pending 标识",
      fields: [
        {
          fieldId: "pending_status",
          fieldName: "流程",
          type: 3,
          uiType: "SingleSelect",
          options: [
            { id: "pending_a", name: "初稿" },
            { id: "pending_b", name: "待剪辑" },
            { id: "pending_c", name: "终审" },
          ],
        },
        { fieldId: "pending_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
        { fieldId: "pending_naming", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      ],
    };
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const key = initial.subjects[0].subjectKey;
    const initialStage = {
      ...initial.subjects[0].stages.initial,
      trigger: {
        fieldId: "pending_status",
        fieldName: "流程",
        optionId: "pending_b",
        value: "待剪辑",
      },
      nameSuffix: "_用户配置",
    };
    const saved = await store.saveSubjectDraft(key, {
      expectedVersion: initial.subjects[0].configVersion,
      stages: {
        ...initial.subjects[0].stages,
        initial: initialStage,
      },
    });
    assert.equal(saved.stages.initial.trigger.optionId, "pending_b");

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000003100,
      tables: [{
        ...table,
        fields: [...table.fields, { fieldId: "pending_notes", fieldName: "备注", type: 1, uiType: "Text", options: [] }],
      }],
    });

    assert.deepEqual(refreshed.subjects[0].stages.initial.trigger, initialStage.trigger);
    assert.equal(refreshed.subjects[0].stages.initial.nameSuffix, "_用户配置");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing a phased subject with no enabled stages repairs the initial stage", async () => {
  const { directory, database, store } = await fixture();
  try {
    const table = defaultTable({ tableId: "tbl_no_enabled_stages", tableName: "无启用阶段", prefix: "no-stage" });
    const initial = await store.upsertBasePreview({ ...preview(), tables: [table] });
    const key = initial.subjects[0].subjectKey;
    const malformed = {
      ...initial.subjects[0],
      stages: Object.fromEntries(Object.entries(initial.subjects[0].stages).map(([stageId, stage]) => [
        stageId,
        { ...stage, enabled: false },
      ])),
    };
    database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(malformed), key);

    const refreshed = await store.upsertBasePreview({
      ...preview(),
      metadataRefreshedAt: 1710000002999,
      tables: [table],
    });
    assert.equal(refreshed.subjects[0].stages.initial.enabled, true);
    assert.equal(refreshed.subjects[0].stages.first_review.enabled, false);
    assert.equal(refreshed.subjects[0].stages.final_review.enabled, false);
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
    await store.upsertBasePreview(phasedPreview());
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
