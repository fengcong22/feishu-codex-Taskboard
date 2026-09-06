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

function legacyDecision(config, event) {
  const table = config.tables.find((candidate) => (
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
    return { kind: "blocked", reason: "missing_package_alias", table, packageAlias, event };
  }
  const packageConfig = Object.hasOwn(config.packages, packageAlias)
    ? config.packages[packageAlias]
    : undefined;
  if (!packageConfig) {
    return { kind: "blocked", reason: "unknown_package_alias", table, packageAlias, event };
  }
  return {
    kind: "ready",
    table,
    packageAlias,
    packageConfig,
    packageSource: packageFromField === undefined ? "table-default" : "record-field",
    event,
  };
}

function modernSubject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.statusField && value.stages);
}

function subjectTable(subject, stage = null) {
  const statusField = subject.statusField ?? {};
  return {
    ...subject,
    baseToken: subject.baseToken,
    tableId: subject.tableId,
    subjectKey: subject.subjectKey,
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
    defaultPackageAlias: subject.packageRoute?.packageAlias ?? null,
  };
}

function stageEntries(subject) {
  return Object.entries(subject.stages ?? {}).filter(([, stage]) => stage && typeof stage === "object");
}

function modernDecision(subject, event) {
  if (!subject || !event || typeof event !== "object") return { kind: "ignored", reason: "invalid_event" };
  if (subject.baseToken && event.baseToken && subject.baseToken !== event.baseToken) {
    return { kind: "ignored", reason: "unknown_table" };
  }
  if (subject.tableId && event.tableId && subject.tableId !== event.tableId) {
    return { kind: "ignored", reason: "unknown_table" };
  }
  const statusField = subject.statusField ?? {};
  const statusFieldId = statusField.fieldId ?? statusField.field_id;
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
  if (statusFieldId && event.statusFieldId !== statusFieldId) {
    return { kind: "ignored", reason: "unrelated_field" };
  }
  const entries = stageEntries(subject);
  const previous = entries.find(([, candidate]) => candidate.trigger?.optionId === event.beforeOptionId);
  const targetAny = entries.find(([, candidate]) => candidate.trigger?.optionId === event.afterOptionId);
  if (event.beforeOptionId === event.afterOptionId) {
    return { kind: "ignored", reason: "already_at_trigger", subject, table: subjectTable(subject) };
  }
  const target = entries.find(([, candidate]) => (
    candidate.enabled === true && candidate.trigger?.optionId === event.afterOptionId
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
    if (targetAny && targetAny[1]?.enabled !== true) {
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
    subjectKey: subject.subjectKey,
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

/**
 * Decide either a legacy table event or a versioned phased subject event.
 * Keeping the legacy call shape is intentional: old manual tables remain
 * readable, while only a subject with the fixed stage contract can return a
 * `register` decision.
 */
export function decideRecordChange(configOrSubject, event) {
  if (modernSubject(configOrSubject)) return modernDecision(configOrSubject, event);
  if (configOrSubject?.subject && modernSubject(configOrSubject.subject)) {
    return modernDecision(configOrSubject.subject, event);
  }
  return legacyDecision(configOrSubject, event);
}

/** Convert a workflow catalog into the table list consumed by the event loop. */
export function configuredTables(config) {
  const legacy = Array.isArray(config?.tables) ? config.tables : [];
  const workflow = config?.workflow;
  if (!workflow || !Array.isArray(workflow.bases)) return legacy;
  const subjects = workflow.bases.flatMap((base) => base.subjects ?? [])
    .filter((subject) => subject.lifecycle === "enabled" || subject.activeSnapshot);
  if (subjects.length === 0) return legacy;
  const modern = subjects.map((subject) => {
    const active = subject.lifecycle === "enabled" ? subject : subject.activeSnapshot;
    const status = active.statusField ?? {};
    return {
      ...active,
      subjectKey: active.subjectKey,
      baseToken: active.baseToken ?? baseTokenFromKey(active.subjectKey),
      tableId: active.tableId,
      name: active.tableName,
      mode: active.execution?.mode ?? "manual",
      triggerField: status.fieldName ?? active.trigger?.fieldName,
      triggerFieldId: status.fieldId ?? active.trigger?.fieldId,
      triggerValue: active.trigger?.startValue ?? "",
      statusField: status,
    };
  });
  const modernKeys = new Set(modern.map((entry) => `${entry.baseToken}:${entry.tableId}`));
  return [
    ...legacy.filter((entry) => !modernKeys.has(`${entry.baseToken ?? ""}:${entry.tableId}`)),
    ...modern,
  ];
}

function baseTokenFromKey(value) {
  return typeof value === "string" ? value.split(":", 1)[0] : "";
}
