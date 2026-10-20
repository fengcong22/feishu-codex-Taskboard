import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "./feishu-source-manifest.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,511}$/u;
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LEASE_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const TRANSIENT_CODES = new Set(["EBUSY", "EIO", "ENETDOWN", "ENETUNREACH", "ETIMEDOUT", "EMFILE", "ENFILE"]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validId(value, pattern = LOCAL_ID) { return typeof value === "string" && pattern.test(value); }
function dbConnection(database) {
  const db = database?.database ?? database;
  if (typeof db?.prepare !== "function" || typeof db?.exec !== "function") throw fail("VM_ARCHIVE_STORE_INVALID");
  return db;
}

function publicJob(row) {
  if (!row) return null;
  let request;
  try { request = JSON.parse(row.request_json); } catch { throw fail("VM_ARCHIVE_STORE_CORRUPT"); }
  return {
    id: row.id, eventId: row.event_id, subjectKey: row.subject_key, configVersion: row.config_version,
    record: request.record, filename: row.filename, state: row.state, attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at, errorCode: row.error_code,
  };
}

function sourceShape(source, record) {
  if (!object(source) || ["baseToken", "tableId", "recordId"].some((key) => source.record?.[key] !== record[key])
    || ![source.deliveryId, source.runId, source.artifactId].every((value) => validId(value))
    || typeof source.localPath !== "string" || !path.isAbsolute(source.localPath)
    || path.normalize(source.localPath) !== source.localPath || source.localPath.includes("\0")
    || path.extname(source.localPath).toLowerCase() !== ".mp4"
    || typeof source.sha256 !== "string" || !SHA256.test(source.sha256)
    || !Number.isSafeInteger(source.bytes) || source.bytes < 1) throw fail("VM_ARCHIVE_PLAN_INVALID");
}

function planShape(plan, request) {
  if (!object(plan) || !object(plan.record) || !object(plan.source)
    || ["baseToken", "tableId", "recordId"].some((key) => plan.record[key] !== request.record[key])) {
    throw fail("VM_ARCHIVE_PLAN_INVALID");
  }
  sourceShape({ ...plan.source, record: plan.record }, plan.record);
  if (typeof plan.filename !== "string" || plan.filename.length < 5 || plan.filename.length > 180
    || path.basename(plan.filename) !== plan.filename || !/^[^\u0000-\u001f<>:"/\\|?*]+\.mp4$/iu.test(plan.filename)
    || typeof plan.destinationDirectory !== "string" || !path.isAbsolute(plan.destinationDirectory)
    || path.normalize(plan.destinationDirectory) !== plan.destinationDirectory
    || typeof plan.destinationPath !== "string" || !path.isAbsolute(plan.destinationPath)
    || plan.destinationPath !== path.join(plan.destinationDirectory, plan.filename)
    || typeof plan.canonicalLocationKey !== "string" || !plan.canonicalLocationKey.trim()) {
    throw fail("VM_ARCHIVE_PLAN_INVALID");
  }
  return structuredClone(plan);
}

function validRequest(value) {
  if (!object(value) || Object.keys(value).some((key) => !["eventId", "subjectKey", "configVersion", "record", "statusEdge"].includes(key))
    || !validId(value.eventId, ID)
    || typeof value.subjectKey !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}:[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(value.subjectKey)
    || !Number.isSafeInteger(value.configVersion) || value.configVersion < 1
    || !object(value.record) || Object.keys(value.record).some((key) => !["baseToken", "tableId", "recordId"].includes(key))
    || ![value.record.baseToken, value.record.tableId, value.record.recordId].every((entry) => validId(entry))
    || !object(value.statusEdge)
    || Object.keys(value.statusEdge).some((key) => !["statusFieldId", "beforeOptionIds", "afterOptionIds", "occurredAt"].includes(key))
    || !validId(value.statusEdge.statusFieldId)
    || ![value.statusEdge.beforeOptionIds, value.statusEdge.afterOptionIds].every((ids) => Array.isArray(ids)
      && ids.length <= 256 && ids.every((entry) => validId(entry)) && new Set(ids).size === ids.length)
    || value.statusEdge.afterOptionIds.length === 0
    || JSON.stringify(value.statusEdge.beforeOptionIds) === JSON.stringify(value.statusEdge.afterOptionIds)
    || Object.hasOwn(value.statusEdge, "occurredAt")
      && (!Number.isSafeInteger(value.statusEdge.occurredAt) || value.statusEdge.occurredAt < 0)) {
    throw fail("VM_ARCHIVE_REQUEST_INVALID");
  }
  if (`${value.record.baseToken}:${value.record.tableId}` !== value.subjectKey) throw fail("VM_ARCHIVE_REQUEST_INVALID");
  return structuredClone(value);
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function stablePath(target, { directory = false } = {}) {
  try {
    const info = await lstat(target, { bigint: true });
    const canonical = await realpath(target);
    const invalidType = directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n;
    if (info.isSymbolicLink() || !samePath(canonical, target)
      || invalidType) {
      throw fail(directory ? "VM_ARCHIVE_DIRECTORY_INVALID" : "VM_ARCHIVE_SOURCE_CHANGED");
    }
    return info;
  } catch (error) {
    if (error?.code?.startsWith("VM_ARCHIVE_")) throw error;
    throw fail(directory ? "VM_ARCHIVE_DIRECTORY_UNAVAILABLE" : "VM_ARCHIVE_SOURCE_CHANGED");
  }
}

async function hashStableFile(filename, expectedSha, expectedBytes, { source = false } = {}) {
  const code = source ? "VM_ARCHIVE_SOURCE_CHANGED" : "VM_ARCHIVE_COPY_INVALID";
  let before;
  try {
    before = await stablePath(filename);
    if (before.size !== BigInt(expectedBytes)) throw new Error("size changed");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(filename)) { hash.update(chunk); bytes += chunk.length; }
    const after = await lstat(filename, { bigint: true });
    if (bytes !== expectedBytes || hash.digest("hex") !== expectedSha
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.nlink !== 1n) throw new Error("contents changed");
    return true;
  } catch (error) {
    if (error?.code?.startsWith("VM_ARCHIVE_")) throw error;
    throw fail(code);
  }
}

async function existingDestination(destinationPath, source) {
  let info;
  try { info = await lstat(destinationPath, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return false; throw fail("VM_ARCHIVE_DESTINATION_UNAVAILABLE"); }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) throw fail("VM_ARCHIVE_DESTINATION_CONFLICT");
  try { await hashStableFile(destinationPath, source.sha256, source.bytes); return true; }
  catch { throw fail("VM_ARCHIVE_DESTINATION_CONFLICT"); }
}

function terminalError(code) {
  return ["VM_ARCHIVE_SOURCE_CHANGED", "VM_ARCHIVE_COPY_INVALID", "VM_ARCHIVE_PLAN_INVALID",
    "VM_ARCHIVE_DIRECTORY_INVALID", "VM_ARCHIVE_DESTINATION_CONFLICT", "VM_ARCHIVE_TEMP_PATH_UNSAFE",
    "VM_ARCHIVE_ATOMIC_PUBLISH_UNSUPPORTED", "VM_ARCHIVE_SOURCE_SUPERSEDED",
    "VM_ARCHIVE_SOURCE_UNAVAILABLE"].includes(code);
}

function retryable(error) {
  return TRANSIENT_CODES.has(error?.code) || ["VM_ARCHIVE_DIRECTORY_UNAVAILABLE", "VM_ARCHIVE_DESTINATION_UNAVAILABLE"]
    .includes(error?.code);
}

/** Durable no-overwrite publisher. resolveArchivePlan must use the active trusted
 * subject and its confirmed latest-delivered pointer; requests contain no paths. */
export function createVmFinalArchiveService({ database, resolveArchivePlan, now = Date.now,
  idFactory = randomUUID, copy = copyFile, publish = link, validateArchiveSource = async () => {} } = {}) {
  const db = dbConnection(database);
  if (typeof resolveArchivePlan !== "function" || typeof now !== "function" || typeof idFactory !== "function"
    || typeof copy !== "function" || typeof publish !== "function" || typeof validateArchiveSource !== "function")
    throw fail("VM_ARCHIVE_SERVICE_INVALID");
  db.exec(`CREATE TABLE IF NOT EXISTS vm_final_archive_jobs (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, subject_key TEXT NOT NULL,
    config_version INTEGER NOT NULL, request_json TEXT NOT NULL, plan_json TEXT NOT NULL,
    destination_key TEXT NOT NULL, filename TEXT NOT NULL, state TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    error_code TEXT, lease_token TEXT, lease_until INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS vm_final_archive_ready
    ON vm_final_archive_jobs(state, next_attempt_at, created_at);
  CREATE INDEX IF NOT EXISTS vm_final_archive_destination
    ON vm_final_archive_jobs(destination_key, state, lease_until);`);

  function get(eventId) {
    if (!validId(eventId, ID)) throw fail("VM_ARCHIVE_REQUEST_INVALID");
    return publicJob(db.prepare("SELECT * FROM vm_final_archive_jobs WHERE event_id = ?").get(eventId));
  }

  function update(id, state, { attempts, nextAt, errorCode, leaseToken = null, leaseUntil = null } = {}, owner = null) {
    const row = db.prepare(`UPDATE vm_final_archive_jobs SET state = ?, attempt_count = ?, next_attempt_at = ?,
      error_code = ?, lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?
      AND (? IS NULL OR (lease_token = ? AND state = 'copying' AND lease_until > ?))`)
      .run(state, attempts, nextAt, errorCode, leaseToken, leaseUntil, now(), id, owner, owner, now());
    if (row.changes !== 1) return null;
    return publicJob(db.prepare("SELECT * FROM vm_final_archive_jobs WHERE id = ?").get(id));
  }

  function recover() {
    const timestamp = now();
    return Number(db.prepare(`UPDATE vm_final_archive_jobs SET state = 'retry_wait', lease_token = NULL,
      lease_until = NULL, next_attempt_at = ?, error_code = 'VM_ARCHIVE_LEASE_EXPIRED', updated_at = ?
      WHERE state = 'copying' AND (lease_until IS NULL OR lease_until <= ?)`)
      .run(timestamp, timestamp, timestamp).changes);
  }

  async function enqueue(value) {
    const request = validRequest(value);
    const requestJson = canonicalJson(request);
    const existing = db.prepare("SELECT * FROM vm_final_archive_jobs WHERE event_id = ?").get(request.eventId);
    if (existing) {
      if (existing.request_json !== requestJson) throw fail("VM_ARCHIVE_EVENT_CONFLICT");
      return publicJob(existing);
    }
    const plan = planShape(await resolveArchivePlan(structuredClone(request)), request);
    const planJson = canonicalJson(plan);
    db.exec("BEGIN IMMEDIATE");
    try {
      const winner = db.prepare("SELECT * FROM vm_final_archive_jobs WHERE event_id = ?").get(request.eventId);
      if (winner) {
        if (winner.request_json !== requestJson) throw fail("VM_ARCHIVE_EVENT_CONFLICT");
        db.exec("COMMIT");
        return publicJob(winner);
      }
      const timestamp = now();
      const id = idFactory();
      db.prepare(`INSERT INTO vm_final_archive_jobs(id,event_id,subject_key,config_version,request_json,plan_json,
        destination_key,filename,state,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?, 'pending',?,?,?)`)
        .run(id, request.eventId, request.subjectKey, request.configVersion, requestJson, planJson,
          plan.canonicalLocationKey, plan.filename, timestamp, timestamp, timestamp);
      db.exec("COMMIT");
      return get(request.eventId);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function claim() {
    recover();
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`SELECT candidate.* FROM vm_final_archive_jobs AS candidate
        WHERE candidate.state IN ('pending','retry_wait') AND candidate.next_attempt_at <= ?
          AND NOT EXISTS (SELECT 1 FROM vm_final_archive_jobs AS active
            WHERE active.id <> candidate.id AND active.destination_key = candidate.destination_key
              AND active.state = 'copying' AND active.lease_until > ?)
        ORDER BY candidate.created_at,candidate.id LIMIT 1`).get(timestamp, timestamp);
      if (!row) { db.exec("COMMIT"); return null; }
      const token = randomUUID();
      db.prepare("UPDATE vm_final_archive_jobs SET state='copying',lease_token=?,lease_until=?,updated_at=? WHERE id=?")
        .run(token, timestamp + LEASE_MS, timestamp, row.id);
      db.exec("COMMIT");
      return { row: db.prepare("SELECT * FROM vm_final_archive_jobs WHERE id = ?").get(row.id), token };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function assertOwner(row, token) {
    const current = db.prepare("SELECT state,lease_token,lease_until FROM vm_final_archive_jobs WHERE id = ?").get(row.id);
    if (!current || current.state !== "copying" || current.lease_token !== token || current.lease_until <= now())
      throw fail("VM_ARCHIVE_LEASE_STALE");
  }

  async function removeOwnedTemp(tempPath) {
    let info;
    try { info = await lstat(tempPath, { bigint: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw fail("VM_ARCHIVE_TEMP_PATH_UNSAFE"); }
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 2n) throw fail("VM_ARCHIVE_TEMP_PATH_UNSAFE");
    await unlink(tempPath);
  }

  async function removePublishedTempLink(tempPath, destinationPath) {
    let tempInfo, destinationInfo;
    try { tempInfo = await lstat(tempPath, { bigint: true }); }
    catch (error) { if (error?.code === "ENOENT") return false; throw fail("VM_ARCHIVE_TEMP_PATH_UNSAFE"); }
    try { destinationInfo = await lstat(destinationPath, { bigint: true }); }
    catch (error) { if (error?.code === "ENOENT") return false; throw fail("VM_ARCHIVE_DESTINATION_UNAVAILABLE"); }
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile() || tempInfo.nlink !== 2n) return false;
    if (tempInfo.dev !== destinationInfo.dev || tempInfo.ino !== destinationInfo.ino
      || destinationInfo.isSymbolicLink() || !destinationInfo.isFile() || destinationInfo.nlink !== 2n) return false;
    await unlink(tempPath);
    return true;
  }

  async function publishPlan(plan, row, token) {
    const source = plan.source;
    const validate = async () => {
      await validateArchiveSource({request: JSON.parse(row.request_json), plan: structuredClone(plan)});
      assertOwner(row, token);
    };
    await validate();
    await stablePath(plan.destinationDirectory, { directory: true });
    assertOwner(row, token);
    const tempPath = path.join(plan.destinationDirectory, `.${row.id}.${plan.filename}.tmp`);
    if (await removePublishedTempLink(tempPath, plan.destinationPath)
      && await existingDestination(plan.destinationPath, source)) return "published";
    if (await existingDestination(plan.destinationPath, source)) return "published";
    await removeOwnedTemp(tempPath);
    await hashStableFile(source.localPath, source.sha256, source.bytes, { source: true });
    assertOwner(row, token);
    await copy(source.localPath, tempPath, fsConstants.COPYFILE_EXCL);
    try {
      await hashStableFile(tempPath, source.sha256, source.bytes);
      await hashStableFile(source.localPath, source.sha256, source.bytes, { source: true });
      await validate();
      try { await publish(tempPath, plan.destinationPath); }
      catch (error) {
        if (error?.code !== "EEXIST") {
          if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error?.code))
            throw fail("VM_ARCHIVE_ATOMIC_PUBLISH_UNSUPPORTED");
          throw error;
        }
        if (!await existingDestination(plan.destinationPath, source)) throw fail("VM_ARCHIVE_DESTINATION_CONFLICT");
      }
      const handle = await open(tempPath, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await removeOwnedTemp(tempPath);
      await hashStableFile(plan.destinationPath, source.sha256, source.bytes);
      return "published";
    } finally {
      await removeOwnedTemp(tempPath).catch(() => {});
    }
  }

  async function processNext() {
    const claimed = claim();
    if (!claimed) return null;
    const { row, token } = claimed;
    let plan;
    try { plan = planShape(JSON.parse(row.plan_json), JSON.parse(row.request_json)); }
    catch { return update(row.id, "conflict", { attempts: row.attempt_count, nextAt: now(), errorCode: "VM_ARCHIVE_STORE_CORRUPT" }, token); }
    try {
      const state = await publishPlan(plan, row, token);
      return update(row.id, state, { attempts: row.attempt_count, nextAt: now(), errorCode: null }, token);
    } catch (error) {
      if (error?.code === "VM_ARCHIVE_LEASE_STALE") return get(row.event_id);
      const code = terminalError(error?.code) ? error.code
        : retryable(error) ? "VM_ARCHIVE_RETRY" : "VM_ARCHIVE_RETRY";
      if (terminalError(code)) return update(row.id, "conflict", {
        attempts: row.attempt_count, nextAt: now(), errorCode: code,
      }, token);
      const attempts = row.attempt_count + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      return update(row.id, exhausted ? "dead_letter" : "retry_wait", {
        attempts, nextAt: exhausted ? now() : now() + Math.min(5_000 * 2 ** (attempts - 1), 300_000),
        errorCode: exhausted ? "VM_ARCHIVE_RETRIES_EXHAUSTED" : code,
      }, token);
    }
  }

  recover();
  return Object.freeze({ enqueue, get, processNext, recover });
}
