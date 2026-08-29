import path from "node:path";

/**
 * Version of the local Base/subject configuration document.
 *
 * This is deliberately independent from the legacy Bridge config schema.  The
 * legacy `tables` configuration is still consumed by config.mjs; this module
 * owns the versioned, UI-editable workflow catalog.
 */
export const WORKFLOW_SCHEMA_VERSION = 1;

const LIFECYCLES = new Set(["draft", "enabled", "disabled"]);
const EXECUTION_MODES = new Set(["manual", "automatic"]);
const ENQUEUE_MODES = new Set(["manual", "automatic"]);
const ARTIFACT_SOURCE_MODES = new Set([
  "manual_select",
  "watch_directory",
  "driver_report",
]);
const ROUTE_MODES = new Set(["fixed"]);

const WORKFLOW_KEYS = new Set([
  "schemaVersion",
  "configVersion",
  "createdAt",
  "updatedAt",
  "bases",
]);
const BASE_KEYS = new Set([
  "baseToken",
  "baseName",
  "sourceUrlLabel",
  "metadataRefreshedAt",
  "subjects",
]);
const SUBJECT_KEYS = new Set([
  "subjectKey",
  "baseToken",
  "baseName",
  "tableId",
  "tableName",
  "displayEnabled",
  "lifecycle",
  "configVersion",
  "createdAt",
  "updatedAt",
  "trigger",
  "title",
  "execution",
  "packageRoute",
  "upload",
  "activeSnapshot",
]);
const TRIGGER_KEYS = new Set(["fieldId", "fieldName", "startValue", "optionId"]);
const TITLE_KEYS = new Set(["fieldId", "fieldName"]);
const EXECUTION_KEYS = new Set([
  "mode",
  "concurrencyGroup",
  "maxConcurrent",
  "resourceGroups",
]);
const ROUTE_KEYS = new Set([
  "routeMode",
  "packageAlias",
  "subjectCodeFieldId",
  "branchMap",
]);
const UPLOAD_KEYS = new Set([
  "enqueueMode",
  "artifactSourceMode",
  "artifactSourcePath",
  "targetId",
  "targetPath",
  "uploadConcurrency",
]);

function fail(message, code = "WORKFLOW_CONFIG_INVALID") {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function assertKnownKeys(value, keys, name, { allowInternal = false } = {}) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key) && !(allowInternal && key === "activeSnapshot")) {
      fail(`${name}.${key} is not supported`);
    }
  }
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`);
  const result = value.trim();
  if (/[\u0000-\u001f\u007f]/u.test(result)) fail(`${name} contains control characters`);
  return result;
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") return null;
  return nonEmptyString(value, name);
}

function idString(value, name) {
  const result = nonEmptyString(value, name);
  // IDs are used in a composite subject key.  Reject delimiters and path-ish
  // values so two identities can never be represented ambiguously.
  if (/[:\\/\s]/u.test(result)) fail(`${name} contains unsupported characters`);
  return result;
}

function packageAlias(value, name) {
  const result = nonEmptyString(value, name);
  // Aliases are selected from a local allow-list.  They may be named in
  // Chinese (for example Auto-cut-小学语文), but must never contain path,
  // quoting, control or whitespace characters.
  if (/^[./\\]/u.test(result) || /[\s\u0000-\u001f\u007f"'`:$<>|]/u.test(result)) {
    fail(`${name} must be a controlled package alias`);
  }
  return result;
}

function positiveInteger(value, name, fallback = undefined) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}

function timestamp(value, name, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || value < 0) fail(`${name} must be a finite timestamp`);
  return value;
}

function localPath(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const result = nonEmptyString(value, name);
  // path.isAbsolute follows the host platform.  Also recognize Windows paths
  // when a shared config is validated on a non-Windows host.
  const windowsAbsolute = /^[A-Za-z]:[\\/]/u.test(result) || /^\\\\/u.test(result);
  if (!path.isAbsolute(result) && !windowsAbsolute) fail(`${name} must be an absolute local path`);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(result) && !windowsAbsolute) {
    fail(`${name} must be a local path`);
  }
  return windowsAbsolute ? result.replaceAll("/", "\\") : path.normalize(result);
}

function nullableId(value, name) {
  if (value === undefined || value === null || value === "") return null;
  return idString(value, name);
}

function clone(value) {
  return structuredClone(value);
}

export function subjectKey(baseToken, tableId) {
  return `${idString(baseToken, "baseToken")}:${idString(tableId, "tableId")}`;
}

function normalizeTrigger(value, name = "trigger") {
  const input = plainObject(value, name);
  assertKnownKeys(input, TRIGGER_KEYS, name);
  return {
    fieldId: idString(input.fieldId, `${name}.fieldId`),
    fieldName: nonEmptyString(input.fieldName, `${name}.fieldName`),
    startValue: nonEmptyString(input.startValue, `${name}.startValue`),
    optionId: nullableId(input.optionId, `${name}.optionId`),
  };
}

function normalizeTitle(value, name = "title") {
  if (value === undefined || value === null) return { fieldId: null, fieldName: null };
  const input = plainObject(value, name);
  assertKnownKeys(input, TITLE_KEYS, name);
  const fieldId = nullableId(input.fieldId, `${name}.fieldId`);
  const fieldName = optionalString(input.fieldName, `${name}.fieldName`);
  if ((fieldId && !fieldName) || (!fieldId && fieldName)) {
    fail(`${name}.fieldId and ${name}.fieldName must be configured together`);
  }
  return { fieldId, fieldName };
}

function normalizeExecution(value, name = "execution") {
  const input = plainObject(value, name);
  assertKnownKeys(input, EXECUTION_KEYS, name);
  const mode = input.mode;
  if (!EXECUTION_MODES.has(mode)) fail(`${name}.mode must be manual or automatic`);
  const resourceGroups = input.resourceGroups === undefined ? [] : input.resourceGroups;
  if (!Array.isArray(resourceGroups)) fail(`${name}.resourceGroups must be an array`);
  const normalizedGroups = resourceGroups.map((entry, index) => idString(entry, `${name}.resourceGroups[${index}]`));
  return {
    mode,
    concurrencyGroup: idString(input.concurrencyGroup, `${name}.concurrencyGroup`),
    maxConcurrent: positiveInteger(input.maxConcurrent, `${name}.maxConcurrent`, 1),
    resourceGroups: [...new Set(normalizedGroups)],
  };
}

function normalizeBranchMap(value, name = "branchMap") {
  if (value === undefined || value === null) return null;
  const input = plainObject(value, name);
  const result = {};
  for (const [code, alias] of Object.entries(input)) {
    const normalizedCode = nonEmptyString(code, `${name} key`);
    if (/[\u0000-\u001f\u007f]/u.test(normalizedCode)) fail(`${name} key contains control characters`);
    result[normalizedCode] = packageAlias(alias, `${name}.${code}`);
  }
  return result;
}

function normalizePackageRoute(value, name = "packageRoute") {
  const input = plainObject(value, name);
  assertKnownKeys(input, ROUTE_KEYS, name);
  if (!ROUTE_MODES.has(input.routeMode ?? "fixed")) fail(`${name}.routeMode must be fixed`);
  return {
    routeMode: "fixed",
    packageAlias: packageAlias(input.packageAlias, `${name}.packageAlias`),
    subjectCodeFieldId: nullableId(input.subjectCodeFieldId, `${name}.subjectCodeFieldId`),
    branchMap: normalizeBranchMap(input.branchMap, `${name}.branchMap`),
  };
}

function normalizeUpload(value, name = "upload") {
  const input = plainObject(value, name);
  assertKnownKeys(input, UPLOAD_KEYS, name);
  const enqueueMode = input.enqueueMode ?? "manual";
  if (!ENQUEUE_MODES.has(enqueueMode)) fail(`${name}.enqueueMode must be manual or automatic`);
  const artifactSourceMode = input.artifactSourceMode ?? "manual_select";
  if (!ARTIFACT_SOURCE_MODES.has(artifactSourceMode)) {
    fail(`${name}.artifactSourceMode is not supported`);
  }
  return {
    enqueueMode,
    artifactSourceMode,
    artifactSourcePath: localPath(input.artifactSourcePath, `${name}.artifactSourcePath`),
    targetId: optionalString(input.targetId, `${name}.targetId`),
    targetPath: localPath(input.targetPath, `${name}.targetPath`),
    uploadConcurrency: positiveInteger(input.uploadConcurrency, `${name}.uploadConcurrency`, 1),
  };
}

function normalizeSubject(value, base, index, { allowActiveSnapshot = true } = {}) {
  const input = plainObject(value, `bases[${index}].subjects[${index}]`);
  assertKnownKeys(input, SUBJECT_KEYS, `subject[${index}]`, { allowInternal: allowActiveSnapshot });
  const normalizedBaseToken = idString(input.baseToken ?? base.baseToken, `subject[${index}].baseToken`);
  if (normalizedBaseToken !== base.baseToken) fail(`subject[${index}].baseToken does not match its Base`);
  const tableId = idString(input.tableId, `subject[${index}].tableId`);
  const computedKey = subjectKey(normalizedBaseToken, tableId);
  if (input.subjectKey !== undefined && input.subjectKey !== computedKey) {
    fail(`subject[${index}].subjectKey does not match baseToken/tableId`);
  }
  const lifecycle = input.lifecycle ?? "draft";
  if (!LIFECYCLES.has(lifecycle)) fail(`subject[${index}].lifecycle is not supported`);
  const normalized = {
    subjectKey: computedKey,
    baseToken: normalizedBaseToken,
    baseName: nonEmptyString(input.baseName ?? base.baseName, `subject[${index}].baseName`),
    tableId,
    tableName: nonEmptyString(input.tableName, `subject[${index}].tableName`),
    displayEnabled: input.displayEnabled === undefined ? true : input.displayEnabled,
    lifecycle,
    configVersion: positiveInteger(input.configVersion, `subject[${index}].configVersion`, 1),
    createdAt: timestamp(input.createdAt, `subject[${index}].createdAt`),
    updatedAt: timestamp(input.updatedAt, `subject[${index}].updatedAt`),
    trigger: normalizeTrigger(input.trigger, `subject[${index}].trigger`),
    title: normalizeTitle(input.title, `subject[${index}].title`),
    execution: normalizeExecution(input.execution, `subject[${index}].execution`),
    packageRoute: normalizePackageRoute(input.packageRoute, `subject[${index}].packageRoute`),
    upload: normalizeUpload(input.upload, `subject[${index}].upload`),
  };
  if (typeof normalized.displayEnabled !== "boolean") {
    fail(`subject[${index}].displayEnabled must be boolean`);
  }
  if (allowActiveSnapshot && input.activeSnapshot !== undefined && input.activeSnapshot !== null) {
    const snapshot = normalizeSubject(
      { ...input.activeSnapshot, lifecycle: "enabled" },
      base,
      index,
      { allowActiveSnapshot: false },
    );
    normalized.activeSnapshot = snapshot;
  }
  return normalized;
}

function normalizeBase(value, index) {
  const input = plainObject(value, `bases[${index}]`);
  assertKnownKeys(input, BASE_KEYS, `bases[${index}]`);
  const baseToken = idString(input.baseToken, `bases[${index}].baseToken`);
  const base = {
    baseToken,
    baseName: nonEmptyString(input.baseName, `bases[${index}].baseName`),
    sourceUrlLabel: optionalString(input.sourceUrlLabel, `bases[${index}].sourceUrlLabel`),
    metadataRefreshedAt: timestamp(input.metadataRefreshedAt, `bases[${index}].metadataRefreshedAt`),
    subjects: [],
  };
  if (!Array.isArray(input.subjects)) fail(`bases[${index}].subjects must be an array`);
  const tableIds = new Set();
  for (let subjectIndex = 0; subjectIndex < input.subjects.length; subjectIndex += 1) {
    const subject = normalizeSubject(input.subjects[subjectIndex], base, subjectIndex);
    if (tableIds.has(subject.tableId)) fail(`duplicate subjectKey: ${subject.subjectKey}`);
    tableIds.add(subject.tableId);
    base.subjects.push(subject);
  }
  return base;
}

/**
 * Validate and normalize a workflow catalog.  Unknown fields are rejected so
 * values from a Base cell can never silently become executable configuration.
 */
export function validateWorkflowConfig(value) {
  const input = plainObject(value, "workflowConfig");
  assertKnownKeys(input, WORKFLOW_KEYS, "workflowConfig");
  const schemaVersion = input.schemaVersion ?? WORKFLOW_SCHEMA_VERSION;
  if (schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${WORKFLOW_SCHEMA_VERSION}`);
  }
  const configVersion = input.configVersion === undefined
    ? 1
    : positiveInteger(input.configVersion, "workflowConfig.configVersion");
  if (!Array.isArray(input.bases)) fail("workflowConfig.bases must be an array");
  const normalized = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    configVersion,
    createdAt: timestamp(input.createdAt, "workflowConfig.createdAt"),
    updatedAt: timestamp(input.updatedAt, "workflowConfig.updatedAt"),
    bases: [],
  };
  const baseTokens = new Set();
  const subjects = new Set();
  input.bases.forEach((baseInput, index) => {
    const base = normalizeBase(baseInput, index);
    if (baseTokens.has(base.baseToken)) fail(`duplicate baseToken: ${base.baseToken}`);
    baseTokens.add(base.baseToken);
    for (const subject of base.subjects) {
      if (subjects.has(subject.subjectKey)) fail(`duplicate subjectKey: ${subject.subjectKey}`);
      subjects.add(subject.subjectKey);
    }
    normalized.bases.push(base);
  });
  return normalized;
}

/** Return only currently active subject snapshots, independent of display state. */
export function activeTables(config) {
  const normalized = validateWorkflowConfig(config);
  const result = [];
  for (const base of normalized.bases) {
    for (const subject of base.subjects) {
      if (subject.lifecycle === "enabled") result.push(clone(subject));
      else if (subject.lifecycle === "draft" && subject.activeSnapshot) result.push(clone(subject.activeSnapshot));
    }
  }
  return result;
}

export const __internal = Object.freeze({
  normalizeSubject,
  normalizeBase,
  localPath,
  clone,
});

