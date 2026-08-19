import { createHash } from "node:crypto";

export const BITABLE_RECORD_CHANGED_EVENT = "drive.file.bitable_record_changed_v1";

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function decodeJsonValue(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    return parsed === value ? value : decodeJsonValue(parsed);
  } catch {
    return trimmed;
  }
}

export function displayValue(value, table) {
  const decoded = decodeJsonValue(value);
  if (decoded === null || decoded === undefined) return "";
  if (typeof decoded === "string") {
    const text = decoded.trim();
    if (table.triggerOptionId && text === table.triggerOptionId) return table.triggerValue;
    return text;
  }
  if (Array.isArray(decoded)) {
    const values = decoded.map((entry) => displayValue(entry, table)).filter(Boolean);
    return values.length === 1 ? values[0] : values;
  }
  const object = objectValue(decoded);
  if (object) {
    if (table.triggerOptionId && object.option_id === table.triggerOptionId) {
      return table.triggerValue;
    }
    for (const key of ["text", "name", "label", "value", "string_value"]) {
      if (Object.hasOwn(object, key)) return displayValue(object[key], table);
    }
    if (Object.hasOwn(object, "option_id")) return String(object.option_id);
  }
  return decoded;
}

function fieldEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
    && typeof (entry.field_id ?? entry.fieldId) === "string"
  ));
}

function fieldMap(entries, table) {
  const result = new Map();
  for (const entry of fieldEntries(entries)) {
    const fieldId = entry.field_id ?? entry.fieldId;
    result.set(fieldId, displayValue(entry.field_value ?? entry.fieldValue, table));
  }
  return result;
}

function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fingerprint(value) {
  let serialized = "";
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    serialized = String(value);
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 20);
}

function eventEnvelope(payload) {
  const root = objectValue(payload) ?? {};
  const header = objectValue(root.header) ?? {};
  const event = objectValue(root.event) ?? root;
  return { header, event };
}

function actionEntries(event) {
  if (Array.isArray(event.action_list) && event.action_list.length > 0) {
    return event.action_list;
  }
  return [event];
}

function changedFieldIds(before, after) {
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids].filter((fieldId) => !equalValue(before.get(fieldId), after.get(fieldId)));
}

function packageFieldValue(table, after, source) {
  if (table.packageFieldId && after.has(table.packageFieldId)) {
    return after.get(table.packageFieldId);
  }
  if (table.packageField && objectValue(source.fields)) {
    return source.fields[table.packageField];
  }
  return undefined;
}

/**
 * Convert the SDK's event envelope into the Bridge's deliberately small event
 * shape. The SDK can batch several record actions in one callback, so one
 * normalized event is returned per action.
 */
export function normalizeBitableRecordChanged(payload, table) {
  const { header, event } = eventEnvelope(payload);
  const sourceEventId = String(header.event_id ?? header.eventId ?? event.event_id ?? "").trim();
  const baseToken = String(
    event.file_token
      ?? event.fileToken
      ?? event.base_token
      ?? event.baseToken
      ?? header.token
      ?? table.baseToken
      ?? "",
  ).trim();
  const envelopeTableId = String(event.table_id ?? event.tableId ?? "").trim();
  const actions = actionEntries(event);
  const batched = actions.length > 1;
  const normalized = [];
  const actionOccurrences = new Map();

  actions.forEach((action, index) => {
    const actionObject = objectValue(action) ?? {};
    const actionTableId = String(actionObject.table_id ?? actionObject.tableId ?? "").trim();
    if (actionTableId && actionTableId !== table.tableId) return;
    if (!actionTableId && envelopeTableId && envelopeTableId !== table.tableId) return;
    const actionName = String(
      actionObject.action ?? event.action ?? "record_edited",
    ).trim();
    if (actionName === "record_deleted") return;

    const recordId = String(
      actionObject.record_id
        ?? actionObject.recordId
        ?? event.record_id
        ?? event.recordId
        ?? "",
    ).trim();
    if (!recordId) return;
    const tableId = actionTableId || envelopeTableId || table.tableId;

    const before = fieldMap(
      actionObject.before_value ?? actionObject.beforeValue ?? event.before_value ?? event.beforeValue,
      table,
    );
    const after = fieldMap(
      actionObject.after_value ?? actionObject.afterValue ?? event.after_value ?? event.afterValue,
      table,
    );
    const changedIds = changedFieldIds(before, after);
    const triggerFieldId = table.triggerFieldId && (before.has(table.triggerFieldId) || after.has(table.triggerFieldId))
      ? table.triggerFieldId
      : changedIds[0] ?? table.triggerFieldId ?? "";
    const beforeValue = before.get(triggerFieldId) ?? "";
    const afterValue = after.get(triggerFieldId) ?? "";
    const packageValue = packageFieldValue(table, after, actionObject);
    const fields = {};
    if (table.packageField && packageValue !== undefined) fields[table.packageField] = packageValue;

    const actionSignature = fingerprint({
      action: actionName,
      before: [...before.entries()],
      after: [...after.entries()],
    });
    const occurrenceKey = `${tableId}:${recordId}:${actionSignature}`;
    const occurrence = actionOccurrences.get(occurrenceKey) ?? 0;
    actionOccurrences.set(occurrenceKey, occurrence + 1);
    const fallbackId = `feishu:${tableId}:${recordId}:${actionSignature}:${occurrence}`;
    const eventId = sourceEventId
      ? (batched
        ? `${sourceEventId}:${tableId}:${recordId}:${actionSignature}:${occurrence}`
        : sourceEventId)
      : fallbackId;
    normalized.push({
      eventId,
      baseToken,
      tableId,
      recordId,
      recordTitle: String(
        actionObject.record_title
          ?? actionObject.recordTitle
          ?? event.record_title
          ?? event.recordTitle
          ?? "",
      ).trim(),
      action: actionName,
      fieldId: triggerFieldId,
      fieldName: triggerFieldId === table.triggerFieldId
        ? table.triggerField
        : String(actionObject.field_name ?? actionObject.fieldName ?? triggerFieldId).trim(),
      beforeValue,
      afterValue,
      fields,
      fieldValuesById: Object.fromEntries(after.entries()),
    });
  });

  return normalized;
}
