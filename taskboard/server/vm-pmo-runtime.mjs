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
import { validateVmPmoInput, validateVmPmoPlan, validateVmPmoRender } from "./vm-pmo-result-validator.mjs";
import { createVmMp4DeliveryService } from "./vm-mp4-delivery.mjs";
import { createVmStageWriteback } from "./vm-stage-writeback.mjs";
import { createVmWritebackStore } from "./vm-writeback-store.mjs";
import { createFeishuWritebackWorker } from "./feishu-writeback-worker.mjs";

const TEMPLATE = Object.freeze({id: "vm_pmo_review_video",version: 1});
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set(["completed","blocked","needs_attention"]);
const ACTOR = Object.freeze({type: "agent",id: "vm-pmo-runtime",name: "VM 初稿剪辑",avatarUrl: null});
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a,b) => canonicalJson(a) === canonicalJson(b);
const fail = (code,status = 409) => new ApiError(status,code,code);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const template = value => value?.id === TEMPLATE.id && value.version === 1;

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
  const stage = config?.stages?.initial;
  if (!object(config) || !object(stage) || stage.enabled !== true || config.stages.review?.enabled !== false
    || config.finalArchive?.enabled !== false || !Array.isArray(fields)
    || ![config.fields?.vmidFieldId,config.fields?.namingFieldId,config.fields?.outputAttachmentFieldId,
      stage.statusFieldId,stage.triggerOptionId,stage.instructionFieldId].every(value => typeof value === "string" && ID.test(value))
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
  field(config.fields.outputAttachmentFieldId,[17]);field(stage.instructionFieldId,[1]);
  option(stage.statusFieldId,stage.triggerOptionId);
  for (const moment of ["processing","completed"]) {
    const binding = stage.writeback?.[moment];
    if (!binding || !ID.test(binding.fieldId ?? "") || !ID.test(binding.optionId ?? "")) throw fail("VM_WORKFLOW_NOT_READY");
    option(binding.fieldId,binding.optionId);
  }
  return config;
}

/** The runtime owns executable paths, policy, immutable input evidence and remote effects.
 * Neither the registration body nor PMO record may choose an executable or a workspace.
 * Local readiness never initializes the approval queue, a remote adapter, or run directories. */
export function createVmPmoRuntime({database,getPackage,getActiveSubject,getDownloads,getAdapter,getPolicy,
  scheduler,dispatchWriteback,onTaskUpdated = () => {},runRoot,pythonPath,
  ffprobePath = "ffprobe",ffmpegPath = "ffmpeg",tickMs = 5_000,now = Date.now} = {}) {
  const db = database?.database;
  let services, closed = false, timer, draining;
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
        || typeof manifest.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(manifest.name)
        || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version))
        throw new Error("manifest invalid");
      let runnerFound = false;
      for (const runner of [path.join(record.workspacePath,"auto_cut_slicing","vm_pmo.py"),
        path.join(record.workspacePath,"auto_cut_slicing","vm_pmo","__main__.py")]) {
        try {await canonicalLocation(runner);runnerFound = true;break;} catch {}
      }
      if (!runnerFound) throw new Error("runner unavailable");
      return {name: manifest.name,version: manifest.version,manifestSha256: digest(bytes)};
    } catch {throw fail("VM_PMO_PACKAGE_NOT_READY");}
  }
  async function validateVmPackage(record) {await ready();await inspectPackage(record);return true;}
  async function validateActivation({subject,packageAlias,config} = {}) {
    await ready();
    const record = await getPackage(packageAlias);
    if (record?.state !== "enabled" || record.alias !== packageAlias) throw fail("PACKAGE_DISABLED");
    await inspectPackage(record);initialProfile(subject,config);
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
    const approval = Object.fromEntries(["lookup","enqueue","wake"].map(method => [method,async input => {
      const adapter = createVmTaskDownloadAdapter(await getDownloads());
      return adapter[method](input);
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
      return {...run,productionOrigin: true,stageId: "initial",subjectKey: origin.subjectKey,configVersion: origin.configVersion,target};
    }
    async function boundFor(options) {
      const local = db.prepare("SELECT * FROM vm_pmo_runtime_bindings WHERE context_path = ?").get(options.contextPath);
      if (!local?.bound_json || digest(local.bound_json) !== local.bound_sha256) throw fail("VM_PMO_INPUT_CHANGED");
      let bound;
      try {bound = JSON.parse(local.bound_json);} catch {throw fail("VM_PMO_INPUT_CHANGED");}
      if (bound.context?.input_sha256 !== local.input_sha256
        || bound.input?.binding?.task_id !== local.task_id || bound.input?.binding?.run_id !== local.run_id)
        throw fail("VM_PMO_INPUT_CHANGED");
      try {return await validateVmPmoInput({...options,expectedBound: bound});}
      catch {throw fail("VM_PMO_INPUT_CHANGED");}
    }
    delivery = createVmMp4DeliveryService({database,adapter: localAdapter,now,resolveTrustedDelivery: async ({runId,artifactId}) => {
      const run = trustedRun(runId), row = db.prepare("SELECT * FROM vm_pmo_artifacts WHERE id = ?").get(artifactId);
      if (!row || row.run_id !== runId || row.task_id !== run.taskId || digest(row.artifact_json) !== row.artifact_sha256
        || run.artifactId !== artifactId) throw fail("VM_DELIVERY_UNTRUSTED");
      await boundFor(run.prepared.runnerOptions);
      let artifact;
      try {artifact = JSON.parse(row.artifact_json);} catch {throw fail("VM_DELIVERY_UNTRUSTED");}
      return {runId,taskId: run.taskId,artifactId,productionOrigin: true,artifact,
        target: {...run.target,fieldId: run.identity.outputAttachmentFieldId}};
    }});
    // Each run has its own frozen subject. A task from a later version must never redirect an earlier run.
    async function planWriteback(runId,moment) {
      const run = trustedRun(runId), frozen = metadata(run.taskId).subject;
      const planner = createVmStageWriteback({resolveTrustedRun: () => trustedRun(runId),getActiveSubject: () => structuredClone(frozen),
        listFields: localAdapter.listFields,getDelivery: () => delivery.get(runId),enqueueWritebackIntent: input => writebackStore.enqueueWritebackIntent(input)});
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
        if (!same(await inspectPackage(record),local.packageIdentity)) throw fail("VM_PMO_PACKAGE_CHANGED");
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
      prepareInput: async ({run,acquisition}) => {
        const origin = database.getFeishuTaskOrigin(run.taskId), local = metadata(run.taskId);
        const record = normalizeVmRecordContext(await readCurrentRecord({subject: local.subject,event: origin}),
          {expectedStatusOptionId: origin.afterOptionId});
        if (!same(record,origin.stageSnapshot?.vmContext)) throw fail("VM_PMO_RECORD_CHANGED");
        const prepared = await prepareVmPmoRunInput({runRoot,runId: run.runId,taskId: run.taskId,origin,
          profile: local.subject.vmWorkflow,packageSnapshot: database.getFeishuTaskPackageSnapshot(run.taskId),
          packageIdentity: local.packageIdentity,acquisition,pythonPath});
        const bound = await validateVmPmoInput({contextPath: prepared.contextPath});
        const value = canonicalJson(bound);
        db.prepare(`UPDATE vm_pmo_runtime_bindings SET context_path = ?,input_sha256 = ?,bound_json = ?,bound_sha256 = ?
          WHERE task_id = ? AND run_id = ? AND (bound_json IS NULL OR bound_json = ?)`)
          .run(prepared.contextPath,prepared.inputSha256,value,digest(value),run.taskId,run.runId,value);
        const saved = metadata(run.taskId);
        if (saved.bound_json !== value) throw fail("VM_PMO_INPUT_CHANGED");
        return prepared;
      },
      runOffline: async options => {
        const bound = await boundFor(options);
        const result = await runVmPmoOffline({...options,ffprobePath,ffmpegPath,expectedBound: bound});
        await validateVmPmoInput({...options,expectedBound: bound});
        return result;
      },
      recoverOffline: async options => {
        const bound = await boundFor(options);
        const receipt = options.mode === "plan" ? bound.context.plan_result_path : bound.context.result_path;
        try {await lstat(receipt);} catch (error) {if (error?.code === "ENOENT") return null;throw fail("VM_PMO_RUN_OUTCOME_UNKNOWN");}
        return options.mode === "plan" ? validateVmPmoPlan({...options,ffprobePath,expectedBound: bound})
          : validateVmPmoRender({...options,ffprobePath,ffmpegPath,expectedBound: bound});
      },
      registerArtifact: async ({run,prepared,result}) => {
        trustedRun(run.runId);
        const bound = await boundFor(prepared.runnerOptions);
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
    services = {orchestrator,delivery,writebackStore,writebackWorker,metadata,
      registration: createVmTaskRegistration({database,getPackage,getActiveSubject,readCurrentRecord,
        prepareCommit: async ({subject,packageRecord,origin}) => {
          if (origin.executionMode !== "automatic") return null;
          const policy = await getPolicy();
          if (policy?.enabled !== true) return null;
          if (!Number.isSafeInteger(policy.version) || policy.version < 1) throw fail("VM_PMO_POLICY_CHANGED");
          initialProfile(subject,subject?.vmWorkflow);
          const identity = await inspectPackage(packageRecord);
          const frozenSubject = canonicalJson(subject), frozenIdentity = canonicalJson(identity);
          return ({taskId}) => db.prepare(`INSERT INTO vm_pmo_runtime_bindings(task_id,policy_version,package_identity_json,subject_json)
            VALUES(?,?,?,?)`).run(taskId,policy.version,frozenIdentity,frozenSubject);
        },
      })};
    return services;
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
  async function wake() {
    if (closed) return;
    await ready();const service = initialize();
    draining ??= (async () => {
      try {await service.orchestrator.wake();} finally {releaseTerminalSlots();}
      for (let count = 0;count < 10 && !closed;count++) {if (!await service.delivery.processNext()) break;}
      try {await service.orchestrator.wake();} finally {releaseTerminalSlots();}
      await service.writebackWorker.wake();
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
    list: () => services?.orchestrator.list() ?? [],
    resolveWriteback: async claim => {await ready();return initialize().writebackStore.resolveWritebackIntentForBridge(claim);},
    async start() {
      await ready();initialize();
      if (!timer) {timer = setInterval(() => {void wake().catch(() => {});},tickMs);timer.unref?.();}
      void wake().catch(() => {});
    },
    async close() {
      if (closed) return;closed = true;clearInterval(timer);
      for (const runId of pendingSlots.keys()) cancelSlot(runId);
      await services?.orchestrator.close();await draining;await services?.writebackWorker.close();
    },
  });
}
