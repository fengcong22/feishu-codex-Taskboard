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

export function decideRecordChange(config, event) {
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
  if (displayValue(event.afterValue) !== table.triggerValue) {
    return { kind: "ignored", reason: "new_value_not_trigger" };
  }
  if (displayValue(event.beforeValue) === table.triggerValue) {
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
