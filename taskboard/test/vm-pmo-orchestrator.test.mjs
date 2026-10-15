import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createVmPmoOrchestrator } from "../server/vm-pmo-orchestrator.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-pmo-orchestrator-"));
  const sqlitePath = path.join(directory, "runs.sqlite");
  let db = new DatabaseSync(sqlitePath);
  const calls = [];
  let approvalStatus = "waiting_approval";
  let deliveryJob = null;
  let now = 1_700_000_000_000;
  const task = { id: "task_vm", status: "todo", archivedAt: null, labels: ["feishu"] };
  const origin = { source: "feishu-base", packageSource: "subject-config", eventId: "evt_vm",
    baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm", subjectKey: "bas_vm:tbl_vm",
    configVersion: 4, stageId: "initial", packageAlias: "auto-cut-slicing", executionMode: "manual",
    stageSnapshot: { vmWorkflow: { fields: { outputAttachmentFieldId: "fld_output" } } } };
  const packageSnapshot = { packageAlias: "auto-cut-slicing", packageRevision: 2,
    workflowTemplate: { id: "vm_pmo_review_video", version: 1 } };
  const database = { get database() { return db; }, getTask: () => task,
    getFeishuTaskOrigin: () => origin, getFeishuTaskPackageSnapshot: () => packageSnapshot };
  const binding = { taskId: "task_vm", runId: "run_vm", vmid: "5dd7753a4723ba416403cbad", approvalJobId: "job_vm" };
  const acquisition = { receipt_path: path.join(directory, "receipt.json"), path: path.join(directory, "source.mp4"),
    sha256: "a".repeat(64), bytes: 100, duration_ms: 1000, vmid_binding: "vm_api_verified" };
  const prepared = { contextPath: path.join(directory, "execution-context.json"), inputSha256: "b".repeat(64),
    outputFilename: "课程_初稿.mp4", runnerOptions: { contextPath: path.join(directory, "execution-context.json"),
      packageRoot: directory, pythonPath: path.join(directory, "python.exe") } };
  const artifact = { kind: "review_mp4", path: path.join(directory, "review.mp4"), sha256: "c".repeat(64),
    bytes: 200, duration_ms: 1000, width: 1920, height: 1080, fps: 25, has_audio: true, full_decode_passed: true };
  const dependencies = {
    database, now: () => now,
    bindings: {
      reserve: async (taskId) => { calls.push(["reserve", taskId]); return binding; },
      reconcile: async (taskId) => { calls.push(["reconcile", taskId]); return binding; },
      status: async (taskId) => { calls.push(["status", taskId]); return { ...binding, status: approvalStatus,
        ...(approvalStatus === "ready" ? { acquisition } : {}) }; },
    },
    canExecute: async () => true,
    acquireSlot: async () => { calls.push(["slot"]); return { release: async () => { calls.push(["release"]); } }; },
    prepareInput: async (input) => { calls.push(["prepare", input]); return prepared; },
    runOffline: async ({ mode, onStarted }) => {
      calls.push([mode]); await onStarted({ mode, pid: 42, startedAt: new Date(now).toISOString() });
      return mode === "plan" ? { status: "ready", planSha256: "d".repeat(64) }
        : { status: "rendered", planSha256: "d".repeat(64), artifact };
    },
    recoverOffline: async ({ mode }) => { calls.push(["recover", mode]); return null; },
    registerArtifact: async ({ result }) => { calls.push(["artifact", result]); return { artifactId: "artifact_vm" }; },
    delivery: {
      enqueue: async (input) => { calls.push(["delivery.enqueue", input]); deliveryJob ??= {
        runId: input.runId, taskId: "task_vm", artifactId: input.artifactId, state: "upload_pending",
        target: { baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm", fieldId: "fld_output" } }; return deliveryJob; },
      get: () => deliveryJob,
    },
    onRunStarted: async ({ run }) => { calls.push(["processing", run.runnerStartedAt]); },
    onCompleted: async ({ run }) => { calls.push(["completed", run.runId]); },
  };
  let service = createVmPmoOrchestrator(dependencies);
  t.after(async () => { await service.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { calls, task, origin, packageSnapshot, dependencies, prepared, artifact, binding,
    get f() { return service; }, get db() { return db; },
    setApproval(value) { approvalStatus = value; }, setDelivery(value) { deliveryJob = value; },
    advance(ms) { now += ms; },
    async restart() { await service.close(); db.close(); db = new DatabaseSync(sqlitePath); service = createVmPmoOrchestrator(dependencies); },
  };
}

test("registered tasks wait durably for approval without taking an execution slot", async (t) => {
  const x = await fixture(t);
  const first = await x.f.register({ taskId: "task_vm" });
  assert.equal(first.runId, "run_vm"); assert.equal(first.state, "waiting_materials");
  await x.f.pump("run_vm");
  assert.equal(x.f.get("run_vm").approvalStatus, "waiting_approval");
  assert.equal(x.calls.some(([name]) => ["slot", "prepare", "plan", "render"].includes(name)), false);
  await x.restart();
  assert.equal((await x.f.register({ taskId: "task_vm" })).runId, "run_vm");
  assert.equal(x.f.list().length, 1);
});

test("trusted Chinese package aliases retain their identity through approval and rendering", async (t) => {
  const x = await fixture(t);
  x.origin.packageAlias = "自动切片包";
  x.packageSnapshot.packageAlias = "自动切片包";
  await x.f.register({ taskId: "task_vm" });
  x.setApproval("ready");
  const run = await x.f.pump("run_vm");
  assert.equal(run.state, "delivery_pending");
  assert.equal(x.calls.filter(([kind]) => kind === "render").length, 1);
});

test("verified material leads to immutable input, plan, render, and delivery", async (t) => {
  const x = await fixture(t);
  await x.f.register({ taskId: "task_vm" }); x.setApproval("ready");
  const result = await x.f.pump("run_vm");
  assert.equal(result.state, "delivery_pending");
  assert.equal(result.prepared.inputSha256, "b".repeat(64));
  assert.equal(result.artifactId, "artifact_vm");
  assert.equal(result.runnerStartedAt, "2023-11-14T22:13:20.000Z");
  assert.deepEqual(x.calls.filter(([kind]) => !["reserve", "reconcile", "status"].includes(kind)).map(([kind]) => kind),
    ["prepare", "slot", "plan", "render", "processing", "release", "artifact", "delivery.enqueue"]);
});

test("only attachment readback completes a run and restart does not rerender", async (t) => {
  const x = await fixture(t);
  await x.f.register({ taskId: "task_vm" }); x.setApproval("ready"); await x.f.pump("run_vm");
  await x.restart();
  assert.equal((await x.f.pump("run_vm")).state, "delivery_pending");
  x.setDelivery({ runId: "run_vm", taskId: "task_vm", artifactId: "artifact_vm", state: "delivered",
    fileToken: "file_vm", target: { baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm", fieldId: "fld_output" } });
  assert.equal((await x.f.pump("run_vm")).state, "completed");
  assert.equal((await x.f.pump("run_vm")).state, "completed");
  assert.equal(x.calls.filter(([kind]) => kind === "render").length, 1);
  assert.equal(x.calls.filter(([kind]) => kind === "completed").length, 1);
});

test("simulation, untrusted origins, and identity drift never acquire a slot", async (t) => {
  const x = await fixture(t);
  x.origin.deliverySource = "simulation";
  await assert.rejects(x.f.register({ taskId: "task_vm" }), { code: "VM_PMO_TASK_NOT_ELIGIBLE" });
  assert.equal(x.calls.length, 0);
  delete x.origin.deliverySource;
  await x.f.register({ taskId: "task_vm" }); x.setApproval("ready"); x.origin.recordId = "rec_other";
  assert.equal((await x.f.pump("run_vm")).state, "blocked");
  assert.equal(x.f.get("run_vm").errorCode, "VM_PMO_TASK_IDENTITY_CHANGED");
  assert.equal(x.calls.some(([kind]) => kind === "slot"), false);
});

test("approval rejection is retained and automatic execution policy is checked after waiting", async (t) => {
  const x = await fixture(t); await x.f.register({ taskId: "task_vm" }); x.setApproval("rejected");
  assert.equal((await x.f.pump("run_vm")).state, "blocked");
  const y = await fixture(t); await y.f.register({ taskId: "task_vm" }); y.setApproval("ready");
  y.dependencies.canExecute = async () => false;
  await y.restart();
  assert.equal((await y.f.pump("run_vm")).state, "waiting_materials");
  assert.equal(y.calls.some(([kind]) => kind === "slot"), false);
});

test("runner start evidence and a valid rendered artifact are mandatory", async (t) => {
  const x = await fixture(t); await x.f.register({ taskId: "task_vm" }); x.setApproval("ready");
  x.dependencies.runOffline = async () => ({ status: "ready", planSha256: "d".repeat(64) }); await x.restart();
  const failed = await x.f.pump("run_vm");
  assert.equal(failed.state, "needs_attention"); assert.equal(failed.errorCode, "VM_PMO_START_NOT_CONFIRMED");
  assert.equal(x.calls.some(([kind]) => kind === "delivery.enqueue"), false);
});

test("restart with uncertain render validates its receipt and never respawns it", async (t) => {
  const x = await fixture(t); await x.f.register({ taskId: "task_vm" }); x.setApproval("ready");
  await x.f.pump("run_vm");
  x.db.prepare("UPDATE vm_pmo_runs SET state = 'rendering', lease_token = NULL, lease_until = NULL WHERE run_id = ?").run("run_vm");
  x.dependencies.recoverOffline = async ({ mode }) => { x.calls.push(["recover", mode]);
    return { status: "rendered", planSha256: "d".repeat(64), artifact: x.artifact }; };
  await x.restart();
  assert.equal((await x.f.pump("run_vm")).state, "delivery_pending");
  assert.equal(x.calls.filter(([kind]) => kind === "render").length, 1);
  assert.deepEqual(x.calls.filter(([kind]) => kind === "recover"), [["recover", "render"]]);
});

test("missing recovery evidence remains visible and never reruns the process", async (t) => {
  const x = await fixture(t); await x.f.register({ taskId: "task_vm" }); x.setApproval("ready");
  await x.f.pump("run_vm");
  x.db.prepare("UPDATE vm_pmo_runs SET state = 'rendering', lease_token = NULL, lease_until = NULL WHERE run_id = ?").run("run_vm");
  await x.restart();
  const failed = await x.f.pump("run_vm");
  assert.equal(failed.state, "needs_attention"); assert.equal(failed.errorCode, "VM_PMO_RUN_OUTCOME_UNKNOWN");
  assert.equal(x.calls.filter(([kind]) => kind === "render").length, 1);
});

test("a second worker cannot execute a run while its durable lease is owned", async (t) => {
  const x = await fixture(t); await x.f.register({ taskId: "task_vm" }); x.setApproval("ready");
  x.db.prepare("UPDATE vm_pmo_runs SET lease_token = 'other', lease_until = ? WHERE run_id = ?")
    .run(1_700_000_030_000, "run_vm");
  assert.equal((await x.f.pump("run_vm")).state, "waiting_materials");
  assert.equal(x.calls.some(([kind]) => kind === "slot"), false);
});

test("a cancelled automatic policy blocks approval side effects and never backfills", async (t) => {
  const x = await fixture(t); await x.f.register({ taskId: "task_vm" });
  let enabled = false;
  x.dependencies.canExecute = async () => {
    if (!enabled) { const error = new Error("disabled"); error.code = "AUTOMATIC_EXECUTION_DISABLED"; throw error; }
    return true;
  };
  await x.restart();
  const canceled = await x.f.pump("run_vm");
  assert.equal(canceled.state, "blocked"); assert.equal(canceled.errorCode, "AUTOMATIC_EXECUTION_DISABLED");
  assert.equal(x.calls.some(([kind]) => kind === "reconcile"), false);
  enabled = true; x.advance(10_000);
  assert.equal((await x.f.pump("run_vm")).state, "blocked");
  assert.equal(x.calls.some(([kind]) => kind === "slot"), false);
});

test("completion requires the frozen attachment field and is revalidated after restart", async (t) => {
  const x = await fixture(t); await x.f.register({ taskId: "task_vm" }); x.setApproval("ready");
  await x.f.pump("run_vm");
  x.setDelivery({ runId: "run_vm", taskId: "task_vm", artifactId: "artifact_vm", state: "delivered",
    fileToken: "file_vm", target: { baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm", fieldId: "fld_other" } });
  assert.equal((await x.f.pump("run_vm")).state, "blocked");
  assert.equal(x.calls.some(([kind]) => kind === "completed"), false);
});

test("unknown or corrupted stored payload fields fail closed", async (t) => {
  const x = await fixture(t); await x.f.register({ taskId: "task_vm" });
  const row = x.db.prepare("SELECT payload_json FROM vm_pmo_runs WHERE run_id = ?").get("run_vm");
  x.db.prepare("UPDATE vm_pmo_runs SET payload_json = ? WHERE run_id = ?")
    .run(JSON.stringify({ ...JSON.parse(row.payload_json), state: "completed" }), "run_vm");
  assert.throws(() => x.f.get("run_vm"), { code: "VM_PMO_STATE_INVALID" });
  assert.equal(x.calls.some(([kind]) => kind === "slot"), false);
});

test("preparation retries stop after a finite persisted budget", async (t) => {
  const x = await fixture(t); await x.f.register({ taskId: "task_vm" }); x.setApproval("ready");
  x.dependencies.prepareInput = async () => { const error = new Error("temporary"); error.code = "VM_PMO_PREPARE_UNAVAILABLE"; throw error; };
  await x.restart();
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await x.f.pump("run_vm");
    assert.equal(result.attemptCount, attempt);
    assert.equal(result.state, attempt === 8 ? "needs_attention" : "preparing");
    x.advance(300_001);
    if (attempt === 3) await x.restart();
  }
  assert.equal((await x.f.pump("run_vm")).attemptCount, 8);
  assert.equal(x.calls.some(([kind]) => kind === "slot"), false);
});

test("corrupted persisted render evidence is rejected before artifact registration", async (t) => {
  const x = await fixture(t); await x.f.register({ taskId: "task_vm" }); x.setApproval("ready");
  await x.f.pump("run_vm");
  const row = x.db.prepare("SELECT payload_json FROM vm_pmo_runs WHERE run_id = ?").get("run_vm");
  const payload = JSON.parse(row.payload_json);
  payload.renderResult.artifact.full_decode_passed = false;
  x.db.prepare("UPDATE vm_pmo_runs SET state = 'rendered', payload_json = ? WHERE run_id = ?")
    .run(JSON.stringify(payload), "run_vm");
  assert.throws(() => x.f.get("run_vm"), { code: "VM_PMO_STATE_INVALID" });
});
