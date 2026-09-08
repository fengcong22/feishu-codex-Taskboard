/**
 * Read-only Feishu Base metadata helpers.
 *
 * This module intentionally has no record or write APIs.  The value returned
 * by the SDK is reduced to the stable identifiers and display names that the
 * local workflow catalogue needs; credentials and SDK error text never leave
 * this process.
 */

const BASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const FEISHU_LINK_HOST_SUFFIXES = ["feishu.cn"];

function fail(message, code = "INVALID_BASE_LINK") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function identifier(value, name) {
  if (typeof value !== "string") {
    throw fail(`${name} is invalid`, "FEISHU_METADATA_INVALID_RESPONSE");
  }
  const result = value.trim();
  if (!BASE_ID_PATTERN.test(result)) {
    throw fail(`${name} is invalid`, "FEISHU_METADATA_INVALID_RESPONSE");
  }
  return result;
}

function displayName(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail(`${name} is invalid`, "FEISHU_METADATA_INVALID_RESPONSE");
  }
  const result = value.trim();
  if (/^[\u0000-\u001f\u007f]/u.test(result) || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw fail(`${name} is invalid`, "FEISHU_METADATA_INVALID_RESPONSE");
  }
  return result;
}

function baseLinkError() {
  // Do not include the user-supplied URL in this error.  Apart from keeping
  // responses safe, this prevents a pasted token from being copied into logs.
  return fail("Base link is invalid", "INVALID_BASE_LINK");
}

function parseIdentifier(value, name) {
  if (typeof value !== "string" || !BASE_ID_PATTERN.test(value.trim())) {
    throw baseLinkError();
  }
  return value.trim();
}

function isFeishuLinkHost(hostname) {
  const normalized = typeof hostname === "string" ? hostname.toLowerCase() : "";
  return FEISHU_LINK_HOST_SUFFIXES.some((suffix) => (
    normalized === suffix || normalized.endsWith(`.${suffix}`)
  ));
}

/**
 * Parse a direct Base URL or a Wiki URL that may point to a Base. Wiki tokens
 * stay distinct until the official API confirms the node type and resolves
 * the real Base token.
 */
export function parseBaseLink(input) {
  if (typeof input !== "string" || input.trim() === "") throw baseLinkError();
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw baseLinkError();
  }
  if (url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || !isFeishuLinkHost(url.hostname)) throw baseLinkError();

  const segments = url.pathname.split("/");
  if (segments.length !== 3
    || segments[0] !== ""
    || !["base", "wiki"].includes(segments[1])) {
    throw baseLinkError();
  }
  const sourceType = segments[1];
  const sourceToken = parseIdentifier(segments[2], `${sourceType} token`);

  const tableValues = url.searchParams.getAll("table");
  if (tableValues.length > 1 || tableValues.some((value) => value.trim() === "")) {
    throw baseLinkError();
  }
  const tableId = tableValues.length === 1
    ? parseIdentifier(tableValues[0], "table id")
    : undefined;
  const parsed = sourceType === "base"
    ? { baseToken: sourceToken }
    : { wikiToken: sourceToken };
  return tableId ? { ...parsed, tableId } : parsed;
}

function sdkMethod(client, path, method) {
  const value = client?.bitable?.v1?.[path]?.[method];
  if (typeof value !== "function") {
    const error = new Error("Feishu metadata client is unavailable");
    error.code = "FEISHU_METADATA_CLIENT_INVALID";
    throw error;
  }
  return value.bind(client.bitable.v1[path]);
}

function wikiNodeMethod(client) {
  const value = client?.wiki?.v2?.space?.getNode;
  if (typeof value !== "function") {
    const error = new Error("Feishu metadata client is unavailable");
    error.code = "FEISHU_METADATA_CLIENT_INVALID";
    throw error;
  }
  return value.bind(client.wiki.v2.space);
}

function assertSuccess(response) {
  if (!response || response.code !== 0) {
    const error = new Error("Feishu Base metadata request failed");
    error.code = "FEISHU_METADATA_READ_FAILED";
    error.status = 502;
    // Keep the SDK response only as a non-enumerable diagnostic cause.  The
    // HTTP layer serializes the safe error code and generic message instead.
    Object.defineProperty(error, "sdkCode", {
      value: response?.code,
      enumerable: false,
    });
    throw error;
  }
  return response;
}

async function callSdk(method, request) {
  let response;
  try {
    response = await method(request);
  } catch (cause) {
    const error = fail("Feishu Base metadata request failed", "FEISHU_METADATA_READ_FAILED");
    error.status = 502;
    Object.defineProperty(error, "cause", { value: cause, enumerable: false });
    throw error;
  }
  return assertSuccess(response);
}

function responseItems(response) {
  const data = response?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw fail("Feishu metadata response is invalid", "FEISHU_METADATA_INVALID_RESPONSE");
  }
  const items = data.items;
  if (items === undefined) return [];
  if (!Array.isArray(items)) {
    throw fail("Feishu metadata response is invalid", "FEISHU_METADATA_INVALID_RESPONSE");
  }
  return items;
}

async function readAllPages(method, initialRequest) {
  const items = [];
  let request = initialRequest;
  const seenPageTokens = new Set();
  while (true) {
    const response = await callSdk(method, request);
    items.push(...responseItems(response));
    const data = response.data ?? {};
    if (!data.has_more) return items;
    const pageToken = typeof data.page_token === "string" ? data.page_token.trim() : "";
    if (!pageToken || seenPageTokens.has(pageToken)) {
      throw fail("Feishu metadata pagination is invalid", "FEISHU_METADATA_INVALID_RESPONSE");
    }
    seenPageTokens.add(pageToken);
    request = {
      path: initialRequest.path,
      params: { page_token: pageToken },
    };
  }
}

function normalizeOption(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail(`Feishu field option ${index} is invalid`, "FEISHU_METADATA_INVALID_RESPONSE");
  }
  const id = identifier(value.id ?? value.option_id, `field option ${index} id`);
  const rawName = value.name ?? value.option_name;
  if (typeof rawName === "string" && /[\u0000-\u001f\u007f-\u009f]/u.test(rawName)) {
    throw fail(`field option ${index} name is invalid`, "FEISHU_METADATA_INVALID_RESPONSE");
  }
  if (typeof rawName === "string" && rawName.trim() === "") {
    return null;
  }
  const name = displayName(rawName, `field option ${index} name`);
  const option = { id, name };
  if (Number.isInteger(value.color)) option.color = value.color;
  return option;
}

function normalizeField(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail(`Feishu field ${index} is invalid`, "FEISHU_METADATA_INVALID_RESPONSE");
  }
  const fieldId = identifier(value.field_id ?? value.fieldId ?? value.id, `field ${index} id`);
  const fieldName = displayName(
    value.field_name ?? value.fieldName ?? value.name,
    `field ${index} name`,
  );
  const optionsSource = value.property?.options ?? value.options ?? [];
  if (!Array.isArray(optionsSource)) {
    throw fail(`Feishu field ${index} options are invalid`, "FEISHU_METADATA_INVALID_RESPONSE");
  }
  return {
    fieldId,
    fieldName,
    type: value.type ?? null,
    uiType: value.ui_type ?? value.uiType ?? null,
    options: optionsSource.map(normalizeOption).filter((option) => option !== null),
  };
}

function normalizeTable(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail(`Feishu table ${index} is invalid`, "FEISHU_METADATA_INVALID_RESPONSE");
  }
  return {
    tableId: identifier(value.table_id ?? value.tableId ?? value.id, `table ${index} id`),
    tableName: displayName(value.name ?? value.table_name ?? value.tableName, `table ${index} name`),
  };
}

function normalizeApp(response, baseToken) {
  const data = response?.data;
  const app = data?.app && typeof data.app === "object" ? data.app : data;
  if (!app || typeof app !== "object" || Array.isArray(app)) {
    throw fail("Feishu Base response is invalid", "FEISHU_METADATA_INVALID_RESPONSE");
  }
  const responseToken = app.app_token ?? app.appToken ?? app.base_token ?? app.baseToken;
  if (responseToken !== undefined && identifier(responseToken, "Base token") !== baseToken) {
    throw fail("Feishu Base response does not match the requested Base", "FEISHU_METADATA_INVALID_RESPONSE");
  }
  return {
    baseToken,
    baseName: displayName(app.name ?? app.app_name ?? app.base_name, "Base name"),
  };
}

function normalizeWikiBase(response, wikiToken) {
  const node = response?.data?.node;
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw fail("Feishu Wiki response is invalid", "FEISHU_METADATA_INVALID_RESPONSE");
  }
  if (node.node_token !== undefined
    && identifier(node.node_token, "Wiki node token") !== wikiToken) {
    throw fail(
      "Feishu Wiki response does not match the requested node",
      "FEISHU_METADATA_INVALID_RESPONSE",
    );
  }
  if (node.obj_type !== "bitable") {
    const error = fail("Feishu Wiki node is not a Base", "FEISHU_WIKI_NOT_BASE");
    error.status = 400;
    throw error;
  }
  return identifier(node.obj_token, "Base token");
}

/**
 * Build an adapter around the official SDK client. Direct Base previews only
 * invoke bitable read APIs; Wiki previews first invoke `wiki.v2.space.getNode`
 * to resolve the real Base token.
 */
export function createFeishuBaseMetadataReader({ client } = {}) {
  const getApp = sdkMethod(client, "app", "get");
  const listTable = sdkMethod(client, "appTable", "list");
  const listField = sdkMethod(client, "appTableField", "list");

  async function resolveSource(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw baseLinkError();
    const tableId = parsed.tableId === undefined
      ? undefined
      : parseIdentifier(parsed.tableId, "table id");
    if (parsed.baseToken !== undefined) {
      const baseToken = parseIdentifier(parsed.baseToken, "Base token");
      return tableId ? { baseToken, tableId } : { baseToken };
    }
    if (parsed.wikiToken !== undefined) {
      const wikiToken = parseIdentifier(parsed.wikiToken, "Wiki token");
      const response = await callSdk(wikiNodeMethod(client), {
        params: { token: wikiToken, obj_type: "wiki" },
      });
      const baseToken = normalizeWikiBase(response, wikiToken);
      return tableId ? { baseToken, tableId } : { baseToken };
    }
    throw baseLinkError();
  }

  async function readBase(baseToken) {
    const normalizedToken = identifier(baseToken, "Base token");
    const response = await callSdk(getApp, { path: { app_token: normalizedToken } });
    return normalizeApp(response, normalizedToken);
  }

  async function listTables(baseToken) {
    const normalizedToken = identifier(baseToken, "Base token");
    const items = await readAllPages(listTable, { path: { app_token: normalizedToken } });
    return items.map(normalizeTable);
  }

  async function listFields(baseToken, tableId) {
    const normalizedToken = identifier(baseToken, "Base token");
    const normalizedTableId = identifier(tableId, "table id");
    const items = await readAllPages(listField, {
      path: { app_token: normalizedToken, table_id: normalizedTableId },
    });
    return items.map(normalizeField);
  }

  async function preview(input) {
    const parsed = typeof input === "string" ? parseBaseLink(input) : input;
    const { baseToken, tableId } = await resolveSource(parsed);
    const base = await readBase(baseToken);
    const tables = await listTables(baseToken);
    const selected = tableId === undefined ? tables : tables.filter((table) => table.tableId === tableId);
    if (tableId !== undefined && selected.length === 0) {
      const error = new Error("Feishu table was not found");
      error.code = "FEISHU_TABLE_NOT_FOUND";
      throw error;
    }
    const resultTables = [];
    for (const table of selected) {
      resultTables.push({
        ...table,
        fields: await listFields(baseToken, table.tableId),
      });
    }
    return { ...base, tables: resultTables };
  }

  async function validateSubject(subject) {
    const baseToken = identifier(subject?.baseToken, "Base token");
    const tableId = identifier(subject?.tableId, "table id");
    const metadata = await preview({ baseToken, tableId });
    if (subject?.statusField && subject?.stages) {
      assertPhasedSubjectMetadata(subject, metadata);
    } else {
      assertSubjectMetadata(subject, metadata);
    }
  }

  return Object.freeze({ readBase, listTables, listFields, preview, validateSubject });
}

function subjectCodeFieldName(subject) {
  const route = subject?.packageRoute;
  const fieldId = route?.subjectCodeFieldId ?? null;
  const metadataField = fieldId && Array.isArray(subject?.metadata?.fields)
    ? subject.metadata.fields.find((field) => (
      field?.fieldId === fieldId || field?.id === fieldId
    ))
    : null;
  return route?.subjectCodeFieldName
    ?? route?.fieldName
    ?? route?.subjectCodeField?.fieldName
    ?? route?.subjectCodeField?.name
    ?? subject?.subjectCodeFieldName
    ?? subject?.metadata?.subjectCodeFieldName
    ?? subject?.metadata?.subjectCode?.fieldName
    ?? subject?.metadata?.subjectCode?.name
    ?? metadataField?.fieldName
    ?? metadataField?.name
    ?? null;
}

function fieldBinding(subject, bindingName) {
  if (bindingName === "trigger") return subject?.trigger ?? null;
  if (bindingName === "title") return subject?.title ?? null;
  return {
    fieldId: subject?.packageRoute?.subjectCodeFieldId ?? null,
    fieldName: subjectCodeFieldName(subject),
  };
}

function metadataIssue(code, path, message, errorCode = code) {
  return { code, path, message, errorCode };
}

/**
 * Compare a saved subject snapshot with a normalized live metadata preview.
 * Both the enable path and share-import dry-run use this function so they
 * cannot silently diverge in what they consider a valid binding.
 */
export function compareSubjectMetadata(subject, metadata) {
  const issues = [];
  const basePath = `bases.${subject?.baseToken ?? "unknown"}`;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || !Array.isArray(metadata.tables)) {
    return [metadataIssue(
      "FEISHU_METADATA_UNAVAILABLE",
      basePath,
      "Feishu returned unusable metadata for this Base",
      "FEISHU_METADATA_INVALID_RESPONSE",
    )];
  }
  if (metadata.baseToken !== subject?.baseToken) {
    issues.push(metadataIssue(
      "BASE_NOT_FOUND",
      basePath,
      "The configured Base is not present in the live metadata",
      "FEISHU_BASE_NOT_FOUND",
    ));
    return issues;
  }
  if (metadata.baseName !== subject?.baseName) {
    issues.push(metadataIssue(
      "BASE_NAME_MISMATCH",
      basePath,
      "The configured Base name no longer matches Feishu metadata",
    ));
  }

  const tableMatches = metadata.tables.filter((table) => table?.tableId === subject?.tableId);
  const subjectPath = `${basePath}.subjects.${subject?.tableId ?? "unknown"}`;
  if (tableMatches.length === 0) {
    issues.push(metadataIssue(
      "TABLE_NOT_FOUND",
      subjectPath,
      "The configured subject table is not present in this Base",
      "FEISHU_TABLE_NOT_FOUND",
    ));
    return issues;
  }
  if (tableMatches.length !== 1) {
    issues.push(metadataIssue(
      "FEISHU_METADATA_INVALID_RESPONSE",
      subjectPath,
      "Feishu returned ambiguous table metadata",
      "FEISHU_METADATA_INVALID_RESPONSE",
    ));
    return issues;
  }
  const [table] = tableMatches;
  if (table.tableName !== subject?.tableName) {
    issues.push(metadataIssue(
      "TABLE_NAME_MISMATCH",
      subjectPath,
      "The configured table name no longer matches Feishu metadata",
    ));
  }
  if (!Array.isArray(table.fields)) {
    issues.push(metadataIssue(
      "FEISHU_METADATA_UNAVAILABLE",
      `${subjectPath}.fields`,
      "Field metadata is unavailable for this table",
      "FEISHU_METADATA_INVALID_RESPONSE",
    ));
    return issues;
  }

  for (const bindingName of ["trigger", "title", "subjectCode"]) {
    const binding = fieldBinding(subject, bindingName);
    if (!binding?.fieldId) {
      if (bindingName === "trigger") {
        issues.push(metadataIssue(
          "FIELD_NOT_FOUND",
          `${subjectPath}.trigger.fieldId`,
          "The configured trigger field is missing",
          "INVALID_FIELD",
        ));
      }
      continue;
    }
    const fieldMatches = table.fields.filter((field) => field?.fieldId === binding.fieldId);
    const fieldPath = `${subjectPath}.${bindingName}.fieldId`;
    if (fieldMatches.length === 0) {
      issues.push(metadataIssue(
        "FIELD_NOT_FOUND",
        fieldPath,
        `The configured ${bindingName} field is not present in this table`,
        "INVALID_FIELD",
      ));
      continue;
    }
    if (fieldMatches.length !== 1) {
      issues.push(metadataIssue(
        "FEISHU_METADATA_INVALID_RESPONSE",
        fieldPath,
        `Feishu returned ambiguous ${bindingName} field metadata`,
        "FEISHU_METADATA_INVALID_RESPONSE",
      ));
      continue;
    }
    const [field] = fieldMatches;
    if (binding.fieldName && field.fieldName !== binding.fieldName) {
      issues.push(metadataIssue(
        "FIELD_NAME_MISMATCH",
        `${subjectPath}.${bindingName}.fieldName`,
        `The configured ${bindingName} field name no longer matches Feishu metadata`,
      ));
    }
    if (bindingName !== "trigger") continue;

    const startValue = subject?.trigger?.startValue;
    const optionId = subject?.trigger?.optionId === "" || subject?.trigger?.optionId === undefined
      ? null
      : subject?.trigger?.optionId;
    const options = Array.isArray(field.options) ? field.options : [];
    const select = isSelectField(field) || options.length > 0;
    if (!select) {
      if (optionId !== null) {
        issues.push(metadataIssue(
          "OPTION_NOT_FOUND",
          `${subjectPath}.trigger.optionId`,
          "A text trigger field cannot use a select option",
        ));
      }
      continue;
    }
    const matches = optionId === null
      ? options.filter((option) => option?.name === startValue)
      : options.filter((option) => option?.id === optionId && option?.name === startValue);
    if (matches.length !== 1) {
      issues.push(metadataIssue(
        matches.length === 0 ? "OPTION_NOT_FOUND" : "OPTION_AMBIGUOUS",
        `${subjectPath}.trigger.startValue`,
        optionId === null
          ? "The configured trigger start option is missing or ambiguous"
          : "The configured trigger option ID and name no longer match Feishu metadata",
      ));
    }
  }
  return issues;
}

export function assertSubjectMetadata(subject, metadata) {
  const baseToken = identifier(subject?.baseToken, "Base token");
  displayName(subject?.baseName, "configured Base name");
  identifier(subject?.tableId, "table id");
  displayName(subject?.tableName, "configured table name");
  identifier(subject?.trigger?.fieldId, "trigger field id");
  displayName(subject?.trigger?.fieldName, "configured trigger field name");
  displayName(subject?.trigger?.startValue, "configured start value");
  if (subject?.trigger?.optionId !== null
    && subject?.trigger?.optionId !== undefined
    && subject?.trigger?.optionId !== "") {
    identifier(subject.trigger.optionId, "trigger option id");
  }
  for (const bindingName of ["title", "subjectCode"]) {
    const binding = fieldBinding(subject, bindingName);
    if (bindingName === "title" && Boolean(binding?.fieldId) !== Boolean(binding?.fieldName)) {
      throw configurationChanged("Configured title field ID and name must be provided together");
    }
    if (bindingName === "subjectCode" && binding?.fieldName && !binding?.fieldId) {
      throw configurationChanged("Configured subject-code field name requires a field ID");
    }
    if (binding?.fieldId) identifier(binding.fieldId, `${bindingName} field id`);
    if (binding?.fieldName) displayName(binding.fieldName, `configured ${bindingName} field name`);
  }
  const issue = compareSubjectMetadata(subject, metadata)[0];
  if (!issue) return;
  const error = configurationChanged(issue.message);
  error.code = issue.errorCode === "FEISHU_TABLE_NOT_FOUND" ? "FEISHU_TABLE_NOT_FOUND" : "INVALID_FIELD";
  error.metadataCode = issue.code;
  error.path = issue.path;
  if (issue.errorCode === "FEISHU_METADATA_INVALID_RESPONSE") error.code = issue.errorCode;
  if (issue.errorCode === "FEISHU_BASE_NOT_FOUND") error.code = issue.errorCode;
  // Keep the validated token available only to local callers; it is not part
  // of serialized HTTP errors.
  void baseToken;
  throw error;
}

function configurationChanged(message) {
  const error = fail(message, "INVALID_FIELD");
  error.status = 409;
  return error;
}

function isSelectField(field) {
  if (field.type === 3 || field.type === 4) return true;
  const uiType = typeof field.uiType === "string"
    ? field.uiType.replace(/[^A-Za-z]/gu, "").toLowerCase()
    : "";
  return uiType === "singleselect" || uiType === "multiselect" || uiType === "multipleselect";
}

function phasedField(subject, metadata, descriptor, pathName) {
  const table = metadata.tables?.find((candidate) => candidate.tableId === subject.tableId);
  const fieldId = descriptor?.fieldId ?? descriptor?.field_id;
  const field = table?.fields?.find((candidate) => candidate.fieldId === fieldId);
  if (!field) {
    const error = configurationChanged(`${pathName} is not present in Feishu metadata`);
    error.code = "INVALID_FIELD";
    throw error;
  }
  const expectedName = descriptor?.fieldName ?? descriptor?.name;
  if (expectedName && field.fieldName !== expectedName) {
    throw configurationChanged(`${pathName} name no longer matches Feishu metadata`);
  }
  return field;
}

/** Validate the fixed three-stage subject against a live metadata snapshot. */
export function assertPhasedSubjectMetadata(subject, metadata) {
  if (!metadata || metadata.baseToken !== subject?.baseToken) {
    const error = new Error("Feishu Base metadata does not match subject");
    error.code = "FEISHU_BASE_NOT_FOUND";
    error.status = 409;
    throw error;
  }
  const table = metadata.tables?.find((candidate) => candidate.tableId === subject.tableId);
  if (!table) {
    const error = new Error("Feishu subject table was not found");
    error.code = "FEISHU_TABLE_NOT_FOUND";
    error.status = 409;
    throw error;
  }
  const status = phasedField(subject, metadata, subject.statusField, "statusField");
  if (!isSelectField(status) && String(status.type ?? "").toLowerCase() !== "single_select") {
    throw configurationChanged("statusField must be a single-select field");
  }
  phasedField(subject, metadata, subject.documentField, "documentField");
  phasedField(subject, metadata, subject.namingField, "namingField");
  const options = Array.isArray(status.options) ? status.options : [];
  const enabled = Object.entries(subject.stages ?? {}).filter(([, stage]) => stage?.enabled);
  if (enabled.length === 0) throw configurationChanged("at least one stage must be enabled");
  const seen = new Set();
  for (const [stageId, stage] of enabled) {
    const trigger = stage.trigger ?? {};
    if (trigger.fieldId !== subject.statusField.fieldId) {
      throw configurationChanged(`${stageId}.trigger.fieldId must match statusField.fieldId`);
    }
    if (seen.has(trigger.optionId)) {
      throw configurationChanged("enabled stage trigger options must be unique");
    }
    seen.add(trigger.optionId);
    const matches = options.filter((option) => (
      option.id === trigger.optionId && option.name === trigger.value
    ));
    if (matches.length !== 1) {
      throw configurationChanged(`${stageId}.trigger option is missing or changed`);
    }
  }
  return true;
}

export function comparePhasedSubjectMetadata(subject, metadata) {
  try {
    assertPhasedSubjectMetadata(subject, metadata);
    return [];
  } catch (error) {
    return [{
      code: error?.code ?? "FEISHU_METADATA_INVALID_RESPONSE",
      path: error?.path ?? "subject",
      message: error?.message ?? "Feishu metadata validation failed",
      errorCode: error?.code ?? "FEISHU_METADATA_INVALID_RESPONSE",
    }];
  }
}
