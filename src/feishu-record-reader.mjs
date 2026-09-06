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

function configuredFieldValue(fields, descriptor) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !descriptor) return undefined;
  const fieldId = descriptor.fieldId ?? descriptor.field_id;
  const fieldName = descriptor.fieldName ?? descriptor.name;
  if (fieldId && Object.hasOwn(fields, fieldId)) return fields[fieldId];
  if (fieldName && Object.hasOwn(fields, fieldName)) return fields[fieldName];
  return undefined;
}

function collectDocumentLinks(value, result = []) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      try {
        const url = new URL(trimmed);
        const host = url.hostname.toLowerCase();
        if (url.protocol === "https:" && (host === "feishu.cn" || host.endsWith(".feishu.cn"))
          && /^\/docx\/[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(url.pathname)) {
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          result.push(url.toString());
        }
      } catch {
        // Invalid links are represented by an empty candidate set and are
        // blocked later by Taskboard; they are never treated as paths.
      }
    }
    return result;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectDocumentLinks(entry, result);
    return result;
  }
  if (value && typeof value === "object") {
    for (const key of ["url", "link", "text", "value", "token", "document_url", "doc_url"]) {
      if (Object.hasOwn(value, key)) collectDocumentLinks(value[key], result);
    }
  }
  return result;
}

function normalizedName(value) {
  return titleText(value).trim();
}

function uniqueProof(result) {
  if (result === true) return true;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (result.provedUnique === true || result.namingValueUnique === true || result.unique === true) return true;
  if (result.provedUnique === false || result.namingValueUnique === false || result.unique === false) return false;
  if (Array.isArray(result.records) || Array.isArray(result.items)) {
    const entries = result.records ?? result.items;
    return entries.length === 1;
  }
  return false;
}

/**
 * Create a read-only reader for the controlled document and naming fields.
 * The reader intentionally returns bounded inert values; source cardinality
 * and naming validity are enforced by Taskboard at run preparation time.
 */
export function createFeishuControlledContextReader({ client, searchNaming = null, logger = console } = {}) {
  if (typeof client?.bitable?.v1?.appTableRecord?.get !== "function") {
    throw new Error("Feishu client must expose bitable.v1.appTableRecord.get");
  }
  const getRecord = client.bitable.v1.appTableRecord.get.bind(client.bitable.v1.appTableRecord);
  async function read(table, identity = {}) {
    const baseToken = identity.baseToken ?? table.baseToken;
    const tableId = identity.tableId ?? table.tableId;
    const recordId = identity.recordId;
    const response = await getRecord({
      path: { app_token: baseToken, table_id: tableId, record_id: recordId },
    });
    if (response?.code !== 0) {
      const error = new Error("Feishu record lookup failed");
      error.code = String(response?.code ?? "FEISHU_RECORD_LOOKUP_FAILED");
      error.status = 502;
      throw error;
    }
    const fields = response?.data?.record?.fields ?? {};
    const documentField = table.documentField ?? {
      fieldId: table.documentFieldId,
      fieldName: table.documentFieldName,
    };
    const namingField = table.namingField ?? {
      fieldId: table.namingFieldId,
      fieldName: table.namingFieldName,
    };
    const documentLinks = [...new Set(collectDocumentLinks(configuredFieldValue(fields, documentField)))].slice(0, 32);
    const namingDisplayValue = normalizedName(configuredFieldValue(fields, namingField));
    let namingValueUnique = false;
    if (namingDisplayValue && typeof searchNaming === "function") {
      try {
        const proof = await searchNaming({
          baseToken,
          tableId,
          recordId,
          fieldId: namingField.fieldId ?? namingField.field_id,
          fieldName: namingField.fieldName ?? namingField.name,
          value: namingDisplayValue,
        });
        namingValueUnique = uniqueProof(proof);
      } catch (error) {
        try { logger.warn?.("Feishu naming uniqueness proof unavailable"); } catch {}
        namingValueUnique = false;
      }
    }
    return { documentLinks, namingDisplayValue, namingValueUnique };
  }
  return Object.freeze({ readControlledRecordContext: read, read });
}

/** Read a controlled context from a reader object/function without guessing fields. */
export async function readControlledRecordContext(reader, table, identity = {}) {
  const operation = typeof reader === "function"
    ? reader
    : reader?.readControlledRecordContext ?? reader?.read;
  if (typeof operation !== "function") throw new Error("controlled context reader is unavailable");
  const result = await operation.call(reader, table, identity);
  const input = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  return {
    documentLinks: Array.isArray(input.documentLinks)
      ? input.documentLinks.filter((value) => typeof value === "string").slice(0, 32)
      : [],
    namingDisplayValue: typeof input.namingDisplayValue === "string" ? input.namingDisplayValue : "",
    namingValueUnique: input.namingValueUnique === true,
  };
}

export const createFeishuControlledContextResolver = createFeishuControlledContextReader;

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
