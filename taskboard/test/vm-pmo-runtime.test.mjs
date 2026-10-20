import assert from "node:assert/strict";
import { test } from "node:test";
import { createVmPmoRuntime } from "../server/vm-pmo-runtime.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";
import { createVmApprovalStore } from "../server/vm-approval-store.mjs";
import { enqueueVmApproval, summarizeVmApproval, validateVmApprovalRequest,
  vmApprovalJobIdForTaskRun } from "../server/vm-approval-workflow.mjs";
import { createResourceScheduler } from "../server/resource-scheduler.mjs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const TEMPLATE = { id: "vm_pmo_review_video", version: 1 };
const VMID = "5dd7753a4723ba416403cbad";
const ACTOR = { type: "agent", id: "bridge", name: "Feishu Bridge", avatarUrl: null };
const runCommand = promisify(execFile);
let PYTHON;
try { PYTHON = execFileSync("python",["-c","import sys; print(sys.executable)"],{encoding: "utf8"}).trim(); }
catch { /* Python-dependent composition case skips when unavailable. */ }

async function fixture(t, { enabled = true, alias = "slicing", finalArchive = false, privateEndpoints = [], contractVersion = 2 } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-runtime-")));
  const archiveDirectory = path.join(directory,"archive");
  if (finalArchive) await mkdir(archiveDirectory);
  const packageRoot = path.join(directory, "package");
  await mkdir(path.join(packageRoot, "auto_cut_slicing"), { recursive: true });
  await writeFile(path.join(packageRoot, "auto_cut_slicing", "vm_pmo.py"), "# trusted runner fixture");
  await writeFile(path.join(packageRoot, "PACKAGE-MANIFEST.json"), JSON.stringify({ name: "auto-cut-slicing", version: "0.2.1",
    interface: {workflowTemplate: TEMPLATE,contract: {id: TEMPLATE.id,version: contractVersion},
      driverId: `vm_pmo_review_video_v${contractVersion}`,artifactKind: "review_mp4"} }));
  const pythonPath = path.join(directory, "python.exe");
  await writeFile(pythonPath, "local runtime fixture");
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const approvals = createVmApprovalStore({ file: path.join(directory, "approvals.sqlite") });
  const options = [{id: "opt_other",name: "准备"},{id: "opt_initial",name: "待剪辑"},
    {id: "opt_processing",name: "处理中"},{id: "opt_complete",name: "完成"},
    ...(finalArchive ? [{id: "opt_archive",name: "待归档"}] : [])];
  const fields = [{fieldId: "fld_status",fieldName: "制作进度",type: 3,uiType: "SingleSelect",options},
    {fieldId: "fld_vmid",fieldName: "原视频vmid",type: 1,uiType: "Text"},
    {fieldId: "fld_name",fieldName: "名称",type: 1,uiType: "Text"},
    {fieldId: "fld_instruction",fieldName: "初稿意见",type: 1,uiType: "Text"},
    {fieldId: "fld_output",fieldName: "成片",type: 17,uiType: "Attachment"}];
  const subject = {subjectKey: "bas_vm:tbl_vm",baseToken: "bas_vm",tableId: "tbl_vm",tableName: "VM 测试",
    lifecycle: "enabled",configVersion: 4,enabledAt: 100,closedAt: null,workflowTemplate: TEMPLATE,
    packageRoute: {packageAlias: alias},execution: {mode: "automatic"},metadata: {fields},
    statusField: {fieldId: "fld_status",type: "single_select",options: options.map(o => ({optionId: o.id,name: o.name}))},
    vmWorkflow: {fields: {vmidFieldId: "fld_vmid",namingFieldId: "fld_name",outputAttachmentFieldId: "fld_output"},
      approval: {department: "动画组",reason: "切片剪辑"},stages: {initial: {enabled: true,statusFieldId: "fld_status",
        triggerOptionId: "opt_initial",instructionFieldId: "fld_instruction",writeback: {
          processing: {fieldId: "fld_status",optionId: "opt_processing"},completed: {fieldId: "fld_status",optionId: "opt_complete"}}},
      review: {enabled: false}},finalArchive: finalArchive
        ? {enabled: true,statusFieldId: "fld_status",triggerOptionId: "opt_archive",pathSource: "manual",
          directoryPath: archiveDirectory,pathFieldId: null}
        : {enabled: false}}};
  const record = {fields: {fld_status: "待剪辑",fld_vmid: VMID,fld_name: "化学变化中微粒怎么变？",fld_instruction: "0:00-0:20"}};
  const packageRecord = {alias,state: "enabled",revision: 2,workflowTemplate: TEMPLATE,workspacePath: packageRoot,
    prompt: "trusted local prompt",maxConcurrent: 1,resourceGroups: ["vm-render"]};
  database.createProject({id: subjectProjectId(subject.subjectKey),name: "VM 测试",workspacePath: directory});
  database.getFeishuSubjectVersion = () => structuredClone(subject);
  let policy = {enabled,version: 1}, connects = 0, downloadReads = 0, policyFailure;
  const downloadInput = input => validateVmApprovalRequest({schema_version: 1,vmid: input.vmid,department: input.department,
    reason: input.reason,output_root: input.outputRoot,allowed_origins: ["https://vm-resource.yangcong345.com"],
    private_endpoints: structuredClone(privateEndpoints)});
  const downloads = {requestFor: downloadInput,snapshot: () => ({settings: {outputRoot: directory}}),
    lookupExact: ({jobId,requestFingerprint}) => { const job = jobId ? approvals.get(jobId)
      : approvals.list().find(j => j.request_fingerprint === requestFingerprint);
      return job?.request_fingerprint === requestFingerprint ? {...summarizeVmApproval(job,{includeLocalRequest: true}),
        requestFingerprint: job.request_fingerprint} : null; },
    lookupTaskRun: ({jobId}) => { const job = approvals.get(jobId);
      return job ? {...summarizeVmApproval(job,{includeLocalRequest: true}),requestFingerprint: job.request_fingerprint,
        request: structuredClone(job.request)} : null; },
    enqueueForTask: (input,scope) => ({jobs: [summarizeVmApproval(enqueueVmApproval(approvals,
      downloadInput({...input,vmid: input.vmids[0]}), {id: vmApprovalJobIdForTaskRun(scope.taskId,scope.runId),
        dedupeByRequest: false}), {includeLocalRequest: true})]}),wake: async () => {}};
  const scheduler = createResourceScheduler();
  const args = {database,getPackage: async () => structuredClone(packageRecord),getActiveSubject: async () => structuredClone(subject),
    getDownloads: () => {downloadReads++;return downloads;},getAdapter: async () => {connects++;return {
      listFields: async () => structuredClone(fields),getRecord: async () => structuredClone(record),
      updateRecord: async () => {throw new Error("unexpected update");},uploadMedia: async () => {throw new Error("unexpected upload");}};},
    getPolicy: () => {if (policyFailure) {const error = policyFailure;policyFailure = null;throw error;}return policy;},
    scheduler,dispatchWriteback: async () => {},runRoot: path.join(directory,"runs"),pythonPath,
    coursePathResolver: {classifyDrive: async () => "local"}};
  let runtime = createVmPmoRuntime(args);
  const body = {event: {eventId: "evt_vm",baseToken: "bas_vm",tableId: "tbl_vm",recordId: "rec_vm",
    statusFieldId: "fld_status",beforeOptionId: "opt_other",afterOptionId: "opt_initial",occurredAt: 200},
    binding: {subjectKey: "bas_vm:tbl_vm",configVersion: 4,stageId: "initial"}};
  t.after(async () => {await runtime.close();approvals.close();database.close();await rm(directory,{recursive: true,force: true});});
  return {directory,args,database,approvals,subject,record,packageRecord,scheduler,body,
    get runtime() {return runtime;},get connects() {return connects;},get downloadReads() {return downloadReads;},
    setPolicy(value) {policy = value;},failNextPolicy() {policyFailure = new Error("temporary local policy failure");},
    setPrivateEndpoints(value) {privateEndpoints = structuredClone(value);},
    async restart() {await runtime.close();runtime = createVmPmoRuntime(args);},
    async markReady({sourceBytes = Buffer.from("source"),durationMs = 25000} = {}) {
      const job = approvals.list()[0], claim = approvals.claim(job.id);
      const source = path.join(directory,"source.mp4"), receipt = path.join(directory,"receipt.json");
      await writeFile(source,sourceBytes);
      const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
      await writeFile(receipt,JSON.stringify({protocol: "vm_source_acquisition",schema_version: 1,status: "ready",vmid: VMID,
        artifact: {path: source,sha256,bytes: sourceBytes.length,media: {duration_ms: durationMs,video: [{width: 1280,height: 720}],validation: {metadata: true,full_decode: true}}},
        provenance: {kind: "vm_api_approval",vmid_binding: "vm_api_verified",resource_id: VMID,approval_status: "APPROVED",
          video_quality: "HIGH",approval_ref: "app_vm",instance_code: "instance_vm"}}));
      claim.job.status = "ready";claim.job.application_id = "app_vm";claim.job.instance_code = "instance_vm";
      claim.job.acquisition = {receipt_path: receipt,path: source,sha256,bytes: sourceBytes.length,duration_ms: durationMs,vmid_binding: "vm_api_verified"};
      approvals.save(job.id,claim.leaseToken,claim.job);
    }};
}

test("VM runtime cannot start or create a task with missing local runtime binding", async t => {
  const database = new TaskboardDatabase(":memory:");
  t.after(() => database.close());
  const runtime = createVmPmoRuntime({database,getPackage: async () => null,getActiveSubject: async () => null,
    getDownloads: () => { throw new Error("must not initialize downloads"); },getAdapter: async () => { throw new Error("must not connect"); },
    getPolicy: () => ({enabled: false,version: 1}),scheduler: {},dispatchWriteback: async () => {},
    runRoot: "relative",pythonPath: null});
  t.after(() => runtime.close());
  await assert.rejects(runtime.ready(), {code: "VM_PMO_RUNTIME_UNAVAILABLE"});
  await assert.rejects(runtime.register({}, {}), {code: "VM_PMO_RUNTIME_UNAVAILABLE"});
  assert.deepEqual(runtime.list(), []);
});

test("policy preparation failures leave no task and replay can atomically reserve the automatic run", async t => {
  const f = await fixture(t);f.failNextPolicy();
  await assert.rejects(f.runtime.register(f.body,ACTOR), /temporary local policy failure/u);
  assert.equal(f.database.findFeishuTaskByEventId(f.body.event.eventId),null);
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS total FROM vm_pmo_runtime_bindings").get().total,0);
  const replay = await f.runtime.register(f.body,ACTOR);await f.runtime.wake();
  assert.equal(replay.created,true);assert.equal(f.runtime.list().length,1);
  assert.equal(f.approvals.list().length,1);
});

test("binding persistence failure rolls back trusted task creation and replay retains exactly one intent", async t => {
  const f = await fixture(t);await f.runtime.start();
  f.database.database.exec(`CREATE TEMP TRIGGER vm_binding_failure BEFORE INSERT ON vm_pmo_runtime_bindings
    BEGIN SELECT RAISE(ABORT,'binding temporarily unavailable'); END`);
  await assert.rejects(f.runtime.register(f.body,ACTOR), /binding temporarily unavailable/u);
  assert.equal(f.database.findFeishuTaskByEventId(f.body.event.eventId),null);
  f.database.database.exec("DROP TRIGGER vm_binding_failure");
  const replay = await f.runtime.register(f.body,ACTOR);await f.runtime.wake();
  assert.equal(replay.created,true);assert.equal(f.runtime.list().length,1);
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS total FROM vm_pmo_runtime_bindings").get().total,1);
});

test("immediate policy cancellation survives closing and reopening before the next worker tick", async t => {
  const f = await fixture(t);await f.runtime.register(f.body,ACTOR);await f.runtime.wake();
  f.setPolicy({enabled: false,version: 2});await f.runtime.cancelPendingAutomatic();
  f.setPolicy({enabled: true,version: 3});await f.restart();await f.runtime.start();await f.runtime.wake();
  assert.equal(f.runtime.list()[0].state,"blocked");
  assert.equal(f.runtime.list()[0].errorCode,"AUTOMATIC_EXECUTION_DISABLED");
  assert.equal(f.approvals.list().length,1);
});

test("a policy version changed while Taskboard was stopped blocks the previous automatic reservation", async t => {
  const f = await fixture(t);await f.runtime.register(f.body,ACTOR);await f.runtime.wake();await f.restart();
  f.setPolicy({enabled: true,version: 3});await f.runtime.start();await f.runtime.wake();
  assert.equal(f.runtime.list()[0].state,"blocked");assert.equal(f.runtime.list()[0].errorCode,"VM_PMO_POLICY_CHANGED");
});

test("startup recovers a binding-conflict run only after its original approved receipt is ready", async t => {
  const oldPrivateEndpoint = {origin: "https://vm-resource.yangcong345.com",addresses: ["10.8.8.10"]};
  const currentPrivateEndpoint = {origin: "https://vm-resource.yangcong345.com",addresses: ["10.8.8.11"]};
  const f = await fixture(t,{privateEndpoints: [oldPrivateEndpoint]});
  await f.runtime.register(f.body,ACTOR);
  const [registered] = f.runtime.list();
  const approvalJobId = vmApprovalJobIdForTaskRun(registered.taskId,registered.runId);
  const request = validateVmApprovalRequest({schema_version: 1,vmid: VMID,department: "动画组",reason: "切片剪辑",
    output_root: f.directory,allowed_origins: ["https://vm-resource.yangcong345.com"],
    private_endpoints: [currentPrivateEndpoint]});
  enqueueVmApproval(f.approvals,request,{id: approvalJobId,dedupeByRequest: false});
  f.setPrivateEndpoints([currentPrivateEndpoint]);
  f.database.database.prepare("UPDATE vm_task_download_bindings SET approval_job_id = ? WHERE task_id = ?")
    .run(approvalJobId,registered.taskId);
  const row = f.database.database.prepare("SELECT payload_json FROM vm_pmo_runs WHERE run_id = ?").get(registered.runId);
  const payload = JSON.parse(row.payload_json);
  payload.binding.approvalJobId = approvalJobId;
  f.database.database.prepare(`UPDATE vm_pmo_runs SET state = 'needs_attention',
    error_code = 'VM_TASK_BINDING_CONFLICT',attempt_count = 8,payload_json = ? WHERE run_id = ?`)
    .run(JSON.stringify(payload),registered.runId);
  await f.markReady();
  const hold = await f.scheduler.request({requestId: "recovery-hold",concurrencyGroup: "autocut:slicing",
    maxConcurrent: 1,resourceGroups: ["vm-render"],queuePolicy: "per-group",fixedMaxConcurrent: true});
  t.after(() => hold.release());

  await f.restart();
  await f.runtime.start();
  await f.runtime.wake();

  const [recovered] = f.runtime.list();
  assert.equal(recovered.runId,registered.runId);
  assert.equal(recovered.state,"prepared",recovered.errorCode);
  assert.equal(recovered.approvalStatus,"ready");
  assert.equal(f.approvals.list().length,1);
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS total FROM vm_pmo_artifacts").get().total,0);
});

test("canceling pending reservations preserves a render with persisted start evidence", async t => {
  const f = await fixture(t);await f.runtime.register(f.body,ACTOR);
  const [run] = f.runtime.list(), row = f.database.database.prepare("SELECT payload_json FROM vm_pmo_runs WHERE run_id = ?").get(run.runId);
  const payload = {...JSON.parse(row.payload_json),runnerStartedAt: new Date().toISOString()};
  f.database.database.prepare("UPDATE vm_pmo_runs SET state = 'rendering',payload_json = ? WHERE run_id = ?")
    .run(JSON.stringify(payload),run.runId);
  f.setPolicy({enabled: false,version: 2});await f.runtime.cancelPendingAutomatic();
  assert.equal(f.runtime.list()[0].state,"rendering");
});

async function preparedWhileBusy(f) {
  const hold = await f.scheduler.request({requestId: "held",concurrencyGroup: `autocut:${f.packageRecord.alias}`,maxConcurrent: 1});
  await f.runtime.register(f.body,ACTOR);await f.runtime.wake();await f.markReady();await f.runtime.wake();
  assert.equal(f.runtime.list()[0].state,"prepared");assert.equal(f.scheduler.snapshot().pendingCount,1);
  return hold;
}

test("package board distinguishes a held scheduler slot from actual editing after restart", async t => {
  const f = await fixture(t), hold = await preparedWhileBusy(f);
  t.after(() => hold.release());
  const scope = {subjectKey:f.subject.subjectKey,packageAlias:f.packageRecord.alias};
  const readsBefore = {downloads:f.downloadReads,adapter:f.connects};
  const schedulerBefore = f.scheduler.snapshot();
  const [queued] = (await f.runtime.getPackageBoard(scope)).tasks;
  assert.equal(queued.state,"prepared");assert.equal(queued.waitingForSlot,true);
  assert.equal(queued.planStartedAt,null);assert.equal(queued.runnerStartedAt,null);
  assert.deepEqual(queued.writeback,{processing:null,completed:null});
  assert.deepEqual(f.scheduler.snapshot(),schedulerBefore);
  assert.deepEqual({downloads:f.downloadReads,adapter:f.connects},readsBefore);
  await f.restart();
  assert.equal((await f.runtime.getPackageBoard(scope)).tasks[0].waitingForSlot,true);
  f.setPolicy({enabled:false,version:2});await f.runtime.wake();
  const [blocked] = (await f.runtime.getPackageBoard(scope)).tasks;
  assert.equal(blocked.state,"blocked");assert.equal(blocked.waitingForSlot,false);
});

test("VM plan retry reuses the ready approval and source while appending a new input attempt", async t => {
  const f = await fixture(t);
  const hold = await preparedWhileBusy(f);
  try {
    const [before] = f.runtime.list();
    const row = f.database.database.prepare("SELECT payload_json FROM vm_pmo_runs WHERE run_id = ?").get(before.runId);
    const payload = {...JSON.parse(row.payload_json),planStartedAt:new Date().toISOString()};
    f.database.database.prepare(`UPDATE vm_pmo_runs SET state='blocked',error_code='WORD_ALIGNMENT_UNRESOLVED',
      payload_json=?,updated_at=? WHERE run_id=?`).run(JSON.stringify(payload),Date.now(),before.runId);
    const task = f.database.getTask(before.taskId);
    assert.equal((await f.runtime.getTaskRun(task.id)).canRetryPlan,true);
    await assert.rejects(f.runtime.retryPlanning(task.id,{version:task.version}),
      {code:"VM_PMO_RETRY_CONSENT_REQUIRED"});

    const queued = await f.runtime.retryPlanning(task.id,{version:task.version,
      runConsent:{allowVideoAudioAsr:true,allowConfiguredLocalOutput:true}});
    await f.runtime.wake();
    const [retried] = f.runtime.list();
    assert.equal(queued.runId,before.runId);
    assert.equal(retried.runId,before.runId);
    assert.equal(retried.planAttempt,2);
    assert.equal(retried.state,"prepared");
    assert.notEqual(retried.prepared.contextPath,before.prepared.contextPath);
    assert.equal(f.database.database.prepare("SELECT COUNT(*) AS total FROM vm_pmo_attempt_inputs WHERE run_id = ?")
      .get(before.runId).total,2);
    assert.equal(f.approvals.list().length,1);
    assert.equal(f.runtime.list()[0].acquisition.sha256,before.acquisition.sha256);
  } finally {
    await f.runtime.close();
    await hold.release();
  }
});

for (const mutationTiming of ["before retry", "during source validation"]) {
  test(`VM plan retry rejects a task version changed ${mutationTiming}`, async t => {
    const f = await fixture(t), hold = await preparedWhileBusy(f);
    try {
      const [before] = f.runtime.list();
      const row = f.database.database.prepare("SELECT payload_json FROM vm_pmo_runs WHERE run_id = ?").get(before.runId);
      const payload = {...JSON.parse(row.payload_json),planStartedAt:new Date().toISOString()};
      f.database.database.prepare(`UPDATE vm_pmo_runs SET state='blocked',error_code='WORD_ALIGNMENT_UNRESOLVED',
        payload_json=? WHERE run_id=?`).run(JSON.stringify(payload),before.runId);
      const task = f.database.getTask(before.taskId);
      const mutate = () => f.database.updateTask(task.id,task.version,{title:"Updated while retrying"},
        undefined,undefined,ACTOR);
      let mutationCount = 0;
      if (mutationTiming === "before retry") {mutate();mutationCount++;}
      else {
        const getDownloads = f.args.getDownloads;
        f.args.getDownloads = () => {
          if (mutationCount++ === 0) mutate();
          return getDownloads();
        };
        await f.restart();
      }
      await assert.rejects(f.runtime.retryPlanning(task.id,{version:task.version,
        runConsent:{allowVideoAudioAsr:true,allowConfiguredLocalOutput:true}}),
      {code:"VERSION_CONFLICT",status:409});
      assert.ok(mutationCount > 0);
      const [after] = f.runtime.list();
      assert.equal(after.state,"blocked");
      assert.equal(after.planAttempt ?? 1,1);
      assert.deepEqual(after.prepared,before.prepared);
      assert.equal(f.database.database.prepare("SELECT COUNT(*) AS total FROM vm_pmo_attempt_inputs WHERE run_id=?")
        .get(before.runId).total,1);
      assert.equal(f.approvals.list().length,1);
    } finally {await f.runtime.close();hold.release();}
  });
}

test("legacy runtime package identities resume unchanged v2 manifests without rewriting binding evidence", async t => {
  const f = await fixture(t);
  await f.runtime.register(f.body,ACTOR);
  await f.runtime.wake();
  const row = f.database.database.prepare("SELECT task_id,package_identity_json FROM vm_pmo_runtime_bindings").get();
  const {contractVersion,driverId,...legacyIdentity} = JSON.parse(row.package_identity_json);
  const legacyValue = JSON.stringify(legacyIdentity);
  f.database.database.prepare("UPDATE vm_pmo_runtime_bindings SET package_identity_json=? WHERE task_id=?")
    .run(legacyValue,row.task_id);
  await f.restart();
  const hold = await f.scheduler.request({requestId:"legacy-hold",concurrencyGroup:"autocut:slicing",maxConcurrent:1});
  try {
    await f.markReady();
    await f.runtime.wake();
    const [run] = f.runtime.list();
    assert.equal(run.state,"prepared",run.errorCode);
    const context = JSON.parse(await readFile(run.prepared.contextPath,"utf8"));
    const input = JSON.parse(await readFile(path.join(context.run_dir,"input.json"),"utf8"));
    assert.equal(input.schema_version,2);
    assert.equal(f.database.database.prepare("SELECT package_identity_json FROM vm_pmo_runtime_bindings WHERE task_id=?")
      .get(row.task_id).package_identity_json,legacyValue);
    assert.equal(f.approvals.list().length,1);
  } finally {await f.runtime.close();hold.release();}
});

test("preparation normalizes VMID and title while preserving the original PMO instruction", async t => {
  const f = await fixture(t);
  f.record.fields.fld_vmid = `  ${VMID}\n`;
  f.record.fields.fld_name = "  化学变化中微粒怎么变？\n";
  f.record.fields.fld_instruction = "  0:00-0:20\n";
  const hold = await preparedWhileBusy(f);
  t.after(() => hold.release());
  const [run] = f.runtime.list();
  const input = JSON.parse(await readFile(path.join(path.dirname(run.prepared.contextPath),"input.json"),"utf8"));
  assert.equal(input.source.vmid,VMID);
  assert.equal(input.instructions[0].raw_text,"  0:00-0:20\n");
  assert.equal(f.database.getFeishuTaskOrigin(run.taskId).stageSnapshot.vmContext.title,"化学变化中微粒怎么变？");
});

test("runtime composes real plan/render, verified delivery and writeback without replay after restart", {timeout: 120000}, async t => {
  if (!PYTHON) return t.skip("python is unavailable");
  const f = await fixture(t,{alias: "切片初稿",finalArchive: true});
  const manifestPath = path.join(f.packageRecord.workspacePath,"PACKAGE-MANIFEST.json");
  const reviewManifest = JSON.parse(await readFile(manifestPath,"utf8"));
  reviewManifest.version = "0.3.0";
  reviewManifest.interface.contract.version = 2;
  reviewManifest.interface.driverId = "vm_pmo_review_video_v2";
  await writeFile(manifestPath,JSON.stringify(reviewManifest));
  const sourceFile = path.join(f.directory,"fixture.mp4");
  try {
    await runCommand("ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i",
      "color=c=black:s=1280x720:r=25:d=1","-f","lavfi","-i",
      "sine=frequency=440:sample_rate=48000:duration=1","-c:v","libx264","-preset","ultrafast",
      "-pix_fmt","yuv420p","-c:a","aac","-shortest",sourceFile],{timeout: 60000});
  } catch (error) {if (error?.code === "ENOENT") return t.skip("ffmpeg is unavailable");throw error;}
  const moduleRoot = path.join(f.packageRecord.workspacePath,"auto_cut_slicing");
  await writeFile(path.join(moduleRoot,"__init__.py"),"");
  await writeFile(path.join(moduleRoot,"vm_pmo.py"),`
import hashlib, json, os, subprocess, sys
def read(filename):
    with open(filename, encoding='utf-8') as handle:
        return json.load(handle)
def save(filename, value):
    with open(filename, 'w', encoding='utf-8') as handle:
        json.dump(value, handle)
def sha(data):
    return hashlib.sha256(data).hexdigest()
data = read(sys.argv[sys.argv.index('--input')+1])
context = read(sys.argv[sys.argv.index('--context')+1])
mode = sys.argv[1]
with open(os.path.join(context['run_dir'], 'executions.log'), 'a', encoding='utf-8') as handle:
    handle.write(mode+'\\n')
identity = {key: data[key] for key in ['protocol','schema_version','package','binding','record','review_round','delivery_target']}
results = [{key: entry[key] for key in ['instruction_id','source_field_id','raw_text']}
           | {'status':'resolved','segments':['segment-1']} for entry in data['instructions']]
common = identity | {'input_sha256':context['input_sha256'],'source_sha256':data['source']['sha256'],
                     'instruction_results':results,'error':None}
if mode == 'plan':
    version_two = data['schema_version'] == 2
    segments = ([{'segment_id':'segment-1','source_id':data['source']['source_id'],
        'source_start_us':0,'duration_us':1000000,'target_start_us':0}] if version_two else
        [{'segment_id':'segment-1','source_id':data['source']['source_id'],'start_ms':0,'end_ms':1000}])
    plan = identity | {'source':data['source'],'input_sha256':context['input_sha256'],
        'source_sha256':data['source']['sha256'],'instruction_results':results,
        'segments':segments,
        'operations':[],'expected_duration_ms':1000,'engine_plan_sha256':'b'*64}
    if version_two:
        plan['alignment_sha256'] = None
    save(context['plan_path'],plan)
    with open(context['plan_path'],'rb') as handle:
        plan_hash = sha(handle.read())
    save(context['plan_result_path'],common | {'status':'ready','plan_sha256':plan_hash})
elif mode == 'render':
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',context['source_path'],
        '-vf','scale=1920:1080','-r','25','-t','1','-c:v','libx264','-preset','ultrafast',
        '-pix_fmt','yuv420p','-c:a','aac',context['output_path']],check=True)
    with open(context['output_path'],'rb') as handle:
        video = handle.read()
    with open(context['plan_path'],'rb') as handle:
        plan_hash = sha(handle.read())
    save(context['result_path'],common | {'status':'rendered','plan_sha256':plan_hash,'artifacts':[
        {'kind':'review_mp4','path':context['output_path'],'sha256':sha(video),'bytes':len(video),
         'duration_ms':1000,'width':1920,'height':1080,'fps':25,'has_audio':True,'full_decode_passed':True}]})
else:
    raise RuntimeError('unsupported mode')
`);
  f.record.fields.fld_instruction = "0:00-0:01";
  f.record.fields.fld_output = [];
  const effects = [];
  let uploadCount = 0;
  f.args.pythonPath = PYTHON;
  f.args.getAdapter = () => ({
    listFields: async () => structuredClone(f.subject.metadata.fields),
    getRecord: async () => structuredClone(f.record),
    uploadMedia: async input => {
      assert.equal(input.baseToken,f.subject.baseToken);
      assert.equal(createHash("sha256").update(await readFile(input.filePath)).digest("hex"),input.sha256);
      effects.push("upload");uploadCount++;
      return {file_token: uploadCount === 1 ? "file_vm_review" : `file_vm_review_${uploadCount}`};
    },
    updateRecord: async input => {
      assert.equal(input.fieldName,"成片");assert.equal(input.recordId,"rec_vm");
      assert.equal(input.attachments.length,uploadCount);
      f.record.fields.fld_output = structuredClone(input.attachments);effects.push("attachment");
    },
  });
  f.args.dispatchWriteback = async claim => {
    const trusted = await f.runtime.resolveWriteback(claim);
    assert.equal(trusted.target.recordId,"rec_vm");
    const option = trusted.operation.optionId;
    if (option === "opt_processing") {
      assert.ok(f.runtime.list()[0].runnerStartedAt);
      effects.push("processing");f.record.fields.fld_status = "处理中";
      f.setPolicy({enabled: false,version: 2});await f.runtime.cancelPendingAutomatic();
    } else {
      assert.ok(["opt_complete","opt_review_complete"].includes(option));
      assert.equal(f.record.fields.fld_output.length,uploadCount);
      effects.push("completed");f.record.fields.fld_status = option === "opt_complete" ? "完成" : "第1稿完成";
    }
  };
  f.record.fields.fld_status = "待归档";
  await assert.rejects(f.runtime.enqueueFinalArchive({
    event: {eventId: "evt_archive_without_delivery",baseToken: "bas_vm",tableId: "tbl_vm",recordId: "rec_vm",
      statusFieldId: "fld_status",beforeOptionIds: ["opt_complete"],afterOptionIds: ["opt_archive"],occurredAt: 400},
    binding: {subjectKey: "bas_vm:tbl_vm",configVersion: 4},
  }),{code: "VM_ARCHIVE_SOURCE_UNAVAILABLE"});
  f.record.fields.fld_status = "待剪辑";
  await f.restart();
  const created = await f.runtime.register(f.body,ACTOR);
  await f.runtime.wake();
  assert.equal(f.runtime.list()[0].state,"waiting_materials");
  assert.deepEqual(effects,[]);
  await f.markReady({sourceBytes: await readFile(sourceFile),durationMs: 1000});
  await f.runtime.wake();
  const [run] = f.runtime.list();
  assert.equal(run.state,"completed",run.errorCode);
  assert.equal(f.database.getTask(created.task.id).status,"in_review");
  assert.deepEqual(effects,["processing","upload","attachment","completed"]);
  const log = path.join(path.dirname(run.prepared.contextPath),"executions.log");
  assert.equal((await readFile(log,"utf8")).replaceAll("\r\n","\n"),"plan\nrender\n");
  assert.equal(f.scheduler.snapshot().activeCount,0);
  assert.equal(f.scheduler.snapshot().pendingCount,0);
  const frozenWritebacks = f.database.database.prepare(`SELECT id,moment FROM vm_writeback_outbox WHERE run_id = ?
    ORDER BY moment`).all(run.runId);
  f.database.database.prepare(`UPDATE vm_writeback_outbox SET state='dead_letter',attempt_count=8,
    error_code='WRITEBACK_UNAVAILABLE',version=version+1 WHERE run_id=?`).run(run.runId);
  f.record.fields.fld_status = "待剪辑";
  const failedWritebackSummary = await f.runtime.getTaskRun(created.task.id);
  assert.equal(failedWritebackSummary.canRetryWriteback,true);
  assert.equal(failedWritebackSummary.writeback.processing.errorCode,"WRITEBACK_UNAVAILABLE");
  const retryingWritebackSummary = await f.runtime.retryWriteback(created.task.id,
    {version:f.database.getTask(created.task.id).version});
  assert.equal(retryingWritebackSummary.canRetryWriteback,false);
  assert.deepEqual(retryingWritebackSummary.writeback.processing.state,"pending");
  await f.runtime.wake();
  assert.deepEqual(f.database.database.prepare(`SELECT id,moment,state FROM vm_writeback_outbox WHERE run_id = ?
    ORDER BY moment`).all(run.runId).map(entry => ({...entry})),frozenWritebacks.map(entry => ({...entry,state:"succeeded"})));
  assert.equal(f.database.getTask(created.task.id).status,"in_review");
  assert.deepEqual(effects,["processing","upload","attachment","completed","processing","completed"]);
  await assert.rejects(f.runtime.retryWriteback(created.task.id,
    {version:f.database.getTask(created.task.id).version}),{code:"VM_PMO_WRITEBACK_RETRY_NOT_ALLOWED"});
  f.record.fields.fld_status = "待归档";
  const archiveRequest = {event: {eventId: "evt_final_archive",baseToken: "bas_vm",tableId: "tbl_vm",recordId: "rec_vm",
    statusFieldId: "fld_status",beforeOptionIds: ["opt_complete"],afterOptionIds: ["opt_archive"],occurredAt: 500},
    binding: {subjectKey: "bas_vm:tbl_vm",configVersion: 4}};
  const queuedArchive = await f.runtime.enqueueFinalArchive(archiveRequest);
  assert.equal(queuedArchive.created,true);
  assert.equal(queuedArchive.job.state,"pending");
  await f.runtime.wake();
  const archivedReplay = await f.runtime.enqueueFinalArchive(archiveRequest);
  assert.equal(archivedReplay.created,false);
  assert.equal(archivedReplay.job.state,"published");
  assert.deepEqual(await readFile(path.join(f.directory,"archive","化学变化中微粒怎么变？.mp4")),
    await readFile(run.renderResult.artifact.path));
  await f.restart();await f.runtime.wake();
  const replay = await f.runtime.register(f.body,ACTOR);await f.runtime.wake();
  assert.equal(replay.created,false);assert.equal(f.runtime.list()[0].runId,run.runId);
  assert.equal(f.runtime.list()[0].state,"completed");
  assert.equal((await readFile(log,"utf8")).replaceAll("\r\n","\n"),"plan\nrender\n");
  assert.deepEqual(effects,["processing","upload","attachment","completed","processing","completed"]);

  f.subject.statusField.options.push({optionId: "opt_review",name: "待修改"},
    {optionId: "opt_review_complete",name: "第1稿完成"});
  f.subject.metadata.fields[0].options.push({id: "opt_review",name: "待修改"},
    {id: "opt_review_complete",name: "第1稿完成"});
  f.subject.metadata.fields.push({fieldId: "fld_review_instruction",fieldName: "审核意见",type: 1,uiType: "Text"});
  f.subject.vmWorkflow.stages.review = {enabled: true,statusFieldId: "fld_status",triggerOptionId: "opt_review",
    instructionFieldId: "fld_review_instruction",instructionAttachmentsFieldId: null,writeback: {
      processing: {fieldId: "fld_status",optionId: "opt_processing"},
      completed: {fieldId: "fld_status",optionId: "opt_review_complete"}}};
  f.record.fields.fld_status = "待修改";
  f.record.fields.fld_review_instruction = "剪掉‘上一章’三个字，其他不变";
  f.setPolicy({enabled: true,version: 3});
  const reviewBody = {event: {eventId: "evt_review",baseToken: "bas_vm",tableId: "tbl_vm",
    recordId: "rec_vm",statusFieldId: "fld_status",beforeOptionId: "opt_complete",afterOptionId: "opt_review",
    occurredAt: 600},binding: {subjectKey: "bas_vm:tbl_vm",configVersion: 4,stageId: "review"}};
  f.subject.packageRoute.packageAlias = "other-package";f.packageRecord.alias = "other-package";
  await assert.rejects(f.runtime.register({...reviewBody,event:{...reviewBody.event,eventId:"evt_other_package"}},ACTOR),
    {code:"VM_REVIEW_PARENT_UNAVAILABLE"});
  f.record.fields.fld_status = "待归档";
  await assert.rejects(f.runtime.enqueueFinalArchive({...archiveRequest,event:{...archiveRequest.event,
    eventId:"evt_other_package_archive",occurredAt:550}}),{code:"VM_ARCHIVE_SOURCE_UNAVAILABLE"});
  f.subject.packageRoute.packageAlias = "切片初稿";f.packageRecord.alias = "切片初稿";
  f.record.fields.fld_status = "待修改";
  const downloadReadsBeforeReview = f.downloadReads;
  let review;
  const held = await f.scheduler.request({requestId: "review-hold",concurrencyGroup: "autocut:切片初稿",
    maxConcurrent: 1});
  try {
    review = await f.runtime.register(reviewBody,ACTOR);
    assert.equal(review.created,true);
    const delayedWriteback = f.database.database.prepare(`SELECT id,version FROM vm_writeback_outbox
      WHERE run_id = ? AND moment = 'completed'`).get(run.runId);
    const claimToken = "delayed_old_round_claim";
    f.database.database.prepare(`UPDATE vm_writeback_outbox SET state='processing',version=version+1,
      claim_token=?,lease_until=?,next_attempt_at=NULL WHERE id=?`)
      .run(claimToken,new Date(Date.now()+60_000).toISOString(),delayedWriteback.id);
    await assert.rejects(f.runtime.resolveWriteback({operationId: delayedWriteback.id,claimToken,
      version: delayedWriteback.version+1}),{code: "VM_WRITEBACK_STAGE_ADVANCED"});
    const deliveryId = f.database.database.prepare("SELECT id FROM vm_mp4_deliveries WHERE run_id = ?").get(run.runId).id;
    const parent = review.origin.stageSnapshot.reviewParent;
    assert.deepEqual(parent,{runId: run.runId,artifactId: run.artifactId,deliveryId,
      localPath: run.renderResult.artifact.path,sha256: run.renderResult.artifact.sha256,
      bytes: run.renderResult.artifact.bytes,durationMs: run.renderResult.artifact.duration_ms,reviewRound: 0});
    await f.runtime.wake();
    const reviewRun = f.runtime.list().find(item => item.taskId === review.task.id);
    assert.equal(reviewRun.state,"prepared",reviewRun.errorCode);
    assert.equal(f.approvals.list().length,1);
    const reviewContext = JSON.parse(await readFile(reviewRun.prepared.contextPath,"utf8"));
    const reviewInput = JSON.parse(await readFile(path.join(reviewContext.run_dir,"input.json"),"utf8"));
    assert.equal(reviewInput.schema_version,2);
    assert.equal(reviewInput.binding.stage_id,"review");
    assert.deepEqual(reviewInput.review_round.parent,{kind: "managed_run",run_id: run.runId,
      artifact_id: run.artifactId,delivery_id: deliveryId,sha256: parent.sha256,bytes: parent.bytes,
      duration_ms: parent.durationMs});
    assert.equal(reviewInput.source.timeline_basis,"previous_review_video");
    assert.equal(reviewInput.instructions[0].raw_text,"剪掉‘上一章’三个字，其他不变");
    assert.equal(reviewRun.prepared.outputFilename,"化学变化中微粒怎么变？_第1稿.mp4");
    const beforeRetryReads = f.downloadReads;
    const retryPayload = JSON.parse(f.database.database.prepare("SELECT payload_json FROM vm_pmo_runs WHERE run_id=?")
      .get(reviewRun.runId).payload_json);
    retryPayload.planStartedAt = new Date().toISOString();
    f.database.database.prepare("UPDATE vm_pmo_runs SET state='blocked',error_code='WORD_ALIGNMENT_UNRESOLVED',payload_json=? WHERE run_id=?")
      .run(JSON.stringify(retryPayload),reviewRun.runId);
    const reviewTask = f.database.getTask(review.task.id);
    assert.equal((await f.runtime.getTaskRun(reviewTask.id)).canRetryPlan,true);
    await f.runtime.retryPlanning(reviewTask.id,{version:reviewTask.version,
      runConsent:{allowVideoAudioAsr:true,allowConfiguredLocalOutput:true}});
    await f.runtime.wake();
    const retriedReview = f.runtime.list().find(item=>item.taskId===review.task.id);
    assert.equal(retriedReview.state,"prepared",retriedReview.errorCode);
    assert.equal(retriedReview.planAttempt,2);
    assert.notEqual(retriedReview.prepared.contextPath,reviewRun.prepared.contextPath);
    assert.deepEqual(retriedReview.acquisition,reviewRun.acquisition);
    assert.equal(f.downloadReads,beforeRetryReads,"review retries must never consult VM approvals");
    assert.equal(f.approvals.list().length,1);
  } finally { await held.release(); }
  await f.runtime.wake();
  const firstReviewRun = f.runtime.list().find(item => item.taskId === review.task.id);
  assert.equal(firstReviewRun.state,"completed",firstReviewRun.errorCode);
  f.record.fields.fld_status = "待修改";f.record.fields.fld_review_instruction = "保留 0:00-0:01";
  f.setPolicy({enabled:true,version:4});
  const secondReviewBodies = [700,701].map((occurredAt,index) => ({...reviewBody,
    event:{...reviewBody.event,eventId:`evt_review_2_${index}`,occurredAt}}));
  const competingReviews = await Promise.allSettled(secondReviewBodies.map(body => f.runtime.register(body,ACTOR)));
  assert.equal(competingReviews.filter(result => result.status === "fulfilled").length,1,
    "concurrent edges must not create sibling reviews from one parent");
  const secondReview = competingReviews.find(result => result.status === "fulfilled").value;
  const secondReviewBody = secondReviewBodies.find(body => body.event.eventId === secondReview.origin.eventId);
  assert.equal(secondReview.origin.stageSnapshot.reviewRound,2);
  assert.equal(secondReview.origin.stageSnapshot.reviewParent.runId,firstReviewRun.runId);
  const boardBeforeRender = await f.runtime.getPackageBoard({subjectKey:f.subject.subjectKey,packageAlias:"切片初稿"});
  assert.equal(boardBeforeRender.tasks.find(item => item.taskId === review.task.id).supersededByTaskId,secondReview.task.id);
  assert.equal(boardBeforeRender.tasks.find(item => item.taskId === secondReview.task.id).parentTaskId,review.task.id);
  f.record.fields.fld_status = "待归档";
  await assert.rejects(f.runtime.enqueueFinalArchive({...archiveRequest,event:{...archiveRequest.event,
    eventId:"evt_archive_obsolete_round",occurredAt:650}}),{code:"VM_ARCHIVE_SOURCE_SUPERSEDED"});
  f.record.fields.fld_status = "待修改";
  await f.runtime.wake();
  const secondReviewRun = f.runtime.list().find(item => item.taskId === secondReview.task.id);
  assert.equal(secondReviewRun.state,"completed",secondReviewRun.errorCode);
  assert.equal(f.approvals.list().length,1);
  assert.equal(f.downloadReads,downloadReadsBeforeReview);
  assert.equal(uploadCount,3);
  const replayedReview = await f.runtime.register(secondReviewBody,ACTOR);
  assert.equal(replayedReview.created,false);assert.equal(replayedReview.task.id,secondReview.task.id);
  f.record.fields.fld_status = "待归档";f.record.fields.fld_name = "审核成片";
  const finalReviewArchive = {...archiveRequest,event:{...archiveRequest.event,eventId:"evt_archive_review_2",occurredAt:800}};
  await f.runtime.enqueueFinalArchive(finalReviewArchive);await f.runtime.wake();
  const finalBoard = await f.runtime.getPackageBoard({subjectKey:f.subject.subjectKey,packageAlias:"切片初稿"});
  const finalEvidence = finalBoard.tasks.find(item => item.taskId === secondReview.task.id);
  assert.equal(finalEvidence.latestDelivered,true);
  assert.equal(finalEvidence.archive.state,"published");
  assert.equal(finalEvidence.archive.sourceRunId,secondReviewRun.runId);
  assert.equal(finalEvidence.archive.eventId,"evt_archive_review_2");
  assert.ok(finalEvidence.runnerStartedAt);assert.ok(finalEvidence.completedAt);
  assert.deepEqual(await readFile(path.join(f.directory,"archive","审核成片.mp4")),
    await readFile(secondReviewRun.renderResult.artifact.path));
});

test("a package blocked while waiting for a slot releases its request instead of taking resources later", async t => {
  const f = await fixture(t), hold = await preparedWhileBusy(f);
  f.packageRecord.state = "disabled";await f.runtime.wake();
  assert.equal(f.runtime.list()[0].state,"blocked");assert.equal(f.runtime.list()[0].errorCode,"VM_PMO_PACKAGE_CHANGED");
  hold.release();await Promise.resolve();
  assert.equal(f.scheduler.snapshot().activeCount,0);assert.equal(f.scheduler.snapshot().pendingCount,0);
});

test("a recovered planning attempt rejects input and context rebound to a different task", async t => {
  const f = await fixture(t), hold = await preparedWhileBusy(f), [run] = f.runtime.list();
  const context = JSON.parse(await readFile(run.prepared.contextPath,"utf8"));
  const inputPath = path.join(context.run_dir,"input.json"), input = JSON.parse(await readFile(inputPath,"utf8"));
  input.binding.task_id = "different-task";
  const bytes = Buffer.from(JSON.stringify(input));context.input_sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(inputPath,bytes);await writeFile(run.prepared.contextPath,JSON.stringify(context));
  const row = f.database.database.prepare("SELECT payload_json FROM vm_pmo_runs WHERE run_id = ?").get(run.runId);
  const payload = {...JSON.parse(row.payload_json),planStartedAt: new Date().toISOString()};
  f.database.database.prepare("UPDATE vm_pmo_runs SET state = 'planning',payload_json = ? WHERE run_id = ?")
    .run(JSON.stringify(payload),run.runId);
  await f.restart();hold.release();await f.runtime.start();await f.runtime.wake();
  assert.equal(f.runtime.list()[0].state,"needs_attention");assert.equal(f.runtime.list()[0].errorCode,"VM_PMO_INPUT_CHANGED");
  assert.equal(f.scheduler.snapshot().activeCount,0);
});

test("Chinese package aliases register and wait for approval through the independent VM workflow", async t => {
  const f = await fixture(t,{alias: "切片初稿"});
  const result = await f.runtime.register(f.body,ACTOR);await f.runtime.wake();
  assert.equal(result.origin.packageAlias,"切片初稿");assert.equal(f.runtime.list()[0].state,"waiting_materials");
  assert.equal(f.approvals.list().length,1);assert.equal(f.scheduler.snapshot().activeCount,0);
});

test("a simulated VM event cannot create a task, initialize approval, or create run folders", async t => {
  const f = await fixture(t), simulated = structuredClone(f.body);simulated.event.deliverySource = "simulation";
  await assert.rejects(f.runtime.register(simulated,ACTOR), {code: "SIMULATION_VM_TASK_FORBIDDEN"});
  assert.equal(f.database.findFeishuTaskByEventId(f.body.event.eventId),null);
  assert.equal(f.runtime.list().length,0);assert.equal(f.downloadReads,0);assert.equal(f.connects,0);
  await assert.rejects(access(f.args.runRoot),{code: "ENOENT"});
});

test("runtime readiness and draft package validation are local and side-effect free", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.runtime.ready(), {available: true,workflowTemplate: TEMPLATE});
  assert.equal(await f.runtime.validateVmPackage({...f.packageRecord,state: "draft"}), true);
  assert.equal(f.connects, 0);assert.equal(f.downloadReads, 0);
  await assert.rejects(access(f.args.runRoot), {code: "ENOENT"});
});

test("package board reads are local, sanitized and do not initialize or advance workers", async t => {
  const f = await fixture(t);
  const tables = () => f.database.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  const before = tables();
  assert.deepEqual(await f.runtime.getPackageBoard({subjectKey: f.subject.subjectKey, packageAlias: "slicing"}),
    {subjectKey: f.subject.subjectKey, packageAlias: "slicing", tasks: []});
  assert.deepEqual(tables(), before);
  assert.equal(f.downloadReads, 0);assert.equal(f.connects, 0);
  const created = await f.runtime.register(f.body, ACTOR);
  const runsBefore = f.runtime.list();
  const readsBefore = {downloads:f.downloadReads,adapter:f.connects};
  const board = await f.runtime.getPackageBoard({subjectKey: f.subject.subjectKey, packageAlias: "slicing"});
  assert.equal(board.tasks.length, 1);assert.equal(board.tasks[0].taskId, created.task.id);
  assert.equal(board.tasks[0].state, "waiting_materials");
  assert.deepEqual(board.tasks[0].writeback, {processing: null, completed: null});
  assert.deepEqual(f.runtime.list(), runsBefore);
  assert.deepEqual({downloads:f.downloadReads,adapter:f.connects}, readsBefore);
  assert.doesNotMatch(JSON.stringify(board), /workspacePath|python|receipt_path|trusted local prompt|instruction|vmid|token/i);
  assert.deepEqual((await f.runtime.getPackageBoard({subjectKey: f.subject.subjectKey, packageAlias: "other"})).tasks, []);
  await f.restart();
  assert.equal((await f.runtime.getPackageBoard({subjectKey: f.subject.subjectKey, packageAlias: "slicing"})).tasks[0].taskId,
    created.task.id);
});

test("package boards retain historical manual snapshots and ignore forged descriptions", async t => {
  const f = await fixture(t,{enabled:false});
  const first = await f.runtime.register(f.body,ACTOR);
  f.subject.packageRoute.packageAlias = "second-package";f.packageRecord.alias = "second-package";
  const second = await f.runtime.register({...f.body,event:{...f.body.event,eventId:"evt_second_package",occurredAt:300}},ACTOR);
  const fake = f.database.createTask({projectId:subjectProjectId(f.subject.subjectKey),title:"forged VM task",
    description:first.task.description,status:"todo",priority:"high",labels:["feishu"],actor:ACTOR,assignee:ACTOR,
    startDate:null,dueDate:null,recurrence:null,developmentContext:null});
  const firstBoard = await f.runtime.getPackageBoard({subjectKey:f.subject.subjectKey,packageAlias:"slicing"});
  const secondBoard = await f.runtime.getPackageBoard({subjectKey:f.subject.subjectKey,packageAlias:"second-package"});
  assert.deepEqual(firstBoard.tasks.map(task => task.taskId),[first.task.id]);
  assert.deepEqual(secondBoard.tasks.map(task => task.taskId),[second.task.id]);
  assert.equal(firstBoard.tasks[0].runId,null);assert.equal(firstBoard.tasks[0].state,"todo");
  assert.equal(firstBoard.tasks[0].supersededByTaskId,null);
  assert.ok(!firstBoard.tasks.some(task => task.taskId === fake.id));
});

test("runtime activation accepts initial-only profiles and rejects disabled package or missing runner", async t => {
  const f = await fixture(t);
  assert.equal(await f.runtime.validateActivation({subject: f.subject,packageAlias: "slicing",config: f.subject.vmWorkflow}), true);
  f.packageRecord.state = "disabled";
  await assert.rejects(f.runtime.validateActivation({subject: f.subject,packageAlias: "slicing",config: f.subject.vmWorkflow}), {code: "PACKAGE_DISABLED"});
  f.packageRecord.state = "enabled";
  await rm(path.join(f.packageRecord.workspacePath,"auto_cut_slicing","vm_pmo.py"));
  await assert.rejects(f.runtime.validateVmPackage(f.packageRecord), {code: "VM_PMO_PACKAGE_NOT_READY"});
});

test("runtime activation requires the v2 package contract for an enabled review stage", async t => {
  const f = await fixture(t,{contractVersion: 1});
  const reviewStage = { enabled: true, statusFieldId: "fld_status", triggerOptionId: "opt_review",
    instructionFieldId: "fld_review_instruction", instructionAttachmentsFieldId: null,
    writeback: structuredClone(f.subject.vmWorkflow.stages.initial.writeback) };
  f.subject.statusField.options.push({ optionId: "opt_review", name: "待修改" });
  f.subject.metadata.fields[0].options.push({ id: "opt_review", name: "待修改" });
  f.subject.metadata.fields.push({ fieldId: "fld_review_instruction", fieldName: "审核意见", type: 1, uiType: "Text" });
  f.subject.vmWorkflow.stages.review = reviewStage;
  await assert.rejects(f.runtime.validateActivation({ subject: f.subject, packageAlias: "slicing",
    config: f.subject.vmWorkflow }), { code: "VM_PMO_PACKAGE_NOT_READY" });
  const manifestPath = path.join(f.packageRecord.workspacePath, "PACKAGE-MANIFEST.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.interface.contract.version = 2;
  manifest.interface.driverId = "vm_pmo_review_video_v2";
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal(await f.runtime.validateActivation({ subject: f.subject, packageAlias: "slicing",
    config: f.subject.vmWorkflow }), true);
});

for (const contractVersion of [null, 1]) test(`initial-only execution rejects a missing/v1 protocol declaration (${contractVersion})`, async t => {
  const f = await fixture(t,{contractVersion: contractVersion ?? 2});
  if (contractVersion === null) {
    const manifestPath = path.join(f.packageRecord.workspacePath,"PACKAGE-MANIFEST.json");
    const manifest = JSON.parse(await readFile(manifestPath,"utf8"));
    delete manifest.interface.contract;
    delete manifest.interface.driverId;
    await writeFile(manifestPath,JSON.stringify(manifest));
  }
  await assert.rejects(f.runtime.validateVmPackage(f.packageRecord),{code:"VM_PMO_PACKAGE_NOT_READY"});
  await assert.rejects(f.runtime.validateActivation({subject:f.subject,packageAlias:"slicing",
    config:f.subject.vmWorkflow}),{code:"VM_PMO_PACKAGE_NOT_READY"});
  await assert.rejects(f.runtime.register(f.body,ACTOR),{code:"VM_PMO_PACKAGE_NOT_READY"});
  assert.equal(f.database.findFeishuTaskByEventId(f.body.event.eventId),null);
  assert.equal(f.approvals.list().length,0);
  assert.equal(f.downloadReads,0);
  await assert.rejects(access(f.args.runRoot),{code:"ENOENT"});
});

test("new automatic tasks wait on approval without holding a scheduler slot or creating input folders", async t => {
  const f = await fixture(t);
  const first = await f.runtime.register(f.body, ACTOR);
  await f.runtime.wake();
  const [run] = f.runtime.list();
  assert.equal(first.created, true);assert.equal(run.state,"waiting_materials");
  assert.equal(f.approvals.list().length,1);assert.equal(f.scheduler.snapshot().activeCount,0);
  await assert.rejects(access(f.args.runRoot),{code: "ENOENT"});
  await f.restart();
  const replay = await f.runtime.register(f.body,ACTOR);
  assert.equal(replay.created,false);assert.equal(f.runtime.list()[0].runId,run.runId);
  await f.runtime.wake();assert.equal(f.approvals.list().length,1);
});

test("switching automatic policy off blocks pending runs and switching on does not replay historical tasks", async t => {
  const f = await fixture(t);
  await f.runtime.register(f.body,ACTOR);
  f.setPolicy({enabled: false,version: 2});await f.runtime.wake();
  assert.equal(f.runtime.list()[0].state,"blocked");
  assert.equal(f.runtime.list()[0].errorCode,"AUTOMATIC_EXECUTION_DISABLED");
  assert.equal(f.approvals.list().length,0);
  f.setPolicy({enabled: true,version: 3});await f.runtime.register(f.body,ACTOR);await f.runtime.wake();
  assert.equal(f.runtime.list()[0].state,"blocked");assert.equal(f.approvals.list().length,0);
  const g = await fixture(t,{enabled: false});await g.runtime.register(g.body,ACTOR);
  assert.equal(g.runtime.list().length,0);assert.equal(g.downloadReads,0);
  g.setPolicy({enabled: true,version: 2});await g.runtime.register(g.body,ACTOR);await g.runtime.wake();
  assert.equal(g.runtime.list().length,0);assert.equal(g.approvals.list().length,0);
});

test("first input preparation rejects changed PMO instructions before creating folders or taking a slot", async t => {
  const f = await fixture(t);
  await f.runtime.register(f.body,ACTOR);await f.runtime.wake();await f.markReady();
  f.record.fields.fld_instruction = "0:10-0:20";
  await f.runtime.wake();
  assert.equal(f.runtime.list()[0].state,"blocked");
  assert.equal(f.runtime.list()[0].errorCode,"VM_PMO_RECORD_CHANGED");
  await assert.rejects(access(f.args.runRoot),{code: "ENOENT"});
  assert.equal(f.scheduler.snapshot().activeCount,0);
});

test("package edits after registration cannot silently change the frozen manifest identity", async t => {
  const f = await fixture(t);await f.runtime.register(f.body,ACTOR);
  const file = path.join(f.packageRecord.workspacePath,"PACKAGE-MANIFEST.json");
  const manifest = JSON.parse(await readFile(file,"utf8"));manifest.version = "0.2.2";await writeFile(file,JSON.stringify(manifest));
  await f.runtime.wake();
  assert.equal(f.runtime.list()[0].state,"blocked");assert.equal(f.runtime.list()[0].errorCode,"VM_PMO_PACKAGE_CHANGED");
  assert.equal(f.approvals.list().length,0);
});
