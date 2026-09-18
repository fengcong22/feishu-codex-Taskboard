const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TEXT_LENGTH = 4_096;

export class FeishuRecordWritebackError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "FeishuRecordWritebackError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 400) {
  throw new FeishuRecordWritebackError(code, message, status);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, keys, name) {
  const object = plainObject(value);
  if (!object || Object.keys(object).some((key) => !keys.has(key))) {
    fail("WRITEBACK_INTENT_INVALID", `${name} is invalid`);
  }
  return object;
}

function identifier(value, name) {
  if (typeof value !== "string" || value.includes("\0")) {
    fail("WRITEBACK_INTENT_INVALID", `${name} is invalid`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) {
    fail("WRITEBACK_INTENT_INVALID", `${name} is invalid`);
  }
  return normalized;
}

function frozenIntent(value) {
  const input = exactKeys(value, new Set(["target", "operation"]), "writeback intent");
  const target = exactKeys(input.target, new Set(["baseToken", "tableId", "recordId"]), "writeback target");
  const operation = exactKeys(input.operation, new Set(["type", "fieldId", "optionId", "value"]), "writeback operation");
  const type = identifier(operation.type, "operation.type");
  if (type === "single_select") {
    if (Object.keys(operation).some((key) => !["type", "fieldId", "optionId"].includes(key))) {
      fail("WRITEBACK_INTENT_INVALID", "single-select operation is invalid");
    }
    return {
      target: {
        baseToken: identifier(target.baseToken, "target.baseToken"),
        tableId: identifier(target.tableId, "target.tableId"),
        recordId: identifier(target.recordId, "target.recordId"),
      },
      operation: {
        type,
        fieldId: identifier(operation.fieldId, "operation.fieldId"),
        optionId: identifier(operation.optionId, "operation.optionId"),
      },
    };
  }
  if (type === "text") {
    if (Object.keys(operation).some((key) => !["type", "fieldId", "value"].includes(key))
      || typeof operation.value !== "string" || operation.value.includes("\0")
      || operation.value.length > MAX_TEXT_LENGTH) {
      fail("WRITEBACK_INTENT_INVALID", "text operation is invalid");
    }
    return {
      target: {
        baseToken: identifier(target.baseToken, "target.baseToken"),
        tableId: identifier(target.tableId, "target.tableId"),
        recordId: identifier(target.recordId, "target.recordId"),
      },
      operation: {
        type,
        fieldId: identifier(operation.fieldId, "operation.fieldId"),
        value: operation.value,
      },
    };
  }
  fail("WRITEBACK_INTENT_INVALID", "operation.type is invalid");
}

function responseData(response, code = "FEISHU_WRITEBACK_FAILED") {
  if (!response || response.code !== 0 || !plainObject(response.data)) {
    fail(code, "Feishu writeback request failed", 502);
  }
  return response.data;
}

function decoded(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function optionValue(value) {
  const input = decoded(value);
  if (typeof input === "string") return input.trim() || null;
  if (Array.isArray(input)) {
    const values = input.map(optionValue).filter(Boolean);
    return values.length === 1 ? values[0] : null;
  }
  const object = plainObject(input);
  if (!object) return null;
  for (const key of ["option_id", "optionId", "id", "value", "text", "name", "label"]) {
    if (Object.hasOwn(object, key)) {
      const resolved = optionValue(object[key]);
      if (resolved) return resolved;
    }
  }
  return null;
}

function textValue(value) {
  const input = decoded(value);
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    const parts = [];
    for (const entry of input) {
      const object = plainObject(entry);
      if (!object || typeof object.text !== "string") return null;
      parts.push(object.text);
    }
    return parts.join("");
  }
  const object = plainObject(input);
  return typeof object?.text === "string" ? object.text : null;
}

function rawRecordValue(recordFields, field) {
  const byId = Object.hasOwn(recordFields, field.fieldId) ? recordFields[field.fieldId] : undefined;
  const byName = Object.hasOwn(recordFields, field.fieldName) ? recordFields[field.fieldName] : undefined;
  if (byId !== undefined && byName !== undefined && JSON.stringify(byId) !== JSON.stringify(byName)) {
    fail("FIELD_VALUE_CONFLICT", "The current field value is ambiguous", 409);
  }
  return byId ?? byName;
}

function normalizeField(value) {
  const input = plainObject(value);
  const fieldId = typeof input?.field_id === "string" ? input.field_id.trim()
    : typeof input?.fieldId === "string" ? input.fieldId.trim() : "";
  const fieldName = typeof input?.field_name === "string" ? input.field_name
    : typeof input?.fieldName === "string" ? input.fieldName : "";
  if (!fieldId || !fieldName.trim()) return null;
  const options = input.property?.options ?? input.options ?? [];
  if (!Array.isArray(options)) return null;
  return {
    fieldId,
    fieldName,
    type: input.type,
    uiType: input.ui_type ?? input.uiType ?? null,
    options: options.map((option) => ({
      id: typeof option?.id === "string" ? option.id.trim()
        : typeof option?.option_id === "string" ? option.option_id.trim() : "",
      name: typeof option?.name === "string" ? option.name
        : typeof option?.option_name === "string" ? option.option_name : "",
    })).filter((option) => option.id && option.name.trim()),
  };
}

async function readFields(listFields, target) {
  const fields = [];
  let pageToken = null;
  const seenPageTokens = new Set();
  do {
    let response;
    try {
      response = await listFields({
        path: { app_token: target.baseToken, table_id: target.tableId },
        ...(pageToken ? { params: { page_token: pageToken } } : {}),
      });
    } catch {
      fail("FEISHU_WRITEBACK_FAILED", "Feishu writeback request failed", 502);
    }
    const data = responseData(response);
    if (!Array.isArray(data.items)) fail("FIELD_METADATA_INVALID", "Feishu field metadata is invalid", 502);
    fields.push(...data.items.map(normalizeField));
    if (!data.has_more) return fields;
    pageToken = typeof data.page_token === "string" ? data.page_token.trim() : "";
    if (!pageToken || seenPageTokens.has(pageToken)) {
      fail("FIELD_METADATA_INVALID", "Feishu field metadata is invalid", 502);
    }
    seenPageTokens.add(pageToken);
  } while (true);
}

function targetField(fields, operation) {
  const matches = fields.filter((field) => field?.fieldId === operation.fieldId);
  if (matches.length !== 1) fail("FIELD_CHANGED", "The configured field no longer exists", 409);
  return matches[0];
}

function validateOperationField(field, operation) {
  if (operation.type === "single_select") {
    if (field.type !== 3 || (field.uiType !== null && field.uiType !== "SingleSelect")) {
      fail("FIELD_NOT_WRITABLE", "The configured field is no longer a single-select field", 409);
    }
    const option = field.options.find((entry) => entry.id === operation.optionId);
    if (!option) fail("FIELD_OPTION_CHANGED", "The configured single-select option no longer exists", 409);
    return option;
  }
  if (field.type !== 1 || (field.uiType !== null && field.uiType !== "Text")) {
    fail("FIELD_NOT_WRITABLE", "The configured field is no longer writable text", 409);
  }
  return null;
}

/**
 * Applies a writeback intent obtained from a trusted local resolver. This
 * module deliberately accepts no client-provided Base, record, or field data.
 */
export function createFeishuRecordWriter({ client } = {}) {
  const listFields = client?.bitable?.v1?.appTableField?.list;
  const getRecord = client?.bitable?.v1?.appTableRecord?.get;
  const updateRecord = client?.bitable?.v1?.appTableRecord?.update;
  if (typeof listFields !== "function" || typeof getRecord !== "function" || typeof updateRecord !== "function") {
    throw new Error("Feishu client must expose field listing and record read/write methods");
  }

  async function apply(value) {
    const intent = frozenIntent(value);
    const fields = await readFields(listFields.bind(client.bitable.v1.appTableField), intent.target);
    const field = targetField(fields, intent.operation);
    const option = validateOperationField(field, intent.operation);

    let current;
    try {
      current = responseData(await getRecord.call(client.bitable.v1.appTableRecord, {
        path: {
          app_token: intent.target.baseToken,
          table_id: intent.target.tableId,
          record_id: intent.target.recordId,
        },
        params: { text_field_as_array: true },
      }));
    } catch (error) {
      if (error instanceof FeishuRecordWritebackError) throw error;
      fail("FEISHU_WRITEBACK_FAILED", "Feishu writeback request failed", 502);
    }
    const recordFields = plainObject(current.record?.fields);
    if (!recordFields) fail("FEISHU_WRITEBACK_FAILED", "Feishu writeback request failed", 502);
    const currentValue = rawRecordValue(recordFields, field);
    const alreadyApplied = intent.operation.type === "single_select"
      ? [intent.operation.optionId, option.name].includes(optionValue(currentValue))
      : textValue(currentValue) === intent.operation.value;
    if (alreadyApplied) return { outcome: "already_applied" };

    try {
      responseData(await updateRecord.call(client.bitable.v1.appTableRecord, {
        path: {
          app_token: intent.target.baseToken,
          table_id: intent.target.tableId,
          record_id: intent.target.recordId,
        },
        data: {
          fields: {
            [field.fieldName]: intent.operation.type === "single_select"
              ? option.name : intent.operation.value,
          },
        },
      }));
    } catch (error) {
      if (error instanceof FeishuRecordWritebackError) throw error;
      fail("FEISHU_WRITEBACK_FAILED", "Feishu writeback request failed", 502);
    }
    return { outcome: "updated" };
  }

  return Object.freeze({ apply });
}
