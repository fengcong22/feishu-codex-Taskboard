import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isSameFilesystemPath } from "./filesystem-path-boundary.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACTIVE = new Set(["uploading", "binding"]);
const LEASE_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validId(value) { return typeof value === "string" && IDENTIFIER.test(value); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function assertId(value) { if (!validId(value)) throw failure("VM_DELIVERY_INPUT_INVALID"); }

function connectionFrom(database) {
  const db = database?.database ?? database;
  if (typeof db?.prepare !== "function" || typeof db?.exec !== "function")
    throw failure("VM_DELIVERY_STORE_INVALID");
  return db;
}

function rowValue(row) {
  if (!row) return null;
  return {
    id: row.id, runId: row.run_id, taskId: row.task_id, artifactId: row.artifact_id,
    target: { baseToken: row.base_token, tableId: row.table_id,
      recordId: row.record_id, fieldId: row.field_id },
    artifact: { path: row.source_path, filename: row.filename, sha256: row.sha256,
      bytes: row.bytes, durationMs: row.duration_ms },
    fileToken: row.file_token, state: row.state, attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at, errorCode: row.error_code,
    leaseToken: row.lease_token, leaseUntil: row.lease_until,
  };
}

async function verifiedFile(file, expectedSha, expectedBytes) {
  try {
    if (typeof file !== "string" || !path.isAbsolute(file) || path.normalize(file) !== file
      || !isSameFilesystemPath(await realpath(file), file)) throw new Error("noncanonical path");
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size !== BigInt(expectedBytes)) throw new Error("not a stable file");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
    const after = await lstat(file, { bigint: true });
    if (size !== expectedBytes || hash.digest("hex") !== expectedSha
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n)
      throw new Error("file changed");
  } catch { throw failure("VM_DELIVERY_ARTIFACT_CHANGED"); }
}

function trustedDelivery(value, runId, artifactId) {
  if (!object(value) || value.productionOrigin !== true || value.runId !== runId
    || value.artifactId !== artifactId || !validId(value.taskId)
    || !object(value.artifact) || value.artifact.kind !== "review_mp4"
    || value.artifact.validationStatus !== "verified" || !object(value.target))
    throw failure("VM_DELIVERY_UNTRUSTED");
  const target = value.target;
  if (![target.baseToken, target.tableId, target.recordId, target.fieldId].every(validId)
    || typeof value.artifact.path !== "string" || !path.isAbsolute(value.artifact.path)
    || typeof value.artifact.filename !== "string" || value.artifact.filename.length > 180
    || value.artifact.filename !== path.basename(value.artifact.filename)
    || !/^[^\u0000-\u001f<>:"/\\|?*]+\.mp4$/iu.test(value.artifact.filename)
    || !SHA256.test(value.artifact.sha256)
    || !Number.isSafeInteger(value.artifact.bytes) || value.artifact.bytes < 1
    || !Number.isSafeInteger(value.artifact.duration_ms) || value.artifact.duration_ms < 1)
    throw failure("VM_DELIVERY_UNTRUSTED");
  return value;
}

function attachmentField(fields, fieldId) {
  if (!Array.isArray(fields)) throw failure("VM_DELIVERY_REMOTE_INVALID");
  const matches = fields.filter((entry) => (entry?.field_id ?? entry?.fieldId) === fieldId);
  if (matches.length !== 1) throw failure("VM_DELIVERY_FIELD_CHANGED");
  const field = matches[0];
  const name = field.field_name ?? field.fieldName;
  const uiType = field.ui_type ?? field.uiType;
  if (field.type !== 17 || (uiType !== undefined && uiType !== null
    && !["Attachment", "Attachments"].includes(uiType))
    || typeof name !== "string" || !name.trim()) throw failure("VM_DELIVERY_FIELD_CHANGED");
  return { id: fieldId, name };
}

function attachmentTokens(record, field) {
  if (!object(record?.fields)) throw failure("VM_DELIVERY_REMOTE_INVALID");
  const byId = record.fields[field.id];
  const byName = record.fields[field.name];
  if (byId !== undefined && byName !== undefined && JSON.stringify(byId) !== JSON.stringify(byName))
    throw failure("VM_DELIVERY_FIELD_CONFLICT");
  const value = byId ?? byName;
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw failure("VM_DELIVERY_FIELD_CONFLICT");
  const tokens = value.map((entry) => entry?.file_token ?? entry?.fileToken);
  if (tokens.some((token) => !validId(token)) || new Set(tokens).size !== tokens.length)
    throw failure("VM_DELIVERY_FIELD_CONFLICT");
  return tokens;
}

function immutableMatches(existing, trusted) {
  return existing.taskId === trusted.taskId
    && existing.artifactId === trusted.artifactId
    && Object.entries(existing.target).every(([key, value]) => value === trusted.target[key])
    && existing.artifact.path === trusted.artifact.path
    && existing.artifact.filename === trusted.artifact.filename
    && existing.artifact.sha256 === trusted.artifact.sha256
    && existing.artifact.bytes === trusted.artifact.bytes
    && (existing.artifact.durationMs === 0 || existing.artifact.durationMs === trusted.artifact.duration_ms);
}

/**
 * Durable local MP4 delivery. The resolver must derive a verified artifact and
 * production Feishu origin from server-owned run/task state; callers provide
 * only run and artifact IDs. The adapter performs Feishu media and Base calls.
 */
export function createVmMp4DeliveryService({ database, resolveTrustedDelivery, resolveTrustedLineage = null, adapter,
  now = Date.now, idFactory = randomUUID } = {}) {
  const db = connectionFrom(database);
  if (typeof resolveTrustedDelivery !== "function" || resolveTrustedLineage !== null && typeof resolveTrustedLineage !== "function" || !adapter
    || ["listFields", "getRecord", "updateRecord", "uploadMedia"].some((name) => typeof adapter[name] !== "function"))
    throw failure("VM_DELIVERY_SERVICE_INVALID");
  db.exec(`CREATE TABLE IF NOT EXISTS vm_mp4_deliveries (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
    base_token TEXT NOT NULL, table_id TEXT NOT NULL, record_id TEXT NOT NULL, field_id TEXT NOT NULL,
    source_path TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    file_token TEXT, state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, error_code TEXT, lease_token TEXT, lease_until INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  if (!db.prepare("PRAGMA table_info(vm_mp4_deliveries)").all().some((column) => column.name === "duration_ms"))
    db.exec("ALTER TABLE vm_mp4_deliveries ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE INDEX IF NOT EXISTS vm_mp4_deliveries_ready
    ON vm_mp4_deliveries(state, next_attempt_at, created_at)`);

  const get = (runId) => {
    assertId(runId);
    return rowValue(db.prepare("SELECT * FROM vm_mp4_deliveries WHERE run_id = ?").get(runId));
  };

  async function latestDelivered({ baseToken, tableId, recordId, fieldId, subjectKey, packageAlias, workflowTemplate } = {}) {
    if (![baseToken, tableId, recordId, fieldId].every(validId))
      throw failure("VM_DELIVERY_INPUT_INVALID");
    const scoped = subjectKey !== undefined || packageAlias !== undefined || workflowTemplate !== undefined;
    if (scoped && (subjectKey !== `${baseToken}:${tableId}` || typeof packageAlias !== "string" || !packageAlias
      || !object(workflowTemplate) || typeof workflowTemplate.id !== "string"
      || !Number.isSafeInteger(workflowTemplate.version))) throw failure("VM_DELIVERY_INPUT_INVALID");
    const rows = db.prepare(`SELECT * FROM vm_mp4_deliveries
      WHERE base_token = ? AND table_id = ? AND record_id = ? AND field_id = ? AND state = 'delivered'
      ORDER BY updated_at DESC, created_at DESC, rowid DESC`)
      .all(baseToken, tableId, recordId, fieldId);
    function matchesLineage(lineage) {
      if (!object(lineage) || typeof lineage.packageAlias !== "string" || !object(lineage.workflowTemplate))
        throw failure("VM_DELIVERY_UNTRUSTED");
      return lineage.subjectKey === subjectKey && lineage.packageAlias === packageAlias
        && lineage.workflowTemplate.id === workflowTemplate.id && lineage.workflowTemplate.version === workflowTemplate.version;
    }
    for (const row of rows) {
      const job = rowValue(row);
      // Local trusted origin snapshots can exclude another package before touching its retired files.
      if (scoped && resolveTrustedLineage && !matchesLineage(await resolveTrustedLineage({taskId:job.taskId,runId:job.runId}))) continue;
      if (job.state !== "delivered" || !validId(job.fileToken)) throw failure("VM_DELIVERY_PARENT_UNCONFIRMED");
      let trusted;
      try { trusted = trustedDelivery(await resolveTrustedDelivery({ runId: job.runId,
        artifactId: job.artifactId }), job.runId, job.artifactId); }
      catch { throw failure("VM_DELIVERY_UNTRUSTED"); }
      if (!immutableMatches(job, trusted)) throw failure("VM_DELIVERY_IDENTITY_CONFLICT");
      if (scoped && !matchesLineage(trusted.lineage)) continue;
      await verifiedFile(trusted.artifact.path, trusted.artifact.sha256, trusted.artifact.bytes);
      if (job.artifact.durationMs === 0) {
        db.prepare("UPDATE vm_mp4_deliveries SET duration_ms = ? WHERE run_id = ? AND state = 'delivered' AND duration_ms = 0")
          .run(trusted.artifact.duration_ms, job.runId);
        return get(job.runId);
      }
      return job;
    }
    return null;
  }

  function change(runId, state, patch = {}, owner = null) {
    const current = get(runId);
    if (!current) throw failure("VM_DELIVERY_STATE_INVALID");
    const next = { fileToken: patch.fileToken ?? current.fileToken,
      attemptCount: patch.attemptCount ?? current.attemptCount,
      nextAttemptAt: patch.nextAttemptAt ?? now(), errorCode: patch.errorCode ?? null,
      leaseToken: patch.leaseToken ?? null, leaseUntil: patch.leaseUntil ?? null };
    const result = db.prepare(`UPDATE vm_mp4_deliveries SET state = ?, file_token = ?, attempt_count = ?,
      next_attempt_at = ?, error_code = ?, lease_token = ?, lease_until = ?, updated_at = ?
      WHERE run_id = ? AND (? IS NULL OR (lease_token = ? AND state IN ('uploading', 'binding') AND lease_until > ?))`)
      .run(state, next.fileToken, next.attemptCount, next.nextAttemptAt,
        next.errorCode, next.leaseToken, next.leaseUntil, now(), runId, owner, owner, now());
    if (result.changes !== 1) return get(runId);
    return get(runId);
  }

  function recover() {
    const timestamp = now();
    db.prepare(`UPDATE vm_mp4_deliveries SET state = 'upload_uncertain', lease_token = NULL,
      lease_until = NULL, error_code = 'VM_DELIVERY_UPLOAD_UNCERTAIN', updated_at = ?
      WHERE state = 'uploading' AND (lease_until IS NULL OR lease_until <= ?)`)
      .run(timestamp, timestamp);
    db.prepare(`UPDATE vm_mp4_deliveries SET state = 'binding_pending', lease_token = NULL,
      lease_until = NULL, next_attempt_at = ?, updated_at = ?
      WHERE state = 'binding' AND (lease_until IS NULL OR lease_until <= ?)`)
      .run(timestamp, timestamp, timestamp);
  }
  recover();

  async function enqueue({ runId, artifactId } = {}) {
    assertId(runId); assertId(artifactId);
    const trusted = trustedDelivery(await resolveTrustedDelivery({ runId, artifactId }), runId, artifactId);
    const artifact = trusted.artifact;
    await verifiedFile(artifact.path, artifact.sha256, artifact.bytes);
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = get(runId);
      if (existing) {
        if (!immutableMatches(existing, trusted)) throw failure("VM_DELIVERY_IDENTITY_CONFLICT");
        db.exec("COMMIT"); return existing;
      }
      const timestamp = now();
      db.prepare(`INSERT INTO vm_mp4_deliveries (id, run_id, task_id, artifact_id,
        base_token, table_id, record_id, field_id, source_path, filename, sha256, bytes, duration_ms,
        state, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upload_pending', ?, ?, ?)`)
        .run(idFactory(), runId, trusted.taskId, artifactId, trusted.target.baseToken,
          trusted.target.tableId, trusted.target.recordId, trusted.target.fieldId,
          artifact.path, artifact.filename, artifact.sha256, artifact.bytes, artifact.duration_ms,
          timestamp, timestamp, timestamp);
      db.exec("COMMIT"); return get(runId);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  function claim() {
    recover();
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`SELECT d.* FROM vm_mp4_deliveries AS d
        WHERE d.state IN ('upload_pending', 'binding_pending') AND d.next_attempt_at <= ?
          AND NOT EXISTS (SELECT 1 FROM vm_mp4_deliveries AS active
            WHERE active.id <> d.id AND active.base_token = d.base_token
              AND active.table_id = d.table_id AND active.record_id = d.record_id
              AND active.field_id = d.field_id AND active.state IN ('uploading', 'binding')
              AND active.lease_until > ?)
        ORDER BY d.created_at, d.id LIMIT 1`).get(timestamp, timestamp);
      if (!row) { db.exec("COMMIT"); return null; }
      const leaseToken = randomUUID();
      const state = row.state === "upload_pending" ? "uploading" : "binding";
      db.prepare(`UPDATE vm_mp4_deliveries SET state = ?, lease_token = ?, lease_until = ?,
        updated_at = ? WHERE id = ?`).run(state, leaseToken, timestamp + LEASE_MS, timestamp, row.id);
      db.exec("COMMIT");
      return get(row.run_id);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  function assertLease(job) {
    const current = get(job.runId);
    if (!current || !ACTIVE.has(current.state) || current.leaseToken !== job.leaseToken
      || current.leaseUntil === null || current.leaseUntil <= now())
      throw failure("VM_DELIVERY_LEASE_STALE");
  }

  async function assertTrusted(job) {
    assertLease(job);
    let trusted;
    try {
      trusted = trustedDelivery(await resolveTrustedDelivery({ runId: job.runId,
        artifactId: job.artifactId }), job.runId, job.artifactId);
    } catch { throw failure("VM_DELIVERY_UNTRUSTED"); }
    assertLease(job);
    if (!immutableMatches(job, trusted)) throw failure("VM_DELIVERY_IDENTITY_CONFLICT");
  }

  async function readField(job) {
    const fields = await adapter.listFields({ baseToken: job.target.baseToken, tableId: job.target.tableId });
    return attachmentField(fields, job.target.fieldId);
  }

  async function bind(job) {
    await assertTrusted(job);
    const field = await readField(job);
    const record = { baseToken: job.target.baseToken, tableId: job.target.tableId,
      recordId: job.target.recordId };
    const before = attachmentTokens(await adapter.getRecord(record), field);
    await assertTrusted(job);
    if (before.includes(job.fileToken)) return change(job.runId, "delivered", {}, job.leaseToken);
    // The Base update API has no revision precondition. A second read catches
    // visible changes but cannot make the following update atomic.
    const justBefore = attachmentTokens(await adapter.getRecord(record), field);
    await assertTrusted(job);
    if (justBefore.includes(job.fileToken)) return change(job.runId, "delivered", {}, job.leaseToken);
    if (JSON.stringify(before) !== JSON.stringify(justBefore))
      return change(job.runId, "conflict", { errorCode: "VM_DELIVERY_FIELD_CHANGED" }, job.leaseToken);
    await adapter.updateRecord({ ...record, fieldName: field.name,
      attachments: [...justBefore.map((fileToken) => ({ file_token: fileToken })),
        { file_token: job.fileToken }] });
    const after = attachmentTokens(await adapter.getRecord(record), field);
    await assertTrusted(job);
    if (!after.includes(job.fileToken))
      return change(job.runId, "conflict", { errorCode: "VM_DELIVERY_READBACK_CONFLICT" }, job.leaseToken);
    return change(job.runId, "delivered", {}, job.leaseToken);
  }

  async function processNext() {
    const claimed = claim();
    if (!claimed) return null;
    let job = claimed;
    if (job.state === "uploading") {
      try {
        await assertTrusted(job);
        await verifiedFile(job.artifact.path, job.artifact.sha256, job.artifact.bytes);
        await readField(job);
        await assertTrusted(job);
      } catch (error) {
        if (error?.code === "VM_DELIVERY_LEASE_STALE") return get(job.runId);
        const code = ["VM_DELIVERY_ARTIFACT_CHANGED", "VM_DELIVERY_FIELD_CHANGED",
          "VM_DELIVERY_UNTRUSTED", "VM_DELIVERY_IDENTITY_CONFLICT"].includes(error?.code)
          ? error.code : "VM_DELIVERY_REMOTE_UNAVAILABLE";
        if (code !== "VM_DELIVERY_REMOTE_UNAVAILABLE")
          return change(job.runId, "conflict", { errorCode: code }, job.leaseToken);
        const attemptCount = job.attemptCount + 1;
        return change(job.runId, attemptCount >= MAX_ATTEMPTS ? "dead_letter" : "upload_pending",
          { attemptCount, errorCode: attemptCount >= MAX_ATTEMPTS
            ? "VM_DELIVERY_METADATA_RETRIES_EXHAUSTED" : code,
          nextAttemptAt: now() + Math.min(5_000 * 2 ** (attemptCount - 1), 300_000) }, job.leaseToken);
      }
      let token;
      try {
        const result = await adapter.uploadMedia({ filePath: job.artifact.path,
          filename: job.artifact.filename, sha256: job.artifact.sha256,
          bytes: job.artifact.bytes, baseToken: job.target.baseToken });
        token = result?.file_token ?? result?.fileToken;
        if (!validId(token)) throw failure("VM_DELIVERY_UPLOAD_UNCERTAIN");
      } catch {
        return change(job.runId, "upload_uncertain", { errorCode: "VM_DELIVERY_UPLOAD_UNCERTAIN" }, job.leaseToken);
      }
      job = change(job.runId, "binding", { fileToken: token,
        leaseToken: claimed.leaseToken, leaseUntil: now() + LEASE_MS }, claimed.leaseToken);
      if (job.state !== "binding") return job;
    }
    try { return await bind(job); }
    catch (error) {
      if (error?.code === "VM_DELIVERY_LEASE_STALE") return get(job.runId);
      if (["VM_DELIVERY_FIELD_CHANGED", "VM_DELIVERY_FIELD_CONFLICT",
        "VM_DELIVERY_UNTRUSTED", "VM_DELIVERY_IDENTITY_CONFLICT"].includes(error?.code))
        return change(job.runId, "conflict", { errorCode: error.code }, job.leaseToken);
      const attemptCount = job.attemptCount + 1;
      if (attemptCount >= MAX_ATTEMPTS)
        return change(job.runId, "dead_letter", { attemptCount, errorCode: "VM_DELIVERY_BIND_RETRIES_EXHAUSTED" }, job.leaseToken);
      return change(job.runId, "binding_pending", { attemptCount,
        nextAttemptAt: now() + Math.min(5_000 * 2 ** (attemptCount - 1), 300_000),
        errorCode: "VM_DELIVERY_BIND_RETRY" }, job.leaseToken);
    }
  }

  return Object.freeze({ enqueue, get, latestDelivered, processNext, recover });
}
