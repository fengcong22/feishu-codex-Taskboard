export const DELIVERY_STAGE_IDS = Object.freeze(["initial", "first_review", "final_review"]);

const DELIVERY_KEYS = new Set([
  "version",
  "rootPath",
  "courseNaming",
  "coursePathWriteback",
  "writeback",
  "finalDirectoryTrigger",
]);
const COURSE_NAMING_KEYS = new Set(["mode", "fieldId"]);
const COURSE_PATH_WRITEBACK_KEYS = new Set(["enabled", "fieldId"]);
const WRITEBACK_KEYS = new Set(DELIVERY_STAGE_IDS);
const STAGE_WRITEBACK_KEYS = new Set(["onProcessing", "onUploaded"]);
const ASSIGNMENT_KEYS = new Set(["fieldId", "optionId"]);
const FINAL_DIRECTORY_TRIGGER_KEYS = new Set(["enabled", "fieldId", "optionId"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const POSIX_ABSOLUTE_PATH = /^\//u;

function fail(message) {
  const error = new Error(`DELIVERY_CONFIG_INVALID: ${message}`);
  error.code = "DELIVERY_CONFIG_INVALID";
  throw error;
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
}

function assertKnownKeys(value, keys, path) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(`${path}.${key} is not supported`);
  }
}

function nullableIdentifier(value, path) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !IDENTIFIER.test(value.trim())) fail(`${path} is invalid`);
  return value.trim();
}

function nullableAbsolutePath(value, path) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${path} is invalid`);
  }
  const normalized = value.trim().replaceAll("/", "\\");
  if (!(WINDOWS_ABSOLUTE_PATH.test(normalized) || POSIX_ABSOLUTE_PATH.test(value.trim()))) {
    fail(`${path} must be an absolute local path`);
  }
  if (normalized.split("\\").includes("..")) fail(`${path} cannot contain parent directory segments`);
  return normalized;
}

function boolean(value, path, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(`${path} must be boolean`);
  return value;
}

function normalizeAssignments(value, path) {
  const entries = value === undefined ? [] : value;
  if (!Array.isArray(entries)) fail(`${path} must be an array`);
  return entries.map((entry, index) => {
    const assignmentPath = `${path}[${index}]`;
    const input = object(entry, assignmentPath);
    assertKnownKeys(input, ASSIGNMENT_KEYS, assignmentPath);
    return {
      fieldId: nullableIdentifier(input.fieldId, `${assignmentPath}.fieldId`),
      optionId: nullableIdentifier(input.optionId, `${assignmentPath}.optionId`),
    };
  });
}

function normalizeStageWriteback(value, stageId) {
  const path = `delivery.writeback.${stageId}`;
  const input = object(value ?? {}, path);
  assertKnownKeys(input, STAGE_WRITEBACK_KEYS, path);
  return {
    onProcessing: normalizeAssignments(input.onProcessing, `${path}.onProcessing`),
    onUploaded: normalizeAssignments(input.onUploaded, `${path}.onUploaded`),
  };
}

function normalizeCourseNaming(value) {
  const input = object(value ?? {}, "delivery.courseNaming");
  assertKnownKeys(input, COURSE_NAMING_KEYS, "delivery.courseNaming");
  const mode = input.mode ?? "reuse_artifact_naming";
  if (!["reuse_artifact_naming", "field"].includes(mode)) {
    fail("delivery.courseNaming.mode is invalid");
  }
  return { mode, fieldId: nullableIdentifier(input.fieldId, "delivery.courseNaming.fieldId") };
}

function normalizeCoursePathWriteback(value) {
  const input = object(value ?? {}, "delivery.coursePathWriteback");
  assertKnownKeys(input, COURSE_PATH_WRITEBACK_KEYS, "delivery.coursePathWriteback");
  return {
    enabled: boolean(input.enabled, "delivery.coursePathWriteback.enabled", false),
    fieldId: nullableIdentifier(input.fieldId, "delivery.coursePathWriteback.fieldId"),
  };
}

function normalizeFinalDirectoryTrigger(value) {
  const input = object(value ?? {}, "delivery.finalDirectoryTrigger");
  assertKnownKeys(input, FINAL_DIRECTORY_TRIGGER_KEYS, "delivery.finalDirectoryTrigger");
  return {
    enabled: boolean(input.enabled, "delivery.finalDirectoryTrigger.enabled", false),
    fieldId: nullableIdentifier(input.fieldId, "delivery.finalDirectoryTrigger.fieldId"),
    optionId: nullableIdentifier(input.optionId, "delivery.finalDirectoryTrigger.optionId"),
  };
}

/**
 * Normalize the persisted, subject-level course delivery settings. Structural
 * errors always fail so an untrusted patch cannot hide unsupported behavior.
 */
export function normalizeDeliveryConfig(value) {
  if (value === undefined || value === null) return null;
  const input = object(value, "delivery");
  assertKnownKeys(input, DELIVERY_KEYS, "delivery");
  if (input.version !== 1) fail("delivery.version must be 1");

  const writebackInput = object(input.writeback ?? {}, "delivery.writeback");
  assertKnownKeys(writebackInput, WRITEBACK_KEYS, "delivery.writeback");
  const writeback = Object.fromEntries(DELIVERY_STAGE_IDS.map((stageId) => [
    stageId,
    normalizeStageWriteback(writebackInput[stageId], stageId),
  ]));

  return {
    version: 1,
    rootPath: nullableAbsolutePath(input.rootPath, "delivery.rootPath"),
    courseNaming: normalizeCourseNaming(input.courseNaming),
    coursePathWriteback: normalizeCoursePathWriteback(input.coursePathWriteback),
    writeback,
    finalDirectoryTrigger: normalizeFinalDirectoryTrigger(input.finalDirectoryTrigger),
  };
}

function metadataFieldId(field) {
  return field?.fieldId ?? field?.id ?? null;
}

function normalizedUiType(field) {
  if (typeof field?.uiType !== "string") return null;
  return field.uiType.trim().toLowerCase().replace(/[\s_-]/gu, "");
}

function fieldType(field) {
  if (typeof field?.type === "number" && Number.isSafeInteger(field.type)) return field.type;
  if (typeof field?.type === "string" && /^\d+$/u.test(field.type.trim())) return Number(field.type);
  return null;
}

function isSingleSelectField(field) {
  const type = fieldType(field);
  const uiType = normalizedUiType(field);
  return type === 3 && (uiType === null || ["singleselect", "select"].includes(uiType));
}

function isCourseNamingField(field) {
  const type = fieldType(field);
  const uiType = normalizedUiType(field);
  if (![1, 20].includes(type)) return false;
  return uiType === null || ["text", "formula"].includes(uiType);
}

function isWritableTextField(field) {
  return fieldType(field) === 1 && normalizedUiType(field) !== "formula" && field?.writable !== false;
}

function issue(code, path, message) {
  return { code, path, section: "delivery", message };
}

function fieldMap(fields) {
  const result = new Map();
  for (const field of Array.isArray(fields) ? fields : []) {
    const id = metadataFieldId(field);
    if (typeof id !== "string" || id.trim() === "") continue;
    const existing = result.get(id);
    result.set(id, existing ? null : field);
  }
  return result;
}

function fieldIssue(issues, fieldsById, fieldId, path, predicate, typeCode) {
  if (!fieldId) {
    issues.push(issue("WRITEBACK_FIELD_REQUIRED", path, "Choose an existing field"));
    return null;
  }
  const field = fieldsById.get(fieldId);
  if (field === undefined) {
    issues.push(issue("WRITEBACK_FIELD_NOT_FOUND", path, "The selected field is not present in current metadata"));
    return null;
  }
  if (field === null || !predicate(field)) {
    issues.push(issue(typeCode, path, "The selected field has an incompatible type"));
    return null;
  }
  return field;
}

function optionIssue(issues, field, optionId, path) {
  if (!optionId) {
    issues.push(issue("WRITEBACK_OPTION_REQUIRED", path, "Choose an existing single-select option"));
    return;
  }
  const matches = (Array.isArray(field?.options) ? field.options : [])
    .filter((option) => (option?.id ?? option?.optionId) === optionId);
  if (matches.length !== 1) {
    issues.push(issue("WRITEBACK_OPTION_NOT_FOUND", path, "The selected option is not present in current metadata"));
  }
}

function stageEnabled(stages, stageId) {
  return Boolean(stages?.[stageId]?.enabled);
}

function validateAssignments(issues, assignments, fieldsById, path) {
  const assignedFields = new Set();
  for (const [index, assignment] of assignments.entries()) {
    const assignmentPath = `${path}[${index}]`;
    const field = fieldIssue(
      issues,
      fieldsById,
      assignment.fieldId,
      `${assignmentPath}.fieldId`,
      isSingleSelectField,
      "WRITEBACK_FIELD_TYPE_INVALID",
    );
    if (!field) continue;
    if (assignedFields.has(assignment.fieldId)) {
      issues.push(issue("WRITEBACK_FIELD_CONFLICT", `${assignmentPath}.fieldId`, "A writeback moment cannot set the same field twice"));
      continue;
    }
    assignedFields.add(assignment.fieldId);
    optionIssue(issues, field, assignment.optionId, `${assignmentPath}.optionId`);
  }
}

/**
 * Validate business requirements after structural normalization. Draft mode
 * intentionally leaves incomplete operator choices repairable.
 */
export function validateDeliveryConfig(value, {
  mode = "draft",
  fields = [],
  stages = {},
  uploadEnabled = false,
  namingField = null,
} = {}) {
  if (!["draft", "activation"].includes(mode)) fail("validation mode is invalid");
  const normalized = normalizeDeliveryConfig(value);
  if (normalized === null || mode === "draft") return { value: normalized, issues: [] };

  const issues = [];
  const fieldsById = fieldMap(fields);
  const hasUploadedWriteback = DELIVERY_STAGE_IDS.some((stageId) => (
    stageEnabled(stages, stageId) && normalized.writeback[stageId].onUploaded.length > 0
  ));
  const needsCourseDirectory = uploadEnabled || normalized.finalDirectoryTrigger.enabled;

  if (needsCourseDirectory && !normalized.rootPath) {
    issues.push(issue("DELIVERY_ROOT_PATH_REQUIRED", "delivery.rootPath", "Set an absolute course delivery root path"));
  }

  if (needsCourseDirectory) {
    const namingPath = normalized.courseNaming.mode === "field"
      ? "delivery.courseNaming.fieldId"
      : "namingField.fieldId";
    const fieldId = normalized.courseNaming.mode === "field"
      ? normalized.courseNaming.fieldId
      : metadataFieldId(namingField);
    const field = fieldIssue(
      issues,
      fieldsById,
      fieldId,
      namingPath,
      isCourseNamingField,
      "COURSE_NAMING_FIELD_INVALID",
    );
    if (field && !isCourseNamingField(field)) {
      issues.push(issue("COURSE_NAMING_FIELD_INVALID", namingPath, "Course naming must use a text or formula field"));
    }
  }

  if (!uploadEnabled && (normalized.coursePathWriteback.enabled || hasUploadedWriteback)) {
    issues.push(issue("UPLOAD_REQUIRED", "upload.enabled", "Enable ZIP upload before configuring upload-complete writeback"));
  }
  if (!uploadEnabled && normalized.coursePathWriteback.enabled) {
    issues.push(issue("UPLOAD_REQUIRED", "delivery.coursePathWriteback.enabled", "Course path writeback requires ZIP upload"));
  }

  if (normalized.coursePathWriteback.enabled) {
    fieldIssue(
      issues,
      fieldsById,
      normalized.coursePathWriteback.fieldId,
      "delivery.coursePathWriteback.fieldId",
      isWritableTextField,
      "WRITEBACK_FIELD_TYPE_INVALID",
    );
  }

  for (const stageId of DELIVERY_STAGE_IDS) {
    if (!stageEnabled(stages, stageId)) continue;
    const stage = normalized.writeback[stageId];
    validateAssignments(issues, stage.onProcessing, fieldsById, `delivery.writeback.${stageId}.onProcessing`);
    if (!uploadEnabled && stage.onUploaded.length > 0) {
      issues.push(issue("UPLOAD_REQUIRED", `delivery.writeback.${stageId}.onUploaded`, "Upload-complete writeback requires ZIP upload"));
    }
    validateAssignments(issues, stage.onUploaded, fieldsById, `delivery.writeback.${stageId}.onUploaded`);
  }

  if (normalized.finalDirectoryTrigger.enabled) {
    const field = fieldIssue(
      issues,
      fieldsById,
      normalized.finalDirectoryTrigger.fieldId,
      "delivery.finalDirectoryTrigger.fieldId",
      isSingleSelectField,
      "WRITEBACK_FIELD_TYPE_INVALID",
    );
    if (field) {
      optionIssue(issues, field, normalized.finalDirectoryTrigger.optionId, "delivery.finalDirectoryTrigger.optionId");
    } else if (!normalized.finalDirectoryTrigger.optionId) {
      issues.push(issue(
        "WRITEBACK_OPTION_REQUIRED",
        "delivery.finalDirectoryTrigger.optionId",
        "Choose an existing single-select option",
      ));
    }
    for (const stageId of DELIVERY_STAGE_IDS) {
      const stage = stages?.[stageId];
      if (stage?.enabled !== true) continue;
      const stageTrigger = stage.trigger ?? {};
      if (stageTrigger.fieldId === normalized.finalDirectoryTrigger.fieldId
        && stageTrigger.optionId === normalized.finalDirectoryTrigger.optionId) {
        issues.push(issue(
          "FINAL_DIRECTORY_TRIGGER_CONFLICT",
          "delivery.finalDirectoryTrigger.optionId",
          "The final-directory trigger cannot use an enabled Auto-Cut stage option",
        ));
        break;
      }
    }
  }

  return { value: normalized, issues };
}
