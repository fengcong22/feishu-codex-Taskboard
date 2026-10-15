import { createHash } from "node:crypto";

import { ApiError } from "./database.mjs";
import { normalizeVmPackageWorkflowConfig } from "./feishu-package-workflow-drafts.mjs";
import { validateSubjectConfig as validateBridgeSubject } from "../../src/workflow-config.mjs";
import {
  normalizeDeliveryConfig,
  validateDeliveryConfig,
} from "../shared/feishu-delivery-config.mjs";
import {
  STAGE_IDS,
  assertPhasedAttachmentBindings,
  canonicalizePhasedSubjectPatch,
  isAttachmentMetadataField,
  isPhasedSubject,
  isSingleSelectMetadataField,
  normalizeStage,
  normalizePhasedDraftBindings,
  portablePhasedSubject,
  validatePhasedSubjectConfig,
} from "./feishu-workflow-stages.mjs";

export {
  STAGE_IDS,
  assertPhasedAttachmentBindings,
  normalizeStage,
  validatePhasedSubjectConfig,
} from "./feishu-workflow-stages.mjs";

const now = () => new Date().toISOString();
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const TARGET_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,255}$/u;
const LIFECYCLES = new Set(["draft", "enabled", "disabled"]);
const EXECUTION_MODES = new Set(["manual", "automatic"]);
const ARTIFACT_SOURCE_MODES = new Set(["manual_select", "watch_directory", "driver_report"]);
const SUBJECT_PROJECT_HASH_LENGTH = 16;
export const WORKFLOW_SCHEMA_VERSION = 1;
const PENDING_IDENTIFIERS = new Set([
  "pending",
  "pending_status_field",
  "pending_review_status_field",
  "pending_document_field",
  "pending_naming_field",
  "pending_initial_option",
  "pending_first_review_option",
  "pending_final_review_option",
  "pending_attachment_field",
]);

const PENDING_STAGE_OPTION_IDS = Object.freeze({
  initial: "pending_initial_option",
  first_review: "pending_first_review_option",
  final_review: "pending_final_review_option",
});

const DEFAULT_STAGE_SUFFIXES = Object.freeze(["_初稿", "_初审修改", "_终审修改"]);
const VM_WORKFLOW_TEMPLATE = Object.freeze({ id: "vm_pmo_review_video", version: 1 });

function isVmSubject(subject) {
  return subject?.workflowTemplate?.id === VM_WORKFLOW_TEMPLATE.id || subject?.vmWorkflow !== undefined;
}

function validateVmSubject(value) {
  const { metadata, projectId, ...bridge } = value;
  if (projectId !== subjectProjectId(value.subjectKey)) throw new ApiError(400, "INVALID_FIELD", "Subject project identity is invalid");
  for (const key of ["createdAt", "updatedAt", "enabledAt", "closedAt"]) {
    if (typeof bridge[key] === "string") bridge[key] = Date.parse(bridge[key]);
  }
  try { return { ...validateBridgeSubject(bridge), projectId, metadata }; }
  catch (error) { throw new ApiError(400, error.code ?? "INVALID_FIELD", "VM subject configuration is invalid"); }
}

function metadataFieldId(field) {
  return field?.fieldId ?? field?.id ?? null;
}

function metadataFieldName(field) {
  return field?.fieldName ?? field?.name ?? null;
}

function isCourseNamingMetadataField(field) {
  const type = typeof field?.type === "string" ? Number(field.type) : field?.type;
  const uiType = typeof field?.uiType === "string"
    ? field.uiType.replace(/[\s_-]/gu, "").toLowerCase()
    : null;
  return (type === 1 && (uiType === null || uiType === "text"))
    || (type === 20 && (uiType === null || uiType === "formula"));
}

function validIdentifier(value) {
  return typeof value === "string" && ID_PATTERN.test(value.trim()) ? value.trim() : null;
}

function validRequiredText(value) {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\0")
    ? value.trim()
    : null;
}

function metadataDescriptor(field, fallbackId, fallbackName = "待配置") {
  const fieldId = validIdentifier(metadataFieldId(field)) ?? fallbackId;
  const fieldName = typeof metadataFieldName(field) === "string" && metadataFieldName(field).trim() !== ""
    ? metadataFieldName(field).trim()
    : fallbackName;
  return { fieldId, fieldName };
}

function metadataOption(field, index) {
  const option = Array.isArray(field?.options) ? field.options[index] : null;
  const optionId = validIdentifier(option?.id);
  const optionName = typeof option?.name === "string" && option.name.trim() !== ""
    ? option.name.trim()
    : null;
  return optionId && optionName ? { id: optionId, name: optionName } : null;
}

function metadataOptionName(option) {
  return option?.name ?? option?.optionName ?? null;
}

function isPendingIdentifier(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return PENDING_IDENTIFIERS.has(normalized);
}

function isPendingPhasedDefaults(subject) {
  return [subject?.statusField, subject?.reviewStatusField, subject?.documentField, subject?.namingField]
    .some((field) => isPendingIdentifier(field?.fieldId))
    || isPendingIdentifier(subject?.trigger?.fieldId)
    || isPendingIdentifier(subject?.trigger?.optionId)
    || STAGE_IDS.some((stageId) => (
      isPendingIdentifier(subject?.stages?.[stageId]?.trigger?.fieldId)
      || isPendingIdentifier(subject?.stages?.[stageId]?.trigger?.optionId)
  ));
}

function hasUsableStageTrigger(stage, expectedFieldId = null) {
  const trigger = stage?.trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return false;
  const fieldId = validIdentifier(trigger.fieldId ?? trigger.field_id);
  const optionId = validIdentifier(trigger.optionId ?? trigger.option_id);
  const fieldName = validRequiredText(trigger.fieldName ?? trigger.field_name);
  const value = validRequiredText(trigger.value ?? trigger.startValue ?? trigger.start_value);
  return Boolean(
    fieldId
    && optionId
    && fieldName
    && value
    && !isPendingIdentifier(fieldId)
    && !isPendingIdentifier(optionId)
    && (!expectedFieldId || fieldId === expectedFieldId),
  );
}

function hasTriggerIntent(trigger) {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return false;
  const fieldId = validIdentifier(trigger.fieldId ?? trigger.field_id);
  const fieldName = validRequiredText(trigger.fieldName ?? trigger.field_name);
  const value = validRequiredText(trigger.value ?? trigger.startValue ?? trigger.start_value);
  const rawOptionId = trigger.optionId ?? trigger.option_id;
  const optionMissing = rawOptionId === undefined || rawOptionId === null || rawOptionId === "";
  const optionId = optionMissing ? null : validIdentifier(rawOptionId);
  return Boolean(
    fieldId
    && fieldName
    && value
    && !isPendingIdentifier(fieldId)
    && !isPendingIdentifier(value)
    && (optionMissing || (optionId && !isPendingIdentifier(optionId))),
  );
}

function repairStageDefaults(defaultStage, existingStage, stageId) {
  const source = existingStage && typeof existingStage === "object" && !Array.isArray(existingStage)
    ? existingStage
    : {};
  const aliases = {
    videoSource: "video_source",
    reviewSource: "review_source",
    artifactTargetPath: "artifact_target_path",
    nameSuffix: "name_suffix",
  };
  let repaired = clone(defaultStage);
  for (const key of [
    "enabled",
    "trigger",
    "videoSource",
    "reviewSource",
    "audio",
    "artifactTargetPath",
    "nameSuffix",
  ]) {
    const sourceKey = Object.hasOwn(source, key)
      ? key
      : aliases[key] && Object.hasOwn(source, aliases[key])
        ? aliases[key]
        : null;
    if (!sourceKey) continue;
    const value = clone(source[sourceKey]);
    // Placeholders are intentionally replaced by the metadata-derived default
    // when a later refresh supplies real field/option identifiers.
    if (key === "trigger") {
      const triggerFieldId = value?.fieldId ?? value?.field_id;
      // A pending field means the table was first discovered without usable
      // metadata, so a later refresh may bind it from the new metadata.  A
      // pending option on an otherwise still-selected field is different: it
      // records a deleted or renamed Feishu option and must stay empty until
      // the operator chooses an option again.
      if (isPendingIdentifier(triggerFieldId) || triggerFieldId !== defaultStage.trigger.fieldId) continue;
    }
    const candidate = { ...repaired, [key]: value };
    try {
      const normalized = normalizeStage(candidate, null, stageId);
      repaired = normalized;
    } catch {
      // Keep the default for this malformed property while allowing other
      // valid custom properties from the same partially persisted stage to
      // survive the repair.
    }
  }
  return repaired;
}

function ensureAtLeastOneEnabledStage(stages, defaultStages) {
  if (STAGE_IDS.some((stageId) => stages[stageId]?.enabled)) return stages;
  const current = stages.initial && typeof stages.initial === "object" && !Array.isArray(stages.initial)
    ? stages.initial
    : {};
  try {
    stages.initial = normalizeStage({ ...current, enabled: true }, null, "initial");
  } catch {
    // A malformed disabled initial stage must not prevent the table from
    // opening. Fall back to the metadata-derived default, which always has a
    // repairable trigger placeholder when no option is available yet.
    stages.initial = normalizeStage({ ...defaultStages.initial, enabled: true }, null, "initial");
  }
  return stages;
}

function projectLegacyUploadTarget(stages, upload) {
  const targetPath = typeof upload?.targetPath === "string"
    && upload.targetPath.trim() !== ""
    ? upload.targetPath
    : null;
  if (!targetPath) return stages;
  return Object.fromEntries(STAGE_IDS.map((stageId) => {
    const stage = stages[stageId];
    return [stageId, stage?.enabled && !stage.artifactTargetPath
      ? { ...stage, artifactTargetPath: targetPath }
      : stage];
  }));
}

function hasCompletePhasedConfig(subject) {
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) return false;
  // Presence checks alone are insufficient here: a persisted object can have
  // every expected key while carrying null/empty values.  Validate the phased
  // portion against an unknown metadata snapshot so stale field bindings are
  // still considered structurally complete, but malformed values force the
  // repair/default path during the next refresh.
  try {
    validatePhasedSubjectConfig({ ...subject, metadata: null });
    return true;
  } catch {
    return false;
  }
}

function phasedDefaultsForSubject({
  subjectKey,
  baseToken,
  baseName,
  tableId,
  tableName,
  projectId,
  metadata,
  previousMetadata = null,
  existing = null,
  lifecycle = "draft",
  configVersion,
  createdAt,
  updatedAt,
  validate,
}) {
  const fields = Array.isArray(metadata?.fields) ? metadata.fields : [];
  const previousFields = Array.isArray(previousMetadata?.fields) ? previousMetadata.fields : [];
  const existingTrigger = existing?.trigger
    && typeof existing.trigger === "object"
    && !Array.isArray(existing.trigger)
    ? {
      fieldId: existing.trigger.fieldId ?? existing.trigger.field_id,
      fieldName: existing.trigger.fieldName ?? existing.trigger.field_name,
      startValue: existing.trigger.startValue ?? existing.trigger.start_value,
      optionId: existing.trigger.optionId ?? existing.trigger.option_id,
    }
    : null;
  const hasPersistedPhasedShape = Boolean(
    existing
    && ["statusField", "reviewStatusField", "documentField", "namingField", "stages"]
      .some((key) => existing[key] !== undefined && existing[key] !== null),
  );
  const migratingLegacySubject = Boolean(existing && !hasPersistedPhasedShape);
  const legacyTriggerFieldId = !migratingLegacySubject
    ? null
    : validIdentifier(existingTrigger?.fieldId);
  const legacyTriggerFieldRenamed = Boolean(
    migratingLegacySubject
    && fieldDisplayNameChanged(fields, previousFields, legacyTriggerFieldId, existingTrigger?.fieldName),
  );
  const legacyTriggerOptionRenamed = Boolean(
    migratingLegacySubject
    && !legacyTriggerFieldRenamed
    && optionDisplayNameChanged(
      fields,
      previousFields,
      legacyTriggerFieldId,
      existingTrigger?.optionId,
      existingTrigger?.startValue,
    ),
  );
  const legacyStatusMatches = legacyTriggerFieldId && !legacyTriggerFieldRenamed
    ? fields.filter((field) => (
      isSingleSelectMetadataField(field)
      && validIdentifier(metadataFieldId(field)) === legacyTriggerFieldId
    ))
    : [];
  const persistedStatusFieldId = !migratingLegacySubject
    ? validIdentifier(existing?.statusField?.fieldId)
    : null;
  const persistedStatusMatches = persistedStatusFieldId && !isPendingIdentifier(persistedStatusFieldId)
    ? fields.filter((field) => (
      isSingleSelectMetadataField(field)
      && validIdentifier(metadataFieldId(field)) === persistedStatusFieldId
    ))
    : [];
  const existingTriggerFieldIds = [
    ...(existing?.reviewStatusField == null ? [existing?.trigger?.fieldId ?? existing?.trigger?.field_id] : []),
    ...(existing?.reviewStatusField == null ? STAGE_IDS : ["initial"]).map((stageId) => (
      existing?.stages?.[stageId]?.trigger?.fieldId
      ?? existing?.stages?.[stageId]?.trigger?.field_id
    )),
  ]
    .map(validIdentifier)
    .filter((fieldId) => fieldId && !isPendingIdentifier(fieldId));
  const uniqueExistingTriggerFieldIds = [...new Set(existingTriggerFieldIds)];
  const matchedExistingTriggerFields = uniqueExistingTriggerFieldIds
    .map((fieldId) => fields.filter((field) => (
      isSingleSelectMetadataField(field)
      && validIdentifier(metadataFieldId(field)) === fieldId
    )))
    .filter((matches) => matches.length > 0);
  const inferredStatusCandidate = uniqueExistingTriggerFieldIds.length === 1
    && matchedExistingTriggerFields.length === 1
    && matchedExistingTriggerFields[0].length === 1
    ? matchedExistingTriggerFields[0][0]
    : null;
  const freshStatusCandidate = fields.find((field) => (
    isSingleSelectMetadataField(field) && validIdentifier(metadataFieldId(field))
  ));
  const statusCandidate = migratingLegacySubject
    ? (legacyStatusMatches.length === 1 ? legacyStatusMatches[0] : null)
    : persistedStatusFieldId && !isPendingIdentifier(persistedStatusFieldId)
      ? (persistedStatusMatches.length === 1 ? persistedStatusMatches[0] : null)
      : existingTriggerFieldIds.length > 0
        ? inferredStatusCandidate
        : !existing || isPendingPhasedDefaults(existing)
          ? freshStatusCandidate
          : null;
  const usableFields = fields.filter((field) => validIdentifier(metadataFieldId(field)));
  const remainingFields = usableFields.filter((field) => field !== statusCandidate);
  // Missing document/name columns remain explicit repairable placeholders.
  // Reusing the status column would make strict enable validation accept a
  // binding the operator never selected.
  const documentCandidate = remainingFields[0];
  const positionalNamingCandidate = remainingFields[1] ?? documentCandidate;
  const namingCandidate = isCourseNamingMetadataField(positionalNamingCandidate)
    ? positionalNamingCandidate
    : null;
  const defaultStatusField = metadataDescriptor(
    statusCandidate ?? (migratingLegacySubject && !legacyTriggerFieldRenamed ? existingTrigger : null),
    "pending_status_field",
  );
  const defaultDocumentField = metadataDescriptor(documentCandidate, "pending_document_field");
  const defaultNamingField = metadataDescriptor(namingCandidate, "pending_naming_field");
  const reusableDescriptor = (value, fallback) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const fieldId = validIdentifier(value.fieldId);
    const fieldName = validRequiredText(value.fieldName);
    return fieldId && fieldName && !isPendingIdentifier(fieldId)
      ? { fieldId, fieldName }
      : fallback;
  };
  const statusField = reusableDescriptor(existing?.statusField, defaultStatusField);
  const reviewStatusField = existing?.reviewStatusField == null ? existing?.reviewStatusField
    : reusableDescriptor(existing.reviewStatusField, metadataDescriptor(null, "pending_review_status_field"));
  const reviewStatusCandidate = reviewStatusField == null ? statusCandidate
    : fields.find((field) => metadataFieldId(field) === reviewStatusField.fieldId);
  const documentField = reusableDescriptor(existing?.documentField, defaultDocumentField);
  const namingField = reusableDescriptor(existing?.namingField, defaultNamingField);
  const initialStageHasIntent = Boolean(
    existing
    && existing?.stages?.initial?.enabled !== false
    && hasTriggerIntent(existing?.stages?.initial?.trigger),
  );
  const topLevelTriggerHasIntent = Boolean(existing && hasTriggerIntent(existing?.trigger));
  let initialOptionNeedsRepair = false;
  const shouldProjectTopLevelInitialTrigger = Boolean(
    existing && !hasUsableStageTrigger(existing?.stages?.initial, statusField.fieldId),
  );
  const defaultStages = Object.fromEntries(STAGE_IDS.map((stageId, index) => {
    const stageStatusField = stageId === "initial" ? statusField : reviewStatusField ?? statusField;
    const stageStatusCandidate = stageId === "initial" ? statusCandidate : reviewStatusCandidate;
    let option = metadataOption(stageStatusCandidate, reviewStatusField && stageId !== "initial" ? index - 1 : index);
    const topLevelTriggerFieldId = validIdentifier(existingTrigger?.fieldId);
    if (
      stageId === "initial"
      && (migratingLegacySubject || shouldProjectTopLevelInitialTrigger)
    ) {
      if (migratingLegacySubject && (legacyTriggerFieldRenamed || legacyTriggerOptionRenamed)) {
        initialOptionNeedsRepair = true;
        option = {
          id: "pending_initial_option",
          name: "待配置",
        };
      } else if (topLevelTriggerFieldId === statusField.fieldId) {
        const legacyOptionId = validIdentifier(existingTrigger?.optionId);
        const legacyStartValue = validRequiredText(existingTrigger?.startValue);
        const legacyOptionMatches = Array.isArray(statusCandidate?.options)
          ? statusCandidate.options.filter((candidate) => (
            legacyOptionId
              ? validIdentifier(candidate?.id) === legacyOptionId
              : legacyStartValue && validRequiredText(candidate?.name) === legacyStartValue
          ))
          : [];
        const matchedOptionId = legacyOptionMatches.length === 1
          ? validIdentifier(legacyOptionMatches[0]?.id)
          : null;
        const matchedOptionName = legacyOptionMatches.length === 1
          ? validRequiredText(legacyOptionMatches[0]?.name)
          : null;
        if (matchedOptionId && matchedOptionName) {
          option = {
            id: matchedOptionId,
            name: matchedOptionName,
          };
        } else if (!migratingLegacySubject && (initialStageHasIntent || topLevelTriggerHasIntent)) {
          // A phased subject already carried an explicit trigger, but neither
          // the stage nor the legacy projection can be reconciled with the
          // current status field.  Keep it visibly repairable instead of
          // silently selecting metadata option 0.
          initialOptionNeedsRepair = true;
          option = {
            id: "pending_initial_option",
            name: "待配置",
          };
        } else if (migratingLegacySubject || initialStageHasIntent || topLevelTriggerHasIntent) {
          initialOptionNeedsRepair = true;
          option = {
            id: legacyOptionId ?? "pending_initial_option",
            name: legacyStartValue ?? "待配置",
          };
        }
      } else if (!migratingLegacySubject && (initialStageHasIntent || topLevelTriggerHasIntent)) {
        // A phased subject already carried an explicit trigger, but neither
        // the stage nor the legacy projection can be reconciled with the
        // current status field.  Keep it visibly repairable instead of
        // silently selecting metadata option 0.
        initialOptionNeedsRepair = true;
        option = {
          id: "pending_initial_option",
          name: "待配置",
        };
      } else if (migratingLegacySubject || initialStageHasIntent || topLevelTriggerHasIntent) {
        initialOptionNeedsRepair = true;
        const legacyOptionId = validIdentifier(existingTrigger?.optionId);
        const legacyStartValue = validRequiredText(existingTrigger?.startValue);
        option = {
          id: legacyOptionId ?? "pending_initial_option",
          name: legacyStartValue ?? "待配置",
        };
      }
    }
    const enabled = index === 0;
    const trigger = {
      fieldId: stageStatusField.fieldId,
      fieldName: stageStatusField.fieldName,
      optionId: option?.id ?? (enabled ? "pending_initial_option" : null),
      value: option?.name ?? (enabled ? "待配置" : ""),
    };
    return [stageId, {
      enabled,
      trigger,
      videoSource: { kind: "docx_section", anchorText: "录屏" },
      reviewSource: { kind: "docx_section", anchorText: "修改意见" },
      audio: { mode: "video_original" },
      artifactTargetPath: null,
      nameSuffix: DEFAULT_STAGE_SUFFIXES[index],
    }];
  }));
  let stages = Object.fromEntries(STAGE_IDS.map((stageId) => [
    stageId,
    repairStageDefaults(defaultStages[stageId], existing?.stages?.[stageId], stageId),
  ]));
  stages = ensureAtLeastOneEnabledStage(stages, defaultStages);
  // Legacy subjects had one upload destination at the subject level. Preserve
  // that destination for every enabled phased stage so both manual and
  // automatic uploads keep their machine-local routing after migration.
  stages = projectLegacyUploadTarget(stages, existing?.upload);
  const defaultLegacyStage = STAGE_IDS
    .map((stageId) => stages[stageId])
    .find((stage) => stage.enabled) ?? stages.initial;
  const projectedTrigger = defaultLegacyStage.trigger;
  const defaultLegacyTrigger = !migratingLegacySubject && initialOptionNeedsRepair
    ? {
      fieldId: statusField.fieldId,
      fieldName: statusField.fieldName,
      startValue: "待配置",
      optionId: "pending_initial_option",
    }
    : {
      fieldId: projectedTrigger.fieldId,
      fieldName: projectedTrigger.fieldName,
      startValue: projectedTrigger.value,
      optionId: projectedTrigger.optionId,
    };
  const reusableTriggerFieldId = validIdentifier(existingTrigger?.fieldId);
  const reusableTriggerFieldName = validRequiredText(existingTrigger?.fieldName);
  const reusableTriggerStartValue = validRequiredText(existingTrigger?.startValue);
  const optionalTriggerId = existingTrigger?.optionId === null
    || existingTrigger?.optionId === undefined
    || existingTrigger?.optionId === "";
  const reusableTriggerOptionId = optionalTriggerId
    ? null
    : validIdentifier(existingTrigger.optionId);
  const reusableTrigger = reusableTriggerFieldId
    && reusableTriggerFieldName
    && reusableTriggerStartValue
    && !migratingLegacySubject
    && !isPendingIdentifier(reusableTriggerFieldId)
    && !isPendingIdentifier(reusableTriggerOptionId)
    && (optionalTriggerId || reusableTriggerOptionId !== null)
    && !initialOptionNeedsRepair
    ? {
      fieldId: reusableTriggerFieldId,
      fieldName: reusableTriggerFieldName,
      startValue: reusableTriggerStartValue,
      optionId: reusableTriggerOptionId,
    }
    : defaultLegacyTrigger;
  const titleNeedsReselection = Boolean(
    migratingLegacySubject
    && fieldDisplayNameChanged(fields, previousFields, existing?.title?.fieldId, existing?.title?.fieldName),
  );
  const packageRoute = clone(existing?.packageRoute ?? {
    routeMode: "fixed",
    packageAlias: null,
    subjectCodeFieldId: null,
    branchMap: null,
  });
  if (migratingLegacySubject && fieldDisplayNameChanged(
    fields,
    previousFields,
    packageRoute.subjectCodeFieldId,
  )) {
    packageRoute.subjectCodeFieldId = null;
  }
  const candidate = {
    subjectKey,
    baseToken,
    baseName,
    tableId,
    tableName,
    projectId,
    displayEnabled: existing?.displayEnabled ?? false,
    lifecycle,
    configVersion,
    trigger: clone(reusableTrigger),
    title: titleNeedsReselection ? { fieldId: null, fieldName: null } : clone(existing?.title ?? { fieldId: null, fieldName: null }),
    execution: clone(existing?.execution ?? {
      // Only first discovery opts into automatic execution. Legacy repair and
      // restoration retain their conservative fallback when execution is absent.
      mode: existing ? "manual" : "automatic",
      concurrencyGroup: "default",
      maxConcurrent: 1,
      resourceGroups: [],
    }),
    packageRoute,
    upload: clone(existing?.upload ?? {
      enqueueMode: "manual",
      artifactSourceMode: "manual_select",
      artifactSourcePath: null,
      targetId: null,
      targetPath: null,
      uploadConcurrency: 1,
    }),
    ...(existing?.delivery === undefined ? {} : { delivery: clone(existing.delivery) }),
    statusField,
    ...(reviewStatusField === undefined ? {} : { reviewStatusField }),
    documentField,
    namingField,
    stages,
    metadata: null,
    createdAt,
    updatedAt,
  };
  const normalized = validate(candidate);
  normalized.metadata = metadata;
  return normalized;
}

export function subjectProjectId(subjectKey) {
  const digest = createHash("sha256")
    .update(String(subjectKey), "utf8")
    .digest("hex")
    .slice(0, SUBJECT_PROJECT_HASH_LENGTH);
  return `feishu-${digest}`;
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new ApiError(400, "INVALID_FIELD", `${name} is required`);
  if (value.includes("\0")) throw new ApiError(400, "INVALID_FIELD", `${name} contains null bytes`);
  return value.trim();
}

function identifier(value, name) {
  const result = requireText(value, name);
  if (!ID_PATTERN.test(result)) throw new ApiError(400, "INVALID_FIELD", `${name} is invalid`);
  return result;
}

function optionalIdentifier(value, name) {
  if (value === undefined || value === null || value === "") return null;
  return identifier(value, name);
}

function optionalTargetIdentifier(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const result = requireText(value, name);
  if (!TARGET_ID_PATTERN.test(result)) throw new ApiError(400, "INVALID_FIELD", `${name} is invalid`);
  return result;
}

function assertKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_FIELD", `${name} must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new ApiError(400, "UNKNOWN_FIELD", `${name}.${unknown} is not supported`);
}

function mergeObjects(current, patch) {
  const result = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)
      && current?.[key] && typeof current[key] === "object" && !Array.isArray(current[key])) {
      result[key] = mergeObjects(current[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseSubjectKey(value) {
  const key = requireText(value, "subjectKey");
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1 || key.indexOf(":", separator + 1) !== -1) {
    throw new ApiError(400, "INVALID_FIELD", "subjectKey must be baseToken:tableId");
  }
  const baseToken = identifier(key.slice(0, separator), "baseToken");
  const tableId = identifier(key.slice(separator + 1), "tableId");
  return { subjectKey: key, baseToken, tableId };
}

function json(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function rowSubject(row) {
  return {
    ...json(row.config_json),
    subjectKey: row.subject_key,
    baseToken: row.base_token,
    tableId: row.table_id,
    tableName: row.table_name,
    projectId: row.project_id,
    displayEnabled: Boolean(row.display_enabled),
    lifecycle: row.lifecycle,
    configVersion: row.config_version,
    metadata: json(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function subjectResponse(database, row) {
  const active = database.prepare(`
    SELECT version, snapshot_json FROM feishu_subject_versions
    WHERE subject_key = ? AND lifecycle = 'enabled' AND closed_at IS NULL
    ORDER BY version DESC LIMIT 1
  `).get(row.subject_key);
  const editingPreference = database.prepare(`
    SELECT package_alias FROM feishu_subject_editing_preferences WHERE subject_key = ?
  `).get(row.subject_key);
  return {
    ...rowSubject(row),
    // Response-only state: editing a draft does not replace the active version.
    activeConfigVersion: active?.version ?? null,
    activePackageAlias: active ? json(active.snapshot_json)?.packageRoute?.packageAlias ?? null : null,
    preferredPackageAlias: editingPreference?.package_alias ?? null,
  };
}

function rowBase(database, row) {
  const subjects = database.prepare(`
    SELECT * FROM feishu_subjects
    WHERE base_token = ? AND removed_at IS NULL
    ORDER BY table_name, table_id
  `).all(row.base_token).map((subject) => subjectResponse(database, subject));
  return {
    baseToken: row.base_token,
    baseName: row.base_name,
    sourceUrlLabel: safeSourceUrlLabel(row.source_url_label),
    metadataRefreshedAt: row.metadata_refreshed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subjects,
  };
}

function snapshotFor(row) {
  return rowSubject(row);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function uniqueMetadataField(fields, fieldId) {
  const matches = fields.filter((field) => metadataFieldId(field) === fieldId);
  return matches.length === 1 ? matches[0] : null;
}

function uniqueMetadataOption(field, optionId) {
  const matches = (Array.isArray(field?.options) ? field.options : [])
    .filter((option) => option?.id === optionId);
  return matches.length === 1 ? matches[0] : null;
}

function missingMetadataField(fields, fieldId) {
  const identifierValue = validIdentifier(fieldId);
  return Boolean(
    identifierValue
    && !isPendingIdentifier(identifierValue)
    && fields.filter((field) => metadataFieldId(field) === identifierValue).length === 0,
  );
}

function missingMetadataOption(field, optionId) {
  const identifierValue = validIdentifier(optionId);
  return Boolean(
    identifierValue
    && !isPendingIdentifier(identifierValue)
    && (Array.isArray(field?.options) ? field.options : [])
      .filter((option) => option?.id === identifierValue).length === 0,
  );
}

function metadataNameChanged(previousName, currentName, configuredName = null) {
  const before = validRequiredText(previousName) ?? validRequiredText(configuredName);
  const after = validRequiredText(currentName);
  return before !== null && after !== null && before !== after;
}

function fieldDisplayNameChanged(fields, previousFields, fieldId, configuredName = null) {
  const identifierValue = validIdentifier(fieldId);
  if (!identifierValue || isPendingIdentifier(identifierValue)) return false;
  const previousField = uniqueMetadataField(previousFields, identifierValue);
  const currentField = uniqueMetadataField(fields, identifierValue);
  if (!previousField || !currentField) return false;
  return metadataNameChanged(
    metadataFieldName(previousField),
    metadataFieldName(currentField),
    configuredName,
  );
}

function fieldRequiresReselection(fields, previousFields, fieldId, configuredName = null) {
  const identifierValue = validIdentifier(fieldId);
  if (!identifierValue || isPendingIdentifier(identifierValue)) return false;
  const matches = fields.filter((field) => metadataFieldId(field) === identifierValue);
  if (matches.length === 0) return true;
  if (matches.length !== 1) return false;
  return fieldDisplayNameChanged(fields, previousFields, identifierValue, configuredName);
}

function optionDisplayNameChanged(fields, previousFields, fieldId, optionId, configuredName = null) {
  const fieldIdValue = validIdentifier(fieldId);
  const optionIdValue = validIdentifier(optionId);
  if (!fieldIdValue || !optionIdValue || isPendingIdentifier(fieldIdValue) || isPendingIdentifier(optionIdValue)) return false;
  const previousField = uniqueMetadataField(previousFields, fieldIdValue);
  const currentField = uniqueMetadataField(fields, fieldIdValue);
  if (!previousField || !currentField) return false;
  const previousOption = uniqueMetadataOption(previousField, optionIdValue);
  const currentOption = uniqueMetadataOption(currentField, optionIdValue);
  if (!previousOption || !currentOption) return false;
  return metadataNameChanged(
    metadataOptionName(previousOption),
    metadataOptionName(currentOption),
    configuredName,
  );
}

function optionRequiresReselection(fields, previousFields, fieldId, optionId, configuredName = null) {
  const fieldIdValue = validIdentifier(fieldId);
  const optionIdValue = validIdentifier(optionId);
  if (!fieldIdValue || !optionIdValue || isPendingIdentifier(fieldIdValue) || isPendingIdentifier(optionIdValue)) return false;
  const fieldMatches = fields.filter((field) => metadataFieldId(field) === fieldIdValue);
  if (fieldMatches.length === 0) return true;
  if (fieldMatches.length !== 1) return false;
  const options = Array.isArray(fieldMatches[0]?.options) ? fieldMatches[0].options : [];
  const matches = options.filter((option) => option?.id === optionIdValue);
  if (matches.length === 0) return true;
  if (matches.length !== 1) return false;
  return optionDisplayNameChanged(fields, previousFields, fieldIdValue, optionIdValue, configuredName);
}

function clearDeletedMetadataBindings(value, metadata, previousMetadata = null) {
  const fields = Array.isArray(metadata?.fields) ? metadata.fields : [];
  const previousFields = Array.isArray(previousMetadata?.fields) ? previousMetadata.fields : [];
  const next = clone(value);
  let triggerChanged = false;
  const repairDescriptor = (descriptor, pendingId) => {
    if (!validIdentifier(descriptor?.fieldId)
      || fieldRequiresReselection(fields, previousFields, descriptor.fieldId, descriptor.fieldName)) {
      return { fieldId: pendingId, fieldName: "待配置" };
    }
    return descriptor;
  };

  next.statusField = repairDescriptor(next.statusField, "pending_status_field");
  if (next.reviewStatusField != null) {
    next.reviewStatusField = repairDescriptor(next.reviewStatusField, "pending_review_status_field");
  }
  next.documentField = repairDescriptor(next.documentField, "pending_document_field");
  next.namingField = repairDescriptor(next.namingField, "pending_naming_field");
  if (next.title && fieldRequiresReselection(fields, previousFields, next.title.fieldId, next.title.fieldName)) {
    next.title = { fieldId: null, fieldName: null };
  }
  if (next.packageRoute?.subjectCodeFieldId
    && fieldRequiresReselection(fields, previousFields, next.packageRoute.subjectCodeFieldId)) {
    next.packageRoute = { ...next.packageRoute, subjectCodeFieldId: null };
  }
  const triggerFieldRequiresReselection = fieldRequiresReselection(
    fields,
    previousFields,
    next.trigger?.fieldId,
    next.trigger?.fieldName,
  );
  const triggerOptionRequiresReselection = !triggerFieldRequiresReselection
    && optionRequiresReselection(
      fields,
      previousFields,
      next.trigger?.fieldId,
      next.trigger?.optionId,
      next.trigger?.startValue,
    );
  if (triggerFieldRequiresReselection || triggerOptionRequiresReselection) {
    next.trigger = {
      ...next.trigger,
      ...(triggerFieldRequiresReselection ? {
        fieldId: "pending_status_field",
        fieldName: "待配置",
      } : {}),
      optionId: "pending_initial_option",
      startValue: "待配置",
    };
  }
  if (next.stages && typeof next.stages === "object") {
    next.stages = Object.fromEntries(STAGE_IDS.map((stageId) => {
      const stage = clone(next.stages[stageId]);
      if (!stage) return [stageId, stage];
      const trigger = stage.trigger ?? {};
      const statusField = stageId === "initial" ? next.statusField : next.reviewStatusField ?? next.statusField;
      const statusWasCleared = isPendingIdentifier(statusField?.fieldId);
      const stageFieldMissing = fieldRequiresReselection(fields, previousFields, trigger.fieldId, trigger.fieldName);
      const currentTriggerField = uniqueMetadataField(fields, trigger.fieldId);
      const triggerField = statusWasCleared || stageFieldMissing
        ? null
        : currentTriggerField;
      const triggerOptionMissing = triggerField && optionRequiresReselection(
        fields,
        previousFields,
        trigger.fieldId,
        trigger.optionId,
        trigger.value,
      );
      if (statusWasCleared || stageFieldMissing || triggerOptionMissing) {
        stage.trigger = {
          ...trigger,
          fieldId: statusField.fieldId,
          fieldName: statusField.fieldName,
          optionId: PENDING_STAGE_OPTION_IDS[stageId],
          value: "待配置",
        };
        triggerChanged = true;
      }
      for (const sourceKey of ["videoSource", "reviewSource"]) {
        const source = stage[sourceKey];
        if (source?.kind === "base_attachment" && fieldRequiresReselection(fields, previousFields, source.fieldId)) {
          stage[sourceKey] = { ...source, fieldId: "pending_attachment_field" };
        }
      }
      if (stage.audio?.mode === "replace_original" && stage.audio.source?.kind === "base_attachment"
        && fieldRequiresReselection(fields, previousFields, stage.audio.source.fieldId)) {
        stage.audio = {
          ...stage.audio,
          source: { ...stage.audio.source, fieldId: "pending_attachment_field" },
        };
      }
      return [stageId, stage];
    }));
  }

  const firstEnabledStage = STAGE_IDS.map((stageId) => next.stages?.[stageId])
    .find((stage) => stage?.enabled);
  if (triggerChanged && firstEnabledStage?.trigger) {
    next.trigger = {
      ...next.trigger,
      fieldId: firstEnabledStage.trigger.fieldId,
      fieldName: firstEnabledStage.trigger.fieldName,
      startValue: firstEnabledStage.trigger.value,
      optionId: firstEnabledStage.trigger.optionId,
    };
  }

  if (next.delivery) {
    const delivery = clone(next.delivery);
    if (delivery.courseNaming?.mode === "field"
      && fieldRequiresReselection(fields, previousFields, delivery.courseNaming.fieldId)) {
      delivery.courseNaming.fieldId = null;
    }
    if (delivery.coursePathWriteback
      && fieldRequiresReselection(fields, previousFields, delivery.coursePathWriteback.fieldId)) {
      delivery.coursePathWriteback.fieldId = null;
    }
    for (const stageId of STAGE_IDS) {
      for (const moment of ["onProcessing", "onUploaded"]) {
        delivery.writeback?.[stageId]?.[moment]?.forEach((assignment) => {
          const field = uniqueMetadataField(fields, assignment.fieldId);
          if (fieldRequiresReselection(fields, previousFields, assignment.fieldId)) {
            assignment.fieldId = null;
            assignment.optionId = null;
          } else if (optionRequiresReselection(fields, previousFields, assignment.fieldId, assignment.optionId)) {
            assignment.optionId = null;
          }
        });
      }
    }
    if (delivery.finalDirectoryTrigger) {
      const field = uniqueMetadataField(fields, delivery.finalDirectoryTrigger.fieldId);
      if (fieldRequiresReselection(fields, previousFields, delivery.finalDirectoryTrigger.fieldId)) {
        delivery.finalDirectoryTrigger.fieldId = null;
        delivery.finalDirectoryTrigger.optionId = null;
      } else if (optionRequiresReselection(
        fields,
        previousFields,
        delivery.finalDirectoryTrigger.fieldId,
        delivery.finalDirectoryTrigger.optionId,
        null,
      )) {
        delivery.finalDirectoryTrigger.optionId = null;
      }
    }
    next.delivery = delivery;
  }
  return next;
}

function safeSourceUrlLabel(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    // A Base link is only a display hint.  Never carry query strings, hash
    // fragments or embedded credentials into a portable configuration.
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function portableMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  if (!Array.isArray(metadata.fields)) return {};
  return {
    fields: metadata.fields.map((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return null;
      const safe = {};
      for (const key of ["fieldId", "id", "fieldName", "name", "type", "uiType", "options"]) {
        if (field[key] !== undefined) {
          safe[key] = key === "options" && Array.isArray(field[key])
            ? field[key].filter((option) => option && typeof option === "object").map((option) => ({
              ...(option.id !== undefined ? { id: clone(option.id) } : {}),
              ...(option.name !== undefined ? { name: clone(option.name) } : {}),
            }))
            : clone(field[key]);
        }
      }
      return safe;
    }).filter(Boolean),
  };
}

function localMetadataForShareImport(subject) {
  const metadata = subject?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    && Array.isArray(metadata.fields)
    ? clone(metadata)
    : { fields: [] };
}

function shareableSubject(subject, { forceDraft = false } = {}) {
  const delivery = Object.hasOwn(subject, "delivery") ? clone(subject.delivery) : undefined;
  const result = {
    subjectKey: subject.subjectKey,
    baseToken: subject.baseToken,
    baseName: subject.baseName,
    tableId: subject.tableId,
    tableName: subject.tableName,
    projectId: subject.projectId,
    displayEnabled: subject.displayEnabled,
    lifecycle: subject.lifecycle,
    configVersion: subject.configVersion,
    ...(subject.statusField ? { statusField: clone(subject.statusField) } : {}),
    ...(subject.reviewStatusField === undefined ? {} : { reviewStatusField: clone(subject.reviewStatusField) }),
    ...(subject.documentField ? { documentField: clone(subject.documentField) } : {}),
    ...(subject.namingField ? { namingField: clone(subject.namingField) } : {}),
    ...(subject.stages ? {
      stages: Object.fromEntries(STAGE_IDS.map((stageId) => {
        const stage = subject.stages[stageId];
        if (!stage) return [stageId, null];
        const portableStage = clone(stage);
        delete portableStage.artifact_target_path;
        // Stage destinations are local to the Taskboard machine and never
        // cross the Bridge/share boundary.
        portableStage.artifactTargetPath = null;
        return [stageId, portableStage];
      })),
    } : {}),
    trigger: clone(subject.trigger),
    title: clone(subject.title),
    execution: clone(subject.execution),
    packageRoute: clone(subject.packageRoute),
    upload: clone(subject.upload),
    ...(delivery === undefined ? {} : { delivery }),
    metadata: portableMetadata(subject.metadata),
  };
  // A share file is a portable description of workflow intent.  Runtime
  // snapshots, database timestamps and machine-local path bindings never cross
  // the device boundary.
  if (forceDraft) {
    result.lifecycle = "draft";
    result.configVersion = 1;
  }
  result.upload = {
    ...result.upload,
    artifactSourcePath: null,
    targetPath: null,
  };
  if (result.delivery) result.delivery.rootPath = null;
  return result;
}

function shareableConfiguration(catalog, { forceDraft = false } = {}) {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    configVersion: 1,
    createdAt: null,
    updatedAt: null,
    bases: (catalog ?? []).map((base) => ({
      baseToken: base.baseToken,
      baseName: base.baseName,
      sourceUrlLabel: safeSourceUrlLabel(base.sourceUrlLabel),
      metadataRefreshedAt: base.metadataRefreshedAt ?? null,
      subjects: (base.subjects ?? []).map((subject) => shareableSubject(subject, { forceDraft })),
    })),
  };
}

function validateShareDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", "Shared workflow configuration must be an object");
  }
  const allowed = new Set(["schemaVersion", "configVersion", "createdAt", "updatedAt", "bases"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new ApiError(400, "UNKNOWN_FIELD", `configuration.${unknown} is not supported`);
  if (value.schemaVersion !== undefined && value.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new ApiError(400, "UNSUPPORTED_SCHEMA_VERSION", `configuration.schemaVersion must be ${WORKFLOW_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.bases)) throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", "configuration.bases must be an array");
  const bases = [];
  const seenBases = new Set();
  const seenSubjects = new Set();
  for (const [baseIndex, inputBase] of value.bases.entries()) {
    if (!inputBase || typeof inputBase !== "object" || Array.isArray(inputBase)) {
      throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `configuration.bases[${baseIndex}] must be an object`);
    }
    const baseAllowed = new Set(["baseToken", "baseName", "sourceUrlLabel", "metadataRefreshedAt", "subjects"]);
    const baseUnknown = Object.keys(inputBase).find((key) => !baseAllowed.has(key));
    if (baseUnknown) throw new ApiError(400, "UNKNOWN_FIELD", `configuration.bases[${baseIndex}].${baseUnknown} is not supported`);
    const baseToken = identifier(inputBase.baseToken, `configuration.bases[${baseIndex}].baseToken`);
    const baseName = requireText(inputBase.baseName, `configuration.bases[${baseIndex}].baseName`);
    if (seenBases.has(baseToken)) throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `duplicate baseToken: ${baseToken}`);
    seenBases.add(baseToken);
    if (!Array.isArray(inputBase.subjects)) {
      throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `configuration.bases[${baseIndex}].subjects must be an array`);
    }
    const subjects = [];
    for (const [subjectIndex, inputSubject] of inputBase.subjects.entries()) {
      if (!inputSubject || typeof inputSubject !== "object" || Array.isArray(inputSubject)) {
        throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `configuration.bases[${baseIndex}].subjects[${subjectIndex}] must be an object`);
      }
      const subjectAllowed = new Set([
        "subjectKey", "baseToken", "baseName", "tableId", "tableName", "projectId", "displayEnabled",
        "lifecycle", "configVersion", "createdAt", "updatedAt", "trigger", "title", "execution",
        "packageRoute", "upload", "metadata", "statusField", "reviewStatusField", "documentField", "namingField", "stages", "delivery",
      ]);
      const subjectUnknown = Object.keys(inputSubject).find((key) => !subjectAllowed.has(key));
      if (subjectUnknown) {
        throw new ApiError(400, "UNKNOWN_FIELD", `configuration.bases[${baseIndex}].subjects[${subjectIndex}].${subjectUnknown} is not supported`);
      }
      const hasExplicitPhasedShape = ["statusField", "reviewStatusField", "documentField", "namingField", "stages"]
        .some((keyName) => inputSubject[keyName] !== undefined && inputSubject[keyName] !== null);
      const tableId = identifier(inputSubject.tableId, `configuration.bases[${baseIndex}].subjects[${subjectIndex}].tableId`);
      const key = `${baseToken}:${tableId}`;
      if (inputSubject.subjectKey !== undefined && inputSubject.subjectKey !== key) {
        throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `subjectKey does not match ${key}`);
      }
      if (inputSubject.baseToken !== undefined && inputSubject.baseToken !== baseToken) {
        throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `baseToken does not match ${key}`);
      }
      if (inputSubject.projectId !== undefined && inputSubject.projectId !== subjectProjectId(key)) {
        throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `projectId does not match ${key}`);
      }
      if (seenSubjects.has(key)) throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `duplicate subjectKey: ${key}`);
      seenSubjects.add(key);
      let normalized = {
        subjectKey: key,
        baseToken,
        baseName: requireText(inputSubject.baseName ?? baseName, "subject.baseName"),
        tableId,
        tableName: requireText(inputSubject.tableName, "subject.tableName"),
        projectId: subjectProjectId(key),
        displayEnabled: inputSubject.displayEnabled === undefined ? false : inputSubject.displayEnabled,
        lifecycle: "draft",
        configVersion: Number.isInteger(inputSubject.configVersion) && inputSubject.configVersion > 0 ? inputSubject.configVersion : 1,
        metadata: portableMetadata(inputSubject.metadata),
        trigger: clone(inputSubject.trigger),
        title: clone(inputSubject.title),
        execution: clone(inputSubject.execution),
        packageRoute: clone(inputSubject.packageRoute),
        upload: clone(inputSubject.upload),
        ...(inputSubject.delivery === undefined ? {} : { delivery: clone(inputSubject.delivery) }),
        statusField: clone(inputSubject.statusField),
        ...(inputSubject.reviewStatusField === undefined ? {} : { reviewStatusField: clone(inputSubject.reviewStatusField) }),
        documentField: clone(inputSubject.documentField),
        namingField: clone(inputSubject.namingField),
        stages: inputSubject.stages && typeof inputSubject.stages === "object" && !Array.isArray(inputSubject.stages)
          ? Object.fromEntries(Object.entries(inputSubject.stages).map(([stageId, stage]) => {
            if (!stage || typeof stage !== "object" || Array.isArray(stage)) return [stageId, clone(stage)];
            const portableStage = clone(stage);
            delete portableStage.artifact_target_path;
            portableStage.artifactTargetPath = null;
            return [stageId, portableStage];
          }))
          : clone(inputSubject.stages),
      };
      if (typeof normalized.displayEnabled !== "boolean") {
        throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `${key}.displayEnabled must be boolean`);
      }
      // Reuse the store's strict field/package/path-independent validator after
      // filling only fields that are safe defaults for a portable document.
      normalized.title ??= { fieldId: null, fieldName: null };
      normalized.execution ??= { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] };
      normalized.packageRoute ??= { routeMode: "fixed", packageAlias: null, subjectCodeFieldId: null, branchMap: null };
      if (normalized.upload !== undefined && normalized.upload !== null
        && (typeof normalized.upload !== "object" || Array.isArray(normalized.upload))) {
        throw new ApiError(
          400,
          "INVALID_SHARE_CONFIGURATION",
          `configuration.bases[${baseIndex}].subjects[${subjectIndex}].upload must be an object`,
        );
      }
      normalized.upload ??= { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 };
      normalized.upload.artifactSourcePath = null;
      normalized.upload.targetPath = null;
      if (Object.hasOwn(normalized, "delivery")) {
        try {
          normalized.delivery = normalizeDeliveryConfig(normalized.delivery);
        } catch (error) {
          throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", error.message);
        }
        if (normalized.delivery) normalized.delivery.rootPath = null;
      }
      try {
        if (!hasExplicitPhasedShape) {
          normalized = phasedDefaultsForSubject({
            subjectKey: normalized.subjectKey,
            baseToken: normalized.baseToken,
            baseName: normalized.baseName,
            tableId: normalized.tableId,
            tableName: normalized.tableName,
            projectId: normalized.projectId,
            metadata: normalized.metadata,
            existing: normalized,
            lifecycle: "draft",
            configVersion: normalized.configVersion,
            validate: validateSubjectConfig,
          });
        }
        // A newly exported subject can carry the complete phased editor
        // skeleton even when this machine has not observed any field
        // metadata yet. Validate its shape without pretending pending
        // bindings are real fields; Save/Enable will still require a repair.
        const validationInput = isPendingPhasedDefaults(normalized)
          ? { ...normalized, metadata: null }
          : normalized;
        validateSubjectConfig(validationInput);
      } catch (error) {
        if (error instanceof ApiError) {
          throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", error.message);
        }
        throw error;
      }
      subjects.push(normalized);
    }
    bases.push({
      baseToken,
      baseName,
      sourceUrlLabel: safeSourceUrlLabel(inputBase.sourceUrlLabel),
      metadataRefreshedAt: inputBase.metadataRefreshedAt ?? null,
      subjects,
    });
  }
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    configVersion: 1,
    createdAt: null,
    updatedAt: null,
    bases,
  };
}

const SUBJECT_PATCH_KEYS = new Set([
  "displayEnabled", "trigger", "title", "execution", "packageRoute", "upload",
  "statusField", "reviewStatusField", "documentField", "namingField", "stages", "delivery", "expectedVersion",
]);

const PACKAGE_PROFILE_KEYS = new Set([...SUBJECT_PATCH_KEYS].filter((key) => !["displayEnabled", "expectedVersion"].includes(key)));
const ZIP_WORKFLOW_TEMPLATE = Object.freeze({ id: "document_draft_zip", version: 1 });

function packageProfileConfig(subject) {
  return Object.fromEntries([...PACKAGE_PROFILE_KEYS].filter((key) => Object.hasOwn(subject, key))
    .map((key) => [key, clone(subject[key])]));
}

export function validateSubjectConfig(value, { projectLegacyTrigger = false, allowIncompleteBindings = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Subject configuration must be an object");
  }
  if (isVmSubject(value)) return validateVmSubject(value);
  if (allowIncompleteBindings && isPhasedSubject(value)) {
    try { value = normalizePhasedDraftBindings(value, { projectLegacyTrigger }); }
    catch (error) { throw new ApiError(400, error.code ?? "INVALID_FIELD", error.message); }
  }
  const allowedTopLevel = new Set([
    "subjectKey", "baseToken", "baseName", "tableId", "tableName", "projectId",
    "displayEnabled", "lifecycle", "configVersion", "trigger", "title", "execution",
    "packageRoute", "upload", "metadata", "statusField", "reviewStatusField", "documentField", "namingField", "stages", "delivery",
    "createdAt", "updatedAt",
  ]);
  const unknownTopLevel = Object.keys(value).find((key) => !allowedTopLevel.has(key));
  if (unknownTopLevel) throw new ApiError(400, "UNKNOWN_FIELD", `Unknown subject field '${unknownTopLevel}'`);
  const identity = parseSubjectKey(value.subjectKey);
  if (value.baseToken !== identity.baseToken || value.tableId !== identity.tableId) {
    throw new ApiError(400, "INVALID_FIELD", "Subject identity does not match subjectKey");
  }
  if (value.projectId !== subjectProjectId(value.subjectKey)) {
    throw new ApiError(400, "INVALID_FIELD", "Subject project identity is invalid");
  }
  if (!LIFECYCLES.has(value.lifecycle)) throw new ApiError(400, "INVALID_FIELD", "lifecycle is invalid");
  assertKeys(value.trigger, new Set(["fieldId", "fieldName", "startValue", "optionId"]), "trigger");
  identifier(value.trigger.fieldId, "trigger.fieldId");
  requireText(value.trigger.fieldName, "trigger.fieldName");
  requireText(value.trigger.startValue, "trigger.startValue");
  optionalIdentifier(value.trigger.optionId, "trigger.optionId");
  assertKeys(value.title, new Set(["fieldId", "fieldName"]), "title");
  const titleFieldId = optionalIdentifier(value.title.fieldId, "title.fieldId");
  const titleFieldName = value.title.fieldName === null || value.title.fieldName === undefined || value.title.fieldName === ""
    ? null : requireText(value.title.fieldName, "title.fieldName");
  if (Boolean(titleFieldId) !== Boolean(titleFieldName)) {
    throw new ApiError(400, "INVALID_FIELD", "title.fieldId and title.fieldName must be configured together");
  }
  assertKeys(value.execution, new Set(["mode", "concurrencyGroup", "maxConcurrent", "resourceGroups"]), "execution");
  if (!EXECUTION_MODES.has(value.execution.mode)) throw new ApiError(400, "INVALID_FIELD", "execution.mode is invalid");
  identifier(value.execution.concurrencyGroup, "execution.concurrencyGroup");
  if (!Number.isSafeInteger(value.execution.maxConcurrent) || value.execution.maxConcurrent < 1) {
    throw new ApiError(400, "INVALID_FIELD", "execution.maxConcurrent must be positive");
  }
  if (!Array.isArray(value.execution.resourceGroups)) throw new ApiError(400, "INVALID_FIELD", "execution.resourceGroups must be an array");
  const groups = value.execution.resourceGroups.map((group, index) => identifier(group, `execution.resourceGroups[${index}]`));
  if (new Set(groups).size !== groups.length) throw new ApiError(400, "INVALID_FIELD", "execution.resourceGroups must be unique");
  assertKeys(value.packageRoute, new Set(["routeMode", "packageAlias", "subjectCodeFieldId", "branchMap"]), "packageRoute");
  if ((value.packageRoute.routeMode ?? "fixed") !== "fixed") throw new ApiError(400, "INVALID_FIELD", "packageRoute.routeMode is invalid");
  const aliasValue = value.packageRoute.packageAlias;
  const alias = aliasValue === null || aliasValue === undefined || (typeof aliasValue === "string" && aliasValue.trim() === "")
    ? null : requireText(aliasValue, "packageRoute.packageAlias");
  if (alias === null && value.lifecycle === "enabled") throw new ApiError(409, "PACKAGE_ALIAS_REQUIRED", "请选择剪辑包后再启用学科流程");
  value.packageRoute.packageAlias = alias;
  if (alias !== null && (/^[./\\]/u.test(alias) || /[\s\u0000-\u001f\u007f"'`:$<>|]/u.test(alias))) {
    throw new ApiError(400, "INVALID_FIELD", "packageRoute.packageAlias is invalid");
  }
  optionalIdentifier(value.packageRoute.subjectCodeFieldId, "packageRoute.subjectCodeFieldId");
  if (value.packageRoute.branchMap !== null && value.packageRoute.branchMap !== undefined) {
    assertKeys(value.packageRoute.branchMap, new Set(Object.keys(value.packageRoute.branchMap)), "packageRoute.branchMap");
    for (const [code, branchAlias] of Object.entries(value.packageRoute.branchMap)) {
      requireText(code, "packageRoute.branchMap key");
      const normalized = requireText(branchAlias, `packageRoute.branchMap.${code}`);
      if (/^[./\\]/u.test(normalized) || /[\s\u0000-\u001f\u007f"'`:$<>|]/u.test(normalized)) {
        throw new ApiError(400, "INVALID_FIELD", "packageRoute.branchMap contains an invalid alias");
      }
    }
  }
  assertKeys(value.upload, new Set(["enabled", "enqueueMode", "artifactSourceMode", "artifactSourcePath", "targetId", "targetPath", "uploadConcurrency"]), "upload");
  if (value.upload.enabled !== undefined && typeof value.upload.enabled !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "upload.enabled must be boolean");
  }
  if (!EXECUTION_MODES.has(value.upload.enqueueMode)) throw new ApiError(400, "INVALID_FIELD", "upload.enqueueMode is invalid");
  if (!ARTIFACT_SOURCE_MODES.has(value.upload.artifactSourceMode)) throw new ApiError(400, "INVALID_FIELD", "upload.artifactSourceMode is invalid");
  if (!Number.isSafeInteger(value.upload.uploadConcurrency) || value.upload.uploadConcurrency < 1) throw new ApiError(400, "INVALID_FIELD", "upload.uploadConcurrency must be positive");
  optionalTargetIdentifier(value.upload.targetId, "upload.targetId");
  if (typeof value.displayEnabled !== "boolean") throw new ApiError(400, "INVALID_FIELD", "displayEnabled must be boolean");
  for (const field of ["artifactSourcePath", "targetPath"]) {
    const candidate = value.upload[field];
    if (candidate !== null && candidate !== undefined && candidate !== "" && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(candidate)) {
      throw new ApiError(400, "INVALID_FIELD", `upload.${field} must be absolute`);
    }
  }
  if (isPhasedSubject(value)) {
    try {
      const normalized = validatePhasedSubjectConfig(value, { allowIncompleteBindings });
      if (value.lifecycle === "enabled" && value.upload.enqueueMode === "automatic" && value.delivery?.version !== 1) {
        const missingDestination = STAGE_IDS.find((stageId) => (
          normalized.stages[stageId].enabled
          && normalized.stages[stageId].artifactTargetPath === null
        ));
        if (missingDestination) {
          throw new ApiError(
            400,
            "INVALID_FIELD",
            `Enabled automatic stage '${missingDestination}' requires artifactTargetPath`,
          );
        }
      }
      for (const key of ["statusField", "documentField", "namingField", "stages"]) value[key] = normalized[key];
      if (normalized.reviewStatusField !== undefined) value.reviewStatusField = normalized.reviewStatusField;
      if (projectLegacyTrigger) {
        const firstEnabledStage = STAGE_IDS
          .map((stageId) => normalized.stages[stageId])
          .find((stage) => stage?.enabled);
        if (firstEnabledStage) {
          value.trigger = {
            ...value.trigger,
            fieldId: firstEnabledStage.trigger.fieldId,
            fieldName: firstEnabledStage.trigger.fieldName,
            startValue: firstEnabledStage.trigger.value,
            optionId: firstEnabledStage.trigger.optionId,
          };
        }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, error.code ?? "INVALID_FIELD", error.message);
    }
  }
  if (Object.hasOwn(value, "delivery")) {
    try {
      value.delivery = normalizeDeliveryConfig(value.delivery);
    } catch (error) {
      throw new ApiError(400, error.code ?? "INVALID_FIELD", error.message);
    }
  }
  return value;
}

export function createFeishuWorkflowStore({ database, validateConfig = null, packageAliases = null, validatePackageWorkflow = null,
  validateVmWorkflowActivation = null, syncSubject = null } = {}) {
  if (!database?.database) throw new TypeError("database is required");
  const db = database.database;
  db.exec(`CREATE TABLE IF NOT EXISTS feishu_package_workflow_drafts (
    subject_key TEXT NOT NULL REFERENCES feishu_subjects(subject_key) ON DELETE CASCADE,
    package_alias TEXT NOT NULL,
    template_id TEXT NOT NULL,
    template_version INTEGER NOT NULL CHECK (template_version > 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (subject_key, package_alias, template_id, template_version)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS feishu_subject_editing_preferences (
    subject_key TEXT PRIMARY KEY REFERENCES feishu_subjects(subject_key) ON DELETE CASCADE,
    package_alias TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`INSERT OR IGNORE INTO feishu_subject_editing_preferences (subject_key, package_alias, updated_at)
    SELECT draft.subject_key, draft.package_alias, draft.updated_at
    FROM feishu_package_workflow_drafts AS draft
    WHERE draft.rowid = (
      SELECT recent.rowid FROM feishu_package_workflow_drafts AS recent
      WHERE recent.subject_key = draft.subject_key
      ORDER BY recent.updated_at DESC, recent.revision DESC, recent.rowid DESC LIMIT 1
    )`);
  const validate = (value, options = {}) => {
    const normalized = typeof validateConfig === "function" ? validateConfig(value) : value;
    return validateSubjectConfig(normalized, options);
  };
  const validateMetadataRefreshDraft = (value) => {
    const metadata = value.metadata;
    const structuralInput = { ...value, metadata: null };
    const normalized = typeof validateConfig === "function" ? validateConfig(structuralInput) : structuralInput;
    const next = validateSubjectConfig(normalized);
    next.metadata = metadata;
    return next;
  };
  const validateLifecycleSnapshot = (value, options = {}) => {
    if (!isPendingPhasedDefaults(value)) return validate(value, options);
    // Pending bindings are deliberately persisted so the editor can repair
    // them. Lifecycle cleanup must still be able to disable/archive that
    // draft without pretending the placeholders exist in Base metadata.
    const structuralInput = { ...value, metadata: null };
    const normalized = validate(structuralInput, options);
    normalized.metadata = value.metadata;
    return normalized;
  };

  function assertStrictPhasedAttachments(subject, { allowIncompleteBindings = false } = {}) {
    if (!isPhasedSubject(subject)) return;
    try {
      assertPhasedAttachmentBindings(subject, subject.metadata, { allowIncompleteBindings });
    } catch (error) {
      const code = error?.code === "FIELD_TYPE_INVALID"
        ? "FIELD_TYPE_INVALID"
        : error?.code === "FIELD_NOT_UNIQUE"
          ? "FIELD_NOT_UNIQUE"
          : "FIELD_NOT_FOUND";
      throw new ApiError(
        409,
        code,
        code === "FIELD_TYPE_INVALID"
          ? "A configured phased source is not an attachment field"
          : code === "FIELD_NOT_UNIQUE"
            ? "A configured phased field is not unique in the latest Base metadata"
            : "A configured phased attachment field is not present in the latest Base metadata",
        error?.path ? { path: error.path } : undefined,
      );
    }
  }

  function assertPhasedNamingField(subject) {
    if (!isPhasedSubject(subject)) return;
    const fields = Array.isArray(subject?.metadata?.fields) ? subject.metadata.fields : [];
    const field = fields.find((candidate) => metadataFieldId(candidate) === subject.namingField?.fieldId);
    if (!field) return;
    if (isCourseNamingMetadataField(field)) return;
    throw new ApiError(
      409,
      "FIELD_TYPE_INVALID",
      "namingField.fieldId must identify a text or formula field",
      { path: "namingField.fieldId" },
    );
  }

  function assertDeliveryConfiguration(subject, mode) {
    if (!Object.hasOwn(subject, "delivery")) return;
    const fields = Array.isArray(subject?.metadata?.fields) ? subject.metadata.fields : [];
    const namingField = fields.find((field) => (
      metadataFieldId(field) === subject?.namingField?.fieldId
    )) ?? null;
    const result = validateDeliveryConfig(subject.delivery, {
      mode,
      fields,
      stages: subject.stages,
      uploadEnabled: subject.upload?.enabled !== false,
      namingField,
    });
    if (result.issues.length === 0) return;
    const first = result.issues[0];
    throw new ApiError(
      mode === "activation" ? 409 : 400,
      first.code,
      first.message,
      { path: first.path },
    );
  }
  async function assertPackageAlias(alias) {
    if (typeof packageAliases !== "function") return;
    const allowed = await packageAliases();
    if (!Array.isArray(allowed) || !allowed.includes(alias)) {
      throw new ApiError(409, "UNKNOWN_PACKAGE_ALIAS", "Auto-Cut package is not configured on this Taskboard");
    }
  }

  function assertTriggerMetadata(subject) {
    const fields = Array.isArray(subject?.metadata?.fields) ? subject.metadata.fields : [];
    const fieldMatches = fields.filter((candidate) => (
      candidate && typeof candidate === "object"
      && (candidate.fieldId ?? candidate.id) === subject.trigger.fieldId
    ));
    if (fieldMatches.length === 0) {
      throw new ApiError(
        409,
        "TRIGGER_FIELD_NOT_FOUND",
        "The configured trigger field is not present in the latest Base metadata",
      );
    }
    if (fieldMatches.length > 1) {
      throw new ApiError(409, "TRIGGER_FIELD_NOT_UNIQUE", "The configured trigger field is not unique in the latest Base metadata");
    }
    const field = fieldMatches[0];
    if (subject.trigger.optionId) {
      const options = Array.isArray(field.options) ? field.options : [];
      const optionMatches = options.filter((candidate) => (
        candidate && typeof candidate === "object"
        && candidate.id === subject.trigger.optionId
      ));
      if (optionMatches.length === 0 || optionMatches.length > 1) {
        throw new ApiError(
          409,
          optionMatches.length > 1 ? "TRIGGER_OPTION_NOT_UNIQUE" : "TRIGGER_OPTION_NOT_FOUND",
          "The configured start option is not present in the latest Base metadata",
        );
      }
      if (optionMatches[0].name !== subject.trigger.startValue) {
        throw new ApiError(409, "TRIGGER_OPTION_NOT_FOUND", "The configured start option is not present in the latest Base metadata");
      }
    }
  }

  async function configuredPackageAliases() {
    if (typeof packageAliases !== "function") return null;
    const aliases = await packageAliases();
    return new Set(Array.isArray(aliases) ? aliases : []);
  }

  function hasActiveShareImportVersion(row) {
    if (!row) return false;
    if (row.removed_at !== null) return false;
    if (row.lifecycle === "enabled") return true;
    return Boolean(db.prepare(`
      SELECT 1 FROM feishu_subject_versions
      WHERE subject_key = ? AND lifecycle = 'enabled' AND closed_at IS NULL
      LIMIT 1
    `).get(row.subject_key));
  }

  function enabledSubjectSkipDiagnostic(subject) {
    return {
      code: "ENABLED_SUBJECT_SKIPPED",
      severity: "warning",
      path: `bases.${subject.baseToken}.subjects.${subject.tableId}`,
      message: `Subject ${subject.tableName} has an active workflow and will remain unchanged during import`,
    };
  }

  function removedShareSkipDiagnostic(base, subject = null) {
    return {
      code: subject ? "REMOVED_SUBJECT_SKIPPED" : "REMOVED_BASE_SKIPPED",
      severity: "warning",
      path: `bases.${base.baseToken}${subject ? `.subjects.${subject.tableId}` : ""}`,
      message: "Removed catalog entries remain removed during configuration import",
    };
  }

  async function shareDiagnostics(configuration) {
    const diagnostics = [];
    const packageSet = await configuredPackageAliases();
    const currentBases = new Map(db.prepare("SELECT * FROM feishu_bases").all().map((row) => [row.base_token, row]));
    const currentSubjects = new Map(db.prepare("SELECT * FROM feishu_subjects").all().map((row) => [row.subject_key, row]));
    for (const base of configuration.bases) {
      const currentBase = currentBases.get(base.baseToken);
      if (currentBase?.removed_at) {
        diagnostics.push(removedShareSkipDiagnostic(base));
        continue;
      }
      if (!currentBase) {
        diagnostics.push({
          code: "BASE_NOT_FOUND",
          severity: "info",
          path: `bases.${base.baseToken}`,
          message: `Base ${base.baseName} will be added to this Taskboard`,
        });
      }
      for (const subject of base.subjects) {
        const current = currentSubjects.get(subject.subjectKey);
        if (current?.removed_at) {
          diagnostics.push(removedShareSkipDiagnostic(base, subject));
          continue;
        }
        if (hasActiveShareImportVersion(current)) {
          diagnostics.push(enabledSubjectSkipDiagnostic(subject));
          continue;
        }
        if (!current) {
          diagnostics.push({
            code: "SUBJECT_NOT_FOUND",
            severity: "info",
            path: `bases.${base.baseToken}.subjects.${subject.tableId}`,
            message: `Subject ${subject.tableName} will be added to this Taskboard`,
          });
        }
        const currentConfig = current ? rowSubject(current) : null;
        // Shared metadata is only a portable preview. Diagnostics and commit
        // must use the same local snapshot so an unavailable or stale binding
        // cannot appear validated before becoming a blocked draft.
        const fields = localMetadataForShareImport(currentConfig).fields;
        const knownIds = new Set(fields.map((field) => field?.fieldId ?? field?.id).filter(Boolean));
        for (const [fieldName, fieldId] of [
          ["trigger", subject.trigger?.fieldId],
          ["title", subject.title?.fieldId],
          ["subjectCode", subject.packageRoute?.subjectCodeFieldId],
        ]) {
          if (fieldId && !knownIds.has(fieldId)) {
            diagnostics.push({
              code: "FIELD_NOT_FOUND",
              severity: "warning",
              path: `bases.${base.baseToken}.subjects.${subject.tableId}.${fieldName}.fieldId`,
              message: `Configured ${fieldName} field ${fieldId} is not present in the local metadata`,
            });
          }
        }
        const fieldById = new Map(fields.map((field) => [field?.fieldId ?? field?.id, field]));
        if (isPhasedSubject(subject)) {
          for (const [name, descriptor, predicate] of [
            ["statusField", subject.statusField, isSingleSelectMetadataField],
            ["reviewStatusField", subject.reviewStatusField, isSingleSelectMetadataField],
            ["documentField", subject.documentField, null],
            ["namingField", subject.namingField, isCourseNamingMetadataField],
          ]) {
            const fieldId = descriptor?.fieldId;
            if (!fieldId) continue;
            const matches = fields.filter((field) => metadataFieldId(field) === fieldId);
            const code = matches.length === 0 ? "FIELD_NOT_FOUND"
              : matches.length > 1 ? "FIELD_NOT_UNIQUE"
                : predicate && !predicate(matches[0]) ? "FIELD_TYPE_INVALID" : null;
            if (!code) continue;
            diagnostics.push({
              code,
              severity: "warning",
              path: `bases.${base.baseToken}.subjects.${subject.tableId}.${name}.fieldId`,
              message: `Configured ${name} field must be reselected from current metadata`,
            });
          }
        }
        if (subject.delivery) {
          const namingField = fieldById.get(subject.namingField?.fieldId) ?? null;
          const deliveryIssues = validateDeliveryConfig(subject.delivery, {
            mode: "activation",
            fields,
            stages: subject.stages,
            uploadEnabled: subject.upload?.enabled !== false,
            namingField,
          }).issues;
          for (const issue of deliveryIssues) {
            if (!issue.path.endsWith(".fieldId") && !issue.path.endsWith(".optionId")) continue;
            diagnostics.push({
              code: issue.code,
              severity: "warning",
              path: `bases.${base.baseToken}.subjects.${subject.tableId}.${issue.path}`,
              message: issue.message,
            });
          }
        }
        const stageSources = [];
        for (const stageId of STAGE_IDS) {
          const stage = subject.stages?.[stageId];
          if (!stage || typeof stage !== "object") continue;
          if (stage.videoSource?.kind === "base_attachment") {
            stageSources.push([
              stage.videoSource.fieldId,
              `stages.${stageId}.videoSource.fieldId`,
            ]);
          }
          if (stage.audio?.mode === "replace_original" && stage.audio.source?.kind === "base_attachment") {
            stageSources.push([
              stage.audio.source.fieldId,
              `stages.${stageId}.audio.source.fieldId`,
            ]);
          }
        }
        for (const [fieldId, sourcePath] of stageSources) {
          const field = fieldById.get(fieldId);
          const diagnosticPath = `bases.${base.baseToken}.subjects.${subject.tableId}.${sourcePath}`;
          if (!field) {
            diagnostics.push({
              code: "FIELD_NOT_FOUND",
              severity: "warning",
              path: diagnosticPath,
              message: "A configured staged attachment field is not present in the local metadata",
            });
          } else if (!isAttachmentMetadataField(field)) {
            diagnostics.push({
              code: "FIELD_TYPE_INVALID",
              severity: "warning",
              path: diagnosticPath,
              message: "A configured staged source field is not an attachment field",
            });
          }
        }
        const aliases = [
          subject.packageRoute?.packageAlias,
          ...Object.values(subject.packageRoute?.branchMap ?? {}),
        ].filter(Boolean);
        if (!subject.packageRoute?.packageAlias) diagnostics.push({
          code: "PACKAGE_ALIAS_REQUIRED", severity: "warning",
          path: `bases.${base.baseToken}.subjects.${subject.tableId}.packageRoute.packageAlias`,
          message: "此学科尚未选择剪辑包，请选择后再启用。",
        });
        if (packageSet) {
          for (const alias of aliases) {
            if (!packageSet.has(alias)) {
              diagnostics.push({
                code: "PACKAGE_ALIAS_UNAVAILABLE",
                severity: "error",
                path: `bases.${base.baseToken}.subjects.${subject.tableId}.packageRoute`,
                alias,
                message: `Auto-Cut package alias ${alias} is not configured on this Taskboard`,
              });
            }
          }
        }
        const sourcePath = currentConfig?.upload?.artifactSourcePath ?? null;
        const targetPath = currentConfig?.upload?.targetPath ?? null;
        if (["watch_directory", "driver_report"].includes(subject.upload?.artifactSourceMode) && !sourcePath) {
          diagnostics.push({
            code: "ARTIFACT_SOURCE_PATH_UNBOUND",
            severity: "warning",
            path: `bases.${base.baseToken}.subjects.${subject.tableId}.upload.artifactSourcePath`,
            message: "Artifact source path must be bound on this machine before upload can run",
          });
        }
        if (isPhasedSubject(subject)) {
          const legacyTargetPath = typeof targetPath === "string" && targetPath.trim() !== "" ? targetPath : null;
          for (const stageId of STAGE_IDS) {
            if (!subject.stages?.[stageId]?.enabled) continue;
            const localStage = currentConfig?.stages?.[stageId];
            const stageTargetPath = localStage?.artifactTargetPath ?? localStage?.artifact_target_path ?? null;
            // Import preserves each local stage binding, then fills empty
            // enabled stages from the existing common destination.
            if (stageTargetPath || legacyTargetPath) continue;
            diagnostics.push({
              code: "UPLOAD_TARGET_PATH_UNBOUND",
              severity: "warning",
              path: `bases.${base.baseToken}.subjects.${subject.tableId}.stages.${stageId}.artifactTargetPath`,
              message: "Stage upload target path must be bound on this machine before upload can run",
            });
          }
        } else if (subject.upload?.targetId && !targetPath) {
          diagnostics.push({
            code: "UPLOAD_TARGET_PATH_UNBOUND",
            severity: "warning",
            path: `bases.${base.baseToken}.subjects.${subject.tableId}.upload.targetPath`,
            message: "Upload target path must be bound on this machine before upload can run",
          });
        }
      }
    }
    return diagnostics;
  }

  function configurationFromCatalog(catalog) {
    return shareableConfiguration(catalog);
  }
  function getSubject(subjectKey) {
    const row = db.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ? AND removed_at IS NULL").get(subjectKey);
    if (!row) throw new ApiError(404, "SUBJECT_NOT_FOUND", `Subject '${subjectKey}' does not exist`);
    return row;
  }
  const selectProfile = db.prepare(`SELECT * FROM feishu_package_workflow_drafts
    WHERE subject_key = ? AND package_alias = ? AND template_id = 'document_draft_zip' AND template_version = 1`);

  function profileSubject(subject, config, packageAlias, { checkMetadata = false } = {}) {
    assertKeys(config, PACKAGE_PROFILE_KEYS, "config");
    for (const key of ["trigger", "title", "execution", "packageRoute", "upload"]) {
      if (!Object.hasOwn(config, key)) throw new ApiError(400, "INVALID_FIELD", `config.${key} is required`);
    }
    if (config.packageRoute?.packageAlias !== packageAlias) {
      throw new ApiError(409, "PACKAGE_WORKFLOW_MISMATCH", "Package route does not match the profile identity");
    }
    const identity = Object.fromEntries(Object.entries(subject).filter(([key]) => !PACKAGE_PROFILE_KEYS.has(key)));
    delete identity.workflowTemplate;
    delete identity.vmWorkflow;
    delete identity.enabledAt;
    delete identity.closedAt;
    const candidate = { ...identity, ...clone(config), lifecycle: "draft", metadata: checkMetadata ? subject.metadata : null };
    const normalized = checkMetadata
      ? validate(candidate, { projectLegacyTrigger: true, allowIncompleteBindings: true })
      : validateSubjectConfig(candidate, { projectLegacyTrigger: true });
    normalized.metadata = subject.metadata;
    return normalized;
  }

  function profileResponse(subject, packageAlias, row, defaultConfig = null) {
    let config = defaultConfig;
    if (row) {
      try { config = packageProfileConfig(profileSubject(subject, JSON.parse(row.config_json), packageAlias)); }
      catch { throw new ApiError(500, "PACKAGE_WORKFLOW_DRAFT_INVALID", "Saved package workflow draft is invalid"); }
    }
    return {
      subjectKey: subject.subjectKey, packageAlias, workflowTemplate: { ...ZIP_WORKFLOW_TEMPLATE },
      revision: row?.revision ?? 0, config, updatedAt: row?.updated_at ?? null,
    };
  }

  function writeProfile(subject, packageAlias, config, timestamp = now()) {
    const current = selectProfile.get(subject.subjectKey, packageAlias);
    if (current) profileResponse(subject, packageAlias, current);
    db.prepare(`INSERT INTO feishu_package_workflow_drafts
      (subject_key, package_alias, template_id, template_version, revision, config_json, updated_at)
      VALUES (?, ?, 'document_draft_zip', 1, ?, ?, ?)
      ON CONFLICT(subject_key, package_alias, template_id, template_version) DO UPDATE SET
        revision = excluded.revision, config_json = excluded.config_json, updated_at = excluded.updated_at`)
      .run(subject.subjectKey, packageAlias, (current?.revision ?? 0) + 1, JSON.stringify(config), timestamp);
    return profileResponse(subject, packageAlias, selectProfile.get(subject.subjectKey, packageAlias));
  }

  function preferEditingPackage(subjectKey, packageAlias, timestamp = now()) {
    db.prepare(`INSERT INTO feishu_subject_editing_preferences (subject_key, package_alias, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(subject_key) DO UPDATE SET package_alias = excluded.package_alias, updated_at = excluded.updated_at`)
      .run(subjectKey, packageAlias, timestamp);
  }

  function readProfile(subject, packageAlias) {
    const current = selectProfile.get(subject.subjectKey, packageAlias);
    if (current) return profileResponse(subject, packageAlias, current);
    // Recover the last snapshot for this alias, never the configuration of the
    // package currently selected on the subject. History remains immutable.
    const history = db.prepare("SELECT snapshot_json, created_at FROM feishu_subject_versions WHERE subject_key = ? ORDER BY version DESC").all(subject.subjectKey);
    for (const version of history) {
      let snapshot;
      try { snapshot = JSON.parse(version.snapshot_json); } catch {
        throw new ApiError(500, "PACKAGE_WORKFLOW_DRAFT_INVALID", "Saved package workflow history is invalid");
      }
      if (snapshot?.packageRoute?.packageAlias !== packageAlias || isVmSubject(snapshot)) continue;
      const config = packageProfileConfig(profileSubject(subject, packageProfileConfig(snapshot), packageAlias));
      return writeProfile(subject, packageAlias, config, version.created_at);
    }
    const { workflowTemplate: _template, vmWorkflow: _vmWorkflow, enabledAt: _enabledAt, closedAt: _closedAt, ...baseline } = subject;
    const fresh = phasedDefaultsForSubject({
      ...baseline, existing: null, lifecycle: "draft", validate: validateSubjectConfig,
    });
    fresh.packageRoute.packageAlias = packageAlias;
    fresh.execution.mode = "manual";
    return profileResponse(subject, packageAlias, null, packageProfileConfig(fresh));
  }

  function checkProfileRevision(profile, expectedRevision, { requireSaved = false } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ApiError(400, "INVALID_FIELD", "expectedRevision must be a non-negative integer");
    }
    if (expectedRevision !== profile.revision) {
      throw new ApiError(409, "VERSION_CONFLICT", "Package workflow draft was changed by another client", {
        expectedRevision, actualRevision: profile.revision,
      });
    }
    if (requireSaved && profile.revision === 0) throw new ApiError(409, "PACKAGE_WORKFLOW_DRAFT_UNSAVED", "Save the package workflow draft before enabling it");
  }

  function syncLegacyProfile(subject, timestamp, previousMetadata) {
    if (isVmSubject(subject)) return;
    const alias = subject.packageRoute?.packageAlias;
    if (!alias) return;
    let config = packageProfileConfig(subject);
    if (previousMetadata !== undefined) {
      const row = selectProfile.get(subject.subjectKey, alias);
      if (row) {
        const saved = profileResponse(subject, alias, row);
        const refreshed = clearDeletedMetadataBindings(
          profileSubject(subject, saved.config, alias), subject.metadata, previousMetadata,
        );
        config = packageProfileConfig(validateMetadataRefreshDraft(refreshed));
      }
    }
    writeProfile(subject, alias, config, timestamp);
  }

  function getBase(baseToken) {
    const row = db.prepare("SELECT * FROM feishu_bases WHERE base_token = ? AND removed_at IS NULL")
      .get(identifier(baseToken, "baseToken"));
    if (!row) throw new ApiError(404, "BASE_NOT_FOUND", "Feishu Base does not exist");
    return row;
  }
  function saveVersion(row, snapshot, version, timestamp) {
    const lifecycle = LIFECYCLES.has(snapshot?.lifecycle) ? snapshot.lifecycle : "draft";
    const timestampMs = Date.parse(timestamp);
    const enabledAt = Number.isSafeInteger(snapshot?.enabledAt)
      ? snapshot.enabledAt
      : lifecycle === "enabled" && Number.isFinite(timestampMs) ? timestampMs : null;
    const closedAt = Number.isSafeInteger(snapshot?.closedAt)
      ? snapshot.closedAt
      : lifecycle === "disabled" && Number.isFinite(timestampMs) ? timestampMs : null;
    if (lifecycle === "disabled") {
      db.prepare(`
        UPDATE feishu_subject_versions
        SET closed_at = COALESCE(closed_at, ?)
        WHERE subject_key = ? AND lifecycle = 'enabled' AND closed_at IS NULL
      `).run(Number.isFinite(timestampMs) ? timestampMs : null, row.subject_key);
    }
    if (lifecycle === "enabled") {
      db.prepare(`
        UPDATE feishu_subject_versions
        SET closed_at = COALESCE(closed_at, ?)
        WHERE subject_key = ? AND lifecycle = 'enabled' AND version < ? AND closed_at IS NULL
      `).run(Number.isFinite(timestampMs) ? timestampMs : null, row.subject_key, version);
    }
    db.prepare(`
      INSERT INTO feishu_subject_versions (
        subject_key, version, snapshot_json, lifecycle, enabled_at, closed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.subject_key, version, JSON.stringify(snapshot), lifecycle, enabledAt, closedAt, timestamp);
  }

  function snapshotForBridgeLifecycle(subject, currentRow) {
    if (subject.packageRoute?.packageAlias) return subject;
    // Unconfigured local drafts have never registered a Bridge route. A draft
    // may also deliberately clear its package while an older version remains
    // active; use that immutable routing identity only for disabling Bridge.
    if (subject.lifecycle !== "disabled") return null;
    const active = db.prepare(`SELECT snapshot_json FROM feishu_subject_versions
      WHERE subject_key=? AND lifecycle='enabled' AND closed_at IS NULL ORDER BY version DESC LIMIT 1`).get(subject.subjectKey);
    let previous = null;
    if (active) {
      try { previous = JSON.parse(active.snapshot_json); } catch {}
      if (!previous || previous.subjectKey !== subject.subjectKey || previous.lifecycle !== "enabled"
        || typeof previous.packageRoute?.packageAlias !== "string" || !previous.packageRoute.packageAlias.trim()) {
        throw new ApiError(409, "WORKFLOW_HISTORY_INVALID", "无法确认此前启用的流程身份，请先检查历史配置。");
      }
    }
    if (!previous) {
      if (!currentRow || requiresBridgeDisableBeforeRemoval(currentRow)) {
        throw new ApiError(409, "WORKFLOW_HISTORY_INVALID", "无法确认该学科是否已停用，请先检查历史配置。");
      }
      return null;
    }
    return { ...previous, lifecycle: "disabled", configVersion: subject.configVersion };
  }

  function requiresBridgeDisableBeforeRemoval(subject) {
    if (subject.lifecycle === "enabled") return true;
    if (subject.lifecycle !== "draft") return false;

    const versions = db.prepare(`SELECT version, snapshot_json FROM feishu_subject_versions
      WHERE subject_key = ? ORDER BY version`).all(subject.subject_key);
    if (versions.length !== subject.config_version) return true;

    // Only a complete draft-only history proves that Bridge never received this subject.
    let lastSyncedLifecycle = null;
    let latestLifecycle = null;
    for (const [index, version] of versions.entries()) {
      if (version.version !== index + 1) return true;
      try {
        const snapshot = JSON.parse(version.snapshot_json);
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
          || snapshot.configVersion !== version.version || !LIFECYCLES.has(snapshot.lifecycle)) {
          return true;
        }
        latestLifecycle = snapshot.lifecycle;
        if (snapshot.lifecycle !== "draft") lastSyncedLifecycle = snapshot.lifecycle;
      } catch {
        return true;
      }
    }
    if (latestLifecycle !== subject.lifecycle) return true;
    return lastSyncedLifecycle !== null && lastSyncedLifecycle !== "disabled";
  }

  return {
    async listCatalog() {
      return db.prepare("SELECT * FROM feishu_bases WHERE removed_at IS NULL ORDER BY base_name, base_token").all().map((row) => rowBase(db, row));
    },
    async packageAliases() {
      if (typeof packageAliases !== "function") return [];
      const aliases = await packageAliases();
      return Array.isArray(aliases) ? [...new Set(aliases)] : [];
    },
    async exportShareable() {
      const catalog = db.prepare("SELECT * FROM feishu_bases WHERE removed_at IS NULL ORDER BY base_name, base_token").all().map((row) => rowBase(db, row));
      return configurationFromCatalog(catalog);
    },
    async importShareable(value, { dryRun = false } = {}) {
      if (typeof dryRun !== "boolean") {
        throw new ApiError(400, "INVALID_FIELD", "dryRun must be boolean");
      }
      const configuration = validateShareDocument(value);
      const validatedAliases = new Set();
      if (typeof validatePackageWorkflow === "function") {
        for (const base of configuration.bases) {
          if (db.prepare("SELECT removed_at FROM feishu_bases WHERE base_token = ?").get(base.baseToken)?.removed_at) continue;
          for (const subject of base.subjects) {
            const existing = db.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(subject.subjectKey);
            if (existing?.removed_at || hasActiveShareImportVersion(existing)) continue;
            for (const alias of [
              subject.packageRoute?.packageAlias,
              ...Object.values(subject.packageRoute?.branchMap ?? {}),
            ]) {
              if (!alias || validatedAliases.has(alias)) continue;
              await validatePackageWorkflow(alias);
              validatedAliases.add(alias);
            }
          }
        }
      }
      const diagnostics = await shareDiagnostics(configuration);
      const diagnosticsOk = diagnostics.every((entry) => entry.severity !== "error");
      const draftConfiguration = shareableConfiguration(
        configuration.bases.map((base) => ({
          ...base,
          subjects: base.subjects.map((subject) => shareableSubject(subject, { forceDraft: true })),
        })),
        { forceDraft: true },
      );
      if (dryRun) {
        return { ...draftConfiguration, configuration: draftConfiguration, diagnostics, diagnosticsOk, dryRun: true };
      }
      const timestamp = now();
      const skippedEnabled = [];
      const skippedRemoved = [];
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const base of configuration.bases) {
          const existingBase = db.prepare("SELECT * FROM feishu_bases WHERE base_token = ?").get(base.baseToken);
          if (existingBase?.removed_at) {
            skippedRemoved.push(removedShareSkipDiagnostic(base));
            continue;
          }
          const localMetadataRefreshedAt = existingBase?.metadata_refreshed_at ?? null;
          db.prepare(`INSERT INTO feishu_bases
              (base_token, base_name, source_url_label, metadata_refreshed_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(base_token) DO UPDATE SET base_name=excluded.base_name,
                source_url_label=excluded.source_url_label,
                metadata_refreshed_at=excluded.metadata_refreshed_at,
                removed_at=NULL,
                updated_at=excluded.updated_at`)
            .run(base.baseToken, base.baseName, base.sourceUrlLabel ?? null, localMetadataRefreshedAt,
              existingBase?.created_at ?? timestamp, timestamp);
          for (const imported of base.subjects) {
            const existing = db.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(imported.subjectKey);
            if (existing?.removed_at) {
              skippedRemoved.push(removedShareSkipDiagnostic(base, imported));
              continue;
            }
            if (hasActiveShareImportVersion(existing)) {
              skippedEnabled.push(enabledSubjectSkipDiagnostic(imported));
              continue;
            }
            if (typeof validatePackageWorkflow === "function" && [
              imported.packageRoute?.packageAlias,
              ...Object.values(imported.packageRoute?.branchMap ?? {}),
            ].some((alias) => alias && !validatedAliases.has(alias))) {
              throw new ApiError(409, "VERSION_CONFLICT", "Subject changed during import; retry");
            }
            const local = existing ? rowSubject(existing) : null;
            const importedAlias = imported.packageRoute.packageAlias;
            const localProfile = local && importedAlias ? selectProfile.get(local.subjectKey, importedAlias) : null;
            const localBindings = localProfile
              ? profileResponse(local, importedAlias, localProfile).config
              : local?.packageRoute?.packageAlias === importedAlias
                ? local
                : local && importedAlias ? readProfile(local, importedAlias).config : null;
            const importedSubject = {
              ...imported,
              baseName: base.baseName,
              lifecycle: "draft",
              projectId: subjectProjectId(imported.subjectKey),
              configVersion: (existing?.config_version ?? 0) + 1,
              createdAt: existing?.created_at ?? timestamp,
              updatedAt: timestamp,
              // Shared files carry null paths. Preserve this alias's own local
              // bindings, including edits saved only in its independent profile.
              upload: {
                ...imported.upload,
                artifactSourcePath: localBindings?.upload?.artifactSourcePath ?? null,
                targetPath: localBindings?.upload?.targetPath ?? null,
              },
              ...(imported.delivery === undefined ? {} : {
                delivery: {
                  ...imported.delivery,
                  rootPath: localBindings?.delivery?.rootPath ?? null,
                },
              }),
              ...(imported.stages ? {
                stages: Object.fromEntries(STAGE_IDS.map((stageId) => {
                  const localStage = localBindings?.stages?.[stageId];
                  return [stageId, {
                    ...imported.stages[stageId],
                    artifactTargetPath: localStage?.artifactTargetPath
                      ?? localStage?.artifact_target_path
                      ?? null,
                  }];
                })),
              } : {}),
            };
            if (importedSubject.stages) {
              importedSubject.stages = projectLegacyUploadTarget(
                importedSubject.stages,
                importedSubject.upload,
              );
            }
            const next = validateSubjectConfig(
              isPendingPhasedDefaults(importedSubject)
                ? { ...importedSubject, metadata: null }
                : importedSubject,
            );
            // A share file's metadata is only a portable preview.  Once this
            // Taskboard has observed the subject, keep its local snapshot
            // authoritative so a warned stale field cannot self-validate on
            // the next Save or Enable action.
            const metadata = localMetadataForShareImport(local);
            next.metadata = metadata;
            if (existing) {
              db.prepare(`UPDATE feishu_subjects SET table_name=?, project_id=?, display_enabled=?, lifecycle='draft',
                config_version=?, config_json=?, metadata_json=?, removed_at=NULL, updated_at=? WHERE subject_key=?`)
                .run(next.tableName, next.projectId, next.displayEnabled ? 1 : 0, next.configVersion,
                  JSON.stringify(next), JSON.stringify(metadata), timestamp, next.subjectKey);
            } else {
              db.prepare(`INSERT INTO feishu_subjects
                (subject_key, base_token, table_id, table_name, project_id, display_enabled, lifecycle, config_version,
                 config_json, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`)
                .run(next.subjectKey, next.baseToken, next.tableId, next.tableName, next.projectId,
                  next.displayEnabled ? 1 : 0, next.configVersion, JSON.stringify(next), JSON.stringify(metadata), timestamp, timestamp);
            }
            db.prepare(`INSERT INTO projects
              (id, name, workspace_path, source, archived_at, next_task_number, created_at, updated_at)
              VALUES (?, ?, NULL, 'feishu', NULL, 1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name=excluded.name, source='feishu', updated_at=excluded.updated_at`)
              .run(next.projectId, next.tableName, timestamp, timestamp);
            database.syncSourceProjectArchived(next.projectId, false, "feishu", db);
            database.restoreSourceWorkflowState(next.subjectKey, db);
            saveVersion({ subject_key: next.subjectKey }, next, next.configVersion, timestamp);
            syncLegacyProfile(next, timestamp);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const catalog = db.prepare("SELECT * FROM feishu_bases WHERE removed_at IS NULL ORDER BY base_name, base_token").all().map((row) => rowBase(db, row));
      const resultConfiguration = configurationFromCatalog(catalog);
      const committedDiagnostics = [
        ...diagnostics.filter((entry) => !["ENABLED_SUBJECT_SKIPPED", "REMOVED_SUBJECT_SKIPPED", "REMOVED_BASE_SKIPPED"].includes(entry.code)),
        ...skippedEnabled,
        ...skippedRemoved,
      ];
      return {
        ...resultConfiguration,
        configuration: resultConfiguration,
        catalog,
        diagnostics: committedDiagnostics,
        diagnosticsOk: committedDiagnostics.every((entry) => entry.severity !== "error"),
        dryRun: false,
      };
    },
    async getSubject(subjectKey) {
      return subjectResponse(db, getSubject(parseSubjectKey(subjectKey).subjectKey));
    },
    async getPackageWorkflowProfile(subjectKey, packageAlias) {
      return readProfile(rowSubject(getSubject(parseSubjectKey(subjectKey).subjectKey)), packageAlias);
    },
    async savePackageWorkflowProfile(subjectKey, packageAlias, { expectedRevision, config }) {
      const key = parseSubjectKey(subjectKey).subjectKey;
      db.exec("BEGIN IMMEDIATE");
      try {
        const subject = rowSubject(getSubject(key));
        const profile = readProfile(subject, packageAlias);
        checkProfileRevision(profile, expectedRevision);
        const next = profileSubject(subject, config, packageAlias, { checkMetadata: true });
        assertStrictPhasedAttachments(next, { allowIncompleteBindings: true });
        assertDeliveryConfiguration(next, "draft");
        const saved = writeProfile(subject, packageAlias, packageProfileConfig(next));
        preferEditingPackage(key, packageAlias);
        db.exec("COMMIT");
        return saved;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async enablePackageWorkflowProfile(subjectKey, packageAlias, { expectedRevision, expectedVersion }) {
      return transition(subjectKey, expectedVersion, "enabled", { packageAlias, expectedRevision });
    },
    async enableVmPackageWorkflowProfile(subjectKey, packageAlias, request) {
      return activateVmProfile(subjectKey, packageAlias, request);
    },
    vmWorkflowActivationAvailable() {
      return typeof validateVmWorkflowActivation === "function" && typeof syncSubject === "function";
    },
    async getBase(baseToken) {
      return rowBase(db, getBase(baseToken));
    },
    async upsertBasePreview(preview, { refreshExistingOnly = false } = {}) {
      if (!preview || typeof preview !== "object" || Array.isArray(preview)) throw new ApiError(400, "INVALID_BODY", "Base preview must be an object");
      const baseToken = identifier(preview.baseToken, "baseToken");
      const baseName = requireText(preview.baseName, "baseName");
      if (!Array.isArray(preview.tables)) throw new ApiError(400, "INVALID_FIELD", "tables must be an array");
      if (typeof refreshExistingOnly !== "boolean") {
        throw new ApiError(400, "INVALID_FIELD", "refreshExistingOnly must be boolean");
      }
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const existingBase = db.prepare("SELECT * FROM feishu_bases WHERE base_token = ? AND removed_at IS NULL")
          .get(baseToken);
        if (refreshExistingOnly && !existingBase) {
          throw new ApiError(404, "BASE_NOT_FOUND", "Feishu Base does not exist");
        }
        const sourceUrlLabel = refreshExistingOnly
          ? existingBase.source_url_label
          : safeSourceUrlLabel(preview.sourceUrlLabel);
        db.prepare(`INSERT INTO feishu_bases (base_token, base_name, source_url_label, metadata_refreshed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(base_token) DO UPDATE SET base_name=excluded.base_name, source_url_label=excluded.source_url_label,
          metadata_refreshed_at=excluded.metadata_refreshed_at, removed_at=NULL, updated_at=excluded.updated_at`)
          .run(baseToken, baseName, sourceUrlLabel, preview.metadataRefreshedAt ?? null, timestamp, timestamp);
        for (const table of preview.tables) {
          const tableId = identifier(table.tableId, "tableId");
          const tableName = requireText(table.tableName, "tableName");
          const key = `${baseToken}:${tableId}`;
          const existing = db.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(key);
          // A manual metadata refresh is scoped to the current catalogue. It
          // must never add a new subject or restore one that was removed.
          if (refreshExistingOnly && (!existing || existing.removed_at !== null)) continue;
          const metadata = { fields: Array.isArray(table.fields) ? table.fields : [] };
          if (existing) {
            const existingConfig = rowSubject(existing);
            const namesChanged = existingConfig.baseName !== baseName || existingConfig.tableName !== tableName;
            const metadataChanged = JSON.stringify(existingConfig.metadata ?? {}) !== JSON.stringify(metadata);
            const phasedDefaultsNeeded = !isVmSubject(existingConfig) && (!hasCompletePhasedConfig(existingConfig)
              || (isPendingPhasedDefaults(existingConfig) && (namesChanged || metadataChanged)));
            if (namesChanged || metadataChanged || phasedDefaultsNeeded) {
              // A metadata refresh changes the configuration snapshot.  Keep
              // the Bridge's last enabled snapshot active until the operator
              // explicitly validates and re-enables the refreshed draft.
              const refreshedInput = {
                ...existingConfig,
                baseName,
                tableName,
                metadata,
                lifecycle: existingConfig.lifecycle === "enabled" ? "draft" : existingConfig.lifecycle,
                configVersion: existing.config_version + 1,
                updatedAt: timestamp,
              };
              const refreshedDraft = isVmSubject(existingConfig) ? refreshedInput
                : clearDeletedMetadataBindings(refreshedInput, metadata, existingConfig.metadata);
              let next = phasedDefaultsNeeded
                ? phasedDefaultsForSubject({
                  ...existingConfig,
                  baseToken,
                  baseName,
                  tableId,
                  tableName,
                  projectId: subjectProjectId(key),
                  subjectKey: key,
                  metadata,
                  previousMetadata: existingConfig.metadata,
                  existing: existingConfig,
                  lifecycle: existingConfig.lifecycle === "enabled" ? "draft" : existingConfig.lifecycle,
                  configVersion: existing.config_version + 1,
                  createdAt: existing.created_at,
                  updatedAt: timestamp,
                  validate,
                })
                : validateMetadataRefreshDraft(refreshedDraft);
              if (phasedDefaultsNeeded) {
                next = validateMetadataRefreshDraft(
                  clearDeletedMetadataBindings(next, metadata, existingConfig.metadata),
                );
              }
              // Refresh must retain missing IDs as a repairable draft.  Strict
              // metadata binding checks remain at save/enable; this pass only
              // validates the already-persisted configuration structurally.
              db.prepare(`UPDATE feishu_subjects
                SET table_name = ?, metadata_json = ?, lifecycle = ?, config_version = ?, config_json = ?, removed_at = NULL, updated_at = ?
                WHERE subject_key = ?`)
                .run(tableName, JSON.stringify(metadata), next.lifecycle, next.configVersion, JSON.stringify(next), timestamp, key);
              saveVersion({ subject_key: key }, next, next.configVersion, timestamp);
              syncLegacyProfile(next, timestamp, existingConfig.metadata);
            } else if (existing.removed_at !== null) {
              db.prepare("UPDATE feishu_subjects SET removed_at = NULL, updated_at = ? WHERE subject_key = ?")
                .run(timestamp, key);
            }
            db.prepare("UPDATE projects SET name = ?, source = 'feishu', updated_at = ? WHERE id = ?")
              .run(tableName, timestamp, subjectProjectId(key));
            database.syncSourceProjectArchived(subjectProjectId(key), false, "feishu", db);
            database.restoreSourceWorkflowState(key, db);
          } else {
            const initial = phasedDefaultsForSubject({
              subjectKey: key,
              baseToken,
              baseName,
              tableId,
              tableName,
              projectId: subjectProjectId(key),
              metadata,
              configVersion: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
              validate,
            });
            db.prepare(`INSERT INTO feishu_subjects
              (subject_key, base_token, table_id, table_name, project_id, display_enabled, lifecycle, config_version, config_json, metadata_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 0, 'draft', 1, ?, ?, ?, ?)`)
              .run(key, baseToken, tableId, tableName, subjectProjectId(key), JSON.stringify(initial), JSON.stringify(metadata), timestamp, timestamp);
            db.prepare(`INSERT INTO projects
              (id, name, workspace_path, source, archived_at, next_task_number, created_at, updated_at)
              VALUES (?, ?, NULL, 'feishu', NULL, 1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, source = 'feishu', updated_at = excluded.updated_at`)
              .run(subjectProjectId(key), tableName, timestamp, timestamp);
            database.syncSourceProjectArchived(subjectProjectId(key), false, "feishu", db);
            database.restoreSourceWorkflowState(key, db);
            saveVersion({ subject_key: key }, initial, 1, timestamp);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return rowBase(db, db.prepare("SELECT * FROM feishu_bases WHERE base_token = ?").get(baseToken));
    },
    async saveSubjectDraft(subjectKey, patch) {
      const key = parseSubjectKey(subjectKey).subjectKey;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ApiError(400, "INVALID_BODY", "Subject patch must be an object");
      for (const field of Object.keys(patch)) {
        if (!SUBJECT_PATCH_KEYS.has(field)) throw new ApiError(400, "UNKNOWN_FIELD", `Unknown subject field '${field}'`);
      }
      // This store owns the document/ZIP contract. Other package templates
      // keep their drafts separately and cannot replace this subject version.
      if (typeof validatePackageWorkflow === "function") {
        const alias = patch.packageRoute && Object.hasOwn(patch.packageRoute, "packageAlias")
          ? patch.packageRoute.packageAlias : rowSubject(getSubject(key)).packageRoute?.packageAlias;
        if (typeof alias === "string" && alias.trim()) await validatePackageWorkflow(alias);
      }
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = getSubject(key);
        if (patch.expectedVersion !== undefined
          && (!Number.isInteger(patch.expectedVersion) || patch.expectedVersion !== current.config_version)) {
          throw new ApiError(409, "VERSION_CONFLICT", "Subject was changed by another client", {
            expectedVersion: patch.expectedVersion,
            actualVersion: current.config_version,
          });
        }
        const { expectedVersion: _expectedVersion, ...rawChanges } = patch;
        let changes;
        try {
          changes = canonicalizePhasedSubjectPatch(rawChanges);
        } catch (error) {
          throw new ApiError(400, error.code ?? "INVALID_FIELD", error.message);
        }
        const currentConfig = rowSubject(current);
        const targetAlias = changes.packageRoute && Object.hasOwn(changes.packageRoute, "packageAlias")
          ? changes.packageRoute.packageAlias : currentConfig.packageRoute?.packageAlias;
        const savedProfile = targetAlias ? selectProfile.get(key, targetAlias) : null;
        const targetProfile = savedProfile
          ? profileResponse(currentConfig, targetAlias, savedProfile)
          : !targetAlias || targetAlias === currentConfig.packageRoute?.packageAlias ? null : readProfile(currentConfig, targetAlias);
        // Legacy PATCH still inherits untouched current-subject values when
        // routing to an alias never configured before. Existing profiles (or
        // recovered history) take precedence over that compatibility baseline.
        const editableBaseline = targetProfile?.revision > 0
          ? profileSubject(currentConfig, targetProfile.config, targetAlias)
          : currentConfig;
        const merged = {
          ...mergeObjects(editableBaseline, changes),
          subjectKey: key,
          baseToken: current.base_token,
          tableId: current.table_id,
          projectId: current.project_id,
          lifecycle: "draft",
          configVersion: current.config_version + 1,
        };
        const phasedPatch = ["statusField", "reviewStatusField", "documentField", "namingField", "stages"]
          .some((field) => Object.hasOwn(rawChanges, field));
        if (
          !phasedPatch
          && Object.hasOwn(rawChanges, "upload")
          && isPhasedSubject(merged)
          && typeof merged.upload.targetPath === "string"
          && merged.upload.targetPath.trim() !== ""
        ) {
          // Legacy clients know only one upload destination. Keep that local
          // path usable by both manual and automatic phased uploads.
          merged.stages = projectLegacyUploadTarget(merged.stages, merged.upload);
        }
        const next = validate(merged, { projectLegacyTrigger: Object.hasOwn(rawChanges, "stages"), allowIncompleteBindings: true });
        assertStrictPhasedAttachments(next, { allowIncompleteBindings: true });
        assertDeliveryConfiguration(next, "draft");
        db.prepare("UPDATE feishu_subjects SET lifecycle='draft', config_version=?, config_json=?, display_enabled=?, updated_at=? WHERE subject_key=?")
          .run(next.configVersion, JSON.stringify(next), next.displayEnabled === false ? 0 : 1, timestamp, key);
        saveVersion({ subject_key: key }, next, next.configVersion, timestamp);
        syncLegacyProfile(next, timestamp);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return subjectResponse(db, getSubject(key));
    },
    async setSubjectDisplayEnabled(subjectKey, displayEnabled) {
      const key = parseSubjectKey(subjectKey).subjectKey;
      if (typeof displayEnabled !== "boolean") {
        throw new ApiError(400, "INVALID_FIELD", "displayEnabled must be boolean");
      }
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = getSubject(key);
        const currentConfig = rowSubject(current);
        const nextConfig = { ...currentConfig, displayEnabled, updatedAt: timestamp };
        db.prepare("UPDATE feishu_subjects SET config_json=?, display_enabled=?, updated_at=? WHERE subject_key=?")
          .run(JSON.stringify(nextConfig), displayEnabled ? 1 : 0, timestamp, key);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return subjectResponse(db, getSubject(key));
    },
    async removeSubject(subjectKey) {
      const key = parseSubjectKey(subjectKey).subjectKey;
      const current = getSubject(key);
      await removeSubjectRows([current]);
      return this.listCatalog();
    },
    async removeBase(baseTokenValue) {
      const baseToken = identifier(baseTokenValue, "baseToken");
      const base = db.prepare("SELECT * FROM feishu_bases WHERE base_token = ? AND removed_at IS NULL").get(baseToken);
      if (!base) throw new ApiError(404, "BASE_NOT_FOUND", `Base '${baseToken}' does not exist`);
      const subjects = db.prepare("SELECT * FROM feishu_subjects WHERE base_token = ? AND removed_at IS NULL ORDER BY subject_key").all(baseToken);
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const lockedSubjects = db.prepare("SELECT * FROM feishu_subjects WHERE base_token = ? AND removed_at IS NULL ORDER BY subject_key").all(baseToken);
        if (lockedSubjects.length !== subjects.length
          || lockedSubjects.some((subject, index) => (
            subject.subject_key !== subjects[index]?.subject_key
            || subject.config_version !== subjects[index]?.config_version
          ))) {
          throw new ApiError(409, "VERSION_CONFLICT", "A subject changed while the Base was being removed");
        }
        await removeSubjectRows(lockedSubjects, timestamp, false);
        const removed = db.prepare("UPDATE feishu_bases SET removed_at = ?, updated_at = ? WHERE base_token = ? AND removed_at IS NULL")
          .run(timestamp, timestamp, baseToken);
        if (removed.changes !== 1) {
          throw new ApiError(409, "VERSION_CONFLICT", "The Base changed while it was being removed");
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return this.listCatalog();
    },
    async enableSubject(subjectKey, expectedVersion) { return transition(subjectKey, expectedVersion, "enabled"); },
    async disableSubject(subjectKey, expectedVersion) { return transition(subjectKey, expectedVersion, "disabled"); },
  };

  async function removeSubjectRows(subjects, timestamp = now(), manageTransaction = true) {
    if (manageTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      for (const subject of subjects) {
        let locked = getSubject(subject.subject_key);
        if (locked.config_version !== subject.config_version) {
          throw new ApiError(409, "VERSION_CONFLICT", "Subject changed while it was being removed", {
            expectedVersion: subject.config_version,
            actualVersion: locked.config_version,
          });
        }
        if (locked.lifecycle !== "disabled") {
          const expectedVersion = locked.config_version;
          const disabled = validateLifecycleSnapshot({
            ...rowSubject(locked),
            subjectKey: locked.subject_key,
            baseToken: locked.base_token,
            tableId: locked.table_id,
            projectId: locked.project_id,
            lifecycle: "disabled",
            configVersion: expectedVersion + 1,
          });
          if (requiresBridgeDisableBeforeRemoval(locked) && typeof syncSubject === "function") {
            const bridgeSnapshot = snapshotForBridgeLifecycle(disabled, locked);
            if (bridgeSnapshot) await syncSubject(bridgeSnapshot, { lifecycle: "disabled", expectedVersion });
          }
          const transitioned = db.prepare(`UPDATE feishu_subjects
            SET lifecycle='disabled', config_version=?, config_json=?, updated_at=?
            WHERE subject_key=? AND config_version=? AND removed_at IS NULL`)
            .run(disabled.configVersion, JSON.stringify(disabled), timestamp, locked.subject_key, expectedVersion);
          if (transitioned.changes !== 1) {
            throw new ApiError(409, "VERSION_CONFLICT", "Subject changed while it was being removed", {
              expectedVersion,
              actualVersion: getSubject(locked.subject_key).config_version,
            });
          }
          saveVersion({ subject_key: locked.subject_key }, disabled, disabled.configVersion, timestamp);
          locked = getSubject(locked.subject_key);
        }
        const next = { ...rowSubject(locked), displayEnabled: false, updatedAt: timestamp };
        const removed = db.prepare(`UPDATE feishu_subjects
          SET display_enabled=0, config_json=?, removed_at=?, updated_at=?
          WHERE subject_key=? AND config_version=? AND lifecycle='disabled' AND removed_at IS NULL`)
          .run(JSON.stringify(next), timestamp, timestamp, locked.subject_key, locked.config_version);
        if (removed.changes !== 1) {
          throw new ApiError(409, "VERSION_CONFLICT", "Subject changed while it was being removed", {
            expectedVersion: locked.config_version,
            actualVersion: locked.config_version,
          });
        }
        database.syncSourceProjectArchived(locked.project_id, true, "feishu", db);
        database.freezeSourceWorkflowState(locked.subject_key, db);
      }
      if (manageTransaction) db.exec("COMMIT");
    } catch (error) {
      if (manageTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  async function transition(subjectKey, expectedVersion, lifecycle, profileRequest = null) {
    const key = parseSubjectKey(subjectKey).subjectKey;
    const current = getSubject(key);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== current.config_version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Subject was changed by another client", { expectedVersion, actualVersion: current.config_version });
    }
    const currentSubject = rowSubject(current);
    if (isVmSubject(currentSubject) && !profileRequest && lifecycle === "enabled") {
      throw new ApiError(409, "PACKAGE_WORKFLOW_DRAFT_REQUIRED", "Enable a saved VM package workflow profile");
    }
    const profile = profileRequest ? readProfile(currentSubject, profileRequest.packageAlias) : null;
    if (profile) checkProfileRevision(profile, profileRequest.expectedRevision, { requireSaved: true });
    const currentConfig = profile ? profileSubject(currentSubject, profile.config, profileRequest.packageAlias) : currentSubject;
    if (lifecycle === "enabled") {
      if (typeof currentConfig.packageRoute?.packageAlias !== "string" || !currentConfig.packageRoute.packageAlias.trim()) {
        throw new ApiError(409, "PACKAGE_ALIAS_REQUIRED", "请选择剪辑包后再启用学科流程");
      }
      if (typeof validatePackageWorkflow === "function") {
        await validatePackageWorkflow(currentConfig.packageRoute.packageAlias);
      }
      assertStrictPhasedAttachments(currentConfig);
      assertPhasedNamingField(currentConfig);
      assertTriggerMetadata(currentConfig);
      await assertPackageAlias(currentConfig.packageRoute.packageAlias);
      if (
        currentConfig.upload.artifactSourceMode === "driver_report"
        && !(typeof currentConfig.upload.artifactSourcePath === "string" && currentConfig.upload.artifactSourcePath.trim())
      ) {
        throw new ApiError(
          409,
          "ARTIFACT_SOURCE_PATH_UNBOUND",
          "Set a ZIP artifact source path before enabling driver reporting",
        );
      }
      if (
        currentConfig.upload.enqueueMode === "automatic"
        && !isPhasedSubject(currentConfig)
        && !(typeof currentConfig.upload.targetPath === "string" && currentConfig.upload.targetPath.trim())
      ) {
        throw new ApiError(
          409,
          "UPLOAD_TARGET_NOT_CONFIGURED",
          "Set an upload destination before enabling automatic upload",
        );
      }
    }
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const locked = getSubject(key);
      if (locked.config_version !== expectedVersion) {
        throw new ApiError(409, "VERSION_CONFLICT", "Subject was changed by another client", {
          expectedVersion,
          actualVersion: locked.config_version,
        });
      }
      const lockedSubject = rowSubject(locked);
      const lockedProfile = profileRequest ? readProfile(lockedSubject, profileRequest.packageAlias) : null;
      if (lockedProfile) checkProfileRevision(lockedProfile, profileRequest.expectedRevision, { requireSaved: true });
      const lifecycleCandidate = {
        ...(lockedProfile ? profileSubject(lockedSubject, lockedProfile.config, profileRequest.packageAlias) : lockedSubject),
        subjectKey: key,
        baseToken: locked.base_token,
        tableId: locked.table_id,
        projectId: locked.project_id,
        lifecycle,
        configVersion: locked.config_version + 1,
      };
      // Pending sentinels are a draft/cleanup compatibility mechanism only.
      // Enabling always validates the real metadata snapshot so an unresolved
      // subject can never become active or reach Bridge synchronization.
      const next = lifecycle === "enabled"
        ? validate(lifecycleCandidate, { projectLegacyTrigger: true })
        : validateLifecycleSnapshot(lifecycleCandidate);
      if (lifecycle === "enabled") assertDeliveryConfiguration(next, "activation");
      if (typeof syncSubject === "function") {
        // Keep the local transaction open until Bridge accepts the same
        // validated snapshot.  A failed loopback sync rolls back the local
        // lifecycle transition and leaves the subject as a draft/previous
        // state.
        const bridgeSnapshot = snapshotForBridgeLifecycle(next, locked);
        if (bridgeSnapshot) await syncSubject(bridgeSnapshot, { lifecycle, expectedVersion });
      }
      db.prepare("UPDATE feishu_subjects SET lifecycle=?, config_version=?, config_json=?, updated_at=? WHERE subject_key=? AND config_version=?")
        .run(lifecycle, next.configVersion, JSON.stringify(next), timestamp, key, expectedVersion);
      saveVersion({ subject_key: key }, next, next.configVersion, timestamp);
      if (lifecycle === "enabled") preferEditingPackage(key, next.packageRoute.packageAlias, timestamp);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return subjectResponse(db, getSubject(key));
  }

  function vmProfileCandidate(row, packageAlias, expectedRevision) {
    const saved = db.prepare(`SELECT * FROM feishu_package_workflow_drafts
      WHERE subject_key = ? AND package_alias = ? AND template_id = 'vm_pmo_review_video' AND template_version = 1`)
      .get(row.subject_key, packageAlias);
    checkProfileRevision({ revision: saved?.revision ?? 0 }, expectedRevision, { requireSaved: true });
    const subject = rowSubject(row);
    let config;
    try { config = normalizeVmPackageWorkflowConfig(JSON.parse(saved.config_json), subject.metadata).config; }
    catch (error) { throw new ApiError(409, error.code ?? "VM_WORKFLOW_NOT_READY", "VM workflow fields must be repaired before activation"); }
    const stage = config.stages.initial;
    if (stage.enabled !== true || config.stages.review.enabled !== false || config.finalArchive.enabled !== false
      || [config.fields.vmidFieldId, config.fields.namingFieldId, config.fields.outputAttachmentFieldId,
        stage.statusFieldId, stage.triggerOptionId, stage.instructionFieldId].some((value) => !value)
      || !config.approval.department || !config.approval.reason) {
      throw new ApiError(409, "VM_WORKFLOW_NOT_READY", "Only a fully configured initial VM workflow is available");
    }
    const status = subject.metadata.fields.find((field) => field.fieldId === stage.statusFieldId);
    if (!isSingleSelectMetadataField(status)) throw new ApiError(409, "VM_WORKFLOW_NOT_READY", "Initial VM workflow requires a single-select trigger");
    const naming = subject.metadata.fields.find((field) => field.fieldId === config.fields.namingFieldId);
    return validateVmSubject({
      subjectKey: subject.subjectKey, baseToken: subject.baseToken, baseName: subject.baseName,
      tableId: subject.tableId, tableName: subject.tableName, projectId: subject.projectId,
      displayEnabled: subject.displayEnabled, lifecycle: "enabled", configVersion: subject.configVersion + 1,
      createdAt: subject.createdAt, updatedAt: now(), workflowTemplate: { ...VM_WORKFLOW_TEMPLATE },
      title: { fieldId: naming.fieldId, fieldName: naming.fieldName },
      execution: { mode: "automatic", concurrencyGroup: packageAlias, maxConcurrent: 1, resourceGroups: [] },
      packageRoute: { routeMode: "fixed", packageAlias, subjectCodeFieldId: null, branchMap: null },
      statusField: { fieldId: status.fieldId, fieldName: status.fieldName, type: "single_select",
        options: status.options.map((option) => ({ optionId: option.id, value: option.name })) },
      vmWorkflow: config, metadata: clone(subject.metadata),
    });
  }

  async function activateVmProfile(subjectKey, packageAlias, { expectedRevision, expectedVersion } = {}) {
    if (typeof validateVmWorkflowActivation !== "function" || typeof syncSubject !== "function") {
      throw new ApiError(409, "PACKAGE_WORKFLOW_NOT_READY", "VM runtime and Bridge validation must be available before activation");
    }
    const key = parseSubjectKey(subjectKey).subjectKey;
    const current = getSubject(key);
    const assertVersion = (row) => {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== row.config_version) {
        throw new ApiError(409, "VERSION_CONFLICT", "Subject was changed by another client", {
          expectedVersion, actualVersion: row.config_version,
        });
      }
    };
    assertVersion(current);
    const candidate = vmProfileCandidate(current, packageAlias, expectedRevision);
    await assertPackageAlias(packageAlias);
    if (await validateVmWorkflowActivation({ subject: clone(candidate), packageAlias, config: clone(candidate.vmWorkflow) }) !== true) {
      throw new ApiError(409, "PACKAGE_WORKFLOW_NOT_READY", "VM runtime is not ready for activation");
    }
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const locked = getSubject(key);
      assertVersion(locked);
      const next = vmProfileCandidate(locked, packageAlias, expectedRevision);
      next.updatedAt = Date.parse(timestamp);
      // The Bridge revalidates these exact field/option IDs against live Feishu
      // metadata before the local transaction can publish the active version.
      await syncSubject(next, { lifecycle: "enabled", expectedVersion });
      const changed = db.prepare(`UPDATE feishu_subjects SET lifecycle='enabled', config_version=?, config_json=?, updated_at=?
        WHERE subject_key=? AND config_version=? AND removed_at IS NULL`)
        .run(next.configVersion, JSON.stringify(next), timestamp, key, expectedVersion);
      if (changed.changes !== 1) throw new ApiError(409, "VERSION_CONFLICT", "Subject changed during VM activation");
      saveVersion({ subject_key: key }, next, next.configVersion, timestamp);
      preferEditingPackage(key, packageAlias, timestamp);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return subjectResponse(db, getSubject(key));
  }
}
