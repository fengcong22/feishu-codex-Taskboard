import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { prepareVmSource, validateVmSourceRequest } from "./vm-source-adapter.mjs";
import { VmSourceError } from "./vm-source-transfer.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const TERMINAL = new Set(["ready", "rejected", "canceled", "needs_attention", "auth_required", "dead_letter"]);
const RETRYABLE = new Set(["VM_API_TIMEOUT", "VM_API_TRANSPORT_FAILED", "VM_API_HTTP_FAILED",
  "VM_API_PAGINATION_INVALID", "VM_API_RESPONSE_INVALID", "VM_API_RESPONSE_TOO_LARGE"]);
const RESOLUTION = Object.freeze({ width: 1280, height: 720 });
const WAIT_MS = 7 * 24 * 60 * 60 * 1000;
function fail(code) { throw new VmSourceError(code); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value, max = 200) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function localPath(value) { return text(value, 4096) && path.isAbsolute(value); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

export function vmApprovalJobIdForTaskRun(taskId, runId) {
  if (typeof taskId !== "string" || !ID.test(taskId) || typeof runId !== "string" || !ID.test(runId)) {
    fail("VM_APPROVAL_REQUEST_INVALID");
  }
  return `vm-${digest(JSON.stringify({ scope: "vm-pmo-task-run", taskId, runId }))}`;
}

export function validateVmApprovalRequest(raw) {
  const keys = ["schema_version", "vmid", "department", "reason", "output_root", "allowed_origins",
    "private_endpoints", "application_id", "reuse_receipt"];
  if (!object(raw) || Object.keys(raw).some((key) => !keys.includes(key)) || raw.schema_version !== 1
    || typeof raw.vmid !== "string" || !/^[a-f0-9]{24}$/u.test(raw.vmid)
    || !text(raw.department, 100) || !text(raw.reason, 500) || !localPath(raw.output_root)
    || (raw.application_id !== undefined && (typeof raw.application_id !== "string" || !ID.test(raw.application_id)))
    || (raw.reuse_receipt !== undefined && (!localPath(raw.reuse_receipt) || !raw.application_id))) {
    fail("VM_APPROVAL_REQUEST_INVALID");
  }
  // Reuse the downloader's trusted-local-network configuration validation.
  try {
    validateVmSourceRequest({ schema_version: 1, vmid: raw.vmid, source: {
      kind: "approved_url", approval_ref: "validation", video_variant: "approved_rendition",
      url: `${raw.allowed_origins?.[0]}/validation.mp4`, allowed_origins: raw.allowed_origins,
      ...(raw.private_endpoints === undefined ? {} : { private_endpoints: raw.private_endpoints }),
    } });
  } catch { fail("VM_APPROVAL_REQUEST_INVALID"); }
  return {
    schema_version: 1, vmid: raw.vmid, department: raw.department, reason: raw.reason,
    output_root: path.resolve(raw.output_root), allowed_origins: [...new Set(raw.allowed_origins)].sort(),
    private_endpoints: structuredClone(raw.private_endpoints ?? []),
    ...(raw.application_id ? { application_id: raw.application_id } : {}),
    ...(raw.reuse_receipt ? { reuse_receipt: path.resolve(raw.reuse_receipt) } : {}),
  };
}

export function enqueueVmApproval(store, raw, { id, dedupeByRequest = true, now = Date.now } = {}) {
  const request = validateVmApprovalRequest(raw);
  const fingerprint = digest(JSON.stringify(request));
  id ??= `vm-${fingerprint.slice(0, 24)}`;
  if (typeof id !== "string" || !ID.test(id) || typeof dedupeByRequest !== "boolean") fail("VM_APPROVAL_REQUEST_INVALID");
  const time = now();
  return store.enqueue({ id, request_fingerprint: fingerprint, request, status: "queued",
    created_at: time, updated_at: time, next_attempt_at: time, attempts: 0,
    submission_attempts: 0, reconciliation_attempts: 0,
    ...(request.application_id ? { application_id: request.application_id } : {}) }, { dedupeByRequest });
}

export function summarizeVmApproval(job, { includeLocalRequest = false } = {}) {
  if (!job) fail("VM_APPROVAL_JOB_NOT_FOUND");
  return { protocol: "vm_approval_workflow", schema_version: 1, id: job.id,
    vmid: job.request.vmid, status: job.status, submission_attempts: job.submission_attempts,
    attempts: job.attempts, next_attempt_at: job.next_attempt_at,
    created_at: job.created_at, updated_at: job.updated_at,
    approval_wait_started_at: job.approval_wait_started_at ?? null,
    approval_deadline_at: job.approval_deadline_at ?? null,
    media_wait_started_at: job.media_wait_started_at ?? null,
    media_deadline_at: job.media_deadline_at ?? null,
    ...(includeLocalRequest ? { output_root: job.request.output_root,
      department: job.request.department, reason: job.request.reason } : {}),
    ...(job.application_id ? { application_id: job.application_id } : {}),
    ...(job.instance_code ? { instance_code: job.instance_code } : {}),
    ...(job.last_error ? { error: { code: job.last_error,
      ...(job.last_error_detail ? { diagnostic_code: job.last_error_detail } : {}) } } : {}),
    ...(job.acquisition ? { acquisition: structuredClone(job.acquisition) } : {}),
  };
}

function identityFrom(response) {
  const identity = response?.raw?.feishu;
  if (!object(identity) || !text(identity.name) || !text(identity.open_id) || !ID.test(identity.open_id)
    || !text(identity.user_id) || !ID.test(identity.user_id) || !text(identity.enterprise_email, 320)
    || !Array.isArray(identity.departments) || !identity.departments.length
    || identity.departments.some((id) => !text(id) || !ID.test(id))) fail("VM_IDENTITY_INVALID");
  return identity;
}

function verifyVideo(response, vmid) {
  if (!object(response) || !Array.isArray(response.videos) || response.videos.length !== 1
    || response.videos[0]?.id !== vmid || response.total !== 1) fail("VM_VIDEO_IDENTITY_MISMATCH");
}

function matchesApplication(application, job) {
  return object(application) && typeof application.id === "string" && ID.test(application.id)
    && application.applyUser?.feishuUserId === job.requester_id
    && application.applyReason === job.request.reason && application.videoUse === "ORIGINAL"
    && application.videoQuality === "HIGH" && Array.isArray(application.urlObjList)
    && application.urlObjList.length === 1 && application.urlObjList[0]?.id === job.request.vmid;
}

function requireBinding(application, job) {
  if (!matchesApplication(application, job) || application.id !== job.application_id
    || !text(application.instanceCode) || !ID.test(application.instanceCode)
    || (job.instance_code && application.instanceCode !== job.instance_code)) fail("VM_APPLICATION_MISMATCH");
}

/** A receipt is reusable only after checking its exact application binding and current file bytes. */
export async function verifyVmAcquisitionReceipt(receiptPath, { vmid, applicationId, instanceCode, allowOperatorReceipt = false }) {
  let handle;
  try {
    const info = await lstat(receiptPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) fail("VM_RECEIPT_INVALID");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const artifact = receipt?.artifact;
    if (receipt.protocol !== "vm_source_acquisition" || receipt.schema_version !== 1
      || receipt.status !== "ready" || receipt.vmid !== vmid
      || receipt.provenance?.approval_ref !== applicationId
      || !localPath(artifact?.path) || path.dirname(artifact.path) !== path.dirname(path.resolve(receiptPath))
      || path.basename(artifact.path) !== "source.mp4" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0
      || artifact.media?.validation?.metadata !== true || artifact.media?.validation?.full_decode !== true
      || !Number.isSafeInteger(artifact.media.duration_ms) || artifact.media.duration_ms <= 0
      || !Array.isArray(artifact.media.video) || !artifact.media.video.length
      || artifact.media.video.some((stream) => !Number.isSafeInteger(stream.width) || stream.width < RESOLUTION.width
        || !Number.isSafeInteger(stream.height) || stream.height < RESOLUTION.height)) fail("VM_RECEIPT_INVALID");
    const provenance = receipt.provenance;
    const apiVerified = provenance.kind === "vm_api_approval" && provenance.vmid_binding === "vm_api_verified"
      && provenance.resource_id === vmid && provenance.approval_status === "APPROVED"
      && provenance.video_quality === "HIGH" && text(provenance.instance_code) && ID.test(provenance.instance_code)
      && (!instanceCode || provenance.instance_code === instanceCode);
    const operatorVerified = allowOperatorReceipt && provenance.kind === "operator_provided_approval"
      && provenance.vmid_binding === "operator_asserted";
    if (!apiVerified && !operatorVerified) fail("VM_RECEIPT_INVALID");
    const before = await lstat(artifact.path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(artifact.bytes)) fail("VM_RECEIPT_INVALID");
    handle = await open(artifact.path, "r");
    const opened = await handle.stat({ bigint: true });
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail("VM_RECEIPT_INVALID");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await lstat(artifact.path, { bigint: true });
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || hash.digest("hex") !== artifact.sha256) fail("VM_RECEIPT_INVALID");
    const video = artifact.media.video[0];
    return { receipt_path: path.resolve(receiptPath), path: artifact.path, sha256: artifact.sha256,
      bytes: artifact.bytes, duration_ms: artifact.media.duration_ms, width: video.width, height: video.height,
      vmid_binding: provenance.vmid_binding };
  } catch (error) {
    if (error instanceof VmSourceError) throw error;
    fail("VM_RECEIPT_INVALID");
  } finally { await handle?.close().catch(() => {}); }
}

export function resumeVmApproval(store, id, { now = Date.now } = {}) {
  const claim = store.claim(id, { leaseMs: 60_000 });
  if (!claim) fail("VM_APPROVAL_JOB_BUSY");
  const job = claim.job;
  if (!["auth_required", "dead_letter"].includes(job.status)) {
    store.save(id, claim.leaseToken, job);
    fail("VM_APPROVAL_NOT_RESUMABLE");
  }
  job.status = job.resume_phase;
  delete job.resume_phase;
  delete job.last_error;
  delete job.last_error_detail;
  job.attempts = 0;
  job.next_attempt_at = now();
  job.updated_at = now();
  return store.save(id, claim.leaseToken, job);
}

function assertNoAcquisitionRecoveryArtifacts(job) {
  try {
    const outputRootInfo = lstatSync(job.request.output_root);
    if (!outputRootInfo.isDirectory() || outputRootInfo.isSymbolicLink()) fail("VM_DOWNLOAD_RECOVERY_PATH_INVALID");
    const outputRoot = realpathSync(job.request.output_root);
    const jobRoot = path.dirname(path.resolve(job.receipt_path));
    const jobRootInfo = lstatSync(jobRoot);
    if (!jobRootInfo.isDirectory() || jobRootInfo.isSymbolicLink()
      || !path.basename(jobRoot).startsWith(`vm-${job.request.vmid}-`)
      || path.basename(path.resolve(job.receipt_path)) !== "acquisition.json") {
      fail("VM_DOWNLOAD_RECOVERY_PATH_INVALID");
    }
    const realJobRoot = realpathSync(jobRoot);
    const relative = path.relative(outputRoot, realJobRoot);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail("VM_DOWNLOAD_RECOVERY_PATH_INVALID");
    }
    for (const filename of ["source.mp4", "source.mp4.part", "acquisition.json", "acquisition.json.part"]) {
      try { lstatSync(path.join(realJobRoot, filename)); fail("VM_DOWNLOAD_RECOVERY_ARTIFACT_PRESENT"); }
      catch (error) {
        if (error instanceof VmSourceError) throw error;
        if (error?.code !== "ENOENT") fail("VM_DOWNLOAD_RECOVERY_PATH_INVALID");
      }
    }
  } catch (error) {
    if (error instanceof VmSourceError) throw error;
    fail("VM_DOWNLOAD_RECOVERY_PATH_INVALID");
  }
}

export function recoverVmApprovalAcquisition(store, id, {
  confirmRepeatableResource, privateEndpoints, now = Date.now,
} = {}) {
  if (confirmRepeatableResource !== true) fail("VM_DOWNLOAD_RECOVERY_CONFIRMATION_REQUIRED");
  const claim = store.claim(id, { leaseMs: 60_000 });
  if (!claim) fail(store.get(id) ? "VM_APPROVAL_JOB_BUSY" : "VM_APPROVAL_JOB_NOT_FOUND");
  const job = claim.job;
  const originalJob = structuredClone(job);
  try {
    const resourceClaimFailure = job.last_error === "VM_RESOURCE_ALREADY_CLAIMED";
    const recoverableFailure = resourceClaimFailure || job.last_error === "VM_SOURCE_ADDRESS_NOT_ALLOWED"
      || job.last_error === "VM_DOWNLOAD_OUTCOME_UNKNOWN";
    if (job.status !== "needs_attention" || !recoverableFailure
      || !job.application_id || !job.instance_code || job.approval?.status !== "APPROVED"
      || job.approval.resource_id !== job.request?.vmid || job.approval.video_quality !== "HIGH"
      || !/^[a-f0-9]{64}$/u.test(job.resource_fingerprint ?? "")
      || (!resourceClaimFailure && !localPath(job.receipt_path))
      || (resourceClaimFailure && (job.receipt_path !== undefined || job.acquisition !== undefined))
      || digest(JSON.stringify(job.request)) !== job.request_fingerprint) {
      fail("VM_DOWNLOAD_RECOVERY_NOT_ALLOWED");
    }
    const request = validateVmApprovalRequest(resourceClaimFailure ? job.request : { ...job.request, private_endpoints: privateEndpoints });
    if (!resourceClaimFailure) {
      if (!request.private_endpoints.length) fail("VM_DOWNLOAD_PRIVATE_ENDPOINTS_REQUIRED");
      assertNoAcquisitionRecoveryArtifacts(job);
    }
    const resource = store.reserveResource(id, claim.leaseToken, job.resource_fingerprint);
    if (!resource.owned) fail("VM_RESOURCE_ALREADY_CLAIMED");
    job.request = request;
    job.request_fingerprint = digest(JSON.stringify(request));
    job.status = "waiting_media";
    job.next_attempt_at = now();
    job.attempts = 0;
    job.updated_at = now();
    delete job.last_error;
    delete job.last_error_detail;
    delete job.resume_phase;
    return store.saveConfirmedAcquisitionRecovery(id, claim.leaseToken, job);
  } catch (error) {
    try { store.save(id, claim.leaseToken, originalJob); } catch { /* The lease may already have expired. */ }
    throw error;
  }
}

export function extendVmApprovalWait(store, id, { now = Date.now, waitMs = WAIT_MS } = {}) {
  if (typeof now !== "function" || !Number.isSafeInteger(waitMs) || waitMs <= 0) fail("VM_APPROVAL_REQUEST_INVALID");
  const time = now();
  if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + waitMs)) fail("VM_APPROVAL_REQUEST_INVALID");
  const claim = store.claim(id, { leaseMs: 60_000 });
  if (!claim) fail(store.get(id) ? "VM_APPROVAL_JOB_BUSY" : "VM_APPROVAL_JOB_NOT_FOUND");
  const job = claim.job;
  const phase = job.last_error === "VM_APPROVAL_WAIT_EXPIRED" ? "approval"
    : job.last_error === "VM_MEDIA_WAIT_EXPIRED" ? "media" : null;
  if (job.status !== "needs_attention" || !phase || !job.application_id || !job.instance_code
    || !Number.isSafeInteger(job[`${phase}_wait_started_at`])
    || !Number.isSafeInteger(job[`${phase}_deadline_at`]) || job[`${phase}_deadline_at`] > time) {
    store.save(id, claim.leaseToken, job);
    fail("VM_APPROVAL_NOT_EXTENDABLE");
  }
  job.status = `waiting_${phase}`;
  job[`${phase}_deadline_at`] = time + waitMs;
  job.attempts = 0;
  job.next_attempt_at = time;
  job.updated_at = time;
  delete job.last_error;
  delete job.resume_phase;
  return store.save(id, claim.leaseToken, job);
}

export async function processVmApproval(store, id, {
  client, now = Date.now, pollMs = 60_000, maxAttempts = 6, leaseMs = 120_000,
  acquire = prepareVmSource, ffprobePath = "ffprobe", ffmpegPath = "ffmpeg",
} = {}) {
  if (!client || !Number.isSafeInteger(pollMs) || pollMs <= 0 || !Number.isSafeInteger(maxAttempts)
    || maxAttempts <= 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 300) fail("VM_APPROVAL_REQUEST_INVALID");
  const claim = store.claim(id, { leaseMs });
  if (!claim) return store.get(id) ?? fail("VM_APPROVAL_JOB_NOT_FOUND");
  let job = claim.job;
  let leaseError;
  const heartbeat = setInterval(() => {
    try { store.renew(id, claim.leaseToken, { leaseMs }); } catch { leaseError = true; }
  }, Math.max(100, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();
  function save(release = false) {
    if (leaseError) fail("VM_APPROVAL_LEASE_LOST");
    job.updated_at = now();
    job = store.save(id, claim.leaseToken, job, { release });
    return job;
  }
  function wait(status, code) {
    job.status = status;
    job.next_attempt_at = now() + pollMs;
    job.attempts = 0;
    if (code) job.last_error = code;
    else delete job.last_error;
    delete job.last_error_detail;
    return save(true);
  }
  function stop(status, code, diagnosticCode) {
    job.status = status;
    job.next_attempt_at = null;
    job.last_error = code;
    if (code === "VM_DOWNLOAD_OUTCOME_UNKNOWN" && /^[A-Z][A-Z0-9_]{1,80}$/u.test(diagnosticCode ?? "")) {
      job.last_error_detail = diagnosticCode;
    } else delete job.last_error_detail;
    return save(true);
  }
  function beginWait(phase) {
    if (job[`${phase}_wait_started_at`] === undefined) {
      const startedAt = now();
      job[`${phase}_wait_started_at`] = startedAt;
      job[`${phase}_deadline_at`] = startedAt + WAIT_MS;
    }
  }
  try {
    if (TERMINAL.has(job.status) || job.next_attempt_at > now()) return save(true);
    if (job.status === "retry_wait") {
      job.status = job.resume_phase;
      delete job.resume_phase;
    }
    // No retry can pass this point with changed local request fields.
    const request = validateVmApprovalRequest(job.request);
    if (digest(JSON.stringify(request)) !== job.request_fingerprint) fail("VM_APPROVAL_STATE_INVALID");
    if (job.status === "acquiring") {
      if (!job.receipt_path) return stop("needs_attention", "VM_DOWNLOAD_OUTCOME_UNKNOWN");
      try {
        job.acquisition = await verifyVmAcquisitionReceipt(job.receipt_path, {
          vmid: request.vmid, applicationId: job.application_id,
          instanceCode: job.instance_code,
        });
        job.status = "ready";
        job.next_attempt_at = null;
        delete job.last_error;
        delete job.last_error_detail;
        return save(true);
      } catch { return stop("needs_attention", "VM_DOWNLOAD_OUTCOME_UNKNOWN"); }
    }
    // A stale queue entry must not unexpectedly submit; confirmed applications use their own clocks.
    if (job.status === "queued" && now() - job.created_at > WAIT_MS) return stop("needs_attention", "VM_APPROVAL_QUEUE_EXPIRED");
    if (job.application_id && job.media_wait_started_at === undefined && now() >= job.approval_deadline_at) {
      return stop("needs_attention", "VM_APPROVAL_WAIT_EXPIRED");
    }
    if (job.status === "waiting_media" && now() >= job.media_deadline_at) {
      return stop("needs_attention", "VM_MEDIA_WAIT_EXPIRED");
    }
    const identity = identityFrom(await client.getIdentity());
    if (job.requester_id && job.requester_id !== identity.user_id) fail("VM_APPLICANT_CHANGED");
    job.requester_id = identity.user_id;
    await client.getVideos(request.vmid).then((result) => verifyVideo(result, request.vmid));
    if (job.status === "queued" && !job.application_id) {
      const result = await client.getDepartments(identity.departments);
      const departments = result?.data?.department_infos;
      const selected = Array.isArray(departments) ? departments.filter((item) => item?.name === request.department) : [];
      if (selected.length !== 1 || !text(selected[0].id) || !ID.test(selected[0].id)) fail("VM_DEPARTMENT_INVALID");
      const before = await client.listApplications();
      job.baseline_ids = before.list.map((item) => item.id);
      job.intended_at = now();
      job.status = "submitting";
      job.submission_attempts = 1;
      save(); // Commit before the only permitted submit attempt, even if its response is lost.
      try {
        await client.submitApplication({ videoIds: [request.vmid], applyReason: request.reason,
          department: selected[0].id, videoUse: "ORIGINAL", videoQuality: "HIGH", fileBase64: "",
          watermark: "", feishuUserName: identity.name, feishuOpenId: identity.open_id,
          feishuDepartmentId: identity.departments[0], feishuUserId: identity.user_id,
          feishuUserEmail: identity.enterprise_email, isMergeSubtitle: false });
      } catch (error) {
        // Keep submitting intent even on auth rejection: resume must reconcile, never repeat POST.
        if (error instanceof VmSourceError && error.code === "VM_AUTH_REQUIRED") throw error;
      }
      job.status = "reconciling";
      save();
    }
    if (["submitting", "reconciling"].includes(job.status)) {
      job.status = "reconciling";
      const result = await client.listApplications();
      const baseline = new Set(job.baseline_ids);
      const matches = result.list.filter((item) => !baseline.has(item.id)
        && Date.parse(item.createdAt) >= job.intended_at - 5000 && matchesApplication(item, job));
      if (matches.length > 1) return stop("needs_attention", "VM_APPLICATION_AMBIGUOUS");
      if (!matches.length) {
        job.reconciliation_attempts += 1;
        if (job.reconciliation_attempts >= maxAttempts) return stop("needs_attention", "VM_SUBMISSION_OUTCOME_UNKNOWN");
        return wait("reconciling", "VM_APPLICATION_NOT_VISIBLE");
      }
      // Binding the unique submitted application starts the clock even if its detail endpoint is unavailable.
      requireBinding(matches[0], { ...job, application_id: matches[0].id });
      job.application_id = matches[0].id;
      job.instance_code = matches[0].instanceCode;
      beginWait("approval");
      delete job.baseline_ids;
      job.status = "waiting_approval";
      save();
    }
    if (!job.application_id) fail("VM_APPROVAL_STATE_INVALID");
    const application = await client.getApplication(job.application_id);
    requireBinding(application, job);
    job.instance_code = application.instanceCode;
    beginWait("approval");
    if (application.applyStatus === "PENDING") {
      if (now() >= job.approval_deadline_at) return stop("needs_attention", "VM_APPROVAL_WAIT_EXPIRED");
      return wait("waiting_approval");
    }
    if (application.applyStatus === "REJECTED") return stop("rejected", "VM_APPROVAL_REJECTED");
    if (["CANCELED", "CANCELLED", "DELETED"].includes(application.applyStatus)) return stop("canceled", "VM_APPROVAL_CANCELED");
    if (application.applyStatus !== "APPROVED") fail("VM_APPROVAL_STATUS_INVALID");
    beginWait("media");
    if (now() >= job.media_deadline_at) return stop("needs_attention", "VM_MEDIA_WAIT_EXPIRED");
    const resource = application.urlObjList[0];
    if (resource.status !== "finished") return wait("waiting_media");
    job.approval = { status: "APPROVED", resource_id: resource.id, video_quality: "HIGH", checked_at: now() };
    if (request.reuse_receipt) {
      job.acquisition = await verifyVmAcquisitionReceipt(request.reuse_receipt, {
        vmid: request.vmid, applicationId: job.application_id,
        instanceCode: job.instance_code, allowOperatorReceipt: true,
      });
      // An explicitly reused artifact means this application's resource may already be consumed.
      if (typeof resource.url === "string" && resource.url) {
        job.resource_fingerprint = digest(resource.url);
        store.reserveResource(id, claim.leaseToken, job.resource_fingerprint);
      }
      job.status = "ready";
      job.next_attempt_at = null;
      delete job.last_error;
      return save(true);
    }
    const sourceRequest = validateVmSourceRequest({ schema_version: 1, vmid: request.vmid,
      source: { kind: "approved_url", approval_ref: job.application_id, video_variant: "approved_rendition",
        expected_resolution: RESOLUTION, url: resource.url, allowed_origins: request.allowed_origins,
        private_endpoints: request.private_endpoints } });
    // Persist only a digest. The single-use URL lives in memory and is never in job state or logs.
    job.resource_fingerprint = digest(resource.url);
    const reservation = store.reserveResource(id, claim.leaseToken, job.resource_fingerprint);
    if (!reservation.owned) return stop("needs_attention", "VM_RESOURCE_ALREADY_CLAIMED");
    job.status = "waiting_media";
    save();
    const result = await acquire(sourceRequest, { outputRoot: request.output_root, ffprobePath, ffmpegPath }, {
      approvalEvidence: { application_id: job.application_id, instance_code: job.instance_code,
        resource_id: request.vmid, status: "APPROVED", quality: "HIGH" },
      beforeTransfer: async ({ receiptPath }) => {
        job.status = "acquiring";
        job.receipt_path = receiptPath;
        save();
      },
    });
    if (job.status !== "acquiring" || result?.status !== "ready" || result.receipt_path !== job.receipt_path) {
      fail("VM_ACQUISITION_RESULT_INVALID");
    }
    job.acquisition = await verifyVmAcquisitionReceipt(job.receipt_path, {
      vmid: request.vmid, applicationId: job.application_id,
      instanceCode: job.instance_code,
    });
    job.status = "ready";
    job.next_attempt_at = null;
    job.attempts = 0;
    delete job.last_error;
    delete job.last_error_detail;
    return save(true);
  } catch (error) {
    if (leaseError || error?.code === "VM_APPROVAL_LEASE_LOST") fail("VM_APPROVAL_LEASE_LOST");
    const code = error instanceof VmSourceError ? error.code : "VM_APPROVAL_OPERATION_FAILED";
    if (job.status === "acquiring") return stop("needs_attention",
      code === "VM_SOURCE_ADDRESS_NOT_ALLOWED" ? code : "VM_DOWNLOAD_OUTCOME_UNKNOWN",
      code === "VM_SOURCE_ADDRESS_NOT_ALLOWED" ? undefined : code);
    if (code === "VM_AUTH_REQUIRED") {
      job.resume_phase = job.status;
      return stop("auth_required", code);
    }
    if (RETRYABLE.has(code)) {
      job.attempts += 1;
      job.resume_phase = job.status;
      if (job.attempts >= maxAttempts) return stop("dead_letter", code);
      job.status = "retry_wait";
      job.last_error = code;
      job.next_attempt_at = now() + Math.min(30 * 60 * 1000, pollMs * 2 ** (job.attempts - 1));
      return save(true);
    }
    return stop("needs_attention", code);
  } finally { clearInterval(heartbeat); }
}
