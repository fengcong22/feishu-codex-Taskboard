import { subjectKey as makeSubjectKey } from "./workflow-config.mjs";

function displayValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== value) return displayValue(parsed);
    } catch {}
    return trimmed;
  }
  if (Array.isArray(value)) {
    return value.map(displayValue).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    for (const key of ["text", "name", "value", "label"]) {
      if (Object.hasOwn(value, key)) return displayValue(value[key]);
    }
  }
  return String(value);
}

function aliasValue(value) {
  return displayValue(value);
}

function workflowCatalog(config) {
  if (config?.workflow && typeof config.workflow === "object") return config.workflow;
  if (config?.workflowConfig && typeof config.workflowConfig === "object") return config.workflowConfig;
  if (Array.isArray(config?.bases)) return config;
  return null;
}

function workflowTables(config) {
  const catalog = workflowCatalog(config);
  if (!catalog || !Array.isArray(catalog.bases)) return null;
  const tables = [];
  for (const base of catalog.bases) {
    if (!base || typeof base !== "object" || !Array.isArray(base.subjects)) continue;
    for (const configuredSubject of base.subjects) {
      if (!configuredSubject || typeof configuredSubject !== "object") continue;
      // Keep routing with the last enabled snapshot while a new draft is
      // being edited. The draft becomes live only after explicit enable.
      const subject = configuredSubject.lifecycle === "enabled"
        ? configuredSubject
        : configuredSubject.lifecycle === "draft" && configuredSubject.activeSnapshot
          ? configuredSubject.activeSnapshot
          : null;
      if (!subject || typeof subject !== "object") continue;
      const baseToken = subject.baseToken ?? configuredSubject.baseToken ?? base.baseToken;
      const tableId = subject.tableId ?? configuredSubject.tableId;
      if (typeof baseToken !== "string" || !baseToken || typeof tableId !== "string" || !tableId) continue;
      const trigger = subject.trigger ?? {};
      const statusField = subject.statusField ?? {};
      const execution = subject.execution ?? {};
      const route = subject.packageRoute ?? {};
      const upload = subject.upload ?? {};
      const finalDirectoryTrigger = subject.delivery?.version === 1
        && subject.delivery.finalDirectoryTrigger?.enabled === true
        && typeof subject.delivery.finalDirectoryTrigger.fieldId === "string"
        && typeof subject.delivery.finalDirectoryTrigger.optionId === "string"
        ? {
          enabled: true,
          fieldId: subject.delivery.finalDirectoryTrigger.fieldId,
          optionId: subject.delivery.finalDirectoryTrigger.optionId,
        }
        : null;
      const normalizedSubjectKey = typeof subject.subjectKey === "string" && subject.subjectKey
        ? subject.subjectKey
        : makeSubjectKey(baseToken, tableId);
      tables.push({
        baseToken,
        tableId,
        subjectKey: normalizedSubjectKey,
        configVersion: subject.configVersion,
        name: subject.tableName ?? configuredSubject.tableName ?? base.baseName ?? tableId,
        mode: execution.mode,
        executionMode: execution.mode,
        concurrencyGroup: execution.concurrencyGroup,
        maxConcurrent: execution.maxConcurrent,
        resourceGroups: Array.isArray(execution.resourceGroups) ? [...execution.resourceGroups] : [],
        uploadMode: upload.enqueueMode,
        triggerField: trigger.fieldName ?? statusField.fieldName,
        triggerFieldId: trigger.fieldId ?? statusField.fieldId ?? statusField.field_id,
        triggerValue: trigger.startValue,
        triggerOptionId: trigger.optionId,
        statusField,
        ...(subject.reviewStatusField ? { reviewStatusField: subject.reviewStatusField } : {}),
        titleField: subject.title?.fieldName ?? null,
        titleFieldId: subject.title?.fieldId ?? null,
        packageField: null,
        packageFieldId: null,
        defaultPackageAlias: route.packageAlias,
        packageRoute: route,
        ...(finalDirectoryTrigger ? {
          delivery: { version: 1, finalDirectoryTrigger },
        } : {}),
      });
    }
  }
  return tables;
}

function legacyTables(config) {
  if (!Array.isArray(config?.tables)) return [];
  return config.tables.filter((table) => table?.lifecycle === undefined || table.lifecycle === "enabled");
}

function modernSubject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.statusField && value.stages);
}

function modernSubjects(config) {
  if (modernSubject(config)) return [config];
  if (modernSubject(config?.subject)) return [config.subject];
  const workflow = workflowCatalog(config);
  if (workflow && Array.isArray(workflow.bases)) {
    return workflow.bases.flatMap((base) => (base.subjects ?? []).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      if (entry.lifecycle === "enabled") return modernSubject(entry) ? [entry] : [];
      if (entry.lifecycle === "draft" && modernSubject(entry.activeSnapshot)) return [entry.activeSnapshot];
      return [];
    }));
  }
  return (config?.tables ?? []).filter((entry) => modernSubject(entry)
    && (entry.lifecycle === undefined || entry.lifecycle === "enabled"));
}

function subjectTable(subject, stage = null) {
  const statusField = [subject.statusField, subject.reviewStatusField].find((field) => (
    field && stage?.trigger?.fieldId === (field.fieldId ?? field.field_id)
  )) ?? subject.statusField ?? {};
  return {
    ...subject,
    name: subject.tableName ?? subject.name ?? subject.tableId,
    mode: subject.execution?.mode ?? subject.mode ?? "manual",
    executionMode: subject.execution?.mode ?? subject.executionMode ?? subject.mode ?? "manual",
    uploadMode: subject.upload?.enqueueMode ?? subject.execution?.enqueueMode ?? "manual",
    triggerField: statusField.fieldName ?? subject.triggerField ?? "",
    triggerFieldId: statusField.fieldId ?? subject.triggerFieldId ?? "",
    triggerValue: stage?.trigger?.value ?? subject.trigger?.startValue ?? "",
    statusField,
    packageField: null,
    packageFieldId: null,
    defaultPackageAlias: subject.packageRoute?.packageAlias ?? subject.defaultPackageAlias ?? null,
  };
}

function finalDirectoryDecision(subject, event) {
  const trigger = subject?.delivery?.version === 1
    ? subject.delivery.finalDirectoryTrigger
    : null;
  if (!trigger || trigger.enabled !== true
    || typeof trigger.fieldId !== "string" || trigger.fieldId === ""
    || typeof trigger.optionId !== "string" || trigger.optionId === ""
    || event?.fieldId !== trigger.fieldId) {
    return null;
  }
  if (!event.beforePresent || !event.afterPresent
    || !Object.hasOwn(event, "beforeOptionId") || !Object.hasOwn(event, "afterOptionId")
    || !event.beforeOptionId || !event.afterOptionId) {
    return {
      kind: "blocked",
      reason: "missing_final_directory_edge",
      reasonCode: "MISSING_FINAL_DIRECTORY_EDGE",
      subject,
      table: subjectTable(subject),
      event,
    };
  }
  if (event.beforeOptionId === event.afterOptionId) {
    return {
      kind: "ignored",
      reason: "already_at_final_directory_trigger",
      subject,
      table: subjectTable(subject),
      event,
    };
  }
  if (event.afterOptionId === trigger.optionId) {
    return {
      kind: "directory_operation",
      operationKind: "ensure_final_directory",
      subject,
      table: subjectTable(subject),
      event,
      subjectKey: subject.subjectKey ?? (subject.baseToken && subject.tableId
        ? makeSubjectKey(subject.baseToken, subject.tableId) : undefined),
      configVersion: subject.configVersion,
    };
  }
  if (event.beforeOptionId === trigger.optionId) {
    return {
      kind: "ignored",
      reason: "left_final_directory_trigger",
      subject,
      table: subjectTable(subject),
      event,
    };
  }
  return null;
}

function modernDecision(subject, event) {
  if (!subject || !event || typeof event !== "object") {
    return { kind: "ignored", reason: "invalid_event" };
  }
  if (subject.baseToken && event.baseToken && subject.baseToken !== event.baseToken) {
    return { kind: "ignored", reason: "unknown_table" };
  }
  if (subject.tableId && event.tableId && subject.tableId !== event.tableId) {
    return { kind: "ignored", reason: "unknown_table" };
  }
  const finalDirectory = finalDirectoryDecision(subject, event);
  if (finalDirectory) return finalDirectory;
  const statusField = subject.statusField ?? {};
  const statusFieldId = statusField.fieldId ?? statusField.field_id;
  const reviewStatusFieldId = subject.reviewStatusField?.fieldId
    ?? subject.reviewStatusField?.field_id ?? statusFieldId;
  const watchedFieldIds = [statusFieldId, reviewStatusFieldId].filter(Boolean);
  if (watchedFieldIds.length && event.fieldId && !watchedFieldIds.includes(event.fieldId)) {
    return { kind: "ignored", reason: "unrelated_field" };
  }
  if (!event.beforePresent || !event.afterPresent
    || !Object.hasOwn(event, "beforeOptionId") || !Object.hasOwn(event, "afterOptionId")
    || !event.beforeOptionId || !event.afterOptionId) {
    return {
      kind: "blocked",
      reason: "missing_status_edge",
      reasonCode: "MISSING_STATUS_EDGE",
      subject,
      table: subjectTable(subject),
      event,
    };
  }
  if (watchedFieldIds.length && (!watchedFieldIds.includes(event.statusFieldId)
    || (event.fieldId && event.statusFieldId !== event.fieldId))) {
    return { kind: "ignored", reason: "unrelated_field" };
  }
  const stages = subject.stages ?? {};
  const entries = Object.entries(stages).filter(([stageId, stage]) => (
    stage && typeof stage === "object"
    && (stage.trigger?.fieldId ?? (stageId === "initial" ? statusFieldId : reviewStatusFieldId)) === event.statusFieldId
  ));
  const previous = entries.find(([, stage]) => stage.trigger?.optionId === event.beforeOptionId);
  const targetAny = entries.find(([, stage]) => stage.trigger?.optionId === event.afterOptionId);
  if (event.beforeOptionId === event.afterOptionId) {
    return { kind: "ignored", reason: "already_at_trigger", subject, table: subjectTable(subject) };
  }
  const target = entries.find(([, stage]) => (
    stage.enabled === true && stage.trigger?.optionId === event.afterOptionId
  ));
  if (!target) {
    if (previous) {
      return {
        kind: "archive_waiting",
        reason: "left_trigger",
        reasonCode: "LEFT_STAGE_TARGET",
        stageId: previous[0],
        stage: previous[1],
        subject,
        table: subjectTable(subject, previous[1]),
        event,
        previousStageId: previous[0],
      };
    }
    if (targetAny && targetAny[1].enabled !== true) {
      return {
        kind: "ignored",
        reason: "stage_disabled",
        stageId: targetAny[0],
        subject,
        table: subjectTable(subject, targetAny[1]),
        event,
      };
    }
    return { kind: "ignored", reason: "new_value_not_trigger", subject, table: subjectTable(subject), event };
  }
  const packageAlias = subject.packageRoute?.packageAlias ?? subject.defaultPackageAlias ?? null;
  const packageMap = subject.packages ?? subject.packageCatalog ?? null;
  const packageConfig = packageMap && Object.hasOwn(packageMap, packageAlias)
    ? packageMap[packageAlias]
    : subject.packageConfig;
  if (!packageAlias) {
    return {
      kind: "blocked", reason: "missing_package_alias", reasonCode: "MISSING_PACKAGE_ALIAS",
      subject, table: subjectTable(subject, target[1]), stageId: target[0], stage: target[1], event,
    };
  }
  if (packageMap && !packageConfig) {
    return {
      kind: "blocked", reason: "unknown_package_alias", reasonCode: "UNKNOWN_PACKAGE_ALIAS",
      subject, table: subjectTable(subject, target[1]), stageId: target[0], stage: target[1], packageAlias, event,
    };
  }
  return {
    kind: "register",
    subject,
    table: subjectTable(subject, target[1]),
    event,
    subjectKey: subject.subjectKey ?? (subject.baseToken && subject.tableId
      ? makeSubjectKey(subject.baseToken, subject.tableId) : undefined),
    configVersion: subject.configVersion,
    stageId: target[0],
    stage: target[1],
    packageAlias,
    ...(packageConfig ? { packageConfig } : {}),
    packageSource: "subject-route",
    executionMode: subject.execution?.mode ?? subject.executionMode ?? subject.mode ?? "manual",
    uploadMode: subject.upload?.enqueueMode ?? subject.execution?.enqueueMode ?? "manual",
    archiveWaiting: Boolean(previous),
    previousStageId: previous?.[0] ?? null,
  };
}

export function configuredTables(config) {
  const workflow = workflowTables(config);
  // A workflow catalog is authoritative when present.  This prevents an old
  // tables array from continuing to receive events after a subject is drafted
  // or disabled in the new configuration center.
  return workflow ?? legacyTables(config);
}

function tableSubjectKey(table) {
  if (typeof table?.subjectKey === "string" && table.subjectKey) return table.subjectKey;
  if (typeof table?.baseToken === "string" && table.baseToken && typeof table?.tableId === "string" && table.tableId) {
    try {
      return makeSubjectKey(table.baseToken, table.tableId);
    } catch {
      return null;
    }
  }
  return null;
}

function tableSnapshot(table) {
  const subject = tableSubjectKey(table);
  const configVersion = table?.configVersion;
  const executionMode = table?.executionMode;
  const uploadMode = table?.uploadMode ?? table?.upload?.enqueueMode;
  const concurrencyGroup = table?.concurrencyGroup ?? table?.execution?.concurrencyGroup;
  const maxConcurrent = table?.maxConcurrent ?? table?.execution?.maxConcurrent;
  const resourceGroups = table?.resourceGroups ?? table?.execution?.resourceGroups;
  return {
    ...(subject ? { subjectKey: subject } : {}),
    ...(Number.isInteger(configVersion) ? { configVersion } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(uploadMode ? { uploadMode } : {}),
    ...(typeof concurrencyGroup === "string" && concurrencyGroup ? { concurrencyGroup } : {}),
    ...(Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0 ? { maxConcurrent } : {}),
    ...(Array.isArray(resourceGroups) ? { resourceGroups: [...resourceGroups] } : {}),
  };
}

export function decideRecordChange(config, event) {
  const subjects = modernSubjects(config);
  const subject = subjects.find((candidate) => (
    (!candidate.baseToken || candidate.baseToken === event?.baseToken)
    && (!candidate.tableId || candidate.tableId === event?.tableId)
  ));
  if (subject) return modernDecision(subject, event);
  const table = configuredTables(config).find((candidate) => (
    candidate.tableId === event.tableId
    && (!candidate.baseToken || candidate.baseToken === event.baseToken)
  ));
  if (!table) return { kind: "ignored", reason: "unknown_table" };
  const triggerMatches = table.triggerFieldId
    ? (event.fieldId ? event.fieldId === table.triggerFieldId : event.fieldName === table.triggerField)
    : event.fieldName === table.triggerField;
  if (!triggerMatches) {
    return { kind: "ignored", reason: "unrelated_field" };
  }
  const before = displayValue(event.beforeValue);
  const after = displayValue(event.afterValue);
  if (before === table.triggerValue && after !== table.triggerValue) {
    return {
      kind: "ignored",
      reason: "left_trigger",
      effect: "archive_waiting_tasks",
      table,
      ...tableSnapshot(table),
      event,
    };
  }
  if (after !== table.triggerValue) {
    return { kind: "ignored", reason: "new_value_not_trigger" };
  }
  if (before === table.triggerValue) {
    return { kind: "ignored", reason: "already_at_trigger" };
  }

  const packageFromField = table.packageField
    ? (event.fields?.[table.packageField]
      ?? (table.packageFieldId ? event.fieldValuesById?.[table.packageFieldId] : undefined))
    : (table.packageFieldId ? event.fieldValuesById?.[table.packageFieldId] : undefined);
  const packageAlias = aliasValue(packageFromField) || aliasValue(table.defaultPackageAlias);
  if (!packageAlias) {
    return {
      kind: "blocked",
      reason: "missing_package_alias",
      table,
      ...tableSnapshot(table),
      packageAlias,
      event,
    };
  }
  const packages = config?.packages && typeof config.packages === "object" && !Array.isArray(config.packages)
    ? config.packages
    : Object.create(null);
  const packageConfig = Object.hasOwn(packages, packageAlias)
    ? packages[packageAlias]
    : undefined;
  if (!packageConfig) {
    return {
      kind: "blocked",
      reason: "unknown_package_alias",
      table,
      ...tableSnapshot(table),
      packageAlias,
      event,
    };
  }
  return {
    kind: "ready",
    table,
    ...tableSnapshot(table),
    packageAlias,
    packageConfig,
    packageSource: packageFromField === undefined ? "table-default" : "record-field",
    event,
  };
}
