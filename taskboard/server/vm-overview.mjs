import { createHash } from "node:crypto";

import { ApiError } from "./database.mjs";

const template = value => value?.id === "vm_pmo_review_video" && value.version === 1;
const code = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,100}$/u.test(value) ? value : null;
const iso = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const parse = value => {try {return JSON.parse(value);} catch {return null;}};
const hash = value => createHash("sha256").update(value).digest("hex");
const millis = value => {const parsed = Date.parse(value ?? "");return Number.isFinite(parsed) ? parsed : null;};
const DAY = 86_400_000;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

const RUN_STATES = new Set(["waiting_materials","ready","preparing","prepared","planning","planned","rendering",
  "rendered","delivery_pending","delivery_confirmed","completed","blocked","needs_attention"]);
const APPROVAL_STATES = new Set(["reserved","queued","submitting","reconciling","waiting_approval","waiting_media",
  "acquiring","retry_wait","auth_required","needs_attention","dead_letter","ready","rejected","canceled"]);
const WRITEBACK_STATES = new Set(["pending","processing","retry_wait","succeeded","conflict","dead_letter"]);
const SETTLED_WRITEBACK = new Set(["succeeded","skipped"]);
const ATTENTION = new Set(["blocked","needs_attention"]);
const WAITING_APPROVAL = new Set(["reserved","queued","submitting","reconciling","waiting_approval","waiting_media","acquiring","retry_wait"]);
const EDITING_SEQUENCE = new Set(["ready","preparing","prepared","planning","planned","rendering"]);

/** Mirrors the package board projection so the dashboard and the board agree. */
function column(state, approvalStatus, writeback, archive, waitingForSlot, taskStatus, hasRun) {
  if (!hasRun) {
    if (taskStatus === "todo") return "todo";
    return taskStatus === "queued" ? "queued" : "needs_attention";
  }
  if (ATTENTION.has(state)) return "needs_attention";
  if (archive) {
    if (archive.state === "published") return "completed";
    return ["conflict","dead_letter"].includes(archive.state) ? "needs_attention" : "nas_upload";
  }
  if (state === "waiting_materials") {
    return ["auth_required","needs_attention","dead_letter","rejected","canceled"].includes(approvalStatus)
      ? "needs_attention" : "materials";
  }
  if (state === "completed") {
    const completed = writeback?.completed;
    if (completed?.state === "dead_letter") return "needs_attention";
    return completed && !SETTLED_WRITEBACK.has(completed.state) ? "feishu_delivery" : "awaiting_feishu_review";
  }
  if (["rendered","delivery_pending","delivery_confirmed"].includes(state)) return "feishu_delivery";
  if (waitingForSlot || taskStatus === "queued") return "queued";
  return EDITING_SEQUENCE.has(state) ? "editing" : "todo";
}

/**
 * Read-only projection of VM/PMO pipeline health for the dashboard.
 *
 * Only SELECTs on existing local evidence: it never initializes workers, reads
 * media, calls the network, or enables configuration. The scheduler snapshot is
 * in-memory and side-effect free (AGENTS.md: board reads cause no execution).
 */
export function readVmOverview({ database, scheduler = null, projectId = null, now = Date.now() } = {}) {
  if (!database?.database) throw new TypeError("database is required");
  if (projectId !== null && (typeof projectId !== "string" || !PROJECT_ID.test(projectId))) {
    throw new ApiError(400, "VM_OVERVIEW_SCOPE_INVALID", "VM_OVERVIEW_SCOPE_INVALID");
  }
  const db = database.database;
  const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  const since7 = now - 7 * DAY;

  const originRows = db.prepare(`SELECT origins.task_id AS task_id, tasks.project_id AS project_id,
      tasks.status AS task_status, tasks.title AS title, tasks.archived_at AS archived_at,
      tasks.created_at AS task_created_at
    FROM feishu_task_origins AS origins
    JOIN tasks ON tasks.id = origins.task_id
    ${projectId === null ? "" : "WHERE tasks.project_id = ?"}
    ORDER BY origins.created_at, origins.rowid`).all(...(projectId === null ? [] : [projectId]));

  // Only a persisted origin plus a frozen package snapshot proves the Bridge
  // path; simulation events and description markers are never pipeline evidence.
  const scoped = [];
  for (const row of originRows) {
    let origin;
    let snapshot;
    try {
      origin = database.getFeishuTaskOrigin(row.task_id);
      snapshot = database.getFeishuTaskPackageSnapshot(row.task_id);
    } catch { continue; }
    if (origin?.deliverySource === "simulation") continue;
    if (origin?.source !== "feishu-base" || !template(snapshot?.workflowTemplate)
      || !template(origin.stageSnapshot?.workflowTemplate)) continue;
    if (!["initial","review"].includes(origin.stageId)) continue;
    scoped.push({ ...row, origin });
  }

  const runs = new Map();
  if (exists("vm_pmo_runs")) {
    for (const run of db.prepare("SELECT * FROM vm_pmo_runs").all()) runs.set(run.task_id, run);
  }
  const outbox = new Map();
  if (exists("vm_writeback_outbox")) {
    for (const entry of db.prepare("SELECT run_id, moment, state, error_code, attempt_count FROM vm_writeback_outbox").all()) {
      const list = outbox.get(entry.run_id) ?? [];
      list.push(entry);
      outbox.set(entry.run_id, list);
    }
  }
  const deliveries = new Map();
  if (exists("vm_mp4_deliveries")) {
    for (const delivery of db.prepare("SELECT run_id, state, updated_at FROM vm_mp4_deliveries").all()) {
      deliveries.set(delivery.run_id, delivery);
    }
  }
  const archives = new Map();
  if (exists("vm_final_archive_jobs")) {
    for (const job of db.prepare("SELECT plan_json, state, error_code, updated_at FROM vm_final_archive_jobs ORDER BY created_at, rowid").all()) {
      const sourceRunId = parse(job.plan_json)?.source?.runId;
      if (typeof sourceRunId !== "string") continue;
      archives.set(sourceRunId, { state: String(job.state), errorCode: code(job.error_code), updatedAt: iso(job.updated_at) });
    }
  }

  const tasks = scoped.map(row => {
    const run = runs.get(row.task_id) ?? null;
    const identity = parse(run?.identity_json);
    const payload = parse(run?.payload_json);
    const valid = Boolean(run) && run.identity_sha256 === hash(run.identity_json)
      && identity?.taskId === row.task_id
      && template(identity?.packageSnapshot?.workflowTemplate)
      && identity?.origin?.eventId === row.origin.eventId;
    const entries = valid ? (outbox.get(run.run_id) ?? []) : [];
    const writeback = Object.fromEntries(["processing","completed"].map(moment => {
      const entry = entries.find(item => item.moment === moment);
      return [moment, entry && WRITEBACK_STATES.has(entry.state)
        ? {state: entry.state, errorCode: code(entry.error_code), attemptCount: entry.attempt_count} : null];
    }));
    const delivery = valid ? deliveries.get(run.run_id) ?? null : null;
    const archive = valid ? archives.get(run.run_id) ?? null : null;
    const state = valid && RUN_STATES.has(run.state) ? run.state : run ? "needs_attention" : null;
    const approvalStatus = valid && APPROVAL_STATES.has(payload?.approvalStatus) ? payload.approvalStatus : null;
    const waitingForSlot = Boolean(valid && ["prepared","planned"].includes(run.state) && !payload?.runnerStartedAt);
    return {
      taskId: row.task_id,
      projectId: row.project_id,
      title: row.title,
      subjectKey: row.origin.subjectKey ?? `${row.origin.baseToken}:${row.origin.tableId}`,
      packageAlias: row.origin.packageAlias ?? null,
      baseToken: row.origin.baseToken,
      tableId: row.origin.tableId,
      recordId: row.origin.recordId,
      stage: row.origin.stageId,
      reviewRound: Number.isSafeInteger(row.origin.stageSnapshot?.reviewRound) ? row.origin.stageSnapshot.reviewRound : 0,
      taskStatus: row.task_status,
      archived: row.archived_at != null,
      createdAt: iso(row.task_created_at),
      runId: run?.run_id ?? null,
      state,
      column: column(state, approvalStatus, writeback, archive, waitingForSlot, row.task_status, Boolean(run)),
      errorCode: run && !valid ? "VM_PMO_STATE_INVALID" : code(run?.error_code),
      approvalStatus,
      waitingForSlot,
      planAttempt: Number.isSafeInteger(payload?.planAttempt) ? payload.planAttempt : 1,
      retried: Array.isArray(payload?.retryHistory) && payload.retryHistory.length > 0
        || Array.isArray(payload?.aiRetryHistory) && payload.aiRetryHistory.length > 0,
      plannedAt: iso(payload?.planStartedAt),
      runnerStartedAt: iso(payload?.runnerStartedAt),
      completedAt: iso(payload?.completedAt),
      updatedAt: iso(run?.updated_at ?? row.origin.updatedAt ?? row.task_created_at),
      delivered: delivery?.state === "delivered",
      deliveredAt: delivery?.state === "delivered" ? iso(delivery.updated_at) : null,
      writeback,
      archive,
      materialSource: payload?.acquisition?.vmid_binding === "operator_asserted" ? "manual"
        : payload?.acquisition ? "vm" : null,
    };
  }).map(task => ({ ...task, reasonCode: reasonFor(task) }));

  return {
    projectId,
    generatedAt: new Date(now).toISOString(),
    slot: readSlot(scheduler),
    ...aggregate(tasks, { now, since7 }),
  };
}

/** The one reason a human must act, derived the same way the board picks its column. */
function reasonFor(task) {
  if (task.errorCode) return task.errorCode;
  if (task.writeback?.completed?.state === "dead_letter") return "VM_WRITEBACK_DEAD_LETTER";
  if (task.writeback?.processing?.state === "dead_letter") return "VM_WRITEBACK_DEAD_LETTER";
  if (task.archive && ["conflict","dead_letter"].includes(task.archive.state)) {
    return task.archive.errorCode ?? (task.archive.state === "conflict" ? "VM_ARCHIVE_CONFLICT" : "VM_ARCHIVE_DEAD_LETTER");
  }
  return null;
}

function readSlot(scheduler) {
  if (!scheduler || typeof scheduler.snapshot !== "function") return null;
  try {
    const snapshot = scheduler.snapshot();
    const groups = Array.isArray(snapshot?.concurrencyGroups) ? snapshot.concurrencyGroups : [];
    const group = groups.find(item => item && Number.isSafeInteger(item.maxConcurrent)) ?? null;
    return {
      activeCount: Number.isSafeInteger(snapshot?.activeCount) ? snapshot.activeCount : null,
      pendingCount: Number.isSafeInteger(snapshot?.pendingCount) ? snapshot.pendingCount : null,
      maxConcurrent: group ? group.maxConcurrent : null,
      groupName: typeof group?.name === "string" ? group.name : null,
    };
  } catch {
    return null;
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function elapsed(since, now) {
  const value = millis(since);
  return value === null ? null : Math.max(0, now - value);
}

function aggregate(tasks, { now, since7 }) {
  const active = tasks.filter(task => !task.archived);
  const needsAttention = active.filter(task => task.column === "needs_attention");
  const editing = active.filter(task => task.column === "editing");
  const waitingApproval = active.filter(task => WAITING_APPROVAL.has(task.approvalStatus ?? ""));

  // "Delivered" is this pipeline's completion credential: the unique MP4 passed
  // verification, was uploaded and read back. NAS publication is a later,
  // optional business step and must not decide whether a round counts.
  const deliveredLast7 = tasks.filter(task => task.delivered && isBetween(task.deliveredAt, since7, now));
  // A round is "clean" only when it needed no human step at any point: no
  // planning retry, and nothing left unresolved (writeback or archive included).
  const cleanRounds = deliveredLast7.filter(task => task.planAttempt === 1 && !task.retried
    && task.reasonCode === null);

  // How long the pipeline has been unable to move an item: the earliest of its
  // recorded milestones, so a stalled approval shows the wait, not the last touch.
  const attention = needsAttention
    .map(task => {
      const since = [task.plannedAt, task.createdAt].map(millis).filter(value => value !== null);
      const stuckMs = since.length ? Math.max(0, now - Math.min(...since)) : null;
      return { ...task, stuckMs };
    })
    .sort((left, right) => (right.stuckMs ?? 0) - (left.stuckMs ?? 0));

  const failures = new Map();
  for (const task of tasks.filter(item => !item.archived && item.reasonCode)) {
    const entry = failures.get(task.reasonCode) ?? { errorCode: task.reasonCode, count: 0, taskIds: [] };
    entry.count += 1;
    entry.taskIds.push(task.taskId);
    failures.set(task.reasonCode, entry);
  }

  const records = new Map();
  for (const task of tasks) {
    const key = `${task.baseToken}:${task.tableId}:${task.recordId}`;
    const list = records.get(key) ?? [];
    list.push(task);
    records.set(key, list);
  }
  const rounds = { one: 0, two: 0, threeOrMore: 0 };
  for (const list of records.values()) {
    if (list.length === 1) rounds.one += 1;
    else if (list.length === 2) rounds.two += 1;
    else rounds.threeOrMore += 1;
  }

  const planDurations = [];
  const renderDurations = [];
  const deliveryDurations = [];
  for (const task of tasks) {
    const planned = millis(task.plannedAt);
    const started = millis(task.runnerStartedAt);
    const completed = millis(task.completedAt);
    const delivered = millis(task.deliveredAt);
    if (planned !== null && started !== null && started >= planned) planDurations.push(started - planned);
    if (started !== null && completed !== null && completed >= started) renderDurations.push(completed - started);
    if (completed !== null && delivered !== null && delivered >= completed) deliveryDurations.push(delivered - completed);
  }

  const columns = ["todo","materials","queued","editing","feishu_delivery","awaiting_feishu_review","nas_upload","completed","needs_attention"];
  return {
    kpis: {
      editing: editing.length,
      waitingApproval: waitingApproval.length,
      oldestApprovalWaitMs: oldestMilliseconds(waitingApproval, task => task.createdAt, now),
      needsAttention: needsAttention.length,
      deliveredLast7Days: deliveredLast7.length,
      publishedLast7Days: tasks.filter(task => task.archive?.state === "published"
        && isBetween(task.archive.updatedAt, since7, now)).length,
      firstPassRate: deliveredLast7.length ? Math.round((cleanRounds.length / deliveredLast7.length) * 100) : null,
      activeRuns: active.filter(task => task.runId !== null).length,
    },
    attention: attention.slice(0, 12),
    funnel: columns.map(id => ({ id, count: active.filter(task => task.column === id).length })),
    failures: [...failures.values()].sort((left, right) => right.count - left.count).slice(0, 8),
    rounds,
    durations: {
      plan: { median: median(planDurations), p90: percentile(planDurations, .9), samples: planDurations.length },
      render: { median: median(renderDurations), p90: percentile(renderDurations, .9), samples: renderDurations.length },
      delivery: { median: median(deliveryDurations), p90: percentile(deliveryDurations, .9), samples: deliveryDurations.length },
    },
    writebackDeadLetters: tasks.filter(task => task.writeback?.completed?.state === "dead_letter").length,
    archiveFailures: tasks.filter(task => task.archive && ["conflict","dead_letter"].includes(task.archive.state)).length,
  };
}

function isBetween(value, from, to) {
  const parsed = millis(value);
  return parsed !== null && parsed >= from && parsed <= to;
}

function oldestMilliseconds(list, pick, now) {
  return list.reduce((oldest, item) => {
    const value = elapsed(pick(item), now);
    if (value === null) return oldest;
    return oldest === null || value > oldest ? value : oldest;
  }, null);
}
