import { createHash } from "node:crypto";
import { ApiError } from "./database.mjs";

const template = value => value?.id === "vm_pmo_review_video" && value.version === 1;
const code = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,100}$/u.test(value) ? value : null;
const iso = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const parse = value => {try {return JSON.parse(value);} catch {return null;}};
const hash = value => createHash("sha256").update(value).digest("hex");
const states = new Set(["waiting_materials","ready","preparing","prepared","planning","planned","rendering",
  "rendered","delivery_pending","delivery_confirmed","completed","blocked","needs_attention"]);
const approvalStates = new Set(["reserved","queued","submitting","reconciling","waiting_approval","waiting_media",
  "acquiring","retry_wait","auth_required","needs_attention","dead_letter","ready","rejected","canceled"]);

/** Only SELECTs on existing local evidence. Never initializes workers or reads media/remote configuration. */
export function readVmPackageBoard({database,subjectKey,packageAlias} = {}) {
  if (typeof subjectKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}:[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(subjectKey)
    || typeof packageAlias !== "string" || !packageAlias || packageAlias !== packageAlias.trim()
    || ["__proto__","constructor","prototype"].includes(packageAlias)
    || /^[./\\]/u.test(packageAlias) || /[\s\u0000-\u001f\u007f"'`:$<>|]/u.test(packageAlias))
    throw new ApiError(400,"VM_PACKAGE_BOARD_SCOPE_INVALID","VM_PACKAGE_BOARD_SCOPE_INVALID");
  const db = database.database;
  const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  const origins = db.prepare("SELECT task_id FROM feishu_task_origins WHERE subject_key=? ORDER BY created_at,rowid")
    .all(subjectKey).flatMap(({task_id:taskId}) => {
      const origin = database.getFeishuTaskOrigin(taskId), snapshot = database.getFeishuTaskPackageSnapshot(taskId);
      if (origin?.source !== "feishu-base" || origin.deliverySource !== undefined || origin.packageAlias !== packageAlias
        || origin.subjectKey !== subjectKey || !["initial","review"].includes(origin.stageId)
        || snapshot?.packageAlias !== packageAlias || !template(snapshot.workflowTemplate)
        || !template(origin.stageSnapshot?.workflowTemplate)) return [];
      return [origin];
    });
  const byTask = new Map(origins.map(origin => [origin.taskId,origin]));
  const group = origin => JSON.stringify([origin.baseToken,origin.tableId,origin.recordId,
    origin.stageSnapshot?.vmWorkflow?.fields?.outputAttachmentFieldId]);
  const latestTask = new Map(origins.map(origin => [group(origin),origin.taskId]));
  const deliveries = exists("vm_mp4_deliveries") ? db.prepare(`SELECT * FROM vm_mp4_deliveries
    WHERE state='delivered' ORDER BY updated_at,created_at,rowid`).all().filter(row => {
      const origin = byTask.get(row.task_id);
      return origin && row.base_token === origin.baseToken && row.table_id === origin.tableId && row.record_id === origin.recordId
        && row.field_id === origin.stageSnapshot?.vmWorkflow?.fields?.outputAttachmentFieldId;
    }) : [];
  const latestDelivery = new Map(deliveries.map(row => [group(byTask.get(row.task_id)),row]));
  const archives = new Map();
  if (exists("vm_final_archive_jobs")) for (const row of db.prepare(`SELECT * FROM vm_final_archive_jobs
    WHERE subject_key=? ORDER BY created_at,rowid`).all(subjectKey)) {
    const plan = parse(row.plan_json), sourceRunId = plan?.source?.runId;
    const delivered = deliveries.find(delivery => delivery.run_id === sourceRunId && delivery.id === plan?.source?.deliveryId
      && delivery.artifact_id === plan?.source?.artifactId && delivery.sha256 === plan?.source?.sha256);
    if (!delivered || plan.lineage && (plan.lineage.subjectKey !== subjectKey || plan.lineage.packageAlias !== packageAlias
      || !template(plan.lineage.workflowTemplate) || plan.lineage.outputAttachmentFieldId !== delivered.field_id)) continue;
    archives.set(sourceRunId,{id:row.id,eventId:row.event_id,state:row.state,errorCode:code(row.error_code),
      sourceTaskId:delivered.task_id,sourceRunId,published:row.state === "published",updatedAt:iso(row.updated_at)});
  }
  const tasks = origins.map(origin => {
    const row = exists("vm_pmo_runs") ? db.prepare("SELECT * FROM vm_pmo_runs WHERE task_id=?").get(origin.taskId) : null;
    const identity = parse(row?.identity_json), payload = parse(row?.payload_json);
    const valid = row && row.identity_sha256 === hash(row.identity_json) && identity?.taskId === origin.taskId
      && identity.origin?.packageAlias === packageAlias && identity.origin?.subjectKey === subjectKey
      && identity.packageSnapshot?.packageAlias === packageAlias && template(identity.packageSnapshot?.workflowTemplate)
      && identity.origin?.eventId === origin.eventId && identity.outputAttachmentFieldId === origin.stageSnapshot?.vmWorkflow?.fields?.outputAttachmentFieldId;
    const entries = row && exists("vm_writeback_outbox") ? db.prepare("SELECT moment,state,error_code,attempt_count FROM vm_writeback_outbox WHERE run_id=? AND task_id=?")
      .all(row.run_id,origin.taskId) : [];
    const writeback = Object.fromEntries(["processing","completed"].map(moment => {
      const entry = entries.find(item => item.moment === moment);
      return [moment,entry ? {state:entry.state,errorCode:code(entry.error_code),attemptCount:entry.attempt_count} : null];
    }));
    const parentRunId = origin.stageSnapshot?.reviewParent?.runId ?? null;
    const parentTaskId = parentRunId ? deliveries.find(delivery => delivery.run_id === parentRunId)?.task_id ?? null : null;
    const last = latestDelivery.get(group(origin));
    return {taskId:origin.taskId,runId:row?.run_id ?? null,stage:origin.stageId,
      state:row ? valid && states.has(row.state) ? row.state : "needs_attention" : "todo",
      approvalStatus:valid && approvalStates.has(payload?.approvalStatus) ? payload.approvalStatus : null,
      errorCode:row && !valid ? "VM_PMO_STATE_INVALID" : code(row?.error_code),writeback,
      updatedAt:iso(row?.updated_at ?? origin.updatedAt),
      planStartedAt:valid ? iso(payload?.planStartedAt) : null,
      runnerStartedAt:valid ? iso(payload?.runnerStartedAt) : null,
      completedAt:valid ? iso(payload?.completedAt) : null,
      waitingForSlot:Boolean(valid && ["prepared","planned"].includes(row.state) && !payload?.runnerStartedAt),
      parentTaskId,parentRunId,reviewRound:origin.stageSnapshot?.reviewRound ?? 0,
      latestDelivered:Boolean(valid && last?.run_id === row.run_id),
      supersededByTaskId:latestTask.get(group(origin)) !== origin.taskId ? latestTask.get(group(origin)) : null,
      ...(archives.has(row?.run_id) ? {archive:archives.get(row.run_id)} : {})};
  });
  return {subjectKey,packageAlias,tasks};
}
