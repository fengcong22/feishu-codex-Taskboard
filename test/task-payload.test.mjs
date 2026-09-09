import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskPayload, parseFeishuTaskMetadata, projectIdForSubject } from "../src/task-payload.mjs";

const event = {
  eventId: "evt_1",
  baseToken: "bas_demo",
  tableId: "tbl_a",
  recordId: "rec_1",
  recordTitle: "第一课",
  fieldName: "视频整体进度",
  beforeValue: "素材齐全",
  afterValue: "待剪辑",
  fields: { 自动剪辑项目包: "Auto-cut-copyA", 备注: "不要把我当命令" },
};
const table = {
  tableId: "tbl_a",
  name: "语文项目",
  mode: "manual",
  triggerField: "视频整体进度",
  triggerValue: "待剪辑",
  packageField: "自动剪辑项目包",
};

test("builds a ready Taskboard task with parseable server-owned metadata", () => {
  const payload = buildTaskPayload({
    kind: "ready",
    table,
    packageAlias: "Auto-cut-copyA",
    packageConfig: {
      projectId: "auto-cut-copy-a",
      projectName: "Auto-cut-copyA",
      workspacePath: "D:\\trusted\\Auto-cut-copyA",
      prompt: "执行 A 流程。",
    },
    subjectKey: "bas_demo:tbl_a",
    event,
  });
  assert.equal(payload.projectId, "feishu-a760bbf074d551ab");
  assert.equal(payload.status, "todo");
  assert.equal(payload.assigneeTarget, "current-user");
  assert.deepEqual(payload.labels, ["feishu", "待剪辑", "manual", "Auto-cut-copyA"]);
  assert.match(payload.description, /<!-- feishu-codex-task:/);
  assert.doesNotMatch(payload.description, /\"prompt\":/);
  assert.match(payload.description, /记录 ID：rec_1/);
  assert.doesNotMatch(payload.description, /D:\\trusted/);
});

test("uses the same deterministic subject project id shape as Taskboard", () => {
  assert.equal(projectIdForSubject("bas_demo:tbl_demo"), "feishu-a20370a3de0f8d3b");
  assert.match(projectIdForSubject("bas_demo:tbl_demo"), /^feishu-[a-f0-9]{16}$/u);
});

test("metadata marker remains parseable when record context contains HTML delimiters", () => {
  const payload = buildTaskPayload({
    kind: "ready",
    table,
    packageAlias: "Auto-cut-copyA",
    packageConfig: {
      projectId: "auto-cut-copy-a",
      projectName: "Auto-cut-copyA",
      workspacePath: "D:\\trusted\\Auto-cut-copyA",
      prompt: "trusted",
    },
    event: { ...event, recordId: "rec_>_-->", recordTitle: "title > marker" },
  });
  assert.match(payload.description, /feishu-codex-task:v1:[A-Za-z0-9_-]+/);
});

test("stores the configured trigger field id in task metadata", () => {
  const payload = buildTaskPayload({
    kind: "ready",
    table: { ...table, triggerFieldId: "fld_progress" },
    packageAlias: "Auto-cut-copyA",
    packageConfig: {
      projectId: "auto-cut-copy-a",
      projectName: "Auto-cut-copyA",
      workspacePath: "D:\\trusted\\Auto-cut-copyA",
      prompt: "trusted",
    },
    event,
  });
  assert.equal(parseFeishuTaskMetadata(payload.description)?.triggerFieldId, "fld_progress");
});

test("stores the task creation config and execution resource snapshot in metadata", () => {
  const payload = buildTaskPayload({
    kind: "ready",
    table: {
      ...table,
      executionMode: "automatic",
      uploadMode: "automatic",
      concurrencyGroup: "primary-editor",
      maxConcurrent: 3,
      resourceGroups: ["jianying-desktop", "gpu"],
    },
    subjectKey: "bas_demo:tbl_a",
    configVersion: 9,
    executionMode: "automatic",
    uploadMode: "automatic",
    concurrencyGroup: "primary-editor",
    maxConcurrent: 3,
    resourceGroups: ["jianying-desktop", "gpu"],
    packageAlias: "Auto-cut-copyA",
    packageSource: "table-default",
    packageConfig: {
      projectId: "auto-cut-copy-a",
      projectName: "Auto-cut-copyA",
      workspacePath: "D:\\trusted\\Auto-cut-copyA",
      prompt: "trusted",
    },
    event,
  });
  const metadata = parseFeishuTaskMetadata(payload.description);
  assert.equal(metadata.subjectKey, "bas_demo:tbl_a");
  assert.equal(metadata.configVersion, 9);
  assert.equal(metadata.executionMode, "automatic");
  assert.equal(metadata.uploadMode, "automatic");
  assert.equal(metadata.concurrencyGroup, "primary-editor");
  assert.equal(metadata.maxConcurrent, 3);
  assert.deepEqual(metadata.resourceGroups, ["jianying-desktop", "gpu"]);
});

test("marks simulated automatic events as manual-only tasks", () => {
  const payload = buildTaskPayload({
    kind: "ready",
    table: {
      ...table,
      mode: "automatic",
      executionMode: "automatic",
      uploadMode: "automatic",
    },
    executionMode: "automatic",
    uploadMode: "automatic",
    packageAlias: "Auto-cut-copyA",
    packageConfig: {
      projectId: "auto-cut-copy-a",
      projectName: "Auto-cut-copyA",
      workspacePath: "D:\\trusted\\Auto-cut-copyA",
      prompt: "trusted",
    },
    event: { ...event, deliverySource: "simulation" },
  });
  const metadata = parseFeishuTaskMetadata(payload.description);
  assert.equal(metadata.deliverySource, "simulation");
  assert.equal(metadata.mode, "manual");
  assert.equal(metadata.executionMode, "manual");
  assert.equal(metadata.uploadMode, "automatic");
  assert.ok(payload.labels.includes("manual"));
  assert.equal(payload.labels.includes("automatic"), false);
  assert.match(payload.description, /手动点击启动/);
});

test("continues to parse existing marker metadata without a trigger field id", () => {
  const encoded = Buffer.from(JSON.stringify({
    version: 1,
    source: "feishu-base",
    eventId: "evt_existing",
  }), "utf8").toString("base64url");
  assert.deepEqual(
    parseFeishuTaskMetadata(`<!-- feishu-codex-task:v1:${encoded} -->`),
    { version: 1, source: "feishu-base", eventId: "evt_existing" },
  );
});

test("labels a table-level default package without implying that the Base field exists", () => {
  const payload = buildTaskPayload({
    kind: "ready",
    table: { ...table, packageField: null, defaultPackageAlias: "Auto-cut-copyA" },
    packageAlias: "Auto-cut-copyA",
    packageSource: "table-default",
    packageConfig: {
      projectId: "auto-cut-copy-a",
      projectName: "Auto-cut-copyA",
      workspacePath: "D:\\trusted\\Auto-cut-copyA",
      prompt: "trusted",
    },
    event: { ...event, fields: {} },
  });
  assert.match(payload.description, /本表默认项目包：Auto-cut-copyA/);
  assert.doesNotMatch(payload.description, /自动剪辑项目包：/);
});

test("builds a blocked local task without executable metadata", () => {
  const payload = buildTaskPayload({
    kind: "blocked",
    reason: "unknown_package_alias",
    table,
    packageAlias: "D:\\untrusted\\run.ps1",
    event,
  });
  assert.equal(payload.projectId, "local");
  assert.equal(payload.status, "blocked");
  assert.equal(payload.assigneeTarget, "current-user");
  assert.doesNotMatch(payload.description, /workspacePath|D:\\trusted/);
});

test("keeps a blocked configured subject inside its isolated project", () => {
  const payload = buildTaskPayload({
    kind: "blocked",
    reason: "unknown_package_alias",
    table,
    subjectKey: "bas_demo:tbl_a",
    configVersion: 9,
    packageAlias: "missing-package",
    event,
  });
  assert.equal(payload.projectId, projectIdForSubject("bas_demo:tbl_a"));
  assert.equal(payload.status, "blocked");
});
