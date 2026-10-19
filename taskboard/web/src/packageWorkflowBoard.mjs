export const VM_PACKAGE_COLUMNS = Object.freeze(
  [
    ["todo", "待处理", "Ready"],
    ["materials", "素材准备", "Materials"],
    ["queued", "排队中", "Queued"],
    ["editing", "剪辑中", "Editing"],
    ["feishu_delivery", "回写飞书", "Feishu delivery"],
    ["awaiting_feishu_review", "等待飞书审核", "Awaiting Feishu review"],
    ["nas_upload", "上传 NAS", "NAS upload"],
    ["completed", "已完成", "Completed"],
    ["needs_attention", "需要处理", "Needs attention"],
  ].map(([id, zh, en]) => Object.freeze({ id, zh, en })),
);

export function scopedPackageTasks(tasks, { subjectKey, packageAlias }) {
  return (Array.isArray(tasks) ? tasks : []).filter(
    (task) =>
      task.archivedAt == null &&
      task.feishuOrigin?.source === "feishu-base" &&
      task.feishuOrigin.subjectKey === subjectKey &&
      task.feishuOrigin.packageAlias === packageAlias,
  );
}

export function packageBoardChoices(packages, tasks, activeAlias) {
  const choices = new Map();
  for (const item of packages ?? [])
    choices.set(item.alias, {
      ...item,
      historical: false,
      workflowTemplate: item.workflowTemplate ?? {
        id: "document_draft_zip",
        version: 1,
      },
    });
  for (const task of tasks ?? []) {
    const alias =
      task.feishuOrigin?.source === "feishu-base"
        ? task.feishuOrigin.packageAlias
        : null;
    const template = task.feishuPackageSnapshot?.workflowTemplate;
    if (alias && template && !choices.has(alias))
      choices.set(alias, {
        alias,
        name: alias,
        workflowTemplate: template,
        historical: true,
      });
  }
  if (activeAlias && !choices.has(activeAlias))
    choices.set(activeAlias, {
      alias: activeAlias,
      name: activeAlias,
      historical: true,
      workflowTemplate: null,
    });
  return [...choices.values()];
}

function stageFor(task, evidence) {
  if (!evidence)
    return task.status === "todo"
      ? "todo"
      : task.status === "queued"
        ? "queued"
        : "needs_attention";
  if (["blocked", "needs_attention"].includes(evidence.state))
    return "needs_attention";
  const archive = evidence.archive;
  if (archive && archive.sourceRunId === evidence.runId) {
    if (archive.state === "published") return "completed";
    if (["conflict", "dead_letter"].includes(archive.state))
      return "needs_attention";
    return "nas_upload";
  }
  if (evidence.state === "waiting_materials")
    return ["auth_required", "needs_attention", "dead_letter", "rejected", "canceled"].includes(evidence.approvalStatus)
      ? "needs_attention" : "materials";
  if (evidence.state === "completed") {
    const writeback = evidence.writeback?.completed;
    if (writeback?.state === "dead_letter") return "needs_attention";
    return writeback && !["succeeded", "skipped"].includes(writeback.state)
      ? "feishu_delivery"
      : "awaiting_feishu_review";
  }
  if (
    ["rendered", "delivery_pending", "delivery_confirmed"].includes(
      evidence.state,
    )
  )
    return "feishu_delivery";
  if (evidence.waitingForSlot || task.status === "queued") return "queued";
  return [
    "ready",
    "preparing",
    "prepared",
    "planning",
    "planned",
    "rendering",
  ].includes(evidence.state)
    ? "editing"
    : "todo";
}

/** Project authoritative evidence without changing generic task statuses or advancing a workflow. */
export function projectVmPackageBoard(tasks, status, scope) {
  const groups = Object.fromEntries(
    VM_PACKAGE_COLUMNS.map((column) => [column.id, []]),
  );
  if (
    !status ||
    status.subjectKey !== scope.subjectKey ||
    status.packageAlias !== scope.packageAlias
  )
    return { groups, history: [] };
  const evidenceByTask = new Map(
    (status.tasks ?? []).map((item) => [item.taskId, item]),
  );
  const records = new Map();
  for (const task of scopedPackageTasks(tasks, scope)) {
    if (["backlog", "canceled"].includes(task.status)) continue;
    if (
      task.feishuPackageSnapshot?.workflowTemplate?.id !== "vm_pmo_review_video"
    )
      continue;
    const recordId = task.feishuOrigin.recordId;
    const entries = records.get(recordId) ?? [];
    const evidence = evidenceByTask.get(task.id) ?? null;
    entries.push({ task, evidence, stage: stageFor(task, evidence) });
    records.set(recordId, entries);
  }
  const history = [];
  for (const entries of records.values()) {
    const parents = new Set(
      entries.map((item) => item.evidence?.parentTaskId).filter(Boolean),
    );
    entries.sort(
      (a, b) =>
        Number(parents.has(a.task.id)) - Number(parents.has(b.task.id)) ||
        (Date.parse(b.task.createdAt) || 0) -
          (Date.parse(a.task.createdAt) || 0) ||
        b.task.id.localeCompare(a.task.id),
    );
    const [latest, ...previous] = entries;
    groups[latest.stage].push({ ...latest, roundCount: entries.length });
    history.push(...previous);
  }
  return { groups, history };
}
