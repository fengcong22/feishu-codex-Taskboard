import path from "node:path";

import { ApiError } from "./database.mjs";
import { resolvePackageWorkflowFromWorkspace } from "./feishu-package-identity.mjs";
import { canonicalJson } from "./feishu-source-manifest.mjs";
import { feishuStageTaskTitle } from "./feishu-task-title.mjs";
import { subjectProjectId } from "./feishu-workflow-store.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,511}$/u;
const VMID = /^[a-f0-9]{24}$/u;
const TEMPLATE = Object.freeze({ id: "vm_pmo_review_video", version: 1 });
const RESERVED_ALIASES = new Set(["__proto__", "constructor", "prototype"]);

function fail(code, status = 409) { return new ApiError(status, code, code); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function vmTemplate(value) {
  return object(value) && Object.keys(value).length === 2 && value.id === TEMPLATE.id && value.version === 1;
}
function shape(value, keys) {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key))) throw fail("VM_REGISTRATION_INVALID", 400);
}
function id(value, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) throw fail("VM_REGISTRATION_INVALID", 400);
  return value;
}
function packageAlias(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && !RESERVED_ALIASES.has(value) && !/^[./\\]/u.test(value)
    && !/[\s\u0000-\u001f\u007f"'`:$<>|]/u.test(value);
}

/** No record data, paths, prompt or executable policy may enter this envelope. */
export function parseVmTaskRegistration(body) {
  shape(body, ["event", "binding"]);
  if (body.event?.deliverySource === "simulation") throw fail("SIMULATION_VM_TASK_FORBIDDEN");
  shape(body.event, ["eventId", "baseToken", "tableId", "recordId", "statusFieldId", "beforeOptionId", "afterOptionId", "occurredAt"]);
  shape(body.binding, ["subjectKey", "configVersion", "stageId"]);
  const event = Object.fromEntries(["baseToken", "tableId", "recordId", "statusFieldId", "afterOptionId"]
    .map((key) => [key, id(body.event[key])]));
  event.beforeOptionId = body.event.beforeOptionId === null && body.binding.stageId === "initial"
    ? null : id(body.event.beforeOptionId);
  event.eventId = id(body.event.eventId, EVENT_ID);
  if (body.event.occurredAt !== undefined) {
    if (!Number.isSafeInteger(body.event.occurredAt) || body.event.occurredAt < 0) throw fail("VM_REGISTRATION_INVALID", 400);
    event.occurredAt = body.event.occurredAt;
  }
  if (body.binding.subjectKey !== `${event.baseToken}:${event.tableId}`) throw fail("FEISHU_SUBJECT_IDENTITY_REQUIRED");
  if (!Number.isSafeInteger(body.binding.configVersion) || body.binding.configVersion < 1
    || !["initial", "review"].includes(body.binding.stageId)) throw fail("VM_REGISTRATION_INVALID", 400);
  return { event, binding: { subjectKey: body.binding.subjectKey, configVersion: body.binding.configVersion,
    stageId: body.binding.stageId } };
}

function eventOrigin({ event, binding }) {
  return { source: "feishu-base", eventId: event.eventId, baseToken: event.baseToken, tableId: event.tableId,
    recordId: event.recordId, statusFieldId: event.statusFieldId, beforeOptionId: event.beforeOptionId,
    afterOptionId: event.afterOptionId, subjectKey: binding.subjectKey, configVersion: binding.configVersion,
    stageId: binding.stageId, ...(event.occurredAt === undefined ? {} : { eventOccurredAt: event.occurredAt }) };
}

function sameRegistration(origin, registration) {
  const expected = eventOrigin(registration);
  return object(origin) && origin.deliverySource === undefined && vmTemplate(origin.stageSnapshot?.workflowTemplate)
    && Object.entries(expected).every(([key, value]) => origin[key] === value)
    && origin.eventOccurredAt === expected.eventOccurredAt;
}

function stageStatusField(subject, stageId) {
  return stageId === "review" && subject.vmWorkflow?.stages?.review?.statusFieldId !== subject.statusField?.fieldId
    ? subject.reviewStatusField : subject.statusField;
}

function assertSubject(subject, registration) {
  const { event, binding } = registration;
  if (!object(subject) || subject.lifecycle !== "enabled" || subject.closedAt != null
    || subject.configVersion !== binding.configVersion || subject.subjectKey !== binding.subjectKey
    || subject.baseToken !== event.baseToken || subject.tableId !== event.tableId) throw fail("STALE_STAGE_EVENT");
  const enabledAt = typeof subject.enabledAt === "string" ? Date.parse(subject.enabledAt) : subject.enabledAt;
  if (subject.enabledAt != null && !Number.isSafeInteger(enabledAt)) throw fail("STALE_STAGE_EVENT");
  if (event.occurredAt !== undefined && Number.isSafeInteger(enabledAt)
    && event.occurredAt < enabledAt) throw fail("STALE_STAGE_EVENT");
  const workflow = subject.vmWorkflow;
  const stage = workflow?.stages?.[binding.stageId];
  if (!vmTemplate(subject.workflowTemplate) || !object(workflow) || !object(stage) || stage.enabled !== true
    || workflow.stages.initial?.enabled !== true || typeof workflow.finalArchive?.enabled !== "boolean"
    || !packageAlias(subject.packageRoute?.packageAlias)
    || ![workflow.fields?.vmidFieldId, workflow.fields?.namingFieldId, workflow.fields?.outputAttachmentFieldId,
      stage.instructionFieldId].every((value) => typeof value === "string" && ID.test(value))) throw fail("VM_WORKFLOW_NOT_READY");
  const status = stageStatusField(subject, binding.stageId);
  const options = status?.options;
  const previousOptionValid = event.beforeOptionId === null
    ? binding.stageId === "initial"
    : event.beforeOptionId !== event.afterOptionId
      && options?.filter((option) => option?.optionId === event.beforeOptionId).length === 1;
  if (status?.fieldId !== event.statusFieldId || ![3, "3", "single_select"].includes(status?.type)
    || stage.statusFieldId !== event.statusFieldId || stage.triggerOptionId !== event.afterOptionId
    || !Array.isArray(options) || !previousOptionValid
    || options.filter((option) => option?.optionId === event.afterOptionId).length !== 1)
    throw fail("FEISHU_STAGE_BINDING_MISMATCH");
  return stage;
}

function text(value, maxLength, { trim = true } = {}) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw fail("VM_RECORD_INVALID");
  return trim ? value.trim() : value;
}

/** Canonical server-owned PMO context; preserve the human instruction verbatim. */
export function normalizeVmRecordContext(record, { expectedStatusOptionId } = {}) {
  if (!object(record) || Object.keys(record).some((key) => !["vmid", "title", "instruction", "statusOptionId"].includes(key)))
    throw fail("VM_RECORD_INVALID");
  const vmid = text(record.vmid, 256);
  if (!VMID.test(vmid)) throw fail("VM_RECORD_INVALID");
  const title = text(record.title, 512);
  const instruction = text(record.instruction, 16_000, { trim: false });
  if (typeof record.statusOptionId !== "string" || !ID.test(record.statusOptionId)) throw fail("VM_RECORD_INVALID");
  if (expectedStatusOptionId !== undefined && record.statusOptionId !== expectedStatusOptionId) throw fail("VM_RECORD_STATUS_CHANGED");
  return { vmid, title, instruction, statusOptionId: record.statusOptionId };
}

function reviewParent(value) {
  const keys = ["runId", "artifactId", "deliveryId", "localPath", "sha256", "bytes", "durationMs", "reviewRound"];
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || ![value.runId, value.artifactId, value.deliveryId].every((entry) => typeof entry === "string" && ID.test(entry))
    || typeof value.localPath !== "string" || !path.isAbsolute(value.localPath) || value.localPath.includes("\0")
    || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || !Number.isSafeInteger(value.durationMs) || value.durationMs < 1
    || !Number.isSafeInteger(value.reviewRound) || value.reviewRound < 0) throw fail("VM_REVIEW_PARENT_UNAVAILABLE");
  return structuredClone(value);
}

function packageSnapshot(record, alias) {
  if (!object(record) || record.state !== "enabled") throw fail("PACKAGE_DISABLED");
  if (record.alias !== alias || !vmTemplate(record.workflowTemplate)) throw fail("PACKAGE_WORKFLOW_MISMATCH");
  if (typeof record.workspacePath !== "string" || !path.isAbsolute(record.workspacePath)
    || typeof record.prompt !== "string" || !record.prompt.trim()
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !Number.isSafeInteger(record.maxConcurrent) || record.maxConcurrent < 1
    || !Array.isArray(record.resourceGroups) || record.resourceGroups.some((group) => typeof group !== "string"
      || !group.trim() || group !== group.trim() || group.includes("\0"))
    || new Set(record.resourceGroups).size !== record.resourceGroups.length)
    throw fail("VM_PACKAGE_INVALID");
  return { packageAlias: alias, packageRevision: record.revision, workflowTemplate: { ...TEMPLATE },
    name: record.name ?? alias, projectId: record.projectId ?? null, workspacePath: record.workspacePath,
    model: record.model ?? null, reasoningEffort: record.reasoningEffort ?? null, prompt: record.prompt,
    maxConcurrent: record.maxConcurrent, resourceGroups: [...record.resourceGroups] };
}

/** Call only behind the authenticated loopback Bridge route. This does not enable a package or start work. */
export function createVmTaskRegistration({ database, getActiveSubject, getPackage, readCurrentRecord,
  resolveReviewParent = null, prepareCommit = null } = {}) {
  if (!database || [getActiveSubject, getPackage, readCurrentRecord].some((fn) => typeof fn !== "function"))
    throw new TypeError("VM registration requires a database and trusted configuration/record resolvers");
  if (resolveReviewParent !== null && typeof resolveReviewParent !== "function")
    throw new TypeError("VM review parent resolver must be a trusted function");
  if (prepareCommit !== null && typeof prepareCommit !== "function")
    throw new TypeError("VM registration preparation must be a trusted function");

  function replay(registration) {
    const task = database.findFeishuTaskByEventId(registration.event.eventId);
    if (!task) return null;
    const origin = database.getFeishuTaskOrigin(task.id);
    if (!sameRegistration(origin, registration)) throw fail("FEISHU_EVENT_BINDING_CONFLICT");
    return { task, origin, created: false };
  }

  async function register(body, actor) {
    const registration = parseVmTaskRegistration(body);
    const { event, binding } = registration;
    database.assertFeishuEventNotDeleted(eventOrigin(registration), { registration: true });
    const existing = replay(registration);
    if (existing) return existing;
    const subject = database.getFeishuSubjectVersion(binding.subjectKey, binding.configVersion);
    const stage = assertSubject(subject, registration);
    const active = await getActiveSubject(binding.subjectKey);
    assertSubject(active, registration);
    if (canonicalJson(active.vmWorkflow) !== canonicalJson(subject.vmWorkflow)
      || active.packageRoute.packageAlias !== subject.packageRoute.packageAlias) throw fail("STALE_STAGE_EVENT");
    const alias = subject.packageRoute.packageAlias;
    const packageRecord = await getPackage(alias);
    const snapshot = packageSnapshot(packageRecord, alias);
    const identity = await resolvePackageWorkflowFromWorkspace(packageRecord);
    if (!vmTemplate(identity.workflowTemplate)) throw fail("PACKAGE_WORKFLOW_MISMATCH");
    const context = normalizeVmRecordContext(await readCurrentRecord({ subject: structuredClone(subject),
      event: { ...event }, stageId: binding.stageId }), { expectedStatusOptionId: event.afterOptionId });
    const parent = binding.stageId === "review"
      ? reviewParent(await resolveReviewParent?.({ subject: structuredClone(subject), event: { ...event },
        stage: structuredClone(stage), context: structuredClone(context) }))
      : null;
    if (binding.stageId === "review" && !parent) throw fail("VM_REVIEW_PARENT_UNAVAILABLE");
    const reviewRound = parent ? parent.reviewRound + 1 : null;
    const nameSuffix = binding.stageId === "initial" ? "初稿" : `第${reviewRound}稿`;
    const executionMode = subject.execution?.mode === "automatic" ? "automatic" : "manual";
    const triggerValue = optionName(stageStatusField(subject, binding.stageId).options
      .find((option) => option.optionId === event.afterOptionId));
    const triggerField = subject.metadata?.fields?.find((field) => field.fieldId === event.statusFieldId)?.fieldName ?? event.statusFieldId;
    const marker = { version: 1, ...eventOrigin(registration), triggerField, triggerFieldId: event.statusFieldId,
      triggerValue, mode: executionMode, executionMode, uploadMode: "manual", packageAlias: alias,
      packageSource: "subject-config", concurrencyGroup: `autocut:${alias}`, maxConcurrent: snapshot.maxConcurrent,
      resourceGroups: snapshot.resourceGroups };
    const origin = { ...marker, stageSnapshot: { ...structuredClone(stage), nameSuffix,
      workflowTemplate: { ...TEMPLATE }, vmWorkflow: structuredClone(subject.vmWorkflow), vmContext: context,
      ...(parent ? { reviewRound, reviewParent: parent } : {}) } };
    const description = `<!-- feishu-codex-task:v1:${Buffer.from(JSON.stringify(marker), "utf8").toString("base64url")} -->\n\nVM ${nameSuffix}剪辑`;
    // Prepare trusted runtime state before the final configuration check. Persist it only
    // inside the task transaction; a failed preparation must leave no replayable task.
    const onCreatedInTransaction = prepareCommit === null ? null : await prepareCommit({
      subject: structuredClone(subject), packageRecord: structuredClone(packageRecord),
      snapshot: structuredClone(snapshot), origin: structuredClone(origin),
    });
    const currentPackage = packageSnapshot(await getPackage(alias), alias);
    if (canonicalJson(currentPackage) !== canonicalJson(snapshot)) throw fail("PACKAGE_WORKFLOW_MISMATCH");
    const current = await getActiveSubject(binding.subjectKey);
    assertSubject(current, registration);
    if (canonicalJson(current.vmWorkflow) !== canonicalJson(subject.vmWorkflow)
      || current.packageRoute.packageAlias !== alias || current.execution?.mode !== subject.execution?.mode)
      throw fail("STALE_STAGE_EVENT");
    try {
      const task = database.createFeishuTask({ projectId: subjectProjectId(binding.subjectKey),
        title: feishuStageTaskTitle({ tableName: subject.tableName, recordId: event.recordId,
          nameSuffix, namingDisplayValue: context.title }), description, status: "todo", priority: "high",
        labels: ["feishu"], startDate: null, dueDate: null, recurrence: null, developmentContext: null,
        actor, assignee: actor, feishuOrigin: origin }, snapshot, onCreatedInTransaction);
      return { task, origin: database.getFeishuTaskOrigin(task.id), created: true };
    } catch (error) {
      const winner = replay(registration);
      if (winner) return winner;
      throw error;
    }
  }
  return Object.freeze({ register });
}

function metadataId(field) { return field?.fieldId ?? field?.field_id; }
function metadataName(field) { return field?.fieldName ?? field?.field_name; }
function metadataType(field) { return Number(field?.type); }
function metadataUiType(field) {
  const value = field?.uiType ?? field?.ui_type ?? "";
  if (typeof value !== "string") throw fail("VM_FIELD_BINDING_CHANGED");
  return value.replace(/[\s_-]/gu, "").toLowerCase();
}
function options(field) { return field?.options ?? field?.property?.options; }
function optionId(option) { return option?.optionId ?? option?.id; }
function optionName(option) { return option?.value ?? option?.name; }

function configuredField(subject, liveFields, fieldId, types) {
  const frozen = subject.metadata?.fields?.filter((field) => metadataId(field) === fieldId) ?? [];
  const current = liveFields.filter((field) => metadataId(field) === fieldId);
  if (frozen.length !== 1 || current.length !== 1) throw fail("VM_FIELD_BINDING_CHANGED");
  const [field] = current;
  if (metadataName(field) !== metadataName(frozen[0]) || typeof metadataName(field) !== "string" || !metadataName(field)
    || !types.includes(metadataType(field)) || metadataType(frozen[0]) !== metadataType(field)) throw fail("VM_FIELD_BINDING_CHANGED");
  const expectedUi = { 1: "text", 3: "singleselect", 17: "attachment", 20: "formula" }[metadataType(field)];
  if ([field, frozen[0]].some((entry) => metadataUiType(entry) && metadataUiType(entry) !== expectedUi)) throw fail("VM_FIELD_BINDING_CHANGED");
  return field;
}

function recordValue(record, field, { optional = false } = {}) {
  const fields = record?.fields;
  if (!object(fields)) throw fail("VM_RECORD_INVALID");
  const byId = Object.hasOwn(fields, metadataId(field));
  const byName = Object.hasOwn(fields, metadataName(field));
  if (byId && byName && canonicalJson(fields[metadataId(field)]) !== canonicalJson(fields[metadataName(field)]))
    throw fail("VM_RECORD_INVALID");
  if (!byId && !byName) {
    if (optional) return null;
    throw fail("VM_RECORD_INVALID");
  }
  return fields[byId ? metadataId(field) : metadataName(field)];
}

function plainText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => object(entry)
    && (entry.type === undefined || entry.type === "text") && typeof entry.text === "string"
    && Object.keys(entry).every((key) => ["type", "text"].includes(key)))) return value.map((entry) => entry.text).join("");
  throw fail("VM_RECORD_INVALID");
}

/** Uses immutable field IDs and current metadata; raw PMO values are treated only as data. */
export function createVmRegistrationRecordReader({ listFields, getRecord } = {}) {
  if ([listFields, getRecord].some((fn) => typeof fn !== "function")) throw new TypeError("VM record reader requires Feishu adapters");
  return async ({ subject, event, stageId = "initial" }) => {
    const target = { baseToken: subject.baseToken, tableId: subject.tableId, recordId: event.recordId };
    const fields = await listFields({ baseToken: target.baseToken, tableId: target.tableId });
    if (!Array.isArray(fields)) throw fail("VM_FIELD_BINDING_CHANGED");
    const workflow = subject.vmWorkflow;
    const stage = workflow.stages?.[stageId];
    if (!object(stage) || stage.enabled !== true) throw fail("VM_WORKFLOW_NOT_READY");
    const vmid = configuredField(subject, fields, workflow.fields.vmidFieldId, [1]);
    const title = configuredField(subject, fields, workflow.fields.namingFieldId, [1, 20]);
    const instruction = configuredField(subject, fields, stage.instructionFieldId, [1]);
    const reviewImages = stageId === "review" && stage.instructionAttachmentsFieldId
      ? configuredField(subject, fields, stage.instructionAttachmentsFieldId, [17]) : null;
    const status = configuredField(subject, fields, stage.statusFieldId, [3]);
    const record = await getRecord(target);
    if (reviewImages) {
      const images = recordValue(record, reviewImages, { optional: true });
      if (images != null && !Array.isArray(images)) throw fail("VM_RECORD_INVALID");
      // The current driver contract accepts text/word evidence, not image assets.
      // Never deliver a textual-only edit after discarding supplied review images.
      if (images?.length) throw fail("VM_REVIEW_IMAGES_UNSUPPORTED");
    }
    const statusValue = recordValue(record, status);
    const liveOptions = options(status);
    const statusMatches = Array.isArray(liveOptions) ? liveOptions.filter((option) => object(option) && (
      typeof statusValue === "string" ? optionName(option) === statusValue || optionId(option) === statusValue
        : object(statusValue) && (statusValue.id === optionId(option) || statusValue.option_id === optionId(option)))) : [];
    if (statusMatches.length !== 1) throw fail("VM_RECORD_INVALID");
    const selected = statusMatches[0];
    const frozenStatus = stageStatusField(subject, stageId);
    if (frozenStatus?.fieldId !== stage.statusFieldId || !Array.isArray(frozenStatus?.options)
      || frozenStatus.options.filter((option) => option?.optionId === optionId(selected)
        && optionName(option) === optionName(selected)).length !== 1)
      throw fail("VM_FIELD_BINDING_CHANGED");
    return { vmid: plainText(recordValue(record, vmid)), title: plainText(recordValue(record, title)),
      instruction: plainText(recordValue(record, instruction)), statusOptionId: optionId(selected) };
  };
}
