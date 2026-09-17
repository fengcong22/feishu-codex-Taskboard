import path from "node:path";

import { normalizeDeliveryConfig } from "../taskboard/shared/feishu-delivery-config.mjs";

/**
 * Version of the local Base/subject configuration document.
 *
 * This is deliberately independent from the legacy Bridge config schema.  The
 * legacy `tables` configuration is still consumed by config.mjs; this module
 * owns the versioned, UI-editable workflow catalog.
 */
export const WORKFLOW_SCHEMA_VERSION = 1;
export const STAGE_IDS = Object.freeze(["initial", "first_review", "final_review"]);

const DEFAULT_STAGE_SUFFIXES = Object.freeze({
  initial: "_初稿",
  first_review: "_初审修改",
  final_review: "_终审修改",
});

const LIFECYCLES = new Set(["draft", "enabled", "disabled"]);
const EXECUTION_MODES = new Set(["manual", "automatic"]);
const ENQUEUE_MODES = new Set(["manual", "automatic"]);
const ARTIFACT_SOURCE_MODES = new Set([
  "manual_select",
  "watch_directory",
  "driver_report",
]);
const ROUTE_MODES = new Set(["fixed"]);
const SOURCE_KINDS = new Set(["docx_section", "base_attachment"]);
const AUDIO_MODES = new Set(["video_original", "replace_original"]);

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
  "statusField",
  "documentField",
  "namingField",
  "stages",
  "delivery",
  "enabledAt",
  "closedAt",
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
  "enabled",
  "enqueueMode",
  "artifactSourceMode",
  "artifactSourcePath",
  "targetId",
  "targetPath",
  "uploadConcurrency",
]);
const STATUS_FIELD_KEYS = new Set(["fieldId", "fieldName", "name", "type", "uiType", "options", "optionList", "property"]);
const FIELD_KEYS = new Set(["fieldId", "fieldName", "name", "kind"]);
const STAGE_KEYS = new Set([
  "enabled",
  "trigger",
  "videoSource",
  "reviewSource",
  "audio",
  "artifactTargetPath",
  "nameSuffix",
]);
const STAGE_TRIGGER_KEYS = new Set(["fieldId", "fieldName", "optionId", "value"]);
const SOURCE_KEYS = new Set(["kind", "anchorText", "fieldId"]);
const AUDIO_KEYS = new Set(["mode", "source", "durationToleranceSeconds"]);

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

function booleanValue(value, name, fallback = undefined) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") fail(`${name} must be boolean`);
  return value;
}

function finitePositive(value, name, fallback = undefined) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) fail(`${name} must be positive`);
  return value;
}

function optionId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value.optionId ?? value.option_id ?? value.id ?? null;
}

function optionValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value.value ?? value.name ?? value.text ?? value.label ?? null;
}

function normalizeStatusOptions(value, name) {
  const options = value.options ?? value.optionList ?? value.property?.options;
  if (options === undefined) return [];
  if (!Array.isArray(options)) fail(`${name}.options must be an array`);
  return options.map((entry, index) => ({
    optionId: idString(optionId(entry), `${name}.options[${index}].optionId`),
    value: nonEmptyString(optionValue(entry), `${name}.options[${index}].value`),
  }));
}

function normalizeStatusField(value, name = "statusField") {
  const input = plainObject(value, name);
  assertKnownKeys(input, STATUS_FIELD_KEYS, name);
  const rawType = input.type ?? input.uiType ?? "single_select";
  const normalizedType = typeof rawType === "number"
    ? rawType
    : String(rawType).trim().toLowerCase().replace(/[\s_-]/gu, "");
  if (!(rawType === 3 || new Set(["singleselect", "singleoption", "select"]).has(normalizedType))) {
    fail(`${name} must be a single-select field`);
  }
  const options = normalizeStatusOptions(input, name);
  return {
    fieldId: idString(input.fieldId, `${name}.fieldId`),
    fieldName: nonEmptyString(input.fieldName ?? input.name, `${name}.fieldName`),
    type: "single_select",
    ...(options.length ? { options } : {}),
  };
}

function normalizeConfiguredField(value, name, kind = null) {
  const input = plainObject(value, name);
  assertKnownKeys(input, FIELD_KEYS, name);
  return {
    fieldId: idString(input.fieldId, `${name}.fieldId`),
    fieldName: nonEmptyString(input.fieldName ?? input.name, `${name}.fieldName`),
    ...(kind ? { kind } : input.kind ? { kind: nonEmptyString(input.kind, `${name}.kind`) } : {}),
  };
}

function normalizeSource(value, name, { allowBaseAttachment = true } = {}) {
  const input = plainObject(value, name);
  assertKnownKeys(input, SOURCE_KEYS, name);
  const kind = nonEmptyString(input.kind, `${name}.kind`);
  if (!SOURCE_KINDS.has(kind) || (!allowBaseAttachment && kind === "base_attachment")) {
    fail(`${name}.kind is invalid`);
  }
  if (kind === "docx_section") {
    return { kind, anchorText: nonEmptyString(input.anchorText, `${name}.anchorText`) };
  }
  return { kind, fieldId: idString(input.fieldId, `${name}.fieldId`) };
}

function normalizeAudio(value, name) {
  const input = plainObject(value, name);
  assertKnownKeys(input, AUDIO_KEYS, name);
  const mode = nonEmptyString(input.mode, `${name}.mode`);
  if (!AUDIO_MODES.has(mode)) fail(`${name}.mode is invalid`);
  if (mode === "video_original") return { mode };
  return {
    mode,
    source: normalizeSource(input.source, `${name}.source`),
    durationToleranceSeconds: finitePositive(
      input.durationToleranceSeconds,
      `${name}.durationToleranceSeconds`,
      3,
    ),
  };
}

export function normalizeStage(value, metadata = {}, stageId = "stage") {
  const input = plainObject(value, `stages.${stageId}`);
  assertKnownKeys(input, STAGE_KEYS, `stages.${stageId}`);
  const enabled = booleanValue(input.enabled, `stages.${stageId}.enabled`, false);
  const triggerInput = plainObject(input.trigger ?? {}, `stages.${stageId}.trigger`);
  assertKnownKeys(triggerInput, STAGE_TRIGGER_KEYS, `stages.${stageId}.trigger`);
  const statusField = metadata.statusField ?? metadata;
  const trigger = {
    fieldId: enabled
      ? idString(triggerInput.fieldId, `stages.${stageId}.trigger.fieldId`)
      : nullableId(triggerInput.fieldId, `stages.${stageId}.trigger.fieldId`),
    fieldName: enabled
      ? nonEmptyString(
        triggerInput.fieldName ?? statusField?.fieldName ?? statusField?.name,
        `stages.${stageId}.trigger.fieldName`,
      )
      : optionalString(
        triggerInput.fieldName ?? statusField?.fieldName ?? statusField?.name,
        `stages.${stageId}.trigger.fieldName`,
      ),
    optionId: enabled
      ? idString(triggerInput.optionId, `stages.${stageId}.trigger.optionId`)
      : nullableId(triggerInput.optionId, `stages.${stageId}.trigger.optionId`),
    value: enabled
      ? nonEmptyString(triggerInput.value, `stages.${stageId}.trigger.value`)
      : optionalString(triggerInput.value, `stages.${stageId}.trigger.value`),
  };
  if (statusField?.fieldId && trigger.fieldId && trigger.fieldId !== statusField.fieldId) {
    fail(`stages.${stageId}.trigger.fieldId must match statusField.fieldId`);
  }
  return {
    enabled,
    trigger,
    videoSource: normalizeSource(input.videoSource, `stages.${stageId}.videoSource`),
    reviewSource: normalizeSource(
      input.reviewSource,
      `stages.${stageId}.reviewSource`,
      { allowBaseAttachment: false },
    ),
    audio: normalizeAudio(input.audio, `stages.${stageId}.audio`),
    artifactTargetPath: localPath(input.artifactTargetPath, `stages.${stageId}.artifactTargetPath`),
    nameSuffix: input.nameSuffix === undefined
      ? DEFAULT_STAGE_SUFFIXES[stageId] ?? ""
      : nonEmptyString(input.nameSuffix, `stages.${stageId}.nameSuffix`),
  };
}

function normalizeStages(value, statusField) {
  const input = plainObject(value, "stages");
  const unknown = Object.keys(input).find((stageId) => !STAGE_IDS.includes(stageId));
  if (unknown) fail(`stages.${unknown} is not supported`);
  const result = {};
  for (const stageId of STAGE_IDS) {
    if (!Object.hasOwn(input, stageId)) fail(`stages.${stageId} is required`);
    result[stageId] = normalizeStage(input[stageId], { statusField }, stageId);
  }
  const enabled = STAGE_IDS.filter((stageId) => result[stageId].enabled);
  if (enabled.length === 0) fail("at least one stage must be enabled");
  const optionIds = enabled.map((stageId) => result[stageId].trigger.optionId);
  if (new Set(optionIds).size !== optionIds.length) fail("enabled stage trigger options must be unique");
  const knownOptions = new Map((statusField.options ?? []).map((entry) => [entry.optionId, entry.value]));
  for (const stageId of enabled) {
    const stage = result[stageId];
    if (knownOptions.size && !knownOptions.has(stage.trigger.optionId)) {
      fail(`stages.${stageId}.trigger.optionId is not present in statusField options`);
    }
    if (knownOptions.has(stage.trigger.optionId)
      && knownOptions.get(stage.trigger.optionId) !== stage.trigger.value) {
      fail(`stages.${stageId}.trigger.value does not match statusField option`);
    }
  }
  return result;
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
  assertKnownKeys(input, new Set([...EXECUTION_KEYS, "enqueueMode"]), name);
  const mode = input.mode;
  if (!EXECUTION_MODES.has(mode)) fail(`${name}.mode must be manual or automatic`);
  const resourceGroups = input.resourceGroups === undefined ? [] : input.resourceGroups;
  if (!Array.isArray(resourceGroups)) fail(`${name}.resourceGroups must be an array`);
  const normalizedGroups = resourceGroups.map((entry, index) => idString(entry, `${name}.resourceGroups[${index}]`));
  return {
    mode,
    concurrencyGroup: idString(input.concurrencyGroup ?? "default", `${name}.concurrencyGroup`),
    maxConcurrent: positiveInteger(input.maxConcurrent, `${name}.maxConcurrent`, 1),
    resourceGroups: [...new Set(normalizedGroups)],
    ...(input.enqueueMode ? { enqueueMode: input.enqueueMode } : {}),
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
    ...(input.enabled === undefined ? {} : { enabled: booleanValue(input.enabled, `${name}.enabled`) }),
    enqueueMode,
    artifactSourceMode,
    artifactSourcePath: localPath(input.artifactSourcePath, `${name}.artifactSourcePath`),
    targetId: optionalString(input.targetId, `${name}.targetId`),
    targetPath: localPath(input.targetPath, `${name}.targetPath`),
    uploadConcurrency: positiveInteger(input.uploadConcurrency, `${name}.uploadConcurrency`, 1),
  };
}

function isPhasedSubject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value.statusField || value.documentField || value.namingField || value.stages));
}

/**
 * Validate one subject independently of the catalog envelope.  This is the
 * Bridge/Taskboard synchronization contract and deliberately accepts both the
 * existing single-trigger subject and the fixed three-stage extension.
 */
export function validateSubjectConfig(value) {
  const input = plainObject(value, "subject");
  if (!isPhasedSubject(input)) {
    const base = {
      baseToken: idString(input.baseToken, "subject.baseToken"),
      baseName: nonEmptyString(input.baseName ?? input.baseToken, "subject.baseName"),
    };
    return normalizeSubject(input, base, 0, { allowActiveSnapshot: true });
  }

  const baseToken = idString(input.baseToken, "subject.baseToken");
  const tableId = idString(input.tableId, "subject.tableId");
  const computedKey = subjectKey(baseToken, tableId);
  if (input.subjectKey !== undefined && input.subjectKey !== computedKey) {
    fail("subject.subjectKey does not match baseToken/tableId");
  }
  const statusField = normalizeStatusField(input.statusField);
  const execution = normalizeExecution(input.execution ?? {
    mode: input.mode ?? "manual",
    concurrencyGroup: "default",
    maxConcurrent: 1,
    resourceGroups: [],
  });
  const upload = normalizeUpload(input.upload ?? {
    enqueueMode: execution.enqueueMode ?? execution.mode,
    artifactSourceMode: "driver_report",
    uploadConcurrency: 1,
  });
  const lifecycle = input.lifecycle ?? "draft";
  if (!LIFECYCLES.has(lifecycle)) fail("subject.lifecycle is not supported");
  const normalized = {
    ...clone(input),
    subjectKey: computedKey,
    baseToken,
    baseName: nonEmptyString(input.baseName ?? baseToken, "subject.baseName"),
    tableId,
    tableName: nonEmptyString(input.tableName ?? input.name ?? tableId, "subject.tableName"),
    displayEnabled: booleanValue(input.displayEnabled, "subject.displayEnabled", true),
    lifecycle,
    configVersion: positiveInteger(input.configVersion, "subject.configVersion", 1),
    createdAt: timestamp(input.createdAt, "subject.createdAt"),
    updatedAt: timestamp(input.updatedAt, "subject.updatedAt"),
    ...(input.enabledAt !== undefined ? { enabledAt: timestamp(input.enabledAt, "subject.enabledAt") } : {}),
    ...(input.closedAt !== undefined ? { closedAt: timestamp(input.closedAt, "subject.closedAt") } : {}),
    trigger: input.trigger ? normalizeTrigger(input.trigger, "subject.trigger") : {
      fieldId: statusField.fieldId,
      fieldName: statusField.fieldName,
      startValue: STAGE_IDS.map((stageId) => input.stages?.[stageId])
        .find((stage) => stage?.enabled)?.trigger?.value ?? "phased",
      optionId: STAGE_IDS.map((stageId) => input.stages?.[stageId])
        .find((stage) => stage?.enabled)?.trigger?.optionId ?? null,
    },
    title: normalizeTitle(input.title),
    statusField,
    documentField: normalizeConfiguredField(input.documentField, "documentField", "docx"),
    namingField: normalizeConfiguredField(input.namingField, "namingField", input.namingField?.kind ?? "text"),
    stages: normalizeStages(input.stages, statusField),
    execution,
    packageRoute: normalizePackageRoute(input.packageRoute ?? { packageAlias: input.defaultPackageAlias }),
    upload,
    ...(input.delivery === undefined ? {} : { delivery: normalizeDeliveryConfig(input.delivery) }),
  };
  if (input.activeSnapshot !== undefined && input.activeSnapshot !== null) {
    normalized.activeSnapshot = validateSubjectConfig({
      ...input.activeSnapshot,
      lifecycle: "enabled",
      baseToken,
      tableId,
      baseName: input.activeSnapshot.baseName ?? normalized.baseName,
      tableName: input.activeSnapshot.tableName ?? normalized.tableName,
    });
  }
  return normalized;
}

/** Return a synchronized subject without machine-local artifact destinations. */
export function portableSubject(value) {
  const result = validateSubjectConfig(value);
  if (result.stages) {
    for (const stageId of STAGE_IDS) {
      if (result.stages[stageId]) delete result.stages[stageId].artifactTargetPath;
    }
  }
  if (result.upload) {
    result.upload.artifactSourcePath = null;
    result.upload.targetPath = null;
  }
  if (result.delivery) result.delivery.rootPath = null;
  if (result.activeSnapshot) result.activeSnapshot = portableSubject(result.activeSnapshot);
  return result;
}

export const stageSuffix = (stageId) => DEFAULT_STAGE_SUFFIXES[stageId] ?? "";

function normalizeSubject(value, base, index, { allowActiveSnapshot = true } = {}) {
  const input = plainObject(value, `bases[${index}].subjects[${index}]`);
  assertKnownKeys(input, SUBJECT_KEYS, `subject[${index}]`, { allowInternal: allowActiveSnapshot });
  if (isPhasedSubject(input)) {
    const phased = validateSubjectConfig({
      ...input,
      baseToken: input.baseToken ?? base.baseToken,
      baseName: input.baseName ?? base.baseName,
    });
    if (phased.baseToken !== base.baseToken) fail(`subject[${index}].baseToken does not match its Base`);
    return phased;
  }
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
    ...(input.delivery === undefined ? {} : { delivery: normalizeDeliveryConfig(input.delivery) }),
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
