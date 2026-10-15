import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createVmApprovalStore } from "../server/vm-approval-store.mjs";
import { enqueueVmApproval, summarizeVmApproval } from "../server/vm-approval-workflow.mjs";
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
  };
  const packageSnapshot = { packageAlias: "auto-cut-slicing", packageRevision: 2, workflowTemplate: TEMPLATE };
  let vmid = VMID;
  let approvalEnqueues = 0;
  let verifyCalls = 0;
  const adapter = {
    lookup: ({ requestFingerprint, jobId }) => {
      const job = approvalStore.list().find((candidate) => candidate.request_fingerprint === requestFingerprint);
      if (!job || (jobId && job.id !== jobId)) return null;
      return { ...summarizeVmApproval(job, { includeLocalRequest: true }), requestFingerprint: job.request_fingerprint };
    },
    enqueue: (input) => {
      approvalEnqueues++;
      const job = enqueueVmApproval(approvalStore, {
        schema_version: 1, vmid: input.vmids[0], department: input.department, reason: input.reason,
        output_root: input.outputRoot, allowed_origins: ["https://vm-resource.yangcong345.com"],
        private_endpoints: [],
      }, { now: () => 1_000_000 });
      return { jobs: [summarizeVmApproval(job, { includeLocalRequest: true })] };
    },
    wake: () => {},
  };
  const database = {
    get database() { return taskDb; },
    getTask: () => task,
    getFeishuTaskOrigin: () => origin,
    getFeishuTaskPackageSnapshot: () => packageSnapshot,
  };
  const create = () => createVmTaskDownloadBindings({
    database, approval: adapter, now: () => 1_000_000,
    resolveRequest: () => ({ schema_version: 1, vmid, department: "动画组", reason: "切片剪辑",
      output_root: directory, allowed_origins: ["https://vm-resource.yangcong345.com"], private_endpoints: [] }),
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
  f.setVmid("678465c3d94605d24bb9361b");
  await assert.rejects(f.service.reserve("task-1"), { code: "VM_TASK_BINDING_CONFLICT" });
  f.setVmid(VMID);
  f.origin.configVersion = 5;
  await assert.rejects(f.service.reserve("task-1"), { code: "VM_TASK_BINDING_CONFLICT" });
  assert.equal(f.approvalStore.list().length, 0);
});

test("restart after queue insertion reconciles the exact existing approval job", async (t) => {
  const f = await fixture(t);
  const reserved = await f.service.reserve("task-1");
  f.adapter.enqueue({ vmids: [VMID], department: "动画组", reason: "切片剪辑", outputRoot: f.directory });
  f.restart();
  const linked = await f.service.reconcile("task-1");
  assert.equal(linked.runId, reserved.runId);
  assert.equal(linked.approvalJobId, f.approvalStore.list()[0].id);
  assert.equal(f.approvalEnqueues, 1);
  assert.equal(f.approvalStore.list().length, 1);
  assert.deepEqual(await f.service.reconcile("task-1"), linked);
  assert.equal(f.approvalEnqueues, 1);
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
  const ready = await f.service.status("task-1");
  assert.equal(ready.status, "ready");
  assert.equal(ready.acquisition.sha256, "a".repeat(64));
  assert.equal(f.verifyCalls, 1);
  job.acquisition.sha256 = "b".repeat(64);
  const altered = f.approvalStore.claim(job.id);
  f.approvalStore.save(job.id, altered.leaseToken, { ...altered.job, acquisition: job.acquisition });
  await assert.rejects(f.service.status("task-1"), { code: "VM_TASK_ACQUISITION_INVALID" });
});
