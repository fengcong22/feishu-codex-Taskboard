/**
 * Seeds a throwaway data directory with a plausible VM/PMO pipeline so the
 * dashboard can be inspected visually. Never touches the real .data directory.
 *
 *   node scripts/demo-vm-overview.mjs <dataDirectory>
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { TaskboardDatabase } from "../server/database.mjs";

const VM = { id: "vm_pmo_review_video", version: 1 };
const ACTOR = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = value => new Date(value).toISOString();

const dataDirectory = process.argv[2];
if (!dataDirectory) {
  console.error("usage: node scripts/demo-vm-overview.mjs <dataDirectory>");
  process.exit(1);
}
await mkdir(dataDirectory, { recursive: true });
const database = new TaskboardDatabase(path.join(dataDirectory, "taskboard.sqlite"));

const project = database.createProject({ id: "demo-feishu", name: "VM 剪辑 · 动画组", workspacePath: null });
database.database.prepare("UPDATE projects SET source = 'feishu' WHERE id = ?").run(project.id);

// A subject row so the board chrome resolves; it stays disabled, so nothing can run.
database.database.prepare(`INSERT INTO feishu_bases (base_token, base_name, source_url_label,
  metadata_refreshed_at, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
  .run("bas_demo", "演示多维表格", null, now, iso(now), iso(now));
database.database.prepare(`INSERT INTO feishu_subjects (subject_key, base_token, table_id, table_name,
  project_id, display_enabled, lifecycle, config_version, config_json, metadata_json, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("bas_demo:tbl_demo", "bas_demo", "tbl_demo", "演示表", project.id, 1, "disabled", 1,
    JSON.stringify({
      baseName: "演示多维表格", tableName: "演示表", packageRoute: { packageAlias: "vm-review" },
    }), "{}", iso(now), iso(now));

for (const statement of [
  `CREATE TABLE IF NOT EXISTS vm_pmo_runs (
    run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, identity_json TEXT NOT NULL,
    identity_sha256 TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL,
    lease_token TEXT, lease_until INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS vm_mp4_deliveries (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
    base_token TEXT NOT NULL, table_id TEXT NOT NULL, record_id TEXT NOT NULL, field_id TEXT NOT NULL,
    source_path TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0, file_token TEXT, state TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, error_code TEXT,
    lease_token TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS vm_writeback_outbox (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
    moment TEXT NOT NULL, target_json TEXT NOT NULL, operation_json TEXT NOT NULL, state TEXT NOT NULL,
    version INTEGER NOT NULL, attempt_count INTEGER NOT NULL, next_attempt_at TEXT, claim_token TEXT,
    lease_until TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
]) database.database.exec(statement);

function createTask({ title, recordId, createdAt, reviewRound = 0, stageId = "initial" }) {
  return database.createTask({
    projectId: project.id, title, description: "", status: "todo", priority: "high", labels: ["feishu"],
    actor: ACTOR, assignee: ACTOR, startDate: null, dueDate: null, recurrence: null, developmentContext: null,
    feishuOrigin: {
      source: "feishu-base", eventId: `evt_${randomUUID()}`, baseToken: "bas_demo", tableId: "tbl_demo",
      subjectKey: "bas_demo:tbl_demo", recordId, packageAlias: "vm-review", stageId, executionMode: "automatic",
      stageSnapshot: { workflowTemplate: VM, reviewRound, vmWorkflow: { fields: { outputAttachmentFieldId: "fld_output" } } },
    },
    packageSnapshot: { packageAlias: "vm-review", packageRevision: 3, workflowTemplate: VM },
  });
}

function seedRun(task, { state, errorCode = null, createdAt, payload = {} }) {
  const runId = `run_${randomUUID()}`;
  const identity = {
    taskId: task.id, runId, outputAttachmentFieldId: "fld_output",
    origin: { eventId: database.getFeishuTaskOrigin(task.id).eventId, stageId: "initial",
      subjectKey: "bas_demo:tbl_demo", packageAlias: "vm-review" },
    packageSnapshot: { packageAlias: "vm-review", workflowTemplate: VM },
  };
  const identityJson = JSON.stringify(identity);
  database.database.prepare(`INSERT INTO vm_pmo_runs (run_id, task_id, identity_json, identity_sha256, state,
    payload_json, attempt_count, next_attempt_at, error_code, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(runId, task.id, identityJson, createHash("sha256").update(identityJson).digest("hex"),
      state, JSON.stringify({ approvalStatus: "ready", ...payload }), 0, createdAt, errorCode, createdAt, createdAt);
  return runId;
}

function seedDelivery(task, runId, recordId, at) {
  database.database.prepare(`INSERT INTO vm_mp4_deliveries (id, run_id, task_id, artifact_id, base_token, table_id,
    record_id, field_id, source_path, filename, sha256, bytes, state, next_attempt_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`dep_${randomUUID()}`, runId, task.id, `art_${randomUUID()}`, "bas_demo", "tbl_demo", recordId,
      "fld_output", "/tmp/demo.mp4", "demo.mp4", "a".repeat(64), 1_048_576, "delivered", at, at, at);
}

const rows = [
  { title: "VM 001 期中复习 · 第一讲 剪辑", recordId: "rec_001", state: "planning", createdAt: now - 52 * MINUTE,
    payload: { planStartedAt: iso(now - 40 * MINUTE) } },
  { title: "VM 002 期末冲刺 · 第二讲 剪辑", recordId: "rec_002", state: "blocked",
    errorCode: "WORD_ALIGNMENT_UNRESOLVED", createdAt: now - 6 * HOUR,
    payload: { planStartedAt: iso(now - 5 * HOUR) } },
  { title: "VM 003 实验课 · 第三讲 剪辑", recordId: "rec_003", state: "needs_attention",
    errorCode: "VM_PMO_START_EVIDENCE_FAILED", createdAt: now - 2 * HOUR,
    payload: { planStartedAt: iso(now - 90 * MINUTE), runnerStartedAt: iso(now - 40 * MINUTE) } },
  { title: "VM 004 专题复习 · 第四讲 剪辑", recordId: "rec_004", state: "waiting_materials",
    createdAt: now - 3 * HOUR, payload: { approvalStatus: "waiting_approval" } },
  { title: "VM 005 习题讲解 · 第五讲 剪辑", recordId: "rec_005", state: "waiting_materials",
    createdAt: now - 26 * HOUR, payload: { approvalStatus: "waiting_approval" } },
  { title: "VM 006 实验演示 · 第六讲 剪辑", recordId: "rec_006", state: "blocked",
    errorCode: "VM_DOWNLOAD_FAILED", createdAt: now - 9 * HOUR,
    payload: { downloadFailure: { reason: "wait_timeout", approved: true } } },
  { title: "VM 007 期中复习 · 第一讲 剪辑（第 1 轮审核）", recordId: "rec_007", stageId: "review", reviewRound: 1,
    state: "completed", createdAt: now - 30 * HOUR, delivered: true, deliveredAt: now - 20 * HOUR,
    payload: { planStartedAt: iso(now - 28 * HOUR), runnerStartedAt: iso(now - 26 * HOUR), completedAt: iso(now - 20 * HOUR) } },
  { title: "VM 008 期末冲刺 · 第二讲 剪辑（第 1 轮审核）", recordId: "rec_008", stageId: "review", reviewRound: 1,
    state: "completed", createdAt: now - 3 * DAY, delivered: true, deliveredAt: now - 2.5 * DAY,
    payload: { planStartedAt: iso(now - 3 * DAY + 2 * HOUR), runnerStartedAt: iso(now - 3 * DAY + 3 * HOUR),
      completedAt: iso(now - 2.5 * DAY) } },
  { title: "VM 009 实验课 · 第三讲 剪辑", recordId: "rec_009", state: "completed", createdAt: now - 2 * DAY,
    delivered: true, deliveredAt: now - 30 * HOUR, deadLetter: true,
    payload: { planStartedAt: iso(now - 2 * DAY + HOUR), runnerStartedAt: iso(now - 2 * DAY + 2 * HOUR),
      completedAt: iso(now - 30 * HOUR - HOUR) } },
  // Archived rows: the collapsed "已归档" section is how a wrongly archived
  // round is recovered, so the demo shows one of each.
  { title: "VM 010 阶段复习 · 第七讲 剪辑", recordId: "rec_010", state: "waiting_materials",
    createdAt: now - 4 * HOUR, archived: true },
  { title: "VM 011 阶段复习 · 第八讲 剪辑", recordId: "rec_011", state: "blocked",
    errorCode: "VM_DOWNLOAD_FAILED", createdAt: now - 2 * DAY, archived: true },
];

// createTask opens its own transaction, so each row commits on its own.
for (const row of rows) {
  const task = createTask(row);
  const runId = seedRun(task, row);
  if (row.delivered) seedDelivery(task, runId, row.recordId, row.deliveredAt);
  if (row.deadLetter) {
    database.database.prepare(`INSERT INTO vm_writeback_outbox (id, idempotency_key, task_id, run_id, moment,
      target_json, operation_json, state, version, attempt_count, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`wb_${randomUUID()}`, `wb_${randomUUID()}`, task.id, runId, "completed",
        "{}", "{}", "dead_letter", 1, 5, iso(now - 29 * HOUR), iso(now - 28 * HOUR));
  }
  if (row.archived) database.archiveTask(task.id, task.version, null, null, ACTOR);
}

console.log(`Seeded ${rows.length} demo rows into ${dataDirectory}`);
database.close();
