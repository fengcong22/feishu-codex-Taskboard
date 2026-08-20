import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskPayload, parseFeishuTaskMetadata } from "../src/task-payload.mjs";

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
    event,
  });
  assert.equal(payload.projectId, "auto-cut-copy-a");
  assert.equal(payload.status, "todo");
  assert.equal(payload.assigneeTarget, "current-user");
  assert.deepEqual(payload.labels, ["feishu", "待剪辑", "manual", "Auto-cut-copyA"]);
  assert.match(payload.description, /<!-- feishu-codex-task:/);
  assert.doesNotMatch(payload.description, /\"prompt\":/);
  assert.match(payload.description, /记录 ID：rec_1/);
  assert.doesNotMatch(payload.description, /D:\\trusted/);
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
