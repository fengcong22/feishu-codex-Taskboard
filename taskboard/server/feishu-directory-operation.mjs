import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { win32 as path } from "node:path";

import { deriveFinalDirectoryDestination } from "./feishu-course-path.mjs";

export class FeishuDirectoryOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FeishuDirectoryOperationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FeishuDirectoryOperationError(code, message);
}

function connectionFrom(database) {
  const connection = database?.database ?? database;
  if (!connection || typeof connection.prepare !== "function" || typeof connection.exec !== "function") {
    fail("DIRECTORY_OPERATION_STORE_INVALID", "The directory operation store is unavailable");
  }
  return connection;
}

function text(value, name, { maxLength = 512 } = {}) {
  if (typeof value !== "string" || value.includes("\0")) fail("DIRECTORY_OPERATION_INVALID", `${name} is invalid`);
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maxLength) fail("DIRECTORY_OPERATION_INVALID", `${name} is invalid`);
  return normalized;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail("DIRECTORY_OPERATION_INVALID", `${name} is invalid`);
  return value;
}

function timestamp(value, name) {
  const normalized = text(value, name, { maxLength: 32 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalized)
    || new Date(Date.parse(normalized)).toISOString() !== normalized) {
    fail("DIRECTORY_OPERATION_INVALID", `${name} is invalid`);
  }
  return normalized;
}

function eventInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => ![
      "eventId", "baseToken", "tableId", "recordId", "fieldId", "beforeOptionId", "afterOptionId",
      "occurredAt",
    ].includes(key))) {
    fail("DIRECTORY_OPERATION_INVALID", "event is invalid");
  }
  return {
    eventId: text(value.eventId, "event.eventId"),
    baseToken: text(value.baseToken, "event.baseToken"),
    tableId: text(value.tableId, "event.tableId"),
    recordId: text(value.recordId, "event.recordId"),
    fieldId: text(value.fieldId, "event.fieldId"),
    beforeOptionId: text(value.beforeOptionId, "event.beforeOptionId"),
    afterOptionId: text(value.afterOptionId, "event.afterOptionId"),
  };
}

function bindingInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["bindingId", "baseToken", "tableId", "recordId", "actualRoot", "coursePath"].includes(key))) {
    fail("DIRECTORY_OPERATION_INVALID", "course binding is invalid");
  }
  return {
    bindingId: text(value.bindingId, "courseBinding.bindingId"),
    baseToken: text(value.baseToken, "courseBinding.baseToken"),
    tableId: text(value.tableId, "courseBinding.tableId"),
    recordId: text(value.recordId, "courseBinding.recordId"),
    actualRoot: text(value.actualRoot, "courseBinding.actualRoot", { maxLength: 2_048 }),
    coursePath: text(value.coursePath, "courseBinding.coursePath", { maxLength: 2_048 }),
  };
}

function operationFromRow(row) {
  if (!row) return null;
  if (row.kind !== "ensure_final_directory" || !["pending", "succeeded"].includes(row.state)) {
    fail("DIRECTORY_OPERATION_STORE_CORRUPT", "Stored directory operation is invalid");
  }
  return {
    id: row.id,
    eventId: row.event_id,
    kind: row.kind,
    state: row.state,
    subjectKey: row.subject_key,
    configVersion: row.config_version,
    courseBindingId: row.course_binding_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameOperation(row, input) {
  return row.subject_key === input.subjectKey
    && row.config_version === input.configVersion
    && row.base_token === input.event.baseToken
    && row.table_id === input.event.tableId
    && row.record_id === input.event.recordId
    && row.field_id === input.event.fieldId
    && row.before_option_id === input.event.beforeOptionId
    && row.after_option_id === input.event.afterOptionId
    && row.course_binding_id === input.courseBinding.bindingId;
}

/** Persist event idempotency separately from task registration. */
export function createFeishuDirectoryOperationStore({ database, now = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  const db = connectionFrom(database);

  function get(id) {
    return operationFromRow(db.prepare("SELECT * FROM feishu_directory_operations WHERE id = ?").get(text(id, "id")));
  }

  return Object.freeze({
    registerFinalDirectoryOperation({ event, subjectKey, configVersion, courseBinding } = {}) {
      const normalized = {
        event: eventInput(event),
        subjectKey: text(subjectKey, "subjectKey"),
        configVersion: positiveInteger(configVersion, "configVersion"),
        courseBinding: bindingInput(courseBinding),
      };
      if (normalized.event.baseToken !== normalized.courseBinding.baseToken
        || normalized.event.tableId !== normalized.courseBinding.tableId
        || normalized.event.recordId !== normalized.courseBinding.recordId) {
        fail("DIRECTORY_OPERATION_BINDING_MISMATCH", "Directory operation does not match the course binding");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const existingRow = db.prepare("SELECT * FROM feishu_directory_operations WHERE event_id = ?")
          .get(normalized.event.eventId);
        if (existingRow) {
          if (!sameOperation(existingRow, normalized)) {
            fail("DIRECTORY_OPERATION_EVENT_CONFLICT", "The Feishu event is already bound to another directory operation");
          }
          db.exec("COMMIT");
          return { operation: operationFromRow(existingRow), created: false };
        }
        const id = text(idFactory(), "idFactory result");
        const createdAt = timestamp(now(), "now");
        db.prepare(`
          INSERT INTO feishu_directory_operations (
            id, event_id, subject_key, config_version, base_token, table_id, record_id,
            field_id, before_option_id, after_option_id, course_binding_id, kind, state,
            error_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ensure_final_directory', 'pending', NULL, ?, ?)
        `).run(
          id, normalized.event.eventId, normalized.subjectKey, normalized.configVersion,
          normalized.event.baseToken, normalized.event.tableId, normalized.event.recordId,
          normalized.event.fieldId, normalized.event.beforeOptionId, normalized.event.afterOptionId,
          normalized.courseBinding.bindingId, createdAt, createdAt,
        );
        const operation = get(id);
        db.exec("COMMIT");
        return { operation, created: true };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    getFinalDirectoryOperation(id) {
      return get(id);
    },
    markFinalDirectoryOperationSucceeded(id) {
      const operationId = text(id, "id");
      const updatedAt = timestamp(now(), "now");
      const result = db.prepare(`
        UPDATE feishu_directory_operations
        SET state = 'succeeded', error_code = NULL, updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(updatedAt, operationId);
      if (result.changes === 0) return get(operationId);
      return get(operationId);
    },
  });
}

function hasSafeRelativeContainment(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== "" && !path.isAbsolute(relative) && !relative.startsWith("..\\") && relative !== "..";
}

async function directoryAt(filesystem, target, code) {
  let entry;
  try {
    entry = await filesystem.lstat(target);
  } catch (error) {
    fail(code, "The configured directory is unavailable");
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    fail(code, "The configured directory is not a safe directory");
  }
}

async function ensureDirectory(filesystem, target, code) {
  try {
    await filesystem.mkdir(target);
  } catch (error) {
    if (error?.code !== "EEXIST") fail(code, "The course directory could not be created");
  }
  await directoryAt(filesystem, target, code);
}

/** Create the fixed final directory without creating an unverified root path. */
export function createFinalDirectoryEnsurer({ filesystem = { lstat, mkdir } } = {}) {
  if (typeof filesystem?.lstat !== "function" || typeof filesystem?.mkdir !== "function") {
    fail("DIRECTORY_OPERATION_FILESYSTEM_INVALID", "The directory filesystem adapter is invalid");
  }
  return async function ensureFinalDirectory(courseBinding) {
    const binding = bindingInput(courseBinding);
    const finalDirectory = deriveFinalDirectoryDestination(binding);
    if (!hasSafeRelativeContainment(binding.actualRoot, binding.coursePath)
      || !hasSafeRelativeContainment(binding.coursePath, finalDirectory)) {
      fail("DIRECTORY_OPERATION_PATH_INVALID", "The stored course binding is not contained by its delivery root");
    }
    await directoryAt(filesystem, binding.actualRoot, "DELIVERY_ROOT_UNAVAILABLE");
    await ensureDirectory(filesystem, binding.coursePath, "COURSE_DIRECTORY_CREATE_FAILED");
    await ensureDirectory(filesystem, finalDirectory, "FINAL_DIRECTORY_CREATE_FAILED");
    return { finalDirectory };
  };
}
