import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { validateConfig } from "../src/config.mjs";

function validConfig() {
  return {
    host: "127.0.0.1",
    port: 47824,
    taskboardUrl: "http://127.0.0.1:47823",
    stateFile: path.resolve(".runtime/bridge/state.json"),
    tables: [{
      tableId: "tbl_demo",
      name: "演示表",
      mode: "manual",
      triggerField: "视频整体进度",
      triggerValue: "待剪辑",
      packageField: "自动剪辑项目包",
      titleField: "视频名称",
      titleFieldId: "fld_title",
      fallbackTitleField: "集合文档",
      fallbackTitleFieldId: "fld_collection",
    }],
    packages: {
      "Auto-cut-copyA": {
        projectId: "auto-cut-copy-a",
        projectName: "Auto-cut-copyA",
        workspacePath: path.resolve("examples/harmless-auto-cut"),
        prompt: "执行安全的演示任务。",
      },
    },
  };
}

test("accepts a loopback, per-table, alias-only configuration", () => {
  const result = validateConfig(validConfig());
  assert.deepEqual(result.delivery, {
    maxAttempts: 8,
    initialDelayMs: 5_000,
    maxDelayMs: 300_000,
    leaseMs: 30_000,
    pollIntervalMs: 1_000,
  });
  assert.equal(result.tables[0].triggerValue, "待剪辑");
  assert.equal(result.tables[0].titleField, "视频名称");
  assert.equal(result.tables[0].titleFieldId, "fld_title");
  assert.equal(result.tables[0].fallbackTitleField, "集合文档");
  assert.equal(result.tables[0].fallbackTitleFieldId, "fld_collection");
  assert.equal(result.packages["Auto-cut-copyA"].projectId, "auto-cut-copy-a");
  assert.equal(result.packages["Auto-cut-copyA"].prompt, "执行安全的演示任务。");
});

test("accepts a valid delivery policy override", () => {
  const input = validConfig();
  input.delivery = {
    maxAttempts: 3,
    initialDelayMs: 200,
    maxDelayMs: 2_000,
    leaseMs: 1_500,
    pollIntervalMs: 250,
    ignored: "not returned",
  };
  assert.deepEqual(validateConfig(input).delivery, {
    maxAttempts: 3,
    initialDelayMs: 200,
    maxDelayMs: 2_000,
    leaseMs: 1_500,
    pollIntervalMs: 250,
  });
});

test("rejects a delivery policy poll interval below 100 milliseconds", () => {
  const input = validConfig();
  input.delivery = { pollIntervalMs: 99 };
  assert.throws(() => validateConfig(input), /delivery\.pollIntervalMs must be an integer >= 100/);
});

test("rejects delivery policies whose maximum delay is below the initial delay", () => {
  const input = validConfig();
  input.delivery = { initialDelayMs: 2_000, maxDelayMs: 1_000 };
  assert.throws(() => validateConfig(input), /delivery\.maxDelayMs must be >= delivery\.initialDelayMs/);
});

test("accepts a real table with a field-id trigger and a table-level default package", () => {
  const input = validConfig();
  input.tables[0] = {
    baseToken: "IQWTbOrdwa8GLgsXF3OcLwoUnqe",
    tableId: "tbl0hb8d1LgVWShb",
    name: "高中历史",
    mode: "manual",
    triggerField: "视频整体进度",
    triggerFieldId: "fld2QXgFUT",
    triggerValue: "待剪辑",
    triggerOptionId: "optuPdmxng",
    titleField: "视频名称",
    titleFieldId: "fldHoU4xyR",
    fallbackTitleField: "集合文档",
    fallbackTitleFieldId: "fldyganryv",
    packageField: null,
    packageFieldId: null,
    defaultPackageAlias: "Auto-cut-copyA",
  };
  const result = validateConfig(input);
  assert.equal(result.tables[0].baseToken, "IQWTbOrdwa8GLgsXF3OcLwoUnqe");
  assert.equal(result.tables[0].titleFieldId, "fldHoU4xyR");
  assert.equal(result.tables[0].fallbackTitleFieldId, "fldyganryv");
  assert.equal(result.tables[0].packageField, null);
  assert.equal(result.tables[0].defaultPackageAlias, "Auto-cut-copyA");
});

test("rejects a non-loopback listener", () => {
  const input = validConfig();
  input.host = "0.0.0.0";
  assert.throws(() => validateConfig(input), /host must be 127\.0\.0\.1/);
});

test("rejects duplicate table ids", () => {
  const input = validConfig();
  input.tables.push({ ...input.tables[0] });
  assert.throws(() => validateConfig(input), /duplicate tableId/);
});

test("rejects unsupported table modes", () => {
  const input = validConfig();
  input.tables[0].mode = "sometimes";
  assert.throws(() => validateConfig(input), /mode must be manual or automatic/);
});

test("rejects relative trusted workspace paths", () => {
  const input = validConfig();
  input.packages["Auto-cut-copyA"].workspacePath = "Auto-cut-copyA";
  assert.throws(() => validateConfig(input), /workspacePath must be absolute/);
});

test("rejects duplicate package project ids", () => {
  const input = validConfig();
  input.packages["Auto-cut-copyB"] = {
    ...input.packages["Auto-cut-copyA"],
    projectName: "Auto-cut-copyB",
  };
  assert.throws(() => validateConfig(input), /duplicate package projectId/);
});

test("accepts a phased table using the Taskboard execution and upload schema", () => {
  const input = validConfig();
  input.tables = [{
    subjectKey: "bas_demo:tbl_demo",
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    tableName: "演示表",
    statusField: {
      fieldId: "fld_status",
      fieldName: "制作进度",
      type: 3,
      options: [
        { id: "opt_initial", name: "待初稿" },
        { id: "opt_first", name: "待初审修改" },
      ],
    },
    documentField: { fieldId: "fld_document", fieldName: "集合文档" },
    namingField: { fieldId: "fld_name", fieldName: "命名" },
    stages: {
      initial: {
        enabled: true,
        trigger: { fieldId: "fld_status", optionId: "opt_initial", value: "待初稿", fieldName: "制作进度" },
        videoSource: { kind: "docx_section", anchorText: "录屏" },
        reviewSource: { kind: "docx_section", anchorText: "修改意见" },
        audio: { mode: "video_original" },
        artifactTargetPath: "D:\\approved\\initial",
        nameSuffix: "_初稿",
      },
      first_review: {
        enabled: true,
        trigger: { fieldId: "fld_status", optionId: "opt_first", value: "待初审修改", fieldName: "制作进度" },
        videoSource: { kind: "docx_section", anchorText: "初审视频" },
        reviewSource: { kind: "docx_section", anchorText: "初审意见" },
        audio: { mode: "video_original" },
        artifactTargetPath: "D:\\approved\\first",
        nameSuffix: "_初审修改",
      },
      final_review: {
        enabled: false,
        trigger: { fieldId: "fld_status", optionId: "opt_final", value: "待终审修改", fieldName: "制作进度" },
        videoSource: { kind: "docx_section", anchorText: "终审视频" },
        reviewSource: { kind: "docx_section", anchorText: "终审意见" },
        audio: { mode: "video_original" },
        artifactTargetPath: "D:\\approved\\final",
        nameSuffix: "_终审修改",
      },
    },
    execution: {
      mode: "automatic",
      concurrencyGroup: "autocut",
      maxConcurrent: 1,
      resourceGroups: ["jianying"],
    },
    packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-copyA" },
    upload: {
      enqueueMode: "automatic",
      artifactSourceMode: "driver_report",
      artifactSourcePath: null,
      targetId: "nas-main",
      targetPath: "D:\\uploads",
      uploadConcurrency: 2,
    },
  }];
  const result = validateConfig(input);
  assert.equal(result.tables[0].statusField.type, "single_select");
  assert.equal(result.tables[0].execution.concurrencyGroup, "autocut");
  assert.deepEqual(result.tables[0].execution.resourceGroups, ["jianying"]);
  assert.equal(result.tables[0].upload.artifactSourceMode, "driver_report");
  assert.equal(result.tables[0].upload.uploadConcurrency, 2);
  assert.equal(result.tables[0].stages.initial.trigger.optionId, "opt_initial");
});
