import { createHash, randomUUID } from "node:crypto";

import { validateVmApprovalRequest, verifyVmAcquisitionReceipt } from "./vm-approval-workflow.mjs";

const VM_TEMPLATE = "vm_pmo_review_video";
const ACTIVE_TASK_STATUS = new Set(["todo", "queued"]);

export class VmTaskBindingError extends Error {
  constructor(code) {
    super(code);
    this.name = "VmTaskBindingError";
    this.code = code;
  }
}

function fail(code) { throw new VmTaskBindingError(code); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function identityFor(origin, snapshot) {
  return {
    eventId: origin.eventId, baseToken: origin.baseToken, tableId: origin.tableId,
    recordId: origin.recordId, subjectKey: origin.subjectKey, configVersion: origin.configVersion,
    stageId: origin.stageId, packageAlias: origin.packageAlias,
    packageRevision: snapshot.packageRevision, workflowTemplate: snapshot.workflowTemplate,
  };
}
function validIdentity(task, origin, snapshot) {
  return task?.archivedAt === null && ACTIVE_TASK_STATUS.has(task.status) && task.labels?.includes("feishu")
    && origin?.source === "feishu-base" && origin.packageSource === "subject-config"
    && origin.deliverySource === undefined && origin.stageId === "initial"
    && typeof origin.eventId === "string" && origin.eventId.length > 0
    && typeof origin.baseToken === "string" && origin.baseToken.length > 0
    && typeof origin.tableId === "string" && origin.tableId.length > 0
    && typeof origin.recordId === "string" && origin.recordId.length > 0
    && origin.subjectKey === `${origin.baseToken}:${origin.tableId}`
    && Number.isSafeInteger(origin.configVersion) && origin.configVersion > 0
    && typeof origin.packageAlias === "string" && origin.packageAlias.length > 0
    && snapshot?.packageAlias === origin.packageAlias
    && Number.isSafeInteger(snapshot.packageRevision) && snapshot.packageRevision > 0
    && snapshot.workflowTemplate?.id === VM_TEMPLATE && snapshot.workflowTemplate.version === 1;
}

/**
 * Persist a trusted task's immutable material request before touching the download queue.
 * resolveRequest must read trusted PMO/profile data and local policy, never a task description.
 * approval.lookup must return an exact-match internal job with requestFingerprint;
 * approval.enqueue must use the active VM download service so its worker is woken.
 */
export function createVmTaskDownloadBindings({ database, approval, resolveRequest, verifyAcquisition = verifyVmAcquisitionReceipt,
  now = Date.now } = {}) {
  const db = database?.database;
  if (!db || typeof database.getTask !== "function" || typeof database.getFeishuTaskOrigin !== "function"
    || typeof database.getFeishuTaskPackageSnapshot !== "function" || typeof resolveRequest !== "function"
    || typeof approval?.lookup !== "function" || typeof approval.enqueue !== "function"
    || typeof verifyAcquisition !== "function" || typeof now !== "function") {
    throw new TypeError("VM task bindings require Taskboard storage, trusted request resolution, and a download adapter");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS vm_task_download_bindings (
    task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE,
    identity_sha256 TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    request_json TEXT NOT NULL,
    approval_job_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const select = db.prepare("SELECT * FROM vm_task_download_bindings WHERE task_id = ?");
  const insert = db.prepare(`INSERT INTO vm_task_download_bindings
    (task_id, run_id, identity_sha256, request_sha256, request_json, approval_job_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`);
  const link = db.prepare(`UPDATE vm_task_download_bindings SET approval_job_id = ?, updated_at = ?
    WHERE task_id = ? AND approval_job_id IS NULL AND identity_sha256 = ? AND request_sha256 = ?`);

  function read(taskId) {
    const row = select.get(taskId);
    if (!row) return null;
    let request;
    try {
      request = validateVmApprovalRequest(JSON.parse(row.request_json));
      if (row.request_sha256 !== digest(request) || !/^[a-f0-9]{64}$/u.test(row.identity_sha256)
        || typeof row.run_id !== "string" || !row.run_id || (row.approval_job_id !== null
          && (typeof row.approval_job_id !== "string" || !row.approval_job_id))) fail("VM_TASK_BINDING_INVALID");
    } catch { fail("VM_TASK_BINDING_INVALID"); }
    return { row, request };
  }
  function summary(row, request) {
    return { taskId: row.task_id, runId: row.run_id, vmid: request.vmid,
      approvalJobId: row.approval_job_id, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async function current(taskId) {
    const task = database.getTask(taskId);
    const origin = database.getFeishuTaskOrigin(taskId);
    const snapshot = database.getFeishuTaskPackageSnapshot(taskId);
    if (!validIdentity(task, origin, snapshot)) fail("VM_TASK_NOT_ELIGIBLE");
    const identityHash = digest(identityFor(origin, snapshot));
    const request = validateVmApprovalRequest(await resolveRequest({ task, origin, packageSnapshot: snapshot }));
    const latestTask = database.getTask(taskId);
    const latestOrigin = database.getFeishuTaskOrigin(taskId);
    const latestSnapshot = database.getFeishuTaskPackageSnapshot(taskId);
    if (!validIdentity(latestTask, latestOrigin, latestSnapshot)) fail("VM_TASK_NOT_ELIGIBLE");
    if (identityHash !== digest(identityFor(latestOrigin, latestSnapshot))) fail("VM_TASK_BINDING_CONFLICT");
    return { identityHash, request, requestHash: digest(request) };
  }
  async function checked(taskId) {
    const binding = read(taskId);
    if (!binding) fail("VM_TASK_BINDING_NOT_FOUND");
    const expected = await current(taskId);
    if (binding.row.identity_sha256 !== expected.identityHash || binding.row.request_sha256 !== expected.requestHash) {
      fail("VM_TASK_BINDING_CONFLICT");
    }
    return binding;
  }
  function validateApproval(job, binding) {
    if (!job || typeof job.id !== "string" || !job.id || job.vmid !== binding.request.vmid
      || job.requestFingerprint !== binding.row.request_sha256
      || job.output_root !== binding.request.output_root || job.department !== binding.request.department
      || job.reason !== binding.request.reason
      || (binding.row.approval_job_id && job.id !== binding.row.approval_job_id)) {
      fail("VM_TASK_APPROVAL_JOB_MISMATCH");
    }
    return job;
  }
  return {
    async reserve(taskId) {
      const value = await current(taskId);
      db.exec("BEGIN IMMEDIATE");
      try {
        let binding = read(taskId);
        if (!binding) {
          const timestamp = now();
          if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail("VM_TASK_BINDING_INVALID");
          insert.run(taskId, randomUUID(), value.identityHash, value.requestHash,
            JSON.stringify(value.request), timestamp, timestamp);
          binding = read(taskId);
        }
        if (binding.row.identity_sha256 !== value.identityHash || binding.row.request_sha256 !== value.requestHash) {
          fail("VM_TASK_BINDING_CONFLICT");
        }
        db.exec("COMMIT");
        return summary(binding.row, binding.request);
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async reconcile(taskId) {
      let binding = await checked(taskId);
      const lookup = { requestFingerprint: binding.row.request_sha256, jobId: binding.row.approval_job_id };
      let job = await approval.lookup(lookup);
      if (!job && binding.row.approval_job_id) fail("VM_TASK_APPROVAL_JOB_MISSING");
      if (!job) {
        await checked(taskId);
        const request = binding.request;
        const result = await approval.enqueue({ vmids: [request.vmid], department: request.department,
          reason: request.reason, outputRoot: request.output_root });
        if (!Array.isArray(result?.jobs) || result.jobs.length !== 1) fail("VM_TASK_APPROVAL_JOB_MISMATCH");
        job = await approval.lookup({ requestFingerprint: binding.row.request_sha256, jobId: result.jobs[0]?.id });
      }
      validateApproval(job, binding);
      // The queue may have completed while Taskboard was down. Recheck task and immutable request before linking.
      binding = await checked(taskId);
      if (!binding.row.approval_job_id) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const existing = read(taskId);
          if (!existing || existing.row.identity_sha256 !== binding.row.identity_sha256
            || existing.row.request_sha256 !== binding.row.request_sha256) fail("VM_TASK_BINDING_CONFLICT");
          if (existing.row.approval_job_id && existing.row.approval_job_id !== job.id) fail("VM_TASK_APPROVAL_JOB_MISMATCH");
          if (!existing.row.approval_job_id) link.run(job.id, now(), taskId, binding.row.identity_sha256, binding.row.request_sha256);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      await approval.wake?.();
      binding = read(taskId);
      return summary(binding.row, binding.request);
    },
    async status(taskId) {
      const binding = await checked(taskId);
      const base = summary(binding.row, binding.request);
      if (!binding.row.approval_job_id) return { ...base, status: "reserved" };
      const job = validateApproval(await approval.lookup({ requestFingerprint: binding.row.request_sha256,
        jobId: binding.row.approval_job_id }), binding);
      if (job.status !== "ready") return { ...base, status: job.status, ...(job.error ? { error: job.error } : {}) };
      if (!job.acquisition?.receipt_path || !job.application_id || !job.instance_code) fail("VM_TASK_ACQUISITION_INVALID");
      let verified;
      try {
        verified = await verifyAcquisition(job.acquisition.receipt_path, {
          vmid: binding.request.vmid, applicationId: job.application_id, instanceCode: job.instance_code,
        });
      } catch { fail("VM_TASK_ACQUISITION_INVALID"); }
      if (verified.vmid_binding !== "vm_api_verified" || ["receipt_path", "path", "sha256", "bytes", "duration_ms"]
        .some((key) => verified[key] !== job.acquisition[key])) fail("VM_TASK_ACQUISITION_INVALID");
      await checked(taskId);
      return { ...base, status: "ready", acquisition: verified };
    },
  };
}
