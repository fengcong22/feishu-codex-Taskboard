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
        const navigationHints = url.searchParams.getAll("pre_pathname");
        const hasNoQuery = url.search === "" && !trimmed.includes("?");
        const hasOnlyNavigationHint = navigationHints.length === 1
          && navigationHints[0] !== ""
          && [...url.searchParams].length === 1;
        if (url.toString() === trimmed && url.protocol === "https:"
          && (host === "feishu.cn" || host.endsWith(".feishu.cn"))
          && url.username === "" && url.password === ""
          && (hasNoQuery || hasOnlyNavigationHint)
          && url.hash === "" && !trimmed.includes("#")
          && /^\/(?:docx|wiki)\/[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(url.pathname)) {
          url.search = "";
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

function uniqueProof(result, expectedRecordId) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (Array.isArray(result.records) || Array.isArray(result.items)) {
    const entries = result.records ?? result.items;
    return entries.length === 1 && entries[0]?.record_id === expectedRecordId;
  }
  return false;
}

/**
 * Build a read-only exact-value search for the configured naming field.
 * Returning null when the SDK does not expose search keeps the reader
 * fail-closed: Taskboard will not treat an unproved name as unique.
 */
export function createFeishuNamingSearch({ client } = {}) {
  const search = client?.bitable?.v1?.appTableRecord?.search;
  if (typeof search !== "function") return null;
  const searchRecords = search.bind(client.bitable.v1.appTableRecord);

  async function searchPage(request) {
    const response = await searchRecords(request);
    if (response?.code !== 0) {
      const error = new Error("Feishu naming search failed");
      error.code = String(response?.code ?? "FEISHU_NAMING_SEARCH_FAILED");
      error.status = 502;
      throw error;
    }
    const data = response?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)
      || !Array.isArray(data.items)) {
      const error = new Error("Feishu naming search response is invalid");
      error.code = "FEISHU_NAMING_SEARCH_INVALID_RESPONSE";
      error.status = 502;
      throw error;
    }
    return data;
  }

  return async function searchNaming({
    baseToken,
    tableId,
    fieldId,
    fieldName,
    value,
  } = {}) {
    const field = typeof fieldName === "string" && fieldName.trim() !== ""
      ? fieldName.trim()
      : typeof fieldId === "string" && fieldId.trim() !== ""
        ? fieldId.trim()
        : null;
    if (typeof baseToken !== "string" || baseToken.trim() === ""
      || typeof tableId !== "string" || tableId.trim() === ""
      || !field || typeof value !== "string" || value.trim() === "") {
      return { provedUnique: false };
    }
    const path = {
      app_token: baseToken.trim(),
      table_id: tableId.trim(),
    };
    const data = await searchPage({
      path: {
        ...path,
      },
      data: {
        field_names: [field],
        filter: {
          conjunction: "and",
          conditions: [{ field_name: field, operator: "is", value: [value] }],
        },
      },
      params: { page_size: 2 },
    });
    if (data.has_more === true) return { provedUnique: false };
    if (data.items.length > 0) return { records: data.items.slice(0, 2) };

    const matches = [];
    const seenPageTokens = new Set();
    let pageToken = null;
    do {
      const page = await searchPage({
        path,
        data: { field_names: [field] },
        params: { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
      });
      for (const record of page.items) {
        const fieldValue = configuredFieldValue(record?.fields, { fieldId, fieldName: field });
        if (normalizedName(fieldValue) === value.trim()) {
          matches.push({ record_id: record.record_id });
          if (matches.length === 2) return { records: matches };
        }
      }
      if (page.has_more !== true) break;
      const nextPageToken = typeof page.page_token === "string" ? page.page_token.trim() : "";
      if (!nextPageToken || seenPageTokens.has(nextPageToken)) {
        const error = new Error("Feishu naming search response is invalid");
        error.code = "FEISHU_NAMING_SEARCH_INVALID_RESPONSE";
        error.status = 502;
        throw error;
      }
      seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    } while (pageToken);
    return { records: matches };
  };
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
      params: { text_field_as_array: true },
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
        namingValueUnique = uniqueProof(proof, recordId);
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
