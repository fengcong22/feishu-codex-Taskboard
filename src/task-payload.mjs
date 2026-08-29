import { createHash } from "node:crypto";

const SUBJECT_PROJECT_HASH_LENGTH = 16;

const BLOCKED_REASON_LABELS = {
  missing_package_alias: "记录没有选择自动剪辑项目包",
  unknown_package_alias: "记录选择了未配置的自动剪辑项目包",
};

function text(value) {
  if (value === null || value === undefined || value === "") return "（空）";
  return String(value);
}

/**
 * Project identity belongs to the configured Base/subject, not to whichever
 * Auto-Cut package happens to be selected for the subject.  Hashing keeps
 * tokens out of URLs and project labels while preserving deterministic
 * isolation between two Bases that use the same table id.
 */
export function projectIdForSubject(value, fallback = "local") {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  // Keep this in lockstep with Taskboard's subjectProjectId() helper.  The
  // subject project is the Base/table isolation boundary; package project IDs
  // are only used to resolve the trusted Auto-Cut workspace.
  const digest = createHash("sha256")
    .update(value.trim(), "utf8")
    .digest("hex")
    .slice(0, SUBJECT_PROJECT_HASH_LENGTH);
  return `feishu-${digest}`;
}

function metadata(decision) {
  const executionMode = decision.executionMode ?? decision.table.executionMode ?? decision.table.mode;
  const uploadMode = decision.uploadMode ?? decision.table.uploadMode ?? decision.table.upload?.enqueueMode;
  const concurrencyGroup = decision.concurrencyGroup ?? decision.table.concurrencyGroup ?? decision.table.execution?.concurrencyGroup;
  const maxConcurrent = decision.maxConcurrent ?? decision.table.maxConcurrent ?? decision.table.execution?.maxConcurrent;
  const resourceGroups = decision.resourceGroups ?? decision.table.resourceGroups ?? decision.table.execution?.resourceGroups;
  return {
    version: 1,
    source: "feishu-base",
    eventId: decision.event.eventId,
    baseToken: decision.event.baseToken,
    tableId: decision.event.tableId,
    recordId: decision.event.recordId,
    triggerField: decision.table.triggerField,
    ...(decision.table.triggerFieldId ? { triggerFieldId: decision.table.triggerFieldId } : {}),
    triggerValue: decision.table.triggerValue,
    mode: decision.table.mode,
    subjectKey: decision.subjectKey ?? `${decision.event.baseToken}:${decision.event.tableId}`,
    ...(Number.isInteger(decision.configVersion) ? { configVersion: decision.configVersion } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(uploadMode ? { uploadMode } : {}),
    ...(typeof concurrencyGroup === "string" && concurrencyGroup ? { concurrencyGroup } : {}),
    ...(Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0 ? { maxConcurrent } : {}),
    ...(Array.isArray(resourceGroups) ? { resourceGroups: [...resourceGroups] } : {}),
    ...(decision.packageAlias ? { packageAlias: decision.packageAlias } : {}),
    ...(decision.kind === "ready" && decision.packageSource
      ? { packageSource: decision.packageSource }
      : {}),
  };
}

function metadataMarker(value) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->`;
}

export function parseFeishuTaskMetadata(description) {
  if (typeof description !== "string") return null;
  const match = description.match(/<!--\s*feishu-codex-task:v1:([A-Za-z0-9_-]+)\s*-->/);
  if (!match) return null;
  try {
    const value = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.source !== "feishu-base" || typeof value.eventId !== "string" || !value.eventId) return null;
    return value;
  } catch {
    return null;
  }
}

export function buildTaskPayload(decision) {
  const title = `[待剪辑] ${decision.event.recordTitle || decision.event.recordId}`;
  const transition = `${text(decision.event.beforeValue)} → ${text(decision.event.afterValue)}`;
  if (decision.kind === "blocked") {
    const reason = BLOCKED_REASON_LABELS[decision.reason] ?? decision.reason;
    return {
      projectId: projectIdForSubject(decision.subjectKey, "local"),
      title,
      description: [
        `飞书多维表格「${decision.table.name}」产生了一条待处理记录，但暂时无法启动。`,
        "",
        `- 原因：${reason}`,
        `- 记录 ID：${decision.event.recordId}`,
        `- 字段变化：${decision.table.triggerField}（${transition}）`,
        `- 表格项目包值：${text(decision.packageAlias)}`,
        "",
        metadataMarker(metadata(decision)),
      ].join("\n"),
      status: "blocked",
      priority: "high",
      labels: ["feishu", "待剪辑", "blocked"],
      assigneeTarget: "current-user",
    };
  }

  const packageLine = decision.packageSource === "table-default"
    ? `本表默认项目包：${decision.packageAlias}`
    : `自动剪辑项目包：${decision.packageAlias}`;
  return {
    projectId: projectIdForSubject(decision.subjectKey, decision.packageConfig.projectId),
    title,
    description: [
      `飞书多维表格「${decision.table.name}」中的记录已进入待剪辑状态。`,
      "",
      `- 记录 ID：${decision.event.recordId}`,
      `- 字段变化：${decision.table.triggerField}（${transition}）`,
      `- ${packageLine}`,
      `- 启动方式：${decision.table.mode === "manual" ? "手动点击启动" : "自动模式（MVP 暂按手动启动）"}`,
      "",
      "点击任务中的“启动 Codex”后，Codex 将在服务器白名单映射的项目目录内执行预设流程。",
      "",
      metadataMarker(metadata(decision)),
    ].join("\n"),
    status: "todo",
    priority: "high",
    labels: ["feishu", "待剪辑", decision.table.mode, decision.packageAlias],
    assigneeTarget: "current-user",
  };
}
