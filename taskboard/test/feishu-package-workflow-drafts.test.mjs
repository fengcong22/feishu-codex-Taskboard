import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createFeishuWorkflowStore } from "../server/feishu-workflow-store.mjs";
import { createFeishuPackageWorkflowDrafts } from "../server/feishu-package-workflow-drafts.mjs";

const TEMPLATE = { id: "vm_pmo_review_video", version: 1 };
const SUBJECT = "bas_preview:tbl_chemistry";
const OTHER_SUBJECT = "bas_preview:tbl_physics";
const ALIAS = "vm-chemistry";
const metadata = [
  { fieldId: "fld_vmid", fieldName: "原视频vmid", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_keep", fieldName: "保留片段", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_review", fieldName: "审核意见", type: "1", uiType: null, options: [] },
  { fieldId: "fld_instruction", fieldName: "阶段专用指令", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_name", fieldName: "视频名称", type: 1, uiType: "Text", options: [] },
  { fieldId: "fld_formula", fieldName: "课程名称公式", type: 20, uiType: "Formula", options: [] },
  { fieldId: "fld_images", fieldName: "截图", type: 17, uiType: "Attachment", options: [] },
  { fieldId: "fld_output", fieldName: "审核成片", type: 17, uiType: null, options: [] },
  { fieldId: "fld_status", fieldName: "状态", type: 3, uiType: "SingleSelect", options: [
    { id: "opt_initial", name: "待首剪" }, { id: "opt_review", name: "待修改" },
  ] },
  { fieldId: "fld_progress", fieldName: "视频进度", type: 4, uiType: "MultiSelect", options: [
    { id: "opt_first_review", name: "待初审修改" }, { id: "opt_final_review", name: "待终审修改" },
  ] },
  { fieldId: "fld_writeback", fieldName: "剪辑状态", type: 3, uiType: "SingleSelect", options: [
    { id: "opt_processing", name: "剪辑中" }, { id: "opt_completed", name: "已完成" },
  ] },
];

function url(subjectKey = SUBJECT, alias = ALIAS) {
  return `/api/local/feishu/subjects/${encodeURIComponent(subjectKey)}/package-workflow-drafts/${encodeURIComponent(alias)}`;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-workflow-drafts-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const packages = new Map([
    [ALIAS, { alias: ALIAS, state: "draft", workflowTemplate: TEMPLATE }],
    ["vm-other", { alias: "vm-other", state: "disabled", workflowTemplate: TEMPLATE }],
    ["legacy", { alias: "legacy", state: "enabled" }],
  ]);
  const packageStore = { get: async (alias) => packages.get(alias) ?? null };
  let database;
  let workflowStore;
  let api;
  let syncCount = 0;
  function open() {
    database = new TaskboardDatabase(filename);
    workflowStore = createFeishuWorkflowStore({ database, syncSubject: async () => { syncCount += 1; } });
    api = createFeishuPackageWorkflowDrafts({ database, packageStore, workflowStore });
  }
  open();
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  await workflowStore.upsertBasePreview({
    baseToken: "bas_preview", baseName: "预览测试", sourceUrlLabel: null, metadataRefreshedAt: Date.now(),
    tables: [
      { tableId: "tbl_chemistry", tableName: "化学", fields: structuredClone(metadata) },
      { tableId: "tbl_physics", tableName: "物理", fields: structuredClone(metadata) },
    ],
  });
  return {
    get database() { return database; }, get workflowStore() { return workflowStore; },
    get api() { return api; }, get syncCount() { return syncCount; }, packages,
    reopen() { database.close(); open(); },
    get(subjectKey = SUBJECT, alias = ALIAS) { return api.handle({ method: "GET", pathname: url(subjectKey, alias) }); },
    put(config, expectedRevision = 0, subjectKey = SUBJECT, alias = ALIAS) {
      return api.handle({ method: "PUT", pathname: url(subjectKey, alias), body: { expectedRevision, config } });
    },
  };
}

async function populatedConfig(f) {
  const { body } = await f.get();
  return {
    ...body.config,
    fields: { vmidFieldId: "fld_vmid", outputAttachmentFieldId: "fld_output", namingFieldId: null },
    stages: {
      initial: { ...body.config.stages.initial, enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_initial", instructionFieldId: "fld_keep" },
      review: { ...body.config.stages.review, instructionFieldId: "fld_review", instructionAttachmentsFieldId: "fld_images" },
    },
  };
}

function legacyConfig() {
  return {
    fields: { vmidFieldId: "fld_vmid", keepSegmentsFieldId: "fld_keep", reviewTextFieldId: "fld_review", reviewAttachmentsFieldId: "fld_images", outputAttachmentFieldId: "fld_output" },
    approval: { department: "动画组", reason: "切片剪辑" },
    stages: {
      initial: { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_initial" },
      first_review: { enabled: false, statusFieldId: null, triggerOptionId: null },
      final_review: { enabled: false, statusFieldId: null, triggerOptionId: null },
    },
  };
}

test("VM package drafts have empty revision-zero defaults without creating rows", async (t) => {
  const f = await fixture(t);
  const result = await f.get();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.workflowTemplate, TEMPLATE);
  assert.equal(result.body.subjectKey, SUBJECT);
  assert.equal(result.body.packageAlias, ALIAS);
  assert.equal(result.body.revision, 0);
  assert.equal(result.body.updatedAt, null);
  assert.deepEqual(result.body.config.fields, { vmidFieldId: null, outputAttachmentFieldId: null, namingFieldId: null });
  assert.deepEqual(result.body.config.approval, { department: "动画组", reason: "切片剪辑" });
  assert.deepEqual(Object.keys(result.body.config.stages), ["initial", "review"]);
  assert.equal(result.body.config.stages.initial.enabled, true);
  assert.equal(result.body.config.stages.review.enabled, false);
  assert.equal(result.body.config.stages.review.instructionAttachmentsFieldId, null);
  assert.deepEqual(result.body.config.finalArchive, {
    enabled: false, statusFieldId: null, triggerOptionId: null,
    pathSource: "manual", directoryPath: null, pathFieldId: null,
  });
  assert.equal(Object.hasOwn(result.body, "legacyReviewStage"), false);
  for (const stage of Object.values(result.body.config.stages)) {
    assert.equal(stage.instructionFieldId, null);
    assert.equal(Object.hasOwn(stage, "namingFieldId"), false);
    assert.deepEqual(stage.writeback, {
      processing: { fieldId: null, optionId: null },
      completed: { fieldId: null, optionId: null },
    });
  }
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM feishu_package_workflow_drafts").get().count, 0);
  assert.equal(f.syncCount, 0);
});

test("legacy VM drafts read as two stages without rewriting their row and save canonical bindings explicitly", async (t) => {
  const f = await fixture(t);
  const config = legacyConfig();
  const saved = (await f.put(config)).body;
  assert.deepEqual(saved.config.fields, { vmidFieldId: "fld_vmid", outputAttachmentFieldId: "fld_output", namingFieldId: null });
  assert.equal(saved.config.stages.initial.instructionFieldId, "fld_keep");
  assert.equal(saved.config.stages.review.instructionFieldId, "fld_review");
  assert.equal(saved.config.stages.review.instructionAttachmentsFieldId, "fld_images");
  assert.deepEqual(Object.keys(saved.config.stages), ["initial", "review"]);
  assert.equal(Object.hasOwn(saved, "legacyReviewStage"), false);
  for (const stage of Object.values(saved.config.stages)) {
    assert.deepEqual(stage.writeback, {
      processing: { fieldId: null, optionId: null },
      completed: { fieldId: null, optionId: null },
    });
  }
  // A row written by the older schema must stay readable without migrating its revision.
  f.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
    .run(JSON.stringify(config), SUBJECT);
  const before = f.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT);
  const legacy = (await f.get()).body;
  assert.equal(legacy.revision, 1);
  assert.deepEqual(legacy.config, saved.config);
  assert.equal(legacy.legacyReviewStage, "final_review");
  await f.get();
  assert.deepEqual(f.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT), before);
  const canonical = (await f.put(legacy.config, 1)).body;
  assert.equal(canonical.revision, 2);
  assert.equal(Object.hasOwn(canonical, "legacyReviewStage"), false);
  assert.deepEqual(JSON.parse(f.database.database.prepare("SELECT config_json FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT).config_json), canonical.config);
});

test("legacy reviewer selection prefers enabled stages then first-review bindings without mixing the other stage", async (t) => {
  const f = await fixture(t);
  await f.put(legacyConfig());
  const cases = [
    { first: { enabled: true }, final: { enabled: true }, want: "first_review" },
    { first: { statusFieldId: "fld_status" }, final: { enabled: true }, want: "final_review" },
    { first: { statusFieldId: "fld_status" }, final: {}, want: "first_review" },
    { first: { instructionFieldId: "fld_instruction" }, final: {}, want: "first_review" },
    { first: { writeback: { processing: { fieldId: "fld_writeback", optionId: null }, completed: { fieldId: null, optionId: null } } }, final: {}, want: "first_review" },
    { first: { writeback: { processing: { fieldId: null, optionId: null }, completed: { fieldId: "fld_writeback", optionId: "opt_completed" } } }, final: {}, want: "first_review" },
    { first: {}, final: {}, want: "final_review" },
  ];
  for (const scenario of cases) {
    const config = legacyConfig();
    Object.assign(config.stages.first_review, scenario.first);
    Object.assign(config.stages.final_review, {
      statusFieldId: "fld_progress", triggerOptionId: "opt_final_review", instructionFieldId: "fld_keep",
      writeback: { processing: { fieldId: "fld_writeback", optionId: "opt_processing" }, completed: { fieldId: "fld_writeback", optionId: "opt_completed" } },
    }, scenario.final);
    f.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(config), SUBJECT);
    const read = (await f.get()).body;
    assert.equal(read.legacyReviewStage, scenario.want);
    if (scenario.want === "final_review") {
      assert.deepEqual(read.config.stages.review, {
        enabled: Boolean(scenario.final.enabled), statusFieldId: "fld_progress", triggerOptionId: "opt_final_review",
        instructionFieldId: "fld_keep", instructionAttachmentsFieldId: "fld_images",
        writeback: { processing: { fieldId: "fld_writeback", optionId: "opt_processing" }, completed: { fieldId: "fld_writeback", optionId: "opt_completed" } },
      });
    } else {
      assert.equal(read.config.stages.review.triggerOptionId, null);
      assert.equal(read.config.stages.review.instructionFieldId, scenario.first.instructionFieldId ?? "fld_review");
      assert.deepEqual(read.config.stages.review.writeback, scenario.first.writeback ?? {
        processing: { fieldId: null, optionId: null }, completed: { fieldId: null, optionId: null },
      });
    }
  }
});

test("legacy PUT validates only retained metadata while preserving explicit instructions and a whole review stage", async (t) => {
  const f = await fixture(t);
  const config = legacyConfig();
  config.fields.keepSegmentsFieldId = "fld_removed_keep";
  config.fields.reviewTextFieldId = "fld_removed_review";
  config.stages.initial.instructionFieldId = "fld_instruction";
  config.stages.first_review = {
    enabled: true, statusFieldId: "fld_progress", triggerOptionId: "opt_first_review", instructionFieldId: "fld_keep",
    writeback: { processing: { fieldId: "fld_writeback", optionId: "opt_processing" }, completed: { fieldId: null, optionId: null } },
  };
  config.stages.final_review = {
    enabled: true, statusFieldId: "fld_removed_status", triggerOptionId: "opt_removed", instructionFieldId: "fld_removed_instruction",
    writeback: { processing: { fieldId: "fld_removed_writeback", optionId: "opt_removed" }, completed: { fieldId: "fld_removed_writeback", optionId: "opt_removed" } },
  };
  const saved = (await f.put(config)).body;
  assert.equal(saved.config.stages.initial.instructionFieldId, "fld_instruction");
  assert.deepEqual(saved.config.stages.review, {
    enabled: true, statusFieldId: "fld_progress", triggerOptionId: "opt_first_review", instructionFieldId: "fld_keep",
    instructionAttachmentsFieldId: "fld_images",
    writeback: { processing: { fieldId: "fld_writeback", optionId: "opt_processing" }, completed: { fieldId: null, optionId: null } },
  });
  assert.equal(Object.hasOwn(saved, "legacyReviewStage"), false);
});

test("discarded legacy bindings still require a closed shape and safe identifiers before migration", async (t) => {
  const f = await fixture(t);
  const config = legacyConfig();
  config.stages.first_review.enabled = true;
  for (const [mutate, code] of [
    [(c) => { c.stages.final_review.command = "run"; }, "UNKNOWN_FIELD"],
    [(c) => { c.stages.final_review.instructionFieldId = "C:\\private\\video.mp4"; }, "INVALID_FIELD"],
    [(c) => { c.fields.reviewTextFieldId = "C:\\private\\video.mp4"; }, "INVALID_FIELD"],
    [(c) => { c.stages.final_review.triggerOptionId = "opt_review"; }, "INVALID_FIELD"],
    [(c) => { c.stages.final_review.writeback = { processing: { fieldId: null, optionId: null } }; }, "INVALID_FIELD"],
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    await assert.rejects(f.put(invalid), (error) => error.code === code);
  }
  assert.equal((await f.get()).body.revision, 0);
});

test("canonical stage-owned instructions and review attachments can be cleared without hidden inheritance", async (t) => {
  const f = await fixture(t);
  const saved = (await f.put(legacyConfig())).body;
  assert.ok(saved.config.stages.review, "legacy save must return the canonical review stage");
  saved.config.stages.initial.instructionFieldId = null;
  saved.config.stages.review.instructionFieldId = null;
  saved.config.stages.review.instructionAttachmentsFieldId = null;
  await f.put(saved.config, 1);
  f.reopen();
  const read = (await f.get()).body;
  assert.equal(read.config.stages.initial.instructionFieldId, null);
  assert.equal(read.config.stages.review.instructionFieldId, null);
  assert.equal(read.config.stages.review.instructionAttachmentsFieldId, null);
  assert.deepEqual(read.config.fields, { vmidFieldId: "fld_vmid", outputAttachmentFieldId: "fld_output", namingFieldId: null });
});

test("canonical VM drafts require both stage instruction keys and reject mixed legacy shapes", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  await f.put(config);
  for (const mutate of [
    (c) => { delete c.stages.initial.instructionFieldId; },
    (c) => { delete c.stages.review.instructionFieldId; },
    (c) => { delete c.stages.review.instructionAttachmentsFieldId; },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    await assert.rejects(f.put(invalid, 1), (error) => error.code === "INVALID_FIELD");
  }
  for (const mutate of [
    (c) => { c.fields.keepSegmentsFieldId = "fld_keep"; },
    (c) => { c.stages.first_review = c.stages.review; },
    (c) => { c.stages.initial.instructionAttachmentsFieldId = "fld_images"; },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    await assert.rejects(f.put(invalid, 1), (error) => ["INVALID_FIELD", "UNKNOWN_FIELD"].includes(error.code));
  }
  const mixedLegacy = legacyConfig();
  mixedLegacy.stages.review = config.stages.review;
  await assert.rejects(f.put(mixedLegacy, 1), (error) => error.code === "UNKNOWN_FIELD");
  assert.equal((await f.get()).body.revision, 1);
});

test("canonical review instruction attachments accept only one current attachment field", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  await f.put(config);
  for (const fieldId of ["fld_keep", "fld_status", "fld_missing", "", "C:\\video.mp4"]) {
    const invalid = structuredClone(config);
    invalid.stages.review.instructionAttachmentsFieldId = fieldId;
    await assert.rejects(f.put(invalid, 1), (error) => error.code === "INVALID_FIELD");
  }
  for (const broken of [
    metadata.map((field) => field.fieldId === "fld_images" ? { ...field, type: 1 } : field),
    metadata.map((field) => field.fieldId === "fld_images" ? { ...field, uiType: "Text" } : field),
    [...metadata, structuredClone(metadata.find((field) => field.fieldId === "fld_images"))],
  ]) {
    f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify({ fields: broken }), SUBJECT);
    await assert.rejects(f.put(config, 1), (error) => error.code === "INVALID_FIELD");
  }
  assert.equal((await f.get()).body.revision, 1);
});

test("VM stages accept multi-select progress triggers and persist explicit text instructions and single-select writebacks", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.stages.review = {
    enabled: true, statusFieldId: "fld_progress", triggerOptionId: "opt_first_review",
    instructionFieldId: "fld_keep",
    instructionAttachmentsFieldId: "fld_images",
    writeback: {
      processing: { fieldId: "fld_writeback", optionId: "opt_processing" },
      completed: { fieldId: "fld_writeback", optionId: "opt_completed" },
    },
  };
  const saved = (await f.put(config)).body;
  assert.deepEqual(saved.config.stages.review, config.stages.review);
  f.reopen();
  assert.deepEqual((await f.get()).body.config.stages.review, config.stages.review);
  assert.equal(f.syncCount, 0);
  await assert.rejects(f.api.handle({ method: "POST", pathname: `${url()}/enable`, body: {} }),
    (error) => error.code === "PACKAGE_WORKFLOW_NOT_READY");
});

test("multi-select VM triggers reject contradictory types and unavailable or duplicate options", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.stages.initial = { ...config.stages.initial, enabled: true, statusFieldId: "fld_progress", triggerOptionId: "opt_first_review" };
  for (const broken of [
    metadata.map((field) => field.fieldId === "fld_progress" ? { ...field, type: 3 } : field),
    metadata.map((field) => field.fieldId === "fld_progress" ? { ...field, uiType: "SingleSelect" } : field),
    metadata.map((field) => field.fieldId === "fld_progress" ? { ...field, type: 1, uiType: "MultiSelect" } : field),
    metadata.map((field) => field.fieldId === "fld_progress" ? { ...field, options: [field.options[1]] } : field),
    metadata.map((field) => field.fieldId === "fld_progress" ? { ...field, options: [...field.options, field.options[0]] } : field),
    metadata.map((field) => field.fieldId === "fld_progress" ? { ...field, options: null } : field),
    [...metadata, structuredClone(metadata.find((field) => field.fieldId === "fld_progress"))],
  ]) {
    f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify({ fields: broken }), SUBJECT);
    await assert.rejects(f.put(config), (error) => error.status === 400 && error.code === "INVALID_FIELD");
  }
  assert.equal((await f.get()).body.revision, 0);
});

test("VM stage instructions reject nontext, missing, ambiguous and contradictory fields", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.stages.initial.instructionFieldId = "fld_instruction";
  await f.put(config);
  for (const fieldId of ["fld_output", "fld_status", "fld_progress", "fld_missing", "", "C:\\video.mp4"]) {
    await assert.rejects(f.put({ ...config, stages: { ...config.stages, initial: { ...config.stages.initial, instructionFieldId: fieldId } } }, 1),
      (error) => error.status === 400 && error.code === "INVALID_FIELD");
  }
  for (const broken of [
    metadata.map((field) => field.fieldId === "fld_instruction" ? { ...field, type: 3, uiType: "Text" } : field),
    metadata.map((field) => field.fieldId === "fld_instruction" ? { ...field, type: 1, uiType: "Attachment" } : field),
    [...metadata, structuredClone(metadata.find((field) => field.fieldId === "fld_instruction"))],
  ]) {
    f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify({ fields: broken }), SUBJECT);
    await assert.rejects(f.put(config, 1), (error) => error.code === "INVALID_FIELD");
  }
  assert.equal((await f.get()).body.revision, 1);
});

test("VM stage writebacks accept only current single-select fields and their unique options", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.stages.initial.writeback = {
    processing: { fieldId: "fld_writeback", optionId: "opt_processing" },
    completed: { fieldId: "fld_writeback", optionId: "opt_completed" },
  };
  await f.put(config);
  for (const binding of [
    { fieldId: "fld_progress", optionId: "opt_first_review" },
    { fieldId: "fld_keep", optionId: null },
    { fieldId: "fld_missing", optionId: null },
    { fieldId: "fld_writeback", optionId: "opt_initial" },
    { fieldId: "fld_writeback", optionId: "opt_missing" },
    { fieldId: null, optionId: "opt_processing" },
    { fieldId: "", optionId: null },
  ]) {
    const invalid = structuredClone(config);
    invalid.stages.initial.writeback.processing = binding;
    await assert.rejects(f.put(invalid, 1), (error) => error.status === 400 && error.code === "INVALID_FIELD");
  }
  for (const broken of [
    metadata.map((field) => field.fieldId === "fld_writeback" ? { ...field, type: 4 } : field),
    metadata.map((field) => field.fieldId === "fld_writeback" ? { ...field, uiType: "MultiSelect" } : field),
    metadata.map((field) => field.fieldId === "fld_writeback" ? { ...field, options: [...field.options, field.options[0]] } : field),
    [...metadata, structuredClone(metadata.find((field) => field.fieldId === "fld_writeback"))],
  ]) {
    f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify({ fields: broken }), SUBJECT);
    await assert.rejects(f.put(config, 1), (error) => error.code === "INVALID_FIELD");
  }
  assert.equal((await f.get()).body.revision, 1);
});

test("extended VM stages remain closed to unknown writeback keys and malformed bindings", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.stages.initial.writeback = {
    processing: { fieldId: null, optionId: null },
    completed: { fieldId: null, optionId: null },
  };
  for (const mutate of [
    (c) => { c.stages.initial.writeback.token = "credential"; },
    (c) => { c.stages.initial.writeback.processing.path = "C:\\video.mp4"; },
    (c) => { c.stages.initial.writeback.completed.command = "run"; },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    await assert.rejects(f.put(invalid), (error) => error.code === "UNKNOWN_FIELD");
  }
  for (const mutate of [
    (c) => { c.stages.initial.writeback = null; },
    (c) => { delete c.stages.initial.writeback.completed; },
    (c) => { delete c.stages.initial.writeback.processing.optionId; },
    (c) => { c.stages.initial.writeback.processing = []; },
    (c) => { c.stages.initial.instructionFieldId = undefined; },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    await assert.rejects(f.put(invalid), (error) => error.code === "INVALID_FIELD");
  }
  assert.equal((await f.get()).body.revision, 0);
});

test("VM extended stage bindings validate against each subject metadata without sharing drafts or options", async (t) => {
  const f = await fixture(t);
  const chemistry = await populatedConfig(f);
  chemistry.stages.initial.instructionFieldId = "fld_keep";
  chemistry.stages.initial.writeback = {
    processing: { fieldId: "fld_writeback", optionId: "opt_processing" },
    completed: { fieldId: "fld_writeback", optionId: "opt_completed" },
  };
  const saved = (await f.put(chemistry)).body;
  const physicsFields = metadata.map((field) => field.fieldId === "fld_writeback"
    ? { ...field, options: [{ id: "opt_physics_processing", name: "处理中" }, { id: "opt_physics_completed", name: "已交付" }] }
    : field.fieldId === "fld_keep" ? { ...field, fieldId: "fld_physics_keep" } : field);
  f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
    .run(JSON.stringify({ fields: physicsFields }), OTHER_SUBJECT);
  const physics = structuredClone(chemistry);
  physics.stages.initial.instructionFieldId = "fld_physics_keep";
  await assert.rejects(f.put(physics, 0, OTHER_SUBJECT), (error) => error.code === "INVALID_FIELD");
  physics.stages.initial.writeback.processing.optionId = "opt_physics_processing";
  physics.stages.initial.writeback.completed.optionId = "opt_physics_completed";
  physics.stages.initial.instructionFieldId = "fld_keep";
  await assert.rejects(f.put(physics, 0, OTHER_SUBJECT), (error) => error.code === "INVALID_FIELD");
  physics.stages.initial.instructionFieldId = "fld_physics_keep";
  assert.equal((await f.put(physics, 0, OTHER_SUBJECT)).body.revision, 1);
  assert.deepEqual((await f.get()).body, saved);
  assert.equal((await f.get(OTHER_SUBJECT)).body.config.stages.initial.writeback.completed.optionId, "opt_physics_completed");
  assert.equal((await f.get(SUBJECT, "vm-other")).body.revision, 0);
});

test("VM multi-select trigger options cannot be borrowed from another subject", async (t) => {
  const f = await fixture(t);
  const chemistry = await populatedConfig(f);
  chemistry.stages.review = { ...chemistry.stages.review, enabled: true, statusFieldId: "fld_progress", triggerOptionId: "opt_first_review" };
  const saved = (await f.put(chemistry)).body;
  const physicsFields = metadata.map((field) => field.fieldId === "fld_progress"
    ? { ...field, type: "4", options: [{ id: "opt_physics_review", name: "待修改" }] } : field);
  f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
    .run(JSON.stringify({ fields: physicsFields }), OTHER_SUBJECT);
  await assert.rejects(f.put(chemistry, 0, OTHER_SUBJECT), (error) => error.code === "INVALID_FIELD");
  const physics = structuredClone(chemistry);
  physics.stages.review.triggerOptionId = "opt_physics_review";
  assert.equal((await f.put(physics, 0, OTHER_SUBJECT)).body.config.stages.review.triggerOptionId, "opt_physics_review");
  assert.deepEqual((await f.get()).body, saved);
});

test("profiles persist across restarts and remain isolated by subject and package alias", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  const first = await f.put(config);
  assert.equal(first.body.revision, 1);
  assert.ok(first.body.updatedAt);
  await f.put({ ...config, approval: { department: "物理组", reason: "另一学科" } }, 0, OTHER_SUBJECT);
  await f.put({ ...config, approval: { department: "动画组", reason: "另一个包" } }, 0, SUBJECT, "vm-other");
  f.reopen();
  assert.deepEqual((await f.get()).body, first.body);
  assert.equal((await f.get(OTHER_SUBJECT)).body.config.approval.reason, "另一学科");
  assert.equal((await f.get(SUBJECT, "vm-other")).body.config.approval.reason, "另一个包");
  assert.equal((await f.get(OTHER_SUBJECT, "vm-other")).body.revision, 0);
});

test("draft saves preserve active and draft subject snapshots and never synchronize Bridge", async (t) => {
  const f = await fixture(t);
  const subject = await f.workflowStore.saveSubjectDraft(SUBJECT, { packageRoute: { packageAlias: "legacy" } });
  const enabled = await f.workflowStore.enableSubject(SUBJECT, subject.configVersion);
  await f.workflowStore.saveSubjectDraft(SUBJECT, { expectedVersion: enabled.configVersion, title: { fieldId: "fld_vmid", fieldName: "原视频vmid" } });
  const beforeSubject = f.database.database.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(SUBJECT);
  const beforeVersions = f.database.database.prepare("SELECT * FROM feishu_subject_versions WHERE subject_key = ? ORDER BY version").all(SUBJECT);
  const beforeSync = f.syncCount;
  const config = await populatedConfig(f);
  await f.put(config);
  await f.put({ ...config, approval: { department: "动画组", reason: "调整说明" } }, 1);
  assert.deepEqual(f.database.database.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(SUBJECT), beforeSubject);
  assert.deepEqual(f.database.database.prepare("SELECT * FROM feishu_subject_versions WHERE subject_key = ? ORDER BY version").all(SUBJECT), beforeVersions);
  assert.equal(f.syncCount, beforeSync);
});

test("optimistic revisions reject stale creates and updates without overwriting saved drafts", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  const first = (await f.put(config)).body;
  await assert.rejects(f.put({ ...config, approval: { department: "动画组", reason: "过期写入" } }),
    (error) => error.status === 409 && error.code === "VERSION_CONFLICT" && error.details.actualRevision === 1);
  assert.deepEqual((await f.get()).body, first);
  assert.equal((await f.put(config, 1)).body.revision, 2);
  await assert.rejects(f.put(config, 1), (error) => error.code === "VERSION_CONFLICT");
  assert.equal((await f.get()).body.revision, 2);
});

test("incomplete draft bindings are allowed but field and option values must match metadata", async (t) => {
  const f = await fixture(t);
  const empty = (await f.get()).body.config;
  await f.put(empty);
  const valid = await populatedConfig(f);
  const mutations = [
    (c) => { c.fields.vmidFieldId = "fld_output"; },
    (c) => { c.fields.outputAttachmentFieldId = "fld_vmid"; },
    (c) => { c.stages.review.instructionFieldId = "fld_missing"; },
    (c) => { c.fields.vmidFieldId = "C:\\secret\\file"; },
    (c) => { c.fields.vmidFieldId = ""; },
    (c) => { c.stages.initial.statusFieldId = "fld_vmid"; },
    (c) => { c.stages.initial.triggerOptionId = "opt_missing"; },
    (c) => { c.stages.initial.statusFieldId = null; },
    (c) => { c.stages.initial.enabled = "true"; },
  ];
  for (const mutate of mutations) {
    const config = structuredClone(valid);
    mutate(config);
    await assert.rejects(f.put(config, 1), (error) => error.status === 400 && error.code === "INVALID_FIELD");
  }
  assert.equal((await f.get()).body.revision, 1);
});

test("ambiguous or contradictory metadata cannot approve field bindings", async (t) => {
  const f = await fixture(t);
  const valid = await populatedConfig(f);
  for (const broken of [
    [...metadata, structuredClone(metadata[0])],
    metadata.map((field) => field.fieldId === "fld_vmid" ? { ...field, type: 17, uiType: "Text" } : field),
    metadata.map((field) => field.fieldId === "fld_output" ? { ...field, type: 1, uiType: "Attachment" } : field),
    metadata.map((field) => field.fieldId === "fld_status" ? { ...field, options: [...field.options, field.options[0]] } : field),
  ]) {
    f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?").run(JSON.stringify({ fields: broken }), SUBJECT);
    await assert.rejects(f.put(valid), (error) => error.code === "INVALID_FIELD");
  }
  assert.equal((await f.get()).body.revision, 0);
});

test("removed bindings remain readable for repair but saving rechecks current metadata", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  await f.put(config);
  f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
    .run(JSON.stringify({ fields: metadata.filter((field) => field.fieldId !== "fld_vmid") }), SUBJECT);
  assert.equal((await f.get()).body.config.fields.vmidFieldId, "fld_vmid");
  await assert.rejects(f.put(config, 1), (error) => error.code === "INVALID_FIELD");
  config.fields.vmidFieldId = null;
  assert.equal((await f.put(config, 1)).body.revision, 2);
});

test("closed draft schema rejects credentials, paths, extra fields and malformed revisions", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  for (const mutate of [
    (c) => { c.token = "credential"; },
    (c) => { c.approval.token = "credential"; },
    (c) => { c.fields.sourcePath = "C:\\video.mp4"; },
    (c) => { c.stages.initial.prompt = "command"; },
    (c) => { c.stages.other = c.stages.initial; },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    await assert.rejects(f.put(invalid), (error) => error.code === "UNKNOWN_FIELD");
  }
  for (const revision of [-1, 1.5, "0", null]) {
    await assert.rejects(f.put(config, revision), (error) => error.code === "INVALID_FIELD");
  }
  await assert.rejects(f.api.handle({ method: "PUT", pathname: url(), body: { expectedRevision: 0, config, enabled: true } }),
    (error) => error.code === "UNKNOWN_FIELD");
  const incomplete = structuredClone(config);
  delete incomplete.fields.vmidFieldId;
  await assert.rejects(f.put(incomplete), (error) => error.code === "INVALID_FIELD");
  assert.equal((await f.get()).body.revision, 0);
});

test("only recognized packages and live subjects can access draft profiles", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get(SUBJECT, "legacy")).body.workflowTemplate.id, "document_draft_zip");
  await assert.rejects(f.get(SUBJECT, "missing"), (error) => error.code === "PACKAGE_NOT_FOUND");
  f.packages.set("unknown", { alias: "unknown", workflowTemplate: { id: "vm_pmo_review_video", version: 999 } });
  await assert.rejects(f.get(SUBJECT, "unknown"), (error) => error.code === "PACKAGE_WORKFLOW_DRAFT_UNSUPPORTED");
  await assert.rejects(f.get("bas_preview:tbl_missing"), (error) => error.code === "SUBJECT_NOT_FOUND");
  await f.workflowStore.removeSubject(SUBJECT);
  await assert.rejects(f.get(), (error) => error.code === "SUBJECT_NOT_FOUND");
  assert.equal(await f.api.handle({ method: "GET", pathname: "/api/unrelated" }), null);
  await assert.rejects(f.api.handle({ method: "POST", pathname: url() }), (error) => error.status === 405);
});

test("saved profile corruption fails closed without replacing it with a new draft", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  await f.put(config);
  f.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ?").run("[]");
  await assert.rejects(f.get(), (error) => error.code === "PACKAGE_WORKFLOW_DRAFT_INVALID");
  await assert.rejects(f.put(config, 1), (error) => error.code === "PACKAGE_WORKFLOW_DRAFT_INVALID");
  assert.equal(f.database.database.prepare("SELECT config_json FROM feishu_package_workflow_drafts").get().config_json, "[]");
});

test("the preview store remains compatible with an injected read-only package registry", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const api = createFeishuPackageWorkflowDrafts({
    database: f.database,
    workflowStore: f.workflowStore,
    packageStore: { read: async () => { reads += 1; return { [ALIAS]: { workflowTemplate: TEMPLATE } }; } },
  });
  assert.equal(reads, 0);
  const response = await api.handle({ method: "GET", pathname: url() });
  assert.equal(response.body.revision, 0);
  assert.equal(reads, 1);
});

function archiveConfig(overrides = {}) {
  return {
    enabled: true, statusFieldId: "fld_progress", triggerOptionId: "opt_final_review",
    pathSource: "manual", directoryPath: "\\\\nas\\交付\\课程", pathFieldId: null,
    ...overrides,
  };
}

test("VM naming and final archive defaults stay empty for old two-stage rows without GET writes", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  delete config.finalArchive;
  delete config.fields.namingFieldId;
  await f.put(config);
  f.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
    .run(JSON.stringify(config), SUBJECT);
  const before = f.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT);
  f.reopen();
  const read = (await f.get()).body;
  assert.equal(read.revision, 1);
  assert.deepEqual(read.config.finalArchive, {
    enabled: false, statusFieldId: null, triggerOptionId: null,
    pathSource: "manual", directoryPath: null, pathFieldId: null,
  });
  assert.equal(read.config.fields.namingFieldId, null);
  assert.equal(Object.hasOwn(read.config.stages.initial, "namingFieldId"), false);
  assert.equal(Object.hasOwn(read.config.stages.review, "namingFieldId"), false);
  assert.deepEqual(f.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT), before);
  const saved = (await f.put(read.config, 1)).body;
  assert.equal(saved.revision, 2);
  assert.deepEqual(JSON.parse(f.database.database.prepare("SELECT config_json FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT).config_json), saved.config);
});

test("VM shared text/formula naming and enabled final archive persist after restart without enabling production", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.fields.namingFieldId = "fld_name";
  config.finalArchive = archiveConfig({ directoryPath: "W:/交付/课程/" });
  const saved = (await f.put(config)).body;
  assert.equal(saved.config.finalArchive.directoryPath, "W:\\交付\\课程");
  assert.equal(saved.config.fields.namingFieldId, "fld_name");
  assert.equal(Object.hasOwn(saved.config.stages.initial, "namingFieldId"), false);
  assert.equal(Object.hasOwn(saved.config.stages.review, "namingFieldId"), false);
  f.reopen();
  assert.deepEqual((await f.get()).body, saved);
  await assert.rejects(f.api.handle({ method: "POST", pathname: `${url()}/enable`, body: {} }),
    (error) => error.code === "PACKAGE_WORKFLOW_NOT_READY");
  assert.equal(f.syncCount, 0);
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  config.fields.namingFieldId = "fld_formula";
  const formula = (await f.put(config, 1)).body;
  f.reopen();
  assert.deepEqual((await f.get()).body, formula);
  assert.equal(formula.config.fields.namingFieldId, "fld_formula");
});

test("enabled VM archives need complete bindings while disabled archives allow partial drafts", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.fields.namingFieldId = "fld_name";
  config.finalArchive = archiveConfig();
  for (const key of ["statusFieldId", "triggerOptionId", "directoryPath"]) {
    const invalid = structuredClone(config);
    invalid.finalArchive[key] = null;
    await assert.rejects(f.put(invalid), (error) => error.code === "INVALID_FIELD");
  }
  const missingName = structuredClone(config);
  missingName.fields.namingFieldId = null;
  await assert.rejects(f.put(missingName), (error) => error.code === "INVALID_FIELD");
  config.fields.namingFieldId = null;
  config.finalArchive = archiveConfig({ enabled: false, triggerOptionId: null, directoryPath: null, pathFieldId: "fld_formula" });
  assert.equal((await f.put(config)).body.config.finalArchive.pathFieldId, "fld_formula");
  const invalid = structuredClone(config);
  invalid.finalArchive.statusFieldId = null;
  invalid.finalArchive.triggerOptionId = "opt_final_review";
  await assert.rejects(f.put(invalid, 1), (error) => error.code === "INVALID_FIELD");
  assert.equal((await f.get()).body.revision, 1);
});

test("PMO directory mode accepts text and formula bindings and requires only its selected path", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.fields.namingFieldId = "fld_name";
  config.finalArchive = archiveConfig({ pathSource: "pmo_field", directoryPath: null, pathFieldId: "fld_formula" });
  const missing = structuredClone(config);
  missing.finalArchive.pathFieldId = null;
  await assert.rejects(f.put(missing), (error) => error.code === "INVALID_FIELD");
  assert.equal((await f.put(config)).body.config.finalArchive.pathFieldId, "fld_formula");
  config.finalArchive.pathFieldId = "fld_name";
  assert.equal((await f.put(config, 1)).body.config.finalArchive.pathFieldId, "fld_name");
  config.finalArchive = archiveConfig({ pathFieldId: "fld_removed" });
  assert.equal((await f.put(config, 2)).body.config.finalArchive.pathFieldId, "fld_removed");
  config.finalArchive.pathSource = "pmo_field";
  await assert.rejects(f.put(config, 3), (error) => error.code === "INVALID_FIELD");
  config.finalArchive.pathFieldId = "fld_formula";
  config.finalArchive.directoryPath = "W:\\saved-manual";
  const saved = (await f.put(config, 3)).body;
  assert.equal(saved.config.finalArchive.directoryPath, "W:\\saved-manual");
  f.reopen();
  assert.deepEqual((await f.get()).body, saved);
});

test("unused directory mode values still reject malformed identifiers and unsafe manual paths", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.fields.namingFieldId = "fld_name";
  config.finalArchive = archiveConfig({ pathFieldId: "C:\\not-an-identifier" });
  await assert.rejects(f.put(config), (error) => error.code === "INVALID_FIELD");
  config.finalArchive = archiveConfig({ pathSource: "pmo_field", pathFieldId: "fld_formula", directoryPath: "W:\\..\\outside" });
  await assert.rejects(f.put(config), (error) => error.code === "INVALID_FIELD");
});

test("old course-root archives need explicit directory review on GET without database migration writes", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.fields.namingFieldId = "fld_name";
  await f.put(config);
  config.finalArchive = {
    enabled: true, statusFieldId: "fld_progress", triggerOptionId: "opt_final_review",
    rootPath: "W:\\old-root", courseNameFieldId: "fld_formula",
  };
  f.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
    .run(JSON.stringify(config), SUBJECT);
  const before = f.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT);
  f.reopen();
  const read = (await f.get()).body;
  assert.equal(read.revision, 1);
  assert.equal(read.legacyArchivePathNeedsReview, true);
  assert.deepEqual(read.config.finalArchive, {
    enabled: true, statusFieldId: "fld_progress", triggerOptionId: "opt_final_review",
    pathSource: "manual", directoryPath: null, pathFieldId: null,
  });
  await f.get();
  assert.deepEqual(f.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT), before);
  await assert.rejects(f.put(config, 1), (error) => error.code === "UNKNOWN_FIELD");
  await assert.rejects(f.put(read.config, 1), (error) => error.code === "INVALID_FIELD");
  read.config.finalArchive.directoryPath = "W:\\specific-target";
  const repaired = (await f.put(read.config, 1)).body;
  assert.equal(repaired.revision, 2);
  assert.equal(Object.hasOwn(repaired, "legacyArchivePathNeedsReview"), false);
  f.reopen();
  assert.deepEqual((await f.get()).body, repaired);
});

test("only populated old archive bindings show a directory review notice and legacy names still migrate", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  delete config.fields.namingFieldId;
  config.stages.initial.namingFieldId = "fld_name";
  config.finalArchive = {
    enabled: false, statusFieldId: null, triggerOptionId: null,
    rootPath: null, courseNameFieldId: null, namingFieldId: "fld_name",
  };
  await f.put(await populatedConfig(f));
  for (const [patch, notice] of [[{}, false], [{ rootPath: "W:\\old-root" }, true], [{ courseNameFieldId: "fld_formula" }, true]]) {
    const legacy = structuredClone(config);
    Object.assign(legacy.finalArchive, patch);
    f.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify(legacy), SUBJECT);
    const read = (await f.get()).body;
    assert.equal(read.config.fields.namingFieldId, "fld_name");
    assert.equal(Object.hasOwn(read, "legacyArchivePathNeedsReview"), notice);
    assert.equal(read.config.finalArchive.directoryPath, null);
    assert.equal(Object.hasOwn(read.config.finalArchive, "namingFieldId"), false);
  }
});

test("final archive supports either progress type and refuses an enabled editing trigger collision", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.fields.namingFieldId = "fld_name";
  config.finalArchive = archiveConfig({ statusFieldId: "fld_status", triggerOptionId: "opt_initial" });
  await assert.rejects(f.put(config), (error) => error.code === "INVALID_FIELD");
  config.stages.initial.enabled = false;
  assert.equal((await f.put(config)).body.config.finalArchive.triggerOptionId, "opt_initial");
  config.finalArchive = archiveConfig();
  config.stages.review = { ...config.stages.review, enabled: true, statusFieldId: "fld_progress", triggerOptionId: "opt_final_review" };
  await assert.rejects(f.put(config, 1), (error) => error.code === "INVALID_FIELD");
  config.finalArchive.enabled = false;
  assert.equal((await f.put(config, 1)).body.revision, 2);
  config.finalArchive.enabled = true;
  config.stages.review.triggerOptionId = "opt_first_review";
  assert.equal((await f.put(config, 2)).body.config.finalArchive.statusFieldId, "fld_progress");
});

test("shared VM naming and selected PMO directory bindings reject wrong, missing, duplicate and conflicting metadata", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.fields.namingFieldId = "fld_name";
  config.finalArchive = archiveConfig({ pathSource: "pmo_field", pathFieldId: "fld_formula", directoryPath: null });
  for (const [object, key] of [["fields", "namingFieldId"], ["finalArchive", "pathFieldId"]]) {
    for (const id of ["fld_output", "fld_status", "fld_progress", "fld_missing", "", "C:\\secret.mp4"]) {
      const invalid = structuredClone(config);
      invalid[object][key] = id;
      await assert.rejects(f.put(invalid), (error) => error.code === "INVALID_FIELD");
    }
  }
  for (const broken of [
    metadata.map((field) => field.fieldId === "fld_formula" ? { ...field, type: 1 } : field),
    metadata.map((field) => field.fieldId === "fld_formula" ? { ...field, uiType: "Text" } : field),
    metadata.map((field) => field.fieldId === "fld_name" ? { ...field, type: 20 } : field),
    metadata.map((field) => field.fieldId === "fld_name" ? { ...field, type: null, uiType: null } : field),
    [...metadata, structuredClone(metadata.find((field) => field.fieldId === "fld_name"))],
    [...metadata, structuredClone(metadata.find((field) => field.fieldId === "fld_formula"))],
  ]) {
    f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify({ fields: broken }), SUBJECT);
    await assert.rejects(f.put(config), (error) => error.code === "INVALID_FIELD");
  }
  const uiOnly = metadata.map((field) => ["fld_formula", "fld_name"].includes(field.fieldId) ? { ...field, type: null } : field);
  f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
    .run(JSON.stringify({ fields: uiOnly }), SUBJECT);
  assert.equal((await f.put(config)).body.revision, 1);
});

test("archive progress bindings reject stale, ambiguous and contradictory metadata", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.fields.namingFieldId = "fld_name";
  config.finalArchive = archiveConfig();
  for (const broken of [
    metadata.map((field) => field.fieldId === "fld_progress" ? { ...field, type: 3 } : field),
    metadata.map((field) => field.fieldId === "fld_progress" ? { ...field, uiType: "SingleSelect" } : field),
    metadata.map((field) => field.fieldId === "fld_progress" ? { ...field, options: [field.options[0]] } : field),
    metadata.map((field) => field.fieldId === "fld_progress" ? { ...field, options: [...field.options, field.options[1]] } : field),
    [...metadata, structuredClone(metadata.find((field) => field.fieldId === "fld_progress"))],
  ]) {
    f.database.database.prepare("UPDATE feishu_subjects SET metadata_json = ? WHERE subject_key = ?")
      .run(JSON.stringify({ fields: broken }), SUBJECT);
    await assert.rejects(f.put(config), (error) => error.code === "INVALID_FIELD");
  }
  assert.equal((await f.get()).body.revision, 0);
});

test("archive directory syntax accepts absolute drive and UNC paths but rejects traversal and Windows device paths", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.finalArchive = archiveConfig({ enabled: false });
  for (const directoryPath of [
    "relative/path", "W:relative", "\\\\nas", "\\\\?\\UNC\\nas\\share", "\\\\.\\pipe",
    "W:\\..\\outside", "W:\\folder\\.\\child", "\\\\nas\\share\\..\\outside", "\\\\..\\share",
    "\\\\nas\\..", "W:\\bad:name", "W:\\folder ", " W:\\folder", "W:\\NUL", "W:\\folder\\CON.txt", "", 123,
    "W:\\COM¹", "W:\\LPT²", "W:\\CONIN$", "W:\\CONOUT$", "W:\\CON .txt", "\\\\nas\\share\\COM³.log",
  ]) {
    const invalid = structuredClone(config);
    invalid.finalArchive.directoryPath = directoryPath;
    await assert.rejects(f.put(invalid), (error) => error.code === "INVALID_FIELD", `unsafe directory: ${String(directoryPath)}`);
  }
  let revision = 0;
  for (const [directoryPath, expected] of [["W:/交付/", "W:\\交付"], ["\\\\nas\\share\\课程\\", "\\\\nas\\share\\课程"], ["W:\\", "W:\\"]]) {
    config.finalArchive.directoryPath = directoryPath;
    const saved = (await f.put(config, revision++)).body;
    assert.equal(saved.config.finalArchive.directoryPath, expected);
  }
});

test("extended naming and archive configuration keeps closed shapes and strict value types", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.fields.namingFieldId = "fld_name";
  config.finalArchive = archiveConfig();
  for (const mutate of [
    (c) => { c.finalArchive.command = "run"; },
    (c) => { c.finalArchive.sourceAttachmentId = "file_1"; },
    (c) => { c.stages.initial.naming = { fieldId: "fld_name" }; },
    (c) => { c.stages.initial.namingFieldId = null; },
    (c) => { c.stages.review.namingFieldId = "fld_name"; },
    (c) => { c.finalArchive.namingFieldId = "fld_name"; },
    (c) => { c.finalArchive.rootPath = "W:\\old"; },
    (c) => { c.finalArchive.courseNameFieldId = "fld_formula"; },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    await assert.rejects(f.put(invalid), (error) => error.code === "UNKNOWN_FIELD");
  }
  for (const mutate of [
    (c) => { c.finalArchive = null; },
    (c) => { c.finalArchive.enabled = "true"; },
    (c) => { delete c.finalArchive.directoryPath; },
    (c) => { delete c.finalArchive.pathFieldId; },
    (c) => { c.finalArchive.pathSource = "cell"; },
    (c) => { c.fields.namingFieldId = undefined; },
    (c) => { c.fields.namingFieldId = 123; },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    await assert.rejects(f.put(invalid), (error) => error.code === "INVALID_FIELD");
  }
  assert.equal((await f.get()).body.revision, 0);
});

test("legacy independent names merge into the one shared binding on GET and explicit save", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  delete config.fields.namingFieldId;
  config.stages.initial.namingFieldId = "fld_name";
  config.stages.review.namingFieldId = "fld_name";
  config.finalArchive = { ...archiveConfig(), namingFieldId: "fld_name" };
  const saved = (await f.put(config)).body;
  assert.equal(saved.config.fields.namingFieldId, "fld_name");
  assert.deepEqual(Object.keys(saved.config.finalArchive).sort(), ["directoryPath", "enabled", "pathFieldId", "pathSource", "statusFieldId", "triggerOptionId"]);
  assert.equal(Object.hasOwn(saved, "legacyNamingConflict"), false);
  assert.equal(Object.hasOwn(saved.config.stages.initial, "namingFieldId"), false);
  assert.equal(Object.hasOwn(saved.config.stages.review, "namingFieldId"), false);
  f.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
    .run(JSON.stringify(config), SUBJECT);
  const before = f.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT);
  f.reopen();
  const read = (await f.get()).body;
  assert.deepEqual(read.config, saved.config);
  assert.equal(Object.hasOwn(read, "legacyNamingConflict"), false);
  assert.deepEqual(f.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT), before);
  const migrated = (await f.put(read.config, 1)).body;
  f.reopen();
  assert.deepEqual((await f.get()).body, migrated);
  assert.equal(migrated.revision, 2);
});

test("legacy naming merge ignores null bindings but includes the whole old three-stage draft", async (t) => {
  const f = await fixture(t);
  const config = legacyConfig();
  config.stages.initial.namingFieldId = null;
  config.stages.first_review.namingFieldId = "fld_formula";
  config.stages.final_review.namingFieldId = "fld_formula";
  const saved = (await f.put(config)).body;
  assert.equal(saved.config.fields.namingFieldId, "fld_formula");
  assert.equal(Object.hasOwn(saved, "legacyNamingConflict"), false);
  config.stages.final_review.namingFieldId = "fld_name";
  f.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
    .run(JSON.stringify(config), SUBJECT);
  const read = (await f.get()).body;
  assert.equal(read.config.fields.namingFieldId, null);
  assert.equal(read.legacyNamingConflict, true);
  assert.equal(read.legacyReviewStage, "final_review");
});

test("conflicting old enabled-archive names stay repairable without GET writes or guessed selections", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  delete config.fields.namingFieldId;
  config.stages.initial.namingFieldId = "fld_name";
  config.stages.review.namingFieldId = "fld_formula";
  config.finalArchive = { ...archiveConfig(), namingFieldId: "fld_name" };
  await f.put(await populatedConfig(f));
  f.database.database.prepare("UPDATE feishu_package_workflow_drafts SET config_json = ? WHERE subject_key = ?")
    .run(JSON.stringify(config), SUBJECT);
  const before = f.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT);
  f.reopen();
  const read = (await f.get()).body;
  assert.equal(read.revision, 1);
  assert.equal(read.config.fields.namingFieldId, null);
  assert.equal(read.legacyNamingConflict, true);
  assert.equal(Object.hasOwn(read.config.finalArchive, "namingFieldId"), false);
  await f.get();
  assert.deepEqual(f.database.database.prepare("SELECT * FROM feishu_package_workflow_drafts WHERE subject_key = ?").get(SUBJECT), before);
  await assert.rejects(f.put(config, 1), (error) => error.code === "INVALID_FIELD");
  await assert.rejects(f.put(read.config, 1), (error) => error.code === "INVALID_FIELD");
  read.config.fields.namingFieldId = "fld_formula";
  const repaired = (await f.put(read.config, 1)).body;
  assert.equal(repaired.config.fields.namingFieldId, "fld_formula");
  assert.equal(Object.hasOwn(repaired, "legacyNamingConflict"), false);
  f.reopen();
  assert.deepEqual((await f.get()).body, repaired);
});

test("discarded legacy names validate structure but only the retained shared binding checks metadata", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  delete config.fields.namingFieldId;
  config.stages.initial.namingFieldId = "fld_removed";
  config.stages.review.namingFieldId = "fld_name";
  config.finalArchive.namingFieldId = null;
  for (const [mutate, code] of [
    [(c) => { c.stages.initial.namingFieldId = "C:\\private\\video.mp4"; }, "INVALID_FIELD"],
    [(c) => { c.stages.review.namingFieldId = 123; }, "INVALID_FIELD"],
    [(c) => { c.finalArchive.namingFieldId = ""; }, "INVALID_FIELD"],
    [(c) => { c.stages.initial.naming = "fld_name"; }, "UNKNOWN_FIELD"],
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    await assert.rejects(f.put(invalid), (error) => error.code === code);
  }
  const saved = (await f.put(config)).body;
  assert.equal(saved.config.fields.namingFieldId, null);
  assert.equal(Object.hasOwn(saved, "legacyNamingConflict"), false);
  assert.equal(Object.hasOwn((await f.get()).body, "legacyNamingConflict"), false);
  config.stages.review.namingFieldId = "fld_removed";
  await assert.rejects(f.put(config, 1), (error) => error.code === "INVALID_FIELD");
  const malformedThreeStages = legacyConfig();
  malformedThreeStages.stages.first_review.enabled = true;
  malformedThreeStages.stages.final_review.namingFieldId = "C:\\private\\video.mp4";
  await assert.rejects(f.put(malformedThreeStages, 1), (error) => error.code === "INVALID_FIELD");
  assert.equal((await f.get()).body.revision, 1);
});

test("canonical shared naming can be cleared without hidden legacy inheritance", async (t) => {
  const f = await fixture(t);
  const config = await populatedConfig(f);
  config.fields.namingFieldId = "fld_name";
  await f.put(config);
  config.fields.namingFieldId = null;
  const saved = (await f.put(config, 1)).body;
  f.reopen();
  assert.deepEqual((await f.get()).body, saved);
  assert.equal(saved.config.fields.namingFieldId, null);
  assert.equal(Object.hasOwn(saved, "legacyNamingConflict"), false);
});
