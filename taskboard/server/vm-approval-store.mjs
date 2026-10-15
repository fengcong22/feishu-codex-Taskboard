import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { VmSourceError } from "./vm-source-transfer.mjs";

const APPLICATION_ID = 0x564d4150;
const SCHEMA_VERSION = 1;
const MAX_JOB_BYTES = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const PRIVATE_KEY = /(?:token|secret|password|authorization|cookie|bearer|url|uri)$/iu;

function fail(code) { throw new VmSourceError(code); }
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function identifier(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("VM_APPROVAL_STORE_INPUT_INVALID");
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function encodeJob(job) {
  if (!plainObject(job)) fail("VM_APPROVAL_STORE_INPUT_INVALID");
  identifier(job.id);
  if (typeof job.request_fingerprint !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(job.request_fingerprint)) {
    fail("VM_APPROVAL_STORE_INPUT_INVALID");
  }
  const ancestors = new Set();
  function validate(value, depth = 0, key = "") {
    if (depth > 40) fail("VM_APPROVAL_STORE_INPUT_INVALID");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value === "string") {
      if (/https?:\/\//iu.test(value)) {
        let allowed = false;
        if (["allowed_origins", "origin"].includes(key)) {
          try {
            const parsed = new URL(value);
            allowed = parsed.protocol === "https:" && parsed.origin === value;
          } catch { /* Only normalized HTTPS origins may be persisted. */ }
        }
        if (!allowed) fail("VM_APPROVAL_STORE_PRIVATE_DATA");
      }
      if (/\bBearer\s+\S+/iu.test(value)) fail("VM_APPROVAL_STORE_PRIVATE_DATA");
      return;
    }
    if ((!Array.isArray(value) && !plainObject(value)) || ancestors.has(value)) fail("VM_APPROVAL_STORE_INPUT_INVALID");
    ancestors.add(value);
    for (const [childKey, child] of Object.entries(value)) {
      if (PRIVATE_KEY.test(childKey)) fail("VM_APPROVAL_STORE_PRIVATE_DATA");
      validate(child, depth + 1, Array.isArray(value) ? key : childKey);
    }
    ancestors.delete(value);
  }
  validate(job);
  const encoded = JSON.stringify(job);
  if (Buffer.byteLength(encoded) > MAX_JOB_BYTES) fail("VM_APPROVAL_STORE_INPUT_INVALID");
  return encoded;
}
function sameRequest(left, right) {
  return left.request_fingerprint === right.request_fingerprint
    && canonical(left.request) === canonical(right.request);
}
function safeError(error) {
  if (error instanceof VmSourceError) return error;
  return new VmSourceError([5, 6].includes(error?.errcode) ? "VM_APPROVAL_STORE_BUSY" : "VM_APPROVAL_STORE_FAILED");
}
function optionalStat(filename) {
  try { return lstatSync(filename, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function regularFile(info) {
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1n) fail("VM_APPROVAL_STORE_PATH_INVALID");
}
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }

/** A separate local SQLite queue. All transactions finish before callers do network work. */
export function createVmApprovalStore({ file, now = Date.now } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0") || typeof now !== "function") {
    fail("VM_APPROVAL_STORE_INPUT_INVALID");
  }
  const filename = path.resolve(file);
  const parent = path.dirname(filename);
  const directoryPaths = [];
  for (let directory = parent;; directory = path.dirname(directory)) {
    directoryPaths.unshift(directory);
    if (path.dirname(directory) === directory) break;
  }
  let database;
  let closed = false;
  let fileIdentity;
  let directories;

  function validatePaths() {
    for (const { filename: directory, identity } of directories) {
      const info = optionalStat(directory);
      if (!info?.isDirectory() || info.isSymbolicLink() || !sameFile(info, identity)) fail("VM_APPROVAL_STORE_PATH_INVALID");
    }
    const info = optionalStat(filename);
    regularFile(info);
    if (!sameFile(info, fileIdentity)) fail("VM_APPROVAL_STORE_PATH_INVALID");
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const sidecar = optionalStat(`${filename}${suffix}`);
      if (sidecar) regularFile(sidecar);
    }
  }
  function timestamp() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail("VM_APPROVAL_STORE_INPUT_INVALID");
    return value;
  }
  function leaseDuration(value = 60_000) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400_000) fail("VM_APPROVAL_STORE_INPUT_INVALID");
    return value;
  }
  function expiry(current, duration) {
    const value = current + duration;
    if (!Number.isSafeInteger(value)) fail("VM_APPROVAL_STORE_INPUT_INVALID");
    return value;
  }
  function decode(row) {
    if (!row) return null;
    try {
      const job = JSON.parse(row.job_json);
      encodeJob(job);
      if (job.id !== row.id || job.request_fingerprint !== row.request_fingerprint) fail("VM_APPROVAL_STORE_INVALID");
      if (row.lease_token === null ? row.lease_expires_at !== null
        : typeof row.lease_token !== "string" || !row.lease_token
          || !Number.isSafeInteger(row.lease_expires_at) || row.lease_expires_at < 0) fail("VM_APPROVAL_STORE_INVALID");
      return job;
    } catch { fail("VM_APPROVAL_STORE_INVALID"); }
  }
  function operation(callback) {
    if (closed) fail("VM_APPROVAL_STORE_CLOSED");
    try { validatePaths(); return callback(); }
    catch (error) { throw safeError(error); }
  }
  function transaction(callback) {
    return operation(() => {
      database.exec("BEGIN IMMEDIATE");
      try {
        validatePaths();
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* Preserve the safe primary failure. */ }
        throw error;
      }
    });
  }
  function row(id) { return database.prepare("SELECT * FROM vm_approval_jobs WHERE id = ?").get(identifier(id)); }

  try {
    directories = directoryPaths.map((directory) => {
      let identity = optionalStat(directory);
      if (!identity) {
        try { mkdirSync(directory, { mode: 0o700 }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        identity = optionalStat(directory);
      }
      if (!identity?.isDirectory() || identity.isSymbolicLink()) fail("VM_APPROVAL_STORE_PATH_INVALID");
      return { filename: directory, identity };
    });
    let created = false;
    fileIdentity = optionalStat(filename);
    if (!fileIdentity) {
      try { closeSync(openSync(filename, "wx", 0o600)); created = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      fileIdentity = optionalStat(filename);
    }
    regularFile(fileIdentity);
    // Empty or unmarked existing files are never silently reset or adopted.
    if (!created && fileIdentity.size === 0n) fail("VM_APPROVAL_STORE_INVALID");
    validatePaths();
    database = new DatabaseSync(filename);
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    transaction(() => {
      const applicationId = database.prepare("PRAGMA application_id").get().application_id;
      const version = database.prepare("PRAGMA user_version").get().user_version;
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      if (created && applicationId === 0 && version === 0 && tables.length === 0) {
        database.exec(`
          CREATE TABLE vm_approval_jobs (
            id TEXT PRIMARY KEY NOT NULL,
            request_fingerprint TEXT NOT NULL,
            job_json TEXT NOT NULL,
            lease_token TEXT,
            lease_expires_at INTEGER,
            CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
          );
          CREATE UNIQUE INDEX vm_approval_request_fingerprint ON vm_approval_jobs(request_fingerprint);
          CREATE TABLE vm_approval_resources (
            fingerprint TEXT PRIMARY KEY NOT NULL,
            job_id TEXT NOT NULL REFERENCES vm_approval_jobs(id)
          );
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
      } else if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION
        || tables.length !== 2 || tables.map((table) => table.name).sort().join(",") !== "vm_approval_jobs,vm_approval_resources") {
        fail("VM_APPROVAL_STORE_INVALID");
      }
      const columns = database.prepare("PRAGMA table_info(vm_approval_jobs)").all();
      if (columns.map((column) => column.name).join(",") !== "id,request_fingerprint,job_json,lease_token,lease_expires_at"
        || columns[0].pk !== 1 || columns.slice(1).some((column) => column.pk !== 0)) fail("VM_APPROVAL_STORE_INVALID");
      const resourceColumns = database.prepare("PRAGMA table_info(vm_approval_resources)").all();
      if (resourceColumns.map((column) => column.name).join(",") !== "fingerprint,job_id" || resourceColumns[0].pk !== 1) {
        fail("VM_APPROVAL_STORE_INVALID");
      }
      const fingerprintIndex = database.prepare("PRAGMA index_list(vm_approval_jobs)").all()
        .find((index) => index.name === "vm_approval_request_fingerprint");
      if (fingerprintIndex?.unique !== 1
        || database.prepare("PRAGMA index_info(vm_approval_request_fingerprint)").all().map((column) => column.name).join(",") !== "request_fingerprint") {
        fail("VM_APPROVAL_STORE_INVALID");
      }
      if (database.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("VM_APPROVAL_STORE_INVALID");
      if (database.prepare("PRAGMA foreign_key_check").all().length) fail("VM_APPROVAL_STORE_INVALID");
      for (const existing of database.prepare("SELECT * FROM vm_approval_jobs").all()) decode(existing);
      for (const resource of database.prepare("SELECT * FROM vm_approval_resources").all()) {
        if (typeof resource.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(resource.fingerprint)) fail("VM_APPROVAL_STORE_INVALID");
        identifier(resource.job_id);
      }
    });
    // Rollback journals are short-lived; SQLite supplies cross-process OS locking.
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
  } catch (error) {
    try { database?.close(); } catch { /* Never replace an invalid database. */ }
    throw safeError(error);
  }

  return {
    enqueue(job) {
      const encoded = encodeJob(job);
      return transaction(() => {
        const existing = decode(row(job.id));
        if (existing) {
          if (!sameRequest(existing, job)) fail("VM_APPROVAL_JOB_CONFLICT");
          return existing;
        }
        const duplicate = decode(database.prepare("SELECT * FROM vm_approval_jobs WHERE request_fingerprint = ?").get(job.request_fingerprint));
        if (duplicate) {
          if (!sameRequest(duplicate, job)) fail("VM_APPROVAL_JOB_CONFLICT");
          return duplicate;
        }
        database.prepare("INSERT INTO vm_approval_jobs (id, request_fingerprint, job_json) VALUES (?, ?, ?)")
          .run(job.id, job.request_fingerprint, encoded);
        return JSON.parse(encoded);
      });
    },
    get(id) { return operation(() => decode(row(id))); },
    list() { return operation(() => database.prepare("SELECT * FROM vm_approval_jobs ORDER BY id").all().map(decode)); },
    claim(id, { leaseMs = 60_000 } = {}) {
      identifier(id);
      const duration = leaseDuration(leaseMs);
      return transaction(() => {
        const current = timestamp();
        const job = decode(row(id));
        if (!job) return null;
        const leaseToken = randomUUID();
        const expiresAt = expiry(current, duration);
        const result = database.prepare(`UPDATE vm_approval_jobs SET lease_token = ?, lease_expires_at = ?
          WHERE id = ? AND (lease_token IS NULL OR lease_expires_at <= ?)`).run(leaseToken, expiresAt, id, current);
        return result.changes === 1 ? { job, leaseToken, expiresAt } : null;
      });
    },
    renew(id, leaseToken, { leaseMs = 60_000 } = {}) {
      identifier(id);
      if (typeof leaseToken !== "string" || !leaseToken) fail("VM_APPROVAL_STORE_INPUT_INVALID");
      const duration = leaseDuration(leaseMs);
      return transaction(() => {
        const current = timestamp();
        const expiresAt = expiry(current, duration);
        const result = database.prepare(`UPDATE vm_approval_jobs SET lease_expires_at = ?
          WHERE id = ? AND lease_token = ? AND lease_expires_at > ?`).run(expiresAt, id, leaseToken, current);
        if (result.changes !== 1) fail("VM_APPROVAL_LEASE_LOST");
        return { leaseToken, expiresAt };
      });
    },
    reserveResource(id, leaseToken, fingerprint) {
      identifier(id);
      if (typeof leaseToken !== "string" || !leaseToken
        || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)) fail("VM_APPROVAL_STORE_INPUT_INVALID");
      return transaction(() => {
        const existing = row(id);
        decode(existing);
        if (!existing || existing.lease_token !== leaseToken || existing.lease_expires_at <= timestamp()) {
          fail("VM_APPROVAL_LEASE_LOST");
        }
        database.prepare("INSERT INTO vm_approval_resources(fingerprint, job_id) VALUES (?, ?) ON CONFLICT(fingerprint) DO NOTHING")
          .run(fingerprint, id);
        const resource = database.prepare("SELECT job_id FROM vm_approval_resources WHERE fingerprint = ?").get(fingerprint);
        return { job_id: resource.job_id, owned: resource.job_id === id };
      });
    },
    save(id, leaseToken, job, { release = true } = {}) {
      identifier(id);
      if (typeof leaseToken !== "string" || !leaseToken || typeof release !== "boolean") fail("VM_APPROVAL_STORE_INPUT_INVALID");
      const encoded = encodeJob(job);
      if (job.id !== id) fail("VM_APPROVAL_JOB_CONFLICT");
      return transaction(() => {
        const existing = decode(row(id));
        if (!existing || !sameRequest(existing, job)) fail("VM_APPROVAL_JOB_CONFLICT");
        const result = database.prepare(`UPDATE vm_approval_jobs SET job_json = ?,
          lease_token = CASE WHEN ? THEN NULL ELSE lease_token END,
          lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END
          WHERE id = ? AND lease_token = ? AND lease_expires_at > ?`)
          .run(encoded, Number(release), Number(release), id, leaseToken, timestamp());
        if (result.changes !== 1) fail("VM_APPROVAL_LEASE_LOST");
        return JSON.parse(encoded);
      });
    },
    close() {
      if (closed) return;
      try { database.close(); closed = true; }
      catch (error) { throw safeError(error); }
    },
  };
}
