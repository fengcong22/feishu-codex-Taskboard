const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,511}$/u;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value, pattern = IDENTIFIER) {
  return typeof value === "string" && pattern.test(value);
}

function controlledAlias(value) {
  return typeof value === "string" && value.length > 0
    && !/^[./\\]/u.test(value) && !/[\s\u0000-\u001f\u007f"'`:$<>|]/u.test(value);
}

function blocked(reasonCode, subject, event) {
  return { kind: "blocked", reason: reasonCode.toLowerCase(), reasonCode, subject, event };
}

function singleSelect(field) {
  if (!object(field)) return false;
  const hasType = field.type !== undefined && field.type !== null && field.type !== "";
  const hasUiType = field.uiType !== undefined && field.uiType !== null && field.uiType !== "";
  return (hasType || hasUiType)
    && (!hasType || field.type === 3 || field.type === "3" || field.type === "single_select")
    && (!hasUiType || typeof field.uiType === "string"
      && field.uiType.trim().toLowerCase().replace(/[\s_-]/gu, "") === "singleselect");
}

function multiSelect(field) {
  if (!object(field)) return false;
  const hasType = field.type !== undefined && field.type !== null && field.type !== "";
  const hasUiType = field.uiType !== undefined && field.uiType !== null && field.uiType !== "";
  return (hasType || hasUiType)
    && (!hasType || field.type === 4 || field.type === "4" || field.type === "multi_select")
    && (!hasUiType || typeof field.uiType === "string"
      && ["multiselect", "multipleselect"].includes(field.uiType.trim().toLowerCase().replace(/[\s_-]/gu, "")));
}

function stageStatusField(subject, stageId) {
  return stageId === "review"
    ? subject.reviewStatusField ?? subject.statusField
    : subject.statusField;
}

function configuredStages(subject) {
  const stages = subject?.vmWorkflow?.stages;
  if (!object(stages) || Object.keys(stages).length !== 2 || !object(stages.initial)
    || !object(stages.review) || stages.initial.enabled !== true
    || ![true, false].includes(stages.review.enabled)) return null;
  const enabled = Object.entries(stages).filter(([, stage]) => stage.enabled === true);
  for (const [stageId, stage] of enabled) {
    const field = stageStatusField(subject, stageId);
    if (!identifier(stage.statusFieldId) || !identifier(stage.triggerOptionId)
      || !singleSelect(field) || field.fieldId !== stage.statusFieldId
      || !Array.isArray(field.options)
      || field.options.filter((option) => option?.optionId === stage.triggerOptionId).length !== 1) return null;
  }
  const triggerKeys = enabled.map(([stageId, stage]) =>
    JSON.stringify([stageStatusField(subject, stageId).fieldId, stage.triggerOptionId]));
  return new Set(triggerKeys).size === triggerKeys.length ? enabled : null;
}

function configuredArchive(subject) {
  const archive = subject?.vmWorkflow?.finalArchive;
  if (!object(archive) || typeof archive.enabled !== "boolean") return null;
  if (!archive.enabled) return archive;
  const fields = subject.metadata?.fields;
  const matches = Array.isArray(fields)
    ? fields.filter((field) => (field?.fieldId ?? field?.field_id) === archive.statusFieldId) : [];
  if (matches.length === 0 && subject.statusField?.fieldId === archive.statusFieldId) matches.push(subject.statusField);
  if (!identifier(archive.statusFieldId) || !identifier(archive.triggerOptionId) || matches.length !== 1
    || !(singleSelect(matches[0]) || multiSelect(matches[0]))
    || !Array.isArray(matches[0].options)
    || matches[0].options.filter((option) => (option?.optionId ?? option?.id) === archive.triggerOptionId).length !== 1
    || !["manual", "pmo_field"].includes(archive.pathSource)
    || archive.pathSource === "pmo_field" && !identifier(archive.pathFieldId)) return null;
  const conflict = Object.values(subject.vmWorkflow.stages ?? {}).some((stage) => stage?.enabled === true
    && stage.statusFieldId === archive.statusFieldId && stage.triggerOptionId === archive.triggerOptionId);
  return conflict ? null : archive;
}

function validSubject(subject) {
  if (!object(subject) || subject.lifecycle !== "enabled"
    || !object(subject.workflowTemplate)
    || Object.keys(subject.workflowTemplate).length !== 2
    || subject.workflowTemplate.id !== "vm_pmo_review_video"
    || subject.workflowTemplate.version !== 1
    || !identifier(subject.baseToken)
    || !identifier(subject.tableId)
    || subject.subjectKey !== `${subject.baseToken}:${subject.tableId}`
    || !Number.isSafeInteger(subject.configVersion) || subject.configVersion < 1
    || !controlledAlias(subject.packageRoute?.packageAlias)) return false;

  const workflow = subject.vmWorkflow;
  return Boolean(configuredStages(subject) && configuredArchive(subject));
}

/** Decide only; the caller enforces trusted registration and todo-only archival. */
export function decideVmWorkflowRecordChange(subject, event) {
  if (!validSubject(subject)) return blocked("VM_WORKFLOW_NOT_READY", subject, event);
  if (!object(event)) return blocked("INVALID_EVENT", subject, event);
  if (event.deliverySource === "simulation") return { kind: "ignored", reason: "simulation_forbidden", subject, event };
  if (event.deliverySource !== undefined) return blocked("INVALID_EVENT_SOURCE", subject, event);
  if (event.baseToken !== subject.baseToken || event.tableId !== subject.tableId) {
    return { kind: "ignored", reason: "unknown_table", subject, event };
  }

  const stages = configuredStages(subject);
  const archive = configuredArchive(subject);
  const archiveFieldId = archive?.enabled === true ? archive.statusFieldId : null;
  if (archiveFieldId && (event.fieldId === archiveFieldId || event.statusFieldId === archiveFieldId)) {
    const archiveField = subject.metadata?.fields?.find((field) => (field.fieldId ?? field.field_id) === archiveFieldId)
      ?? (subject.statusField?.fieldId === archiveFieldId ? subject.statusField : null);
    const options = archiveField?.options ?? [];
    const before = event.beforeOptionIds;
    const after = event.afterOptionIds;
    const initialStageWithoutPreviousOption = stages.some(([stageId, stage]) => (
      stageId === "initial"
      && stage.statusFieldId === archiveFieldId
      && stage.triggerOptionId === event.afterOptionId
    )) && event.fieldId === archiveFieldId && event.statusFieldId === archiveFieldId
      && (event.beforePresent === true || event.beforePresent === false)
      && event.beforeOptionId === null && event.afterPresent === true
      && identifier(event.eventId, EVENT_ID) && identifier(event.recordId)
      && Array.isArray(before) && before.length === 0
      && Array.isArray(after) && after.length === 1 && after[0] === event.afterOptionId
      && options.filter((option) => (option?.optionId ?? option?.id) === event.afterOptionId).length === 1;
    if (!initialStageWithoutPreviousOption) {
      if (event.fieldId !== archiveFieldId || event.statusFieldId !== archiveFieldId
        || event.beforePresent !== true || event.afterPresent !== true
        || !identifier(event.eventId, EVENT_ID) || !identifier(event.recordId)
        || !Array.isArray(before) || !Array.isArray(after)
        || before.some((id) => !identifier(id)) || after.some((id) => !identifier(id))
        || new Set(before).size !== before.length || new Set(after).size !== after.length
        || [...before, ...after].some((id) => options.filter((option) => (option?.optionId ?? option?.id) === id).length !== 1)) {
        return blocked("MISSING_STATUS_EDGE", subject, event);
      }
      if (!before.includes(archive.triggerOptionId) && after.includes(archive.triggerOptionId)) return {
        kind: "final_archive", subject, event, subjectKey: subject.subjectKey,
        configVersion: subject.configVersion, archive,
      };
      // Stage dispatch consumes scalar IDs; shared fields must prove the same edge.
      if (stages.some(([, stage]) => stage.statusFieldId === archiveFieldId)
        && (before.length !== 1 || after.length !== 1
          || before[0] !== event.beforeOptionId || after[0] !== event.afterOptionId)) {
        return blocked("MISSING_STATUS_EDGE", subject, event);
      }
    }
  }
  const matching = stages.map(([stageId, stage]) => ({
    stageId, stage, field: stageStatusField(subject, stageId),
  })).filter(({ stage }) => stage.statusFieldId === event.fieldId
    || stage.statusFieldId === event.statusFieldId);
  if (matching.length === 0) {
    return { kind: "ignored", reason: "unrelated_field", subject, event };
  }
  const fieldIds = new Set(matching.map(({ stage }) => stage.statusFieldId));
  const expectedFieldId = matching[0].stage.statusFieldId;
  const hasPreviousOption = identifier(event.beforeOptionId) && event.beforePresent === true;
  const hasNoPreviousOption = event.beforeOptionId === null
    && (event.beforePresent === true || event.beforePresent === false);
  if (fieldIds.size !== 1 || event.fieldId !== expectedFieldId || event.statusFieldId !== expectedFieldId
    || event.afterPresent !== true
    || !identifier(event.eventId, EVENT_ID) || !identifier(event.recordId)
    || (!hasPreviousOption && !hasNoPreviousOption) || !identifier(event.afterOptionId)) {
    return blocked("MISSING_STATUS_EDGE", subject, event);
  }

  const options = matching[0].field.options;
  if ((hasPreviousOption && options.filter((option) => option?.optionId === event.beforeOptionId).length !== 1)
    || options.filter((option) => option?.optionId === event.afterOptionId).length !== 1) {
    return blocked("UNKNOWN_STATUS_OPTION", subject, event);
  }
  if (hasPreviousOption && event.beforeOptionId === event.afterOptionId) {
    return { kind: "ignored", reason: "already_at_trigger", subject, event };
  }
  const entered = matching.find(({ stage }) => stage.triggerOptionId === event.afterOptionId);
  if (hasNoPreviousOption && entered?.stageId !== "initial") {
    return blocked("MISSING_STATUS_EDGE", subject, event);
  }
  const leaving = hasPreviousOption
    ? matching.find(({ stage }) => stage.triggerOptionId === event.beforeOptionId)
    : null;
  if (entered) {
    const common = {
      subject,
      event,
      subjectKey: subject.subjectKey,
      configVersion: subject.configVersion,
      stageId: entered.stageId,
      stage: entered.stage,
      packageAlias: subject.packageRoute.packageAlias,
    };
    return { kind: "register", ...common, packageSource: "subject-route",
      executionMode: subject.execution?.mode === "automatic" ? "automatic" : "manual",
      ...(leaving && leaving.stageId !== entered.stageId
        ? { archiveWaiting: true, previousStageId: leaving.stageId } : {}) };
  }
  if (leaving) {
    const common = {
    subject,
    event,
    subjectKey: subject.subjectKey,
    configVersion: subject.configVersion,
    stageId: leaving.stageId,
    stage: leaving.stage,
    packageAlias: subject.packageRoute.packageAlias,
    };
    return { kind: "archive_waiting", ...common, previousStageId: leaving.stageId, statusConstraint: "todo" };
  }
  return { kind: "ignored", reason: "new_value_not_trigger", subject, event };
}

export const decideVmInitialRecordChange = decideVmWorkflowRecordChange;
