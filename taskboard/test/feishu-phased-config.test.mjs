import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import * as phasedStageContract from "../server/feishu-workflow-stages.mjs";
import {
  STAGE_IDS,
  createFeishuWorkflowStore,
  normalizeStage,
  subjectProjectId,
  validateSubjectConfig,
} from "../server/feishu-workflow-store.mjs";

const subjectKey = "bas_phase:tbl_subject";

function metadata() {
  return {
    fields: [
      {
        fieldId: "fld_status",
        fieldName: "流程",
        type: 3,
        uiType: "SingleSelect",
        options: [
          { id: "opt_initial", name: "初稿" },
          { id: "opt_review", name: "初审修改" },
          { id: "opt_final", name: "终审修改" },
        ],
      },
      { fieldId: "fld_document", fieldName: "素材文档", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_name", fieldName: "命名", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_audio", fieldName: "音频", type: 17, uiType: "Attachment", options: [] },
      { fieldId: "fld_text", fieldName: "普通文本", type: 1, uiType: "Text", options: [] },
    ],
  };
}

function stage(id, optionId, value, overrides = {}) {
  return {
    enabled: true,
    trigger: { fieldId: "fld_status", optionId, value },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "修改意见" },
    audio: { mode: "video_original" },
    artifactTargetPath: `C:\\approved\\${id}`,
    nameSuffix: `_${value}`,
    ...overrides,
  };
}

function subject() {
  return {
    subjectKey,
    baseToken: "bas_phase",
    baseName: "阶段 Base",
    tableId: "tbl_subject",
    tableName: "学科",
    projectId: subjectProjectId(subjectKey),
    displayEnabled: true,
    lifecycle: "draft",
    configVersion: 1,
    statusField: { fieldId: "fld_status", fieldName: "流程" },
    documentField: { fieldId: "fld_document", fieldName: "素材文档" },
    namingField: { fieldId: "fld_name", fieldName: "命名" },
    stages: {
      initial: stage("initial", "opt_initial", "初稿"),
      first_review: stage("first_review", "opt_review", "初审修改"),
      final_review: stage("final_review", "opt_final", "终审修改"),
    },
    trigger: { fieldId: "fld_status", fieldName: "流程", startValue: "初稿", optionId: "opt_initial" },
    title: { fieldId: null, fieldName: null },
    execution: { mode: "manual", concurrencyGroup: "autocut", maxConcurrent: 1, resourceGroups: [] },
    packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
    upload: { enqueueMode: "manual", artifactSourceMode: "driver_report", artifactSourcePath: "C:\\artifacts", targetId: null, targetPath: null, uploadConcurrency: 1 },
    metadata: metadata(),
  };
}

test("normalizes the three fixed phases and rejects duplicate enabled options", () => {
  assert.deepEqual([...STAGE_IDS], ["initial", "first_review", "final_review"]);
  const value = subject();
  const normalized = validateSubjectConfig(value);
  assert.deepEqual(Object.keys(normalized.stages), [...STAGE_IDS]);
  assert.equal(normalized.stages.initial.trigger.optionId, "opt_initial");

  const duplicate = structuredClone(value);
  duplicate.stages.final_review.trigger.optionId = "opt_initial";
  assert.throws(() => validateSubjectConfig(duplicate), /enabled stage trigger options must be unique/i);
});

const unknownStageBoundaryCases = [
  {
    path: "stages.initial.command",
    mutate: (value) => { value.stages.initial.command = "run-anything"; },
  },
  {
    path: "stages.initial.trigger.prompt",
    mutate: (value) => { value.stages.initial.trigger.prompt = "do not execute"; },
  },
  {
    path: "stages.initial.videoSource.credential",
    mutate: (value) => { value.stages.initial.videoSource.credential = "secret"; },
  },
  {
    path: "stages.initial.audio.source.credential",
    mutate: (value) => {
      value.stages.initial.audio = {
        mode: "replace_original",
        source: { kind: "docx_section", anchorText: "配音", credential: "secret" },
      };
    },
  },
  {
    path: "stages.initial.audio.source.command",
    mutate: (value) => {
      value.stages.initial.audio = {
        mode: "video_original",
        source: { kind: "docx_section", anchorText: "不活跃来源", command: "do not execute" },
        durationToleranceSeconds: -1,
      };
    },
  },
  {
    path: "stages.initial.audio.credentials",
    mutate: (value) => { value.stages.initial.audio.credentials = ["secret"]; },
  },
];

for (const { path: unknownPath, mutate } of unknownStageBoundaryCases) {
  test(`rejects unknown staged field ${unknownPath}`, () => {
    const value = subject();
    mutate(value);
    assert.throws(
      () => validateSubjectConfig(value),
      (error) => error?.code === "UNKNOWN_FIELD" && error.message.includes(unknownPath),
      unknownPath,
    );
  });
}

test("rejects type:4 metadata that claims uiType:SingleSelect", () => {
  const statusConflict = subject();
  const statusField = statusConflict.metadata.fields.find((field) => field.fieldId === "fld_status");
  statusField.type = 4;
  assert.throws(
    () => validateSubjectConfig(statusConflict),
    (error) => error?.code === "FIELD_TYPE_INVALID" && /statusField/i.test(error.message),
    "type:4 with uiType:SingleSelect",
  );
});

test("rejects type:1 metadata that claims uiType:Attachment", () => {
  const attachmentConflict = subject();
  const audioField = attachmentConflict.metadata.fields.find((field) => field.fieldId === "fld_audio");
  audioField.type = 1;
  attachmentConflict.stages.initial.audio = {
    mode: "replace_original",
    source: { kind: "base_attachment", fieldId: "fld_audio" },
  };
  const normalizedConflict = validateSubjectConfig(attachmentConflict);
  assert.throws(
    () => phasedStageContract.assertPhasedAttachmentBindings(normalizedConflict),
    (error) => error?.code === "FIELD_TYPE_INVALID"
      && error.path === "stages.initial.audio.source.fieldId",
    "type:1 with uiType:Attachment",
  );
});

test("accepts a string attachment type when uiType is missing", () => {
  const stringTypedAttachment = subject();
  const stringField = stringTypedAttachment.metadata.fields.find((field) => field.fieldId === "fld_audio");
  stringField.type = "17";
  delete stringField.uiType;
  stringTypedAttachment.stages.initial.audio = {
    mode: "replace_original",
    source: { kind: "base_attachment", fieldId: "fld_audio" },
  };
  assert.equal(
    phasedStageContract.assertPhasedAttachmentBindings(validateSubjectConfig(stringTypedAttachment)),
    true,
    "type:'17' without uiType remains accepted",
  );
});

test("rejects metadata whose numeric type conflicts with its uiType", () => {
  const statusConflict = subject();
  const statusField = statusConflict.metadata.fields.find((field) => field.fieldId === "fld_status");
  statusField.uiType = "MultiSelect";
  assert.throws(
    () => validateSubjectConfig(statusConflict),
    (error) => error?.code === "FIELD_TYPE_INVALID",
    "type:3 with uiType:MultiSelect",
  );

  const attachmentConflict = subject();
  const audioField = attachmentConflict.metadata.fields.find((field) => field.fieldId === "fld_audio");
  audioField.uiType = "Text";
  attachmentConflict.stages.initial.audio = {
    mode: "replace_original",
    source: { kind: "base_attachment", fieldId: "fld_audio" },
  };
  assert.throws(
    () => phasedStageContract.assertPhasedAttachmentBindings(validateSubjectConfig(attachmentConflict)),
    (error) => error?.code === "FIELD_TYPE_INVALID",
    "type:17 with uiType:Text",
  );
});

test("normalizes every supported snake_case stage alias to camelCase", () => {
  const normalized = normalizeStage({
    enabled: true,
    trigger: {
      field_id: "fld_status",
      field_name: "流程",
      option_id: "opt_initial",
      start_value: "初稿",
    },
    video_source: { kind: "docx_section", anchor_text: " 录屏 " },
    review_source: { kind: "docx_section", anchor_text: " 修改意见 " },
    audio: {
      mode: "replace_original",
      source: { kind: "base_attachment", field_id: "fld_audio" },
      duration_tolerance_seconds: 1.5,
    },
    artifact_target_path: "C:\\approved\\initial",
    name_suffix: "_初稿",
  }, metadata(), "initial");

  assert.deepEqual(normalized, {
    enabled: true,
    trigger: {
      fieldId: "fld_status",
      fieldName: "流程",
      optionId: "opt_initial",
      value: "初稿",
    },
    videoSource: { kind: "docx_section", anchorText: "录屏" },
    reviewSource: { kind: "docx_section", anchorText: "修改意见" },
    audio: {
      mode: "replace_original",
      source: { kind: "base_attachment", fieldId: "fld_audio" },
      durationToleranceSeconds: 1.5,
    },
    artifactTargetPath: "C:\\approved\\initial",
    nameSuffix: "_初稿",
  });
});

test("requires an audio source only when replacing the video's original audio", () => {
  const value = subject();
  value.stages.initial.audio = {
    mode: "replace_original",
    source: null,
    durationToleranceSeconds: 3,
  };
  assert.throws(() => validateSubjectConfig(value), /audio source is required/i);

  value.stages.initial.audio = { mode: "video_original" };
  assert.equal(validateSubjectConfig(value).stages.initial.audio.mode, "video_original");
});

test("normalizes Docx and Base attachment replacement audio without changing the wire model", () => {
  const docx = subject();
  docx.stages.initial.audio = {
    mode: "replace_original",
    source: { kind: "docx_section", anchorText: " 配音 " },
    durationToleranceSeconds: 1.5,
  };
  assert.deepEqual(validateSubjectConfig(docx).stages.initial.audio, {
    mode: "replace_original",
    source: { kind: "docx_section", anchorText: "配音" },
    durationToleranceSeconds: 1.5,
  });

  const attachment = subject();
  attachment.stages.initial.audio = {
    mode: "replace_original",
    source: { kind: "base_attachment", fieldId: "fld_audio" },
  };
  assert.deepEqual(validateSubjectConfig(attachment).stages.initial.audio, {
    mode: "replace_original",
    source: { kind: "base_attachment", fieldId: "fld_audio" },
    durationToleranceSeconds: 3,
  });
});

test("rejects malformed replacement audio and strips inactive video-original properties", () => {
  const invalidCases = [
    {
      audio: { mode: "replace_original", source: { kind: "docx_section", anchorText: "   " } },
      pattern: /anchorText is invalid/i,
    },
    {
      audio: { mode: "replace_original", source: { kind: "base_attachment", fieldId: "" } },
      pattern: /fieldId is required/i,
    },
    {
      audio: { mode: "unsupported" },
      pattern: /mode is invalid/i,
    },
    {
      audio: { mode: "replace_original", source: { kind: "unsupported" } },
      pattern: /kind is invalid/i,
    },
  ];
  for (const { audio, pattern } of invalidCases) {
    const value = subject();
    value.stages.initial.audio = audio;
    assert.throws(() => validateSubjectConfig(value), pattern);
  }

  for (const tolerance of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const value = subject();
    value.stages.initial.audio = {
      mode: "replace_original",
      source: { kind: "docx_section", anchorText: "配音" },
      durationToleranceSeconds: tolerance,
    };
    assert.throws(
      () => validateSubjectConfig(value),
      /durationToleranceSeconds must be positive/i,
    );
  }

  const original = subject();
  original.stages.initial.audio = {
    mode: "video_original",
    source: { kind: "base_attachment", fieldId: "fld_stale" },
    duration_tolerance_seconds: -1,
  };
  assert.deepEqual(validateSubjectConfig(original).stages.initial.audio, { mode: "video_original" });
});

test("keeps stale attachment bindings structurally but rejects them at the strict metadata boundary", () => {
  assert.equal(typeof phasedStageContract.assertPhasedAttachmentBindings, "function");

  const missing = subject();
  missing.stages.initial.videoSource = { kind: "base_attachment", fieldId: "fld_missing" };
  const normalizedMissing = validateSubjectConfig(missing);
  assert.equal(normalizedMissing.stages.initial.videoSource.fieldId, "fld_missing");
  assert.throws(
    () => phasedStageContract.assertPhasedAttachmentBindings(normalizedMissing),
    (error) => error.code === "FIELD_NOT_FOUND"
      && error.path === "stages.initial.videoSource.fieldId",
  );

  const wrongType = subject();
  wrongType.stages.initial.audio = {
    mode: "replace_original",
    source: { kind: "base_attachment", fieldId: "fld_text" },
  };
  const normalizedWrongType = validateSubjectConfig(wrongType);
  assert.equal(normalizedWrongType.stages.initial.audio.source.fieldId, "fld_text");
  assert.throws(
    () => phasedStageContract.assertPhasedAttachmentBindings(normalizedWrongType),
    (error) => error.code === "FIELD_TYPE_INVALID"
      && error.path === "stages.initial.audio.source.fieldId",
  );

  const knownEmpty = subject();
  knownEmpty.metadata = { fields: [] };
  knownEmpty.stages.initial.audio = {
    mode: "replace_original",
    source: { kind: "base_attachment", fieldId: "fld_audio" },
  };
  assert.throws(
    () => phasedStageContract.assertPhasedAttachmentBindings(knownEmpty),
    (error) => error.code === "FIELD_NOT_FOUND"
      && error.path === "stages.initial.audio.source.fieldId",
  );

  const stringTypedAttachment = subject();
  const audioField = stringTypedAttachment.metadata.fields.find((field) => field.fieldId === "fld_audio");
  audioField.type = "17";
  delete audioField.uiType;
  stringTypedAttachment.stages.initial.audio = {
    mode: "replace_original",
    source: { kind: "base_attachment", fieldId: "fld_audio" },
  };
  assert.equal(
    phasedStageContract.assertPhasedAttachmentBindings(stringTypedAttachment),
    true,
  );
});

test("requires a ZIP destination for every enabled stage in automatic upload mode", () => {
  const value = subject();
  value.lifecycle = "enabled";
  value.upload.enqueueMode = "automatic";
  value.stages.initial.artifactTargetPath = null;
  value.stages.final_review = {
    ...value.stages.final_review,
    enabled: false,
    artifactTargetPath: null,
  };

  assert.throws(
    () => validateSubjectConfig(value),
    /enabled automatic stage 'initial'.*artifactTargetPath/i,
  );

  value.stages.initial.artifactTargetPath = "C:\\approved\\initial";
  const normalized = validateSubjectConfig(value);
  assert.equal(normalized.stages.final_review.enabled, false);
  assert.equal(normalized.stages.final_review.artifactTargetPath, null);
});

test("normalizes a stage against the selected status field metadata", () => {
  const normalized = normalizeStage(stage("initial", "opt_initial", "初稿"), metadata(), "initial");
  assert.equal(normalized.trigger.fieldId, "fld_status");
  assert.equal(normalized.trigger.value, "初稿");
  assert.equal(normalized.audio.mode, "video_original");
});

test("stores and returns a phased subject through the existing workflow store", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-phased-config-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const store = createFeishuWorkflowStore({ database, packageAliases: async () => ["Auto-cut-A"] });
  try {
    await store.upsertBasePreview({
      baseToken: "bas_phase",
      baseName: "阶段 Base",
      tables: [{ tableId: "tbl_subject", tableName: "学科", fields: metadata().fields }],
    });
    const configured = subject();
    const saved = await store.saveSubjectDraft(subjectKey, {
      displayEnabled: configured.displayEnabled,
      statusField: configured.statusField,
      documentField: configured.documentField,
      namingField: configured.namingField,
      stages: configured.stages,
      trigger: configured.trigger,
      title: configured.title,
      execution: configured.execution,
      packageRoute: configured.packageRoute,
      upload: configured.upload,
    });
    assert.equal(saved.stages.final_review.nameSuffix, "_终审修改");
    assert.equal((await store.getSubject(subjectKey)).documentField.fieldId, "fld_document");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
