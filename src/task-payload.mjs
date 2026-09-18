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
  const simulated = decision.event?.deliverySource === "simulation";
  const executionMode = simulated
    ? "manual"
    : decision.executionMode ?? decision.table.executionMode ?? decision.table.mode;
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
    mode: simulated ? "manual" : decision.table.mode,
    ...(simulated ? { deliverySource: "simulation" } : {}),
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
  const executionMode = decision.event?.deliverySource === "simulation"
    ? "manual"
    : decision.executionMode ?? decision.table.executionMode ?? decision.table.mode;
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
      `- 启动方式：${executionMode === "manual" ? "手动点击启动" : "自动模式（MVP 暂按手动启动）"}`,
      "",
      "点击任务中的“启动 Codex”后，Codex 将在服务器白名单映射的项目目录内执行预设流程。",
      "",
      metadataMarker(metadata(decision)),
    ].join("\n"),
    status: "todo",
    priority: "high",
    labels: ["feishu", "待剪辑", executionMode, decision.packageAlias],
    assigneeTarget: "current-user",
  };
}

function safeContext(context) {
  const input = context && typeof context === "object" && !Array.isArray(context) ? context : {};
  const links = Array.isArray(input.documentLinks)
    ? input.documentLinks.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean).slice(0, 16)
    : [];
  const courseName = typeof input.courseName === "string" ? input.courseName.trim() : "";
  const safeCourseName = courseName !== ""
    && courseName.length <= 180
    && !/[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(courseName)
    && courseName !== "."
    && courseName !== ".."
    && !/[. ]$/u.test(courseName)
    ? courseName
    : null;
  return {
    documentLinks: links,
    namingDisplayValue: typeof input.namingDisplayValue === "string" ? input.namingDisplayValue.trim().slice(0, 1024) : "",
    namingValueUnique: input.namingValueUnique === true,
    courseName: safeCourseName ?? "",
  };
}

/**
 * Build the narrow body accepted by Taskboard's trusted Feishu registration
 * route.  All executable policy (package, paths, prompt and mode) stays on
 * Taskboard; this object carries only opaque identity and bounded read data.
 */
export function buildTrustedTaskPayload(decision, context = {}) {
  if (!decision || typeof decision !== "object" || !decision.event) {
    throw new Error("decision is required");
  }
  const event = decision.event;
  const subjectKey = decision.subjectKey
    ?? decision.subject?.subjectKey
    ?? `${event.baseToken}:${event.tableId}`;
  const configVersion = decision.configVersion ?? decision.subject?.configVersion;
  if (!Number.isSafeInteger(configVersion) || configVersion < 1) {
    const error = new Error("configVersion is required");
    error.code = "MISSING_ACTIVE_CONFIG_VERSION";
    throw error;
  }
  if (typeof decision.stageId !== "string" || decision.stageId.trim() === "") {
    throw new Error("stageId is required");
  }
  return {
    event: {
      eventId: String(event.eventId ?? "").trim(),
      baseToken: String(event.baseToken ?? "").trim(),
      tableId: String(event.tableId ?? "").trim(),
      recordId: String(event.recordId ?? "").trim(),
      statusFieldId: String(event.statusFieldId ?? decision.table?.statusField?.fieldId ?? decision.table?.triggerFieldId ?? "").trim(),
      beforeOptionId: String(event.beforeOptionId ?? "").trim(),
      afterOptionId: String(event.afterOptionId ?? "").trim(),
      ...(event.deliverySource === "simulation" ? { deliverySource: "simulation" } : {}),
      ...(event.eventOccurredAtPresent && Number.isFinite(event.eventOccurredAt)
        ? { occurredAt: event.eventOccurredAt }
        : Number.isFinite(event.eventOccurredAt) ? { occurredAt: event.eventOccurredAt } : {}),
    },
    binding: {
      subjectKey: String(subjectKey).trim(),
      configVersion,
      stageId: decision.stageId.trim(),
    },
    controlledContext: safeContext(context),
  };
}
