import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set(["completed", "blocked", "needs_attention"]);
const STATES = new Set(["waiting_materials", "ready", "preparing", "prepared", "planning", "planned",
  "rendering", "rendered", "delivery_pending", "delivery_confirmed", ...TERMINAL]);
const APPROVAL_STATES = new Set(["reserved", "queued", "submitting", "reconciling", "waiting_approval",
  "waiting_media", "acquiring", "retry_wait", "auth_required", "needs_attention", "dead_letter", "ready", "rejected", "canceled"]);
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;
const MAX_PLAN_ATTEMPTS = 3;
const PAYLOAD_KEYS = new Set(["binding", "approvalStatus", "acquisition", "prepared", "planStartedAt",
  "runnerStartedAt", "processingNotified", "planSha256", "renderResult", "artifactId", "deliveredFileToken", "completedAt",
  "planAttempt", "retryHistory"]);

function failure(code) { const error = new Error(code); error.code = code; return error; }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value) { return typeof value === "string" && ID.test(value); }
function packageAlias(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && !["__proto__", "constructor", "prototype"].includes(value)
    && !/^[./\\]/u.test(value) && !/[\s\u0000-\u001f\u007f"'`:$<>|]/u.test(value);
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function safeCode(error, fallback = "VM_PMO_OPERATION_FAILED") {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,100}$/u.test(error.code) ? error.code : fallback;
}
function json(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw failure("VM_PMO_STATE_INVALID");
  return text;
}
function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function frozenIdentity(database, taskId, started = false) {
  const task = database.getTask(taskId);
  const origin = database.getFeishuTaskOrigin(taskId);
  const snapshot = database.getFeishuTaskPackageSnapshot(taskId);
  const outputAttachmentFieldId = origin?.stageSnapshot?.vmWorkflow?.fields?.outputAttachmentFieldId;
  if (!task || task.id !== taskId || task.archivedAt !== null
    || !(started ? ["todo", "queued", "in_progress", "in_review", "done"] : ["todo", "queued"]).includes(task.status)
    || !task.labels?.includes("feishu") || origin?.source !== "feishu-base"
    || origin.packageSource !== "subject-config" || origin.deliverySource !== undefined
    || !["initial", "review"].includes(origin.stageId) || !["manual", "automatic"].includes(origin.executionMode)
    || ![origin.baseToken, origin.tableId, origin.recordId].every(id) || !packageAlias(origin.packageAlias)
    || typeof origin.eventId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,511}$/u.test(origin.eventId)
    || origin.subjectKey !== `${origin.baseToken}:${origin.tableId}`
    || !Number.isSafeInteger(origin.configVersion) || origin.configVersion < 1
    || snapshot?.packageAlias !== origin.packageAlias
    || !Number.isSafeInteger(snapshot.packageRevision) || snapshot.packageRevision < 1
    || snapshot.workflowTemplate?.id !== "vm_pmo_review_video" || snapshot.workflowTemplate.version !== 1
    || !id(outputAttachmentFieldId)
    || origin.stageId === "review" && (!object(origin.stageSnapshot?.reviewParent)
      || origin.stageSnapshot.reviewParent.reviewRound + 1 !== origin.stageSnapshot.reviewRound))
    throw failure("VM_PMO_TASK_NOT_ELIGIBLE");
  return { taskId, outputAttachmentFieldId, origin: Object.fromEntries(["source", "packageSource", "eventId", "baseToken", "tableId",
    "recordId", "subjectKey", "configVersion", "stageId", "packageAlias", "executionMode"].map((key) => [key, origin[key]])),
  stageSnapshot: structuredClone(origin.stageSnapshot),
  packageSnapshot: { packageAlias: snapshot.packageAlias, packageRevision: snapshot.packageRevision,
    workflowTemplate: { id: snapshot.workflowTemplate.id, version: snapshot.workflowTemplate.version } } };
}

function checkedBinding(value, taskId, previous) {
  if (!object(value) || value.taskId !== taskId || !id(value.runId)
    || typeof value.vmid !== "string" || !/^[a-f0-9]{24}$/u.test(value.vmid)
    || (value.approvalJobId !== null && !id(value.approvalJobId))
    || previous && (value.runId !== previous.runId || value.vmid !== previous.vmid
      || previous.approvalJobId && value.approvalJobId !== previous.approvalJobId))
    throw failure("VM_PMO_BINDING_INVALID");
  return { taskId, runId: value.runId, vmid: value.vmid, approvalJobId: value.approvalJobId };
}

function preparedValue(value) {
  if (!object(value) || !HASH.test(value.inputSha256) || !object(value.runnerOptions)
    || ![value.contextPath, value.runnerOptions.contextPath, value.runnerOptions.pythonPath,
      value.runnerOptions.packageRoot].every((file) => typeof file === "string" && path.isAbsolute(file) && !file.includes("\0"))
    || value.contextPath !== value.runnerOptions.contextPath
    || typeof value.outputFilename !== "string" || value.outputFilename !== path.basename(value.outputFilename)
    || !/^[^\u0000-\u001f<>:"/\\|?*]+\.mp4$/iu.test(value.outputFilename)
    || Object.keys(value.runnerOptions).some((key) => !["contextPath", "pythonPath", "packageRoot", "ffprobePath", "ffmpegPath", "timeoutMs"].includes(key)))
    throw failure("VM_PMO_PREPARATION_INVALID");
  return { contextPath: value.contextPath, inputSha256: value.inputSha256,
    outputFilename: value.outputFilename, runnerOptions: structuredClone(value.runnerOptions) };
}

function checkedResult(result, mode, previousPlanSha256) {
  if (!object(result)) throw failure("VM_PMO_RUN_RESULT_INVALID");
  if (["blocked", "failed"].includes(result.status)) return { status: result.status, errorCode: safeCode({ code: result.errorCode }, "VM_PMO_PACKAGE_BLOCKED") };
  if (!HASH.test(result.planSha256) || previousPlanSha256 && result.planSha256 !== previousPlanSha256)
    throw failure("VM_PMO_RUN_RESULT_INVALID");
  if (mode === "plan") {
    if (result.status !== "ready") throw failure("VM_PMO_RUN_RESULT_INVALID");
    return { status: "ready", planSha256: result.planSha256 };
  }
  const artifact = result.artifact;
  if (result.status !== "rendered" || artifact?.kind !== "review_mp4"
    || typeof artifact.path !== "string" || !path.isAbsolute(artifact.path) || !HASH.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1
    || !Number.isSafeInteger(artifact.duration_ms) || artifact.duration_ms < 1
    || artifact.width !== 1920 || artifact.height !== 1080 || artifact.fps !== 25
    || artifact.has_audio !== true || artifact.full_decode_passed !== true)
    throw failure("VM_PMO_RUN_RESULT_INVALID");
  return { status: "rendered", planSha256: result.planSha256, artifact: structuredClone(artifact) };
}

/** Durable orchestration only. Network, immutable file preparation, scheduler and runner adapters
 * are injected. Every adapter is server-owned; this service never interprets a task description.
 * prepareInput/registerArtifact and both notification hooks must be idempotent by runId.
 * recoverOffline must validate an existing receipt or return null, and must never launch a process. */
export function createVmPmoOrchestrator({ database, bindings, canExecute, acquireSlot, prepareInput,
  runOffline, recoverOffline, registerArtifact, delivery, verifyRetryInput, onRunStarted = async () => {},
  onCompleted = async () => {}, now = Date.now, tickMs = 5_000 } = {}) {
  const db = database?.database;
  if (!db || [database?.getTask, database?.getFeishuTaskOrigin, database?.getFeishuTaskPackageSnapshot,
    bindings?.reserve, bindings?.reconcile, bindings?.status, canExecute, acquireSlot, prepareInput,
    runOffline, recoverOffline, registerArtifact, delivery?.enqueue, delivery?.get, verifyRetryInput, onRunStarted,
    onCompleted, now].some((callback) => typeof callback !== "function")
    || !Number.isSafeInteger(tickMs) || tickMs < 100)
    throw failure("VM_PMO_SERVICE_INVALID");
  db.exec(`CREATE TABLE IF NOT EXISTS vm_pmo_runs (
    run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, identity_json TEXT NOT NULL,
    identity_sha256 TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL,
    lease_token TEXT, lease_until INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  const active = new Map();
  let closed = false;
  let timer;
  let draining;

  function fromRow(row) {
    if (!row) return null;
    let identity, payload;
    try { identity = JSON.parse(row.identity_json); payload = JSON.parse(row.payload_json); }
    catch { throw failure("VM_PMO_STATE_INVALID"); }
    if (!id(row.run_id) || !id(row.task_id) || !object(identity) || !object(payload)
      || Object.keys(payload).some((key) => !PAYLOAD_KEYS.has(key))
      || identity.taskId !== row.task_id || !id(identity.outputAttachmentFieldId)
      || row.identity_sha256 !== hash(row.identity_json)
      || !STATES.has(row.state) || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0)
      throw failure("VM_PMO_STATE_INVALID");
    try {
      checkedBinding(payload.binding, row.task_id);
      if (payload.binding.runId !== row.run_id || !APPROVAL_STATES.has(payload.approvalStatus)
        || ["planStartedAt", "runnerStartedAt", "completedAt"].some((key) => payload[key] !== undefined && !timestamp(payload[key]))
        || payload.prepared !== undefined && !preparedValue(payload.prepared)
        || payload.planSha256 !== undefined && !HASH.test(payload.planSha256)
        || payload.artifactId !== undefined && !id(payload.artifactId)
        || payload.deliveredFileToken !== undefined && !id(payload.deliveredFileToken)
        || payload.processingNotified !== undefined && typeof payload.processingNotified !== "boolean")
        throw failure("VM_PMO_STATE_INVALID");
      if (payload.renderResult !== undefined
        && checkedResult(payload.renderResult, "render", payload.planSha256).status !== "rendered")
        throw failure("VM_PMO_STATE_INVALID");
      if (payload.planAttempt !== undefined && (!Number.isSafeInteger(payload.planAttempt)
        || payload.planAttempt < 1 || payload.planAttempt > MAX_PLAN_ATTEMPTS)
        || payload.retryHistory !== undefined && (!Array.isArray(payload.retryHistory)
          || payload.retryHistory.length > MAX_PLAN_ATTEMPTS - 1
          || payload.retryHistory.some((entry) => !object(entry) || !Number.isSafeInteger(entry.planAttempt)
            || entry.planAttempt < 1 || entry.planAttempt >= MAX_PLAN_ATTEMPTS
            || entry.errorCode !== "WORD_ALIGNMENT_UNRESOLVED" || !timestamp(entry.failedAt)
            || !HASH.test(entry.inputSha256))))
        throw failure("VM_PMO_STATE_INVALID");
    } catch { throw failure("VM_PMO_STATE_INVALID"); }
    return { runId: row.run_id, taskId: row.task_id, state: row.state, identity,
      ...payload, attemptCount: row.attempt_count, nextAttemptAt: row.next_attempt_at,
      errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at,
      leaseToken: row.lease_token, leaseUntil: row.lease_until };
  }
  function get(runId) {
    if (!id(runId)) throw failure("VM_PMO_INPUT_INVALID");
    return fromRow(db.prepare("SELECT * FROM vm_pmo_runs WHERE run_id = ?").get(runId));
  }
  function getForTask(taskId) {
    if (!id(taskId)) throw failure("VM_PMO_INPUT_INVALID");
    return fromRow(db.prepare("SELECT * FROM vm_pmo_runs WHERE task_id = ?").get(taskId));
  }
  function list() { return db.prepare("SELECT * FROM vm_pmo_runs ORDER BY created_at, run_id").all().map(fromRow); }
  function assertCurrent(run) {
    const current = frozenIdentity(database, run.taskId, Boolean(run.runnerStartedAt));
    // Pre-review initial runs froze the same identity without a stageSnapshot.
    // Preserve their evidence and all original checks; new/review runs stay strict.
    if (run.identity.origin?.stageId === "initial" && !Object.hasOwn(run.identity, "stageSnapshot")) {
      const { stageSnapshot, ...legacyCurrent } = current;
      if (json(legacyCurrent) === json(run.identity)) return;
    }
    if (json(current) !== json(run.identity)) throw failure("VM_PMO_TASK_IDENTITY_CHANGED");
  }
  function update(runId, owner, state, patch = {}, errorCode = null, attempts, next = now()) {
    const row = db.prepare("SELECT * FROM vm_pmo_runs WHERE run_id = ?").get(runId);
    if (!row || row.lease_token !== owner || row.lease_until <= now()) throw failure("VM_PMO_LEASE_LOST");
    const payload = { ...JSON.parse(row.payload_json), ...patch };
    const changed = db.prepare(`UPDATE vm_pmo_runs SET state = ?, payload_json = ?, error_code = ?,
      attempt_count = ?, next_attempt_at = ?, updated_at = ? WHERE run_id = ? AND lease_token = ? AND lease_until > ?`)
      .run(state, json(payload), errorCode, attempts ?? row.attempt_count, next, now(), runId, owner, now());
    if (changed.changes !== 1) throw failure("VM_PMO_LEASE_LOST");
    return get(runId);
  }
  async function register({ taskId } = {}) {
    if (closed || !id(taskId)) throw failure("VM_PMO_INPUT_INVALID");
    const existing = fromRow(db.prepare("SELECT * FROM vm_pmo_runs WHERE task_id = ?").get(taskId));
    if (existing) { assertCurrent(existing); return existing; }
    const identity = frozenIdentity(database, taskId);
    const reviewParent = identity.origin.stageId === "review" ? identity.stageSnapshot.reviewParent : null;
    const binding = checkedBinding(reviewParent ? { taskId, runId: randomUUID(),
      vmid: identity.stageSnapshot.vmContext?.vmid, approvalJobId: null }
      : await bindings.reserve(taskId), taskId);
    if (json(frozenIdentity(database, taskId)) !== json(identity)) throw failure("VM_PMO_TASK_IDENTITY_CHANGED");
    const value = json(identity);
    const payload = reviewParent ? { binding, approvalStatus: "ready", acquisition: {
      path: reviewParent.localPath, sha256: reviewParent.sha256, bytes: reviewParent.bytes,
      duration_ms: reviewParent.durationMs, vmid_binding: "managed_review_parent",
      vmid: identity.stageSnapshot.vmContext.vmid,
    }, planAttempt: 1, retryHistory: [] } : { binding, approvalStatus: "reserved", planAttempt: 1, retryHistory: [] };
    db.prepare(`INSERT INTO vm_pmo_runs (run_id, task_id, identity_json, identity_sha256,
      state, payload_json, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(binding.runId, taskId, value, hash(value), reviewParent ? "ready" : "waiting_materials",
        json(payload), now(), now(), now());
    const saved = get(binding.runId);
    if (!saved || json(saved.identity) !== value || saved.taskId !== taskId)
      throw failure("VM_PMO_TASK_IDENTITY_CHANGED");
    return saved;
  }
  async function recoverBindingConflict(runId) {
    let run = get(runId);
    if (!run || run.state !== "needs_attention" || run.errorCode !== "VM_TASK_BINDING_CONFLICT"
      || run.runnerStartedAt || run.planStartedAt || run.prepared || run.planSha256 || run.renderResult
      || run.artifactId || run.deliveredFileToken) return run;
    assertCurrent(run);
    const status = await bindings.status(run.taskId);
    checkedBinding(status, run.taskId, run.binding);
    if (status.status !== "ready" || status.acquisition?.vmid_binding !== "vm_api_verified") return get(runId);
    assertCurrent(run);

    const row = db.prepare("SELECT * FROM vm_pmo_runs WHERE run_id = ?").get(runId);
    if (!row) throw failure("VM_PMO_RUN_NOT_FOUND");
    let payload;
    try { payload = JSON.parse(row.payload_json); } catch { throw failure("VM_PMO_STATE_INVALID"); }
    if (payload.runnerStartedAt || payload.planStartedAt || payload.prepared || payload.planSha256
      || payload.renderResult || payload.artifactId || payload.deliveredFileToken) return get(runId);
    const nextPayload = json({ ...payload, binding: run.binding, approvalStatus: "ready",
      acquisition: structuredClone(status.acquisition) });
    db.exec("BEGIN IMMEDIATE");
    try {
      const changed = db.prepare(`UPDATE vm_pmo_runs SET state = 'ready',payload_json = ?,error_code = NULL,
        attempt_count = 0,next_attempt_at = ?,updated_at = ? WHERE run_id = ? AND state = 'needs_attention'
        AND error_code = 'VM_TASK_BINDING_CONFLICT' AND identity_sha256 = ? AND payload_json = ?
        AND lease_token IS NULL`).run(nextPayload, now(), now(), runId, row.identity_sha256, row.payload_json);
      db.exec("COMMIT");
      if (changed.changes !== 1) return get(runId);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return pump(runId);
  }
  async function recoverBindingConflicts() {
    const results = [];
    for (const run of list()) {
      if (run.state !== "needs_attention" || run.errorCode !== "VM_TASK_BINDING_CONFLICT"
        || run.runnerStartedAt || run.planStartedAt || run.prepared || run.planSha256 || run.renderResult
        || run.artifactId || run.deliveredFileToken) continue;
      try {
        const recovered = await recoverBindingConflict(run.runId);
        results.push({ runId: run.runId, state: recovered?.state ?? "missing" });
      } catch (error) {
        results.push({ runId: run.runId, state: "needs_attention", errorCode: safeCode(error) });
      }
    }
    return results;
  }
  async function retryPlan(runId, {beforeCommit = () => {}} = {}) {
    const row = db.prepare("SELECT * FROM vm_pmo_runs WHERE run_id = ?").get(runId);
    const run = fromRow(row);
    if (!run || run.state !== "blocked" || run.errorCode !== "WORD_ALIGNMENT_UNRESOLVED"
      || !run.planStartedAt || !run.prepared || !run.acquisition || run.runnerStartedAt
      || run.planSha256 || run.renderResult || run.artifactId || run.deliveredFileToken || run.completedAt)
      throw failure("VM_PMO_RETRY_NOT_ALLOWED");
    const planAttempt = run.planAttempt ?? 1;
    if (planAttempt >= MAX_PLAN_ATTEMPTS) throw failure("VM_PMO_RETRY_LIMIT");
    assertCurrent(run);
    await verifyRetryInput({ run });
    assertCurrent(run);

    const history = [...(run.retryHistory ?? []), { planAttempt, errorCode: run.errorCode,
      failedAt: new Date(now()).toISOString(), inputSha256: run.prepared.inputSha256 }];
    const nextValue = Object.fromEntries(Object.entries(run).filter(([key]) => PAYLOAD_KEYS.has(key)));
    delete nextValue.prepared;
    delete nextValue.planStartedAt;
    nextValue.planAttempt = planAttempt + 1;
    nextValue.retryHistory = history;
    const nextPayload = json(nextValue);
    db.exec("BEGIN IMMEDIATE");
    try {
      beforeCommit();
      const changed = db.prepare(`UPDATE vm_pmo_runs SET state = 'ready',payload_json = ?,error_code = NULL,
        attempt_count = 0,next_attempt_at = ?,updated_at = ? WHERE run_id = ? AND task_id = ?
        AND state = 'blocked' AND error_code = 'WORD_ALIGNMENT_UNRESOLVED' AND payload_json = ? AND lease_token IS NULL`)
        .run(nextPayload, now(), now(), runId, run.taskId, row.payload_json);
      if (changed.changes !== 1) throw failure("VM_PMO_RETRY_NOT_ALLOWED");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return get(runId);
  }
  function claim(runId) {
    const owner = randomUUID();
    const changed = db.prepare(`UPDATE vm_pmo_runs SET lease_token = ?, lease_until = ?
      WHERE run_id = ? AND state NOT IN ('completed', 'blocked', 'needs_attention')
        AND next_attempt_at <= ? AND (lease_token IS NULL OR lease_until <= ?)`)
      .run(owner, now() + LEASE_MS, runId, now(), now());
    return changed.changes === 1 ? owner : null;
  }
  async function notifyStarted(run, owner) {
    if (run.runnerStartedAt && !run.processingNotified) {
      await onRunStarted({ run });
      return update(run.runId, owner, run.state, { processingNotified: true });
    }
    return run;
  }
  async function offline(run, owner, mode, signal, recovering) {
    const key = mode === "plan" ? "planStartedAt" : "runnerStartedAt";
    let started = recovering ? Boolean(run[key]) : false;
    const options = { ...run.prepared.runnerOptions, taskId:run.taskId,runId:run.runId,
      planAttempt:run.planAttempt ?? 1,inputSha256:run.prepared.inputSha256,mode,signal };
    const result = recovering ? await recoverOffline(options)
      : await runOffline({ ...options, onStarted: async (evidence) => {
        if (started || evidence?.mode !== mode || !Number.isSafeInteger(evidence.pid) || evidence.pid < 1
          || !timestamp(evidence.startedAt)) throw failure("VM_PMO_START_NOT_CONFIRMED");
        started = true;
        run = update(run.runId, owner, run.state, { [key]: evidence.startedAt });
        if (mode === "render") run = await notifyStarted(run, owner);
      } });
    if (!result && recovering) throw failure("VM_PMO_RUN_OUTCOME_UNKNOWN");
    if (!started) throw failure("VM_PMO_START_NOT_CONFIRMED");
    const checked = checkedResult(result, mode, mode === "render" ? run.planSha256 : null);
    if (["blocked", "failed"].includes(checked.status)) return update(run.runId, owner, "blocked", {}, checked.errorCode);
    return mode === "plan" ? update(run.runId, owner, "planned", { planSha256: checked.planSha256 })
      : update(run.runId, owner, "rendered", { renderResult: checked });
  }
  async function processRun(runId, owner, signal) {
    let run = get(runId);
    assertCurrent(run);
    if (run.state === "waiting_materials") {
      if (!await canExecute({ run })) return run;
      assertCurrent(run);
      const binding = checkedBinding(await bindings.reconcile(run.taskId), run.taskId, run.binding);
      const status = await bindings.status(run.taskId);
      checkedBinding(status, run.taskId, binding);
      if (!APPROVAL_STATES.has(status.status)) throw failure("VM_PMO_APPROVAL_STATE_INVALID");
      assertCurrent(run);
      run = update(runId, owner, "waiting_materials", { binding, approvalStatus: status.status });
      if (["rejected", "canceled"].includes(status.status))
        return update(runId, owner, "blocked", {}, `VM_PMO_APPROVAL_${status.status.toUpperCase()}`);
      if (status.status !== "ready") return run;
      const acquired = status.acquisition;
      if (!object(acquired) || acquired.vmid_binding !== "vm_api_verified"
        || !HASH.test(acquired.sha256) || !Number.isSafeInteger(acquired.bytes) || acquired.bytes < 1
        || !Number.isSafeInteger(acquired.duration_ms) || acquired.duration_ms < 1
        || ![acquired.path, acquired.receipt_path].every((file) => typeof file === "string" && path.isAbsolute(file)))
        throw failure("VM_PMO_ACQUISITION_INVALID");
      run = update(runId, owner, "ready", { acquisition: structuredClone(acquired) });
    }
    if (run.identity.origin.stageId === "review") {
      const parent = run.identity.stageSnapshot.reviewParent;
      const acquired = run.acquisition;
      if (!object(acquired) || acquired.vmid_binding !== "managed_review_parent"
        || acquired.path !== parent.localPath || acquired.sha256 !== parent.sha256
        || acquired.bytes !== parent.bytes || acquired.duration_ms !== parent.durationMs
        || acquired.vmid !== run.identity.stageSnapshot.vmContext?.vmid)
        throw failure("VM_PMO_REVIEW_PARENT_INVALID");
    }
    if (["ready", "preparing", "prepared", "planned"].includes(run.state)) {
      if (!await canExecute({ run })) return run;
      assertCurrent(run);
    }
    if (["ready", "preparing"].includes(run.state)) {
      run = update(runId, owner, "preparing");
      const prepared = preparedValue(await prepareInput({ run, acquisition: run.acquisition,
        planAttempt: run.planAttempt ?? 1 }));
      assertCurrent(run);
      run = update(runId, owner, "prepared", { prepared });
    }
    if (["planning", "rendering"].includes(run.state))
      run = await offline(run, owner, run.state === "planning" ? "plan" : "render", signal, true);
    if (["prepared", "planned"].includes(run.state)) {
      if (!await canExecute({ run })) return run;
      const slot = await acquireSlot({ run });
      if (slot === null) return run;
      if (!slot || typeof slot.release !== "function") throw failure("VM_PMO_SLOT_INVALID");
      try {
        if (!await canExecute({ run })) return run;
        assertCurrent(run);
        if (run.state === "prepared") {
          run = update(runId, owner, "planning");
          run = await offline(run, owner, "plan", signal, false);
        }
        if (run.state === "planned") {
          assertCurrent(run);
          if (!await canExecute({ run })) return run;
          run = update(runId, owner, "rendering");
          run = await offline(run, owner, "render", signal, false);
        }
      } finally { await slot.release(); }
    }
    if (TERMINAL.has(run.state)) return run;
    if (run.state === "rendered") {
      run = await notifyStarted(run, owner);
      const registered = await registerArtifact({ run, prepared: run.prepared, result: run.renderResult });
      if (!id(registered?.artifactId)) throw failure("VM_PMO_ARTIFACT_INVALID");
      run = update(runId, owner, "delivery_pending", { artifactId: registered.artifactId });
    }
    if (run.state === "delivery_pending") {
      let job = await delivery.get(runId);
      if (!job) job = await delivery.enqueue({ runId, artifactId: run.artifactId });
      if (job?.runId !== runId || job.taskId !== run.taskId || job.artifactId !== run.artifactId
        || ["baseToken", "tableId", "recordId"].some((key) => job.target?.[key] !== run.identity.origin[key])
        || job.target?.fieldId !== run.identity.outputAttachmentFieldId)
        throw failure("VM_PMO_DELIVERY_IDENTITY_INVALID");
      if (["conflict", "upload_uncertain", "dead_letter"].includes(job.state))
        return update(runId, owner, "needs_attention", {}, safeCode({ code: job.errorCode }, "VM_PMO_DELIVERY_FAILED"));
      if (job.state !== "delivered") return run;
      if (!id(job.fileToken)) throw failure("VM_PMO_DELIVERY_IDENTITY_INVALID");
      run = update(runId, owner, "delivery_confirmed", { deliveredFileToken: job.fileToken });
    }
    if (run.state === "delivery_confirmed") {
      const job = await delivery.get(runId);
      if (job?.state !== "delivered" || job.fileToken !== run.deliveredFileToken
        || job.runId !== runId || job.taskId !== run.taskId || job.artifactId !== run.artifactId
        || ["baseToken", "tableId", "recordId"].some((key) => job.target?.[key] !== run.identity.origin[key])
        || job.target?.fieldId !== run.identity.outputAttachmentFieldId)
        throw failure("VM_PMO_DELIVERY_IDENTITY_INVALID");
      await onCompleted({ run, delivery: job });
      run = update(runId, owner, "completed", { completedAt: new Date(now()).toISOString() });
    }
    return run;
  }
  async function execute(runId) {
    const owner = claim(runId);
    if (!owner) return get(runId);
    const controller = new AbortController();
    const lease = setInterval(() => {
      try {
        const renewed = db.prepare(`UPDATE vm_pmo_runs SET lease_until = ? WHERE run_id = ?
          AND lease_token = ? AND lease_until > ?`).run(now() + LEASE_MS, runId, owner, now());
        if (renewed.changes !== 1) controller.abort();
      } catch { controller.abort(); }
    }, LEASE_MS / 3);
    lease.unref?.();
    try { return await processRun(runId, owner, controller.signal); }
    catch (error) {
      const code = safeCode(error);
      const current = get(runId);
      if (code === "VM_PMO_LEASE_LOST" || current?.leaseToken !== owner || current?.leaseUntil <= now()) return current;
      const uncertain = ["planning", "rendering"].includes(current.state);
      const invalid = /(?:INVALID|CHANGED|NOT_ELIGIBLE|START_NOT_CONFIRMED|UNKNOWN)$/u.test(code)
        || ["AUTOMATIC_EXECUTION_DISABLED", "VM_PMO_POLICY_CHANGED"].includes(code);
      const attempts = current.attemptCount + 1;
      return update(runId, owner, uncertain ? "needs_attention" : invalid ? "blocked"
        : attempts >= MAX_ATTEMPTS ? "needs_attention" : current.state, {}, code, attempts,
      now() + Math.min(5_000 * 2 ** (attempts - 1), 300_000));
    } finally {
      clearInterval(lease);
      db.prepare("UPDATE vm_pmo_runs SET lease_token = NULL, lease_until = NULL WHERE run_id = ? AND lease_token = ?")
        .run(runId, owner);
    }
  }
  function pump(runId) {
    if (closed || !id(runId)) return Promise.reject(failure("VM_PMO_INPUT_INVALID"));
    if (!get(runId)) return Promise.reject(failure("VM_PMO_RUN_NOT_FOUND"));
    if (active.has(runId)) return active.get(runId);
    const running = execute(runId).finally(() => active.delete(runId));
    active.set(runId, running);
    return running;
  }
  function wake() {
    if (closed) return Promise.resolve();
    draining ??= (async () => {
      for (const run of list()) {
        if (closed) break;
        if (!TERMINAL.has(run.state) && run.nextAttemptAt <= now()) await pump(run.runId);
      }
    })().finally(() => { draining = null; });
    return draining;
  }
  return Object.freeze({ register, get, getForTask, list, pump, wake, retryPlan, recoverBindingConflicts,
    start() { if (closed || timer) return; timer = setInterval(() => { void wake().catch(() => {}); }, tickMs);
      timer.unref?.(); void wake().catch(() => {}); },
    async close() { closed = true; clearInterval(timer); await Promise.allSettled([...active.values(), draining]); },
  });
}
