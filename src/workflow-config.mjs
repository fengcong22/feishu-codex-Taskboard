import path from "node:path";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";

import { withStateLock } from "./state-lock.mjs";
import { SubjectVersionHistory } from "./subject-version-history.mjs";

/** The stage ids are part of the persisted cross-process contract. */
export const STAGE_IDS = Object.freeze(["initial", "first_review", "final_review"]);

const DEFAULT_SUFFIXES = Object.freeze({
  initial: "_初稿",
  first_review: "_初审修改",
  final_review: "_终审修改",
});

const SOURCE_KINDS = new Set(["docx_section", "base_attachment"]);
const AUDIO_MODES = new Set(["video_original", "replace_original"]);
const EXECUTION_MODES = new Set(["manual", "automatic"]);

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function text(value, name, { optional = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new Error(`${name} must be a non-empty string`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} contains control characters`);
  return value.trim();
}

function bool(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function identifier(value, name, { optional = false } = {}) {
  const result = text(value, name, { optional });
  if (result === null) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(result)) {
    throw new Error(`${name} must be an identifier`);
  }
  return result;
}

function absolute(value, name, { optional = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new Error(`${name} must be an absolute path`);
  }
  const result = text(value, name);
  // path.isAbsolute is platform-specific; retain the Windows form when a
  // portable config is validated on a different host.
  if (!path.isAbsolute(result) && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(result)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return path.isAbsolute(result) ? path.normalize(result) : result;
}

function optionId(option) {
  if (!option || typeof option !== "object" || Array.isArray(option)) return null;
  return option.optionId ?? option.option_id ?? option.id ?? null;
}

function optionValue(option) {
  if (!option || typeof option !== "object" || Array.isArray(option)) return null;
  return option.value ?? option.name ?? option.text ?? option.label ?? null;
}

function normalizeOptions(statusField) {
  const options = statusField.options ?? statusField.optionList ?? statusField.property?.options;
  if (!Array.isArray(options)) return [];
  return options.map((entry, index) => ({
    optionId: identifier(optionId(entry), `statusField.options[${index}].optionId`),
    value: text(optionValue(entry), `statusField.options[${index}].value`),
  }));
}

function normalizeSource(source, name, { allowBase = true } = {}) {
  object(source, name);
  const kind = text(source.kind ?? source.sourceKind, `${name}.kind`);
  if (!SOURCE_KINDS.has(kind) || (!allowBase && kind === "base_attachment")) {
    throw new Error(`${name}.kind is invalid`);
  }
  if (kind === "docx_section") {
    return { kind, anchorText: text(source.anchorText ?? source.anchor_text ?? source.title, `${name}.anchorText`) };
  }
  return { kind, fieldId: identifier(source.fieldId ?? source.field_id, `${name}.fieldId`) };
}

function normalizeAudio(audio, name) {
  object(audio, name);
  const mode = text(audio.mode ?? audio.soundMode ?? audio.sound_mode, `${name}.mode`);
  if (!AUDIO_MODES.has(mode)) throw new Error(`${name}.mode is invalid`);
  if (mode === "video_original") return { mode };
  if (!audio.source && !audio.audioSource) throw new Error(`${name} source is required`);
  const source = normalizeSource(audio.source ?? audio.audioSource, `${name}.source`);
  const tolerance = audio.durationToleranceSeconds === undefined && audio.duration_tolerance_seconds === undefined
    ? 3
    : Number(audio.durationToleranceSeconds ?? audio.duration_tolerance_seconds);
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error(`${name}.durationToleranceSeconds must be positive`);
  }
  return { mode, source, durationToleranceSeconds: tolerance };
}

/** Normalize one fixed stage without accepting any executable input. */
export function normalizeStage(stage, metadata = {}, stageId = "stage") {
  object(stage, stageId);
  const statusField = metadata.statusField ?? metadata;
  const enabled = stage.enabled === undefined ? false : bool(stage.enabled, `${stageId}.enabled`);
  const trigger = stage.trigger ?? {};
  const fieldId = trigger.fieldId ?? trigger.field_id;
  const optionIdValue = trigger.optionId ?? trigger.option_id;
  const triggerValue = trigger.value ?? trigger.startValue ?? trigger.start_value ?? trigger.label;
  const normalized = {
    enabled,
    trigger: {
      fieldId: identifier(fieldId, `${stageId}.trigger.fieldId`, { optional: !enabled }),
      fieldName: text(
        trigger.fieldName ?? trigger.field_name ?? statusField.fieldName ?? statusField.name,
        `${stageId}.trigger.fieldName`,
        { optional: !enabled },
      ),
      optionId: identifier(optionIdValue, `${stageId}.trigger.optionId`, { optional: !enabled }),
      value: text(triggerValue, `${stageId}.trigger.value`, { optional: !enabled }),
    },
    videoSource: normalizeSource(stage.videoSource ?? stage.video_source, `${stageId}.videoSource`),
    reviewSource: normalizeSource(stage.reviewSource ?? stage.review_source, `${stageId}.reviewSource`, { allowBase: false }),
    audio: normalizeAudio(stage.audio, `${stageId}.audio`),
    artifactTargetPath: absolute(
      stage.artifactTargetPath ?? stage.artifact_target_path,
      `${stageId}.artifactTargetPath`,
    ),
    nameSuffix: stage.nameSuffix === undefined && stage.name_suffix === undefined
      ? DEFAULT_SUFFIXES[stageId] ?? ""
      : text(stage.nameSuffix ?? stage.name_suffix, `${stageId}.nameSuffix`),
  };

  const statusFieldId = statusField?.fieldId ?? statusField?.field_id;
  if (statusFieldId && normalized.trigger.fieldId !== statusFieldId) {
    throw new Error(`${stageId}.trigger.fieldId must match statusField.fieldId`);
  }
  return normalized;
}

function normalizeStatusField(value) {
  object(value, "statusField");
  const fieldId = identifier(value.fieldId ?? value.field_id, "statusField.fieldId");
  const fieldName = text(value.fieldName ?? value.name, "statusField.fieldName");
  const rawType = value.type ?? value.uiType ?? value.ui_type ?? "single_select";
  const type = typeof rawType === "number" ? rawType : String(rawType).trim().toLowerCase().replace(/[\s_-]/gu, "");
  if (!(rawType === 3 || new Set(["singleselect", "singleoption", "select"]).has(type))) {
    throw new Error("statusField must be a single-select field");
  }
  const options = normalizeOptions(value);
  return { fieldId, fieldName, type: "single_select", ...(options.length ? { options } : {}) };
}

function normalizeField(value, name, { kind = null } = {}) {
  object(value, name);
  const fieldId = identifier(value.fieldId ?? value.field_id, `${name}.fieldId`);
  const fieldName = text(value.fieldName ?? value.name, `${name}.fieldName`);
  return { fieldId, fieldName, ...(kind ? { kind } : {}) };
}

function normalizeStages(stages, statusField) {
  object(stages, "stages");
  const unknown = Object.keys(stages).find((id) => !STAGE_IDS.includes(id));
  if (unknown) throw new Error(`stages.${unknown} is not supported`);
  const result = {};
  for (const stageId of STAGE_IDS) {
    if (!Object.hasOwn(stages, stageId)) throw new Error(`stages.${stageId} is required`);
    result[stageId] = normalizeStage(stages[stageId], { statusField }, stageId);
  }
  const enabled = STAGE_IDS.filter((id) => result[id].enabled);
  if (enabled.length === 0) throw new Error("at least one stage must be enabled");
  const optionIds = enabled.map((id) => result[id].trigger.optionId);
  if (new Set(optionIds).size !== optionIds.length) {
    throw new Error("enabled stage trigger options must be unique");
  }
  const knownOptions = new Map((statusField.options ?? []).map((entry) => [entry.optionId, entry.value]));
  for (const id of enabled) {
    const stage = result[id];
    if (knownOptions.size && !knownOptions.has(stage.trigger.optionId)) {
      throw new Error(`${id}.trigger.optionId is not present in statusField options`);
    }
    if (knownOptions.has(stage.trigger.optionId)
      && knownOptions.get(stage.trigger.optionId) !== stage.trigger.value) {
      throw new Error(`${id}.trigger.value does not match statusField option`);
    }
  }
  return result;
}

function normalizeExecution(value = {}) {
  object(value, "execution");
  const mode = text(value.mode ?? "manual", "execution.mode");
  if (!EXECUTION_MODES.has(mode)) throw new Error("execution.mode is invalid");
  const enqueueMode = text(value.enqueueMode ?? value.enqueue_mode ?? mode, "execution.enqueueMode");
  if (!EXECUTION_MODES.has(enqueueMode)) throw new Error("execution.enqueueMode is invalid");
  const maxConcurrent = value.maxConcurrent === undefined ? 1 : Number(value.maxConcurrent);
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("execution.maxConcurrent must be positive");
  const concurrencyGroup = identifier(value.concurrencyGroup ?? value.concurrency_group ?? "default", "execution.concurrencyGroup");
  const resourceGroups = value.resourceGroups ?? value.resource_groups ?? [];
  if (!Array.isArray(resourceGroups)) throw new Error("execution.resourceGroups must be an array");
  const normalizedGroups = resourceGroups.map((group, index) => identifier(group, `execution.resourceGroups[${index}]`));
  if (new Set(normalizedGroups).size !== normalizedGroups.length) throw new Error("execution.resourceGroups must be unique");
  return { mode, enqueueMode, concurrencyGroup, maxConcurrent, resourceGroups: normalizedGroups };
}

function normalizePackageRoute(value = {}) {
  object(value, "packageRoute");
  return {
    packageAlias: text(value.packageAlias ?? value.defaultPackageAlias, "packageRoute.packageAlias"),
    routeMode: text(value.routeMode ?? "fixed", "packageRoute.routeMode"),
    ...(value.subjectCodeFieldId ?? value.subject_code_field_id
      ? { subjectCodeFieldId: identifier(value.subjectCodeFieldId ?? value.subject_code_field_id, "packageRoute.subjectCodeFieldId") }
      : {}),
    ...(value.branchMap ? { branchMap: structuredClone(value.branchMap) } : {}),
  };
}

function normalizeUpload(value = {}, execution) {
  object(value, "upload");
  const enqueueMode = text(value.enqueueMode ?? execution.enqueueMode, "upload.enqueueMode");
  if (!EXECUTION_MODES.has(enqueueMode)) throw new Error("upload.enqueueMode is invalid");
  const artifactSourceMode = text(value.artifactSourceMode ?? value.artifact_source_mode ?? "driver_report", "upload.artifactSourceMode");
  if (!new Set(["driver_report", "manual_select", "watch_directory"]).has(artifactSourceMode)) {
    throw new Error("upload.artifactSourceMode is invalid");
  }
  const uploadConcurrency = value.uploadConcurrency === undefined
    ? (value.upload_concurrency === undefined ? 1 : Number(value.upload_concurrency))
    : Number(value.uploadConcurrency);
  if (!Number.isSafeInteger(uploadConcurrency) || uploadConcurrency < 1) {
    throw new Error("upload.uploadConcurrency must be positive");
  }
  return {
    enqueueMode,
    artifactSourceMode,
    ...(value.artifactSourcePath !== undefined || value.artifact_source_path !== undefined
      ? { artifactSourcePath: absolute(value.artifactSourcePath ?? value.artifact_source_path, "upload.artifactSourcePath") }
      : {}),
    ...(value.targetId !== undefined && value.targetId !== null ? { targetId: text(value.targetId, "upload.targetId") } : {}),
    ...(value.targetPath !== undefined && value.targetPath !== null && value.targetPath !== ""
      ? { targetPath: absolute(value.targetPath, "upload.targetPath") }
      : {}),
    uploadConcurrency,
  };
}

/** Validate and normalize the complete subject contract used by the Bridge. */
export function validateSubjectConfig(input) {
  object(input, "subject");
  if (!input.statusField && input.trigger) return normalizeLegacySubject(input);
  const statusField = normalizeStatusField(input.statusField);
  const documentField = normalizeField(input.documentField, "documentField", { kind: "docx" });
  const namingField = normalizeField(input.namingField, "namingField", { kind: input.namingField?.kind ?? "text" });
  const execution = normalizeExecution(input.execution);
  const packageRoute = normalizePackageRoute(input.packageRoute);
  const upload = normalizeUpload(input.upload, execution);
  const stages = normalizeStages(input.stages, statusField);
  return {
    ...input,
    ...(input.subjectKey ? { subjectKey: text(input.subjectKey, "subjectKey") } : {}),
    ...(input.baseToken ? { baseToken: text(input.baseToken, "baseToken") } : {}),
    ...(input.tableId ? { tableId: text(input.tableId, "tableId") } : {}),
    statusField,
    documentField,
    namingField,
    stages,
    execution,
    packageRoute,
    upload,
  };
}

/** Return the shareable form; local artifact/upload paths never cross the boundary. */
export function portableSubject(input) {
  const subject = validateSubjectConfig(input);
  const result = structuredClone(subject);
  if (result.stages && typeof result.stages === "object") {
    for (const stageId of STAGE_IDS) {
      if (result.stages[stageId] && typeof result.stages[stageId] === "object") {
        delete result.stages[stageId].artifactTargetPath;
      }
    }
  }
  if (result.upload) {
    delete result.upload.targetPath;
    delete result.upload.artifactSourcePath;
  }
  return result;
}

export const normalizeSubject = validateSubjectConfig;
export const stageSuffix = (stageId) => DEFAULT_SUFFIXES[stageId] ?? "";

function normalizeLegacySubject(input) {
  const trigger = object(input.trigger, "trigger");
  const execution = normalizeExecution({
    mode: input.execution?.mode ?? input.mode ?? "manual",
    enqueueMode: input.execution?.enqueueMode ?? input.upload?.enqueueMode ?? "manual",
    maxConcurrent: input.execution?.maxConcurrent ?? 1,
  });
  const packageRoute = normalizePackageRoute({
    packageAlias: input.packageRoute?.packageAlias ?? input.defaultPackageAlias,
    routeMode: input.packageRoute?.routeMode,
  });
  const upload = normalizeUpload(input.upload ?? {}, execution);
  return {
    ...input,
    ...(input.subjectKey ? { subjectKey: text(input.subjectKey, "subjectKey") } : {}),
    ...(input.baseToken ? { baseToken: text(input.baseToken, "baseToken") } : {}),
    ...(input.tableId ? { tableId: text(input.tableId, "tableId") } : {}),
    trigger: {
      fieldId: identifier(trigger.fieldId ?? trigger.field_id, "trigger.fieldId"),
      fieldName: text(trigger.fieldName ?? trigger.field_name, "trigger.fieldName"),
      startValue: text(trigger.startValue ?? trigger.value, "trigger.startValue"),
      optionId: trigger.optionId ?? trigger.option_id ?? null,
    },
    title: input.title ?? {
      fieldId: input.titleFieldId ?? null,
      fieldName: input.titleField ?? null,
    },
    execution,
    packageRoute,
    upload,
    lifecycle: input.lifecycle ?? "draft",
    configVersion: Number.isSafeInteger(input.configVersion) && input.configVersion > 0 ? input.configVersion : 1,
  };
}

export function subjectKey(baseToken, tableId) {
  return `${text(baseToken, "baseToken")}:${text(tableId, "tableId")}`;
}

/** Validate the catalog envelope used by the Taskboard sync API. */
export function validateWorkflowConfig(input) {
  object(input, "workflowConfig");
  const bases = Array.isArray(input.bases) ? input.bases : [];
  const normalizedBases = bases.map((base, baseIndex) => {
    object(base, `bases[${baseIndex}]`);
    const baseToken = text(base.baseToken, `bases[${baseIndex}].baseToken`);
    const baseName = text(base.baseName ?? base.name ?? baseToken, `bases[${baseIndex}].baseName`);
    const subjects = Array.isArray(base.subjects) ? base.subjects : [];
    return {
      ...base,
      baseToken,
      baseName,
      subjects: subjects.map((entry, index) => {
        const subject = { ...entry, baseToken: entry.baseToken ?? baseToken };
        subject.tableId = text(subject.tableId, `bases[${baseIndex}].subjects[${index}].tableId`);
        subject.subjectKey = subject.subjectKey ?? subjectKey(baseToken, subject.tableId);
        if (subject.statusField || subject.stages || subject.trigger) return validateSubjectConfig(subject);
        return subject;
      }),
    };
  });
  return {
    schemaVersion: Number.isSafeInteger(input.schemaVersion) ? input.schemaVersion : 1,
    configVersion: Number.isSafeInteger(input.configVersion) ? input.configVersion : 1,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null,
    bases: normalizedBases,
  };
}

export function activeTables(config) {
  const normalized = validateWorkflowConfig(config);
  return normalized.bases.flatMap((base) => base.subjects.flatMap((subject) => {
    if (subject.lifecycle === "enabled") return [structuredClone(subject)];
    if (subject.activeSnapshot) return [structuredClone(subject.activeSnapshot)];
    return [];
  }));
}

async function atomicJsonWrite(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

/** A small durable catalog store used by Bridge's workflow sync endpoint. */
export function createWorkflowConfigStore({ filename, initial = { schemaVersion: 1, configVersion: 1, bases: [] }, now = () => Date.now(), packageAliases = null } = {}) {
  if (typeof filename !== "string" || filename.trim() === "") throw new Error("workflow config filename is required");
  const resolved = path.resolve(filename);
  const history = new SubjectVersionHistory(`${resolved}.versions.json`, { now });
  async function read() {
    try { return validateWorkflowConfig(JSON.parse(await readFile(resolved, "utf8"))); }
    catch (error) { if (error?.code === "ENOENT") return validateWorkflowConfig(initial); throw error; }
  }
  async function write(value) { return atomicJsonWrite(resolved, validateWorkflowConfig(value)); }
  async function mutate(operation) {
    return withStateLock(resolved, async () => {
      const current = await read();
      const next = await operation(current);
      await write(next);
      return structuredClone(next);
    });
  }
  function locate(config, key) {
    for (const base of config.bases) {
      const subject = base.subjects.find((entry) => entry.subjectKey === key);
      if (subject) return { base, subject };
    }
    return null;
  }
  async function syncSubject(input, options = {}) {
    const subject = validateSubjectConfig({ ...input, lifecycle: options.lifecycle ?? input.lifecycle ?? "enabled" });
    if (!subject.subjectKey) subject.subjectKey = subjectKey(subject.baseToken, subject.tableId);
    const current = await read();
    const existing = locate(current, subject.subjectKey)?.subject ?? null;
    if (options.expectedVersion !== undefined && existing
      && (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion !== existing.configVersion)) {
      const error = new Error("workflow subject version conflict");
      error.code = "VERSION_CONFLICT";
      error.status = 409;
      throw error;
    }
    if (packageAliases) {
      const alias = subject.packageRoute?.packageAlias;
      const allowed = typeof packageAliases === "function" ? await packageAliases(alias) : Array.isArray(packageAliases) ? packageAliases.includes(alias) : Object.hasOwn(packageAliases, alias);
      if (!allowed && subject.lifecycle === "enabled") {
        const error = new Error("workflow package alias is not locally configured"); error.code = "WORKFLOW_PACKAGE_ALIAS_UNBOUND"; error.status = 409; throw error;
      }
    }
    const version = subject.configVersion ?? 1;
    subject.enabledAt = subject.enabledAt ?? now();
    const portable = portableSubject(subject);
    await history.syncSubject(portable);
    await mutate((config) => {
      const locked = locate(config, portable.subjectKey)?.subject ?? null;
      if (options.expectedVersion !== undefined && locked
        && (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion !== locked.configVersion)) {
        const error = new Error("workflow subject version conflict");
        error.code = "VERSION_CONFLICT";
        error.status = 409;
        throw error;
      }
      let base = config.bases.find((candidate) => candidate.baseToken === portable.baseToken);
      if (!base) { base = { baseToken: portable.baseToken, baseName: portable.baseName ?? portable.baseToken, subjects: [] }; config.bases.push(base); }
      const index = base.subjects.findIndex((candidate) => candidate.subjectKey === portable.subjectKey);
      if (index >= 0) base.subjects[index] = { ...base.subjects[index], ...structuredClone(portable) };
      else base.subjects.push(structuredClone(portable));
      config.configVersion = Math.max(config.configVersion ?? 1, version);
      config.updatedAt = now();
      return config;
    });
    return structuredClone(portable);
  }
  async function getSubjectVersion(keyValue, version) { return history.getSubjectVersion(keyValue, version); }
  async function resolveSubjectVersionAt(keyValue, occurredAt) { return history.resolveSubjectVersionAt(keyValue, occurredAt); }
  async function active() { return activeTables(await read()); }
  async function exportShareable() { const config = await read(); return structuredClone(config); }
  return {
    filename: resolved,
    read,
    write,
    syncSubject,
    getSubjectVersion,
    resolveSubjectVersionAt,
    activeTables: active,
    exportShareable,
    history,
    hasPersistedConfig: async () => { try { await readFile(resolved); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } },
    locateSubject: async (keyValue) => locate(await read(), keyValue)?.subject ?? null,
  };
}
