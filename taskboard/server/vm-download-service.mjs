import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createVmDownloadSession } from "./vm-download-session.mjs";
import { enqueueVmApproval, extendVmApprovalWait, processVmApproval, resumeVmApproval, summarizeVmApproval, validateVmApprovalRequest } from "./vm-approval-workflow.mjs";
import { VmSourceError } from "./vm-source-transfer.mjs";
import { prepareVmSource } from "./vm-source-adapter.mjs";

const TERMINAL = new Set(["ready", "rejected", "canceled", "needs_attention", "auth_required", "dead_letter"]);
const DAY = 86400000;
const fail = code => { throw new VmSourceError(code); };
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("VM_DOWNLOAD_INPUT_INVALID"); }
function accountValid(value) {
  return object(value) && typeof value.userId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value.userId)
    && typeof value.email === "string" && value.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email)
    && typeof value.epoch === "string" && /^[a-f0-9-]{36}$/u.test(value.epoch);
}

export function createVmDownloadService({ store, metadata, session: injectedSession, sessionOptions = {},
  notifier = { available: () => false }, now = Date.now,
  defaultOutputRoot = path.join(os.homedir(), "Desktop"),
  allowedOrigins = ["https://vm-resource.yangcong345.com"], privateEndpoints = [],
  processJob = processVmApproval, workerOptions = {}, tickMs = 1000 } = {}) {
  if (!store || !metadata || !Number.isSafeInteger(tickMs) || tickMs < 10) fail("VM_DOWNLOAD_INPUT_INVALID");
  let timer;
  let running;
  let requested = false;
  let started = false;
  let closed = false;
  let closePromise;
  let lastClient;
  let workerError = null;
  const session = injectedSession ?? createVmDownloadSession({ ...sessionOptions, now, onChange: () => { if (started) void wake(); } });
  let settings = metadata.read("settings") ?? { outputRoot: defaultOutputRoot, department: "动画组", reason: "切片剪辑", notificationsEnabled: true };
  function request(vmid, fields) {
    return validateVmApprovalRequest({ schema_version: 1, vmid, department: fields.department, reason: fields.reason,
      output_root: fields.outputRoot, allowed_origins: allowedOrigins, private_endpoints: privateEndpoints });
  }
  function validateSettings(value) {
    keys(value, ["outputRoot", "department", "reason", "notificationsEnabled"]);
    request("000000000000000000000000", value);
    if (typeof value.notificationsEnabled !== "boolean") fail("VM_DOWNLOAD_INPUT_INVALID");
    return { outputRoot: path.resolve(value.outputRoot), department: value.department, reason: value.reason, notificationsEnabled: value.notificationsEnabled };
  }
  try { settings = validateSettings(settings); } catch { fail("VM_DOWNLOAD_STATE_INVALID"); }
  let lastAccount = metadata.read("account");
  if (lastAccount !== null && !accountValid(lastAccount)) fail("VM_DOWNLOAD_STATE_INVALID");
  function publicJob(job) { return summarizeVmApproval(job, { includeLocalRequest: true }); }
  function owner(job, required = false) {
    const identity = session.identity();
    if (required && !session.client()) fail("VM_AUTH_REQUIRED");
    if (job.requester_id && job.requester_id !== identity?.user_id) fail("VM_APPLICANT_CHANGED");
    return identity;
  }
  function bind(id, identity) {
    const claim = store.claim(id);
    if (!claim) return false;
    const job = claim.job;
    if (job.requester_id && job.requester_id !== identity.user_id) {
      store.save(id, claim.leaseToken, job); return false;
    }
    job.requester_id = identity.user_id;
    store.save(id, claim.leaseToken, job);
    return true;
  }
  function rememberAccount() {
    const client = session.client();
    const identity = session.identity();
    if (!client || !identity) return;
    if (client !== lastClient) {
      const next = { userId: identity.user_id, email: identity.enterprise_email, epoch: randomUUID() };
      if (accountValid(next)) { metadata.write("account", next); lastAccount = next; }
      lastClient = client;
    }
  }
  function queueNotifications(jobs) {
    if (!settings.notificationsEnabled || !lastAccount) return;
    const state = session.snapshot();
    const active = jobs.filter(job => job.requester_id === lastAccount.userId && (!TERMINAL.has(job.status) || job.status === "auth_required"));
    const enqueue = (key, kind, vmid) => metadata.enqueue({ key, kind, vmid, recipient: lastAccount.email });
    if (active.length && ["disconnected", "auth_required"].includes(state.status)) enqueue(`auth:${lastAccount.epoch}`, "auth_required");
    if (active.length && state.status === "connected" && state.expiresAt !== null && state.expiresAt - now() <= 15 * 60000) {
      enqueue(`expiry:${lastAccount.userId}:${state.expiresAt}`, "expiring");
    }
    for (const job of jobs) {
      if (job.requester_id !== lastAccount.userId) continue;
      if (job.status === "waiting_approval" && Number.isSafeInteger(job.approval_wait_started_at) && now() - job.approval_wait_started_at >= DAY) {
        enqueue(`approval:${job.id}:${job.approval_deadline_at}`, "approval_reminder", job.request.vmid);
      }
      let kind;
      if (["rejected", "canceled"].includes(job.status)) kind = job.status;
      else if (["needs_attention", "dead_letter"].includes(job.status)) kind = ["VM_APPROVAL_WAIT_EXPIRED", "VM_MEDIA_WAIT_EXPIRED"].includes(job.last_error) ? "wait_expired" : "failed";
      if (kind) enqueue(`job:${job.id}:${job.status}:${job.last_error}:${job.approval_deadline_at}:${job.media_deadline_at}`, kind, job.request.vmid);
    }
  }
  async function notify() {
    if (!settings.notificationsEnabled || !notifier.available()) return;
    // Bound each pass so a notification backlog cannot starve the queue.
    for (let count = 0; count < 10 && !closed && settings.notificationsEnabled; count++) {
      const item = metadata.claim();
      if (!item) break;
      let success = false;
      try { await notifier.send({ id: item.id, recipient: item.recipient, kind: item.kind, vmid: item.vmid }); success = true; }
      catch { /* Persist only a known error, never an SDK response or request. */ }
      metadata.complete(item, success);
    }
  }
  async function pass() {
    rememberAccount();
    for (const pending of store.list()) {
      if (closed) break;
      const client = session.client();
      const identity = session.identity();
      if (!client || !identity || (pending.requester_id && pending.requester_id !== identity.user_id)) continue;
      let job = pending;
      if (job.status === "auth_required") {
        try { job = resumeVmApproval(store, job.id, { now }); }
        catch (error) { if (error?.code === "VM_APPROVAL_JOB_BUSY") continue; throw error; }
      }
      if (TERMINAL.has(job.status) || job.next_attempt_at > now()) continue;
      if (!job.requester_id && !bind(job.id, identity)) continue;
      // A login/logout/account switch fences every subsequent API call in this job.
      const guardedClient = Object.fromEntries(Object.entries(client).map(([property, method]) => [property,
        typeof method !== "function" ? method : async (...args) => {
          if (session.client() !== client) fail("VM_AUTH_REQUIRED");
          const result = await method.apply(client, args);
          if (session.client() !== client) fail("VM_AUTH_REQUIRED");
          return result;
        },
      ]));
      const acquire = async (raw, config, dependencies) => {
        if (session.client() !== client) fail("VM_AUTH_REQUIRED");
        return (workerOptions.acquire ?? prepareVmSource)(raw, config, { ...dependencies,
          beforeTransfer: async (value) => {
            if (session.client() !== client) fail("VM_AUTH_REQUIRED");
            return dependencies.beforeTransfer(value);
          },
        });
      };
      const result = await processJob(store, job.id, { ...workerOptions, acquire, client: guardedClient, now });
      if (result.status === "auth_required" && session.client() === client) await session.requireLogin();
    }
    queueNotifications(store.list());
    await notify();
  }
  function wake() {
    if (closed) return Promise.resolve();
    requested = true;
    if (!running) {
      running = Promise.resolve().then(async () => {
        do {
          requested = false;
          try { await pass(); workerError = null; }
          catch { workerError = "VM_DOWNLOAD_WORKER_FAILED"; }
        } while (requested && !closed);
      }).finally(() => { running = null; });
    }
    return running;
  }
  function kick() { if (started) void wake(); }
  return {
    requestFor(input) {
      if (closed) fail("VM_DOWNLOAD_CLOSED");
      keys(input, ["vmid", "department", "reason", "outputRoot"]);
      return request(input.vmid, input);
    },
    lookupExact(input) {
      if (closed) fail("VM_DOWNLOAD_CLOSED");
      keys(input, ["requestFingerprint", "jobId"]);
      if (typeof input.requestFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(input.requestFingerprint)
        || (input.jobId != null && (typeof input.jobId !== "string"
          || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(input.jobId)))) {
        fail("VM_DOWNLOAD_INPUT_INVALID");
      }
      const job = input.jobId
        ? store.get(input.jobId)
        : store.list().find((candidate) => candidate.request_fingerprint === input.requestFingerprint);
      if (!job || job.request_fingerprint !== input.requestFingerprint) return null;
      if (session.client() && job.requester_id && job.requester_id !== session.identity()?.user_id) {
        fail("VM_APPLICANT_CHANGED");
      }
      return { ...publicJob(job), requestFingerprint: job.request_fingerprint };
    },
    snapshot() {
      const summary = metadata.summary();
      return { session: session.snapshot(), settings: structuredClone(settings), jobs: store.list().map(publicJob),
        notifications: { ...summary, available: notifier.available() && Boolean(lastAccount) && !summary.errorCode, enabled: settings.notificationsEnabled,
          errorCode: !notifier.available() ? "VM_NOTIFY_NOT_CONFIGURED" : !lastAccount ? "VM_NOTIFY_RECIPIENT_UNAVAILABLE" : summary.errorCode },
        worker: { running: Boolean(running), errorCode: workerError } };
    },
    updateSettings(input) { if (closed) fail("VM_DOWNLOAD_CLOSED"); settings = validateSettings(input); metadata.write("settings", settings); kick(); return { settings: structuredClone(settings) }; },
    async beginLogin() { if (closed) fail("VM_DOWNLOAD_CLOSED"); return session.beginLogin(); },
    async logout() { await session.disconnect(); lastClient = undefined; return { session: session.snapshot() }; },
    enqueue(input) {
      if (closed) fail("VM_DOWNLOAD_CLOSED");
      keys(input, ["vmids", "department", "reason", "outputRoot"]);
      if (!Array.isArray(input.vmids) || input.vmids.length < 1 || input.vmids.length > 50) fail("VM_DOWNLOAD_BATCH_INVALID");
      const requests = [...new Set(input.vmids)].map(vmid => request(vmid, input));
      // Check all existing ownership before creating any jobs.
      const existing = store.list();
      const identity = session.client() ? session.identity() : null;
      for (const value of requests) {
        const duplicate = existing.find(job => JSON.stringify(job.request) === JSON.stringify(value));
        if (duplicate?.requester_id && duplicate.requester_id !== identity?.user_id) fail("VM_APPLICANT_CHANGED");
      }
      const jobs = requests.map(value => {
        const job = enqueueVmApproval(store, value, { now });
        if (identity && !job.requester_id) bind(job.id, identity);
        return publicJob(store.get(job.id));
      });
      kick(); return { jobs };
    },
    resume(id) { const job = store.get(id); if (!job) fail("VM_APPROVAL_JOB_NOT_FOUND"); owner(job, true); const result = resumeVmApproval(store, id, { now }); kick(); return { job: publicJob(result) }; },
    extend(id) { const job = store.get(id); if (!job) fail("VM_APPROVAL_JOB_NOT_FOUND"); owner(job, true); const result = extendVmApprovalWait(store, id, { now }); kick(); return { job: publicJob(result) }; },
    start() { if (closed || started) return; started = true; timer = setInterval(() => { void wake(); }, tickMs); timer.unref?.(); kick(); },
    wake,
    close() {
      closePromise ??= (async () => { closed = true; started = false; clearInterval(timer); await running; await session.close(); store.close(); })();
      return closePromise;
    },
  };
}
