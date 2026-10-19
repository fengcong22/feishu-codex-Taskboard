import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createVmApprovalStore } from "../server/vm-approval-store.mjs";
import { enqueueVmApproval, summarizeVmApproval, vmApprovalJobIdForTaskRun } from "../server/vm-approval-workflow.mjs";
import { createVmTaskDownloadBindings } from "../server/vm-task-download-bindings.mjs";

const VMID = "678465c3d94605d24bb9361a";
const TEMPLATE = { id: "vm_pmo_review_video", version: 1 };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-task-bindings-"));
  const taskFile = path.join(directory, "taskboard.sqlite");
  const approvalFile = path.join(directory, "approval.sqlite");
  let taskDb = new DatabaseSync(taskFile);
  let approvalStore = createVmApprovalStore({ file: approvalFile, now: () => 1_000_000 });
  taskDb.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY);");
  taskDb.prepare("INSERT INTO tasks (id) VALUES (?)").run("task-1");
  const task = { id: "task-1", status: "todo", archivedAt: null, labels: ["feishu"] };
  const origin = {
    source: "feishu-base", packageSource: "subject-config", eventId: "event-1",
    subjectKey: "base-1:table-1", baseToken: "base-1", tableId: "table-1", recordId: "record-1",
    configVersion: 4, stageId: "initial", packageAlias: "auto-cut-slicing", executionMode: "manual",
    stageSnapshot: { vmContext: { vmid: VMID }, vmWorkflow: { approval: { department: "动画组", reason: "切片剪辑" } } },
  };
  const packageSnapshot = { packageAlias: "auto-cut-slicing", packageRevision: 2, workflowTemplate: TEMPLATE };
  const tasks = new Map([["task-1", task]]);
  const origins = new Map([["task-1", origin]]);
  const snapshots = new Map([["task-1", packageSnapshot]]);
  let vmid = VMID;
  let outputRoot = directory;
  let privateEndpoints = [];
  let approvalEnqueues = 0;
  let verifyCalls = 0;
  const adapter = {
    lookup: ({ requestFingerprint, jobId }) => {
      const job = jobId ? approvalStore.get(jobId)
        : approvalStore.list().find((candidate) => candidate.request_fingerprint === requestFingerprint);
      if (!job || (jobId && job.id !== jobId)) return null;
      return { ...summarizeVmApproval(job, { includeLocalRequest: true }), requestFingerprint: job.request_fingerprint };
    },
    lookupTaskRun: ({ jobId }) => {
      const job = approvalStore.get(jobId);
      return job ? { ...summarizeVmApproval(job, { includeLocalRequest: true }),
        requestFingerprint: job.request_fingerprint, request: structuredClone(job.request) } : null;
    },
    enqueue: (input, scope) => {
      approvalEnqueues++;
      const job = enqueueVmApproval(approvalStore, {
        schema_version: 1, vmid: input.vmids[0], department: input.department, reason: input.reason,
        output_root: input.outputRoot, allowed_origins: ["https://vm-resource.yangcong345.com"],
        private_endpoints: structuredClone(privateEndpoints),
      }, { ...(scope ? { id: vmApprovalJobIdForTaskRun(scope.taskId, scope.runId), dedupeByRequest: false } : {}),
        now: () => 1_000_000 });
      return { jobs: [summarizeVmApproval(job, { includeLocalRequest: true })] };
    },
    wake: () => {},
  };
  const database = {
    get database() { return taskDb; },
    getTask: (id) => tasks.get(id) ?? null,
    getFeishuTaskOrigin: (id) => origins.get(id) ?? null,
    getFeishuTaskPackageSnapshot: (id) => snapshots.get(id) ?? null,
  };
  const create = () => createVmTaskDownloadBindings({
    database, approval: adapter, now: () => 1_000_000,
    resolveRequest: () => ({ schema_version: 1, vmid, department: "动画组", reason: "切片剪辑",
      output_root: outputRoot, allowed_origins: ["https://vm-resource.yangcong345.com"],
      private_endpoints: structuredClone(privateEndpoints) }),
    verifyAcquisition: async (receiptPath) => {
      verifyCalls++;
      return { receipt_path: receiptPath, path: path.join(directory, "source.mp4"), sha256: "a".repeat(64),
        bytes: 100, duration_ms: 2000, width: 1280, height: 720, vmid_binding: "vm_api_verified" };
    },
  });
  let service = create();
  t.after(async () => { approvalStore.close(); taskDb.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, task, origin, packageSnapshot, adapter,
    get serviceDatabase() { return taskDb; },
    get service() { return service; }, get approvalStore() { return approvalStore; },
    get approvalEnqueues() { return approvalEnqueues; }, get verifyCalls() { return verifyCalls; },
    setVmid(value) { vmid = value; },
    setOutputRoot(value) { outputRoot = value; },
    setPrivateEndpoints(value) { privateEndpoints = structuredClone(value); },
    addTask(id = "task-2") {
      const nextTask = { ...task, id };
      const nextOrigin = { ...origin, eventId: `event-${id}`, recordId: `record-${id}` };
      const nextSnapshot = structuredClone(packageSnapshot);
      taskDb.prepare("INSERT INTO tasks (id) VALUES (?)").run(id);
      tasks.set(id, nextTask); origins.set(id, nextOrigin); snapshots.set(id, nextSnapshot);
      return { task: nextTask, origin: nextOrigin, packageSnapshot: nextSnapshot };
    },
    recreate() { service = create(); },
    restart() { taskDb.close(); taskDb = new DatabaseSync(taskFile); approvalStore.close(); approvalStore = createVmApprovalStore({ file: approvalFile, now: () => 1_000_000 }); service = create(); },
  };
}

test("only a trusted production initial VM task can reserve a download", async (t) => {
  const f = await fixture(t);
  f.origin.deliverySource = "simulation";
  await assert.rejects(f.service.reserve("task-1"), { code: "VM_TASK_NOT_ELIGIBLE" });
  f.origin.deliverySource = "unexpected-source";
  await assert.rejects(f.service.reserve("task-1"), { code: "VM_TASK_NOT_ELIGIBLE" });
  delete f.origin.deliverySource;
  f.packageSnapshot.workflowTemplate = { id: "document_draft_zip", version: 1 };
  await assert.rejects(f.service.reserve("task-1"), { code: "VM_TASK_NOT_ELIGIBLE" });
  f.packageSnapshot.workflowTemplate = TEMPLATE;
  f.task.labels = [];
  await assert.rejects(f.service.reserve("task-1"), { code: "VM_TASK_NOT_ELIGIBLE" });
  assert.equal(f.approvalStore.list().length, 0);
});

test("reservation is durable and cannot change its VMID, config or task identity", async (t) => {
  const f = await fixture(t);
  const first = await f.service.reserve("task-1");
  assert.equal(first.taskId, "task-1");
  assert.equal(first.vmid, VMID);
  assert.equal(first.approvalJobId, null);
  assert.equal(f.approvalEnqueues, 0);
  f.restart();
  assert.deepEqual(await f.service.reserve("task-1"), first);
  f.setOutputRoot(path.join(f.directory, "changed-output"));
  assert.deepEqual(await f.service.reserve("task-1"), first);
  f.setOutputRoot(f.directory);
  f.setVmid(VMID);
  f.origin.stageSnapshot.vmContext.vmid = "678465c3d94605d24bb9361b";
  await assert.rejects(f.service.status("task-1"), { code: "VM_TASK_BINDING_CONFLICT" });
  f.origin.stageSnapshot.vmContext.vmid = VMID;
  f.origin.configVersion = 5;
  await assert.rejects(f.service.reserve("task-1"), { code: "VM_TASK_BINDING_CONFLICT" });
  assert.equal(f.approvalStore.list().length, 0);
});

test("restart after queue insertion reconciles the exact existing approval job", async (t) => {
  const f = await fixture(t);
  const reserved = await f.service.reserve("task-1");
  const legacyJob = f.adapter.enqueue({ vmids: [VMID], department: "动画组", reason: "切片剪辑", outputRoot: f.directory }).jobs[0];
  f.restart();
  const linked = await f.service.reconcile("task-1");
  assert.equal(linked.runId, reserved.runId);
  assert.equal(linked.approvalJobId, legacyJob.id);
  assert.equal(f.approvalEnqueues, 1);
  assert.equal(f.approvalStore.list().length, 1);
  assert.deepEqual(await f.service.reconcile("task-1"), linked);
  assert.equal(f.approvalEnqueues, 1);
});

test("a new task run can apply for the same VMID while replay of that run reuses its own job", async (t) => {
  const f = await fixture(t);
  await f.service.reserve("task-1");
  const legacyJob = f.adapter.enqueue({ vmids: [VMID], department: "动画组", reason: "切片剪辑", outputRoot: f.directory }).jobs[0];
  const first = await f.service.reconcile("task-1");
  assert.equal(first.approvalJobId, legacyJob.id);
  const firstClaim = f.approvalStore.claim(first.approvalJobId);
  f.approvalStore.save(first.approvalJobId, firstClaim.leaseToken,
    { ...firstClaim.job, status: "canceled", last_error: "VM_APPROVAL_CANCELED" });

  const secondTask = f.addTask();
  const secondReservation = await f.service.reserve(secondTask.task.id);
  const second = await f.service.reconcile(secondTask.task.id);
  assert.equal(secondReservation.vmid, VMID);
  assert.notEqual(secondReservation.runId, first.runId);
  assert.notEqual(second.approvalJobId, first.approvalJobId);
  assert.equal(f.approvalStore.get(second.approvalJobId).request_fingerprint,
    f.approvalStore.get(first.approvalJobId).request_fingerprint);

  const linked = f.serviceDatabase.prepare("SELECT run_id FROM vm_task_download_bindings WHERE task_id = ?")
    .get(secondTask.task.id);
  f.serviceDatabase.prepare("UPDATE vm_task_download_bindings SET approval_job_id = NULL WHERE task_id = ?")
    .run(secondTask.task.id);
  const replayed = await f.service.reconcile(secondTask.task.id);
  assert.equal(replayed.runId, linked.run_id);
  assert.equal(replayed.approvalJobId, second.approvalJobId);
  assert.equal(f.approvalStore.list().length, 2);
});

test("opening legacy duplicate task bindings gives one task the shared approval and separates the others", async (t) => {
  const f = await fixture(t);
  await f.service.reserve("task-1");
  const first = await f.service.reconcile("task-1");
  const secondTask = f.addTask();
  await f.service.reserve(secondTask.task.id);
  const second = await f.service.reconcile(secondTask.task.id);
  assert.notEqual(first.approvalJobId, second.approvalJobId);

  const uniqueIndex = f.serviceDatabase.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'index' AND name = 'vm_task_download_approval_job_unique'`).get();
  if (uniqueIndex) f.serviceDatabase.exec("DROP INDEX vm_task_download_approval_job_unique");
  f.serviceDatabase.prepare("UPDATE vm_task_download_bindings SET approval_job_id = ? WHERE task_id = ?")
    .run(first.approvalJobId, secondTask.task.id);

  f.recreate();
  const taskOne = f.serviceDatabase.prepare("SELECT approval_job_id FROM vm_task_download_bindings WHERE task_id = ?")
    .get("task-1");
  const taskTwo = f.serviceDatabase.prepare("SELECT approval_job_id FROM vm_task_download_bindings WHERE task_id = ?")
    .get(secondTask.task.id);
  assert.equal(taskOne.approval_job_id, first.approvalJobId);
  assert.equal(taskTwo.approval_job_id, null);

  const recovered = await f.service.reconcile(secondTask.task.id);
  assert.equal(recovered.approvalJobId, second.approvalJobId);
  assert.notEqual(recovered.approvalJobId, first.approvalJobId);
  assert.equal(f.approvalEnqueues, 2);
});

test("reconcile enqueues once, but archived or changed tasks never enqueue", async (t) => {
  const f = await fixture(t);
  await f.service.reserve("task-1");
  f.task.archivedAt = "2026-10-14T00:00:00.000Z";
  await assert.rejects(f.service.reconcile("task-1"), { code: "VM_TASK_NOT_ELIGIBLE" });
  assert.equal(f.approvalEnqueues, 0);
  f.task.archivedAt = null;
  f.origin.recordId = "record-2";
  await assert.rejects(f.service.reconcile("task-1"), { code: "VM_TASK_BINDING_CONFLICT" });
  assert.equal(f.approvalEnqueues, 0);
  f.origin.recordId = "record-1";
  const linked = await f.service.reconcile("task-1");
  assert.ok(linked.approvalJobId);
  assert.equal(f.approvalEnqueues, 1);
  assert.equal(f.task.status, "todo");
});

test("an archive during approval lookup prevents a late enqueue", async (t) => {
  const f = await fixture(t);
  await f.service.reserve("task-1");
  f.adapter.lookup = async () => {
    f.task.archivedAt = "2026-10-14T00:00:00.000Z";
    return null;
  };
  await assert.rejects(f.service.reconcile("task-1"), { code: "VM_TASK_NOT_ELIGIBLE" });
  assert.equal(f.approvalEnqueues, 0);
});

test("an archive while resolving the VMID prevents reservation", async (t) => {
  const f = await fixture(t);
  const service = createVmTaskDownloadBindings({
    database: { database: f.serviceDatabase, getTask: () => f.task,
      getFeishuTaskOrigin: () => f.origin, getFeishuTaskPackageSnapshot: () => f.packageSnapshot },
    approval: f.adapter,
    resolveRequest: async () => {
      f.task.archivedAt = "2026-10-14T00:00:00.000Z";
      return { schema_version: 1, vmid: VMID, department: "动画组", reason: "切片剪辑",
        output_root: f.directory, allowed_origins: ["https://vm-resource.yangcong345.com"], private_endpoints: [] };
    },
  });
  await assert.rejects(service.reserve("task-1"), { code: "VM_TASK_NOT_ELIGIBLE" });
  assert.equal(f.approvalStore.list().length, 0);
});

test("an approval adapter cannot link a job with a different frozen request", async (t) => {
  const f = await fixture(t);
  await f.service.reserve("task-1");
  const original = f.adapter.lookup;
  f.adapter.lookup = async (query) => {
    const job = original(query);
    return job && { ...job, requestFingerprint: "b".repeat(64) };
  };
  f.adapter.enqueue({ vmids: [VMID], department: "动画组", reason: "切片剪辑", outputRoot: f.directory });
  await assert.rejects(f.service.reconcile("task-1"), { code: "VM_TASK_APPROVAL_JOB_MISMATCH" });
  assert.equal((await f.service.reserve("task-1")).approvalJobId, null);
});

test("ready status verifies the bound acquisition and rejects unrelated queue results", async (t) => {
  const f = await fixture(t);
  await f.service.reserve("task-1");
  const linked = await f.service.reconcile("task-1");
  assert.equal((await f.service.status("task-1")).status, "queued");
  const claim = f.approvalStore.claim(linked.approvalJobId);
  const job = claim.job;
  job.status = "ready";
  job.application_id = "application-1";
  job.instance_code = "instance-1";
  job.acquisition = { receipt_path: path.join(f.directory, "acquisition.json"), path: path.join(f.directory, "source.mp4"),
    sha256: "a".repeat(64), bytes: 100, duration_ms: 2000, width: 1280, height: 720, vmid_binding: "vm_api_verified" };
  f.approvalStore.save(job.id, claim.leaseToken, job);
  f.setOutputRoot(path.join(f.directory, "changed-output"));
  const replayed = await f.service.reconcile("task-1");
  assert.equal(replayed.approvalJobId, linked.approvalJobId);
  assert.equal(f.approvalStore.list().length, 1);
  const ready = await f.service.status("task-1");
  assert.equal(ready.status, "ready");
  assert.equal(ready.acquisition.sha256, "a".repeat(64));
  assert.equal(f.verifyCalls, 1);
  job.acquisition.sha256 = "b".repeat(64);
  const altered = f.approvalStore.claim(job.id);
  f.approvalStore.save(job.id, altered.leaseToken, { ...altered.job, acquisition: job.acquisition });
  await assert.rejects(f.service.status("task-1"), { code: "VM_TASK_ACQUISITION_INVALID" });
});

test("a task-run approval with only historical private endpoint drift can recover after receipt verification", async (t) => {
  const f = await fixture(t);
  const reservation = await f.service.reserve("task-1");
  const endpoint = { origin: "https://vm-resource.yangcong345.com", addresses: ["10.8.8.11"] };
  f.setPrivateEndpoints([endpoint]);
  const approval = f.adapter.enqueue({ vmids: [VMID], department: "动画组", reason: "切片剪辑",
    outputRoot: f.directory }, { taskId: "task-1", runId: reservation.runId }).jobs[0];
  const claim = f.approvalStore.claim(approval.id);
  const receiptPath = path.join(f.directory, "acquisition.json");
  f.approvalStore.save(approval.id, claim.leaseToken, {
    ...claim.job, status: "ready", application_id: "application-1", instance_code: "instance-1",
    acquisition: { receipt_path: receiptPath, path: path.join(f.directory, "source.mp4"),
      sha256: "a".repeat(64), bytes: 100, duration_ms: 2000, width: 1280, height: 720,
      vmid_binding: "vm_api_verified" },
  });
  f.serviceDatabase.prepare("UPDATE vm_task_download_bindings SET approval_job_id = ? WHERE task_id = ?")
    .run(approval.id, "task-1");
  const linked = f.adapter.lookupTaskRun({ jobId: approval.id });
  assert.equal(approval.id, vmApprovalJobIdForTaskRun("task-1", reservation.runId));
  assert.equal(linked.status, "ready");
  assert.deepEqual({ ...linked.request, private_endpoints: [] },
    { ...JSON.parse(f.serviceDatabase.prepare("SELECT request_json FROM vm_task_download_bindings WHERE task_id = ?")
      .get("task-1").request_json), private_endpoints: [] });

  const status = await f.service.status("task-1");
  assert.equal(status.status, "ready");
  assert.equal(status.approvalJobId, approval.id);
  assert.equal(status.acquisition.sha256, "a".repeat(64));
  assert.equal(f.verifyCalls, 1);
  assert.equal(f.approvalEnqueues, 1);
  const migrated = f.serviceDatabase.prepare("SELECT request_sha256,request_json FROM vm_task_download_bindings WHERE task_id = ?")
    .get("task-1");
  assert.equal(migrated.request_sha256, f.approvalStore.get(approval.id).request_fingerprint);
  assert.deepEqual(JSON.parse(migrated.request_json).private_endpoints, [endpoint]);
});
