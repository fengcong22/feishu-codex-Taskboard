function titleText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const decoded = JSON.parse(trimmed);
      if (decoded !== value) return titleText(decoded);
    } catch {}
    return trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(titleText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    for (const key of ["text", "name", "label", "value", "string_value"]) {
      if (Object.hasOwn(value, key)) return titleText(value[key]);
    }
  }
  return "";
}

function configuredCandidates(table) {
  return [
    [table.titleFieldId, table.titleField],
    [table.fallbackTitleFieldId, table.fallbackTitleField],
  ];
}

export function selectRecordTitle({ table, fieldValuesById = {}, fieldsByName = {} } = {}) {
  for (const [fieldId, fieldName] of configuredCandidates(table ?? {})) {
    const byId = fieldId ? titleText(fieldValuesById[fieldId]) : "";
    if (byId) return byId;
    const byName = fieldName ? titleText(fieldsByName[fieldName]) : "";
    if (byName) return byName;
  }
  return "";
}

export function createFeishuRecordTitleResolver({ client, logger = console } = {}) {
  if (typeof client?.bitable?.v1?.appTableRecord?.get !== "function") {
    throw new Error("Feishu client must expose bitable.v1.appTableRecord.get");
  }
  return async (event, table) => {
    const response = await client.bitable.v1.appTableRecord.get({
      path: {
        app_token: event.baseToken,
        table_id: event.tableId,
        record_id: event.recordId,
      },
    });
    if (response?.code !== 0) {
      const error = new Error(`Feishu record lookup failed: ${response?.msg ?? "unknown error"}`);
      error.code = String(response?.code ?? "FEISHU_RECORD_LOOKUP_FAILED");
      throw error;
    }
    return selectRecordTitle({
      table,
      fieldValuesById: event.fieldValuesById,
      fieldsByName: response?.data?.record?.fields,
    });
  };
}
