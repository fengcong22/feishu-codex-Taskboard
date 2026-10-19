import { createHash, randomUUID } from "node:crypto";

import { validateVmApprovalRequest, verifyVmAcquisitionReceipt, vmApprovalJobIdForTaskRun } from "./vm-approval-workflow.mjs";

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
function requestWithoutPrivateEndpoints(request) {
  const { private_endpoints: _privateEndpoints, ...rest } = request;
  return rest;
}
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
 * resolveRequest reads trusted task/profile data and local settings once; later checks use
 * the saved request and task identity rather than allowing settings changes to retarget a run.
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
  const approvalOwner = db.prepare(`SELECT task_id FROM vm_task_download_bindings
    WHERE approval_job_id = ? AND task_id <> ? LIMIT 1`);
  const duplicateApprovals = db.prepare(`SELECT approval_job_id FROM vm_task_download_bindings
    WHERE approval_job_id IS NOT NULL GROUP BY approval_job_id HAVING COUNT(*) > 1`);
  const approvalOwnerForMigration = db.prepare(`SELECT task_id FROM vm_task_download_bindings
    WHERE approval_job_id = ? ORDER BY created_at, task_id LIMIT 1`);
  const releaseDuplicateApproval = db.prepare(`UPDATE vm_task_download_bindings
    SET approval_job_id = NULL, updated_at = ? WHERE approval_job_id = ? AND task_id <> ?`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const duplicates = duplicateApprovals.all();
    if (duplicates.length) {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail("VM_TASK_BINDING_INVALID");
      for (const { approval_job_id: jobId } of duplicates) {
        const owner = approvalOwnerForMigration.get(jobId);
        if (!owner) fail("VM_TASK_BINDING_INVALID");
        releaseDuplicateApproval.run(timestamp, jobId, owner.task_id);
      }
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS vm_task_download_approval_job_unique
      ON vm_task_download_bindings(approval_job_id) WHERE approval_job_id IS NOT NULL`);
    const ownershipIndex = db.prepare("PRAGMA index_list(vm_task_download_bindings)").all()
      .find((index) => index.name === "vm_task_download_approval_job_unique");
    if (ownershipIndex?.unique !== 1 || ownershipIndex.partial !== 1
      || db.prepare("PRAGMA index_info(vm_task_download_approval_job_unique)").all()
        .map((column) => column.name).join(",") !== "approval_job_id") fail("VM_TASK_BINDING_INVALID");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }

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
  function currentIdentity(taskId) {
    const task = database.getTask(taskId);
    const origin = database.getFeishuTaskOrigin(taskId);
    const snapshot = database.getFeishuTaskPackageSnapshot(taskId);
    if (!validIdentity(task, origin, snapshot)) fail("VM_TASK_NOT_ELIGIBLE");
    return { task, origin, snapshot, identityHash: digest(identityFor(origin, snapshot)) };
  }
  function requestMatchesTask(request, origin) {
    const vmWorkflow = origin?.stageSnapshot?.vmWorkflow;
    return request.vmid === origin?.stageSnapshot?.vmContext?.vmid
      && request.department === vmWorkflow?.approval?.department
      && request.reason === vmWorkflow?.approval?.reason;
  }
  async function current(taskId) {
    const current = currentIdentity(taskId);
    const { task, origin, snapshot, identityHash } = current;
    const request = validateVmApprovalRequest(await resolveRequest({ task, origin, packageSnapshot: snapshot }));
    if (!requestMatchesTask(request, origin)) fail("VM_TASK_BINDING_CONFLICT");
    const latest = currentIdentity(taskId);
    if (identityHash !== latest.identityHash || !requestMatchesTask(request, latest.origin)) fail("VM_TASK_BINDING_CONFLICT");
    return { identityHash, request, requestHash: digest(request) };
  }
  async function checked(taskId) {
    const binding = read(taskId);
    if (!binding) fail("VM_TASK_BINDING_NOT_FOUND");
    const expected = currentIdentity(taskId);
    if (binding.row.identity_sha256 !== expected.identityHash || !requestMatchesTask(binding.request, expected.origin)) {
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
  async function recoverPrivateEndpointDrift(taskId, binding) {
    const jobId = binding.row.approval_job_id;
    if (!jobId || jobId !== vmApprovalJobIdForTaskRun(taskId, binding.row.run_id)
      || typeof approval.lookupTaskRun !== "function") return null;
    const job = await approval.lookupTaskRun({ jobId });
    if (!job || job.id !== jobId || job.status !== "ready" || !job.request
      || typeof job.request !== "object" || Array.isArray(job.request)) return null;
    let request;
    try { request = validateVmApprovalRequest(job.request); }
    catch { return null; }
    if (job.requestFingerprint !== digest(request)
      || JSON.stringify(requestWithoutPrivateEndpoints(request))
        !== JSON.stringify(requestWithoutPrivateEndpoints(binding.request))
      || JSON.stringify(request.private_endpoints) === JSON.stringify(binding.request.private_endpoints)
      || !requestMatchesTask(request, currentIdentity(taskId).origin)) return null;
    const acquisition = job.acquisition;
    if (!acquisition?.receipt_path || !job.application_id || !job.instance_code) return null;
    let verified;
    try {
      verified = await verifyAcquisition(acquisition.receipt_path, {
        vmid: request.vmid, applicationId: job.application_id, instanceCode: job.instance_code,
      });
    } catch { fail("VM_TASK_ACQUISITION_INVALID"); }
    if (verified.vmid_binding !== "vm_api_verified" || ["receipt_path", "path", "sha256", "bytes", "duration_ms"]
      .some((key) => verified[key] !== acquisition[key])) fail("VM_TASK_ACQUISITION_INVALID");

    const latest = await checked(taskId);
    if (latest.row.run_id !== binding.row.run_id || latest.row.approval_job_id !== jobId
      || latest.row.request_sha256 !== binding.row.request_sha256) fail("VM_TASK_BINDING_CONFLICT");
    const requestJson = JSON.stringify(request);
    const requestHash = digest(request);
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail("VM_TASK_BINDING_INVALID");
    db.exec("BEGIN IMMEDIATE");
    try {
      const changed = db.prepare(`UPDATE vm_task_download_bindings SET request_sha256 = ?,request_json = ?,updated_at = ?
        WHERE task_id = ? AND run_id = ? AND identity_sha256 = ? AND request_sha256 = ? AND approval_job_id = ?`)
        .run(requestHash, requestJson, timestamp, taskId, binding.row.run_id, binding.row.identity_sha256,
          binding.row.request_sha256, jobId);
      if (changed.changes !== 1) fail("VM_TASK_BINDING_CONFLICT");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const migrated = await checked(taskId);
    if (migrated.row.request_sha256 !== job.requestFingerprint) fail("VM_TASK_BINDING_CONFLICT");
    return { binding: migrated, job, acquisition: verified };
  }
  function linkIfUnclaimed(taskId, binding, jobId) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = read(taskId);
      if (!existing || existing.row.identity_sha256 !== binding.row.identity_sha256
        || existing.row.request_sha256 !== binding.row.request_sha256) fail("VM_TASK_BINDING_CONFLICT");
      if (existing.row.approval_job_id) {
        db.exec("COMMIT");
        return existing.row.approval_job_id === jobId;
      }
      if (approvalOwner.get(jobId, taskId)) {
        db.exec("COMMIT");
        return false;
      }
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail("VM_TASK_BINDING_INVALID");
      const result = link.run(jobId, timestamp, taskId, binding.row.identity_sha256, binding.row.request_sha256);
      if (result.changes !== 1) fail("VM_TASK_BINDING_CONFLICT");
      db.exec("COMMIT");
      return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return {
    async reserve(taskId) {
      let binding = read(taskId);
      if (binding) {
        const expected = currentIdentity(taskId);
        if (binding.row.identity_sha256 !== expected.identityHash || !requestMatchesTask(binding.request, expected.origin)) {
          fail("VM_TASK_BINDING_CONFLICT");
        }
        return summary(binding.row, binding.request);
      }
      const value = await current(taskId);
      db.exec("BEGIN IMMEDIATE");
      try {
        binding = read(taskId);
        if (!binding) {
          const timestamp = now();
          if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail("VM_TASK_BINDING_INVALID");
          insert.run(taskId, randomUUID(), value.identityHash, value.requestHash,
            JSON.stringify(value.request), timestamp, timestamp);
          binding = read(taskId);
        }
        const latest = currentIdentity(taskId);
        if (binding.row.identity_sha256 !== latest.identityHash || !requestMatchesTask(binding.request, latest.origin)) {
          fail("VM_TASK_BINDING_CONFLICT");
        }
        db.exec("COMMIT");
        return summary(binding.row, binding.request);
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async reconcile(taskId) {
      let binding = await checked(taskId);
      const taskRunJobId = vmApprovalJobIdForTaskRun(taskId, binding.row.run_id);
      let job = await approval.lookup({ requestFingerprint: binding.row.request_sha256,
        jobId: binding.row.approval_job_id ?? taskRunJobId });
      if (!job && binding.row.approval_job_id) fail("VM_TASK_APPROVAL_JOB_MISSING");
      if (!job) {
        const legacyJobId = `vm-${binding.row.request_sha256.slice(0, 24)}`;
        const legacyJob = await approval.lookup({ requestFingerprint: binding.row.request_sha256, jobId: legacyJobId });
        if (legacyJob) {
          validateApproval(legacyJob, binding);
          binding = await checked(taskId);
          if (linkIfUnclaimed(taskId, binding, legacyJob.id)) {
            job = legacyJob;
            binding = read(taskId);
          } else {
            binding = read(taskId);
            if (binding.row.approval_job_id) {
              job = await approval.lookup({ requestFingerprint: binding.row.request_sha256,
                jobId: binding.row.approval_job_id });
              if (!job) fail("VM_TASK_APPROVAL_JOB_MISSING");
            }
          }
        }
      }
      if (!job) {
        await checked(taskId);
        const request = binding.request;
        const result = await approval.enqueue({ vmids: [request.vmid], department: request.department,
          reason: request.reason, outputRoot: request.output_root }, { taskId, runId: binding.row.run_id });
        if (!Array.isArray(result?.jobs) || result.jobs.length !== 1 || result.jobs[0]?.id !== taskRunJobId) {
          fail("VM_TASK_APPROVAL_JOB_MISMATCH");
        }
        job = await approval.lookup({ requestFingerprint: binding.row.request_sha256, jobId: taskRunJobId });
      }
      validateApproval(job, binding);
      // The queue may have completed while Taskboard was down. Recheck task and immutable request before linking.
      binding = await checked(taskId);
      if (!binding.row.approval_job_id) {
        if (!linkIfUnclaimed(taskId, binding, job.id)) {
          binding = read(taskId);
          if (!binding.row.approval_job_id) fail("VM_TASK_APPROVAL_JOB_MISMATCH");
          job = await approval.lookup({ requestFingerprint: binding.row.request_sha256,
            jobId: binding.row.approval_job_id });
          if (!job) fail("VM_TASK_APPROVAL_JOB_MISSING");
          validateApproval(job, binding);
        }
      }
      await approval.wake?.();
      binding = read(taskId);
      return summary(binding.row, binding.request);
    },
    async status(taskId) {
      let binding = await checked(taskId);
      let recoveredAcquisition = null;
      if (!binding.row.approval_job_id) return { ...summary(binding.row, binding.request), status: "reserved" };
      let job = await approval.lookup({ requestFingerprint: binding.row.request_sha256,
        jobId: binding.row.approval_job_id });
      if (!job || job.requestFingerprint !== binding.row.request_sha256) {
        const recovered = await recoverPrivateEndpointDrift(taskId, binding);
        if (recovered) {
          binding = recovered.binding;
          job = recovered.job;
          recoveredAcquisition = recovered.acquisition;
        }
      }
      job = validateApproval(job, binding);
      const base = summary(binding.row, binding.request);
      if (job.status !== "ready") return { ...base, status: job.status, ...(job.error ? { error: job.error } : {}) };
      if (!job.acquisition?.receipt_path || !job.application_id || !job.instance_code) fail("VM_TASK_ACQUISITION_INVALID");
      let verified = recoveredAcquisition;
      if (!verified) {
        try {
          verified = await verifyAcquisition(job.acquisition.receipt_path, {
            vmid: binding.request.vmid, applicationId: job.application_id, instanceCode: job.instance_code,
          });
        } catch { fail("VM_TASK_ACQUISITION_INVALID"); }
      }
      if (verified.vmid_binding !== "vm_api_verified" || ["receipt_path", "path", "sha256", "bytes", "duration_ms"]
        .some((key) => verified[key] !== job.acquisition[key])) fail("VM_TASK_ACQUISITION_INVALID");
      await checked(taskId);
      return { ...base, status: "ready", acquisition: verified };
    },
  };
}
