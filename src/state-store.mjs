import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { safeDeliveryErrorCode } from "./retry-policy.mjs";
import { withEventLock as withEventIpcLock, withStateLock } from "./state-lock.mjs";
import { portableSubject } from "./workflow-config.mjs";

const TERMINAL_STATES = new Set(["succeeded", "dead_letter"]);
const DELIVERY_STATES = new Set([
  "pending",
  "processing",
  "retry_wait",
  "succeeded",
  "dead_letter",
]);
const DECISIONS = new Set(["ready", "blocked", "ignored", "register", "archive_waiting"]);
const DECISION_SNAPSHOT_VERSION = 1;
const LEGACY_DECISION_SNAPSHOT_ACTIONS = new Set(["create", "archive"]);
const LEGACY_DECISION_SNAPSHOT_ROOT_FIELDS = new Set([
  "version",
  "action",
  "kind",
  "reason",
  "effect",
  "table",
  "packageAlias",
  "packageSource",
  "packageProjectId",
  "packageConfigFingerprint",
]);
const DECISION_SNAPSHOT_TABLE_FIELDS = new Set([
  "baseToken",
  "tableId",
  "subjectKey",
  "name",
  "configVersion",
  "mode",
  "executionMode",
  "uploadMode",
  "concurrencyGroup",
  "maxConcurrent",
  "resourceGroups",
  "triggerField",
  "triggerFieldId",
  "triggerValue",
]);
const PHASED_DECISION_SNAPSHOT_ACTIONS = new Set([
  "register",
  "blocked",
  "ignored",
  "archive_waiting",
]);
const PHASED_DECISION_SNAPSHOT_ROOT_FIELDS = new Set([
  "version",
  "action",
  "kind",
  "subjectKey",
  "configVersion",
  "stageId",
  "previousStageId",
  "eventOccurredAt",
  "beforeOptionId",
  "afterOptionId",
  "event",
  "subject",
  "reason",
  "reasonCode",
  "controlledContext",
]);
const PHASED_STAGE_IDS = new Set(["initial", "first_review", "final_review"]);
const CONTROLLED_CONTEXT_FIELDS = new Set([
  "documentLinks",
  "namingDisplayValue",
  "namingValueUnique",
]);
const MAX_FAILURE_HISTORY = 10;
const REHYDRATABLE_SNAPSHOT_ERRORS = new Set([
  "LEGACY_EVENT_SNAPSHOT_MISSING",
  "EVENT_SNAPSHOT_MISSING",
  "PROCESSING_EVENT_SNAPSHOT_MISSING",
]);
const EVENT_SNAPSHOT_FIELDS = Object.freeze([
  "eventId",
  "baseToken",
  "tableId",
  "recordId",
  "recordTitle",
  "action",
  "fieldId",
  "fieldName",
  "beforeValue",
  "afterValue",
  "fields",
  "fieldValuesById",
  "statusFieldId",
  "beforePresent",
  "afterPresent",
  "beforeOptionId",
  "afterOptionId",
  "eventOccurredAt",
  "eventOccurredAtPresent",
]);

function normalizeEventSnapshot(event) {
  const snapshot = {};
  for (const field of EVENT_SNAPSHOT_FIELDS) {
    if (Object.hasOwn(event, field)) snapshot[field] = structuredClone(event[field]);
  }
  return snapshot;
}

function snapshotInvalid(message) {
  const error = new Error(`DECISION_SNAPSHOT_INVALID: ${message}`);
  error.code = "DECISION_SNAPSHOT_INVALID";
  return error;
}

function snapshotString(value, name, { optional = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return undefined;
    throw snapshotInvalid(`${name} must be a non-empty string`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw snapshotInvalid(`${name} must be a non-empty string`);
  }
  const result = value.trim();
  if (/[\u0000-\u001f\u007f]/u.test(result)) {
    throw snapshotInvalid(`${name} contains control characters`);
  }
  return result;
}

function assertSnapshotKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw snapshotInvalid(`${name}.${key} is not supported`);
  }
}

function optionalSnapshotString(value, name) {
  return snapshotString(value, name, { optional: true }) ?? null;
}

function snapshotTimestamp(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw snapshotInvalid(`${name} must be a non-negative timestamp`);
  }
  return value;
}

function normalizeControlledContext(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw snapshotInvalid("snapshot.controlledContext must be an object or null");
  }
  assertSnapshotKeys(value, CONTROLLED_CONTEXT_FIELDS, "snapshot.controlledContext");
  if (!Array.isArray(value.documentLinks) || value.documentLinks.length > 32) {
    throw snapshotInvalid("snapshot.controlledContext.documentLinks must be a bounded array");
  }
  const documentLinks = value.documentLinks.map((entry, index) => {
    const link = snapshotString(entry, `snapshot.controlledContext.documentLinks[${index}]`);
    if (link.length > 2048) {
      throw snapshotInvalid(`snapshot.controlledContext.documentLinks[${index}] is too long`);
    }
    return link;
  });
  if (typeof value.namingDisplayValue !== "string"
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.namingDisplayValue)
    || value.namingDisplayValue.length > 1024) {
    throw snapshotInvalid("snapshot.controlledContext.namingDisplayValue is invalid");
  }
  if (typeof value.namingValueUnique !== "boolean") {
    throw snapshotInvalid("snapshot.controlledContext.namingValueUnique must be boolean");
  }
  return {
    documentLinks,
    namingDisplayValue: value.namingDisplayValue,
    namingValueUnique: value.namingValueUnique,
  };
}

function normalizeLegacyDecisionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw snapshotInvalid("snapshot must be an object");
  }
  assertSnapshotKeys(value, LEGACY_DECISION_SNAPSHOT_ROOT_FIELDS, "snapshot");
  if (value.version !== DECISION_SNAPSHOT_VERSION) {
    throw snapshotInvalid(`version must be ${DECISION_SNAPSHOT_VERSION}`);
  }
  const action = snapshotString(value.action, "snapshot.action");
  if (!LEGACY_DECISION_SNAPSHOT_ACTIONS.has(action)) {
    throw snapshotInvalid("snapshot.action is not supported");
  }
  const kind = snapshotString(value.kind, "snapshot.kind");
  if (!DECISIONS.has(kind)) throw snapshotInvalid("snapshot.kind is not supported");
  if ((action === "create" && !["ready", "blocked"].includes(kind))
    || (action === "archive" && kind !== "ignored")) {
    throw snapshotInvalid("snapshot action and kind do not match");
  }

  const table = value.table;
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    throw snapshotInvalid("snapshot.table must be an object");
  }
  assertSnapshotKeys(table, DECISION_SNAPSHOT_TABLE_FIELDS, "snapshot.table");
  const normalizedTable = {
    baseToken: snapshotString(table.baseToken, "snapshot.table.baseToken"),
    tableId: snapshotString(table.tableId, "snapshot.table.tableId"),
    name: snapshotString(table.name, "snapshot.table.name"),
    mode: snapshotString(table.mode, "snapshot.table.mode"),
    triggerField: snapshotString(table.triggerField, "snapshot.table.triggerField"),
    triggerValue: snapshotString(table.triggerValue, "snapshot.table.triggerValue"),
  };
  if (!["manual", "automatic"].includes(normalizedTable.mode)) {
    throw snapshotInvalid("snapshot.table.mode is not supported");
  }
  for (const field of [
    "subjectKey",
    "executionMode",
    "uploadMode",
    "concurrencyGroup",
    "triggerFieldId",
  ]) {
    const normalized = snapshotString(table[field], `snapshot.table.${field}`, { optional: true });
    if (normalized !== undefined) normalizedTable[field] = normalized;
  }
  if (table.configVersion !== undefined && table.configVersion !== null) {
    if (!Number.isSafeInteger(table.configVersion) || table.configVersion <= 0) {
      throw snapshotInvalid("snapshot.table.configVersion must be a positive integer");
    }
    normalizedTable.configVersion = table.configVersion;
  }
  if (table.maxConcurrent !== undefined && table.maxConcurrent !== null) {
    if (!Number.isSafeInteger(table.maxConcurrent) || table.maxConcurrent <= 0) {
      throw snapshotInvalid("snapshot.table.maxConcurrent must be a positive integer");
    }
    normalizedTable.maxConcurrent = table.maxConcurrent;
  }
  if (table.resourceGroups !== undefined) {
    if (!Array.isArray(table.resourceGroups)) {
      throw snapshotInvalid("snapshot.table.resourceGroups must be an array");
    }
    normalizedTable.resourceGroups = table.resourceGroups.map((entry, index) => (
      snapshotString(entry, `snapshot.table.resourceGroups[${index}]`)
    ));
  }

  const normalized = {
    version: DECISION_SNAPSHOT_VERSION,
    action,
    kind,
    table: normalizedTable,
  };
  for (const field of ["reason", "effect", "packageAlias", "packageSource", "packageProjectId", "packageConfigFingerprint"]) {
    const normalizedValue = snapshotString(value[field], `snapshot.${field}`, { optional: true });
    if (normalizedValue !== undefined) normalized[field] = normalizedValue;
  }
  if (action === "archive" && normalized.effect !== "archive_waiting_tasks") {
    throw snapshotInvalid("archive snapshots must use archive_waiting_tasks effect");
  }
  if (action === "create" && normalized.effect !== undefined) {
    throw snapshotInvalid("create snapshots must not carry an archive effect");
  }
  if (kind === "ignored" && normalized.reason !== "left_trigger") {
    throw snapshotInvalid("archive snapshots must preserve left_trigger reason");
  }
  if (kind === "ready") {
    if (!normalized.packageAlias || !normalized.packageProjectId) {
      throw snapshotInvalid("ready snapshots require packageAlias and packageProjectId");
    }
  }
  for (const field of ["packageAlias", "packageProjectId"]) {
    if (normalized[field] !== undefined && /[\\/:]/u.test(normalized[field])) {
      throw snapshotInvalid(`snapshot.${field} must be an identifier`);
    }
  }
  if (normalized.packageConfigFingerprint !== undefined
    && !/^[a-f0-9]{64}$/u.test(normalized.packageConfigFingerprint)) {
    throw snapshotInvalid("snapshot.packageConfigFingerprint must be a SHA-256 hex digest");
  }
  return normalized;
}

function normalizePhasedDecisionSnapshot(value) {
  assertSnapshotKeys(value, PHASED_DECISION_SNAPSHOT_ROOT_FIELDS, "snapshot");
  if (value.version !== DECISION_SNAPSHOT_VERSION) {
    throw snapshotInvalid(`version must be ${DECISION_SNAPSHOT_VERSION}`);
  }
  const action = snapshotString(value.action, "snapshot.action");
  const kind = snapshotString(value.kind, "snapshot.kind");
  if (!PHASED_DECISION_SNAPSHOT_ACTIONS.has(action) || action !== kind) {
    throw snapshotInvalid("snapshot phased action and kind must match");
  }
  const subjectKey = snapshotString(value.subjectKey, "snapshot.subjectKey");
  if (!subjectKey.includes(":")) throw snapshotInvalid("snapshot.subjectKey is invalid");
  if (!Number.isSafeInteger(value.configVersion) || value.configVersion < 1) {
    throw snapshotInvalid("snapshot.configVersion must be a positive integer");
  }
  const stageId = optionalSnapshotString(value.stageId, "snapshot.stageId");
  const previousStageId = optionalSnapshotString(value.previousStageId, "snapshot.previousStageId");
  for (const [name, stage] of [["stageId", stageId], ["previousStageId", previousStageId]]) {
    if (stage !== null && !PHASED_STAGE_IDS.has(stage)) {
      throw snapshotInvalid(`snapshot.${name} is not supported`);
    }
  }
  if (kind === "register" && stageId === null) {
    throw snapshotInvalid("register snapshots require stageId");
  }
  if (kind === "archive_waiting" && stageId === null) {
    throw snapshotInvalid("archive_waiting snapshots require stageId");
  }
  if (!value.subject || typeof value.subject !== "object" || Array.isArray(value.subject)) {
    // The first handoff tests exercise the minimal immutable binding. Full
    // Bridge retry snapshots additionally include the portable subject.
    if (value.subject !== undefined && value.subject !== null) {
      throw snapshotInvalid("snapshot.subject must be an object or null");
    }
  }
  let subject = null;
  if (value.subject) {
    try {
      subject = portableSubject(value.subject);
    } catch {
      throw snapshotInvalid("snapshot.subject is invalid");
    }
    if (subject.subjectKey !== subjectKey || subject.configVersion !== value.configVersion) {
      throw snapshotInvalid("snapshot subject identity does not match the binding");
    }
  }
  const event = value.event === undefined || value.event === null
    ? null
    : normalizeEventSnapshot(value.event);
  if (value.event !== undefined && value.event !== null
    && (!value.event || typeof value.event !== "object" || Array.isArray(value.event))) {
    throw snapshotInvalid("snapshot.event must be an object or null");
  }
  const normalized = {
    version: DECISION_SNAPSHOT_VERSION,
    action,
    kind,
    subjectKey,
    configVersion: value.configVersion,
    stageId,
    previousStageId,
    eventOccurredAt: snapshotTimestamp(value.eventOccurredAt, "snapshot.eventOccurredAt"),
    beforeOptionId: optionalSnapshotString(value.beforeOptionId, "snapshot.beforeOptionId"),
    afterOptionId: optionalSnapshotString(value.afterOptionId, "snapshot.afterOptionId"),
    event,
    subject,
    reason: optionalSnapshotString(value.reason, "snapshot.reason"),
    reasonCode: optionalSnapshotString(value.reasonCode, "snapshot.reasonCode"),
    controlledContext: normalizeControlledContext(value.controlledContext),
  };
  return normalized;
}

/** Keep retry decisions independent from executable or machine-local data. */
function normalizeDecisionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw snapshotInvalid("snapshot must be an object");
  }
  return Object.hasOwn(value, "table")
    ? normalizeLegacyDecisionSnapshot(value)
    : normalizePhasedDecisionSnapshot(value);
}

function snapshotMatchesEvent(snapshot, event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return true;
  if (snapshot.table) {
    return snapshot.table.baseToken === event.baseToken
      && snapshot.table.tableId === event.tableId;
  }
  const [baseToken, tableId] = snapshot.subjectKey.split(":");
  return baseToken === event.baseToken
    && tableId === event.tableId
    && (snapshot.event === null || snapshot.event.eventId === event.eventId)
    && (snapshot.beforeOptionId === null || snapshot.beforeOptionId === event.beforeOptionId)
    && (snapshot.afterOptionId === null || snapshot.afterOptionId === event.afterOptionId);
}

function assertClaimOptions({ ownerId, leaseMs }) {
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    throw new Error("ownerId must be a non-empty string");
  }
  if (!Number.isFinite(leaseMs) || !Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("leaseMs must be a finite positive integer");
  }
}

function assertRetrySchedule(nextAttemptAt, now) {
  if (!Number.isFinite(nextAttemptAt) || nextAttemptAt <= now) {
    throw new Error("nextAttemptAt must be a finite timestamp greater than now");
  }
}

function newRecord(event, now) {
  return {
    schemaVersion: 2,
    eventId: event.eventId,
    event: normalizeEventSnapshot(event),
    deliveryState: "pending",
    decision: null,
    decisionSnapshot: null,
    attempts: 0,
    nextAttemptAt: null,
    lease: null,
    lastError: null,
    failureHistory: [],
    outcome: null,
    createdAt: now,
    updatedAt: now,
  };
}

function legacyRecord(eventId, value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const invalid = new Error("STATE_FILE_INVALID: durable state record must be an object");
    invalid.code = "STATE_FILE_INVALID";
    throw invalid;
  }
  if (value.kind === "pending") {
    return {
      schemaVersion: 2,
      eventId,
      event: null,
      deliveryState: "dead_letter",
      decision: null,
      decisionSnapshot: null,
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: { code: "LEGACY_EVENT_SNAPSHOT_MISSING", status: 0, at: now },
      failureHistory: [],
      outcome: null,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (!DECISIONS.has(value.kind)) {
    const invalid = new Error("STATE_FILE_INVALID: unknown legacy delivery outcome");
    invalid.code = "STATE_FILE_INVALID";
    throw invalid;
  }
  const outcome = normalizeOutcome(value, value.kind);
  if (!outcome) {
    const invalid = new Error("STATE_FILE_INVALID: invalid legacy delivery outcome");
    invalid.code = "STATE_FILE_INVALID";
    throw invalid;
  }
  return {
    schemaVersion: 2,
    eventId,
    event: null,
    deliveryState: "succeeded",
    decision: value?.kind ?? null,
    decisionSnapshot: null,
    attempts: 0,
    nextAttemptAt: null,
    lease: null,
    lastError: null,
    failureHistory: [],
    outcome,
    createdAt: now,
    updatedAt: now,
  };
}

function invalidRecord(eventId, value, now, code) {
  const createdAt = Number.isFinite(value?.createdAt) ? value.createdAt : now;
  const attempts = Number.isInteger(value?.attempts) && value.attempts >= 0 ? value.attempts : 0;
  return {
    schemaVersion: 2,
    eventId,
    event: null,
    deliveryState: "dead_letter",
    decision: null,
    decisionSnapshot: null,
    attempts,
    nextAttemptAt: null,
    lease: null,
    lastError: { code, status: 0, at: now },
    failureHistory: [],
    outcome: null,
    createdAt,
    updatedAt: now,
  };
}

function normalizeOutcome(value, decision, { requireTaskIdentifier = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!DECISIONS.has(value.kind) || (decision !== null && value.kind !== decision)) return null;
  const outcome = { kind: value.kind };
  for (const field of [
    "reason",
    "reasonCode",
    "taskId",
    "taskIdentifier",
    "packageAlias",
    "stageId",
    "subjectKey",
  ]) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== "string" || value[field].trim() === "") return null;
    outcome[field] = value[field];
  }
  const noTaskOutcome = value.kind === "ignored" || value.kind === "archive_waiting" || value.kind === "blocked";
  if (!noTaskOutcome && !outcome.taskId && !outcome.taskIdentifier) return null;
  if (requireTaskIdentifier && !noTaskOutcome && (!outcome.taskId || !outcome.taskIdentifier)) return null;
  return outcome;
}

function normalizeRecord(eventId, value, now) {
  if (value?.schemaVersion === 2) {
    const record = structuredClone(value);
    const snapshotEventId = record.event
      && typeof record.event === "object"
      && !Array.isArray(record.event)
      && typeof record.event.eventId === "string"
      && record.event.eventId.trim() !== ""
      ? record.event.eventId
      : null;
    if (record.eventId !== eventId || (snapshotEventId !== null && snapshotEventId !== eventId)) {
      return invalidRecord(eventId, record, now, "EVENT_RECORD_ID_MISMATCH");
    }
    if (!DELIVERY_STATES.has(record.deliveryState)) {
      return invalidRecord(eventId, record, now, "EVENT_RECORD_INVALID");
    }
    if (record.attempts === undefined) record.attempts = 0;
    if (!Number.isInteger(record.attempts) || record.attempts < 0) {
      return invalidRecord(eventId, record, now, "EVENT_RECORD_INVALID");
    }
    if (record.createdAt === undefined) record.createdAt = now;
    if (record.updatedAt === undefined) record.updatedAt = now;
    if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) {
      return invalidRecord(eventId, record, now, "EVENT_RECORD_INVALID");
    }
    if (record.decision === undefined) record.decision = null;
    if (record.decision !== null && !DECISIONS.has(record.decision)) {
      return invalidRecord(eventId, record, now, "EVENT_RECORD_INVALID");
    }
    if (record.decisionSnapshot === undefined || record.decisionSnapshot === null) {
      record.decisionSnapshot = null;
    } else {
      try {
        record.decisionSnapshot = normalizeDecisionSnapshot(record.decisionSnapshot);
      } catch {
        return invalidRecord(eventId, record, now, "DECISION_SNAPSHOT_INVALID");
      }
    }
    if (record.nextAttemptAt === undefined) record.nextAttemptAt = null;
    if (record.nextAttemptAt !== null && !Number.isFinite(record.nextAttemptAt)) {
      return invalidRecord(eventId, record, now, "EVENT_RECORD_INVALID");
    }
    if (record.lease === undefined) record.lease = null;
    if (record.lease !== null && (typeof record.lease !== "object" || Array.isArray(record.lease))) {
      record.lease = null;
    }
    if (record.lastError === undefined) record.lastError = null;
    if (record.lastError !== null && (typeof record.lastError !== "object" || Array.isArray(record.lastError))) {
      return invalidRecord(eventId, record, now, "EVENT_RECORD_INVALID");
    }
    if (record.lastError) {
      record.lastError = summarizeError(record.lastError, now);
    }
    if (record.failureHistory === undefined) record.failureHistory = [];
    if (!Array.isArray(record.failureHistory)) {
      return invalidRecord(eventId, record, now, "EVENT_RECORD_INVALID");
    }
    record.failureHistory = record.failureHistory
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => summarizeError(entry, now))
      .slice(-MAX_FAILURE_HISTORY);
    if (record.outcome === undefined) record.outcome = null;
    if (record.deliveryState === "succeeded") {
      const outcome = normalizeOutcome(record.outcome, record.decision);
      if (!outcome) return invalidRecord(eventId, record, now, "EVENT_RECORD_INVALID");
      record.outcome = outcome;
    } else {
      record.outcome = null;
    }
    if (record.deliveryState === "retry_wait" && record.nextAttemptAt === null) {
      return invalidRecord(eventId, record, now, "EVENT_RECORD_INVALID");
    }
    if (record.deliveryState !== "retry_wait") record.nextAttemptAt = null;
    if (record.deliveryState !== "processing") record.lease = null;
    if (record.event && typeof record.event === "object" && !Array.isArray(record.event)) {
      record.event = normalizeEventSnapshot(record.event);
    } else if (record.event !== null && record.event !== undefined) {
      return invalidRecord(eventId, record, now, "EVENT_RECORD_INVALID");
    }
    if (record.event === undefined) record.event = null;
    if (!hasEventSnapshot(record.event)) {
      record.event = null;
      if (record.deliveryState === "pending" || record.deliveryState === "retry_wait") {
        return invalidRecord(eventId, record, now, "EVENT_SNAPSHOT_MISSING");
      }
    }
    if (record.decisionSnapshot && !snapshotMatchesEvent(record.decisionSnapshot, record.event)) {
      return invalidRecord(eventId, record, now, "DECISION_SNAPSHOT_INVALID");
    }
    return record;
  }
  return legacyRecord(eventId, value, now);
}

function validLease(record, now) {
  return (
    record.deliveryState === "processing"
    && typeof record.lease?.ownerId === "string"
    && record.lease.ownerId.trim() !== ""
    && typeof record.lease?.token === "string"
    && record.lease.token.trim() !== ""
    && Number.isFinite(record.lease?.leaseUntil)
    && record.lease.leaseUntil > now
  );
}

function newLease(ownerId, now, leaseMs) {
  return {
    ownerId,
    token: randomUUID(),
    leaseUntil: now + leaseMs,
  };
}

function isExcluded(excludeEventIds, eventId) {
  if (excludeEventIds instanceof Set) return excludeEventIds.has(eventId);
  if (Array.isArray(excludeEventIds)) return excludeEventIds.includes(eventId);
  return false;
}

function assertEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("event must be an object");
  }
  if (typeof event.eventId !== "string" || event.eventId.trim() === "") {
    throw new Error("event.eventId must be a non-empty string");
  }
}

function hasEventSnapshot(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  for (const field of ["eventId", "baseToken", "tableId", "recordId"]) {
    if (typeof event[field] !== "string" || event[field].trim() === "") return false;
  }
  const legacyEdge = typeof event.fieldName === "string" && event.fieldName.trim() !== ""
    && Object.hasOwn(event, "beforeValue") && Object.hasOwn(event, "afterValue");
  const phasedEdge = typeof event.statusFieldId === "string" && event.statusFieldId.trim() !== ""
    && event.beforePresent === true && event.afterPresent === true
    && typeof event.beforeOptionId === "string" && event.beforeOptionId.trim() !== ""
    && typeof event.afterOptionId === "string" && event.afterOptionId.trim() !== "";
  if (!legacyEdge && !phasedEdge) return false;
  return Boolean(event.fields && typeof event.fields === "object" && !Array.isArray(event.fields));
}

function assertLeaseOwner(record, ownerId, now, token, { allowExpired = false } = {}) {
  const leaseUntil = record.lease?.leaseUntil;
  const leaseToken = record.lease?.token;
  if (
    record.deliveryState !== "processing"
    || record.lease?.ownerId !== ownerId
    || !Number.isFinite(leaseUntil)
    || (!allowExpired && leaseUntil <= now)
    || typeof leaseToken !== "string"
    || leaseToken.trim() === ""
    || token !== leaseToken
  ) {
    const error = new Error(`Cannot update delivery record ${record.eventId}: lease is not owned by ${ownerId}`);
    error.code = "LEASE_NOT_OWNED";
    throw error;
  }
}

function summarizeError(error, now) {
  const code = safeDeliveryErrorCode(error?.code);
  const status = Number.isInteger(error?.status) ? error.status : 0;
  const at = Number.isFinite(error?.at) ? error.at : now;
  return { code, status, at };
}

function stateObject() {
  return Object.create(null);
}

export class JsonStateStore {
  #filename;
  #writeQueue = Promise.resolve();

  constructor(filename) {
    this.#filename = filename;
  }

  async #read(now = Date.now()) {
    let data;
    try {
      data = JSON.parse(await readFile(this.#filename, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return stateObject();
      throw error;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      const invalid = new Error("STATE_FILE_INVALID: durable state file must contain an object map");
      invalid.code = "STATE_FILE_INVALID";
      throw invalid;
    }
    const state = stateObject();
    for (const [key, value] of Object.entries(data)) {
      state[key] = normalizeRecord(key, value, now);
    }
    return state;
  }

  async get(eventId) {
    return this.#withFileLock(async () => {
      const state = await this.#read();
      return Object.hasOwn(state, eventId) ? structuredClone(state[eventId]) : null;
    });
  }

  async #withFileLock(operation) {
    await mkdir(path.dirname(this.#filename), { recursive: true });
    return withStateLock(this.#filename, operation);
  }

  async withEventLock(eventId, operation) {
    if (typeof eventId !== "string" || eventId.trim() === "") {
      throw new Error("eventId must be a non-empty string");
    }
    if (typeof operation !== "function") throw new Error("event lock operation must be a function");
    await mkdir(path.dirname(this.#filename), { recursive: true });
    return withEventIpcLock(this.#filename, eventId, operation);
  }

  async #writeState(state) {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    let temporary = null;
    let handle = null;
    for (let attempt = 0; attempt < 3 && !handle; attempt += 1) {
      temporary = `${this.#filename}.${randomUUID()}.tmp`;
      try {
        handle = await open(temporary, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST" || attempt === 2) throw error;
      }
    }

    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        const error = new Error("STATE_TEMP_UNSUPPORTED: temporary state file must be a single-link regular file");
        error.code = "STATE_TEMP_UNSUPPORTED";
        throw error;
      }
      await handle.writeFile(serialized, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
      const written = await handle.stat();
      if (!written.isFile() || written.nlink !== 1) {
        const error = new Error("STATE_TEMP_UNSUPPORTED: temporary state file changed while writing");
        error.code = "STATE_TEMP_UNSUPPORTED";
        throw error;
      }
      await handle.close();
      handle = null;
      const target = await lstat(temporary);
      if (!target.isFile() || target.nlink !== 1) {
        const error = new Error("STATE_TEMP_UNSUPPORTED: temporary state path is not a single-link regular file");
        error.code = "STATE_TEMP_UNSUPPORTED";
        throw error;
      }
      await rename(temporary, this.#filename);
      temporary = null;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (temporary) await unlink(temporary).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async #mutate(operation, now = Date.now(), clock = () => now) {
    let result;
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(async () => {
      result = await this.#withFileLock(async () => {
        const readNow = typeof clock === "function" ? clock() : now;
        const state = await this.#read(readNow);
        const currentNow = typeof clock === "function" ? clock() : readNow;
        const value = await operation(state, currentNow);
        await this.#writeState(state);
        return value;
      });
    });
    await this.#writeQueue;
    return result;
  }

  async claimEvent(event, { ownerId, now, leaseMs, clock }) {
    assertEvent(event);
    assertClaimOptions({ ownerId, leaseMs });
    return this.#mutate((state, currentNow) => {
      let record = Object.hasOwn(state, event.eventId) ? state[event.eventId] : null;
      if (!record) {
        if (!hasEventSnapshot(event)) throw new Error("event snapshot is incomplete");
        record = newRecord(event, currentNow);
        state[event.eventId] = record;
      } else if (
        record.deliveryState === "dead_letter"
        && record.event === null
        && REHYDRATABLE_SNAPSHOT_ERRORS.has(record.lastError?.code)
      ) {
        if (!hasEventSnapshot(event)) return { kind: "terminal", record: structuredClone(record) };
        record = newRecord(event, currentNow);
        state[event.eventId] = record;
      }

      if (record && !hasEventSnapshot(record.event) && !TERMINAL_STATES.has(record.deliveryState)) {
        // Never replace a snapshot while another worker still owns a valid
        // lease. Once the lease is absent or expired, a replay carrying the
        // complete server-normalized event is the only safe way to rehydrate
        // the malformed record.
        if (validLease(record, currentNow)) {
          return { kind: "deferred", record: structuredClone(record) };
        }
        if (!hasEventSnapshot(event)) {
          record = invalidRecord(event.eventId, record, currentNow, "EVENT_SNAPSHOT_MISSING");
          state[event.eventId] = record;
          return { kind: "terminal", record: structuredClone(record) };
        }
        record.event = normalizeEventSnapshot(event);
        record.deliveryState = "pending";
        record.nextAttemptAt = null;
        record.lease = null;
        record.updatedAt = currentNow;
      }

      if (TERMINAL_STATES.has(record.deliveryState)) {
        return { kind: "terminal", record: structuredClone(record) };
      }
      if (validLease(record, currentNow)) {
        return { kind: "deferred", record: structuredClone(record) };
      }
      if (
        record.deliveryState === "retry_wait"
        && record.nextAttemptAt !== null
        && record.nextAttemptAt > currentNow
      ) {
        return { kind: "deferred", record: structuredClone(record) };
      }

      record.deliveryState = "processing";
      record.attempts += 1;
      record.nextAttemptAt = null;
      record.lease = newLease(ownerId, currentNow, leaseMs);
      record.updatedAt = currentNow;
      return { kind: "claimed", record: structuredClone(record) };
    }, now, clock);
  }

  async claimNextDue({ ownerId, now, leaseMs, excludeEventIds, clock }) {
    assertClaimOptions({ ownerId, leaseMs });
    return this.#mutate((state, currentNow) => {
      const due = Object.values(state)
        .filter((record) => (
          (record.deliveryState === "pending" || record.deliveryState === "retry_wait")
          && hasEventSnapshot(record.event)
          && !isExcluded(excludeEventIds, record.eventId)
          && (record.nextAttemptAt === null || record.nextAttemptAt <= currentNow)
        ))
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!due) return null;

      due.deliveryState = "processing";
      due.attempts += 1;
      due.nextAttemptAt = null;
      due.lease = newLease(ownerId, currentNow, leaseMs);
      due.updatedAt = currentNow;
      return structuredClone(due);
    }, now, clock);
  }

  async saveDecisionSnapshot(eventId, { ownerId, token, snapshot, now, clock }) {
    const normalizedSnapshot = normalizeDecisionSnapshot(snapshot);
    return this.#mutate((state, currentNow) => {
      const record = state[eventId];
      if (!record) throw new Error(`Cannot update unknown delivery record ${eventId}`);
      assertLeaseOwner(record, ownerId, currentNow, token);
      if (!snapshotMatchesEvent(normalizedSnapshot, record.event)) {
        throw snapshotInvalid("snapshot subject does not match event");
      }
      if (record.decisionSnapshot !== null) {
        const existing = normalizeDecisionSnapshot(record.decisionSnapshot);
        if (JSON.stringify(existing) !== JSON.stringify(normalizedSnapshot)) {
          const error = new Error(`Cannot replace decision snapshot for ${eventId}`);
          error.code = "DECISION_SNAPSHOT_CONFLICT";
          throw error;
        }
        return structuredClone(record);
      }
      record.decisionSnapshot = normalizedSnapshot;
      record.updatedAt = currentNow;
      return structuredClone(record);
    }, now, clock);
  }

  async complete(eventId, {
    ownerId,
    token,
    decision,
    outcome,
    requireTaskIdentifier = true,
    now,
    clock,
  }) {
    return this.#mutate((state, currentNow) => {
      const record = state[eventId];
      if (!record) throw new Error(`Cannot update unknown delivery record ${eventId}`);
      assertLeaseOwner(record, ownerId, currentNow, token);
      const normalizedOutcome = normalizeOutcome(outcome, decision, { requireTaskIdentifier });
      if (!DECISIONS.has(decision) || !normalizedOutcome) {
        throw new Error("outcome must match decision and contain valid task identifiers");
      }
      record.deliveryState = "succeeded";
      record.decision = decision;
      record.outcome = normalizedOutcome;
      record.nextAttemptAt = null;
      record.lease = null;
      record.updatedAt = currentNow;
      return structuredClone(record);
    }, now, clock);
  }

  async fail(eventId, { ownerId, token, error, nextAttemptAt, deadLetter, now, clock }) {
    if (!deadLetter) {
      const validationNow = Number.isFinite(now) ? now : Date.now();
      assertRetrySchedule(nextAttemptAt, validationNow);
    }
    return this.#mutate((state, currentNow) => {
      const record = state[eventId];
      if (!record) throw new Error(`Cannot update unknown delivery record ${eventId}`);
      assertLeaseOwner(record, ownerId, currentNow, token);
      const scheduledNextAttemptAt = deadLetter
        ? null
        : Math.max(nextAttemptAt, currentNow + 1);
      if (!deadLetter) assertRetrySchedule(scheduledNextAttemptAt, currentNow);
      const summary = summarizeError(error, currentNow);
      record.lastError = summary;
      record.failureHistory = [...record.failureHistory, summary].slice(-MAX_FAILURE_HISTORY);
      record.deliveryState = deadLetter ? "dead_letter" : "retry_wait";
      record.nextAttemptAt = scheduledNextAttemptAt;
      record.lease = null;
      record.updatedAt = currentNow;
      return structuredClone(record);
    }, now, clock);
  }

  async renewLease(eventId, { ownerId, token, now, leaseMs, clock }) {
    assertClaimOptions({ ownerId, leaseMs });
    return this.#mutate((state, currentNow) => {
      const record = state[eventId];
      if (!record) throw new Error(`Cannot update unknown delivery record ${eventId}`);
      assertLeaseOwner(record, ownerId, currentNow, token, { allowExpired: true });
      record.lease.leaseUntil = currentNow + leaseMs;
      record.updatedAt = currentNow;
      return structuredClone(record);
    }, now, clock);
  }

  async recoverExpiredLeases({ now, excludeEventIds, clock }) {
    return this.#mutate((state, currentNow) => {
      let recovered = 0;
      for (const record of Object.values(state)) {
        if (
          record.deliveryState === "processing"
          && !isExcluded(excludeEventIds, record.eventId)
          && !validLease(record, currentNow)
        ) {
          const snapshotValid = hasEventSnapshot(record.event);
          record.deliveryState = snapshotValid ? "pending" : "dead_letter";
          if (!snapshotValid) record.event = null;
          record.lease = null;
          record.nextAttemptAt = null;
          if (!snapshotValid) {
            record.lastError = { code: "PROCESSING_EVENT_SNAPSHOT_MISSING", status: 0, at: currentNow };
          }
          record.updatedAt = currentNow;
          recovered += 1;
        }
      }
      return recovered;
    }, now, clock);
  }

  async getQueueStats() {
    return this.#withFileLock(async () => {
      const state = await this.#read();
      const stats = {
        pending: 0,
        processing: 0,
        retryWait: 0,
        deadLetter: 0,
      };
      for (const record of Object.values(state)) {
        if (record.deliveryState === "pending") stats.pending += 1;
        else if (record.deliveryState === "processing") stats.processing += 1;
        else if (record.deliveryState === "retry_wait") stats.retryWait += 1;
        else if (record.deliveryState === "dead_letter") stats.deadLetter += 1;
      }
      return stats;
    });
  }
}
