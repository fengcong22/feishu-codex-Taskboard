import { randomUUID } from "node:crypto";
import { win32 as path } from "node:path";

import {
  canonicalCoursePathKey,
  normalizeCourseName,
} from "./feishu-course-path.mjs";

const PATH_KINDS = new Set(["local", "network", "unc"]);
const WRITEBACK_STATES = new Set([
  "pending",
  "processing",
  "retry_wait",
  "succeeded",
  "conflict",
  "dead_letter",
]);
const WRITEBACK_OPERATION_TYPES = new Set(["single_select", "text"]);
const DELIVERY_STAGE_IDS = new Set(["initial", "first_review", "final_review"]);
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const FEISHU_WRITEBACK_LEASE_DURATION_MS = 5 * 60 * 1000;
export const FEISHU_WRITEBACK_MAX_LEASE_DURATION_MS = 20 * 60 * 1000;

export class FeishuDeliveryStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FeishuDeliveryStoreError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FeishuDeliveryStoreError(code, message);
}

function requireText(value, name, { maxLength = 1_024 } = {}) {
  if (typeof value !== "string" || value.includes("\0")) {
    fail("COURSE_BINDING_INVALID", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maxLength) {
    fail("COURSE_BINDING_INVALID", `${name} is invalid`);
  }
  return normalized;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("COURSE_BINDING_INVALID", `${name} must be a positive integer`);
  }
  return value;
}

function requireCanonicalTimestamp(value, name) {
  const timestamp = requireText(value, name, { maxLength: 32 });
  if (!CANONICAL_UTC_TIMESTAMP.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))
    || new Date(Date.parse(timestamp)).toISOString() !== timestamp) {
    fail("WRITEBACK_INVALID", `${name} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

function requireIdentifier(value, name) {
  return requireText(value, name, { maxLength: 512 });
}

function requireLeaseDuration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > FEISHU_WRITEBACK_MAX_LEASE_DURATION_MS) {
    fail("WRITEBACK_INVALID", "leaseMs is invalid");
  }
  return value;
}

function leaseExpiry(timestamp, leaseMs) {
  return new Date(Date.parse(timestamp) + leaseMs).toISOString();
}

function errorDetails(value, { defaultCode, defaultMessage } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("WRITEBACK_INVALID", "error details are required");
  }
  const code = value.code === undefined ? defaultCode : requireText(value.code, "error.code", { maxLength: 128 });
  const message = value.message === undefined
    ? defaultMessage
    : requireText(value.message, "error.message", { maxLength: 1_024 });
  if (!code || !message) fail("WRITEBACK_INVALID", "error details are required");
  return { code, message };
}

function writebackOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("WRITEBACK_INVALID", "operation is required");
  }
  const type = requireText(value.type, "operation.type", { maxLength: 32 });
  if (!WRITEBACK_OPERATION_TYPES.has(type)) {
    fail("WRITEBACK_INVALID", "operation.type is invalid");
  }
  if (type === "single_select") {
    if (Object.keys(value).some((key) => !["type", "fieldId", "optionId"].includes(key))) {
      fail("WRITEBACK_INVALID", "single_select operation contains an unknown field");
    }
    return {
      type,
      fieldId: requireIdentifier(value.fieldId, "operation.fieldId"),
      optionId: requireIdentifier(value.optionId, "operation.optionId"),
    };
  }
  if (Object.keys(value).some((key) => !["type", "fieldId", "value"].includes(key))) {
    fail("WRITEBACK_INVALID", "text operation contains an unknown field");
  }
  if (typeof value.value !== "string" || value.value.includes("\0") || value.value.length > 4_096) {
    fail("WRITEBACK_INVALID", "operation.value is invalid");
  }
  return {
    type,
    fieldId: requireIdentifier(value.fieldId, "operation.fieldId"),
    value: value.value,
  };
}

function writebackIntentFromRow(row) {
  if (!row) return null;
  let operation;
  try {
    operation = writebackOperation(JSON.parse(row.payload_json));
  } catch (error) {
    if (error instanceof FeishuDeliveryStoreError) throw error;
    fail("WRITEBACK_STORE_CORRUPT", "Stored writeback operation is invalid");
  }
  if (!WRITEBACK_STATES.has(row.state)) {
    fail("WRITEBACK_STORE_CORRUPT", "Stored writeback state is invalid");
  }
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    runId: row.run_id,
    courseBindingId: row.course_binding_id ?? null,
    operation,
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    version: row.version,
    claimToken: row.claim_token ?? null,
    leaseUntil: row.lease_until ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    updatedAt: row.updated_at,
  };
}

function identityFrom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("COURSE_BINDING_INVALID", "identity is required");
  }
  return {
    baseToken: requireText(value.baseToken, "identity.baseToken", { maxLength: 255 }),
    tableId: requireText(value.tableId, "identity.tableId", { maxLength: 255 }),
    recordId: requireText(value.recordId, "identity.recordId", { maxLength: 255 }),
  };
}

function normalizeDisplayPath(value) {
  const displayPath = requireText(value, "resolvedPaths.displayPath", { maxLength: 2_048 }).replaceAll("/", "\\");
  if (
    path.isAbsolute(displayPath)
    || /^[A-Za-z]:/u.test(displayPath)
    || displayPath.split("\\").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("COURSE_BINDING_PATH_INVALID", "resolvedPaths.displayPath must be a relative display path");
  }
  return displayPath;
}

function normalizeResolvedPaths(value, courseName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("COURSE_BINDING_INVALID", "resolvedPaths is required");
  }
  const actualRoot = requireText(value.actualRoot, "resolvedPaths.actualRoot", { maxLength: 2_048 }).replaceAll("/", "\\");
  const coursePath = requireText(value.coursePath, "resolvedPaths.coursePath", { maxLength: 2_048 }).replaceAll("/", "\\");
  const pathKind = requireText(value.pathKind, "resolvedPaths.pathKind", { maxLength: 32 });
  if (!PATH_KINDS.has(pathKind)) {
    fail("COURSE_BINDING_PATH_INVALID", "resolvedPaths.pathKind is invalid");
  }

  let expectedCourseKey;
  let coursePathKey;
  let canonicalLocationKey;
  try {
    expectedCourseKey = canonicalCoursePathKey(path.join(actualRoot, courseName));
    coursePathKey = canonicalCoursePathKey(coursePath);
    canonicalLocationKey = canonicalCoursePathKey(
      requireText(value.canonicalLocationKey, "resolvedPaths.canonicalLocationKey", { maxLength: 2_048 }),
    );
  } catch {
    fail("COURSE_BINDING_PATH_INVALID", "resolvedPaths contains an unsafe absolute path");
  }
  if (coursePathKey !== expectedCourseKey) {
    fail("COURSE_BINDING_PATH_INVALID", "resolvedPaths.coursePath does not match the course name and root");
  }
  if ((pathKind === "local" || pathKind === "unc") && canonicalLocationKey !== coursePathKey) {
    fail("COURSE_BINDING_PATH_INVALID", "resolvedPaths.canonicalLocationKey does not match the local course path");
  }
  if (pathKind === "network" && !canonicalLocationKey.startsWith("\\\\")) {
    fail("COURSE_BINDING_PATH_INVALID", "resolvedPaths.canonicalLocationKey must be UNC for a network mapping");
  }

  return {
    actualRoot: path.normalize(actualRoot),
    coursePath: path.normalize(coursePath),
    displayPath: normalizeDisplayPath(value.displayPath),
    canonicalLocationKey,
    pathKind,
  };
}

function courseBindingFromRow(row) {
  if (!row) return null;
  return {
    bindingId: row.id,
    baseToken: row.base_token,
    tableId: row.table_id,
    recordId: row.record_id,
    firstConfigVersion: row.first_config_version,
    courseName: row.course_name,
    actualRoot: row.actual_root,
    coursePath: row.course_path,
    displayPath: row.display_path,
    canonicalLocationKey: row.canonical_location_key,
    pathKind: row.path_kind,
    firstEventId: row.first_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deliveryFactFromRow(row) {
  if (!row) return null;
  let snapshot;
  try {
    snapshot = JSON.parse(row.snapshot_json);
  } catch {
    fail("DELIVERY_FACT_STORE_CORRUPT", "Stored delivery fact is invalid");
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || !["course_path", "stage_uploaded", "processing"].includes(row.kind)) {
    fail("DELIVERY_FACT_STORE_CORRUPT", "Stored delivery fact is invalid");
  }
  return {
    id: row.id,
    kind: row.kind,
    taskId: row.task_id,
    runId: row.run_id,
    bindingId: row.course_binding_id ?? null,
    artifactId: row.artifact_id ?? null,
    artifactUploadId: row.artifact_upload_id ?? null,
    snapshot,
    createdAt: row.created_at,
  };
}

function connectionFrom(database) {
  const connection = database?.database ?? database;
  if (!connection || typeof connection.prepare !== "function" || typeof connection.exec !== "function") {
    fail("COURSE_BINDING_STORE_INVALID", "A Taskboard database connection is required");
  }
  return connection;
}

function isSimulationOrigin(metadataJson) {
  try {
    const metadata = JSON.parse(metadataJson);
    return metadata?.deliverySource === "simulation";
  } catch {
    return true;
  }
}

function writebackLeaseNeedsRecovery(row, nowMs) {
  if (typeof row?.claim_token !== "string" || row.claim_token.trim() === "") return true;
  if (!CANONICAL_UTC_TIMESTAMP.test(row.lease_until ?? "")) return true;
  if (!CANONICAL_UTC_TIMESTAMP.test(row.started_at ?? "")) return true;
  const leaseUntilMs = Date.parse(row.lease_until);
  const startedAtMs = Date.parse(row.started_at);
  if (!Number.isFinite(leaseUntilMs) || !Number.isFinite(startedAtMs)) return true;
  if (new Date(leaseUntilMs).toISOString() !== row.lease_until
    || new Date(startedAtMs).toISOString() !== row.started_at) return true;
  if (leaseUntilMs <= nowMs || leaseUntilMs > nowMs + FEISHU_WRITEBACK_MAX_LEASE_DURATION_MS) return true;
  return leaseUntilMs <= startedAtMs;
}

/**
 * Persist the first trusted course directory binding for each Feishu record.
 * The store performs no filesystem operations; callers must derive paths with
 * the path utility before reaching this boundary.
 */
export function createFeishuDeliveryStore({
  database,
  now = () => new Date().toISOString(),
  idFactory = randomUUID,
  claimTokenFactory = randomUUID,
} = {}) {
  const db = connectionFrom(database);

  function lookup(identity) {
    return courseBindingFromRow(db.prepare(`
      SELECT * FROM feishu_course_bindings
      WHERE base_token = ? AND table_id = ? AND record_id = ?
    `).get(identity.baseToken, identity.tableId, identity.recordId));
  }

  function ensureInTransaction(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      fail("COURSE_BINDING_INVALID", "Course binding input is required");
    }
    const identity = identityFrom(input.identity);
    const existing = lookup(identity);
    if (existing) return existing;

    const courseName = normalizeCourseName(input.namingValue);
    const resolvedPaths = normalizeResolvedPaths(input.resolvedPaths, courseName);
    const firstConfigVersion = requirePositiveInteger(input.subjectVersion, "subjectVersion");
    const firstEventId = requireText(input.trustedEventId, "trustedEventId", { maxLength: 512 });
    const timestamp = requireText(now(), "now", { maxLength: 64 });
    const bindingId = requireText(idFactory(), "idFactory result", { maxLength: 255 });

    // Older databases may not have the schema-level unique constraint. Keep
    // the path identity invariant inside this write transaction as well.
    const collision = db.prepare(`
      SELECT id FROM feishu_course_bindings WHERE canonical_location_key = ?
    `).get(resolvedPaths.canonicalLocationKey);
    if (collision) {
      fail("COURSE_PATH_CONFLICT", "The resolved course directory is already bound to another Feishu record");
    }

    const inserted = db.prepare(`
      INSERT INTO feishu_course_bindings (
        id, base_token, table_id, record_id, first_config_version, course_name,
        actual_root, course_path, display_path, canonical_location_key, path_kind,
        first_event_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      bindingId, identity.baseToken, identity.tableId, identity.recordId, firstConfigVersion, courseName,
      resolvedPaths.actualRoot, resolvedPaths.coursePath, resolvedPaths.displayPath,
      resolvedPaths.canonicalLocationKey, resolvedPaths.pathKind, firstEventId, timestamp, timestamp,
    );
    if (inserted.changes === 1) return lookup(identity);

    const reused = lookup(identity);
    if (reused) return reused;
    fail("COURSE_BINDING_CONFLICT", "Unable to persist the course binding");
  }

  function timestampNow() {
    return requireCanonicalTimestamp(now(), "now");
  }

  function writebackInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("WRITEBACK_INVALID", "Writeback intent is required");
    }
    if (Object.keys(value).some((key) => ![
      "idempotencyKey", "taskId", "runId", "courseBindingId", "operation",
    ].includes(key))) {
      fail("WRITEBACK_INVALID", "Writeback intent contains an unknown field");
    }
    return {
      idempotencyKey: requireIdentifier(value.idempotencyKey, "idempotencyKey"),
      taskId: requireIdentifier(value.taskId, "taskId"),
      runId: requireIdentifier(value.runId, "runId"),
      courseBindingId: value.courseBindingId === null
        ? null
        : requireIdentifier(value.courseBindingId, "courseBindingId"),
      operation: writebackOperation(value.operation),
    };
  }

  function processingWritebackInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("WRITEBACK_INVALID", "Processing writeback input is required");
    }
    if (Object.keys(value).some((key) => !["taskId", "runId", "stageId", "assignments"].includes(key))) {
      fail("WRITEBACK_INVALID", "Processing writeback input contains an unknown field");
    }
    const stageId = requireText(value.stageId, "stageId", { maxLength: 64 });
    if (!DELIVERY_STAGE_IDS.has(stageId)) {
      fail("WRITEBACK_INVALID", "stageId is invalid");
    }
    if (!Array.isArray(value.assignments) || value.assignments.length > 32) {
      fail("WRITEBACK_INVALID", "assignments is invalid");
    }
    const fieldIds = new Set();
    const assignments = value.assignments.map((assignment, index) => {
      if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)
        || Object.keys(assignment).some((key) => !["fieldId", "optionId"].includes(key))) {
        fail("WRITEBACK_INVALID", `assignments[${index}] is invalid`);
      }
      const operation = writebackOperation({ type: "single_select", ...assignment });
      if (fieldIds.has(operation.fieldId)) {
        fail("WRITEBACK_INVALID", "assignments cannot write one field more than once");
      }
      fieldIds.add(operation.fieldId);
      return operation;
    });
    return {
      taskId: requireIdentifier(value.taskId, "taskId"),
      runId: requireIdentifier(value.runId, "runId"),
      stageId,
      assignments,
    };
  }

  function lookupWritebackIntent(id) {
    return writebackIntentFromRow(db.prepare(`
      SELECT * FROM feishu_writeback_outbox WHERE id = ?
    `).get(id));
  }

  function lookupWritebackByKey(idempotencyKey) {
    return writebackIntentFromRow(db.prepare(`
      SELECT * FROM feishu_writeback_outbox WHERE idempotency_key = ?
    `).get(idempotencyKey));
  }

  function listDeliveryFacts(runId) {
    const normalizedRunId = requireIdentifier(runId, "runId");
    return db.prepare(`
      SELECT * FROM feishu_delivery_facts
      WHERE run_id = ?
      ORDER BY CASE kind
        WHEN 'course_path' THEN 1
        WHEN 'processing' THEN 2
        WHEN 'stage_uploaded' THEN 3
        ELSE 4
      END, created_at, id
    `).all(normalizedRunId).map(deliveryFactFromRow);
  }

  function getRunDeliveryProgress(runId) {
    const normalizedRunId = requireIdentifier(runId, "runId");
    const artifact = db.prepare(`
      SELECT id FROM task_artifacts
      WHERE run_id = ?
      ORDER BY created_at, id
      LIMIT 1
    `).get(normalizedRunId);
    const uploaded = artifact ? db.prepare(`
      SELECT 1 FROM artifact_uploads
      WHERE artifact_id = ? AND run_id = ? AND status = 'uploaded'
      LIMIT 1
    `).get(artifact.id, normalizedRunId) : null;
    return {
      artifactId: artifact?.id ?? null,
      registered: Boolean(artifact),
      uploaded: Boolean(uploaded),
    };
  }

  function listPublishedDeliveryUploads() {
    return db.prepare(`
      SELECT
        upload.id AS upload_id,
        upload.task_id,
        upload.run_id,
        upload.course_binding_id
      FROM artifact_uploads AS upload
      JOIN feishu_delivery_facts AS fact
        ON fact.artifact_upload_id = upload.id
        AND fact.kind = 'stage_uploaded'
      WHERE upload.status = 'uploaded'
        AND upload.run_id IS NOT NULL
        AND upload.course_binding_id IS NOT NULL
        AND fact.run_id = upload.run_id
        AND fact.course_binding_id = upload.course_binding_id
      ORDER BY upload.completed_at, upload.id
    `).all().map((row) => ({
      uploadId: row.upload_id,
      taskId: row.task_id,
      runId: row.run_id,
      courseBindingId: row.course_binding_id,
    }));
  }

  function assertTrustedWritebackReferences(input) {
    const reference = db.prepare(`
      SELECT
        run.task_id AS run_task_id,
        run.stage_id AS run_stage_id,
        run.subject_key AS run_subject_key,
        origin.base_token AS origin_base_token,
        origin.table_id AS origin_table_id,
        origin.record_id AS origin_record_id,
        origin.subject_key AS origin_subject_key,
        origin.metadata_json AS origin_metadata_json
      FROM feishu_autocut_runs AS run
      JOIN feishu_task_origins AS origin ON origin.task_id = run.task_id
      WHERE run.run_id = ? AND run.task_id = ?
    `).get(input.runId, input.taskId);
    if (!reference
      || reference.run_subject_key !== `${reference.origin_base_token}:${reference.origin_table_id}`
      || (reference.origin_subject_key && reference.origin_subject_key !== reference.run_subject_key)) {
      fail("WRITEBACK_REFERENCE_INVALID", "Writeback intent references are not a trusted Feishu record");
    }
    if (isSimulationOrigin(reference.origin_metadata_json)) {
      fail("WRITEBACK_SIMULATION_FORBIDDEN", "Simulated Feishu tasks cannot create writeback intents");
    }
    if (input.courseBindingId === null) return;
    const binding = db.prepare(`
      SELECT base_token, table_id, record_id FROM feishu_course_bindings WHERE id = ?
    `).get(input.courseBindingId);
    if (!binding
      || reference.origin_base_token !== binding.base_token
      || reference.origin_table_id !== binding.table_id
      || reference.origin_record_id !== binding.record_id) {
      fail("WRITEBACK_REFERENCE_INVALID", "Writeback intent references are not one trusted Feishu record");
    }
  }

  function bridgeWritebackContextFromRow(row, { operationId, claimToken, version }) {
    const intent = writebackIntentFromRow(row);
    if (!intent
      || intent.state !== "processing"
      || intent.claimToken !== claimToken
      || intent.version !== version) {
      fail("WRITEBACK_CLAIM_STALE", "Writeback intent is no longer claimed by this worker");
    }
    const origin = db.prepare(`
      SELECT base_token, table_id, record_id, metadata_json
      FROM feishu_task_origins WHERE task_id = ?
    `).get(intent.taskId);
    if (!origin || isSimulationOrigin(origin.metadata_json)) {
      fail("WRITEBACK_REFERENCE_INVALID", "Writeback intent has no production Feishu origin");
    }
    return {
      operationId,
      claimToken,
      version,
      target: {
        baseToken: origin.base_token,
        tableId: origin.table_id,
        recordId: origin.record_id,
      },
      operation: intent.operation,
    };
  }

  function sameImmutableWriteback(existing, input) {
    return existing.taskId === input.taskId
      && existing.runId === input.runId
      && existing.courseBindingId === input.courseBindingId
      && JSON.stringify(existing.operation) === JSON.stringify(input.operation);
  }

  function enqueueWritebackIntentInTransaction(input) {
    const normalized = writebackInput(input);
    assertTrustedWritebackReferences(normalized);
    const existing = lookupWritebackByKey(normalized.idempotencyKey);
    if (existing) {
      if (sameImmutableWriteback(existing, normalized)) return existing;
      fail("WRITEBACK_IDEMPOTENCY_CONFLICT", "Writeback idempotency key is already bound to another intent");
    }

    const timestamp = timestampNow();
    const id = requireIdentifier(idFactory(), "idFactory result");
    db.prepare(`
      INSERT INTO feishu_writeback_outbox (
        id, idempotency_key, task_id, run_id, course_binding_id, operation_type, payload_json,
        state, attempt_count, next_attempt_at, error_code, error_message, version, claim_token, lease_until,
        created_at, started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, 1, NULL, NULL, ?, NULL, NULL, ?)
    `).run(
      id,
      normalized.idempotencyKey,
      normalized.taskId,
      normalized.runId,
      normalized.courseBindingId,
      normalized.operation.type,
      JSON.stringify(normalized.operation),
      timestamp,
      timestamp,
      timestamp,
    );
    return lookupWritebackIntent(id);
  }

  function recordProcessingWritebackIntentsInTransaction(input) {
    const normalized = processingWritebackInput(input);
    const reference = {
      taskId: normalized.taskId,
      runId: normalized.runId,
      courseBindingId: null,
    };
    assertTrustedWritebackReferences(reference);
    const run = db.prepare(`
      SELECT stage_id FROM feishu_autocut_runs WHERE run_id = ? AND task_id = ?
    `).get(normalized.runId, normalized.taskId);
    if (!run || run.stage_id !== normalized.stageId) {
      fail("WRITEBACK_REFERENCE_INVALID", "Processing writeback stage does not match the Auto-Cut run");
    }

    const dedupeKey = `processing:${normalized.runId}`;
    let fact = deliveryFactFromRow(db.prepare(`
      SELECT * FROM feishu_delivery_facts WHERE dedupe_key = ?
    `).get(dedupeKey));
    if (!fact) {
      const timestamp = timestampNow();
      const factId = requireIdentifier(idFactory(), "idFactory result");
      db.prepare(`
        INSERT INTO feishu_delivery_facts (
          id, dedupe_key, kind, task_id, run_id, course_binding_id,
          artifact_id, artifact_upload_id, snapshot_json, created_at
        ) VALUES (?, ?, 'processing', ?, ?, NULL, NULL, NULL, ?, ?)
      `).run(
        factId,
        dedupeKey,
        normalized.taskId,
        normalized.runId,
        JSON.stringify({ stageId: normalized.stageId }),
        timestamp,
      );
      fact = deliveryFactFromRow(db.prepare(`SELECT * FROM feishu_delivery_facts WHERE id = ?`).get(factId));
    }

    const intents = normalized.assignments.map((operation, index) => enqueueWritebackIntentInTransaction({
      idempotencyKey: `${normalized.runId}:processing:${index}`,
      taskId: normalized.taskId,
      runId: normalized.runId,
      courseBindingId: null,
      operation,
    }));
    return { fact, intents };
  }

  function transitionOwned(id, claimToken, state, {
    error = null,
    nextAttemptAt = null,
  } = {}) {
    const writebackId = requireIdentifier(id, "id");
    const token = requireIdentifier(claimToken, "claimToken");
    const timestamp = timestampNow();
    const result = db.prepare(`
      UPDATE feishu_writeback_outbox
      SET state = ?, next_attempt_at = ?, error_code = ?, error_message = ?,
          claim_token = NULL, lease_until = NULL,
          completed_at = CASE WHEN ? IN ('succeeded', 'conflict', 'dead_letter') THEN ? ELSE NULL END,
          version = version + 1, updated_at = ?
      WHERE id = ? AND state = 'processing' AND claim_token = ?
    `).run(
      state,
      nextAttemptAt ?? timestamp,
      error?.code ?? null,
      error?.message ?? null,
      state,
      timestamp,
      timestamp,
      writebackId,
      token,
    );
    return result.changes === 1 ? lookupWritebackIntent(writebackId) : null;
  }

  function nextWritebackTimestamp({ states, column }) {
    const row = db.prepare(`
      SELECT ${column} AS timestamp
      FROM feishu_writeback_outbox
      WHERE state IN (${states.map(() => "?").join(", ")})
        AND ${column} IS NOT NULL
      ORDER BY ${column}, created_at, id
      LIMIT 1
    `).get(...states);
    return typeof row?.timestamp === "string" ? row.timestamp : null;
  }

  return {
    getCourseBinding(identity) {
      return lookup(identityFrom(identity));
    },
    ensureCourseBinding(input) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const binding = ensureInTransaction(input);
        db.exec("COMMIT");
        return binding;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    ensureCourseBindingInTransaction: ensureInTransaction,
    getWritebackIntent(id) {
      return lookupWritebackIntent(requireIdentifier(id, "id"));
    },
    listDeliveryFacts,
    getRunDeliveryProgress,
    listPublishedDeliveryUploads,
    resolveWritebackIntentForBridge({ operationId, claimToken, version } = {}) {
      const id = requireIdentifier(operationId, "operationId");
      const token = requireIdentifier(claimToken, "claimToken");
      if (!Number.isSafeInteger(version) || version < 1) {
        fail("WRITEBACK_INVALID", "version is invalid");
      }
      return bridgeWritebackContextFromRow(
        db.prepare("SELECT * FROM feishu_writeback_outbox WHERE id = ?").get(id),
        { operationId: id, claimToken: token, version },
      );
    },
    enqueueWritebackIntent(input) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const intent = enqueueWritebackIntentInTransaction(input);
        db.exec("COMMIT");
        return intent;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    enqueueWritebackIntentInTransaction,
    recordProcessingWritebackIntents(input) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = recordProcessingWritebackIntentsInTransaction(input);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    recordProcessingWritebackIntentsInTransaction,
    getNextWritebackAttemptAt() {
      return nextWritebackTimestamp({
        states: ["pending", "retry_wait"],
        column: "next_attempt_at",
      });
    },
    getNextWritebackLeaseExpiry() {
      return nextWritebackTimestamp({
        states: ["processing"],
        column: "lease_until",
      });
    },
    claimNextWritebackIntent({ leaseMs = FEISHU_WRITEBACK_LEASE_DURATION_MS } = {}) {
      const duration = requireLeaseDuration(leaseMs);
      const timestamp = timestampNow();
      const leaseUntil = leaseExpiry(timestamp, duration);
      db.exec("BEGIN IMMEDIATE");
      try {
        const candidate = db.prepare(`
          SELECT id FROM feishu_writeback_outbox
          WHERE state IN ('pending', 'retry_wait') AND next_attempt_at <= ?
          ORDER BY next_attempt_at, created_at, id
          LIMIT 1
        `).get(timestamp);
        if (!candidate) {
          db.exec("COMMIT");
          return null;
        }
        const claimToken = requireIdentifier(claimTokenFactory(), "claimTokenFactory result");
        const claimed = db.prepare(`
          UPDATE feishu_writeback_outbox
          SET state = 'processing', attempt_count = attempt_count + 1,
              error_code = NULL, error_message = NULL, started_at = ?, completed_at = NULL,
              version = version + 1, updated_at = ?, claim_token = ?, lease_until = ?
          WHERE id = ? AND state IN ('pending', 'retry_wait') AND next_attempt_at <= ?
        `).run(timestamp, timestamp, claimToken, leaseUntil, candidate.id, timestamp);
        if (claimed.changes !== 1) {
          db.exec("COMMIT");
          return null;
        }
        const intent = lookupWritebackIntent(candidate.id);
        db.exec("COMMIT");
        return intent;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    renewWritebackIntentLease(id, claimToken, { leaseMs = FEISHU_WRITEBACK_LEASE_DURATION_MS } = {}) {
      const writebackId = requireIdentifier(id, "id");
      const token = requireIdentifier(claimToken, "claimToken");
      const duration = requireLeaseDuration(leaseMs);
      const timestamp = timestampNow();
      const leaseUntil = leaseExpiry(timestamp, duration);
      db.exec("BEGIN IMMEDIATE");
      try {
        const renewed = db.prepare(`
          UPDATE feishu_writeback_outbox
          SET lease_until = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND state = 'processing' AND claim_token = ?
        `).run(leaseUntil, timestamp, writebackId, token);
        if (renewed.changes !== 1) {
          db.exec("COMMIT");
          return null;
        }
        const intent = lookupWritebackIntent(writebackId);
        db.exec("COMMIT");
        return intent;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    markWritebackIntentSucceeded(id, claimToken) {
      return transitionOwned(id, claimToken, "succeeded");
    },
    markWritebackIntentRetryWait(id, claimToken, input) {
      const details = errorDetails(input);
      const nextAttemptAt = requireCanonicalTimestamp(input?.nextAttemptAt, "nextAttemptAt");
      return transitionOwned(id, claimToken, "retry_wait", { error: details, nextAttemptAt });
    },
    markWritebackIntentConflict(id, claimToken, input) {
      return transitionOwned(id, claimToken, "conflict", { error: errorDetails(input) });
    },
    markWritebackIntentDeadLetter(id, claimToken, input) {
      return transitionOwned(id, claimToken, "dead_letter", { error: errorDetails(input) });
    },
    recoverExpiredWritebackIntents() {
      const timestamp = timestampNow();
      const nowMs = Date.parse(timestamp);
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = db.prepare(`
          SELECT id, claim_token, lease_until, started_at
          FROM feishu_writeback_outbox
          WHERE state = 'processing'
        `).all();
        let recovered = 0;
        const update = db.prepare(`
          UPDATE feishu_writeback_outbox
          SET state = 'retry_wait', next_attempt_at = ?,
              error_code = 'WRITEBACK_LEASE_EXPIRED',
              error_message = 'Writeback worker lease expired',
              claim_token = NULL, lease_until = NULL, completed_at = NULL, version = version + 1, updated_at = ?
          WHERE id = ? AND state = 'processing'
        `);
        for (const row of rows) {
          if (!writebackLeaseNeedsRecovery(row, nowMs)) continue;
          recovered += update.run(timestamp, timestamp, row.id).changes;
        }
        db.exec("COMMIT");
        return recovered;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
  };
}
