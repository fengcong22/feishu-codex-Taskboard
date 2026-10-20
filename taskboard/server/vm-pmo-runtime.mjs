import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./database.mjs";
import { canonicalJson } from "./feishu-source-manifest.mjs";
import { packageWorkflowFromManifest } from "../shared/feishu-package-workflow.mjs";
import { createVmTaskRegistration, createVmRegistrationRecordReader, normalizeVmRecordContext } from "./vm-task-registration.mjs";
import { createVmTaskDownloadAdapter } from "./vm-task-download-adapter.mjs";
import { createVmTaskDownloadBindings } from "./vm-task-download-bindings.mjs";
import { createVmPmoOrchestrator } from "./vm-pmo-orchestrator.mjs";
import { prepareVmPmoRunInput } from "./vm-pmo-run-input.mjs";
import { runVmPmoOffline } from "./vm-pmo-offline-runner.mjs";
import { validateVmPmoInput, validateVmPmoInputSnapshot, validateVmPmoPlan, validateVmPmoRender } from "./vm-pmo-result-validator.mjs";
import { createVmMp4DeliveryService } from "./vm-mp4-delivery.mjs";
import { createVmStageWriteback } from "./vm-stage-writeback.mjs";
import { createVmWritebackStore } from "./vm-writeback-store.mjs";
import { createFeishuWritebackWorker } from "./feishu-writeback-worker.mjs";
import { createVmFinalArchiveService } from "./vm-pmo-final-archive.mjs";
import { isVmFinalArchiveTransition, planVmFinalArchive } from "./feishu-vm-delivery-plan.mjs";
import { readVmPackageBoard } from "./vm-package-board.mjs";

const TEMPLATE = Object.freeze({id: "vm_pmo_review_video",version: 1});
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,511}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set(["completed","blocked","needs_attention"]);
const MAX_PLAN_ATTEMPTS = 3;
const ACTOR = Object.freeze({type: "agent",id: "vm-pmo-runtime",name: "VM 初稿剪辑",avatarUrl: null});
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a,b) => canonicalJson(a) === canonicalJson(b);
const fail = (code,status = 409) => new ApiError(status,code,code);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const template = value => value?.id === TEMPLATE.id && value.version === 1;

function parseFinalArchiveRegistration(value) {
  const eventKeys = ["eventId", "baseToken", "tableId", "recordId", "statusFieldId",
    "beforeOptionIds", "afterOptionIds", "occurredAt"];
  if (!object(value) || Object.keys(value).some(key => !["event", "binding", "expectedSource"].includes(key))
    || !object(value.event) || !object(value.binding)
    || Object.keys(value.event).some(key => !eventKeys.includes(key))
    || Object.keys(value.binding).some(key => !["subjectKey", "configVersion"].includes(key)))
    throw fail("VM_ARCHIVE_REQUEST_INVALID",400);
  const event = value.event;
  if (!EVENT_ID.test(event.eventId ?? "") || ![event.baseToken,event.tableId,event.recordId,event.statusFieldId].every(id => ID.test(id ?? ""))
    || ![event.beforeOptionIds,event.afterOptionIds].every(ids => Array.isArray(ids) && ids.length <= 256
      && ids.every(item => ID.test(item ?? "")) && new Set(ids).size === ids.length)
    || JSON.stringify(event.beforeOptionIds) === JSON.stringify(event.afterOptionIds)
    || Object.hasOwn(event,"occurredAt") && (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0)
    || value.binding.subjectKey !== `${event.baseToken}:${event.tableId}`
    || !Number.isSafeInteger(value.binding.configVersion) || value.binding.configVersion < 1)
    throw fail("VM_ARCHIVE_REQUEST_INVALID",400);
  let expectedSource;
  if (Object.hasOwn(value, "expectedSource")) {
    const source = value.expectedSource;
    if (!object(source) || Object.keys(source).length !== 5
      || Object.keys(source).some(key => !["runId", "deliveryId", "artifactId", "sha256", "bytes"].includes(key))
      || ![source.runId,source.deliveryId,source.artifactId].every(id => ID.test(id ?? ""))
      || typeof source.sha256 !== "string" || !HASH.test(source.sha256)
      || !Number.isSafeInteger(source.bytes) || source.bytes < 1)
      throw fail("VM_ARCHIVE_REQUEST_INVALID",400);
    expectedSource = {runId:source.runId,deliveryId:source.deliveryId,artifactId:source.artifactId,
      sha256:source.sha256,bytes:source.bytes};
  }
  return {
    event: {
      eventId:event.eventId,baseToken:event.baseToken,tableId:event.tableId,recordId:event.recordId,
      statusFieldId:event.statusFieldId,beforeOptionIds:[...event.beforeOptionIds],afterOptionIds:[...event.afterOptionIds],
      ...(Object.hasOwn(event,"occurredAt") ? {occurredAt:event.occurredAt} : {}),
    },
    binding:{subjectKey:value.binding.subjectKey,configVersion:value.binding.configVersion},
    ...(expectedSource ? {expectedSource} : {}),
  };
}

function archiveFieldView(field) {
  const fieldId = field?.fieldId ?? field?.field_id;
  const fieldName = field?.fieldName ?? field?.field_name;
  const type = Number(field?.type);
  if (!ID.test(fieldId ?? "") || typeof fieldName !== "string" || !fieldName.trim()
    || !Number.isSafeInteger(type)) return null;
  const rawUiType = field.uiType ?? field.ui_type;
  if (rawUiType !== undefined && rawUiType !== null && typeof rawUiType !== "string") return null;
  const sourceOptions = field.options ?? field.property?.options;
  const options = (Array.isArray(sourceOptions) ? sourceOptions : []).map(option => ({
    id:option?.optionId ?? option?.id,
    name:option?.value ?? option?.name,
  })).filter(option => typeof option.id === "string" && typeof option.name === "string");
  return {fieldId,fieldName:fieldName.trim(),type,uiType:rawUiType ?? null,options};
}

function expectedArchiveUi(type) {
  return ({1:"text",3:"singleselect",4:"multiselect",20:"formula"})[type] ?? null;
}

function archiveConfiguredField(subject, liveFields, fieldId, allowedTypes) {
  const frozen = (subject.metadata?.fields ?? []).map(archiveFieldView).filter(field => field?.fieldId === fieldId);
  const current = liveFields.map(archiveFieldView).filter(field => field?.fieldId === fieldId);
  if (frozen.length !== 1 || current.length !== 1 || !allowedTypes.includes(current[0].type)
    || current[0].fieldName !== frozen[0].fieldName || current[0].type !== frozen[0].type)
    throw fail("VM_ARCHIVE_FIELD_CHANGED");
  const expected = expectedArchiveUi(current[0].type);
  if (!expected || [frozen[0],current[0]].some(field => field.uiType
    && field.uiType.replace(/[\s_-]/gu,"").toLowerCase() !== expected)) throw fail("VM_ARCHIVE_FIELD_CHANGED");
  return current[0];
}

function archiveRecordValue(record, field) {
  if (!object(record?.fields)) throw fail("VM_ARCHIVE_RECORD_INVALID");
  const byId = Object.hasOwn(record.fields,field.fieldId), byName = Object.hasOwn(record.fields,field.fieldName);
  if (byId && byName && !same(record.fields[field.fieldId],record.fields[field.fieldName]))
    throw fail("VM_ARCHIVE_RECORD_INVALID");
  if (!byId && !byName) throw fail("VM_ARCHIVE_RECORD_INVALID");
  return record.fields[byId ? field.fieldId : field.fieldName];
}

function archiveOptionId(value, options) {
  let reference = value;
  if (object(value)) reference = value.id ?? value.option_id ?? value.optionId ?? value.name ?? value.value ?? value.text;
  if (typeof reference !== "string") throw fail("VM_ARCHIVE_RECORD_INVALID");
  const matches = options.filter(option => option.id === reference || option.name === reference);
  if (matches.length !== 1) throw fail("VM_ARCHIVE_RECORD_INVALID");
  return matches[0].id;
}

function archiveRecordOptionIds(value, field) {
  if (value === null || value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  const result = entries.map(entry => archiveOptionId(entry,field.options));
  if (new Set(result).size !== result.length) throw fail("VM_ARCHIVE_RECORD_INVALID");
  return result;
}

async function canonicalLocation(target, {directory = false,missing = false} = {}) {
  if (typeof target !== "string" || !path.isAbsolute(target) || path.normalize(target) !== target || target.includes("\0"))
    throw fail("VM_PMO_RUNTIME_UNAVAILABLE",503);
  let current = target, found = false;
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || await realpath(current) !== current
        || (current === target ? directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 : !info.isDirectory()))
        throw fail("VM_PMO_RUNTIME_UNAVAILABLE",503);
      found = true;
    } catch (error) {
      if (error?.code !== "ENOENT" || !missing || found) throw fail("VM_PMO_RUNTIME_UNAVAILABLE",503);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function initialProfile(subject, config) {
  const fields = subject?.metadata?.fields;
  const stages = config?.stages;
  if (!object(config) || !object(stages) || stages.initial?.enabled !== true
    || ![true, false].includes(stages.review?.enabled) || !object(config.finalArchive)
    || typeof config.finalArchive.enabled !== "boolean"
    || !same(subject?.vmWorkflow, config) || !Array.isArray(fields)
    || ![config.fields?.vmidFieldId,config.fields?.namingFieldId,config.fields?.outputAttachmentFieldId,
      stages.initial.statusFieldId,stages.initial.triggerOptionId,stages.initial.instructionFieldId].every(value => typeof value === "string" && ID.test(value))
    || typeof config.approval?.department !== "string" || !config.approval.department.trim()
    || typeof config.approval?.reason !== "string" || !config.approval.reason.trim())
    throw fail("VM_WORKFLOW_NOT_READY");
  function field(id, types) {
    const matches = fields.filter(entry => (entry.fieldId ?? entry.field_id) === id);
    if (matches.length !== 1 || !types.includes(Number(matches[0].type))) throw fail("VM_WORKFLOW_NOT_READY");
    return matches[0];
  }
  function option(id, value) {
    const current = field(id,[3]);
    const options = current.options ?? current.property?.options;
    if (!Array.isArray(options) || options.filter(entry => (entry.id ?? entry.optionId) === value).length !== 1)
      throw fail("VM_WORKFLOW_NOT_READY");
  }
  field(config.fields.vmidFieldId,[1]);field(config.fields.namingFieldId,[1,20]);
  field(config.fields.outputAttachmentFieldId,[17]);
  const triggers = new Set();
  for (const stageId of ["initial","review"]) {
    const stage = stages[stageId];
    if (stage.enabled !== true) continue;
    if (![stage.statusFieldId,stage.triggerOptionId,stage.instructionFieldId]
      .every(value => typeof value === "string" && ID.test(value))) throw fail("VM_WORKFLOW_NOT_READY");
    field(stage.instructionFieldId,[1]);
    option(stage.statusFieldId,stage.triggerOptionId);
    const trigger = JSON.stringify([stage.statusFieldId,stage.triggerOptionId]);
    if (triggers.has(trigger)) throw fail("VM_WORKFLOW_NOT_READY");
    triggers.add(trigger);
    for (const moment of ["processing","completed"]) {
      const binding = stage.writeback?.[moment];
      if (!binding || !ID.test(binding.fieldId ?? "") || !ID.test(binding.optionId ?? "")) throw fail("VM_WORKFLOW_NOT_READY");
      option(binding.fieldId,binding.optionId);
    }
  }
  return config;
}

/** The runtime owns executable paths, policy, immutable input evidence and remote effects.
 * Neither the registration body nor PMO record may choose an executable or a workspace.
 * Local readiness never initializes the approval queue, a remote adapter, or run directories. */
export function createVmPmoRuntime({database,getPackage,getActiveSubject,getSubjectVersion,getDownloads,getAdapter,getPolicy,
  scheduler,dispatchWriteback,onTaskUpdated = () => {},runRoot,pythonPath,
  ffprobePath = "ffprobe",ffmpegPath = "ffmpeg",coursePathResolver = {},tickMs = 5_000,now = Date.now} = {}) {
  const db = database?.database;
  let services, closed = false, timer, archiveTimer, draining, archiveDraining;
  const pendingSlots = new Map();

  function cancelSlot(runId) {
    const pending = pendingSlots.get(runId);
    if (pending) pending.canceled = true;
    scheduler.cancel(`vm-pmo:${runId}`);
    pending?.lease?.release();
    pendingSlots.delete(runId);
  }
  function releaseTerminalSlots() {
    for (const run of services?.orchestrator.list() ?? []) {
      if (TERMINAL.has(run.state)) cancelSlot(run.runId);
    }
  }

  async function ready() {
    if (closed || !db || [getPackage,getActiveSubject,getDownloads,getAdapter,getPolicy,dispatchWriteback,
      scheduler?.request,scheduler?.cancel,onTaskUpdated].some(fn => typeof fn !== "function")
      || !Number.isSafeInteger(tickMs) || tickMs < 100) throw fail("VM_PMO_RUNTIME_UNAVAILABLE",503);
    await canonicalLocation(pythonPath);
    await canonicalLocation(runRoot,{directory: true,missing: true});
    return {available: true,workflowTemplate: {...TEMPLATE}};
  }

  async function inspectPackage(record) {
    if (!object(record) || !template(record.workflowTemplate)) throw fail("PACKAGE_WORKFLOW_MISMATCH");
    try {
      await canonicalLocation(record.workspacePath,{directory: true});
      const filename = path.join(record.workspacePath,"PACKAGE-MANIFEST.json");
      await canonicalLocation(filename);
      const bytes = await readFile(filename), manifest = JSON.parse(bytes.toString("utf8"));
      if (!template(packageWorkflowFromManifest(manifest.interface))
        || manifest.interface?.contract?.id !== TEMPLATE.id || manifest.interface?.contract?.version !== 2
        || manifest.interface?.driverId !== "vm_pmo_review_video_v2"
        || typeof manifest.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(manifest.name)
        || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version))
        throw new Error("manifest invalid");
      let runnerFound = false;
      for (const runner of [path.join(record.workspacePath,"auto_cut_slicing","vm_pmo.py"),
        path.join(record.workspacePath,"auto_cut_slicing","vm_pmo","__main__.py")]) {
        try {await canonicalLocation(runner);runnerFound = true;break;} catch {}
      }
      if (!runnerFound) throw new Error("runner unavailable");
      return {name: manifest.name,version: manifest.version,
        contractVersion: manifest.interface?.contract?.version ?? 1,
        driverId: manifest.interface?.driverId ?? "vm_pmo_review_video_v1",
        manifestSha256: digest(bytes)};
    } catch {throw fail("VM_PMO_PACKAGE_NOT_READY");}
  }
  async function validateVmPackage(record) {await ready();await inspectPackage(record);return true;}
  function samePackageIdentity(current, frozen) {
    if (object(frozen) && !Object.hasOwn(frozen,"contractVersion") && !Object.hasOwn(frozen,"driverId")) {
      const {contractVersion,driverId,...legacyCurrent} = current;
      return same(legacyCurrent,frozen);
    }
    return same(current,frozen);
  }
  async function validateActivation({subject,packageAlias,config} = {}) {
    await ready();
    const record = await getPackage(packageAlias);
    if (record?.state !== "enabled" || record.alias !== packageAlias) throw fail("PACKAGE_DISABLED");
    const identity = await inspectPackage(record);
    initialProfile(subject,config);
    if (config.stages.review.enabled && (identity.contractVersion !== 2
      || identity.driverId !== "vm_pmo_review_video_v2")) throw fail("VM_PMO_REVIEW_PROTOCOL_REQUIRED");
    return true;
  }
  const localAdapter = Object.freeze(Object.fromEntries(["listFields","getRecord","updateRecord","uploadMedia"].map(method => [method,
    async input => {
      const adapter = await getAdapter();
      if (typeof adapter?.[method] !== "function") throw fail("VM_PMO_ADAPTER_UNAVAILABLE",503);
      return adapter[method](input);
    }])));
  const readCurrentRecord = createVmRegistrationRecordReader(localAdapter);

  function initialize() {
    if (services) return services;
    db.exec(`CREATE TABLE IF NOT EXISTS vm_pmo_runtime_bindings (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,run_id TEXT UNIQUE,
      policy_version INTEGER NOT NULL,package_identity_json TEXT NOT NULL,subject_json TEXT NOT NULL,
      context_path TEXT UNIQUE,input_sha256 TEXT,bound_json TEXT,bound_sha256 TEXT
    ); CREATE TABLE IF NOT EXISTS vm_pmo_artifacts (
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,task_id TEXT NOT NULL,
      artifact_json TEXT NOT NULL,artifact_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS vm_pmo_attempt_inputs (
      run_id TEXT NOT NULL,task_id TEXT NOT NULL,plan_attempt INTEGER NOT NULL,
      context_path TEXT NOT NULL UNIQUE,input_sha256 TEXT NOT NULL,bound_json TEXT NOT NULL,
      bound_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(run_id,plan_attempt)
    )`);
    const metadata = taskId => {
      const row = db.prepare("SELECT * FROM vm_pmo_runtime_bindings WHERE task_id = ?").get(taskId);
      if (!row) throw fail("VM_PMO_BINDING_INVALID");
      try {
        const packageIdentity = JSON.parse(row.package_identity_json), subject = JSON.parse(row.subject_json);
        if (!Number.isSafeInteger(row.policy_version) || row.policy_version < 1 || !object(packageIdentity)
          || !HASH.test(packageIdentity.manifestSha256) || !object(subject)) throw new Error("invalid");
        return {...row,packageIdentity,subject};
      } catch {throw fail("VM_PMO_BINDING_INVALID");}
    };
    const approval = Object.fromEntries(["lookup","lookupTaskRun","enqueue","wake"].map(method => [method,async (...args) => {
      const adapter = createVmTaskDownloadAdapter(await getDownloads());
      return adapter[method]?.(...args) ?? null;
    }]));
    const bindings = createVmTaskDownloadBindings({database,approval,now,resolveRequest: async ({task,origin}) => {
      const local = metadata(task.id), profile = local.subject.vmWorkflow;
      if (!same(profile,origin.stageSnapshot?.vmWorkflow)) throw fail("VM_PMO_BINDING_INVALID");
      const downloads = await getDownloads();
      const outputRoot = downloads.snapshot()?.settings?.outputRoot;
      return createVmTaskDownloadAdapter(downloads).requestFor({vmid: origin.stageSnapshot.vmContext.vmid,
        department: profile.approval.department,reason: profile.approval.reason,outputRoot});
    }});
    let orchestrator, delivery, writebackStore, writebackWorker;

    function lineageFor(taskId) {
      const origin = database.getFeishuTaskOrigin(taskId), snapshot = database.getFeishuTaskPackageSnapshot(taskId);
      if (origin?.source !== "feishu-base" || origin.deliverySource !== undefined
        || snapshot?.packageAlias !== origin.packageAlias || !template(snapshot.workflowTemplate)
        || !template(origin.stageSnapshot?.workflowTemplate)) throw fail("VM_PMO_TASK_IDENTITY_CHANGED");
      return {subjectKey: origin.subjectKey, packageAlias: snapshot.packageAlias,
        workflowTemplate: {...snapshot.workflowTemplate}};
    }
    function latestStageOrigin({subjectKey,baseToken,tableId,recordId,fieldId,packageAlias,excludeTaskId}) {
      const rows = db.prepare(`SELECT task_id FROM feishu_task_origins
        WHERE subject_key = ? AND base_token = ? AND table_id = ? AND record_id = ?
        ORDER BY created_at DESC, rowid DESC`).all(subjectKey,baseToken,tableId,recordId);
      return rows.filter(row => row.task_id !== excludeTaskId).map(row => database.getFeishuTaskOrigin(row.task_id)).find(origin => {
        if (origin?.packageAlias !== packageAlias || !["initial","review"].includes(origin.stageId)
          || origin.stageSnapshot?.vmWorkflow?.fields?.outputAttachmentFieldId !== fieldId) return false;
        const lineage = lineageFor(origin.taskId);
        return lineage.subjectKey === subjectKey;
      }) ?? null;
    }
    function subjectLineage(subject) {
      return {subjectKey: subject.subjectKey, packageAlias: subject.packageRoute.packageAlias,
        workflowTemplate: {...subject.workflowTemplate}};
    }

    function trustedRun(runId) {
      const run = orchestrator.get(runId);
      if (!run || !run.runnerStartedAt) throw fail("VM_PMO_RUN_NOT_STARTED");
      const task = database.getTask(run.taskId), origin = database.getFeishuTaskOrigin(run.taskId);
      const snapshot = database.getFeishuTaskPackageSnapshot(run.taskId);
      if (!task || task.archivedAt !== null || !task.labels?.includes("feishu") || origin?.deliverySource !== undefined
        || !same(run.identity.origin,Object.fromEntries(Object.keys(run.identity.origin).map(key => [key,origin?.[key]])))
        || !template(snapshot?.workflowTemplate) || snapshot.packageAlias !== origin?.packageAlias
        || snapshot.packageRevision !== run.identity.packageSnapshot.packageRevision)
        throw fail("VM_PMO_TASK_IDENTITY_CHANGED");
      const target = {baseToken: origin.baseToken,tableId: origin.tableId,recordId: origin.recordId};
      return {...run,productionOrigin: true,stageId: origin.stageId,
        subjectKey: origin.subjectKey,configVersion: origin.configVersion,target};
    }
    async function boundFor(options, expected = {}, deliveredSnapshot = false) {
      const local = db.prepare("SELECT * FROM vm_pmo_attempt_inputs WHERE context_path = ?").get(options.contextPath)
        ?? db.prepare("SELECT * FROM vm_pmo_runtime_bindings WHERE context_path = ?").get(options.contextPath);
      if (!local?.bound_json || digest(local.bound_json) !== local.bound_sha256) throw fail("VM_PMO_INPUT_CHANGED");
      if (expected.runId !== undefined && local.run_id !== expected.runId
        || expected.taskId !== undefined && local.task_id !== expected.taskId
        || expected.planAttempt !== undefined && local.plan_attempt !== undefined
          && local.plan_attempt !== expected.planAttempt
        || expected.inputSha256 !== undefined && local.input_sha256 !== expected.inputSha256)
        throw fail("VM_PMO_INPUT_CHANGED");
      let bound;
      try {bound = JSON.parse(local.bound_json);} catch {throw fail("VM_PMO_INPUT_CHANGED");}
      if (bound.context?.input_sha256 !== local.input_sha256
        || bound.input?.binding?.task_id !== local.task_id || bound.input?.binding?.run_id !== local.run_id
        || local.plan_attempt !== undefined && (!Number.isSafeInteger(local.plan_attempt) || local.plan_attempt < 1))
        throw fail("VM_PMO_INPUT_CHANGED");
      const validate = deliveredSnapshot ? validateVmPmoInputSnapshot : validateVmPmoInput;
      try {return await validate({...options,expectedBound: bound});}
      catch {throw fail("VM_PMO_INPUT_CHANGED");}
    }
    delivery = createVmMp4DeliveryService({database,adapter: localAdapter,now,
      resolveTrustedLineage: ({taskId}) => lineageFor(taskId),resolveTrustedDelivery: async ({runId,artifactId}) => {
      const run = trustedRun(runId), row = db.prepare("SELECT * FROM vm_pmo_artifacts WHERE id = ?").get(artifactId);
      if (!row || row.run_id !== runId || row.task_id !== run.taskId || digest(row.artifact_json) !== row.artifact_sha256
        || run.artifactId !== artifactId) throw fail("VM_DELIVERY_UNTRUSTED");
      await boundFor(run.prepared.runnerOptions,{runId:run.runId,taskId:run.taskId,
        planAttempt:run.planAttempt ?? 1,inputSha256:run.prepared.inputSha256},
      run.state === "completed" && delivery.get(runId)?.state === "delivered");
      let artifact;
      try {artifact = JSON.parse(row.artifact_json);} catch {throw fail("VM_DELIVERY_UNTRUSTED");}
      return {runId,taskId: run.taskId,artifactId,productionOrigin: true,artifact,
        target: {...run.target,fieldId: run.identity.outputAttachmentFieldId}, lineage: lineageFor(run.taskId)};
    }});
    async function resolveReviewParent({subject,event,excludeTaskId}) {
      const fieldId = subject.vmWorkflow.fields.outputAttachmentFieldId;
      const delivered = await delivery.latestDelivered({baseToken: subject.baseToken,
        tableId: subject.tableId,recordId: event.recordId,fieldId,...subjectLineage(subject)});
      if (!delivered) return null;
      const latest = latestStageOrigin({baseToken: subject.baseToken,tableId: subject.tableId,
        recordId: event.recordId,fieldId,excludeTaskId,...subjectLineage(subject)});
      if (latest?.taskId !== delivered.taskId || event.occurredAt !== undefined
        && latest.eventOccurredAt !== undefined && event.occurredAt <= latest.eventOccurredAt)
        throw fail("VM_REVIEW_PARENT_UNAVAILABLE");
      const parentRun = trustedRun(delivered.runId);
      const parentOrigin = database.getFeishuTaskOrigin(parentRun.taskId);
      if (parentRun.state !== "completed" || parentRun.artifactId !== delivered.artifactId
        || parentRun.identity.origin.baseToken !== subject.baseToken
        || parentRun.identity.origin.tableId !== subject.tableId
        || parentRun.identity.origin.recordId !== event.recordId
        || parentOrigin.stageId !== "initial" && parentOrigin.stageId !== "review")
        throw fail("VM_REVIEW_PARENT_UNAVAILABLE");
      await boundFor(parentRun.prepared.runnerOptions,{runId:parentRun.runId,taskId:parentRun.taskId,
        planAttempt:parentRun.planAttempt ?? 1,inputSha256:parentRun.prepared.inputSha256},true);
      const reviewRound = parentOrigin.stageId === "review"
        ? parentOrigin.stageSnapshot?.reviewRound : 0;
      if (!Number.isSafeInteger(reviewRound) || reviewRound < 0) throw fail("VM_REVIEW_PARENT_UNAVAILABLE");
      return {runId: delivered.runId,artifactId: delivered.artifactId,deliveryId: delivered.id,
        localPath: delivered.artifact.path,sha256: delivered.artifact.sha256,
        bytes: delivered.artifact.bytes,durationMs: delivered.artifact.durationMs,reviewRound};
    }
    const finalArchive = createVmFinalArchiveService({database,now,resolveArchivePlan: async request => {
      const subject = typeof getSubjectVersion === "function"
        ? await getSubjectVersion(request.subjectKey,request.configVersion)
        : await getActiveSubject(request.subjectKey);
      const workflow = subject?.vmWorkflow, archive = workflow?.finalArchive;
      if (!subject || subject.lifecycle !== "enabled" || subject.subjectKey !== request.subjectKey
        || subject.configVersion !== request.configVersion || !template(subject.workflowTemplate)
        || archive?.enabled !== true || archive.statusFieldId !== request.statusEdge.statusFieldId
        || !isVmFinalArchiveTransition(archive,{fieldId: request.statusEdge.statusFieldId,
          beforeOptionIds: request.statusEdge.beforeOptionIds,afterOptionIds: request.statusEdge.afterOptionIds}))
        throw fail("VM_ARCHIVE_CONFIG_CHANGED");

      const target = request.record;
      const liveFields = await localAdapter.listFields({baseToken: target.baseToken,tableId: target.tableId});
      if (!Array.isArray(liveFields)) throw fail("VM_ARCHIVE_FIELD_CHANGED");
      const statusField = archiveConfiguredField(subject,liveFields,archive.statusFieldId,[3,4]);
      const nameField = archiveConfiguredField(subject,liveFields,workflow.fields.namingFieldId,[1,20]);
      const pathField = archive.pathSource === "pmo_field"
        ? archiveConfiguredField(subject,liveFields,archive.pathFieldId,[1,20]) : null;
      const optionIds = new Set(statusField.options.map(option => option.id));
      if ([archive.triggerOptionId,...request.statusEdge.beforeOptionIds,...request.statusEdge.afterOptionIds]
        .some(optionId => !optionIds.has(optionId))) throw fail("VM_ARCHIVE_FIELD_CHANGED");

      const record = await localAdapter.getRecord(target);
      const currentStatus = archiveRecordOptionIds(archiveRecordValue(record,statusField),statusField).sort();
      const expectedStatus = [...request.statusEdge.afterOptionIds].sort();
      if (!same(currentStatus,expectedStatus)) throw fail("VM_ARCHIVE_STALE_EVENT");
      const values = {[nameField.fieldId]:archiveRecordValue(record,nameField)};
      if (pathField) values[pathField.fieldId] = archiveRecordValue(record,pathField);

      const delivered = await delivery.latestDelivered({baseToken: target.baseToken,tableId: target.tableId,
        recordId: target.recordId,fieldId: workflow.fields.outputAttachmentFieldId,...subjectLineage(subject)});
      if (!delivered) throw fail("VM_ARCHIVE_SOURCE_UNAVAILABLE");
      const latest = latestStageOrigin({...target,fieldId: workflow.fields.outputAttachmentFieldId,...subjectLineage(subject)});
      if (latest?.taskId !== delivered.taskId || request.statusEdge.occurredAt !== undefined
        && latest.eventOccurredAt !== undefined && request.statusEdge.occurredAt <= latest.eventOccurredAt)
        throw fail("VM_ARCHIVE_SOURCE_SUPERSEDED");
      const parent = trustedRun(delivered.runId);
      if (parent.state !== "completed" || parent.artifactId !== delivered.artifactId
        || parent.target.baseToken !== target.baseToken || parent.target.tableId !== target.tableId
        || parent.target.recordId !== target.recordId || !["initial","review"].includes(parent.stageId))
        throw fail("VM_ARCHIVE_SOURCE_UNAVAILABLE");
      await boundFor(parent.prepared.runnerOptions,{runId:parent.runId,taskId:parent.taskId,
        planAttempt:parent.planAttempt ?? 1,inputSha256:parent.prepared.inputSha256},true);
      const plan = await planVmFinalArchive({config:workflow,metadata:{fields:liveFields.map(archiveFieldView).filter(Boolean)},
        record:target,fields:values,latestDeliveredVideo:{status:"confirmed",artifactKind:"review_mp4",
          record:target,artifactId:delivered.artifactId,runId:delivered.runId,deliveryId:delivered.id,
          localPath:delivered.artifact.path,sha256:delivered.artifact.sha256,bytes:delivered.artifact.bytes}},
      coursePathResolver);
      return {...plan, lineage: {...subjectLineage(subject),outputAttachmentFieldId: workflow.fields.outputAttachmentFieldId},
        source: {...plan.source,taskId: delivered.taskId}};
    },validateArchiveSource: async ({plan,request}) => {
      const parent = trustedRun(plan.source.runId), lineage = lineageFor(parent.taskId);
      // Old queued jobs recover their package identity from their frozen source run.
      const frozen = plan.lineage ?? {...lineage,outputAttachmentFieldId: parent.identity.outputAttachmentFieldId};
      if (!same(lineage,{subjectKey:frozen.subjectKey,packageAlias:frozen.packageAlias,workflowTemplate:frozen.workflowTemplate})
        || parent.state !== "completed" || parent.artifactId !== plan.source.artifactId
        || parent.identity.outputAttachmentFieldId !== frozen.outputAttachmentFieldId)
        throw fail("VM_ARCHIVE_SOURCE_UNAVAILABLE");
      const latest = latestStageOrigin({...plan.record,fieldId:frozen.outputAttachmentFieldId,...lineage});
      if (latest?.taskId !== parent.taskId || request.statusEdge.occurredAt !== undefined
        && latest.eventOccurredAt !== undefined && request.statusEdge.occurredAt <= latest.eventOccurredAt)
        throw fail("VM_ARCHIVE_SOURCE_SUPERSEDED");
      const current = await delivery.latestDelivered({...plan.record,fieldId:frozen.outputAttachmentFieldId,...lineage});
      if (!current || current.runId !== plan.source.runId || current.id !== plan.source.deliveryId
        || current.artifactId !== plan.source.artifactId || current.artifact.sha256 !== plan.source.sha256)
        throw fail("VM_ARCHIVE_SOURCE_SUPERSEDED");
    }});
    // Each run has its own frozen subject. A task from a later version must never redirect an earlier run.
    async function planWriteback(runId,moment) {
      const run = trustedRun(runId), frozen = metadata(run.taskId).subject;
      const planner = createVmStageWriteback({resolveTrustedRun: () => trustedRun(runId),getActiveSubject: () => structuredClone(frozen),
        listFields: localAdapter.listFields,getDelivery: () => delivery.get(runId),
        isLatestStageRun: async ({run: candidate}) => {
          const latest = latestStageOrigin({...candidate.target,subjectKey:candidate.subjectKey,
            fieldId:candidate.identity.outputAttachmentFieldId,packageAlias:candidate.identity.origin.packageAlias});
          return latest?.taskId === candidate.taskId;
        },
        enqueueWritebackIntent: input => writebackStore.enqueueWritebackIntent(input)});
      return planner.plan({runId,moment});
    }
    writebackStore = createVmWritebackStore({database,now,validateIntent: async input => {
      const moment = input.idempotencyKey === `vm:${input.runId}:processing` ? "processing" : "completed";
      const expected = await planWriteback(input.runId,moment);
      if (!same(expected,input)) throw fail("WRITEBACK_REFERENCE_INVALID");
      return {target: trustedRun(input.runId).target,operation: expected.operation};
    }});
    writebackWorker = createFeishuWritebackWorker({store: writebackStore,dispatch: dispatchWriteback,now});
    async function enqueueWriteback(run,moment) {
      await writebackStore.enqueueWritebackIntent(await planWriteback(run.runId,moment));
      void writebackWorker.wake().catch(() => {});
    }
    function taskStatus(run,status) {
      trustedRun(run.runId);
      const task = database.getTask(run.taskId);
      if (task.status === status || !["todo","in_progress"].includes(task.status)) return;
      const updated = database.updateTask(task.id,task.version,{status},undefined,undefined,ACTOR);
      try {onTaskUpdated(updated);} catch {}
    }
    orchestrator = createVmPmoOrchestrator({database,bindings,now,tickMs,
      canExecute: async ({run}) => {
        if (run.runnerStartedAt) return true;
        const policy = await getPolicy(), local = metadata(run.taskId);
        if (policy?.enabled !== true) throw fail("AUTOMATIC_EXECUTION_DISABLED");
        if (policy.version !== local.policy_version) throw fail("VM_PMO_POLICY_CHANGED");
        const origin = database.getFeishuTaskOrigin(run.taskId), snapshot = database.getFeishuTaskPackageSnapshot(run.taskId);
        if (origin?.executionMode !== "automatic") throw fail("VM_PMO_TASK_NOT_ELIGIBLE");
        const active = await getActiveSubject(origin.subjectKey);
        if (active?.lifecycle !== "enabled" || active.configVersion !== origin.configVersion
          || !same(active.vmWorkflow,local.subject.vmWorkflow) || active.packageRoute?.packageAlias !== origin.packageAlias)
          throw fail("VM_PMO_CONFIG_CHANGED");
        const record = await getPackage(origin.packageAlias);
        if (record?.state !== "enabled" || record.revision !== snapshot.packageRevision
          || record.workspacePath !== snapshot.workspacePath || !template(record.workflowTemplate)) throw fail("VM_PMO_PACKAGE_CHANGED");
        if (!samePackageIdentity(await inspectPackage(record),local.packageIdentity)) throw fail("VM_PMO_PACKAGE_CHANGED");
        return true;
      },
      acquireSlot: async ({run}) => {
        const snapshot = database.getFeishuTaskPackageSnapshot(run.taskId);
        let pending = pendingSlots.get(run.runId);
        if (!pending) {
          pending = {lease: null,error: null,canceled: false};pendingSlots.set(run.runId,pending);
          pending.promise = scheduler.request({requestId: `vm-pmo:${run.runId}`,concurrencyGroup: `autocut:${snapshot.packageAlias}`,
            maxConcurrent: snapshot.maxConcurrent,resourceGroups: snapshot.resourceGroups,queuePolicy: "per-group",fixedMaxConcurrent: true})
            .then(lease => {if (pending.canceled) lease.release();else pending.lease = lease;},error => {pending.error = error;});
          await Promise.resolve();
        }
        if (pending.error) {pendingSlots.delete(run.runId);throw fail("VM_PMO_SLOT_INVALID");}
        if (!pending.lease) return null;
        pendingSlots.delete(run.runId);return pending.lease;
      },
      prepareInput: async ({run,acquisition,planAttempt}) => {
        const origin = database.getFeishuTaskOrigin(run.taskId), local = metadata(run.taskId);
        const packageIdentity = await inspectPackage(await getPackage(origin.packageAlias));
        if (!samePackageIdentity(packageIdentity,local.packageIdentity)) throw fail("VM_PMO_PACKAGE_CHANGED");
        const record = normalizeVmRecordContext(await readCurrentRecord({subject: local.subject,event: origin,
          stageId: origin.stageId}),
          {expectedStatusOptionId: origin.afterOptionId});
        if (!same(record,origin.stageSnapshot?.vmContext)) throw fail("VM_PMO_RECORD_CHANGED");
        const prepared = await prepareVmPmoRunInput({runRoot,runId: run.runId,taskId: run.taskId,origin,
          profile: local.subject.vmWorkflow,packageSnapshot: database.getFeishuTaskPackageSnapshot(run.taskId),
          packageIdentity,acquisition,pythonPath,planAttempt});
        const bound = await validateVmPmoInput({contextPath: prepared.contextPath});
        const value = canonicalJson(bound);
        db.prepare(`INSERT INTO vm_pmo_attempt_inputs(run_id,task_id,plan_attempt,context_path,input_sha256,
          bound_json,bound_sha256,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
          .run(run.runId,run.taskId,planAttempt,prepared.contextPath,prepared.inputSha256,value,digest(value),now());
        const saved = db.prepare("SELECT * FROM vm_pmo_attempt_inputs WHERE run_id = ? AND plan_attempt = ?")
          .get(run.runId,planAttempt);
        if (!saved || saved.task_id !== run.taskId || saved.context_path !== prepared.contextPath
          || saved.input_sha256 !== prepared.inputSha256 || saved.bound_json !== value
          || saved.bound_sha256 !== digest(value)) throw fail("VM_PMO_INPUT_CHANGED");
        return prepared;
      },
      verifyRetryInput: async ({run}) => {
        if (run.identity.origin.stageId === "review") {
          const origin = database.getFeishuTaskOrigin(run.taskId), local = metadata(run.taskId);
          const frozenParent = origin.stageSnapshot?.reviewParent;
          const parent = await resolveReviewParent({subject:local.subject,
            event:{recordId:origin.recordId,occurredAt:origin.eventOccurredAt},excludeTaskId:run.taskId});
          if (!parent || !same(parent,frozenParent) || run.approvalStatus !== "ready"
            || run.binding.approvalJobId !== null || run.acquisition?.vmid_binding !== "managed_review_parent"
            || run.acquisition.path !== parent.localPath || run.acquisition.sha256 !== parent.sha256
            || run.acquisition.bytes !== parent.bytes || run.acquisition.duration_ms !== parent.durationMs
            || run.acquisition.vmid !== origin.stageSnapshot.vmContext?.vmid)
            throw fail("VM_PMO_RETRY_SOURCE_CHANGED");
          try {await boundFor(run.prepared.runnerOptions,{runId:run.runId,taskId:run.taskId,
            planAttempt:run.planAttempt ?? 1,inputSha256:run.prepared.inputSha256});}
          catch {throw fail("VM_PMO_RETRY_SOURCE_CHANGED");}
          return;
        }
        const status = await bindings.status(run.taskId);
        if (status?.taskId !== run.taskId || status.runId !== run.runId
          || status.vmid !== run.binding.vmid || status.approvalJobId !== run.binding.approvalJobId)
          throw fail("VM_PMO_RETRY_BINDING_CHANGED");
        if (run.approvalStatus !== "ready" || status.status !== "ready"
          || status.acquisition?.vmid_binding !== "vm_api_verified")
          throw fail("VM_PMO_RETRY_APPROVAL_NOT_READY");
        const keys = ["receipt_path","path","sha256","bytes","duration_ms","vmid_binding","vmid"];
        if (!run.acquisition || keys.some(key => status.acquisition[key] !== run.acquisition[key]))
          throw fail("VM_PMO_RETRY_SOURCE_CHANGED");
        try {await boundFor(run.prepared.runnerOptions,{runId:run.runId,taskId:run.taskId,
          planAttempt:run.planAttempt ?? 1,inputSha256:run.prepared.inputSha256});}
        catch {throw fail("VM_PMO_RETRY_SOURCE_CHANGED");}
      },
      runOffline: async options => {
        const bound = await boundFor(options,{runId:options.runId,taskId:options.taskId,
          planAttempt:options.planAttempt,inputSha256:options.inputSha256});
        const result = await runVmPmoOffline({...options,ffprobePath,ffmpegPath,expectedBound: bound});
        await validateVmPmoInput({...options,expectedBound: bound});
        return result;
      },
      recoverOffline: async options => {
        const bound = await boundFor(options,{runId:options.runId,taskId:options.taskId,
          planAttempt:options.planAttempt,inputSha256:options.inputSha256});
        const receipt = options.mode === "plan" ? bound.context.plan_result_path : bound.context.result_path;
        try {await lstat(receipt);} catch (error) {if (error?.code === "ENOENT") return null;throw fail("VM_PMO_RUN_OUTCOME_UNKNOWN");}
        return options.mode === "plan" ? validateVmPmoPlan({...options,ffprobePath,expectedBound: bound})
          : validateVmPmoRender({...options,ffprobePath,ffmpegPath,expectedBound: bound});
      },
      registerArtifact: async ({run,prepared,result}) => {
        trustedRun(run.runId);
        const bound = await boundFor(prepared.runnerOptions,{runId:run.runId,taskId:run.taskId,
          planAttempt:run.planAttempt ?? 1,inputSha256:prepared.inputSha256});
        const validated = await validateVmPmoRender({...prepared.runnerOptions,ffprobePath,ffmpegPath,expectedBound: bound});
        if (validated.status !== "rendered" || validated.planSha256 !== run.planSha256 || !same(validated.artifact,result.artifact))
          throw fail("VM_PMO_ARTIFACT_INVALID");
        const artifact = {...validated.artifact,filename: prepared.outputFilename,validationStatus: "verified"};
        const value = canonicalJson(artifact), artifactId = randomUUID();
        db.prepare(`INSERT INTO vm_pmo_artifacts(id,run_id,task_id,artifact_json,artifact_sha256,created_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING`).run(artifactId,run.runId,run.taskId,value,digest(value),now());
        const saved = db.prepare("SELECT * FROM vm_pmo_artifacts WHERE run_id = ?").get(run.runId);
        if (!saved || saved.task_id !== run.taskId || saved.artifact_json !== value || saved.artifact_sha256 !== digest(value))
          throw fail("VM_PMO_ARTIFACT_INVALID");
        return {artifactId: saved.id};
      },delivery,
      onRunStarted: async ({run}) => {taskStatus(run,"in_progress");await enqueueWriteback(run,"processing");},
      onCompleted: async ({run}) => {await enqueueWriteback(run,"completed");taskStatus(run,"in_review");},
    });
    services = {orchestrator,delivery,finalArchive,writebackStore,writebackWorker,metadata,
      registration: createVmTaskRegistration({database,getPackage,getActiveSubject,readCurrentRecord,
        resolveReviewParent,
        prepareCommit: async ({subject,packageRecord,origin}) => {
          const assertParent = ({taskId}) => {
            if (origin.stageId !== "review") return;
            const parent = orchestrator.get(origin.stageSnapshot.reviewParent.runId);
            const latest = latestStageOrigin({subjectKey:origin.subjectKey,baseToken:origin.baseToken,
              tableId:origin.tableId,recordId:origin.recordId,packageAlias:origin.packageAlias,
              fieldId:origin.stageSnapshot.vmWorkflow.fields.outputAttachmentFieldId,excludeTaskId:taskId});
            if (!parent || latest?.taskId !== parent.taskId) throw fail("VM_REVIEW_PARENT_UNAVAILABLE");
          };
          // The source may advance while preparation awaits local policy/package reads.
          // Recheck in the task transaction so concurrent edges cannot allocate sibling rounds.
          if (origin.executionMode !== "automatic") return origin.stageId === "review" ? assertParent : null;
          const policy = await getPolicy();
          if (policy?.enabled !== true) return origin.stageId === "review" ? assertParent : null;
          if (!Number.isSafeInteger(policy.version) || policy.version < 1) throw fail("VM_PMO_POLICY_CHANGED");
          initialProfile(subject,subject?.vmWorkflow);
          const identity = await inspectPackage(packageRecord);
          const frozenSubject = canonicalJson(subject), frozenIdentity = canonicalJson(identity);
          return ({taskId}) => {
            assertParent({taskId});
            return db.prepare(`INSERT INTO vm_pmo_runtime_bindings(task_id,policy_version,package_identity_json,subject_json)
              VALUES(?,?,?,?)`).run(taskId,policy.version,frozenIdentity,frozenSubject);
          };
        },
      })};
    return services;
  }

  function publicRun(run) {
    if (!run) return null;
    const task = database.getTask(run.taskId);
    const writebackEntries = initialize().writebackStore.listWritebackIntents({runId: run.runId});
    const writeback = Object.fromEntries(["processing", "completed"].map(moment => {
      const entry = writebackEntries.find(item => item.moment === moment);
      return [moment, entry ? {state: entry.state, errorCode: entry.errorCode, attemptCount: entry.attemptCount} : null];
    }));
    const canRetryWriteback = run.state === "completed" && task?.status === "in_review" && task.archivedAt === null
      && Boolean(run.deliveredFileToken && run.completedAt)
      && writeback.processing?.state === "dead_letter" && writeback.completed?.state === "dead_letter";
    const planAttempt = run.planAttempt ?? 1;
    const canRetryPlan = run.state === "blocked" && run.errorCode === "WORD_ALIGNMENT_UNRESOLVED"
      && planAttempt < MAX_PLAN_ATTEMPTS && Boolean(run.planStartedAt && run.prepared && run.acquisition)
      && !run.runnerStartedAt && !run.planSha256 && !run.renderResult && !run.artifactId
      && !run.deliveredFileToken && !run.completedAt;
    return {runId:run.runId,taskId:run.taskId,state:run.state,errorCode:run.errorCode,
      approvalStatus:run.approvalStatus,planAttempt,retryLimit:MAX_PLAN_ATTEMPTS,
      retryHistory:(run.retryHistory ?? []).map(entry => ({planAttempt:entry.planAttempt,errorCode:entry.errorCode,
        failedAt:entry.failedAt})),canRetryPlan,canRetryWriteback,writeback,updatedAt:new Date(run.updatedAt).toISOString()};
  }

  async function getTaskRun(taskId) {
    await ready();
    const run = initialize().orchestrator.getForTask(taskId);
    return publicRun(run);
  }

  async function retryPlanning(taskId,request) {
    await ready();
    if (!object(request) || Object.keys(request).length !== 2
      || !Number.isSafeInteger(request.version) || request.version < 1
      || !object(request.runConsent) || Object.keys(request.runConsent).length !== 2
      || request.runConsent.allowVideoAudioAsr !== true
      || request.runConsent.allowConfiguredLocalOutput !== true) throw fail("VM_PMO_RETRY_CONSENT_REQUIRED",400);
    const assertTaskVersion = () => {
      if (database.getTask(taskId).version !== request.version) throw fail("VERSION_CONFLICT",409);
    };
    assertTaskVersion();
    const service = initialize(), run = service.orchestrator.getForTask(taskId);
    if (!run || run.identity.packageSnapshot.workflowTemplate.id !== TEMPLATE.id
      || run.identity.packageSnapshot.workflowTemplate.version !== TEMPLATE.version)
      throw fail("VM_PMO_RUN_NOT_FOUND",404);
    const queued = await service.orchestrator.retryPlan(run.runId,{beforeCommit:assertTaskVersion});
    void service.orchestrator.pump(run.runId).finally(releaseTerminalSlots).catch(() => {});
    return publicRun(queued);
  }

  async function retryWriteback(taskId, request) {
    await ready();
    if (!object(request) || Object.keys(request).length !== 1
      || !Number.isSafeInteger(request.version) || request.version < 1)
      throw fail("VM_PMO_WRITEBACK_RETRY_INVALID", 400);
    const service = initialize(), task = database.getTask(taskId), run = service.orchestrator.getForTask(taskId);
    if (!task || task.version !== request.version) throw fail("VM_PMO_WRITEBACK_RETRY_VERSION_CONFLICT", 409);
    if (!run || run.state !== "completed" || task.status !== "in_review"
      || !run.deliveredFileToken || !run.completedAt) throw fail("VM_PMO_WRITEBACK_RETRY_NOT_ALLOWED", 409);
    const summary = publicRun(run);
    if (!summary?.canRetryWriteback) throw fail("VM_PMO_WRITEBACK_RETRY_NOT_ALLOWED", 409);
    await service.writebackStore.retryDeadLetterWritebacks({taskId,runId:run.runId}, () => {
      const current = database.getTask(taskId), currentRun = service.orchestrator.getForTask(taskId);
      if (!current || current.version !== request.version || current.archivedAt !== null
        || current.status !== "in_review" || currentRun?.runId !== run.runId || currentRun.state !== "completed")
        throw fail("VM_PMO_WRITEBACK_RETRY_NOT_ALLOWED", 409);
    });
    const queued = publicRun(service.orchestrator.getForTask(taskId));
    void service.writebackWorker.wake().catch(() => {});
    return queued;
  }

  async function register(body,actor) {
    await ready();
    const service = initialize(), result = await service.registration.register(body,actor);
    if (result.created) {try {onTaskUpdated(result.task);} catch {}}
    const intent = db.prepare("SELECT run_id FROM vm_pmo_runtime_bindings WHERE task_id = ?").get(result.task.id);
    if (intent && !intent.run_id) {
      const run = await service.orchestrator.register({taskId: result.task.id});
      db.prepare("UPDATE vm_pmo_runtime_bindings SET run_id = ? WHERE task_id = ? AND run_id IS NULL").run(run.runId,result.task.id);
    }
    return result;
  }
  async function enqueueFinalArchive(body,{retryDirectoryConflict=false}={}) {
    if (closed || !db || typeof getActiveSubject !== "function") throw fail("VM_PMO_RUNTIME_UNAVAILABLE",503);
    const registration = parseFinalArchiveRegistration(body), {event,binding} = registration;
    const active = await getActiveSubject(binding.subjectKey,event.occurredAt);
    const subject = typeof getSubjectVersion === "function"
      ? await getSubjectVersion(binding.subjectKey,binding.configVersion) : active;
    const archive = subject?.vmWorkflow?.finalArchive;
    if (!active || active.lifecycle !== "enabled" || active.configVersion !== binding.configVersion
      || !subject || subject.subjectKey !== binding.subjectKey || subject.configVersion !== binding.configVersion
      || subject.baseToken !== event.baseToken || subject.tableId !== event.tableId
      || !template(subject.workflowTemplate) || archive?.enabled !== true
      || !isVmFinalArchiveTransition(archive,{fieldId:event.statusFieldId,
        beforeOptionIds:event.beforeOptionIds,afterOptionIds:event.afterOptionIds}))
      throw fail("VM_ARCHIVE_CONFIG_CHANGED");
    const service = initialize().finalArchive;
    const record = {baseToken:event.baseToken,tableId:event.tableId,recordId:event.recordId};
    const request = {eventId:event.eventId,subjectKey:binding.subjectKey,configVersion:binding.configVersion,record,
      statusEdge:{statusFieldId:event.statusFieldId,beforeOptionIds:event.beforeOptionIds,
        afterOptionIds:event.afterOptionIds,...(Object.hasOwn(event,"occurredAt") ? {occurredAt:event.occurredAt} : {})}};
    const existing = service.get(event.eventId);
    const register=retryDirectoryConflict ? service.retryDirectoryConflict : service.enqueue;
    const job = await register({ ...request,
      ...(registration.expectedSource ? {expectedSource:registration.expectedSource} : {}) });
    void wakeFinalArchive().catch(() => {});
    return {job,created:existing === null};
  }
  async function wakeFinalArchive() {
    if (closed || !db) return;
    archiveDraining ??= (async () => {
      const service = initialize().finalArchive;
      for (let count = 0;count < 10 && !closed;count++) {
        if (!await service.processNext()) break;
      }
    })().finally(() => {archiveDraining = null;});
    return archiveDraining;
  }
  async function startFinalArchive() {
    if (closed || !db) throw fail("VM_PMO_RUNTIME_UNAVAILABLE",503);
    if (!archiveTimer) {
      initialize();
      archiveTimer = setInterval(() => {void wakeFinalArchive().catch(() => {});},tickMs);
      archiveTimer.unref?.();
    }
    void wakeFinalArchive().catch(() => {});
  }
  async function wake() {
    if (closed) return;
    await ready();const service = initialize();
    draining ??= (async () => {
      try {await service.orchestrator.wake();} finally {releaseTerminalSlots();}
      for (let count = 0;count < 10 && !closed;count++) {if (!await service.delivery.processNext()) break;}
      try {await service.orchestrator.wake();} finally {releaseTerminalSlots();}
      await service.writebackWorker.wake();
      await wakeFinalArchive();
    })().finally(() => {draining = null;});
    return draining;
  }
  async function cancelPendingAutomatic() {
    if (!services) return;
    for (const run of services.orchestrator.list()) {
      if (run.runnerStartedAt || TERMINAL.has(run.state)) continue;
      const changed = db.prepare(`UPDATE vm_pmo_runs SET state = 'blocked',error_code = 'AUTOMATIC_EXECUTION_DISABLED',
        lease_token = NULL,lease_until = NULL,updated_at = ? WHERE run_id = ?
        AND state NOT IN ('completed','blocked','needs_attention')
        AND json_extract(payload_json,'$.runnerStartedAt') IS NULL`)
        .run(now(),run.runId);
      if (changed.changes === 1) cancelSlot(run.runId);
    }
    releaseTerminalSlots();
  }
  return Object.freeze({ready,validateVmPackage,validateActivation,register,wake,cancelPendingAutomatic,
    getTaskRun,retryPlanning,retryWriteback,
    getPackageBoard: async ({subjectKey,packageAlias} = {}) => readVmPackageBoard({database,subjectKey,packageAlias}),
    list: () => services?.orchestrator.list() ?? [],
    enqueueFinalArchive,
    retryFinalArchiveDirectory:body=>enqueueFinalArchive(body,{retryDirectoryConflict:true}),
    startFinalArchive,
    resolveWriteback: async claim => {await ready();return initialize().writebackStore.resolveWritebackIntentForBridge(claim);},
    async start() {
      await ready();initialize();
      await startFinalArchive();
      if (!timer) {
        timer = setInterval(() => {void wake().catch(() => {});},tickMs);timer.unref?.();
        void (async () => {
          await initialize().orchestrator.recoverBindingConflicts();
          await wake();
        })().catch(() => {});
      }
    },
    async close() {
      if (closed) return;closed = true;clearInterval(timer);clearInterval(archiveTimer);
      for (const runId of pendingSlots.keys()) cancelSlot(runId);
      await services?.orchestrator.close();await draining;await archiveDraining;await services?.writebackWorker.close();
    },
  });
}
