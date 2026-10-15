import { ApiError } from "./database.mjs";
import {
  isAttachmentMetadataField,
  isSingleSelectMetadataField,
} from "./feishu-workflow-stages.mjs";
import { normalizePackageWorkflowTemplate } from "../shared/feishu-package-workflow.mjs";
import { normalizeCourseRootPath } from "./feishu-course-path.mjs";

const TEMPLATE_ID = "vm_pmo_review_video";
const TEMPLATE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const STAGE_IDS = ["initial", "review"];
const LEGACY_STAGE_IDS = ["initial", "first_review", "final_review"];
const FIELD_KEYS = ["vmidFieldId", "outputAttachmentFieldId", "namingFieldId"];
const LEGACY_FIELD_KEYS = [
  "vmidFieldId", "keepSegmentsFieldId", "reviewTextFieldId",
  "reviewAttachmentsFieldId", "outputAttachmentFieldId",
];

function assertShape(value, keys, name, optionalKeys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_FIELD", `${name} must be an object`);
  }
  const allowed = new Set([...keys, ...optionalKeys]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ApiError(400, "UNKNOWN_FIELD", `${name} contains an unsupported field`);
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    throw new ApiError(400, "INVALID_FIELD", `${name} is incomplete`);
  }
}

function optionalIdentifier(value, name) {
  if (value === null) return null;
  if (typeof value !== "string" || !ID_PATTERN.test(value.trim())) {
    throw new ApiError(400, "INVALID_FIELD", `${name} must be a field or option identifier, or null`);
  }
  return value.trim();
}

function draftText(value, name, maxLength) {
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new ApiError(400, "INVALID_FIELD", `${name} is invalid`);
  }
  return value.trim();
}

function isTextField(field) {
  const hasType = field.type !== null && field.type !== undefined && field.type !== "";
  const hasUiType = field.uiType !== null && field.uiType !== undefined && field.uiType !== "";
  if (!hasType && !hasUiType) return false;
  if (hasType && ![1, "1"].includes(field.type)) return false;
  if (hasUiType && (typeof field.uiType !== "string" || field.uiType.trim().toLowerCase() !== "text")) return false;
  return true;
}

function isFormulaField(field) {
  const hasType = field.type !== null && field.type !== undefined && field.type !== "";
  const hasUiType = field.uiType !== null && field.uiType !== undefined && field.uiType !== "";
  if (!hasType && !hasUiType) return false;
  if (hasType && ![20, "20"].includes(field.type)) return false;
  if (hasUiType && (typeof field.uiType !== "string" || field.uiType.trim().toLowerCase() !== "formula")) return false;
  return true;
}

function isNamingField(field) {
  return isTextField(field) || isFormulaField(field);
}

function isMultiSelectField(field) {
  const hasType = field.type !== null && field.type !== undefined && field.type !== "";
  const hasUiType = field.uiType !== null && field.uiType !== undefined && field.uiType !== "";
  if (!hasType && !hasUiType) return false;
  if (hasType && ![4, "4"].includes(field.type)) return false;
  if (hasUiType && (typeof field.uiType !== "string"
    || field.uiType.trim().toLowerCase().replace(/[\s_-]/gu, "") !== "multiselect")) return false;
  return true;
}

function isProgressField(field) {
  return isSingleSelectMetadataField(field) || isMultiSelectField(field);
}

function validateMetadataField(metadata, id, predicate, name) {
  if (id === null) return null;
  const matches = (Array.isArray(metadata?.fields) ? metadata.fields : [])
    .filter((field) => field?.fieldId === id);
  if (matches.length !== 1 || !predicate(matches[0])) {
    throw new ApiError(400, "INVALID_FIELD", `${name} must refer to one available field of the expected type`);
  }
  return matches[0];
}

function validateMetadataOption(field, optionId, name) {
  if (optionId !== null && (!Array.isArray(field?.options)
    || field.options.filter((option) => option?.id === optionId).length !== 1)) {
    throw new ApiError(400, "INVALID_FIELD", `${name} must refer to one available option`);
  }
}

function emptyWriteback() {
  return {
    processing: { fieldId: null, optionId: null },
    completed: { fieldId: null, optionId: null },
  };
}

function emptyFinalArchive() {
  return {
    enabled: false, statusFieldId: null, triggerOptionId: null,
    pathSource: "manual", directoryPath: null, pathFieldId: null,
  };
}

function normalizeArchiveDirectory(value, name) {
  if (value === null) return null;
  try { return normalizeCourseRootPath(value); } catch {
    throw new ApiError(400, "INVALID_FIELD", `${name} must be an absolute Windows drive or UNC path`);
  }
}

function normalizeFinalArchive(value, sharedNaming, allowLegacyArchive) {
  const name = "config.finalArchive";
  const legacyArchive = allowLegacyArchive && value && typeof value === "object"
    && ["rootPath", "courseNameFieldId"].some((key) => Object.hasOwn(value, key));
  const pathKeys = legacyArchive ? ["rootPath", "courseNameFieldId"] : ["pathSource", "directoryPath", "pathFieldId"];
  assertShape(value, ["enabled", "statusFieldId", "triggerOptionId", ...pathKeys], name,
    sharedNaming ? [] : ["namingFieldId"]);
  if (typeof value.enabled !== "boolean") throw new ApiError(400, "INVALID_FIELD", `${name}.enabled must be boolean`);
  const archive = { enabled: value.enabled };
  for (const key of ["statusFieldId", "triggerOptionId"]) {
    archive[key] = optionalIdentifier(value[key], `${name}.${key}`);
  }
  if (Object.hasOwn(value, "namingFieldId")) {
    archive.namingFieldId = optionalIdentifier(value.namingFieldId, `${name}.namingFieldId`);
  }
  let legacyArchivePathNeedsReview = false;
  if (legacyArchive) {
    // The old root is only a parent directory. Reading must not silently turn
    // it into the new complete archive destination or rewrite the saved row.
    const oldRoot = normalizeArchiveDirectory(value.rootPath, `${name}.rootPath`);
    const oldCourseField = optionalIdentifier(value.courseNameFieldId, `${name}.courseNameFieldId`);
    legacyArchivePathNeedsReview = oldRoot !== null || oldCourseField !== null;
    Object.assign(archive, { pathSource: "manual", directoryPath: null, pathFieldId: null });
  } else {
    if (!["manual", "pmo_field"].includes(value.pathSource)) {
      throw new ApiError(400, "INVALID_FIELD", `${name}.pathSource must be manual or pmo_field`);
    }
    archive.pathSource = value.pathSource;
    archive.directoryPath = normalizeArchiveDirectory(value.directoryPath, `${name}.directoryPath`);
    archive.pathFieldId = optionalIdentifier(value.pathFieldId, `${name}.pathFieldId`);
  }
  if (archive.triggerOptionId !== null && archive.statusFieldId === null) {
    throw new ApiError(400, "INVALID_FIELD", `${name}.triggerOptionId requires a status field`);
  }
  const selectedPathKey = archive.pathSource === "manual" ? "directoryPath" : "pathFieldId";
  if (archive.enabled && !legacyArchivePathNeedsReview && ["statusFieldId", "triggerOptionId", selectedPathKey]
    .some((key) => archive[key] === null)) {
    throw new ApiError(400, "INVALID_FIELD", `${name} requires complete bindings when enabled`);
  }
  return { archive, legacyArchivePathNeedsReview };
}

function normalizeWriteback(value, metadata, name) {
  assertShape(value, ["processing", "completed"], name);
  const writeback = {};
  for (const state of ["processing", "completed"]) {
    const binding = value[state];
    const bindingName = `${name}.${state}`;
    assertShape(binding, ["fieldId", "optionId"], bindingName);
    const fieldId = optionalIdentifier(binding.fieldId, `${bindingName}.fieldId`);
    const optionId = optionalIdentifier(binding.optionId, `${bindingName}.optionId`);
    if (optionId !== null && fieldId === null) {
      throw new ApiError(400, "INVALID_FIELD", `${bindingName}.optionId requires a writeback field`);
    }
    if (metadata !== undefined) {
      const field = validateMetadataField(metadata, fieldId, isSingleSelectMetadataField, `${bindingName}.fieldId`);
      validateMetadataOption(field, optionId, `${bindingName}.optionId`);
    }
    writeback[state] = { fieldId, optionId };
  }
  return writeback;
}

function normalizeStage(stage, stageId, legacy, sharedNaming) {
  const name = `config.stages.${stageId}`;
  const keys = ["enabled", "statusFieldId", "triggerOptionId"];
  if (!legacy) keys.push("instructionFieldId");
  if (!legacy && stageId === "review") keys.push("instructionAttachmentsFieldId");
  assertShape(stage, keys, name, ["writeback", ...(legacy ? ["instructionFieldId"] : []),
    ...(sharedNaming ? [] : ["namingFieldId"])]);
  if (typeof stage.enabled !== "boolean") throw new ApiError(400, "INVALID_FIELD", `${name}.enabled must be boolean`);
  const statusFieldId = optionalIdentifier(stage.statusFieldId, `${name}.statusFieldId`);
  const triggerOptionId = optionalIdentifier(stage.triggerOptionId, `${name}.triggerOptionId`);
  const instructionFieldId = Object.hasOwn(stage, "instructionFieldId")
    ? optionalIdentifier(stage.instructionFieldId, `${name}.instructionFieldId`) : null;
  if (triggerOptionId !== null && statusFieldId === null) {
    throw new ApiError(400, "INVALID_FIELD", `${name}.triggerOptionId requires a status field`);
  }
  const normalized = {
    enabled: stage.enabled, statusFieldId, triggerOptionId, instructionFieldId,
    ...(Object.hasOwn(stage, "namingFieldId")
      ? { namingFieldId: optionalIdentifier(stage.namingFieldId, `${name}.namingFieldId`) } : {}),
    writeback: Object.hasOwn(stage, "writeback")
      ? normalizeWriteback(stage.writeback, undefined, `${name}.writeback`) : emptyWriteback(),
  };
  if (!legacy && stageId === "review") {
    normalized.instructionAttachmentsFieldId = optionalIdentifier(stage.instructionAttachmentsFieldId, `${name}.instructionAttachmentsFieldId`);
  }
  return normalized;
}

function hasStageBindings(stage) {
  return stage.statusFieldId !== null || stage.triggerOptionId !== null || stage.instructionFieldId !== null
    || Object.values(stage.writeback).some((target) => target.fieldId !== null || target.optionId !== null);
}

function validateConfigMetadata(config, metadata) {
  validateMetadataField(metadata, config.fields.vmidFieldId, isTextField, "config.fields.vmidFieldId");
  validateMetadataField(metadata, config.fields.outputAttachmentFieldId, isAttachmentMetadataField, "config.fields.outputAttachmentFieldId");
  validateMetadataField(metadata, config.fields.namingFieldId, isNamingField, "config.fields.namingFieldId");
  for (const stageId of STAGE_IDS) {
    const stage = config.stages[stageId];
    const name = `config.stages.${stageId}`;
    const field = validateMetadataField(metadata, stage.statusFieldId, isProgressField, `${name}.statusFieldId`);
    validateMetadataOption(field, stage.triggerOptionId, `${name}.triggerOptionId`);
    validateMetadataField(metadata, stage.instructionFieldId, isTextField, `${name}.instructionFieldId`);
    if (stageId === "review") {
      validateMetadataField(metadata, stage.instructionAttachmentsFieldId, isAttachmentMetadataField, `${name}.instructionAttachmentsFieldId`);
    }
    normalizeWriteback(stage.writeback, metadata, `${name}.writeback`);
  }
  const archive = config.finalArchive;
  const field = validateMetadataField(metadata, archive.statusFieldId, isProgressField, "config.finalArchive.statusFieldId");
  validateMetadataOption(field, archive.triggerOptionId, "config.finalArchive.triggerOptionId");
  if (archive.pathSource === "pmo_field") {
    validateMetadataField(metadata, archive.pathFieldId, isNamingField, "config.finalArchive.pathFieldId");
  }
}

function normalizeConfig(value, metadata = undefined, { allowLegacyArchive = false } = {}) {
  assertShape(value, ["fields", "approval", "stages"], "config", ["finalArchive"]);
  const legacy = Boolean(value.stages && typeof value.stages === "object"
    && LEGACY_STAGE_IDS.slice(1).some((stageId) => Object.hasOwn(value.stages, stageId)));
  const fieldKeys = legacy ? LEGACY_FIELD_KEYS : FIELD_KEYS.filter((key) => key !== "namingFieldId");
  const stageIds = legacy ? LEGACY_STAGE_IDS : STAGE_IDS;
  assertShape(value.fields, fieldKeys, "config.fields", ["namingFieldId"]);
  const sharedNaming = Object.hasOwn(value.fields, "namingFieldId");
  assertShape(value.approval, ["department", "reason"], "config.approval");
  assertShape(value.stages, stageIds, "config.stages");
  // Validate every old binding's structure and identifier before discarding it.
  const fields = Object.fromEntries(fieldKeys.map((key) => [key, optionalIdentifier(value.fields[key], `config.fields.${key}`)]));
  fields.namingFieldId = sharedNaming ? optionalIdentifier(value.fields.namingFieldId, "config.fields.namingFieldId") : null;
  const stages = Object.fromEntries(stageIds.map((stageId) => [stageId, normalizeStage(value.stages[stageId], stageId, legacy, sharedNaming)]));
  const approval = {
    department: draftText(value.approval.department, "config.approval.department", 200),
    reason: draftText(value.approval.reason, "config.approval.reason", 2000),
  };
  const { archive: finalArchive, legacyArchivePathNeedsReview = false } = Object.hasOwn(value, "finalArchive")
    ? normalizeFinalArchive(value.finalArchive, sharedNaming, allowLegacyArchive) : { archive: emptyFinalArchive() };
  // Legacy names are validated structurally above, then merged across all old
  // stages and the archive before only the retained field checks live metadata.
  const legacyNames = new Set([...Object.values(stages).map((stage) => stage.namingFieldId), finalArchive.namingFieldId]
    .filter((id) => id !== null && id !== undefined));
  const legacyNamingConflict = !sharedNaming && legacyNames.size > 1;
  if (!sharedNaming && legacyNames.size === 1) fields.namingFieldId = [...legacyNames][0];
  for (const stage of Object.values(stages)) delete stage.namingFieldId;
  delete finalArchive.namingFieldId;
  if (finalArchive.enabled && fields.namingFieldId === null
    && !((legacyNamingConflict || legacyArchivePathNeedsReview) && metadata === undefined)) {
    throw new ApiError(400, "INVALID_FIELD", "config.finalArchive requires a shared naming binding when enabled");
  }
  let legacyReviewStage;
  let config = { fields, approval, stages, finalArchive };
  if (legacy) {
    legacyReviewStage = stages.first_review.enabled ? "first_review"
      : stages.final_review.enabled ? "final_review"
        : hasStageBindings(stages.first_review) ? "first_review" : "final_review";
    const review = stages[legacyReviewStage];
    config = {
      fields: { vmidFieldId: fields.vmidFieldId, outputAttachmentFieldId: fields.outputAttachmentFieldId, namingFieldId: fields.namingFieldId },
      approval,
      finalArchive,
      stages: {
        initial: { ...stages.initial, instructionFieldId: stages.initial.instructionFieldId ?? fields.keepSegmentsFieldId },
        review: {
          ...review, instructionFieldId: review.instructionFieldId ?? fields.reviewTextFieldId,
          instructionAttachmentsFieldId: fields.reviewAttachmentsFieldId,
        },
      },
    };
  }
  if (finalArchive.enabled && STAGE_IDS.some((stageId) => {
    const stage = config.stages[stageId];
    return stage.enabled && stage.statusFieldId === finalArchive.statusFieldId
      && stage.triggerOptionId === finalArchive.triggerOptionId;
  })) {
    throw new ApiError(400, "INVALID_FIELD", "config.finalArchive must use a different trigger from enabled editing stages");
  }
  // Only the bindings retained by the canonical draft must still exist in Feishu.
  if (metadata !== undefined) validateConfigMetadata(config, metadata);
  return { config, ...(legacyReviewStage ? { legacyReviewStage } : {}),
    ...(legacyNamingConflict ? { legacyNamingConflict: true } : {}),
    ...(legacyArchivePathNeedsReview ? { legacyArchivePathNeedsReview: true } : {}) };
}

export { normalizeConfig as normalizeVmPackageWorkflowConfig };

function defaultConfig() {
  return {
    fields: Object.fromEntries(FIELD_KEYS.map((key) => [key, null])),
    approval: { department: "动画组", reason: "切片剪辑" },
    stages: Object.fromEntries(STAGE_IDS.map((stageId) => [stageId, {
      enabled: stageId === "initial", statusFieldId: null, triggerOptionId: null,
      instructionFieldId: null, writeback: emptyWriteback(),
      ...(stageId === "review" ? { instructionAttachmentsFieldId: null } : {}),
    }])),
    finalArchive: emptyFinalArchive(),
  };
}

function decodedSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 600 || /[\u0000-\u001f\u007f]/u.test(decoded)) throw new Error("invalid");
    return decoded;
  } catch {
    throw new ApiError(400, "INVALID_PATH", "Workflow draft identity is invalid");
  }
}

/** Saving profiles never replaces an active subject; ZIP activation is explicit. */
export function createFeishuPackageWorkflowDrafts({ database, packageStore, workflowStore } = {}) {
  const db = database?.database;
  if (!db || (typeof packageStore?.get !== "function" && typeof packageStore?.read !== "function")
    || typeof workflowStore?.getSubject !== "function") {
    throw new TypeError("Package workflow drafts require a database, package store and workflow store");
  }
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

  const select = db.prepare(`SELECT * FROM feishu_package_workflow_drafts
    WHERE subject_key = ? AND package_alias = ? AND template_id = ? AND template_version = ?`);

  function profile(subjectKey, packageAlias, workflowTemplate, row) {
    let normalized;
    try {
      // Stale bindings remain visible for repair after a metadata refresh.
      normalized = row ? normalizeConfig(JSON.parse(row.config_json), undefined, { allowLegacyArchive: true }) : { config: defaultConfig() };
    } catch {
      throw new ApiError(500, "PACKAGE_WORKFLOW_DRAFT_INVALID", "Saved package workflow draft is invalid");
    }
    return { subjectKey, packageAlias, workflowTemplate, revision: row?.revision ?? 0, ...normalized, updatedAt: row?.updated_at ?? null };
  }

  return {
    async handle({ method, pathname, body }) {
      const match = pathname.match(/^\/api\/local\/feishu\/subjects\/([^/]+)\/package-workflow-drafts\/([^/]+)(\/enable)?$/u);
      if (!match) return null;
      const enabling = Boolean(match[3]);
      if (enabling ? method !== "POST" : method !== "GET" && method !== "PUT") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      const subjectKey = decodedSegment(match[1]);
      const packageAlias = decodedSegment(match[2]);
      await workflowStore.getSubject(subjectKey);
      const packageRecord = typeof packageStore.get === "function"
        ? await packageStore.get(packageAlias)
        : (await packageStore.read())?.[packageAlias] ?? null;
      if (!packageRecord) throw new ApiError(404, "PACKAGE_NOT_FOUND", "Package does not exist");
      let workflowTemplate;
      try { workflowTemplate = normalizePackageWorkflowTemplate(packageRecord.workflowTemplate); } catch {
        throw new ApiError(409, "PACKAGE_WORKFLOW_DRAFT_UNSUPPORTED", "Package workflow does not support these drafts");
      }
      if (workflowTemplate.id === "document_draft_zip" && workflowTemplate.version === 1) {
        if (enabling) {
          assertShape(body, ["expectedRevision", "expectedVersion"], "activation");
          const subject = await workflowStore.enablePackageWorkflowProfile(subjectKey, packageAlias, body);
          return { status: 200, body: { subject } };
        }
        if (method === "GET") return { status: 200, body: await workflowStore.getPackageWorkflowProfile(subjectKey, packageAlias) };
        assertShape(body, ["expectedRevision", "config"], "draft");
        return { status: 200, body: await workflowStore.savePackageWorkflowProfile(subjectKey, packageAlias, body) };
      }
      if (workflowTemplate.id !== TEMPLATE_ID || workflowTemplate.version !== TEMPLATE_VERSION) {
        throw new ApiError(409, "PACKAGE_WORKFLOW_DRAFT_UNSUPPORTED", "Package workflow does not support these drafts");
      }
      if (enabling) {
        if (typeof workflowStore.enableVmPackageWorkflowProfile !== "function"
          || workflowStore.vmWorkflowActivationAvailable?.() !== true) {
          throw new ApiError(409, "PACKAGE_WORKFLOW_NOT_READY", "Package workflow is available for preview only");
        }
        if (packageRecord.state !== "enabled") throw new ApiError(409, "PACKAGE_WORKFLOW_NOT_READY", "Enable the validated VM package before activating its profile");
        assertShape(body, ["expectedRevision", "expectedVersion"], "activation");
        const subject = await workflowStore.enableVmPackageWorkflowProfile(subjectKey, packageAlias, body);
        return { status: 200, body: { subject } };
      }
      const key = [subjectKey, packageAlias, workflowTemplate.id, workflowTemplate.version];
      if (method === "GET") return { status: 200, body: profile(subjectKey, packageAlias, workflowTemplate, select.get(...key)) };

      assertShape(body, ["expectedRevision", "config"], "draft");
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
        throw new ApiError(400, "INVALID_FIELD", "expectedRevision must be a non-negative integer");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const subject = db.prepare("SELECT metadata_json FROM feishu_subjects WHERE subject_key = ? AND removed_at IS NULL").get(subjectKey);
        if (!subject) throw new ApiError(404, "SUBJECT_NOT_FOUND", "Subject does not exist");
        let metadata;
        try { metadata = JSON.parse(subject.metadata_json); } catch {
          throw new ApiError(500, "SUBJECT_METADATA_INVALID", "Subject metadata is invalid");
        }
        const current = select.get(...key);
        if (current) profile(subjectKey, packageAlias, workflowTemplate, current);
        const actualRevision = current?.revision ?? 0;
        if (body.expectedRevision !== actualRevision) {
          throw new ApiError(409, "VERSION_CONFLICT", "Package workflow draft was changed by another client", { expectedRevision: body.expectedRevision, actualRevision });
        }
        const { config } = normalizeConfig(body.config, metadata ?? null);
        const updatedAt = new Date().toISOString();
        db.prepare(`INSERT INTO feishu_package_workflow_drafts
          (subject_key, package_alias, template_id, template_version, revision, config_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(subject_key, package_alias, template_id, template_version) DO UPDATE SET
            revision = excluded.revision, config_json = excluded.config_json, updated_at = excluded.updated_at`)
          .run(...key, actualRevision + 1, JSON.stringify(config), updatedAt);
        db.prepare(`INSERT INTO feishu_subject_editing_preferences (subject_key, package_alias, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(subject_key) DO UPDATE SET
            package_alias = excluded.package_alias, updated_at = excluded.updated_at`)
          .run(subjectKey, packageAlias, updatedAt);
        const saved = profile(subjectKey, packageAlias, workflowTemplate, select.get(...key));
        db.exec("COMMIT");
        return { status: 200, body: saved };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
