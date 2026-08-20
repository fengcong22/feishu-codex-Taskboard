import assert from "node:assert/strict";
import test from "node:test";

import { decideRecordChange } from "../src/decide-event.mjs";

const config = {
  tables: [
    {
      tableId: "tbl_a",
      name: "语文项目",
      mode: "manual",
      triggerField: "视频整体进度",
      triggerValue: "待剪辑",
      packageField: "自动剪辑项目包",
    },
    {
      tableId: "tbl_b",
      name: "数学项目",
      mode: "automatic",
      triggerField: "制作进度",
      triggerValue: "待剪辑",
      packageField: "剪辑包",
    },
  ],
  packages: {
    "Auto-cut-copyA": {
      projectId: "auto-cut-copy-a",
      projectName: "Auto-cut-copyA",
      workspacePath: "D:\\trusted\\Auto-cut-copyA",
      prompt: "执行 A 流程。",
    },
    "Auto-cut-math": {
      projectId: "auto-cut-math",
      projectName: "Auto-cut-math",
      workspacePath: "D:\\trusted\\Auto-cut-math",
      prompt: "执行数学流程。",
    },
  },
};

function event(overrides = {}) {
  return {
    eventId: "evt_1",
    baseToken: "bas_demo",
    tableId: "tbl_a",
    recordId: "rec_1",
    recordTitle: "第一课",
    fieldName: "视频整体进度",
    beforeValue: "素材齐全",
    afterValue: "待剪辑",
    fields: { 自动剪辑项目包: "Auto-cut-copyA" },
    ...overrides,
  };
}

test("routes a transition into 待剪辑 through the package whitelist", () => {
  const result = decideRecordChange(config, event());
  assert.equal(result.kind, "ready");
  assert.equal(result.table.mode, "manual");
  assert.equal(result.packageAlias, "Auto-cut-copyA");
  assert.equal(result.packageConfig.workspacePath, "D:\\trusted\\Auto-cut-copyA");
});

test("uses the table-level default package when the package field is not configured", () => {
  const defaultConfig = {
    ...config,
    tables: [{
      ...config.tables[0],
      packageField: null,
      defaultPackageAlias: "Auto-cut-copyA",
    }],
  };
  const result = decideRecordChange(defaultConfig, event({ fields: {} }));
  assert.equal(result.kind, "ready");
  assert.equal(result.packageAlias, "Auto-cut-copyA");
});

test("uses a package field id when its display name is not configured", () => {
  const idConfig = {
    ...config,
    tables: [{
      ...config.tables[0],
      packageField: null,
      packageFieldId: "fld_package",
    }],
  };
  const result = decideRecordChange(idConfig, event({
    fields: {},
    fieldValuesById: { fld_package: "Auto-cut-copyA" },
  }));
  assert.equal(result.kind, "ready");
  assert.equal(result.packageAlias, "Auto-cut-copyA");
  assert.equal(result.packageSource, "record-field");
});

test("matches a configured trigger field id even when the display name is absent", () => {
  const idConfig = {
    ...config,
    tables: [{ ...config.tables[0], triggerFieldId: "fld_trigger" }],
  };
  const result = decideRecordChange(idConfig, event({
    fieldName: "",
    fieldId: "fld_trigger",
  }));
  assert.equal(result.kind, "ready");
});

test("marks a transition away from 待剪辑 for waiting-task archival without a package alias", () => {
  const result = decideRecordChange(config, event({
    beforeValue: "待剪辑",
    afterValue: "剪辑中",
    fields: {},
  }));
  assert.deepEqual(result, {
    kind: "ignored",
    reason: "left_trigger",
    effect: "archive_waiting_tasks",
    table: config.tables[0],
    event: event({
      beforeValue: "待剪辑",
      afterValue: "剪辑中",
      fields: {},
    }),
  });
});

test("uses each table's own trigger and package fields", () => {
  const result = decideRecordChange(config, event({
    tableId: "tbl_b",
    fieldName: "制作进度",
    fields: { 剪辑包: "Auto-cut-math" },
  }));
  assert.equal(result.kind, "ready");
  assert.equal(result.table.mode, "automatic");
  assert.equal(result.packageConfig.projectId, "auto-cut-math");
});

for (const [name, overrides, reason] of [
  ["unknown tables", { tableId: "tbl_unknown" }, "unknown_table"],
  ["other fields", { fieldName: "备注" }, "unrelated_field"],
  ["non-trigger values", { afterValue: "剪辑中" }, "new_value_not_trigger"],
  ["unchanged trigger values", { beforeValue: "待剪辑" }, "already_at_trigger"],
]) {
  test(`ignores ${name}`, () => {
    assert.deepEqual(decideRecordChange(config, event(overrides)), { kind: "ignored", reason });
  });
}

test("blocks a missing package alias", () => {
  const result = decideRecordChange(config, event({ fields: {} }));
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "missing_package_alias");
});

test("blocks an unknown package alias instead of treating it as a path", () => {
  const result = decideRecordChange(config, event({
    fields: { 自动剪辑项目包: "D:\\untrusted\\run-me.ps1" },
  }));
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "unknown_package_alias");
  assert.equal(result.packageConfig, undefined);
});

test("blocks package aliases inherited from the package map prototype", () => {
  const result = decideRecordChange(config, event({
    fields: { 自动剪辑项目包: "toString" },
  }));
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "unknown_package_alias");
  assert.equal(result.packageConfig, undefined);
});
