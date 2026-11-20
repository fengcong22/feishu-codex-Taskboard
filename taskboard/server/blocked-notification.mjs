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
  AI_INTENT_SCOPE_VIOLATION: "AI 规划改动了受保护的运行文件或越过规划步骤，已在渲染前阻断，需要人工检查后重新登记任务。",
  QA_REVIEW_TIMEOUT: "AI 看图复核超时（最长 15 分钟），成片没有交付。可在任务详情里重新运行复核，成片和质检结果会复用。",
  QA_REVIEW_MISSING: "AI 看图复核没有写出复核结论，成片没有交付。可在任务详情里重新运行复核，成片和质检结果会复用。",
  QA_REVIEW_FAILED: "AI 看图复核会话失败，成片没有交付。可在任务详情里重新运行复核，成片和质检结果会复用。",
  QA_REVIEW_INVALID: "剪辑包拒绝了 AI 的复核结论（报告、帧哈希或问题对不上），成片没有交付。可在任务详情里重新运行复核。",
  QA_REVIEW_BLOCKED: "剪辑包没能合并 AI 看图复核（计划或质检已变化），成片没有交付，需要人工检查运行目录。",
  QA_REVIEW_SCOPE_VIOLATION: "AI 看图复核改动了受保护的成片、质检或帧文件，已阻断交付，需要人工检查后重新登记任务。",
  QA_REVIEW_REQUEST_INVALID: "质检留下了需要看图的画面项，但复核请求或帧文件缺失、不可用，成片没有交付。",
  VM_PMO_QA_REVIEW_DEFECT: "AI 看图复核在成片画面里发现问题（残留、碎片或闪回），成片没有交付；请在审批界面查看具体画面项。",
  VM_REVIEW_IMAGES_UNSUPPORTED: "审核意见附带了截图，但当前剪辑包不支持读取截图，或附件不是图片；没有生成成片。",
  VM_REVIEW_IMAGE_DOWNLOAD_FAILED: "审核截图下载失败，AI 规划没有开始；请检查附件后重新触发。",
  VM_REVIEW_IMAGE_TOO_LARGE: "审核截图超过 20 MB，AI 规划没有开始；请压缩截图后重新触发。",
  VM_REVIEW_IMAGE_CHANGED: "已下载的审核截图被改动或替换，AI 规划没有开始；请重新触发。",
  VM_PMO_AI_SESSION_CHANGED: "本轮登记后 AI 剪辑模型已切换，和本轮冻结的模型不一致；请重新触发以使用新模型。",
  document_link_missing: "没有取得有效的素材文档链接。",
  document_link_ambiguous: "素材文档链接不唯一，无法确定本次剪辑来源。",
  docx_anchor_missing: "素材文档中没有找到当前流程要求的内容章节。",
  naming_value_missing: "飞书记录中的课程命名字段为空。",
  naming_value_not_unique: "课程命名字段无法确定唯一值。",
  autocut_artifact_missing: "剪辑结果文件缺失，尚未完成交付。",
  autocut_result_invalid: "剪辑结果未通过校验，尚未完成交付。",
  autocut_process_failed: "剪辑程序执行失败，请查看任务运行记录。",
});

const DOWNLOAD_FAILURE_REASONS = Object.freeze({
  VM_APPROVAL_REJECTED: "VM 下载申请被驳回。",
  VM_APPROVAL_CANCELED: "VM 下载申请已撤销。",
  VM_APPROVAL_CANCELED_LOCALLY: "VM 下载申请已在本机撤销。",
  VM_APPROVAL_WAIT_EXPIRED: "等待 VM 审批超时。",
  VM_APPROVAL_QUEUE_EXPIRED: "下载申请排队超时，尚未提交审批。",
  VM_MEDIA_WAIT_EXPIRED: "审批已通过，但等待 VM 视频制作完成超时。",
  VM_AUTH_EXPIRED: "Shadow 登录失效超过 2 小时，自动下载已停止。",
  VM_RESOURCE_ALREADY_CLAIMED: "这次审批的视频已被其他任务领取。",
  VM_DOWNLOAD_OUTCOME_UNKNOWN: "下载结果无法确认。",
  VM_MANUAL_SOURCE_MISSING: "人工素材文件夹里没有找到对应的 VMID.mp4。",
  VM_MANUAL_SOURCE_AMBIGUOUS: "人工素材文件夹里有多个同名视频，无法确定使用哪一个。",
  VM_MANUAL_SOURCE_NOT_APPROVED: "这条任务的 VM 申请没有审批通过，不能人工补素材。",
  VM_MANUAL_SOURCE_UNAVAILABLE: "无法读取 VM 下载目录，请检查 VM 下载面板中的保存位置。",
  VM_SOURCE_TOO_LARGE: "人工素材超过大小上限。",
  VM_SOURCE_EMPTY: "人工素材是空文件。",
  MEDIA_VALIDATION_FAILED: "人工素材不是可完整解码的视频。",
  SOURCE_RESOLUTION_MISMATCH: "人工素材分辨率低于 1280x720。",
});

/** Explains why the VM source could not be obtained and what the operator can do next. */
export function describeVmDownloadFailure(run) {
  const failure = run?.downloadFailure;
  if (!failure || typeof failure !== "object") return null;
  const manual = run.manualSource?.state === "failed" ? run.manualSource.reason : null;
  const code = manual ?? failure.reason;
  const known = typeof code === "string" && code.startsWith("SOURCE_RESOLUTION_MISMATCH")
    ? DOWNLOAD_FAILURE_REASONS.SOURCE_RESOLUTION_MISMATCH : DOWNLOAD_FAILURE_REASONS[code];
  const cause = known ?? (typeof code === "string" && CODE.test(code)
    ? `VM 视频下载出错（${code}）。` : "VM 视频下载出错。");
  const vmid = typeof run.binding?.vmid === "string" ? run.binding.vmid : "VMID";
  const next = failure.approved === true
    ? `审批已通过，可以人工从 VM 下载视频，命名为 ${vmid}.mp4，放进 VM 下载目录下的“人工素材”文件夹，再把进度从“下载失败”改为“素材已就绪”。`
    : "审批没有通过，处理后把进度改回初稿触发状态重新开始，系统会重新提交一次 VM 审批。";
  return `${cause}${next}`;
}

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
  const downloadReason = run.errorCode === "VM_DOWNLOAD_FAILED" ? describeVmDownloadFailure(run) : null;
  return {
    eventKey: `vm-pmo:${run.runId}:${run.state}:${run.updatedAt}`,
    subject: typeof subject?.tableName === "string" && subject.tableName.trim() ? subject.tableName.trim() : fallbackSubject(origin),
    taskId: task.identifier ?? task.id,
    taskTitle: task.title,
    recordId: origin.recordId,
    stage: origin.stageId ?? "workflow",
    status: run.state,
    occurredAt: new Date(run.updatedAt).toISOString(),
    reason: downloadReason ?? reasonFor(run.errorCode) ?? (typeof run.errorCode === "string" && CODE.test(run.errorCode)
      ? `流程错误码 ${run.errorCode}，请在 Taskboard 任务详情查看处理建议。`
      : "流程进入需要处理状态，请在 Taskboard 任务详情查看处理建议。"),
  };
}
