import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { createVmApprovalStore } from "../server/vm-approval-store.mjs";
import { createVmDownloadMetadata, createVmDownloadNotifier } from "../server/vm-download-notifier.mjs";
import { createVmDownloadService } from "../server/vm-download-service.mjs";
import { prepareVmSource } from "../server/vm-source-adapter.mjs";
import { VmSourceError } from "../server/vm-source-transfer.mjs";

const vmid = "678465c3d94605d24bb9361a";
const second = "678465c3d94605d24bb9361b";
const identity = { name: "Fixture", user_id: "fixture-user", open_id: "ou_fixture", enterprise_email: "fixture@example.test", departments: ["dept"] };
const day = 86400000;
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vm-service-"));
  let time = 1000000000;
  let account = identity;
  let status = "connected";
  let expiresAt = null;
  let service;
  let db;
  let store;
  const client = options.client ?? {};
  const session = {
    snapshot: () => ({ status, account: account ? { name: account.name, userId: account.user_id } : null, expiresAt, expirySource: expiresAt === null ? "unknown" : "token", lastCheckedAt: time, errorCode: null, automaticRefreshSupported: false, crossDeviceAuthorizationSupported: false }),
    identity: () => account,
    client: () => status === "connected" ? client : null,
    check: async () => {}, beginLogin: async () => ({ loginUrl: "https://shadow.yangcong345.com/fixture", session: session.snapshot() }),
    disconnect: async () => { account = null; status = "disconnected"; }, close: async () => {},
    requireLogin: async () => { status = "auth_required"; },
  };
  function start(extra = {}) {
    db = new DatabaseSync(path.join(dir, "metadata.sqlite"));
    store = createVmApprovalStore({ file: path.join(dir, "queue.sqlite"), now: () => time });
    service = createVmDownloadService({ store, metadata: createVmDownloadMetadata({ database: db, now: () => time }),
      session, now: () => time, defaultOutputRoot: dir, notifier: { available: () => false }, ...options, ...extra });
    return service;
  }
  start();
  t.after(async () => { await service.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, get service() { return service; }, get store() { return store; }, session,
    advance: (ms) => { time += ms; }, account: (value) => { account = value; }, status: (value) => { status = value; },
    expiresIn: (ms) => { expiresAt = ms === null ? null : time + ms; },
    async restart(extra) { await service.close(); db.close(); return start(extra); },
    input: (vmids = [vmid]) => ({ vmids, department: "动画组", reason: "切片剪辑", outputRoot: dir }),
    update(id, mutate) { const claim = store.claim(id); const job = claim.job; mutate(job); return store.save(id, claim.leaseToken, job); },
  };
}

test("batch validates every input before enqueue; exact requests reuse persistent jobs and settings", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.enqueue(f.input([vmid, "bad"])), { code: "VM_APPROVAL_REQUEST_INVALID" });
  assert.equal(f.store.list().length, 0);
  assert.throws(() => f.service.enqueue(f.input(Array(51).fill(vmid))), { code: "VM_DOWNLOAD_BATCH_INVALID" });
  assert.throws(() => f.service.enqueue({ ...f.input(), allowed_origins: ["https://untrusted.test"] }));
  const jobs = f.service.enqueue(f.input([vmid, second])).jobs;
  assert.equal(jobs.length, 2);
  assert.equal(f.service.enqueue(f.input()).jobs[0].id, jobs[0].id);
  f.service.updateSettings({ outputRoot: f.dir, department: "动画组", reason: "切片剪辑", notificationsEnabled: false });
  await f.restart();
  assert.equal(f.service.snapshot().jobs.length, 2);
  assert.equal(f.service.snapshot().settings.notificationsEnabled, false);
  assert.equal(f.service.enqueue(f.input()).jobs[0].id, jobs[0].id);
});

test("internal requestFor freezes the same server policy used by enqueue", async (t) => {
  const f = await fixture(t);
  const input = { vmid, department: "动画组", reason: "切片剪辑", outputRoot: f.dir };
  const request = f.service.requestFor(input);
  assert.deepEqual(request, {
    schema_version: 1, vmid, department: input.department, reason: input.reason,
    output_root: f.dir, allowed_origins: ["https://vm-resource.yangcong345.com"], private_endpoints: [],
  });
  assert.equal(f.store.list().length, 0);
  assert.throws(() => f.service.requestFor({ ...input, allowed_origins: ["https://other.example"] }),
    { code: "VM_DOWNLOAD_INPUT_INVALID" });
  const queued = f.service.enqueue({ vmids: [vmid], department: input.department, reason: input.reason, outputRoot: input.outputRoot }).jobs[0];
  assert.deepEqual(f.store.get(queued.id).request, request);
});

test("internal exact lookup reconciles a job without exposing its request policy", async (t) => {
  const f = await fixture(t);
  const created = f.service.enqueue(f.input()).jobs[0];
  const fingerprint = f.store.get(created.id).request_fingerprint;
  const found = f.service.lookupExact({ requestFingerprint: fingerprint });
  assert.equal(found.id, created.id);
  assert.equal(found.requestFingerprint, fingerprint);
  assert.equal(found.vmid, vmid);
  assert.equal(f.service.lookupExact({ requestFingerprint: "a".repeat(64) }), null);
  assert.equal(f.service.lookupExact({ requestFingerprint: fingerprint, jobId: "vm-other" }), null);
  assert.throws(() => f.service.lookupExact({ requestFingerprint: "invalid" }), { code: "VM_DOWNLOAD_INPUT_INVALID" });
  assert.equal(Object.hasOwn(f.service.snapshot().jobs[0], "requestFingerprint"), false);
  assert.doesNotMatch(JSON.stringify(found), /allowed_origins|private_endpoints/iu);
  await f.restart();
  assert.equal(f.service.lookupExact({ requestFingerprint: fingerprint, jobId: created.id }).id, created.id);
});

test("queue cleanup hides settled rows, keeps task lookup intact, and restores a reused request", async (t) => {
  const f = await fixture(t);
  const ready = f.service.enqueue(f.input()).jobs[0];
  f.update(ready.id, (job) => { job.status = "ready"; });
  assert.equal(f.service.cleanup([ready.id]).clearedCount, 1);
  assert.deepEqual(f.service.snapshot().jobs, []);
  assert.equal(f.service.lookupExact({ requestFingerprint: f.store.get(ready.id).request_fingerprint, jobId: ready.id }).status, "ready");

  const reused = f.service.enqueue(f.input()).jobs[0];
  assert.equal(reused.id, ready.id);
  assert.equal(f.service.snapshot().jobs.length, 1);
  assert.equal(f.store.get(ready.id).queue_hidden_at, undefined);
  assert.equal(f.service.cleanup([ready.id]).clearedCount, 1);
  assert.deepEqual(f.service.snapshot().jobs, []);
  assert.throws(() => f.service.cleanup([]), { code: "VM_DOWNLOAD_INPUT_INVALID" });
});

test("private endpoint recovery applies the restarted service policy without submitting another application", async (t) => {
  let application;
  let submitted = 0;
  let transfers = 0;
  let allowPrivateAddress = false;
  const client = {
    getIdentity: async () => ({ raw: { feishu: identity } }),
    getVideos: async id => ({ total: 1, videos: [{ id }] }),
    getDepartments: async () => ({ data: { department_infos: [{ id: "dept", name: "动画组" }] } }),
    listApplications: async () => ({ list: application ? [application] : [] }),
    submitApplication: async () => {
      submitted++;
      application = { id: "app-recovery", instanceCode: "approval-recovery", createdAt: new Date(1000000000).toISOString(),
        applyUser: { feishuUserId: identity.user_id }, applyReason: "切片剪辑", videoUse: "ORIGINAL", videoQuality: "HIGH",
        applyStatus: "APPROVED", urlObjList: [{ id: vmid, status: "finished", url: "https://vm-resource.yangcong345.com/fixture.mp4?signature=private" }] };
    },
    getApplication: async () => application,
  };
  const acquire = (raw, config, dependencies) => prepareVmSource(raw, config, { ...dependencies,
    download: async ({ destination }) => {
      transfers++;
      if (!allowPrivateAddress) throw new VmSourceError("VM_SOURCE_ADDRESS_NOT_ALLOWED");
      const payload = Buffer.from("fixture-video");
      await writeFile(destination, payload);
      return { bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
    },
    validateMedia: async () => ({ container: "mov,mp4", duration_ms: 2000,
      video: [{ width: 1280, height: 720 }], audio: [], validation: { metadata: true, full_decode: true } }),
  });
  const f = await fixture(t, { client, workerOptions: { acquire } });
  const queued = f.service.enqueue(f.input()).jobs[0];
  await f.service.wake();
  assert.equal(f.store.get(queued.id).last_error, "VM_SOURCE_ADDRESS_NOT_ALLOWED");
  assert.equal(submitted, 1);
  allowPrivateAddress = true;
  await f.restart({ privateEndpoints: [{ origin: "https://vm-resource.yangcong345.com", addresses: ["10.8.8.11"] }] });

  f.service.recover(queued.id, { confirmRepeatableResource: true });
  await f.service.wake();

  const ready = f.store.get(queued.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.application_id, "app-recovery");
  assert.equal(ready.instance_code, "approval-recovery");
  assert.deepEqual(ready.request.private_endpoints, [{ origin: "https://vm-resource.yangcong345.com", addresses: ["10.8.8.11"] }]);
  assert.equal(submitted, 1);
  assert.equal(transfers, 2);
});

test("unknown outcomes expose operator-confirmed recovery when the configured origin is allowed", async (t) => {
  const policy = [{ origin: "https://vm-resource.yangcong345.com", addresses: ["10.8.8.11"] }];
  const legacy = await fixture(t);
  const oldJob = legacy.service.enqueue(legacy.input()).jobs[0];
  await legacy.restart({ privateEndpoints: policy });
  legacy.update(oldJob.id, (job) => {
    job.status = "needs_attention";
    job.last_error = "VM_DOWNLOAD_OUTCOME_UNKNOWN";
  });
  assert.deepEqual(legacy.service.snapshot().jobs[0].recovery, { kind: "unknown_outcome" });

  const current = await fixture(t, { privateEndpoints: policy });
  const newJob = current.service.enqueue(current.input()).jobs[0];
  current.update(newJob.id, (job) => {
    job.status = "needs_attention";
    job.last_error = "VM_DOWNLOAD_OUTCOME_UNKNOWN";
  });
  const currentPublicJob = current.service.snapshot().jobs[0];
  assert.deepEqual(currentPublicJob.recovery, { kind: "unknown_outcome" });
});

test("an approved cross-application resource claim exposes a recovery action", async (t) => {
  const f = await fixture(t);
  const job = f.service.enqueue(f.input()).jobs[0];
  f.update(job.id, (value) => {
    value.status = "needs_attention";
    value.last_error = "VM_RESOURCE_ALREADY_CLAIMED";
    value.application_id = "application-2";
    value.instance_code = "approval-2";
    value.approval = { status: "APPROVED", resource_id: vmid, video_quality: "HIGH", checked_at: 1000000000 };
    value.resource_fingerprint = "a".repeat(64);
  });
  assert.deepEqual(f.service.snapshot().jobs[0].recovery, { kind: "resource_claim" });

  f.update(job.id, (value) => { delete value.approval; });
  assert.equal(f.service.snapshot().jobs[0].recovery, undefined);
});

test("logout before transfer fences the single-use download and original application resumes after reconnect", async (t) => {
  let submitted = 0, downloaded = 0, application;
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  let block = true;
  const client = Object.freeze({
    getIdentity: async () => ({ raw: { feishu: identity } }),
    getVideos: async id => ({ total: 1, videos: [{ id }] }),
    getDepartments: async () => ({ data: { department_infos: [{ id: "dept", name: "动画组" }] } }),
    listApplications: async () => ({ list: application ? [application] : [] }),
    submitApplication: async () => { submitted++; application = { id: "app", instanceCode: "instance", createdAt: new Date(1000000000).toISOString(), applyUser: { feishuUserId: identity.user_id }, applyReason: "切片剪辑", videoUse: "ORIGINAL", videoQuality: "HIGH", applyStatus: "APPROVED", urlObjList: [{ id: vmid, status: "finished", url: "https://vm-resource.yangcong345.com/fixture.mp4?signature=private" }] }; },
    getApplication: async () => application,
  });
  const acquire = async (raw, config, dependencies) => {
    if (block) { entered(); await new Promise(resolve => { release = resolve; }); block = false; }
    return prepareVmSource(raw, config, { ...dependencies,
      download: async ({ destination }) => { downloaded++; await writeFile(destination, Buffer.from("fixture")); return { bytes: 7, sha256: createHash("sha256").update("fixture").digest("hex") }; },
      validateMedia: async () => ({ container: "mov,mp4", duration_ms: 2000, video: [{ width: 1280, height: 720 }], audio: [], validation: { metadata: true, full_decode: true } }),
    });
  };
  const f = await fixture(t, { client, workerOptions: { acquire } });
  const job = f.service.enqueue(f.input()).jobs[0];
  const run = f.service.wake(); await waiting;
  await f.service.logout(); release(); await run;
  assert.equal(downloaded, 0); assert.equal(f.store.get(job.id).status, "auth_required");
  f.account(identity); f.status("connected"); await f.service.wake();
  assert.equal(submitted, 1); assert.equal(downloaded, 1);
  assert.equal(f.store.get(job.id).status, "ready");
});

test("coalesced worker waits for due times, continues after 30 minutes and restores after restart", async (t) => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const processJob = async (store, id, { now }) => {
    active++; maxActive = Math.max(maxActive, active); calls++;
    await new Promise(resolve => setImmediate(resolve));
    const claim = store.claim(id);
    const job = claim.job;
    job.status = "waiting_approval"; job.next_attempt_at = now() + 60000;
    store.save(id, claim.leaseToken, job);
    active--;
    return job;
  };
  const f = await fixture(t, { processJob });
  f.service.enqueue(f.input());
  await Promise.all([f.service.wake(), f.service.wake(), f.service.wake()]);
  assert.equal(calls, 1); assert.equal(maxActive, 1);
  await f.service.wake(); assert.equal(calls, 1);
  f.advance(31 * 60000); await f.service.wake(); assert.equal(calls, 2);
  f.status("disconnected"); await f.restart({ processJob });
  f.advance(60000); await f.service.wake(); assert.equal(calls, 2);
  f.status("connected"); await f.service.wake(); assert.equal(calls, 3);
});

test("auth reconnect only resumes its account and ready jobs never replay", async (t) => {
  let calls = 0;
  const f = await fixture(t, { processJob: async (store, id) => { calls++; return store.get(id); } });
  const [job, ready] = f.service.enqueue(f.input([vmid, second])).jobs;
  f.update(job.id, value => { value.status = "auth_required"; value.resume_phase = "waiting_approval"; value.next_attempt_at = null; });
  f.update(ready.id, value => { value.status = "ready"; value.next_attempt_at = null; });
  f.account({ ...identity, user_id: "another-user" });
  await f.service.wake(); assert.equal(calls, 0);
  assert.throws(() => f.service.resume(job.id), { code: "VM_APPLICANT_CHANGED" });
  f.account(identity); await f.service.wake(); assert.equal(calls, 1);
  assert.equal(f.store.get(job.id).status, "waiting_approval");
  assert.equal(f.store.get(ready.id).status, "ready");
});

test("close waits for an in-flight job before closing its store", async (t) => {
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { processJob: async (store, id) => {
    entered(); await new Promise(resolve => { release = resolve; }); return store.get(id);
  } });
  f.service.enqueue(f.input());
  const run = f.service.wake(); await enteredPromise;
  let closed = false;
  const closing = f.service.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await run; await closing;
});

test("notifications deduplicate durably, retry failures and never overwrite active job state", async (t) => {
  let sends = 0;
  let fail = true;
  const notifier = { available: () => true, send: async () => { sends++; if (fail) throw new Error("secret transport text"); } };
  const f = await fixture(t, { notifier, processJob: async (store, id) => store.get(id) });
  const job = f.service.enqueue(f.input()).jobs[0];
  f.update(job.id, value => { value.status = "waiting_approval"; value.application_id = "application"; value.approval_wait_started_at = 1000000000; value.approval_deadline_at = 1000000000 + 7 * day; value.next_attempt_at = 1000000000 + 7 * day; });
  f.advance(day); await f.service.wake(); assert.equal(sends, 1);
  await f.service.wake(); assert.equal(sends, 1);
  assert.doesNotMatch(JSON.stringify(f.service.snapshot()), /secret transport text/);
  fail = false; f.advance(60000); await f.service.wake(); assert.equal(sends, 2);
  await f.restart({ notifier }); await f.service.wake(); assert.equal(sends, 2);
  assert.equal(f.store.get(job.id).status, "waiting_approval");
});

test("expiry reminders start thirty minutes before expiry and remain deduplicated across restart", async (t) => {
  const sent = [];
  const notifier = { available: () => true, send: async value => { sent.push(value); } };
  const f = await fixture(t, { notifier, processJob: async (store, id) => store.get(id) });
  const job = f.service.enqueue(f.input()).jobs[0];
  f.expiresIn(30 * 60_000 + 1);
  await f.service.wake();
  assert.equal(sent.length, 0);
  f.advance(1);
  await f.service.wake();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "expiring");
  assert.equal(sent[0].recipient, identity.enterprise_email);
  assert.equal(sent[0].vmid, null);
  f.advance(15 * 60_000);
  await f.service.wake();
  await f.restart({ notifier });
  await f.service.wake();
  assert.equal(sent.length, 1);
  assert.equal(f.store.get(job.id).status, "queued");

  // A rotated credential with a new expiry gets its own reminder.
  f.expiresIn(31 * 60_000);
  await f.service.wake();
  assert.equal(sent.length, 1);
  f.advance(60_000);
  await f.service.wake();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].id, sent[1].id);
});

test("expiry reminders require a future known expiry, a connected account and active work", async (t) => {
  for (const scenario of ["unknown", "expired", "expires_now", "disconnected", "idle", "settled", "disabled"]) {
    await t.test(scenario, async (t) => {
      const sent = [];
      const f = await fixture(t, { notifier: { available: () => true, send: async value => { sent.push(value); } },
        processJob: async (store, id) => store.get(id) });
      const job = scenario === "idle" ? null : f.service.enqueue(f.input()).jobs[0];
      f.expiresIn(scenario === "unknown" ? null : scenario === "expired" ? -1 : scenario === "expires_now" ? 0 : 10 * 60_000);
      if (scenario === "disconnected") f.status("disconnected");
      if (scenario === "settled") f.update(job.id, value => { value.status = "ready"; });
      if (scenario === "disabled") f.service.updateSettings({ ...f.service.snapshot().settings, notificationsEnabled: false });
      await f.service.wake();
      assert.equal(sent.filter(value => value.kind === "expiring").length, 0);
    });
  }
});

test("pending expiry reminders are discarded when their session or active work is no longer current", async (t) => {
  for (const scenario of ["expired", "rotated", "settled", "disconnected"]) {
    await t.test(scenario, async (t) => {
      let attempts = 0;
      const sent = [];
      const notifier = { available: () => true, send: async value => {
        attempts++;
        if (attempts === 1) throw new Error("temporary notification failure");
        sent.push(value);
      } };
      const f = await fixture(t, { notifier, processJob: async (store, id) => store.get(id) });
      const job = f.service.enqueue(f.input()).jobs[0];
      f.expiresIn(scenario === "expired" ? 30_000 : 10 * 60_000);
      await f.service.wake();
      assert.equal(attempts, 1);
      if (scenario === "rotated") f.expiresIn(60 * 60_000);
      if (scenario === "settled") f.update(job.id, value => { value.status = "ready"; });
      if (scenario === "disconnected") f.status("disconnected");
      f.advance(60_000);
      await f.restart({ notifier });
      await f.service.wake();
      assert.equal(sent.filter(value => value.kind === "expiring").length, 0);
      assert.equal(f.service.snapshot().notifications.errorCode, null);
      f.advance(5 * 60_000);
      await f.service.wake();
      assert.equal(sent.filter(value => value.kind === "expiring").length, 0);
    });
  }
});

test("official SDK notification adapter uses verified email, safe text and stable idempotency ID", async () => {
  const requests = [];
  const notifier = createVmDownloadNotifier({ appId: "fixture", appSecret: "fixture-secret", createContext: async () => ({ client: { im: { message: { create: async value => { requests.push(value); return { code: 0, data: { message_id: "message" } }; } } } } }) });
  await notifier.send({ id: "a".repeat(32), recipient: identity.enterprise_email, kind: "auth_required", vmid: null });
  assert.equal(requests[0].params.receive_id_type, "email");
  assert.equal(requests[0].data.receive_id, identity.enterprise_email);
  assert.equal(requests[0].data.uuid, "a".repeat(32));
  assert.doesNotMatch(requests[0].data.content, /http|token|fixture-secret/iu);
  const authText = JSON.parse(requests[0].data.content).text;
  assert.match(authText, /Auto-Cut 包.*VM 账号与队列/u);
  assert.match(authText, /重新连接账号/u);
  await notifier.send({ id: "b".repeat(32), recipient: identity.enterprise_email, kind: "expiring", vmid: null });
  const expiryText = JSON.parse(requests[1].data.content).text;
  assert.match(expiryText, /30 分钟/u);
  assert.match(expiryText, /Taskboard.*VM 账号与队列/u);
  assert.match(expiryText, /重新连接账号.*Shadow.*登录/u);
  assert.doesNotMatch(requests[1].data.content, /http|token|fixture-secret|127\.0\.0\.1/iu);
});
