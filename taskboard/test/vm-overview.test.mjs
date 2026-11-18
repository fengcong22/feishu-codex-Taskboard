import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { readVmOverview } from "../server/vm-overview.mjs";

const VM = { id: "vm_pmo_review_video", version: 1 };
const ZIP = { id: "document_draft_zip", version: 1 };
const ACTOR = { type: "user", id: "offline", name: "Offline", avatarUrl: null };
const ISO = () => new Date().toISOString();

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-overview-"));
  const database = new TaskboardDatabase(path.join(directory, "overview.sqlite"));
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  database.database.exec(`CREATE TABLE IF NOT EXISTS vm_pmo_runs (
    run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, identity_json TEXT NOT NULL,
    identity_sha256 TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL,
    lease_token TEXT, lease_until INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  database.database.exec(`CREATE TABLE IF NOT EXISTS vm_mp4_deliveries (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
    base_token TEXT NOT NULL, table_id TEXT NOT NULL, record_id TEXT NOT NULL, field_id TEXT NOT NULL,
    source_path TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0, file_token TEXT, state TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, error_code TEXT,
    lease_token TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  database.database.exec(`CREATE TABLE IF NOT EXISTS vm_final_archive_jobs (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, subject_key TEXT NOT NULL, config_version INTEGER NOT NULL,
    request_json TEXT NOT NULL, plan_json TEXT NOT NULL, destination_key TEXT NOT NULL, filename TEXT NOT NULL,
    state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    error_code TEXT, lease_token TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  database.database.exec(`CREATE TABLE IF NOT EXISTS vm_writeback_outbox (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
    moment TEXT NOT NULL, target_json TEXT NOT NULL, operation_json TEXT NOT NULL, state TEXT NOT NULL,
    version INTEGER NOT NULL, attempt_count INTEGER NOT NULL, next_attempt_at TEXT, claim_token TEXT,
    lease_until TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const project = database.createProject({ id: "vm_project", name: "VM project", workspacePath: null });
  return { database, project };
}

function createTask(database, projectId, {
  workflowTemplate = VM, subjectKey = "bas_vm:tbl_vm", recordId = `rec_${randomUUID()}`,
  stageId = "initial", executionMode = "manual", deliverySource, packageAlias = "vm-a",
  status = "todo", reviewRound = 0, archived = false,
} = {}) {
  const [baseToken, tableId] = subjectKey.split(":");
  const task = database.createTask({
    projectId, title: `VM ${recordId}`, description: "", status, priority: "high", labels: ["feishu"],
    actor: ACTOR, assignee: ACTOR, startDate: null, dueDate: null, recurrence: null, developmentContext: null,
    feishuOrigin: {
      source: "feishu-base", eventId: `evt_${randomUUID()}`, baseToken, tableId, subjectKey,
      recordId, packageAlias, stageId, executionMode,
      ...(deliverySource ? { deliverySource } : {}),
      stageSnapshot: {
        workflowTemplate,
        reviewRound,
        ...(workflowTemplate.id === VM.id ? { vmWorkflow: { fields: { outputAttachmentFieldId: "fld_output" } } } : {}),
      },
    },
    packageSnapshot: { packageAlias, packageRevision: 1, workflowTemplate },
  });
  return archived ? database.archiveTask(task.id, task.version, null, null, ACTOR) : task;
}

function seedRun(database, task, { state = "completed", errorCode = null, payload = {}, tamper = false } = {}) {
  const origin = database.getFeishuTaskOrigin(task.id);
  const identity = {
    taskId: task.id,
    runId: `run_${task.id}`,
    outputAttachmentFieldId: "fld_output",
    origin: { eventId: origin.eventId, stageId: origin.stageId, subjectKey: origin.subjectKey, packageAlias: origin.packageAlias },
    packageSnapshot: { packageAlias: origin.packageAlias, workflowTemplate: VM },
  };
  const identityJson = JSON.stringify(identity);
  const runId = `run_${task.id}`;
  database.database.prepare(`INSERT INTO vm_pmo_runs (run_id, task_id, identity_json, identity_sha256, state,
    payload_json, attempt_count, next_attempt_at, error_code, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(runId, task.id, identityJson, createHash("sha256").update(identityJson).digest("hex"),
      state, JSON.stringify({ approvalStatus: "ready", ...payload }), 0, Date.now(), errorCode, Date.now(), Date.now());
  if (tamper) database.database.prepare("UPDATE vm_pmo_runs SET identity_sha256 = ? WHERE run_id = ?").run("0".repeat(64), runId);
  return runId;
}

function seedDelivery(database, task, runId, recordId, { state = "delivered" } = {}) {
  database.database.prepare(`INSERT INTO vm_mp4_deliveries (id, run_id, task_id, artifact_id, base_token, table_id,
    record_id, field_id, source_path, filename, sha256, bytes, state, next_attempt_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`dep_${task.id}`, runId, task.id, `art_${task.id}`, "bas_vm", "tbl_vm", recordId, "fld_output",
      "/tmp/a.mp4", "a.mp4", "0".repeat(64), 1, state, Date.now(), Date.now(), Date.now());
}

test("overview reports KPI and funnel counts from the package board projection", async t => {
  const { database, project } = await fixture(t);
  const editing = createTask(database, project.id, { recordId: "rec_editing" });
  seedRun(database, editing, { state: "planning" });
  const blocked = createTask(database, project.id, { recordId: "rec_blocked" });
  seedRun(database, blocked, { state: "blocked", errorCode: "WORD_ALIGNMENT_UNRESOLVED" });

  const overview = readVmOverview({ database, projectId: project.id });
  assert.equal(overview.kpis.needsAttention, 1);
  assert.equal(overview.kpis.activeRuns, 2);
  assert.equal(overview.attention.length, 1);
  assert.equal(overview.attention[0].taskId, blocked.id);
  assert.equal(overview.attention[0].errorCode, "WORD_ALIGNMENT_UNRESOLVED");
  const funnel = Object.fromEntries(overview.funnel.map(item => [item.id, item.count]));
  assert.equal(funnel.needs_attention, 1);
  assert.equal(funnel.editing, 1);
  assert.deepEqual(overview.failures.map(item => item.errorCode), ["WORD_ALIGNMENT_UNRESOLVED"]);
});

test("overview ignores simulation, ZIP templates, archived tasks and unpaired snapshots", async t => {
  const { database, project } = await fixture(t);
  const simulated = createTask(database, project.id, { recordId: "rec_sim", deliverySource: "simulation" });
  seedRun(database, simulated, { state: "blocked", errorCode: "VM_DOWNLOAD_FAILED" });
  createTask(database, project.id, { recordId: "rec_zip", workflowTemplate: ZIP });
  createTask(database, project.id, { recordId: "rec_archived", archived: true });
  const live = createTask(database, project.id, { recordId: "rec_live" });
  seedRun(database, live, { state: "rendering" });
  const unpaired = createTask(database, project.id, { recordId: "rec_unpaired" });
  database.database.prepare("DELETE FROM feishu_task_origins WHERE task_id = ?").run(unpaired.id);

  const overview = readVmOverview({ database, projectId: project.id });
  assert.equal(overview.kpis.needsAttention, 0);
  assert.equal(overview.kpis.activeRuns, 1);
  assert.equal(overview.failures.length, 0);
  assert.equal(overview.funnel.find(item => item.id === "editing").count, 1);
});

test("a run whose identity checksum no longer matches fails closed into needs attention", async t => {
  const { database, project } = await fixture(t);
  const task = createTask(database, project.id, { recordId: "rec_forged" });
  seedRun(database, task, { state: "rendering", tamper: true });

  const overview = readVmOverview({ database, projectId: project.id });
  assert.equal(overview.kpis.needsAttention, 1);
  assert.equal(overview.attention[0].errorCode, "VM_PMO_STATE_INVALID");
});

test("overview counts delivered rounds and a first-pass rate without retries", async t => {
  const { database, project } = await fixture(t);
  const clean = createTask(database, project.id, { recordId: "rec_clean" });
  const cleanRun = seedRun(database, clean, { state: "completed", payload: { completedAt: ISO() } });
  seedDelivery(database, clean, cleanRun, "rec_clean");
  const retried = createTask(database, project.id, { recordId: "rec_retried" });
  const retriedRun = seedRun(database, retried, {
    state: "completed",
    payload: {
      completedAt: ISO(),
      planAttempt: 2,
      retryHistory: [{ planAttempt: 1, errorCode: "WORD_ALIGNMENT_UNRESOLVED", failedAt: ISO() }],
    },
  });
  seedDelivery(database, retried, retriedRun, "rec_retried");

  const overview = readVmOverview({ database, projectId: project.id });
  // Both rounds delivered the unique MP4; only one avoided a planning retry.
  assert.equal(overview.kpis.deliveredLast7Days, 2);
  assert.equal(overview.kpis.firstPassRate, 50);
  assert.deepEqual(overview.rounds, { one: 2, two: 0, threeOrMore: 0 });
  assert.equal(overview.durations.plan.samples, 0);
});

test("overview surfaces a dead-lettered writeback and a failed archive as attention", async t => {
  const { database, project } = await fixture(t);
  const dead = createTask(database, project.id, { recordId: "rec_dead" });
  const deadRun = seedRun(database, dead, { state: "completed", payload: { completedAt: ISO() } });
  seedDelivery(database, dead, deadRun, "rec_dead");
  database.database.prepare(`INSERT INTO vm_writeback_outbox (id, idempotency_key, task_id, run_id, moment,
    target_json, operation_json, state, version, attempt_count, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("wb_1", "wb_1", dead.id, deadRun, "completed", "{}", "{}", "dead_letter", 1, 3, ISO(), ISO());

  const overview = readVmOverview({ database, projectId: project.id });
  assert.equal(overview.writebackDeadLetters, 1);
  assert.equal(overview.kpis.needsAttention, 1);
  assert.equal(overview.attention[0].reasonCode, "VM_WRITEBACK_DEAD_LETTER");
  assert.equal(overview.failures[0].errorCode, "VM_WRITEBACK_DEAD_LETTER");
});

test("overview exposes the scheduler slot and never lets a failing scheduler break the read", async t => {
  const { database, project } = await fixture(t);
  let calls = 0;
  const scheduler = {
    snapshot() {
      calls += 1;
      return { activeCount: 1, pendingCount: 2, concurrencyGroups: [{ name: "editing", maxConcurrent: 1, active: 1 }] };
    },
  };
  const overview = readVmOverview({ database, scheduler, projectId: project.id });
  assert.equal(calls, 1);
  assert.deepEqual(overview.slot, { activeCount: 1, pendingCount: 2, maxConcurrent: 1, groupName: "editing" });
  const broken = readVmOverview({ database, scheduler: { snapshot() { throw new Error("boom"); } }, projectId: project.id });
  assert.equal(broken.slot, null);
});

test("overview rejects an invalid project scope instead of widening to every project", async t => {
  const { database } = await fixture(t);
  for (const invalid of ["", " ", "../project", "a/b", "ok\u0000"]) {
    assert.throws(() => readVmOverview({ database, projectId: invalid }),
      error => error.status === 400 && error.code === "VM_OVERVIEW_SCOPE_INVALID");
  }
});

test("the loopback overview route rejects unknown query parameters and unsupported methods", async t => {
  const { createTaskboardServer } = await import("../server/app.mjs");
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-overview-http-"));
  const app = createTaskboardServer({ dataDirectory: path.join(directory, "data"), codexExecutable: process.execPath, processEnv: {} });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const call = async (target, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${target}`, {
      ...options, headers: { "content-type": "application/json", ...options.headers },
    });
    return { status: response.status, body: await response.json() };
  };

  const ok = await call("/api/local/feishu/vm-overview");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.projectId, null);
  assert.ok(Array.isArray(ok.body.attention));
  assert.ok(Array.isArray(ok.body.funnel));

  for (const [target, options, status] of [
    ["/api/local/feishu/vm-overview?ignored=1", {}, 400],
    ["/api/local/feishu/vm-overview?projectId=a&projectId=b", {}, 400],
    ["/api/local/feishu/vm-overview?projectId=a%2Fb", {}, 400],
    ["/api/local/feishu/vm-overview", { method: "POST" }, 405],
    ["/api/local/feishu/vm-overview", { headers: { origin: "https://untrusted.example" } }, 403],
  ]) {
    const result = await call(target, options);
    assert.equal(result.status, status, JSON.stringify(result));
  }
});
