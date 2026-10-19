import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVmApprovalStore } from "../server/vm-approval-store.mjs";
import * as vmApprovalWorkflow from "../server/vm-approval-workflow.mjs";
import { prepareVmSource } from "../server/vm-source-adapter.mjs";
import { VmSourceError } from "../server/vm-source-transfer.mjs";
import { enqueueVmApproval, extendVmApprovalWait, processVmApproval, resumeVmApproval, summarizeVmApproval,
  validateVmApprovalRequest, verifyVmAcquisitionReceipt } from "../server/vm-approval-workflow.mjs";

const VMID = "0123456789abcdef01234567";
const ORIGIN = "https://media.example.test";
const SECRET_URL = `${ORIGIN}/test.mp4?signature=never-persist`;
const PAYLOAD = Buffer.from("fixture-video");
const MEDIA = { container: "mov,mp4", duration_ms: 2000,
  video: [{ width: 1280, height: 720 }], audio: [], validation: { metadata: true, full_decode: true } };

async function fixture(t, requestOverrides = {}, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-approval-workflow-"));
  let clock = Date.parse("2026-10-09T10:00:00Z");
  const now = () => clock;
  let store = createVmApprovalStore({ file: path.join(root, "queue.sqlite"), now });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const request = { schema_version: 1, vmid: VMID, department: "动画组", reason: "切片剪辑",
    output_root: path.join(root, "materials"), allowed_origins: [ORIGIN], ...requestOverrides };
  let submitted = 0;
  let downloaded = 0;
  let application;
  let identityId = "user-1";
  let approvalStatus = "PENDING";
  let resourceStatus = "finished";
  const makeApplication = () => ({ id: "application-1", instanceCode: "approval-1", createdAt: new Date(clock).toISOString(),
    applyUser: { feishuUserId: "user-1" }, applyReason: "切片剪辑", videoUse: "ORIGINAL", videoQuality: "HIGH",
    applyStatus: approvalStatus, urlObjList: [{ id: VMID, status: resourceStatus, url: SECRET_URL }] });
  const client = {
    async getIdentity() { return { raw: { feishu: { name: "测试", user_id: identityId,
      open_id: "open-1", enterprise_email: "fixture@example.test", departments: ["first-department", "chosen-department"] } } }; },
    async getVideos() { return { total: 1, videos: [{ id: VMID }] }; },
    async getDepartments() { return { data: { department_infos: [{ id: "chosen-department", name: "动画组" }] } }; },
    async listApplications() { return { list: application ? [application] : [], count: application ? 1 : 0 }; },
    async submitApplication(body) {
      submitted += 1;
      assert.equal(body.department, "chosen-department");
      assert.equal(body.feishuDepartmentId, "first-department");
      assert.equal(body.videoQuality, "HIGH");
      assert.deepEqual(body.videoIds, [VMID]);
      application = makeApplication();
      if (options.loseResponse) throw new VmSourceError("VM_API_TIMEOUT");
      return {};
    },
    async getApplication() { return application ?? makeApplication(); },
  };
  const acquire = (raw, config, dependencies) => prepareVmSource(raw, config, { ...dependencies,
    download: async ({ destination }) => {
      downloaded += 1;
      if (options.downloadFailure) throw new VmSourceError("VM_SOURCE_TIMEOUT");
      await writeFile(destination, PAYLOAD);
      return { bytes: PAYLOAD.length, sha256: createHash("sha256").update(PAYLOAD).digest("hex") };
    }, validateMedia: async () => options.sourceResolution
      ? { ...MEDIA, video: [options.sourceResolution] }
      : options.higherResolution ? { ...MEDIA, video: [{ width: 1920, height: 1080 }] } : MEDIA,
  });
  const enqueue = (overrides) => enqueueVmApproval(store, { ...request, ...overrides }, { now });
  const tick = (id, extras = {}) => processVmApproval(store, id, { client, now, pollMs: 1000, maxAttempts: 3, acquire, ...extras });
  return { root, request, now, client, acquire, enqueue, tick, get store() { return store; },
    get submitted() { return submitted; }, get downloaded() { return downloaded; },
    advance(ms = 1000) { clock += ms; },
    approve(status = "APPROVED") { approvalStatus = status; if (application) application.applyStatus = status; },
    resource(status) { resourceStatus = status; if (application) application.urlObjList[0].status = status; },
    application(value) { application = value; }, getApplication: makeApplication,
    changeUser() { identityId = "user-2"; },
    restart() { store.close(); store = createVmApprovalStore({ file: path.join(root, "queue.sqlite"), now }); },
  };
}

test("submit once, restart while pending, download only after APPROVED + finished and publish bound receipt", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  assert.equal(f.enqueue().id, job.id);
  const waiting = await f.tick(job.id);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(f.submitted, 1);
  assert.equal(f.downloaded, 0);
  await assert.rejects(readdir(f.request.output_root), { code: "ENOENT" });
  f.restart();
  f.advance();
  f.approve();
  f.resource("processing");
  assert.equal((await f.tick(job.id)).status, "waiting_media");
  assert.equal(f.downloaded, 0);
  f.advance(); f.resource("finished");
  const ready = await f.tick(job.id);
  assert.equal(ready.status, "ready");
  assert.equal(f.submitted, 1); assert.equal(f.downloaded, 1);
  const receipt = JSON.parse(await readFile(ready.acquisition.receipt_path, "utf8"));
  assert.equal(receipt.provenance.vmid_binding, "vm_api_verified");
  assert.equal(receipt.provenance.kind, "vm_api_approval");
  assert.equal(receipt.provenance.approval_ref, "application-1");
  assert.equal(receipt.provenance.instance_code, "approval-1");
  assert.doesNotMatch(JSON.stringify(f.store.list()), /never-persist|signature=|fixture@example/u);
  assert.doesNotMatch(JSON.stringify(summarizeVmApproval(ready)), /never-persist|signature=/u);
  f.restart();
  assert.equal((await f.tick(job.id)).status, "ready");
  assert.equal(f.downloaded, 1);
});

test("lost submit response reconciles the unique request without a second submission", async (t) => {
  const f = await fixture(t, {}, { loseResponse: true });
  const job = f.enqueue();
  assert.equal((await f.tick(job.id)).status, "waiting_approval");
  f.restart(); f.advance();
  assert.equal((await f.tick(job.id)).status, "waiting_approval");
  assert.equal(f.submitted, 1);
});

test("normal pending polls persist an approval deadline from binding rather than queue creation", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  f.advance(6 * 86_400_000);
  const boundAt = f.now();
  let waiting = await f.tick(job.id);
  assert.equal(waiting.approval_wait_started_at, boundAt);
  assert.equal(waiting.approval_deadline_at, boundAt + 604_800_000);
  assert.equal(waiting.media_wait_started_at, undefined);
  for (let count = 0; count < 8; count += 1) {
    f.advance(86_400_000 / 2);
    if (count === 3) f.restart();
    waiting = await f.tick(job.id);
    assert.equal(waiting.status, "waiting_approval");
    assert.equal(waiting.attempts, 0);
    assert.equal(waiting.approval_wait_started_at, boundAt);
    assert.equal(waiting.approval_deadline_at, boundAt + 604_800_000);
  }
  assert.equal(f.submitted, 1);
  assert.equal(f.downloaded, 0);
  assert.equal(waiting.application_id, "application-1");
});

test("approval deadline pauses exactly at seven days and extension preserves the same application", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  const initial = await f.tick(job.id);
  f.advance(604_800_000);
  const expired = await f.tick(job.id);
  assert.equal(expired.status, "needs_attention");
  assert.equal(expired.last_error, "VM_APPROVAL_WAIT_EXPIRED");
  assert.equal(expired.next_attempt_at, null);
  f.restart();
  assert.equal((await f.tick(job.id)).last_error, "VM_APPROVAL_WAIT_EXPIRED");
  const extended = extendVmApprovalWait(f.store, job.id, { now: f.now });
  assert.equal(extended.status, "waiting_approval");
  assert.equal(extended.approval_wait_started_at, initial.approval_wait_started_at);
  assert.equal(extended.approval_deadline_at, f.now() + 604_800_000);
  assert.equal(extended.next_attempt_at, f.now());
  assert.equal(extended.last_error, undefined);
  assert.deepEqual(extended.request, initial.request);
  assert.equal(extended.application_id, initial.application_id);
  assert.equal(extended.instance_code, initial.instance_code);
  f.restart();
  f.approve();
  assert.equal((await f.tick(job.id)).status, "ready");
  assert.equal(f.submitted, 1);
  assert.equal(f.downloaded, 1);
});

test("unique application binding persists approval timing even when every detail request fails", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  const submittedAt = f.now();
  let detailCalls = 0;
  f.client.getApplication = async () => { detailCalls += 1; throw new VmSourceError("VM_API_TIMEOUT"); };
  const failed = await f.tick(job.id);
  assert.equal(failed.status, "retry_wait");
  assert.equal(failed.application_id, "application-1");
  assert.equal(failed.instance_code, "approval-1");
  assert.equal(failed.approval_wait_started_at, submittedAt);
  assert.equal(failed.approval_deadline_at, submittedAt + 604_800_000);
  f.advance(); await f.tick(job.id);
  f.advance(2000); assert.equal((await f.tick(job.id)).status, "dead_letter");
  f.restart(); f.advance(8 * 86_400_000);
  resumeVmApproval(f.store, job.id, { now: f.now });
  const expired = await f.tick(job.id);
  assert.equal(expired.last_error, "VM_APPROVAL_WAIT_EXPIRED");
  assert.equal(expired.approval_wait_started_at, submittedAt);
  assert.equal(detailCalls, 3);
  assert.equal(f.submitted, 1);
  extendVmApprovalWait(f.store, job.id, { now: f.now });
  f.client.getApplication = async () => f.getApplication();
  assert.equal((await f.tick(job.id)).status, "waiting_approval");
  assert.equal(f.submitted, 1);
});

test("an already bound application keeps its deadline through a submitting or reconciliation resume", async (t) => {
  for (const phase of ["submitting", "reconciling"]) {
    const f = await fixture(t);
    const job = f.enqueue();
    const pending = await f.tick(job.id);
    const claim = f.store.claim(job.id);
    f.store.save(job.id, claim.leaseToken, { ...pending, status: "retry_wait", resume_phase: phase });
    f.advance(604_800_000);
    let reads = 0;
    f.client.getIdentity = async () => { reads += 1; throw new Error("expired state must not reach network"); };
    const expired = await f.tick(job.id);
    assert.equal(expired.last_error, "VM_APPROVAL_WAIT_EXPIRED");
    assert.equal(reads, 0);
    assert.equal(f.submitted, 1);
  }
});

test("a unique application without a valid approval instance cannot establish approval timing", async (t) => {
  const f = await fixture(t);
  const list = f.client.listApplications;
  f.client.listApplications = async () => {
    const result = await list();
    return { ...result, list: result.list.map(value => ({ ...value, instanceCode: "" })) };
  };
  const stopped = await f.tick(f.enqueue().id);
  assert.equal(stopped.status, "needs_attention");
  assert.equal(stopped.last_error, "VM_APPLICATION_MISMATCH");
  assert.equal(stopped.approval_wait_started_at, undefined);
  assert.equal(stopped.instance_code, undefined);
  assert.equal(f.downloaded, 0);
});

test("approved production gets an independent seven-day media wait that survives restart and extension", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  const approval = await f.tick(job.id);
  f.advance(6 * 86_400_000);
  f.approve(); f.resource("processing");
  const mediaAt = f.now();
  const media = await f.tick(job.id);
  assert.equal(media.status, "waiting_media");
  assert.equal(media.media_wait_started_at, mediaAt);
  assert.equal(media.media_deadline_at, mediaAt + 604_800_000);
  assert.equal(media.approval_deadline_at, approval.approval_deadline_at);
  f.advance(6 * 86_400_000);
  f.restart();
  const stillWaiting = await f.tick(job.id);
  assert.equal(stillWaiting.status, "waiting_media");
  assert.equal(stillWaiting.media_wait_started_at, mediaAt);
  assert.equal(stillWaiting.media_deadline_at, media.media_deadline_at);
  f.advance(86_400_000);
  f.resource("finished");
  const expired = await f.tick(job.id);
  assert.equal(expired.status, "needs_attention");
  assert.equal(expired.last_error, "VM_MEDIA_WAIT_EXPIRED");
  assert.equal(f.downloaded, 0);
  const extended = extendVmApprovalWait(f.store, job.id, { now: f.now });
  assert.equal(extended.status, "waiting_media");
  assert.equal(extended.media_wait_started_at, mediaAt);
  assert.equal(extended.media_deadline_at, f.now() + 604_800_000);
  assert.equal(extended.approval_deadline_at, approval.approval_deadline_at);
  assert.equal(extended.application_id, approval.application_id);
  f.restart();
  assert.equal((await f.tick(job.id)).status, "ready");
  assert.equal(f.submitted, 1);
  assert.equal(f.downloaded, 1);
});

test("approval summary exposes local display fields only when requested and never remote data", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  const publicSummary = summarizeVmApproval(job);
  for (const key of ["output_root", "department", "reason"]) assert.equal(publicSummary[key], undefined);
  const queued = summarizeVmApproval(job, { includeLocalRequest: true });
  assert.equal(queued.created_at, f.now());
  assert.equal(queued.updated_at, f.now());
  assert.equal(queued.output_root, f.request.output_root);
  assert.equal(queued.department, "动画组");
  assert.equal(queued.reason, "切片剪辑");
  for (const key of ["approval_wait_started_at", "approval_deadline_at", "media_wait_started_at", "media_deadline_at"]) {
    assert.equal(queued[key], null);
  }
  const waiting = summarizeVmApproval(await f.tick(job.id));
  assert.equal(waiting.approval_wait_started_at, f.now());
  assert.equal(waiting.approval_deadline_at, f.now() + 604_800_000);
  assert.equal(waiting.media_deadline_at, null);
  assert.doesNotMatch(JSON.stringify(waiting), /never-persist|signature=|fixture@example|allowed_origins/u);
});

test("stale queued requests stop separately and cannot be extended into approval polling", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  f.advance(604_800_001);
  const expired = await f.tick(job.id);
  assert.equal(expired.status, "needs_attention");
  assert.equal(expired.last_error, "VM_APPROVAL_QUEUE_EXPIRED");
  assert.equal(expired.application_id, undefined);
  assert.throws(() => extendVmApprovalWait(f.store, job.id, { now: f.now }),
    { code: "VM_APPROVAL_NOT_EXTENDABLE" });
  assert.equal(f.submitted, 0);
});

test("wait extension rejects active and terminal jobs and respects worker leases", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  const pending = await f.tick(job.id);
  for (const state of [pending, { ...pending, status: "ready" },
    { ...pending, status: "rejected", last_error: "VM_APPROVAL_REJECTED" },
    { ...pending, status: "canceled", last_error: "VM_APPROVAL_CANCELED" },
    { ...pending, status: "needs_attention", last_error: "VM_DOWNLOAD_OUTCOME_UNKNOWN" },
    { ...pending, status: "auth_required", resume_phase: "waiting_approval", last_error: "VM_AUTH_REQUIRED" },
    { ...pending, status: "dead_letter", resume_phase: "waiting_approval", last_error: "VM_API_TIMEOUT" }]) {
    const claim = f.store.claim(job.id);
    f.store.save(job.id, claim.leaseToken, state);
    assert.throws(() => extendVmApprovalWait(f.store, job.id, { now: f.now }),
      { code: "VM_APPROVAL_NOT_EXTENDABLE" });
    assert.deepEqual(f.store.get(job.id), state);
  }
  const claimed = f.store.claim(job.id);
  assert.throws(() => extendVmApprovalWait(f.store, job.id, { now: f.now }),
    { code: "VM_APPROVAL_JOB_BUSY" });
  f.store.save(job.id, claimed.leaseToken, pending);
  f.advance(604_800_000);
  await f.tick(job.id);
  for (const waitMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => extendVmApprovalWait(f.store, job.id, { now: f.now, waitMs }),
      { code: "VM_APPROVAL_REQUEST_INVALID" });
  }
  assert.equal(f.store.get(job.id).last_error, "VM_APPROVAL_WAIT_EXPIRED");
});

test("crash after intent commit recovers by reconciliation and never submits again", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  const claim = f.store.claim(job.id, { leaseMs: 500 });
  f.store.save(job.id, claim.leaseToken, { ...job, status: "submitting", submission_attempts: 1,
    requester_id: "user-1", baseline_ids: [], intended_at: f.now() }, { release: false });
  f.restart(); f.advance();
  assert.equal((await f.tick(job.id)).status, "reconciling");
  f.advance(); await f.tick(job.id); f.advance();
  const stopped = await f.tick(job.id);
  assert.equal(stopped.status, "needs_attention");
  assert.equal(stopped.last_error, "VM_SUBMISSION_OUTCOME_UNKNOWN");
  assert.equal(f.submitted, 0); assert.equal(f.downloaded, 0);
});

test("ambiguous new applications stop for reconciliation", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.client.listApplications = async () => (++calls === 1 ? { list: [], count: 0 }
    : { list: [f.getApplication(), { ...f.getApplication(), id: "application-2" }], count: 2 });
  const result = await f.tick(f.enqueue().id);
  assert.equal(result.last_error, "VM_APPLICATION_AMBIGUOUS");
  assert.equal(f.downloaded, 0);
});

test("existing matching pending and approved applications can be adopted with zero submissions", async (t) => {
  const f = await fixture(t, { application_id: "application-1" });
  const job = f.enqueue();
  assert.equal((await f.tick(job.id)).status, "waiting_approval");
  f.approve(); f.advance();
  assert.equal((await f.tick(job.id)).status, "ready");
  assert.equal(f.submitted, 0);
});

test("different identity, resource, quality or approval instance cannot authorize transfer", async (t) => {
  for (const change of [
    (app) => { app.applyUser.feishuUserId = "other"; },
    (app) => { app.urlObjList[0].id = "ffffffffffffffffffffffff"; },
    (app) => { app.videoQuality = "LOW"; },
    (app) => { app.videoUse = "MARKETING"; },
    (app) => { app.applyReason = "other"; },
    (app) => { app.instanceCode = ""; },
    (app) => { app.urlObjList.push({ ...app.urlObjList[0] }); },
  ]) {
    const f = await fixture(t, { application_id: "application-1" });
    f.approve(); const app = f.getApplication(); change(app); f.application(app);
    const result = await f.tick(f.enqueue().id);
    assert.equal(result.status, "needs_attention");
    assert.equal(result.last_error, "VM_APPLICATION_MISMATCH");
    assert.equal(f.downloaded, 0);
  }
});

test("rejection, cancellation and unknown statuses never consume a finished URL", async (t) => {
  for (const status of ["REJECTED", "CANCELED", "UNKNOWN"]) {
    const f = await fixture(t, { application_id: "application-1" });
    f.approve(status);
    const result = await f.tick(f.enqueue().id);
    assert.ok(["rejected", "canceled", "needs_attention"].includes(result.status));
    assert.equal(f.downloaded, 0);
  }
});

test("authentication pause resumes same application and user changes stop", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue(); await f.tick(job.id); f.advance();
  const get = f.client.getIdentity;
  f.client.getIdentity = async () => { throw new VmSourceError("VM_AUTH_REQUIRED"); };
  assert.equal((await f.tick(job.id)).status, "auth_required");
  f.client.getIdentity = get;
  resumeVmApproval(f.store, job.id, { now: f.now });
  assert.equal((await f.tick(job.id)).status, "waiting_approval");
  assert.equal(f.submitted, 1);
  f.advance(); f.changeUser();
  assert.equal((await f.tick(job.id)).last_error, "VM_APPLICANT_CHANGED");
});

test("read failures retry with finite backoff then remain in dead letter", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  f.client.getIdentity = async () => { throw new VmSourceError("VM_API_TIMEOUT"); };
  const first = await f.tick(job.id);
  assert.equal(first.status, "retry_wait"); assert.equal(first.next_attempt_at, f.now() + 1000);
  f.advance(); const second = await f.tick(job.id);
  assert.equal(second.next_attempt_at, f.now() + 2000);
  f.advance(2000); assert.equal((await f.tick(job.id)).status, "dead_letter");
  f.restart(); assert.equal((await f.tick(job.id)).status, "dead_letter");
  assert.equal(f.submitted, 0);
});

test("failed or interrupted download is not retried against a possibly consumed URL", async (t) => {
  const f = await fixture(t, { application_id: "application-1",
    private_endpoints: [{ origin: ORIGIN, addresses: ["10.8.8.11"] }] }, { downloadFailure: true });
  f.approve(); const job = f.enqueue();
  const result = await f.tick(job.id);
  assert.equal(result.status, "needs_attention");
  assert.equal(result.last_error, "VM_DOWNLOAD_OUTCOME_UNKNOWN");
  assert.equal(result.last_error_detail, "VM_SOURCE_TIMEOUT");
  assert.equal(summarizeVmApproval(result).error.diagnostic_code, "VM_SOURCE_TIMEOUT");
  f.restart(); f.advance(); await f.tick(job.id);
  assert.equal(f.downloaded, 1);
  assert.throws(() => resumeVmApproval(f.store, job.id, { now: f.now }), { code: "VM_APPROVAL_NOT_RESUMABLE" });
});

test("unknown acquisition outcomes expose a safe media validation diagnosis", async (t) => {
  const f = await fixture(t);
  f.approve();
  const job = f.enqueue();
  const failMediaValidation = (raw, config, dependencies) => prepareVmSource(raw, config, { ...dependencies,
    download: async ({ destination }) => {
      await writeFile(destination, PAYLOAD);
      return { bytes: PAYLOAD.length, sha256: createHash("sha256").update(PAYLOAD).digest("hex") };
    },
    validateMedia: async () => { throw new VmSourceError("MEDIA_VALIDATION_FAILED"); },
  });

  const result = await f.tick(job.id, { acquire: failMediaValidation });

  assert.equal(result.status, "needs_attention");
  assert.equal(result.last_error, "VM_DOWNLOAD_OUTCOME_UNKNOWN");
  assert.equal(result.last_error_detail, "MEDIA_VALIDATION_FAILED");
  assert.equal(summarizeVmApproval(result).error.diagnostic_code, "MEDIA_VALIDATION_FAILED");
});

test("operator-confirmed repeatable download recovery reuses the approved application", async (t) => {
  const policy = [{ origin: ORIGIN, addresses: ["10.8.8.11"] }];
  const f = await fixture(t, { application_id: "application-1", private_endpoints: policy }, { downloadFailure: true });
  f.approve();
  const job = f.enqueue();
  const failed = await f.tick(job.id);
  assert.equal(failed.status, "needs_attention");
  assert.equal(failed.last_error, "VM_DOWNLOAD_OUTCOME_UNKNOWN");
  assert.equal(f.downloaded, 1);

  f.restart(); f.advance();
  assert.equal((await f.tick(job.id)).status, "needs_attention");
  assert.equal(f.downloaded, 1);
  assert.throws(() => vmApprovalWorkflow.recoverVmApprovalAcquisition(f.store, job.id, {
    confirmRepeatableResource: false, privateEndpoints: policy, now: f.now,
  }), { code: "VM_DOWNLOAD_RECOVERY_CONFIRMATION_REQUIRED" });

  const recovered = vmApprovalWorkflow.recoverVmApprovalAcquisition(f.store, job.id, {
    confirmRepeatableResource: true, privateEndpoints: policy, now: f.now,
  });
  assert.equal(recovered.status, "waiting_media");
  assert.equal(recovered.last_error_detail, undefined);
  assert.equal(recovered.application_id, failed.application_id);
  assert.equal(recovered.instance_code, failed.instance_code);
  assert.equal(recovered.submission_attempts, 0);

  let transfers = 0;
  const successfulAcquire = (raw, config, dependencies) => prepareVmSource(raw, config, { ...dependencies,
    download: async ({ destination }) => {
      transfers++;
      await writeFile(destination, PAYLOAD);
      return { bytes: PAYLOAD.length, sha256: createHash("sha256").update(PAYLOAD).digest("hex") };
    }, validateMedia: async () => MEDIA,
  });
  f.advance();
  const ready = await f.tick(job.id, { acquire: successfulAcquire });
  assert.equal(ready.status, "ready");
  assert.equal(ready.application_id, failed.application_id);
  assert.equal(f.submitted, 0);
  assert.equal(transfers, 1);
});

test("legacy unknown outcomes require confirmation and exact local files absent before reusing the approved application", async (t) => {
  const f = await fixture(t, {}, { downloadFailure: true });
  f.approve(); const queued = f.enqueue();
  const failed = await f.tick(queued.id);
  assert.equal(failed.last_error, "VM_DOWNLOAD_OUTCOME_UNKNOWN");
  assert.deepEqual(failed.request.private_endpoints, []);
  const recover = vmApprovalWorkflow.recoverVmApprovalAcquisition;
  const policy = [{ origin: ORIGIN, addresses: ["10.8.8.11"] }];

  assert.throws(() => recover(f.store, queued.id, { confirmRepeatableResource: false, privateEndpoints: policy, now: f.now }),
    { code: "VM_DOWNLOAD_RECOVERY_CONFIRMATION_REQUIRED" });
  const resumed = recover(f.store, queued.id, { confirmRepeatableResource: true, privateEndpoints: policy, now: f.now });
  assert.equal(resumed.status, "waiting_media");
  assert.equal(resumed.application_id, failed.application_id);
  assert.equal(resumed.instance_code, failed.instance_code);
  assert.equal(resumed.submission_attempts, 1);
  assert.deepEqual(resumed.request.private_endpoints, policy);

  const successAcquire = (raw, config, dependencies) => prepareVmSource(raw, config, { ...dependencies,
    download: async ({ destination }) => {
      await writeFile(destination, PAYLOAD);
      return { bytes: PAYLOAD.length, sha256: createHash("sha256").update(PAYLOAD).digest("hex") };
    }, validateMedia: async () => MEDIA,
  });
  f.advance();
  const ready = await f.tick(queued.id, { acquire: successAcquire });
  assert.equal(ready.status, "ready");
  assert.equal(ready.application_id, failed.application_id);
  assert.equal(f.submitted, 1);
});

test("private-address policy rejection stays distinguishable from an unknown download outcome", async (t) => {
  const f = await fixture(t);
  f.approve(); const job = f.enqueue();
  const rejectBeforeRequest = (raw, config, dependencies) => prepareVmSource(raw, config, { ...dependencies,
    download: async () => { throw new VmSourceError("VM_SOURCE_ADDRESS_NOT_ALLOWED"); }, validateMedia: async () => MEDIA,
  });

  const result = await f.tick(job.id, { acquire: rejectBeforeRequest });

  assert.equal(result.status, "needs_attention");
  assert.equal(result.last_error, "VM_SOURCE_ADDRESS_NOT_ALLOWED");
  assert.equal(f.downloaded, 0);
});

test("confirmed private-address recovery reuses the approved application only when no acquisition files exist", async (t) => {
  const f = await fixture(t);
  f.approve(); const job = f.enqueue();
  const rejectBeforeRequest = (raw, config, dependencies) => prepareVmSource(raw, config, { ...dependencies,
    download: async () => { throw new VmSourceError("VM_SOURCE_ADDRESS_NOT_ALLOWED"); }, validateMedia: async () => MEDIA,
  });
  await f.tick(job.id, { acquire: rejectBeforeRequest });
  const recover = vmApprovalWorkflow.recoverVmApprovalAcquisition;
  assert.equal(typeof recover, "function");
  if (typeof recover !== "function") return;

  const failed = f.store.get(job.id);
  const jobRoot = path.dirname(failed.receipt_path);
  const policy = [{ origin: ORIGIN, addresses: ["10.8.8.11"] }];
  assert.throws(() => recover(f.store, job.id, { confirmRepeatableResource: false, privateEndpoints: policy, now: f.now }),
    { code: "VM_DOWNLOAD_RECOVERY_CONFIRMATION_REQUIRED" });
  for (const filename of ["source.mp4", "source.mp4.part", "acquisition.json", "acquisition.json.part"]) {
    const artifact = path.join(jobRoot, filename);
    await writeFile(artifact, "sentinel");
    assert.throws(() => recover(f.store, job.id, { confirmRepeatableResource: true, privateEndpoints: policy, now: f.now }),
      { code: "VM_DOWNLOAD_RECOVERY_ARTIFACT_PRESENT" });
    await unlink(artifact);
  }

  const beforeResource = failed.resource_fingerprint;
  const recovered = recover(f.store, job.id, { confirmRepeatableResource: true, privateEndpoints: policy, now: f.now });
  assert.equal(recovered.status, "waiting_media");
  assert.equal(recovered.application_id, failed.application_id);
  assert.equal(recovered.instance_code, failed.instance_code);
  assert.equal(recovered.submission_attempts, 1);
  assert.equal(recovered.resource_fingerprint, beforeResource);
  assert.deepEqual(recovered.request.private_endpoints, policy);

  f.advance();
  const ready = await f.tick(job.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.application_id, failed.application_id);
  assert.equal(f.submitted, 1);
  assert.equal(f.downloaded, 1);
});

test("confirmed recovery of an unknown outcome still rejects existing acquisition artifacts", async (t) => {
  const f = await fixture(t, { private_endpoints: [{ origin: ORIGIN, addresses: ["10.8.8.11"] }] }, { downloadFailure: true });
  f.approve(); const job = f.enqueue();
  const failed = await f.tick(job.id);
  const recover = vmApprovalWorkflow.recoverVmApprovalAcquisition;
  assert.equal(typeof recover, "function");
  if (typeof recover !== "function") return;
  assert.equal(failed.last_error, "VM_DOWNLOAD_OUTCOME_UNKNOWN");
  const jobRoot = path.dirname(failed.receipt_path);
  const artifact = path.join(jobRoot, "source.mp4");
  await writeFile(artifact, "sentinel");
  assert.throws(() => recover(f.store, job.id, { confirmRepeatableResource: true,
    privateEndpoints: [{ origin: ORIGIN, addresses: ["10.8.8.11"] }], now: f.now }),
  { code: "VM_DOWNLOAD_RECOVERY_ARTIFACT_PRESENT" });
  await unlink(artifact);
  assert.equal(recover(f.store, job.id, { confirmRepeatableResource: true,
    privateEndpoints: [{ origin: ORIGIN, addresses: ["10.8.8.11"] }], now: f.now }).status, "waiting_media");
});

test("download interrupted after receipt publication recovers exact artifact without network", async (t) => {
  const f = await fixture(t, { application_id: "application-1" });
  f.approve(); const job = f.enqueue(); const ready = await f.tick(job.id);
  const claim = f.store.claim(job.id, { leaseMs: 500 });
  f.store.save(job.id, claim.leaseToken, { ...ready, status: "acquiring" }, { release: false });
  f.restart(); f.advance();
  f.client.getIdentity = () => { throw new Error("must not call network to recover published artifact"); };
  assert.equal((await f.tick(job.id)).status, "ready");
  assert.equal(f.downloaded, 1);
  await writeFile(ready.acquisition.path, "changed");
  await assert.rejects(verifyVmAcquisitionReceipt(ready.receipt_path, {
    vmid: VMID, applicationId: "application-1",
  }), { code: "VM_RECEIPT_INVALID" });
});

test("receipt reuse verifies bytes and exact application without consuming a new URL", async (t) => {
  const f = await fixture(t, { application_id: "application-1" });
  f.approve(); const ready = await f.tick(f.enqueue().id);
  const reused = f.enqueue({ reuse_receipt: ready.receipt_path });
  assert.equal((await f.tick(reused.id)).status, "ready");
  assert.equal(f.downloaded, 1);
  await assert.rejects(verifyVmAcquisitionReceipt(ready.receipt_path, {
    vmid: VMID, applicationId: "application-2",
  }), { code: "VM_RECEIPT_INVALID" });
});

test("source below the requested minimum width does not publish source or receipt", async (t) => {
  const f = await fixture(t, { application_id: "application-1" }, { sourceResolution: { width: 1279, height: 720 } });
  f.approve(); const result = await f.tick(f.enqueue().id);
  assert.equal(result.status, "needs_attention");
  assert.equal(result.last_error, "VM_DOWNLOAD_OUTCOME_UNKNOWN");
  assert.equal(result.last_error_detail, "SOURCE_RESOLUTION_MISMATCH_1279X720_EXPECTED_1280X720");
  assert.equal(summarizeVmApproval(result).error.diagnostic_code,
    "SOURCE_RESOLUTION_MISMATCH_1279X720_EXPECTED_1280X720");
  const dirs = await readdir(f.request.output_root);
  assert.equal(dirs.length, 1);
  assert.deepEqual(await readdir(path.join(f.request.output_root, dirs[0])), []);
});

test("source below the requested minimum height does not publish source or receipt", async (t) => {
  const f = await fixture(t, { application_id: "application-1" }, { sourceResolution: { width: 1280, height: 719 } });
  f.approve(); const result = await f.tick(f.enqueue().id);

  assert.equal(result.status, "needs_attention");
  assert.equal(result.last_error_detail, "SOURCE_RESOLUTION_MISMATCH_1280X719_EXPECTED_1280X720");
  const dirs = await readdir(f.request.output_root);
  assert.equal(dirs.length, 1);
  assert.deepEqual(await readdir(path.join(f.request.output_root, dirs[0])), []);
});

test("approved source at a higher resolution than the requested minimum is accepted", async (t) => {
  const f = await fixture(t, { application_id: "application-1" }, { higherResolution: true });
  f.approve(); const result = await f.tick(f.enqueue().id);

  assert.equal(result.status, "ready");
  assert.equal(result.acquisition.width, 1920);
  assert.equal(result.acquisition.height, 1080);
  assert.equal(f.downloaded, 1);
});

test("request validation refuses path/command/token fields and malformed local policy", async (t) => {
  const f = await fixture(t);
  for (const overrides of [{ vmid: "bad" }, { shell: "whoami" }, { token: "secret" },
    { output_root: "relative" }, { reason: "" }, { allowed_origins: [] },
    { allowed_origins: ["https://media.example.test/path"] }, { reuse_receipt: path.join(f.root, "receipt.json") },
    { private_endpoints: [{ origin: ORIGIN, addresses: ["127.0.0.1"] }] }]) {
    assert.throws(() => validateVmApprovalRequest({ ...f.request, ...overrides }), { code: "VM_APPROVAL_REQUEST_INVALID" });
  }
});

test("different approved applications can independently consume the same resource", async (t) => {
  const f = await fixture(t, { application_id: "application-1" });
  f.approve();
  assert.equal((await f.tick(f.enqueue().id)).status, "ready");
  const other = { ...f.getApplication(), id: "application-2", instanceCode: "approval-2" };
  f.application(other);
  const second = f.enqueue({ application_id: "application-2" });
  const result = await f.tick(second.id);
  assert.equal(result.status, "ready");
  assert.equal(result.application_id, "application-2");
  assert.equal(f.downloaded, 2);
});

test("the same approved application cannot consume one resource through multiple jobs", async (t) => {
  const f = await fixture(t, { application_id: "application-1" });
  f.approve();
  const first = f.enqueue();
  assert.equal((await f.tick(first.id)).status, "ready");
  const second = f.enqueue({ output_root: path.join(f.root, "second-output") });
  const result = await f.tick(second.id);
  assert.equal(result.last_error, "VM_RESOURCE_ALREADY_CLAIMED");
  assert.equal(f.downloaded, 1);
});

test("a prior cross-approval claim error can resume with its own existing approval", async (t) => {
  const f = await fixture(t, { application_id: "application-1" });
  f.approve();
  assert.equal((await f.tick(f.enqueue().id)).status, "ready");

  const application = { ...f.getApplication(), id: "application-2", instanceCode: "approval-2" };
  f.application(application);
  const second = f.enqueue({ application_id: "application-2" });
  const claim = f.store.claim(second.id);
  Object.assign(claim.job, {
    status: "needs_attention", last_error: "VM_RESOURCE_ALREADY_CLAIMED",
    application_id: "application-2", instance_code: "approval-2",
    approval: { status: "APPROVED", resource_id: VMID, video_quality: "HIGH", checked_at: f.now() },
    resource_fingerprint: createHash("sha256").update(SECRET_URL).digest("hex"),
  });
  f.store.save(second.id, claim.leaseToken, claim.job);

  assert.throws(() => vmApprovalWorkflow.recoverVmApprovalAcquisition(f.store, second.id, {
    confirmRepeatableResource: false, privateEndpoints: [], now: f.now,
  }), { code: "VM_DOWNLOAD_RECOVERY_CONFIRMATION_REQUIRED" });
  const recovered = vmApprovalWorkflow.recoverVmApprovalAcquisition(f.store, second.id, {
    confirmRepeatableResource: true, privateEndpoints: [], now: f.now,
  });
  assert.equal(recovered.status, "waiting_media");
  assert.equal(recovered.application_id, "application-2");
  assert.equal(recovered.receipt_path, undefined);
  f.advance();
  assert.equal((await f.tick(second.id)).status, "ready");
  assert.equal(f.submitted, 0);
  assert.equal(f.downloaded, 2);
});

test("active lease prevents concurrent workers from submitting a second application", async (t) => {
  const f = await fixture(t);
  const job = f.enqueue();
  const claimed = f.store.claim(job.id, { leaseMs: 2000 });
  assert.equal((await f.tick(job.id)).status, "queued");
  assert.equal(f.submitted, 0);
  f.store.save(job.id, claimed.leaseToken, job);
  assert.equal((await f.tick(job.id)).status, "waiting_approval");
  assert.equal(f.submitted, 1);
});

test("authentication rejection during submit pauses with durable intent and resumes only reconciliation", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.client.submitApplication = async () => { calls += 1; throw new VmSourceError("VM_AUTH_REQUIRED"); };
  const job = f.enqueue();
  const result = await f.tick(job.id);
  assert.equal(result.status, "auth_required");
  assert.equal(result.resume_phase, "submitting");
  resumeVmApproval(f.store, job.id, { now: f.now });
  assert.equal((await f.tick(job.id)).status, "reconciling");
  assert.equal(calls, 1);
});

test("recovery rejects wrong approval provenance; explicit legacy reuse retains operator assertion", async (t) => {
  const f = await fixture(t, { application_id: "application-1" });
  f.approve();
  const ready = await f.tick(f.enqueue().id);
  const receipt = JSON.parse(await readFile(ready.receipt_path, "utf8"));
  await assert.rejects(verifyVmAcquisitionReceipt(ready.receipt_path, {
    vmid: VMID, applicationId: "application-1", instanceCode: "different-instance",
  }), { code: "VM_RECEIPT_INVALID" });
  receipt.provenance = { kind: "operator_provided_approval", vmid_binding: "operator_asserted",
    approval_ref: "application-1" };
  await writeFile(ready.receipt_path, JSON.stringify(receipt));
  await assert.rejects(verifyVmAcquisitionReceipt(ready.receipt_path, {
    vmid: VMID, applicationId: "application-1",
  }), { code: "VM_RECEIPT_INVALID" });
  const reused = f.enqueue({ reuse_receipt: ready.receipt_path });
  const result = await f.tick(reused.id);
  assert.equal(result.status, "ready");
  assert.equal(result.acquisition.vmid_binding, "operator_asserted");
  assert.equal(f.downloaded, 1);
});
