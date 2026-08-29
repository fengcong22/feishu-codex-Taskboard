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
      const execution = subject.execution ?? {};
      const route = subject.packageRoute ?? {};
      const upload = subject.upload ?? {};
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
        triggerField: trigger.fieldName,
        triggerFieldId: trigger.fieldId,
        triggerValue: trigger.startValue,
        triggerOptionId: trigger.optionId,
        titleField: subject.title?.fieldName ?? null,
        titleFieldId: subject.title?.fieldId ?? null,
        packageField: null,
        packageFieldId: null,
        defaultPackageAlias: route.packageAlias,
        packageRoute: route,
      });
    }
  }
  return tables;
}

function legacyTables(config) {
  if (!Array.isArray(config?.tables)) return [];
  return config.tables.filter((table) => table?.lifecycle === undefined || table.lifecycle === "enabled");
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
