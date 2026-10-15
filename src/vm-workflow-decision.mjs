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
  const stages = workflow?.stages;
  const initial = stages?.initial;
  if (!object(stages) || Object.keys(stages).length !== 2
    || !object(initial) || initial.enabled !== true
    || !identifier(initial.statusFieldId)
    || !identifier(initial.triggerOptionId)
    || stages.review?.enabled !== false
    || workflow.finalArchive?.enabled !== false) return false;

  const field = subject.statusField;
  return singleSelect(field)
    && field.fieldId === initial.statusFieldId
    && Array.isArray(field.options)
    && field.options.filter((option) => option?.optionId === initial.triggerOptionId).length === 1;
}

/** Decide only; the caller enforces trusted registration and todo-only archival. */
export function decideVmInitialRecordChange(subject, event) {
  if (!validSubject(subject)) return blocked("VM_WORKFLOW_NOT_READY", subject, event);
  if (!object(event)) return blocked("INVALID_EVENT", subject, event);
  if (event.deliverySource === "simulation") return { kind: "ignored", reason: "simulation_forbidden", subject, event };
  if (event.deliverySource !== undefined) return blocked("INVALID_EVENT_SOURCE", subject, event);
  if (event.baseToken !== subject.baseToken || event.tableId !== subject.tableId) {
    return { kind: "ignored", reason: "unknown_table", subject, event };
  }

  const stage = subject.vmWorkflow.stages.initial;
  if (event.fieldId !== stage.statusFieldId && event.statusFieldId !== stage.statusFieldId) {
    return { kind: "ignored", reason: "unrelated_field", subject, event };
  }
  if (event.fieldId !== stage.statusFieldId || event.statusFieldId !== stage.statusFieldId
    || event.beforePresent !== true || event.afterPresent !== true
    || !identifier(event.eventId, EVENT_ID) || !identifier(event.recordId)
    || !identifier(event.beforeOptionId) || !identifier(event.afterOptionId)) {
    return blocked("MISSING_STATUS_EDGE", subject, event);
  }

  const options = subject.statusField.options;
  if (options.filter((option) => option?.optionId === event.beforeOptionId).length !== 1
    || options.filter((option) => option?.optionId === event.afterOptionId).length !== 1) {
    return blocked("UNKNOWN_STATUS_OPTION", subject, event);
  }
  if (event.beforeOptionId === event.afterOptionId) {
    return { kind: "ignored", reason: "already_at_trigger", subject, event };
  }
  const common = {
    subject,
    event,
    subjectKey: subject.subjectKey,
    configVersion: subject.configVersion,
    stageId: "initial",
    stage,
    packageAlias: subject.packageRoute.packageAlias,
  };
  if (event.afterOptionId === stage.triggerOptionId) {
    return { kind: "register", ...common, packageSource: "subject-route",
      executionMode: subject.execution?.mode === "automatic" ? "automatic" : "manual" };
  }
  if (event.beforeOptionId === stage.triggerOptionId) {
    return { kind: "archive_waiting", ...common, previousStageId: "initial", statusConstraint: "todo" };
  }
  return { kind: "ignored", reason: "new_value_not_trigger", subject, event };
}
