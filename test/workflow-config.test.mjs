import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGE_IDS,
  normalizeStage,
  portableSubject,
  validateSubjectConfig,
} from "../src/workflow-config.mjs";
import { createWorkflowConfigStore } from "../src/workflow-config-store.mjs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configuredTables } from "../src/decide-event.mjs";

function validSubject(overrides = {}) {
  return {
    subjectKey: "bas_demo:tbl_math",
    baseToken: "bas_demo",
    tableId: "tbl_math",
    tableName: "数学",
    statusField: {
      fieldId: "fld_status",
      fieldName: "制作进度",
      type: "single_select",
      options: [
        { optionId: "opt_other", value: "待准备" },
        { optionId: "opt_initial", value: "待初稿" },
        { optionId: "opt_first", value: "待初审修改" },
        { optionId: "opt_final", value: "待终审修改" },
      ],
    },
    documentField: { fieldId: "fld_document", fieldName: "集合文档", kind: "docx" },
    namingField: { fieldId: "fld_name", fieldName: "命名", kind: "text" },
    stages: {
      initial: {
        enabled: true,
        trigger: { fieldId: "fld_status", optionId: "opt_initial", value: "待初稿" },
        videoSource: { kind: "docx_section", anchorText: "录屏" },
        reviewSource: { kind: "docx_section", anchorText: "修改意见" },
        audio: { mode: "video_original" },
        artifactTargetPath: "D:\\Approved\\Initial",
        nameSuffix: "_初稿",
      },
      first_review: {
        enabled: true,
        trigger: { fieldId: "fld_status", optionId: "opt_first", value: "待初审修改" },
        videoSource: { kind: "docx_section", anchorText: "初审视频" },
        reviewSource: { kind: "docx_section", anchorText: "初审意见" },
        audio: { mode: "replace_original", source: { kind: "base_attachment", fieldId: "fld_audio" } },
        artifactTargetPath: "D:\\Approved\\First",
        nameSuffix: "_初审修改",
      },
      final_review: {
        enabled: false,
        trigger: { fieldId: "fld_status", optionId: "opt_final", value: "待终审修改" },
        videoSource: { kind: "base_attachment", fieldId: "fld_video" },
        reviewSource: { kind: "docx_section", anchorText: "终审意见" },
        audio: { mode: "video_original" },
        artifactTargetPath: "D:\\Approved\\Final",
        nameSuffix: "_终审修改",
      },
    },
    execution: { mode: "automatic", enqueueMode: "automatic", maxConcurrent: 1 },
    packageRoute: { packageAlias: "Auto-cut-lite" },
    upload: { enqueueMode: "automatic", targetId: "target-1", targetPath: "D:\\Uploads" },
    ...overrides,
  };
}

test("normalizes fixed stages and rejects duplicate enabled option ids", () => {
  const subject = validateSubjectConfig(validSubject());
  assert.deepEqual(Object.keys(subject.stages), STAGE_IDS);
  assert.equal(subject.stages.initial.trigger.optionId, "opt_initial");
  const duplicate = structuredClone(validSubject());
  duplicate.stages.final_review.enabled = true;
  duplicate.stages.final_review.trigger = structuredClone(duplicate.stages.initial.trigger);
  assert.throws(() => validateSubjectConfig(duplicate), /enabled stage trigger options must be unique/);
});

test("requires a source only for replace_original and strips local paths from portable subject", () => {
  const subject = validSubject();
  subject.stages.initial.audio = { mode: "replace_original", source: null };
  assert.throws(() => validateSubjectConfig(subject), /audio source is required/);
  subject.stages.initial.audio = { mode: "video_original", source: { kind: "base_attachment", fieldId: "bad" } };
  const normalized = validateSubjectConfig(subject);
  assert.equal(normalized.stages.initial.audio.mode, "video_original");
  const portable = portableSubject(validSubject());
  assert.equal(portable.stages.initial.artifactTargetPath, undefined);
  assert.equal(portable.upload.targetPath, undefined);
});

test("rejects stale options and mismatched trigger field ids", () => {
  const stale = validSubject();
  stale.stages.initial.trigger.optionId = "opt_missing";
  assert.throws(() => validateSubjectConfig(stale), /optionId/);
  const mismatched = validSubject();
  mismatched.stages.initial.trigger.fieldId = "fld_other";
  assert.throws(() => validateSubjectConfig(mismatched), /statusField/);
});

test("sync enforces the expected version and stores a portable subject snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-workflow-store-"));
  const store = createWorkflowConfigStore({ filename: path.join(directory, "workflow.json") });
  await store.syncSubject({ ...validSubject(), lifecycle: "enabled", configVersion: 1, enabledAt: 1000 }, { lifecycle: "enabled", expectedVersion: 0 });
  await assert.rejects(
    () => store.syncSubject({ ...validSubject(), lifecycle: "enabled", configVersion: 2, enabledAt: 2000 }, { lifecycle: "enabled", expectedVersion: 99 }),
    (error) => error?.code === "VERSION_CONFLICT" && error?.status === 409,
  );
  const snapshot = await store.getSubjectVersion("bas_demo:tbl_math", 1);
  assert.equal(snapshot.stages.initial.artifactTargetPath, undefined);
  assert.equal(snapshot.upload.targetPath, undefined);
});

test("keeps legacy tables active alongside synchronized phased subjects", () => {
  const legacy = {
    tableId: "tbl_legacy",
    name: "旧表",
    mode: "manual",
    triggerField: "状态",
    triggerValue: "待剪辑",
    defaultPackageAlias: "Auto-cut-copyA",
  };
  const tables = configuredTables({
    tables: [legacy],
    workflow: {
      bases: [{
        baseToken: "bas_demo",
        subjects: [{
          ...validSubject(),
          lifecycle: "enabled",
          subjectKey: "bas_demo:tbl_math",
        }],
      }],
    },
  });
  assert.equal(tables.some((entry) => entry.tableId === "tbl_legacy"), true);
  assert.equal(tables.some((entry) => entry.tableId === "tbl_math"), true);
});
