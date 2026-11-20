import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { ApiError } from "./database.mjs";
import { canonicalJson } from "./feishu-source-manifest.mjs";
import { packageWorkflowFromManifest } from "../shared/feishu-package-workflow.mjs";
import { createVmTaskRegistration, createVmRegistrationRecordReader, normalizeVmRecordContext } from "./vm-task-registration.mjs";
import { createVmTaskDownloadAdapter } from "./vm-task-download-adapter.mjs";
import { createVmTaskDownloadBindings } from "./vm-task-download-bindings.mjs";
import { createVmPmoOrchestrator } from "./vm-pmo-orchestrator.mjs";
import { prepareVmPmoRunInput } from "./vm-pmo-run-input.mjs";
import {validateVmPmoManualRevision} from "./vm-pmo-manual-revision.mjs";
import { AI_INTENT_SCOPE_VIOLATION, runVmPmoDriver } from "./vm-pmo-v3-driver.mjs";
import { readVmPmoRunReview } from "./vm-pmo-run-review.mjs";
import { readVmPmoAiTranscript } from "./vm-pmo-ai-transcript.mjs";
import { validateVmPmoInput, validateVmPmoInputSnapshot, validateVmPmoPlan, validateVmPmoRender, VM_PMO_QA_RESULT } from "./vm-pmo-result-validator.mjs";
import { archiveVmPmoQa } from "./vm-pmo-qa-archive.mjs";
import { createVmMp4DeliveryService } from "./vm-mp4-delivery.mjs";
import { createVmStageWriteback, parseVmWritebackIdempotencyKey, VM_AI_NOTES_MAX_LENGTH } from "./vm-stage-writeback.mjs";
import { createVmWritebackStore } from "./vm-writeback-store.mjs";
import { createFeishuWritebackWorker } from "./feishu-writeback-worker.mjs";
import { createVmFinalArchiveService } from "./vm-pmo-final-archive.mjs";
import { isVmFinalArchiveTransition, planVmFinalArchive } from "./feishu-vm-delivery-plan.mjs";
import { readVmPackageBoard } from "./vm-package-board.mjs";
import { describeVmPmoAttention, describeVmDownloadFailure } from "./blocked-notification.mjs";
import { verifyVmAcquisitionReceipt } from "./vm-approval-workflow.mjs";
import { prepareVmSource } from "./vm-source-adapter.mjs";

const TEMPLATE = Object.freeze({id: "vm_pmo_review_video",version: 1});
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,511}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set(["completed","blocked","needs_attention"]);
const MAX_PLAN_ATTEMPTS = 3;
const AI_INTENT_BLOCKS = ["AI_INTENT_TIMEOUT","AI_INTENT_MISSING","AI_INTENT_FAILED","AI_PROVIDER_FAILED"];
const MAX_AI_RETRIES = 2;
// Provider refusals (balance, quota, auth) do not use the AI retry allowance; see the orchestrator.
const MAX_AI_PROVIDER_RETRIES = 10;
// Moments written without render start evidence: source acquisition and AI notes (which may explain a block).
const MATERIAL_MOMENTS = new Set(["materials_ready","download_failed","ai_notes"]);
// Operator-supplied sources live in a fixed folder beside the configured VM download output.
const MANUAL_SOURCE_FOLDER = "人工素材";
const MANUAL_SOURCE_RESOLUTION = Object.freeze({width: 1280,height: 720});
const ACTOR = Object.freeze({type: "agent",id: "vm-pmo-runtime",name: "VM 初稿剪辑",avatarUrl: null});
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a,b) => canonicalJson(a) === canonicalJson(b);
const fail = (code,status = 409) => new ApiError(status,code,code);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const template = value => value?.id === TEMPLATE.id && value.version === 1;

export function latestActiveVmStageOrigin({db,database,subjectKey,baseToken,tableId,recordId,
  fieldId,packageAlias,excludeTaskId,lineageFor}) {
  const rows = db.prepare(`SELECT task_id FROM feishu_task_origins
    WHERE subject_key = ? AND base_token = ? AND table_id = ? AND record_id = ?
    ORDER BY created_at DESC, rowid DESC`).all(subjectKey,baseToken,tableId,recordId);
  return rows.filter(row => row.task_id !== excludeTaskId).map(row => ({
    task:database.getTask(row.task_id),origin:database.getFeishuTaskOrigin(row.task_id)})).find(({task,origin}) => {
    if (!task || task.archivedAt !== null || origin?.packageAlias !== packageAlias
      || !["initial","review"].includes(origin.stageId)
      || origin.stageSnapshot?.vmWorkflow?.fields?.outputAttachmentFieldId !== fieldId) return false;
    return lineageFor(origin.taskId).subjectKey === subjectKey;
  })?.origin ?? null;
}

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

/** The initial stage may bind optional status options for the source acquisition result. */
function materialEdgesFor(subject) {
  const stage = subject?.vmWorkflow?.stages?.initial;
  const bound = key => object(stage?.writeback?.[key]) && stage.writeback[key].fieldId === stage.statusFieldId
    && typeof stage.writeback[key].optionId === "string" && ID.test(stage.writeback[key].optionId);
  return {materialsReady: bound("materialsReady"),downloadFailed: bound("downloadFailed")};
}

/** What a run actually acts on: the workflow bindings, the approval text, the template, the table
 * and the package route. Field and option *names* are labels an operator may rename; ids are what
 * reaches Feishu, so a rename alone does not change what a run would do. */
function executableProfile(subject) {
  return {vmWorkflow: subject?.vmWorkflow ?? null,
    packageAlias: subject?.packageRoute?.packageAlias ?? null,
    workflowTemplate: subject?.workflowTemplate ?? null,
    baseToken: subject?.baseToken ?? null, tableId: subject?.tableId ?? null,
    executionMode: subject?.execution?.mode ?? null};
}

/** A subject re-saved with only label edits keeps every binding a run depends on, so an in-flight run
 * may finish under the newer version. Anything else is a real change and still stops it. */
export function sameExecutableWorkflow(left, right) {
  return same(executableProfile(left), executableProfile(right));
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
    for (const moment of stageId === "initial" ? ["materialsReady","downloadFailed"] : []) {
      const binding = stage.writeback?.[moment];
      if (binding === undefined) continue;
      if (binding?.fieldId !== stage.statusFieldId || !ID.test(binding.optionId ?? "")
        || binding.optionId === stage.triggerOptionId) throw fail("VM_WORKFLOW_NOT_READY");
      option(binding.fieldId,binding.optionId);
    }
  }
  return config;
}

/** The runtime owns executable paths, policy, immutable input evidence and remote effects.
 * Neither the registration body nor PMO record may choose an executable or a workspace.
 * Local readiness never initializes the approval queue, a remote adapter, or run directories. */
export function createVmPmoRuntime({database,getPackage,getActiveSubject,getSubjectVersion,getDownloads,getAdapter,getPolicy,
  scheduler,dispatchWriteback,onTaskUpdated = () => {},runRoot,pythonPath,aiIntent = null,
  ffprobePath = "ffprobe",ffmpegPath = "ffmpeg",coursePathResolver = {},tickMs = 5_000,now = Date.now} = {}) {
  const db = database?.database;
  let services, closed = false, timer, archiveTimer, draining, archiveDraining;
  const pendingSlots = new Map();
  let automaticCancellationEpoch = 0;

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

  /** Screenshots are accepted only when the package's v3 contract declares the review_images input. */
  /** v3 package inputs declared in the manifest (review_images, review_original_source). */
  async function packageInputs(record) {
    try {
      await canonicalLocation(record.workspacePath,{directory: true});
      const manifest = JSON.parse(await readFile(path.join(record.workspacePath,"PACKAGE-MANIFEST.json"),"utf8"));
      return manifest.interface?.contract?.version === 3 && Array.isArray(manifest.interface?.inputs)
        ? manifest.interface.inputs.filter(value => typeof value === "string") : [];
    } catch {return [];}
  }
  async function reviewImagesSupported(record) {return (await packageInputs(record)).includes("review_images");}
  async function inspectPackage(record) {
    if (!object(record) || !template(record.workflowTemplate)) throw fail("PACKAGE_WORKFLOW_MISMATCH");
    try {
      await canonicalLocation(record.workspacePath,{directory: true});
      const filename = path.join(record.workspacePath,"PACKAGE-MANIFEST.json");
      await canonicalLocation(filename);
      const bytes = await readFile(filename), manifest = JSON.parse(bytes.toString("utf8"));
      const contract = manifest.interface?.contract?.version;
      if (!template(packageWorkflowFromManifest(manifest.interface))
        || manifest.interface?.contract?.id !== TEMPLATE.id || ![2, 3].includes(contract)
        || manifest.interface?.driverId !== `vm_pmo_review_video_v${contract}`
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
    if (config.stages.review.enabled && (![2, 3].includes(identity.contractVersion)
      || identity.driverId !== `vm_pmo_review_video_v${identity.contractVersion}`)) throw fail("VM_PMO_REVIEW_PROTOCOL_REQUIRED");
    // v3 plans every instruction through an unattended AI session; without one it cannot run.
    if (identity.contractVersion === 3 && (typeof aiIntent?.run !== "function" || !aiIntent.session)) throw fail("VM_PMO_AI_NOT_CONFIGURED");
    return true;
  }
  const localAdapter = Object.freeze(Object.fromEntries(["listFields","getRecord","updateRecord","uploadMedia","downloadMedia"].map(method => [method,
    async input => {
      const adapter = await getAdapter();
      if (typeof adapter?.[method] !== "function") throw fail("VM_PMO_ADAPTER_UNAVAILABLE",503);
      return adapter[method](input);
    }])));
  const readCurrentRecord = createVmRegistrationRecordReader(localAdapter);

  async function notifyAttention({run}) {
    // The AI's own explanation of a block goes to the record's notes field, when one is configured.
    if (services) void services.enqueueAiNotes(run).catch(() => {});
    const task = database.getTask(run.taskId), origin = database.getFeishuTaskOrigin(run.taskId);
    const subject = origin && database.getFeishuSubjectVersion(origin.subjectKey, origin.configVersion);
    const notification = describeVmPmoAttention({run, task, origin, subject});
    if (notification) await (await getDownloads()).notifyWorkflowBlocked(notification);
  }

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
      return latestActiveVmStageOrigin({db,database,subjectKey,baseToken,tableId,recordId,
        fieldId,packageAlias,excludeTaskId,lineageFor});
    }
    function subjectLineage(subject) {
      return {subjectKey: subject.subjectKey, packageAlias: subject.packageRoute.packageAlias,
        workflowTemplate: {...subject.workflowTemplate}};
    }

    /** A review goes back to the original source only when the package supports it and every earlier
     * round was planned on that original (the initial round, or reviews that were themselves rebased). */
    async function resolveReviewSource({parent,packageRecord}) {
      if (!(await packageInputs(packageRecord)).includes("review_original_source")) return null;
      const parentRun = orchestrator.get(parent.runId);
      if (!parentRun || parentRun.state !== "completed") return null;
      const parentStage = parentRun.identity.origin.stageId;
      if (parentStage === "review") {
        const inherited = parentRun.identity.stageSnapshot?.reviewSource;
        return inherited?.basis === "vm_original" ? structuredClone(inherited) : null;
      }
      const acquired = parentRun.acquisition;
      if (parentStage !== "initial" || !["vm_api_verified","operator_asserted"].includes(acquired?.vmid_binding)
        || !HASH.test(parentRun.planSha256 ?? "")) return null;
      try {
        // Only v2/v3 plans have the microsecond segment table a time map needs.
        const bound = JSON.parse(db.prepare("SELECT bound_json FROM vm_pmo_attempt_inputs WHERE run_id = ? AND context_path = ?")
          .get(parentRun.runId,parentRun.prepared.contextPath).bound_json);
        if (!(bound.input.schema_version >= 2)) return null;
        // A retired original keeps the review on the parent MP4 instead of failing later.
        if (!(await lstat(acquired.path)).isFile()) return null;
      } catch {return null;}
      const acquisition = Object.fromEntries(["path","sha256","bytes","duration_ms","vmid_binding","vmid","receipt_path"]
        .filter(key => acquired[key] !== undefined).map(key => [key,acquired[key]]));
      return {basis: "vm_original",rootRunId: parentRun.runId,acquisition};
    }
    /** Every earlier round of a rebased review (oldest first) and the segment table of each delivered cut. */
    async function rebaseFor(run) {
      const chain = [];
      let parentId = run.identity.stageSnapshot.reviewParent.runId;
      while (parentId && chain.length < 20) {
        const parentRun = orchestrator.get(parentId);
        if (!parentRun || parentRun.state !== "completed" || !HASH.test(parentRun.planSha256 ?? ""))
          throw fail("VM_PMO_REVIEW_SOURCE_INVALID");
        chain.unshift(parentRun);
        parentId = parentRun.identity.origin.stageId === "review" ? parentRun.identity.stageSnapshot.reviewParent.runId : null;
      }
      if (chain[0]?.runId !== run.identity.stageSnapshot.reviewSource.rootRunId) throw fail("VM_PMO_REVIEW_SOURCE_INVALID");
      const rounds = [], timeMaps = [];
      for (const [index,round] of chain.entries()) {
        const text = round.identity.stageSnapshot.vmContext?.instruction;
        const fieldId = round.identity.stageSnapshot.instructionFieldId;
        if (typeof text !== "string" || !text.trim() || typeof fieldId !== "string") throw fail("VM_PMO_REVIEW_SOURCE_INVALID");
        rounds.push({instructionId: `round-${index}`,sourceFieldId: fieldId,rawText: text,
          ...(index ? {timeMapId: `cut-${index - 1}`} : {})});
        // The cut a reviewer watched: its own plan, re-hashed against the plan the run rendered.
        const row = db.prepare("SELECT bound_json FROM vm_pmo_attempt_inputs WHERE run_id = ? AND context_path = ?")
          .get(round.runId,round.prepared.contextPath);
        let plan;
        try {
          const planPath = JSON.parse(row.bound_json).context.plan_path;
          const bytes = await readFile(planPath);
          if (digest(bytes) !== round.planSha256) throw new Error("plan changed");
          plan = JSON.parse(bytes.toString("utf8"));
        } catch {throw fail("VM_PMO_REVIEW_SOURCE_INVALID");}
        if (!Array.isArray(plan.segments) || !plan.segments.length) throw fail("VM_PMO_REVIEW_SOURCE_INVALID");
        timeMaps.push({time_map_id: `cut-${index}`,plan_sha256: round.planSha256,segments: plan.segments.map(segment => ({
          source_start_us: segment.source_start_us,duration_us: segment.duration_us,target_start_us: segment.target_start_us}))});
      }
      return {rounds,timeMaps};
    }
    /** Earlier rounds of a review chain, oldest first, read from trusted task origins only. */
    function priorRoundsFor(origin) {
      const rounds = [], seen = new Set();
      let parent = origin?.stageId === "review" ? origin.stageSnapshot?.reviewParent : null;
      while (parent?.runId && !seen.has(parent.runId) && rounds.length < 20) {
        seen.add(parent.runId);
        const row = db.prepare("SELECT task_id FROM vm_pmo_runs WHERE run_id = ?").get(parent.runId);
        const parentOrigin = row ? database.getFeishuTaskOrigin(row.task_id) : null;
        const text = parentOrigin?.stageSnapshot?.vmContext?.instruction;
        if (typeof text !== "string" || !text.trim()) break;
        rounds.unshift({round_id: parentOrigin.stageId === "review"
          ? `review-${parentOrigin.stageSnapshot.reviewRound}` : "initial",
        instructions: [{instruction_id: "instruction-1",raw_text: text}]});
        parent = parentOrigin.stageId === "review" ? parentOrigin.stageSnapshot?.reviewParent : null;
      }
      return rounds;
    }
    /** A review round continues the AI conversation of the round it revises, and can read its files. */
    async function aiHistoryFor(run) {
      const parent = run?.identity?.origin?.stageId === "review" ? run.identity.stageSnapshot?.reviewParent : null;
      if (!parent?.runId) return null;
      const parentRun = orchestrator.get(parent.runId);
      if (!parentRun?.prepared?.contextPath) return null;
      const parentRunDir = path.dirname(parentRun.prepared.contextPath);
      const sessions = path.join(path.dirname(parentRunDir), "ai-sessions");
      let latest = null;
      for (const name of await readdir(sessions).catch(() => [])) {
        try {
          const outcome = JSON.parse(await readFile(path.join(sessions, name, "outcome.json"), "utf8"));
          if (outcome?.outcome === "completed" && typeof outcome.thread_id === "string"
            && (!latest || String(outcome.finished_at) > String(latest.finished_at))) latest = outcome;
        } catch {}
      }
      return {parentRunDir, resumeThreadId: latest?.thread_id ?? null, imagePaths: await reviewImagesFor(run),
        rebased: Boolean(run.identity.stageSnapshot?.reviewSource)};
    }
    /** Downloads the frozen review screenshots once per run, beside (not inside) the AI-writable attempt
     * directory, and re-verifies their recorded SHA-256 on every later use. */
    async function reviewImagesFor(run) {
      const refs = run?.identity?.stageSnapshot?.vmContext?.reviewImages;
      if (!Array.isArray(refs) || !refs.length || !run.prepared?.contextPath) return [];
      const directory = path.join(path.dirname(path.dirname(run.prepared.contextPath)),"review-images");
      const manifestPath = path.join(directory,"review-images.json");
      await mkdir(directory,{recursive: true});
      await canonicalLocation(directory,{directory: true});
      let saved = null;
      try {saved = JSON.parse(await readFile(manifestPath,"utf8"));} catch {}
      const extension = mime => ({"image/png":"png","image/jpeg":"jpg","image/jpg":"jpg","image/webp":"webp",
        "image/gif":"gif","image/bmp":"bmp"})[mime] ?? "img";
      const entries = [];
      for (const [index,ref] of refs.entries()) {
        const file = path.join(directory,`${String(index + 1).padStart(2,"0")}.${extension(ref.mimeType)}`);
        const known = saved?.images?.[index];
        if (known && known.fileToken === ref.fileToken) {
          let bytes;
          try {bytes = await readFile(file);} catch {throw fail("VM_REVIEW_IMAGE_CHANGED");}
          if (digest(bytes) !== known.sha256 || bytes.length !== known.bytes) throw fail("VM_REVIEW_IMAGE_CHANGED");
          entries.push({...known,path: file});
          continue;
        }
        if (saved) throw fail("VM_REVIEW_IMAGE_CHANGED");
        const fetched = await localAdapter.downloadMedia({fileToken: ref.fileToken,
          tableId: run.identity.origin.tableId,targetPath: file,maxBytes: 20 * 1024 * 1024});
        entries.push({fileToken: ref.fileToken,name: ref.name,mimeType: ref.mimeType,...fetched,path: file});
      }
      if (!saved) await writeFile(manifestPath,JSON.stringify({images: entries.map(({path: _file,...rest}) => rest)},null,2)+"\n",
        {flag: "wx"});
      return entries.map(entry => entry.path);
    }
    function trustedRun(runId, {requireStarted = true} = {}) {
      const run = orchestrator.get(runId);
      if (!run || requireStarted && !run.runnerStartedAt) throw fail("VM_PMO_RUN_NOT_STARTED");
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
    /** The latest AI session report of the run's current attempt; null when no AI session ran. */
    async function latestAiReport(run) {
      if (!run?.prepared?.contextPath) return null;
      const attemptDir = path.dirname(run.prepared.contextPath);
      const sessions = path.join(path.dirname(attemptDir), "ai-sessions");
      const prefix = `${path.basename(attemptDir)}-session-`;
      let latest = null;
      for (const name of await readdir(sessions).catch(() => [])) {
        if (!name.startsWith(prefix)) continue;
        try {
          const outcome = JSON.parse(await readFile(path.join(sessions, name, "outcome.json"), "utf8"));
          if (!latest || String(outcome.finished_at) > String(latest.outcome.finished_at)) latest = {name, outcome};
        } catch {}
      }
      if (!latest) return null;
      let report = "";
      try {report = (await readFile(path.join(sessions, latest.name, "report.txt"), "utf8")).trim();} catch {}
      return {report, outcome: latest.outcome.outcome};
    }
    /** Rebuilt from run evidence only, so validating a queued note recomputes exactly the same text. */
    async function aiNotesText({run: candidate}) {
      const run = orchestrator.get(candidate.runId);
      const ai = await latestAiReport(run);
      if (!run || !ai) return null;
      const review = await runReview(run);
      const origin = run.identity.origin, round = origin.stageId === "review"
        ? `第 ${run.identity.stageSnapshot?.reviewRound ?? "?"} 轮修改` : "初稿";
      const lines = [`【AI 处理说明 · ${round}】`];
      if (run.state === "completed") lines.push("结果：已生成并上传成片，请审核。需要调整时在审核意见里补充说明，下一轮会接着这次的处理继续改。");
      else lines.push(`结果：已停止，没有生成成片（${run.errorCode ?? run.state}）。请在剪辑要求或审核意见里补充说明后重新触发。`);
      if (ai.report) lines.push("", ai.report);
      if (review?.blockers?.length) {
        lines.push("", "阻断明细：");
        for (const row of review.blockers.slice(0, 10)) lines.push(`- ${row.code ?? "BLOCKED"}：${row.message ?? ""}`);
      }
      if (review?.qa?.counts) {
        const counts = review.qa.counts;
        lines.push("", `质检：通过 ${counts.passed ?? 0} 项，需人工复核 ${counts.needs_human ?? 0} 项，未通过 ${counts.failed ?? 0} 项。`);
      }
      const text = lines.join("\n");
      return text.length > VM_AI_NOTES_MAX_LENGTH ? `${text.slice(0, VM_AI_NOTES_MAX_LENGTH - 2)}…` : text;
    }
    const notesSlot = text => typeof text === "string" ? `n${digest(text).slice(0, 32)}` : null;
    async function enqueueAiNotes(run) {
      const current = orchestrator.get(run.runId);
      if (!current || !metadata(current.taskId).subject?.vmWorkflow?.fields?.aiNotesFieldId) return;
      const text = await aiNotesText({run: current});
      if (!text) return;
      await enqueueWriteback(current,"ai_notes",notesSlot(text));
    }
    // Each run has its own frozen subject. A task from a later version must never redirect an earlier run.
    async function planWriteback(runId,moment,slot = null) {
      // Source moments are written before any render evidence exists.
      const requireStarted = !MATERIAL_MOMENTS.has(moment);
      const run = trustedRun(runId,{requireStarted}), frozen = metadata(run.taskId).subject;
      const planner = createVmStageWriteback({resolveTrustedRun: () => trustedRun(runId,{requireStarted}),
        getActiveSubject: () => structuredClone(frozen),
        listFields: localAdapter.listFields,getDelivery: () => delivery.get(runId),
        isLatestStageRun: async ({run: candidate}) => {
          const latest = latestStageOrigin({...candidate.target,subjectKey:candidate.subjectKey,
            fieldId:candidate.identity.outputAttachmentFieldId,packageAlias:candidate.identity.origin.packageAlias});
          return latest?.taskId === candidate.taskId;
        },
        enqueueWritebackIntent: input => writebackStore.enqueueWritebackIntent(input),
        aiNotesText,notesSlot});
      return planner.plan({runId,moment,slot});
    }
    writebackStore = createVmWritebackStore({database,now,validateIntent: async input => {
      const key = parseVmWritebackIdempotencyKey(input.idempotencyKey,input.runId);
      if (!key) throw fail("WRITEBACK_REFERENCE_INVALID");
      const expected = await planWriteback(input.runId,key.moment,key.slot);
      if (!same(expected,input)) throw fail("WRITEBACK_REFERENCE_INVALID");
      return {target: trustedRun(input.runId,{requireStarted: !MATERIAL_MOMENTS.has(key.moment)}).target,
        operation: expected.operation};
    }});
    writebackWorker = createFeishuWritebackWorker({store: writebackStore,dispatch: dispatchWriteback,now});
    async function enqueueWriteback(run,moment,slot = null) {
      await writebackStore.enqueueWritebackIntent(await planWriteback(run.runId,moment,slot));
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
        // A queued QA rerun has not started yet, so it still waits on the switch like any new step.
        const qaPending = Boolean(run.qaRetryHistory?.length) && !run.qaRetryStartedAt;
        if (run.runnerStartedAt && !qaPending && (!run.renderRetryHistory?.length
          || run.renderRetryLaunchAt || run.renderRetryStartedAt)) return true;
        const policy = await getPolicy(), local = metadata(run.taskId);
        if (policy?.enabled !== true) throw fail("AUTOMATIC_EXECUTION_DISABLED");
        if (policy.version !== local.policy_version) throw fail("VM_PMO_POLICY_CHANGED");
        const origin = database.getFeishuTaskOrigin(run.taskId), snapshot = database.getFeishuTaskPackageSnapshot(run.taskId);
        if (origin?.executionMode !== "automatic") throw fail("VM_PMO_TASK_NOT_ELIGIBLE");
        const active = await getActiveSubject(origin.subjectKey);
        // A later version that only renamed options keeps everything the run acts on, so it may finish.
        if (active?.lifecycle !== "enabled"
          || active.configVersion !== origin.configVersion
            && !sameExecutableWorkflow(active,local.subject)
          || !same(active.vmWorkflow,local.subject.vmWorkflow)
          || active.packageRoute?.packageAlias !== origin.packageAlias)
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
        const rawRecord = await readCurrentRecord({subject: local.subject,event: origin,stageId: origin.stageId,
          allowReviewImages: await reviewImagesSupported(await getPackage(origin.packageAlias))});
        // Taskboard's own source writebacks are the only other statuses this run may see before render.
        const edges = origin.stageId === "initial" ? materialEdgesFor(local.subject)
          : {materialsReady: false,downloadFailed: false};
        const stage = local.subject.vmWorkflow.stages.initial;
        const sourceOptions = new Set([edges.materialsReady && stage.writeback.materialsReady.optionId,
          edges.downloadFailed && stage.writeback.downloadFailed.optionId]
          .filter(option => typeof option === "string"));
        const record = normalizeVmRecordContext(rawRecord,
          {expectedStatusOptionId: sourceOptions.has(rawRecord?.statusOptionId)
            ? rawRecord.statusOptionId : origin.afterOptionId});
        const frozenContext=origin.stageSnapshot?.vmContext;
        const comparable = sourceOptions.has(record.statusOptionId)
          ? {...record,statusOptionId:frozenContext?.statusOptionId} : record;
        const instructionOnlyDrift=run.manualRevision !== undefined
          && origin.stageId === "initial" && same({...comparable,instruction:frozenContext?.instruction},frozenContext);
        if (!same(comparable,frozenContext) && !instructionOnlyDrift) throw fail("VM_PMO_RECORD_CHANGED");
        const prepared = await prepareVmPmoRunInput({runRoot,runId: run.runId,taskId: run.taskId,origin,
          profile: local.subject.vmWorkflow,packageSnapshot: database.getFeishuTaskPackageSnapshot(run.taskId),
          packageIdentity,acquisition,pythonPath,planAttempt,manualRevision:run.manualRevision,
          aiSession:aiIntent?.session,priorRounds:priorRoundsFor(origin),
          ...(origin.stageSnapshot?.reviewSource ? {rebase: await rebaseFor(run)} : {})});
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
          const reviewSource = origin.stageSnapshot?.reviewSource;
          if (reviewSource && (!parent || !same(parent,frozenParent) || run.approvalStatus !== "ready"
            || run.binding.approvalJobId !== null || !same(run.acquisition,reviewSource.acquisition)))
            throw fail("VM_PMO_RETRY_SOURCE_CHANGED");
          if (!reviewSource && (!parent || !same(parent,frozenParent) || run.approvalStatus !== "ready"
            || run.binding.approvalJobId !== null || run.acquisition?.vmid_binding !== "managed_review_parent"
            || run.acquisition.path !== parent.localPath || run.acquisition.sha256 !== parent.sha256
            || run.acquisition.bytes !== parent.bytes || run.acquisition.duration_ms !== parent.durationMs
            || run.acquisition.vmid !== origin.stageSnapshot.vmContext?.vmid))
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
        if (run.acquisition?.vmid_binding === "operator_asserted") {
          // The VM application stays approved; the operator copy is re-hashed against its own receipt.
          if (run.manualSource?.state !== "accepted" || run.downloadFailure?.approved !== true)
            throw fail("VM_PMO_RETRY_SOURCE_CHANGED");
          let verified;
          try {
            verified = await verifyVmAcquisitionReceipt(run.acquisition.receipt_path,{vmid: run.binding.vmid,
              applicationId: run.downloadFailure.applicationId,instanceCode: run.downloadFailure.instanceCode,
              allowOperatorReceipt: true});
          } catch {throw fail("VM_PMO_RETRY_SOURCE_CHANGED");}
          if (["receipt_path","path","sha256","bytes","duration_ms","vmid_binding"]
            .some(key => verified[key] !== run.acquisition[key])) throw fail("VM_PMO_RETRY_SOURCE_CHANGED");
        } else {
          // The recorded approvalStatus is a mirror an earlier stop can leave behind; the live queue
          // and a byte-identical material are what prove this run may plan again.
          if (status.status !== "ready" || status.acquisition?.vmid_binding !== "vm_api_verified")
            throw fail("VM_PMO_RETRY_APPROVAL_NOT_READY");
          const keys = ["receipt_path","path","sha256","bytes","duration_ms","vmid_binding","vmid"];
          if (!run.acquisition || keys.some(key => status.acquisition[key] !== run.acquisition[key]))
            throw fail("VM_PMO_RETRY_SOURCE_CHANGED");
        }
        if (run.prepared) {
          try {await boundFor(run.prepared.runnerOptions,{runId:run.runId,taskId:run.taskId,
            planAttempt:run.planAttempt ?? 1,inputSha256:run.prepared.inputSha256});}
          catch {throw fail("VM_PMO_RETRY_SOURCE_CHANGED");}
        } else if (run.errorCode !== "VM_PMO_RECORD_CHANGED" || run.manualRevision === undefined) {
          throw fail("VM_PMO_RETRY_SOURCE_CHANGED");
        }
      },
      validateSavedPlan: async ({run}) => {
        const options = {...run.prepared.runnerOptions,runId:run.runId,taskId:run.taskId,
          planAttempt:run.planAttempt ?? 1,inputSha256:run.prepared.inputSha256};
        const bound = await boundFor(options,{runId:run.runId,taskId:run.taskId,
          planAttempt:options.planAttempt,inputSha256:options.inputSha256});
        for (const file of [bound.context.result_path,bound.context.output_path]) {
          try {await lstat(file);throw fail("VM_PMO_RETRY_RENDER_EVIDENCE_PRESENT");}
          catch (error) {if (error?.code !== "ENOENT") throw error;}
        }
        const result = await validateVmPmoPlan({...options,ffprobePath,expectedBound:bound});
        if (result.status !== "ready") throw fail("VM_PMO_RETRY_PLAN_INVALID");
        return result;
      },
      runOffline: async options => {
        const bound = await boundFor(options,{runId:options.runId,taskId:options.taskId,
          planAttempt:options.planAttempt,inputSha256:options.inputSha256});
        // Reverse ASR on the finished MP4 is on by default for v3 (decided 2026-11-17).
        const aiHistory = options.mode === "plan" ? await aiHistoryFor(orchestrator.get(options.runId)) : null;
        const result = await runVmPmoDriver({...options,ffprobePath,ffmpegPath,expectedBound: bound,
          aiIntent,aiHistory,reverseAsr: true});
        await validateVmPmoInput({...options,expectedBound: bound});
        return result;
      },
      recoverOffline: async options => {
        const bound = await boundFor(options,{runId:options.runId,taskId:options.taskId,
          planAttempt:options.planAttempt,inputSha256:options.inputSha256});
        const receipt = options.mode === "plan" ? bound.context.plan_result_path
          : options.mode === "qa" ? path.join(bound.context.run_dir,VM_PMO_QA_RESULT) : bound.context.result_path;
        try {await lstat(receipt);} catch (error) {if (error?.code === "ENOENT") return null;throw fail("VM_PMO_RUN_OUTCOME_UNKNOWN");}
        return options.mode === "plan" ? validateVmPmoPlan({...options,ffprobePath,expectedBound: bound})
          : validateVmPmoRender({...options,ffprobePath,ffmpegPath,expectedBound: bound});
      },
      archiveQa: async ({run}) => {
        const options = {...run.prepared.runnerOptions,runId:run.runId,taskId:run.taskId,
          planAttempt:run.planAttempt ?? 1,inputSha256:run.prepared.inputSha256};
        const bound = await boundFor(options,{runId:run.runId,taskId:run.taskId,
          planAttempt:options.planAttempt,inputSha256:options.inputSha256});
        // The MP4 and its render receipt must still be the ones rendered for this plan.
        const rendered = await validateVmPmoRender({...options,ffprobePath,ffmpegPath,expectedBound:bound,qa:"skip"});
        if (rendered.status !== "rendered" || rendered.planSha256 !== run.planSha256)
          throw fail("VM_PMO_RETRY_RENDER_CHANGED");
        await archiveVmPmoQa(bound.context);
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
      onCompleted: async ({run}) => {
        await enqueueWriteback(run,"completed");taskStatus(run,"in_review");
        try {await enqueueAiNotes(run);} catch {/* Notes never hold back a delivered round. */}
      },
      onAttention: notifyAttention,
      materialEdges: async ({run}) => materialEdgesFor(metadata(run.taskId).subject),
      onMaterialsReady: async ({run}) => enqueueWriteback(run,"materials_ready"),
      onDownloadFailed: async ({run,slot}) => enqueueWriteback(run,"download_failed",slot),
    });
    services = {orchestrator,delivery,finalArchive,writebackStore,writebackWorker,metadata,enqueueWriteback,enqueueAiNotes,latestStageOrigin,
      registration: createVmTaskRegistration({database,getPackage,getActiveSubject,readCurrentRecord,
        resolveReviewParent,reviewImagesSupported,resolveReviewSource,
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
    const canRetryApproval = run.state === "blocked" && run.errorCode === "VM_APPLICANT_CHANGED"
      && run.identity.origin.stageId === "initial" && run.approvalStatus === "reserved"
      && run.binding.approvalJobId === null && !run.acquisition && !run.prepared
      && !run.planStartedAt && !run.runnerStartedAt && !run.artifactId;
    const canRetryManualRevision = canRetryApproval && run.manualRevision === undefined
      || run.state === "blocked" && run.errorCode === "UNSUPPORTED_INSTRUCTION"
        && planAttempt < MAX_PLAN_ATTEMPTS && Boolean(run.planStartedAt && run.prepared && run.acquisition)
        && !run.runnerStartedAt && !run.planSha256 && !run.renderResult && !run.artifactId
        && !run.deliveredFileToken && !run.completedAt
      || run.state === "blocked" && run.errorCode === "VM_PMO_RECORD_CHANGED"
        && run.identity.origin.stageId === "initial" && Boolean(run.manualRevision && run.acquisition)
        && planAttempt > 1 && planAttempt <= MAX_PLAN_ATTEMPTS && !run.prepared && !run.planStartedAt
        && !run.runnerStartedAt && !run.planSha256 && !run.renderResult && !run.artifactId
        && !run.deliveredFileToken && !run.completedAt;
    // Both stops need a fresh plan from the same input; a rule mismatch is the package's own reading
    // having changed, so rerunning after the fix is the operator's decision and nothing is re-downloaded.
    const canRetryPlan = run.state === "blocked"
      && ["WORD_ALIGNMENT_UNRESOLVED", "INTENT_RULE_MISMATCH"].includes(run.errorCode)
      && planAttempt < MAX_PLAN_ATTEMPTS && Boolean(run.planStartedAt && run.prepared && run.acquisition)
      && !run.runnerStartedAt && !run.planSha256 && !run.renderResult && !run.artifactId
      && !run.deliveredFileToken && !run.completedAt;
    // A verified download may continue this run whatever stopped it before any planning: the download
    // reported "outcome unknown" and finished later, the record's status option moved on after the
    // material was adopted, or a newer subject version kept every binding and only the config number
    // drifted. Only a verified file and an untouched run qualify; nothing is re-requested.
    const verified = run.acquisition?.vmid_binding === "vm_api_verified" ? run.acquisition : null;
    const canResumeSource = run.state === "blocked"
      && (run.errorCode === "VM_DOWNLOAD_FAILED"
          && run.downloadFailure?.reason === "VM_DOWNLOAD_OUTCOME_UNKNOWN"
          && (run.downloadFailure?.approved === true || Boolean(verified))
        || run.errorCode === "VM_RECORD_STATUS_CHANGED" && Boolean(verified)
        || run.errorCode === "VM_PMO_CONFIG_CHANGED" && Boolean(verified))
      && run.identity.origin.stageId === "initial" && run.binding.approvalJobId !== null
      && !run.prepared && !run.planStartedAt && !run.runnerStartedAt && !run.planSha256
      && !run.renderResult && !run.artifactId && !run.deliveredFileToken && !run.completedAt;
    const canRetryValidatedPlan = run.state === "needs_attention" && run.errorCode === "PLAN_INVALID"
      && Boolean(run.planStartedAt && run.prepared && run.acquisition)
      && !run.runnerStartedAt && !run.planSha256 && !run.renderResult && !run.artifactId
      && !run.deliveredFileToken && !run.completedAt;
    const providerBlock = run.errorCode === "AI_PROVIDER_FAILED";
    const aiRetryCount = (run.aiRetryHistory ?? []).filter(entry =>
      (entry.errorCode === "AI_PROVIDER_FAILED") === providerBlock).length;
    const canRetryAiIntent = run.state === "blocked" && AI_INTENT_BLOCKS.includes(run.errorCode)
      && aiRetryCount < (providerBlock ? MAX_AI_PROVIDER_RETRIES : MAX_AI_RETRIES) && Boolean(run.planStartedAt && run.prepared && run.acquisition)
      && !run.runnerStartedAt && !run.planSha256 && !run.renderResult && !run.artifactId
      && !run.deliveredFileToken && !run.completedAt;
    const canRetryFailedRender = run.state === "needs_attention"
      && run.errorCode === "VM_PMO_START_EVIDENCE_FAILED"
      && Boolean(run.runnerStartedAt && run.planSha256 && run.prepared && run.acquisition)
      && !run.renderRetryHistory?.length && !run.renderResult && !run.artifactId
      && !run.deliveredFileToken && !run.completedAt;
    // A step timeout leaves no result from the failed stage, so rerunning it
    // once from the same frozen input is safe. Output means the stage finished.
    const canRetryStepTimeout = run.state === "needs_attention"
      && run.errorCode === "VM_PMO_RUN_TIMEOUT"
      && Boolean(run.planStartedAt && run.prepared && run.acquisition)
      && !run.stepTimeoutRetryHistory?.length && !run.renderResult && !run.artifactId
      && !run.deliveredFileToken && !run.completedAt;
    // An older Taskboard or package misjudged the QA of a rendered MP4: rerun only QA, once.
    const canRetryQa = (run.state === "needs_attention" && run.errorCode === "QA_REPORT_INVALID"
        || run.state === "blocked" && run.errorCode === "VM_PMO_QA_FAILED")
      && Boolean(run.runnerStartedAt && run.planSha256 && run.prepared && run.acquisition)
      && !run.qaRetryHistory?.length && !run.renderResult && !run.artifactId
      && !run.deliveredFileToken && !run.completedAt;
    // 只读摘要，供看板填写人工修改方案时绑定原视频；不含路径、回执等敏感字段。
    const sourceSha256 = /^[a-f0-9]{64}$/u.test(run.acquisition?.sha256 ?? "") ? run.acquisition.sha256 : null;
    const sourceDurationMs = Number.isSafeInteger(run.acquisition?.duration_ms) && run.acquisition.duration_ms > 0
      ? run.acquisition.duration_ms : null;
    return {runId:run.runId,taskId:run.taskId,state:run.state,errorCode:run.errorCode,
      approvalStatus:run.approvalStatus,planAttempt,retryLimit:MAX_PLAN_ATTEMPTS,
      sourceSha256,sourceDurationMs,
      materialSource: run.acquisition?.vmid_binding === "operator_asserted" ? "manual"
        : run.acquisition ? "vm" : null,
      ...(run.errorCode === "VM_DOWNLOAD_FAILED" && run.downloadFailure ? {downloadFailure: {
        reason: run.manualSource?.state === "failed" ? run.manualSource.reason : run.downloadFailure.reason,
        approved: run.downloadFailure.approved,
        manualSourceState: run.manualSource?.state ?? null,
        message: describeVmDownloadFailure(run),
        manualSourceFile: run.downloadFailure.approved ? `${MANUAL_SOURCE_FOLDER}/${run.binding.vmid}.mp4` : null,
      }} : {}),
      canRetryApproval,canRetryManualRevision,
      retryHistory:(run.retryHistory ?? []).map(entry => ({planAttempt:entry.planAttempt,errorCode:entry.errorCode,
        failedAt:entry.failedAt})),canRetryPlan,canRetryValidatedPlan,canRetryFailedRender,canResumeSource,
      canRetryStepTimeout,canRetryQa,
      qaRetryHistory:(run.qaRetryHistory ?? []).map(entry => ({errorCode:entry.errorCode,failedAt:entry.failedAt})),
      stepTimeoutRetryHistory:(run.stepTimeoutRetryHistory ?? []).map(entry => ({
        errorCode: entry.errorCode, failedAt: entry.failedAt, stage: entry.stage })),
      canRetryAiIntent,aiRetryLimit:MAX_AI_RETRIES,
      aiRetryHistory:(run.aiRetryHistory ?? []).map(entry => ({errorCode:entry.errorCode,failedAt:entry.failedAt})),
      canRetryWriteback,writeback,
      updatedAt:new Date(run.updatedAt).toISOString()};
  }

  async function getTaskRun(taskId) {
    await ready();
    const run = initialize().orchestrator.getForTask(taskId);
    const value = publicRun(run);
    if (value) value.review = await runReview(run);
    return value;
  }

  /** The run's AI planning sessions for the task view (read only). Session files live beside the
   * attempt directories, outside what the AI may write, so they are shown even after a scope violation. */
  async function getTaskAiTranscript(taskId) {
    await ready();
    const run = initialize().orchestrator.getForTask(taskId);
    if (!run?.prepared?.contextPath) return {runId: run?.runId ?? null, sessions: []};
    const runRoot = path.dirname(path.dirname(run.prepared.contextPath));
    return {runId: run.runId, sessions: await readVmPmoAiTranscript(runRoot)};
  }

  /** v3 approval details (coverage, blockers, QA items for a human) from the frozen run context. */
  async function runReview(run) {
    // Plan and QA files in a run the AI overstepped may be its own forgeries, not package output.
    if (!run?.prepared || run.errorCode === AI_INTENT_SCOPE_VIOLATION) return null;
    const row = db.prepare("SELECT bound_json FROM vm_pmo_attempt_inputs WHERE run_id = ? AND context_path = ?")
      .get(run.runId,run.prepared.contextPath);
    let context;
    try {context = JSON.parse(row.bound_json).context;} catch {return null;}
    return readVmPmoRunReview(context);
  }

  /** Continue a run with the material its approved download already produced: either the download
   * reported "outcome unknown" and finished later, or the record's status option stopped preparation
   * before any planning. Everything is re-derived: the bound approval job must still be this run's,
   * its receipt must match that approval, and the video bytes are re-hashed before anything is written.
   * Nothing is re-requested, re-downloaded or re-approved. */
  async function resumeDownloadedSource(taskId,request) {
    await ready();
    if (!object(request) || Object.keys(request).length !== 1
      || !Number.isSafeInteger(request.version) || request.version < 1) throw fail("VM_PMO_RESUME_CONSENT_REQUIRED",400);
    const assertTaskVersion = () => {
      if (database.getTask(taskId)?.version !== request.version) throw fail("VERSION_CONFLICT",409);
    };
    assertTaskVersion();
    const service = initialize(), run = service.orchestrator.getForTask(taskId);
    const unknownOutcome = run?.state === "blocked" && run.errorCode === "VM_DOWNLOAD_FAILED"
      && run.downloadFailure?.reason === "VM_DOWNLOAD_OUTCOME_UNKNOWN";
    const stoppedOnStatus = run?.state === "blocked" && run.errorCode === "VM_RECORD_STATUS_CHANGED"
      && Boolean(run.acquisition);
    // Config drift is resumable only when the newer subject keeps every binding this run acts on.
    const stoppedOnConfig = run?.state === "blocked" && run.errorCode === "VM_PMO_CONFIG_CHANGED"
      && Boolean(run.acquisition);
    if (!run || run.identity.packageSnapshot.workflowTemplate.id !== TEMPLATE.id
      || !(unknownOutcome || stoppedOnStatus || stoppedOnConfig)) throw fail("VM_PMO_RESUME_NOT_ALLOWED",409);
    if (stoppedOnConfig) {
      const local = service.metadata(run.taskId), active = await getActiveSubject(run.identity.origin.subjectKey);
      if (active?.lifecycle !== "enabled" || !sameExecutableWorkflow(active, local.subject))
        throw fail("VM_PMO_CONFIG_CHANGED",409);
    }
    if (run.binding.approvalJobId === null) throw fail("VM_PMO_RESUME_NOT_ALLOWED",409);
    const downloads = await getDownloads();
    const job = downloads.lookupTaskRun?.({jobId: run.binding.approvalJobId});
    const receiptPath = typeof job?.acquisition?.receipt_path === "string"
      ? job.acquisition.receipt_path : job?.receipt_path;
    if (!job || job.vmid !== run.binding.vmid || typeof receiptPath !== "string")
      throw fail("VM_PMO_RESUME_NOT_ALLOWED",409);
    // The receipt must still name the application and instance this run's material was approved for.
    const applicationId = run.downloadFailure?.applicationId ?? job.application_id;
    const instanceCode = run.downloadFailure?.instanceCode ?? job.instance_code;
    if (![applicationId,instanceCode].every(value => typeof value === "string" && value)
      || job.application_id !== applicationId || job.instance_code !== instanceCode)
      throw fail("VM_PMO_RESUME_NOT_ALLOWED",409);
    let acquisition;
    try {
      // Keep the exact shape a normal acquisition has, so later retries compare like with like.
      acquisition = await verifyVmAcquisitionReceipt(receiptPath,{vmid: run.binding.vmid,
        applicationId,instanceCode});
    } catch {throw fail("VM_PMO_RESUME_SOURCE_CHANGED",409);}
    const queued = await service.orchestrator.resumeDownloadedSource(run.runId,acquisition,{beforeCommit:assertTaskVersion});
    void service.orchestrator.pump(run.runId).finally(releaseTerminalSlots).catch(() => {});
    return publicRun(queued);
  }

  async function retryAiIntent(taskId,request) {
    await ready();
    if (!object(request) || Object.keys(request).length !== 2
      || !Number.isSafeInteger(request.version) || request.version < 1
      || !object(request.runConsent) || Object.keys(request.runConsent).length !== 2
      || request.runConsent.allowAiSession !== true
      || request.runConsent.allowLocalPlanning !== true) throw fail("VM_PMO_RETRY_CONSENT_REQUIRED",400);
    const assertTaskVersion = () => {
      if (database.getTask(taskId)?.version !== request.version) throw fail("VERSION_CONFLICT",409);
    };
    assertTaskVersion();
    const service = initialize(), run = service.orchestrator.getForTask(taskId);
    if (!run || run.identity.packageSnapshot.workflowTemplate.id !== TEMPLATE.id
      || run.identity.packageSnapshot.workflowTemplate.version !== TEMPLATE.version)
      throw fail("VM_PMO_RUN_NOT_FOUND",404);
    if (typeof aiIntent?.run !== "function" || !aiIntent.session) throw fail("VM_PMO_AI_NOT_CONFIGURED",503);
    const queued = await service.orchestrator.retryAiIntent(run.runId,{beforeCommit:assertTaskVersion});
    void service.orchestrator.pump(run.runId).finally(releaseTerminalSlots).catch(() => {});
    return publicRun(queued);
  }

  async function retryApproval(taskId,request) {
    await ready();
    if (!object(request) || Object.keys(request).length !== 1
      || !Number.isSafeInteger(request.version) || request.version < 1)
      throw fail("VM_PMO_RETRY_NOT_ALLOWED",400);
    const assertTaskVersion = () => {
      if (database.getTask(taskId).version !== request.version) throw fail("VERSION_CONFLICT",409);
    };
    assertTaskVersion();
    const service = initialize(), run = service.orchestrator.getForTask(taskId);
    if (!run) throw fail("VM_PMO_RUN_NOT_FOUND",404);
    const queued = await service.orchestrator.retryApproval(run.runId,{beforeCommit:assertTaskVersion});
    void service.orchestrator.pump(run.runId).finally(releaseTerminalSlots).catch(() => {});
    return publicRun(queued);
  }

  async function retryManualRevision(taskId,request) {
    await ready();
    if (!object(request) || Object.keys(request).length !== 3
      || !Number.isSafeInteger(request.version) || request.version < 1
      || !object(request.runConsent) || Object.keys(request.runConsent).length !== 2
      || request.runConsent.allowSourceVideo !== true
      || request.runConsent.allowLocalPlanning !== true)
      throw fail("VM_PMO_RETRY_NOT_ALLOWED",400);
    const revision=validateVmPmoManualRevision(request.manualRevision);
    const assertTaskVersion=()=>{
      if (database.getTask(taskId)?.version !== request.version) throw fail("VERSION_CONFLICT",409);
    };
    assertTaskVersion();
    const service=initialize(),run=service.orchestrator.getForTask(taskId);
    if (!run) throw fail("VM_PMO_RUN_NOT_FOUND",404);
    const queued=run.errorCode === "VM_APPLICANT_CHANGED"
      ? await service.orchestrator.retryApproval(run.runId,{beforeCommit:assertTaskVersion,manualRevision:revision})
      : await service.orchestrator.retryManualRevision(run.runId,revision,{beforeCommit:assertTaskVersion});
    void service.orchestrator.pump(run.runId).finally(releaseTerminalSlots).catch(()=>{});
    return publicRun(queued);
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

  async function retryValidatedPlan(taskId,request) {
    await ready();
    if (!object(request) || Object.keys(request).length !== 1
      || !Number.isSafeInteger(request.version) || request.version < 1)
      throw fail("VM_PMO_RETRY_VERSION_REQUIRED",400);
    const assertTaskVersion = () => {
      if (database.getTask(taskId)?.version !== request.version) throw fail("VERSION_CONFLICT",409);
    };
    assertTaskVersion();
    const service = initialize(), run = service.orchestrator.getForTask(taskId);
    if (!run || run.identity.packageSnapshot.workflowTemplate.id !== TEMPLATE.id
      || run.identity.packageSnapshot.workflowTemplate.version !== TEMPLATE.version)
      throw fail("VM_PMO_RUN_NOT_FOUND",404);
    const queued = await service.orchestrator.retryValidatedPlan(run.runId,{beforeCommit:assertTaskVersion});
    void service.orchestrator.pump(run.runId).finally(releaseTerminalSlots).catch(() => {});
    return publicRun(queued);
  }

  /** QA rerun on the same rendered MP4. The request must name the task version and consent to
   * transcribing the output's audio (reused when already transcribed) and writing new QA files. */
  async function retryQa(taskId,request) {
    await ready();
    if (!object(request) || Object.keys(request).length !== 2
      || !Number.isSafeInteger(request.version) || request.version < 1
      || !object(request.runConsent) || Object.keys(request.runConsent).length !== 2
      || request.runConsent.allowVideoAudioAsr !== true
      || request.runConsent.allowLocalQaOutput !== true) throw fail("VM_PMO_RETRY_CONSENT_REQUIRED",400);
    const assertTaskVersion = () => {
      if (database.getTask(taskId)?.version !== request.version) throw fail("VERSION_CONFLICT",409);
    };
    assertTaskVersion();
    const service = initialize(), run = service.orchestrator.getForTask(taskId);
    if (!run || run.identity.packageSnapshot.workflowTemplate.id !== TEMPLATE.id
      || run.identity.packageSnapshot.workflowTemplate.version !== TEMPLATE.version)
      throw fail("VM_PMO_RUN_NOT_FOUND",404);
    const queued = await service.orchestrator.retryQa(run.runId,{beforeCommit:assertTaskVersion});
    void service.orchestrator.pump(run.runId).finally(releaseTerminalSlots).catch(() => {});
    return publicRun(queued);
  }

  async function retryFailedRender(taskId,request) {
    await ready();
    if (!object(request) || Object.keys(request).length !== 1
      || !Number.isSafeInteger(request.version) || request.version < 1)
      throw fail("VM_PMO_RETRY_VERSION_REQUIRED",400);
    const assertTaskVersion = () => {
      if (database.getTask(taskId)?.version !== request.version) throw fail("VERSION_CONFLICT",409);
    };
    assertTaskVersion();
    const service = initialize(), run = service.orchestrator.getForTask(taskId);
    if (!run || run.identity.packageSnapshot.workflowTemplate.id !== TEMPLATE.id
      || run.identity.packageSnapshot.workflowTemplate.version !== TEMPLATE.version)
      throw fail("VM_PMO_RUN_NOT_FOUND",404);
    const cancellationEpoch = automaticCancellationEpoch;
    const policy = await getPolicy(), local = service.metadata(taskId);
    if (automaticCancellationEpoch !== cancellationEpoch) throw fail("AUTOMATIC_EXECUTION_DISABLED");
    if (policy?.enabled !== true) throw fail("AUTOMATIC_EXECUTION_DISABLED");
    if (policy.version !== local.policy_version) throw fail("VM_PMO_POLICY_CHANGED");
    const queued = await service.orchestrator.retryFailedRender(run.runId,{beforeCommit:() => {
      assertTaskVersion();
      if (automaticCancellationEpoch !== cancellationEpoch) throw fail("AUTOMATIC_EXECUTION_DISABLED");
    }});
    void service.orchestrator.pump(run.runId).finally(releaseTerminalSlots).catch(() => {});
    return publicRun(queued);
  }

  /** Rerun the stage that hit the step timeout, from the same frozen input/plan. */
  async function retryStepTimeout(taskId, request) {
    await ready();
    if (!object(request) || Object.keys(request).length !== 1
      || !Number.isSafeInteger(request.version) || request.version < 1)
      throw fail("VM_PMO_RETRY_VERSION_REQUIRED", 400);
    const assertTaskVersion = () => {
      if (database.getTask(taskId)?.version !== request.version) throw fail("VERSION_CONFLICT", 409);
    };
    assertTaskVersion();
    const service = initialize(), run = service.orchestrator.getForTask(taskId);
    if (!run || run.identity.packageSnapshot.workflowTemplate.id !== TEMPLATE.id
      || run.identity.packageSnapshot.workflowTemplate.version !== TEMPLATE.version)
      throw fail("VM_PMO_RUN_NOT_FOUND", 404);
    const cancellationEpoch = automaticCancellationEpoch;
    const policy = await getPolicy(), local = service.metadata(taskId);
    if (automaticCancellationEpoch !== cancellationEpoch) throw fail("AUTOMATIC_EXECUTION_DISABLED");
    // Rerunning spends the shared editing slot, so the local switch still gates it.
    if (policy?.enabled !== true) throw fail("AUTOMATIC_EXECUTION_DISABLED");
    if (policy.version !== local.policy_version) throw fail("VM_PMO_POLICY_CHANGED");
    const queued = await service.orchestrator.retryStepTimeout(run.runId, { beforeCommit: () => {
      assertTaskVersion();
      if (automaticCancellationEpoch !== cancellationEpoch) throw fail("AUTOMATIC_EXECUTION_DISABLED");
    } });
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

  const manualSourceWork = new Map();
  const manualSlot = eventId => `e${digest(eventId).slice(0,32)}`;
  function manualFailureCode(error) {
    return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,100}$/u.test(error.code)
      ? error.code : "VM_MANUAL_SOURCE_FAILED";
  }
  async function writeDownloadFailed(run,slot,{notify = false} = {}) {
    const service = initialize();
    try {await enqueueWritebackFor(run,"download_failed",slot);} catch {}
    if (!notify) return;
    const current = service.orchestrator.get(run.runId) ?? run;
    const task = database.getTask(current.taskId), origin = database.getFeishuTaskOrigin(current.taskId);
    const subject = origin && database.getFeishuSubjectVersion(origin.subjectKey, origin.configVersion);
    const notification = describeVmPmoAttention({run: current,task,origin,subject});
    if (notification) {
      try {await (await getDownloads()).notifyWorkflowBlocked({...notification,eventKey: `${notification.eventKey}:${slot}`});}
      catch {}
    }
  }
  function enqueueWritebackFor(run,moment,slot) {
    return initialize().enqueueWriteback(run,moment,slot);
  }

  /** Copies the operator's VMID.mp4 into run-owned storage and verifies it like a VM download. */
  async function acquireManualSource(run) {
    const downloads = await getDownloads();
    const outputRoot = downloads?.snapshot?.()?.settings?.outputRoot;
    if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot)) throw fail("VM_MANUAL_SOURCE_UNAVAILABLE");
    const folder = path.join(outputRoot,MANUAL_SOURCE_FOLDER);
    let entries;
    try {entries = await readdir(folder,{withFileTypes: true});}
    catch {throw fail("VM_MANUAL_SOURCE_MISSING");}
    const expected = `${run.binding.vmid}.mp4`;
    const matches = entries.filter(entry => entry.name.toLowerCase() === expected);
    if (matches.length > 1) throw fail("VM_MANUAL_SOURCE_AMBIGUOUS");
    if (matches.length !== 1 || !matches[0].isFile()) throw fail("VM_MANUAL_SOURCE_MISSING");
    const {applicationId,instanceCode} = run.downloadFailure;
    const result = await prepareVmSource({schema_version: 1,vmid: run.binding.vmid,source: {
      kind: "approved_file",approval_ref: applicationId,video_variant: "approved_rendition",
      expected_resolution: {...MANUAL_SOURCE_RESOLUTION},file: path.join(folder,matches[0].name)}},
    {outputRoot: path.join(runRoot,"manual-sources",run.runId),ffprobePath,ffmpegPath});
    if (result?.status !== "ready" || typeof result.receipt_path !== "string") throw fail("MEDIA_VALIDATION_FAILED");
    const verified = await verifyVmAcquisitionReceipt(result.receipt_path,{vmid: run.binding.vmid,
      applicationId,instanceCode,allowOperatorReceipt: true});
    return {...verified,vmid: run.binding.vmid};
  }

  async function processManualSource(runId) {
    if (manualSourceWork.has(runId)) return manualSourceWork.get(runId);
    const work = (async () => {
      const service = initialize();
      const run = service.orchestrator.get(runId);
      if (run?.manualSource?.state !== "pending") return;
      const {eventId} = run.manualSource;
      let acquisition;
      try {acquisition = await acquireManualSource(run);}
      catch (error) {
        const failed = service.orchestrator.completeManualSource(runId,{eventId,failureCode: manualFailureCode(error)});
        await writeDownloadFailed(failed,manualSlot(eventId),{notify: true});
        return;
      }
      service.orchestrator.completeManualSource(runId,{eventId,acquisition});
      void service.orchestrator.pump(runId).finally(releaseTerminalSlots).catch(() => {});
    })().finally(() => manualSourceWork.delete(runId));
    manualSourceWork.set(runId,work);
    return work;
  }

  /** Bridge delivers "下载失败 → 素材已就绪" here; the source itself is verified in the background. */
  async function submitManualSource(body) {
    await ready();
    const event = body?.event, binding = body?.binding;
    const keys = ["eventId","baseToken","tableId","recordId","statusFieldId","beforeOptionId","afterOptionId"];
    if (!object(body) || Object.keys(body).length !== 2 || !object(event) || !object(binding)
      || Object.keys(event).length !== keys.length || keys.some(key => typeof event[key] !== "string")
      || !EVENT_ID.test(event.eventId) || keys.slice(1).some(key => !ID.test(event[key]))
      || Object.keys(binding).length !== 2 || binding.subjectKey !== `${event.baseToken}:${event.tableId}`
      || !Number.isSafeInteger(binding.configVersion) || binding.configVersion < 1)
      throw fail("VM_MANUAL_SOURCE_INPUT_INVALID",400);
    const service = initialize();
    const sameRecord = run => run.identity.origin.stageId === "initial"
      && run.identity.origin.baseToken === event.baseToken && run.identity.origin.tableId === event.tableId
      && run.identity.origin.recordId === event.recordId && run.identity.origin.subjectKey === binding.subjectKey;
    const runs = service.orchestrator.list().filter(sameRecord);
    const replay = runs.find(run => run.manualSource?.eventId === event.eventId);
    if (replay) return {state: replay.manualSource.state === "failed" ? "rejected" : "accepted",taskId: replay.taskId};
    const run = runs.filter(entry => entry.state === "blocked" && entry.errorCode === "VM_DOWNLOAD_FAILED")
      .sort((left,right) => right.createdAt - left.createdAt)[0];
    const task = run && database.getTask(run.taskId);
    if (!run || !task || task.archivedAt !== null) return {state: "ignored"};
    const subject = service.metadata(run.taskId).subject, edges = materialEdgesFor(subject);
    const stage = subject.vmWorkflow.stages.initial;
    const latest = service.latestStageOrigin({baseToken: event.baseToken,tableId: event.tableId,recordId: event.recordId,
      subjectKey: binding.subjectKey,fieldId: run.identity.outputAttachmentFieldId,
      packageAlias: run.identity.origin.packageAlias});
    if (!edges.materialsReady || !edges.downloadFailed || stage.statusFieldId !== event.statusFieldId
      || stage.writeback.downloadFailed.optionId !== event.beforeOptionId
      || stage.writeback.materialsReady.optionId !== event.afterOptionId || latest?.taskId !== run.taskId)
      return {state: "ignored"};
    if (run.manualSource?.state === "pending") return {state: "ignored",taskId: run.taskId};
    if (run.downloadFailure?.approved !== true) {
      // The status moved without an approved application: restore "下载失败" and explain why.
      await writeDownloadFailed(run,manualSlot(event.eventId),{notify: true});
      return {state: "rejected",taskId: run.taskId};
    }
    service.orchestrator.requestManualSource(run.runId,{eventId: event.eventId});
    void processManualSource(run.runId).catch(() => {});
    return {state: "accepted",taskId: run.taskId};
  }

  /** Restores material writebacks and pending operator sources that a restart interrupted. */
  async function recoverMaterialWork() {
    const service = initialize();
    for (const run of service.orchestrator.list()) {
      if (run.identity.origin.stageId !== "initial") continue;
      let edges;
      try {edges = materialEdgesFor(service.metadata(run.taskId).subject);} catch {continue;}
      if (run.state === "blocked" && run.errorCode === "VM_DOWNLOAD_FAILED") {
        if (run.manualSource?.state === "pending") void processManualSource(run.runId).catch(() => {});
        else if (edges.downloadFailed) await writeDownloadFailed(run,
          run.manualSource?.state === "failed" ? manualSlot(run.manualSource.eventId) : "auto");
      } else if (edges.materialsReady && run.acquisition?.vmid_binding === "vm_api_verified"
        && ["ready","preparing","prepared","planning","planned"].includes(run.state)) {
        try {await enqueueWritebackFor(run,"materials_ready",null);} catch {}
      }
    }
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
    automaticCancellationEpoch++;
    if (!services) return;
    for (const run of services.orchestrator.list()) {
      const pendingRenderRetry = Boolean(run.renderRetryHistory?.length
        && !run.renderRetryLaunchAt && !run.renderRetryStartedAt);
      if (run.runnerStartedAt && !pendingRenderRetry || TERMINAL.has(run.state)) continue;
      if (pendingRenderRetry) {
        const stored = db.prepare("SELECT payload_json FROM vm_pmo_runs WHERE run_id = ?").get(run.runId);
        if (!stored) continue;
        const restored = JSON.parse(stored.payload_json);
        delete restored.renderRetryHistory;
        delete restored.renderRetryLaunchAt;
        delete restored.renderRetryStartedAt;
        const changed = db.prepare(`UPDATE vm_pmo_runs SET state = 'needs_attention',
          error_code = 'VM_PMO_START_EVIDENCE_FAILED',payload_json = ?,lease_token = NULL,
          lease_until = NULL,updated_at = ? WHERE run_id = ? AND payload_json = ?
          AND state NOT IN ('completed','blocked','needs_attention')`)
          .run(JSON.stringify(restored),now(),run.runId,stored.payload_json);
        if (changed.changes === 1) {
          cancelSlot(run.runId);
          void notifyAttention({run: services.orchestrator.get(run.runId)}).catch(() => {});
        }
        continue;
      }
      const changed = db.prepare(`UPDATE vm_pmo_runs SET state = 'blocked',error_code = 'AUTOMATIC_EXECUTION_DISABLED',
        lease_token = NULL,lease_until = NULL,updated_at = ? WHERE run_id = ?
        AND state NOT IN ('completed','blocked','needs_attention')
        AND (json_extract(payload_json,'$.runnerStartedAt') IS NULL
          OR json_array_length(json_extract(payload_json,'$.renderRetryHistory')) > 0
            AND json_extract(payload_json,'$.renderRetryLaunchAt') IS NULL
            AND json_extract(payload_json,'$.renderRetryStartedAt') IS NULL)`)
        .run(now(),run.runId);
      if (changed.changes === 1) {
        cancelSlot(run.runId);
        void notifyAttention({run: services.orchestrator.get(run.runId)}).catch(() => {});
      }
    }
    releaseTerminalSlots();
  }
  return Object.freeze({ready,validateVmPackage,validateActivation,register,wake,cancelPendingAutomatic,
    getTaskRun,getTaskAiTranscript,retryApproval,retryManualRevision,retryPlanning,retryValidatedPlan,retryFailedRender,
    retryStepTimeout,retryWriteback,
    retryAiIntent,retryQa,
    resumeDownloadedSource,
    submitManualSource,
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
          await recoverMaterialWork().catch(() => {});
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
