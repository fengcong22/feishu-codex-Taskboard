const CODE = /^[A-Za-z][A-Za-z0-9_]{1,100}$/u;
const SAFE_REASONS = Object.freeze({
  AUTOMATIC_EXECUTION_DISABLED: "本机自动剪辑开关已关闭，任务尚未执行。",
  VM_PMO_CONFIG_CHANGED: "学科配置已变化，和任务登记时冻结的配置不一致。",
  VM_PMO_PACKAGE_CHANGED: "剪辑包身份或版本已变化，流程已暂停。",
  VM_PMO_RECORD_CHANGED: "飞书记录内容已变化，和任务登记时冻结的内容不一致。",
  VM_PMO_RUN_OUTCOME_UNKNOWN: "剪辑进程结果无法确认，需要检查本轮运行记录。",
  VM_PMO_START_NOT_CONFIRMED: "未能确认剪辑进程已正常启动。",
  VM_TASK_BINDING_CONFLICT: "Taskboard 任务与 VM 审批绑定冲突。",
  WORD_ALIGNMENT_UNRESOLVED: "语音识别词条无法与素材准确匹配，需要人工规划处理。",
  document_link_missing: "没有取得有效的素材文档链接。",
  document_link_ambiguous: "素材文档链接不唯一，无法确定本次剪辑来源。",
  docx_anchor_missing: "素材文档中没有找到当前流程要求的内容章节。",
  naming_value_missing: "飞书记录中的课程命名字段为空。",
  naming_value_not_unique: "课程命名字段无法确定唯一值。",
  autocut_artifact_missing: "剪辑结果文件缺失，尚未完成交付。",
  autocut_result_invalid: "剪辑结果未通过校验，尚未完成交付。",
  autocut_process_failed: "剪辑程序执行失败，请查看任务运行记录。",
});

function fallbackSubject(origin) {
  return typeof origin?.subjectKey === "string" ? origin.subjectKey : "未命名学科";
}

function reasonFor(errorCode) {
  if (typeof errorCode !== "string" || !CODE.test(errorCode)) return null;
  return SAFE_REASONS[errorCode] ?? `流程错误码 ${errorCode}，请在 Taskboard 任务详情查看处理建议。`;
}

function trustedOrigin(origin) {
  return origin?.source === "feishu-base" && origin.deliverySource === undefined
    && typeof origin.eventId === "string" && origin.eventId.length > 0
    && typeof origin.subjectKey === "string" && typeof origin.recordId === "string";
}

export function describeBlockedFeishuTask({ task, transition, origin, subject, latestRun } = {}) {
  if (!task || task.status !== "blocked" || !Number.isSafeInteger(transition?.activityId)
    || transition.after !== "blocked" || transition.before === "blocked" || !trustedOrigin(origin)) return null;
  const runReason = latestRun?.state === "blocked" ? reasonFor(latestRun.errorCode) : null;
  return {
    eventKey: `task:${task.id}:activity:${transition.activityId}`,
    subject: typeof subject?.tableName === "string" && subject.tableName.trim() ? subject.tableName.trim() : fallbackSubject(origin),
    taskId: task.identifier ?? task.id,
    taskTitle: task.title,
    recordId: origin.recordId,
    stage: origin.stageId ?? origin.triggerField ?? "workflow",
    status: "blocked",
    occurredAt: transition.createdAt,
    reason: runReason ?? "该任务已标记为遇到阻碍，请查看 Taskboard 中的任务详情和活动记录。",
  };
}

export function describeVmPmoAttention({ run, task, origin, subject } = {}) {
  if (!run || !["blocked", "needs_attention"].includes(run.state) || !task
    || !trustedOrigin(origin) || !Number.isSafeInteger(run.updatedAt)) return null;
  return {
    eventKey: `vm-pmo:${run.runId}:${run.state}:${run.updatedAt}`,
    subject: typeof subject?.tableName === "string" && subject.tableName.trim() ? subject.tableName.trim() : fallbackSubject(origin),
    taskId: task.identifier ?? task.id,
    taskTitle: task.title,
    recordId: origin.recordId,
    stage: origin.stageId ?? "workflow",
    status: run.state,
    occurredAt: new Date(run.updatedAt).toISOString(),
    reason: reasonFor(run.errorCode) ?? (typeof run.errorCode === "string" && CODE.test(run.errorCode)
      ? `流程错误码 ${run.errorCode}，请在 Taskboard 任务详情查看处理建议。`
      : "流程进入需要处理状态，请在 Taskboard 任务详情查看处理建议。"),
  };
}
