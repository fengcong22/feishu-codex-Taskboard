const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

export const STAGE_IDS = Object.freeze(["initial", "first_review", "final_review"]);

const STAGE_KEYS = new Set([
  "enabled",
  "trigger",
  "videoSource",
  "video_source",
  "reviewSource",
  "review_source",
  "audio",
  "artifactTargetPath",
  "artifact_target_path",
  "nameSuffix",
  "name_suffix",
]);
const TRIGGER_KEYS = new Set([
  "fieldId",
  "field_id",
  "fieldName",
  "field_name",
  "optionId",
  "option_id",
  "value",
  "startValue",
  "start_value",
]);
const SOURCE_KEYS = new Set(["kind", "anchorText", "anchor_text", "fieldId", "field_id"]);
const AUDIO_KEYS = new Set([
  "mode",
  "source",
  "durationToleranceSeconds",
  "duration_tolerance_seconds",
]);
const FIELD_DESCRIPTOR_KEYS = new Set(["fieldId", "field_id", "fieldName", "field_name"]);
const SINGLE_SELECT_UI_TYPES = new Set(["singleselect", "select"]);
const ATTACHMENT_UI_TYPES = new Set(["attachment", "attachments"]);

function fail(message, code = "INVALID_FIELD") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value, name, { optional = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (optional) return null;
    throw fail(`${name} is required`);
  }
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw fail(`${name} is invalid`);
  }
  return value.trim();
}

function identifier(value, name, { optional = false } = {}) {
  const result = text(value, name, { optional });
  if (result === null) return null;
  if (!IDENTIFIER.test(result)) throw fail(`${name} is invalid`);
  return result;
}

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(`${name} must be an object`);
  return value;
}

function assertKnownKeys(value, allowed, name) {
  plainObject(value, name);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw fail(`${name}.${unknown} is not supported`, "UNKNOWN_FIELD");
}

function aliasValue(value, canonicalKey, aliases, name) {
  const present = [canonicalKey, ...aliases].filter((key) => Object.hasOwn(value, key));
  if (present.length > 1) {
    throw fail(`${name}.${canonicalKey} has multiple representations`, "INVALID_FIELD");
  }
  return present.length === 0 ? undefined : value[present[0]];
}

function canonicalizeObject(value, allowed, aliases, name) {
  assertKnownKeys(value, allowed, name);
  const result = {};
  const aliasKeys = new Set(Object.values(aliases).flat());
  for (const [key, entry] of Object.entries(value)) {
    if (!aliasKeys.has(key)) result[key] = entry;
  }
  for (const [canonicalKey, alternateKeys] of Object.entries(aliases)) {
    const entry = aliasValue(value, canonicalKey, alternateKeys, name);
    if (entry !== undefined || [canonicalKey, ...alternateKeys].some((key) => Object.hasOwn(value, key))) {
      result[canonicalKey] = entry;
    }
  }
  return result;
}

function canonicalizeSource(source, name) {
  return canonicalizeObject(source, SOURCE_KEYS, {
    anchorText: ["anchor_text"],
    fieldId: ["field_id"],
  }, name);
}

function canonicalizeTrigger(trigger, name) {
  return canonicalizeObject(trigger, TRIGGER_KEYS, {
    fieldId: ["field_id"],
    fieldName: ["field_name"],
    optionId: ["option_id"],
    value: ["startValue", "start_value"],
  }, name);
}

function canonicalizeAudio(audio, name) {
  const result = canonicalizeObject(audio, AUDIO_KEYS, {
    durationToleranceSeconds: ["duration_tolerance_seconds"],
  }, name);
  if (Object.hasOwn(result, "source") && result.source !== null && result.source !== undefined) {
    result.source = canonicalizeSource(result.source, `${name}.source`);
  }
  return result;
}

function canonicalizeStage(stage, stageId) {
  const name = `stages.${stageId}`;
  const result = canonicalizeObject(stage, STAGE_KEYS, {
    videoSource: ["video_source"],
    reviewSource: ["review_source"],
    artifactTargetPath: ["artifact_target_path"],
    nameSuffix: ["name_suffix"],
  }, name);
  if (Object.hasOwn(result, "trigger") && result.trigger !== null && result.trigger !== undefined) {
    result.trigger = canonicalizeTrigger(result.trigger, `${name}.trigger`);
  }
  if (Object.hasOwn(result, "videoSource") && result.videoSource !== null && result.videoSource !== undefined) {
    result.videoSource = canonicalizeSource(result.videoSource, `${name}.videoSource`);
  }
  if (Object.hasOwn(result, "reviewSource") && result.reviewSource !== null && result.reviewSource !== undefined) {
    result.reviewSource = canonicalizeSource(result.reviewSource, `${name}.reviewSource`);
  }
  if (Object.hasOwn(result, "audio") && result.audio !== null && result.audio !== undefined) {
    result.audio = canonicalizeAudio(result.audio, `${name}.audio`);
  }
  return result;
}

function canonicalizeFieldDescriptor(descriptor, name) {
  return canonicalizeObject(descriptor, FIELD_DESCRIPTOR_KEYS, {
    fieldId: ["field_id"],
    fieldName: ["field_name"],
  }, name);
}

export function canonicalizePhasedSubjectPatch(value) {
  plainObject(value, "Subject patch");
  const result = { ...value };
  for (const fieldNameValue of ["statusField", "documentField", "namingField"]) {
    if (Object.hasOwn(result, fieldNameValue)) {
      result[fieldNameValue] = canonicalizeFieldDescriptor(result[fieldNameValue], fieldNameValue);
    }
  }
  if (Object.hasOwn(result, "stages")) {
    const stages = plainObject(result.stages, "stages");
    const unknownStage = Object.keys(stages).find((key) => !STAGE_IDS.includes(key));
    if (unknownStage) throw fail(`Unknown stage '${unknownStage}'`);
    result.stages = Object.fromEntries(Object.entries(stages).map(([stageId, stage]) => (
      [stageId, canonicalizeStage(stage, stageId)]
    )));
  }
  return result;
}

function fieldId(field) {
  return field?.fieldId ?? field?.id ?? null;
}

function fieldName(field) {
  return field?.fieldName ?? field?.name ?? null;
}

function metadataFields(metadata) {
  if (Array.isArray(metadata)) return metadata;
  return Array.isArray(metadata?.fields) ? metadata.fields : [];
}

function metadataField(metadata, id) {
  return metadataFields(metadata).find((field) => fieldId(field) === id) ?? null;
}

function hasKnownMetadata(metadata) {
  return Array.isArray(metadata) || Array.isArray(metadata?.fields);
}

function metadataFieldMatches(metadata, id) {
  return metadataFields(metadata).filter((field) => fieldId(field) === id);
}

function normalizedType(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) return Number(value.trim());
  return null;
}

function normalizedUiType(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim().toLowerCase().replace(/[\s_-]/gu, "");
}

function strictMetadataType(field, expectedType, expectedUiTypes) {
  if (!field || typeof field !== "object" || Array.isArray(field)) return false;
  const hasType = field.type !== null && field.type !== undefined && field.type !== "";
  const hasUiType = field.uiType !== null && field.uiType !== undefined && field.uiType !== "";
  if (!hasType && !hasUiType) return false;
  if (hasType && normalizedType(field.type) !== expectedType) return false;
  if (hasUiType && !expectedUiTypes.has(normalizedUiType(field.uiType))) return false;
  return true;
}

export function isSingleSelectMetadataField(field) {
  return strictMetadataType(field, 3, SINGLE_SELECT_UI_TYPES);
}

export function isAttachmentMetadataField(field) {
  return strictMetadataType(field, 17, ATTACHMENT_UI_TYPES);
}

function normalizeSource(source, metadata, name, { review = false } = {}) {
  source = canonicalizeSource(source, name);
  const kind = text(source.kind, `${name}.kind`);
  if (kind === "docx_section") {
    const anchorText = text(source.anchorText ?? source.anchor_text, `${name}.anchorText`);
    return { kind, anchorText };
  }
  if (kind === "base_attachment" && !review) {
    const fieldIdValue = identifier(source.fieldId ?? source.field_id, `${name}.fieldId`);
    return { kind, fieldId: fieldIdValue };
  }
  throw fail(`${name}.kind is invalid`);
}

function normalizeAudio(audio, metadata, name) {
  audio = canonicalizeAudio(audio, name);
  const mode = text(audio.mode, `${name}.mode`);
  if (mode === "video_original") {
    if (audio.source && typeof audio.source === "object" && !Array.isArray(audio.source)) {
      assertKnownKeys(audio.source, SOURCE_KEYS, `${name}.source`);
    }
    return { mode };
  }
  if (mode !== "replace_original") throw fail(`${name}.mode is invalid`);
  if (audio.source === null || audio.source === undefined) throw fail(`${name} audio source is required`);
  const source = normalizeSource(audio.source, metadata, `${name}.source`);
  const tolerance = audio.durationToleranceSeconds ?? audio.duration_tolerance_seconds ?? 3;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance <= 0) {
    throw fail(`${name}.durationToleranceSeconds must be positive`);
  }
  return {
    mode,
    source,
    durationToleranceSeconds: tolerance,
  };
}

/**
 * Normalize one of the fixed stage entries. The function is deliberately
 * independent from the database so Bridge and Taskboard can share the same
 * field/source contract without importing either application's internals.
 */
export function normalizeStage(stage, metadata = null, stageId = "stage") {
  if (!STAGE_IDS.includes(stageId)) throw fail(`Unknown stage '${stageId}'`);
  stage = canonicalizeStage(stage, stageId);
  const enabled = stage.enabled === undefined ? false : stage.enabled;
  if (typeof enabled !== "boolean") throw fail(`stages.${stageId}.enabled must be boolean`);

  const triggerInput = canonicalizeTrigger(stage.trigger ?? {}, `stages.${stageId}.trigger`);
  const triggerFieldId = identifier(triggerInput.fieldId ?? triggerInput.field_id, `stages.${stageId}.trigger.fieldId`, { optional: !enabled });
  const optionId = identifier(triggerInput.optionId ?? triggerInput.option_id, `stages.${stageId}.trigger.optionId`, { optional: !enabled });
  const value = text(
    triggerInput.value ?? triggerInput.startValue ?? triggerInput.start_value,
    `stages.${stageId}.trigger.value`,
    { optional: !enabled },
  );
  const statusField = metadataField(metadata, triggerFieldId);
  const fieldNameValue = text(
    triggerInput.fieldName ?? triggerInput.field_name ?? fieldName(statusField),
    `stages.${stageId}.trigger.fieldName`,
    { optional: !enabled },
  );

  const videoSource = normalizeSource(stage.videoSource ?? stage.video_source, metadata, `stages.${stageId}.videoSource`);
  const reviewSource = normalizeSource(stage.reviewSource ?? stage.review_source, metadata, `stages.${stageId}.reviewSource`, { review: true });
  const audio = normalizeAudio(stage.audio, metadata, `stages.${stageId}.audio`);
  const artifactTargetPath = text(
    stage.artifactTargetPath ?? stage.artifact_target_path,
    `stages.${stageId}.artifactTargetPath`,
    { optional: true },
  );
  if (artifactTargetPath !== null && !ABSOLUTE_PATH.test(artifactTargetPath)) {
    throw fail(`stages.${stageId}.artifactTargetPath must be absolute`);
  }
  const nameSuffix = text(stage.nameSuffix ?? stage.name_suffix, `stages.${stageId}.nameSuffix`);

  return {
    enabled,
    trigger: {
      fieldId: triggerFieldId,
      fieldName: fieldNameValue,
      optionId,
      value,
    },
    videoSource,
    reviewSource,
    audio,
    artifactTargetPath,
    nameSuffix,
  };
}

function validateMetadataField(metadata, descriptor, name, predicate = null, { required = true } = {}) {
  descriptor = canonicalizeFieldDescriptor(descriptor, name);
  const id = identifier(descriptor?.fieldId ?? descriptor?.field_id, `${name}.fieldId`, { optional: !required });
  const configuredName = text(descriptor?.fieldName ?? descriptor?.field_name, `${name}.fieldName`, { optional: !required });
  if (id === null) return { fieldId: null, fieldName: null };
  const field = metadataField(metadata, id);
  const matches = metadataFieldMatches(metadata, id);
  if (matches.length > 1) throw fail(`${name}.fieldId is not unique in metadata`, "FIELD_NOT_UNIQUE");
  if (hasKnownMetadata(metadata) && !field) throw fail(`${name}.fieldId is not present in metadata`, "FIELD_NOT_FOUND");
  if (field && predicate && !predicate(field)) throw fail(`${name}.fieldId has an incompatible type`, "FIELD_TYPE_INVALID");
  return { fieldId: id, fieldName: configuredName ?? text(fieldName(field), `${name}.fieldName`) };
}

/**
 * Assert that every configured staged Base attachment source still resolves to
 * an Attachment field in a known metadata snapshot. Structural normalization
 * intentionally does not call this helper so a stale binding can be retained
 * and repaired in the editor after metadata refresh.
 *
 * When metadata is unavailable (no `fields` array), callers may leave the
 * default `requireMetadata: false` to defer validation. An explicit empty
 * fields array is considered known metadata and therefore rejects bindings.
 */
export function assertPhasedAttachmentBindings(value, metadata = value?.metadata, { requireMetadata = false } = {}) {
  const fields = Array.isArray(metadata)
    ? metadata
    : (metadata && Array.isArray(metadata.fields) ? metadata.fields : null);
  if (!fields) {
    if (requireMetadata) throw fail("Attachment field metadata is unavailable", "METADATA_UNAVAILABLE");
    return true;
  }
  const resolve = (source, path) => {
    if (!source || source.kind !== "base_attachment") return;
    const matches = fields.filter((candidate) => fieldId(candidate) === source.fieldId);
    if (matches.length === 0) {
      const error = fail(`${path} is not present in metadata`, "FIELD_NOT_FOUND");
      error.path = path;
      throw error;
    }
    if (matches.length > 1) {
      const error = fail(`${path} is not unique in metadata`, "FIELD_NOT_UNIQUE");
      error.path = path;
      throw error;
    }
    const field = matches[0];
    if (!isAttachmentMetadataField(field)) {
      const error = fail(`${path} must identify an attachment field`, "FIELD_TYPE_INVALID");
      error.path = path;
      throw error;
    }
  };

  for (const stageId of STAGE_IDS) {
    const stage = value?.stages?.[stageId];
    if (!stage) continue;
    resolve(stage.videoSource ?? stage.video_source, `stages.${stageId}.videoSource.fieldId`);
    const audio = stage.audio;
    if (audio?.mode === "replace_original") {
      resolve(audio.source, `stages.${stageId}.audio.source.fieldId`);
    }
  }
  return true;
}

/**
 * Validate and normalize the phased subject portion of a workflow subject.
 * The caller decides whether the subject is a legacy single-trigger subject;
 * this function is only required when staged fields are present.
 */
export function validatePhasedSubjectConfig(value) {
  plainObject(value, "Subject configuration");
  const metadata = value.metadata ?? null;
  const statusField = validateMetadataField(metadata, value.statusField, "statusField", isSingleSelectMetadataField);
  if (!statusField.fieldId) throw fail("statusField is required");
  const documentField = validateMetadataField(metadata, value.documentField, "documentField", null);
  if (!documentField.fieldId) throw fail("documentField is required");
  const namingField = validateMetadataField(metadata, value.namingField, "namingField", null);
  if (!namingField.fieldId) throw fail("namingField is required");
  const stagesValue = plainObject(value.stages, "stages");
  const unknownStage = Object.keys(stagesValue).find((key) => !STAGE_IDS.includes(key));
  if (unknownStage) throw fail(`Unknown stage '${unknownStage}'`);
  const stages = {};
  for (const stageId of STAGE_IDS) {
    stages[stageId] = normalizeStage(stagesValue[stageId], metadata, stageId);
    if (stages[stageId].trigger.fieldId !== null && stages[stageId].trigger.fieldId !== statusField.fieldId) {
      throw fail(`stages.${stageId}.trigger.fieldId must match statusField.fieldId`);
    }
    if (stages[stageId].enabled && stages[stageId].trigger.optionId === null) {
      throw fail(`stages.${stageId}.trigger.optionId is required`);
    }
  }
  const enabled = STAGE_IDS.filter((stageId) => stages[stageId].enabled);
  if (enabled.length === 0) throw fail("at least one stage must be enabled");
  const optionIds = enabled.map((stageId) => stages[stageId].trigger.optionId);
  if (new Set(optionIds).size !== optionIds.length) throw fail("enabled stage trigger options must be unique");
  const field = metadataField(metadata, statusField.fieldId);
  const statusFieldMatches = metadataFieldMatches(metadata, statusField.fieldId);
  if (statusFieldMatches.length > 1) {
    throw fail("statusField.fieldId is not unique in metadata", "FIELD_NOT_UNIQUE");
  }
  if (field && !Array.isArray(field.options)) {
    throw fail("status field options are unavailable in metadata", "TRIGGER_OPTION_NOT_FOUND");
  }
  if (field && Array.isArray(field.options)) {
    for (const stageId of enabled) {
      const matches = field.options.filter((candidate) => candidate?.id === stages[stageId].trigger.optionId);
      if (matches.length === 0) throw fail(`stages.${stageId}.trigger.optionId is not present in metadata`, "TRIGGER_OPTION_NOT_FOUND");
      if (matches.length > 1) throw fail(`stages.${stageId}.trigger.optionId is not unique in metadata`, "TRIGGER_OPTION_NOT_UNIQUE");
      const option = matches[0];
      if (option.name !== stages[stageId].trigger.value) {
        throw fail(`stages.${stageId}.trigger.value does not match metadata`, "TRIGGER_OPTION_NOT_FOUND");
      }
    }
  }
  return {
    ...value,
    statusField,
    documentField,
    namingField,
    stages,
  };
}

export function isPhasedSubject(value) {
  return Boolean(value && typeof value === "object" && (value.stages || value.statusField || value.documentField || value.namingField));
}

export function portablePhasedSubject(value) {
  if (!isPhasedSubject(value)) return value;
  const normalized = validatePhasedSubjectConfig(value);
  return {
    ...normalized,
    stages: Object.fromEntries(STAGE_IDS.map((stageId) => [
      stageId,
      { ...normalized.stages[stageId], artifactTargetPath: null },
    ])),
  };
}
