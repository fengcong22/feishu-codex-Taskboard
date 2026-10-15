import assert from "node:assert/strict";
import { test } from "node:test";
import { createVmPmoRuntime } from "../server/vm-pmo-runtime.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";
import { createVmApprovalStore } from "../server/vm-approval-store.mjs";
import { enqueueVmApproval, summarizeVmApproval, validateVmApprovalRequest } from "../server/vm-approval-workflow.mjs";
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

async function fixture(t, { enabled = true, alias = "slicing" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-runtime-"));
  const packageRoot = path.join(directory, "package");
  await mkdir(path.join(packageRoot, "auto_cut_slicing"), { recursive: true });
  await writeFile(path.join(packageRoot, "auto_cut_slicing", "vm_pmo.py"), "# trusted runner fixture");
  await writeFile(path.join(packageRoot, "PACKAGE-MANIFEST.json"), JSON.stringify({ name: "auto-cut-slicing", version: "0.2.1",
    interface: {workflowTemplate: TEMPLATE,contract: TEMPLATE,driverId: "vm_pmo_review_video_v1",artifactKind: "review_mp4"} }));
  const pythonPath = path.join(directory, "python.exe");
  await writeFile(pythonPath, "local runtime fixture");
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const approvals = createVmApprovalStore({ file: path.join(directory, "approvals.sqlite") });
  const options = [{id: "opt_other",name: "准备"},{id: "opt_initial",name: "待剪辑"},
    {id: "opt_processing",name: "处理中"},{id: "opt_complete",name: "完成"}];
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
      review: {enabled: false}},finalArchive: {enabled: false}}};
  const record = {fields: {fld_status: "待剪辑",fld_vmid: VMID,fld_name: "化学变化中微粒怎么变？",fld_instruction: "0:00-0:20"}};
  const packageRecord = {alias,state: "enabled",revision: 2,workflowTemplate: TEMPLATE,workspacePath: packageRoot,
    prompt: "trusted local prompt",maxConcurrent: 1,resourceGroups: ["vm-render"]};
  database.createProject({id: subjectProjectId(subject.subjectKey),name: "VM 测试",workspacePath: directory});
  database.getFeishuSubjectVersion = () => structuredClone(subject);
  let policy = {enabled,version: 1}, connects = 0, downloadReads = 0, policyFailure;
  const downloadInput = input => validateVmApprovalRequest({schema_version: 1,vmid: input.vmid,department: input.department,
    reason: input.reason,output_root: input.outputRoot,allowed_origins: ["https://vm-resource.yangcong345.com"],private_endpoints: []});
  const downloads = {requestFor: downloadInput,snapshot: () => ({settings: {outputRoot: directory}}),
    lookupExact: ({jobId,requestFingerprint}) => { const job = jobId ? approvals.get(jobId)
      : approvals.list().find(j => j.request_fingerprint === requestFingerprint);
      return job?.request_fingerprint === requestFingerprint ? {...summarizeVmApproval(job,{includeLocalRequest: true}),
        requestFingerprint: job.request_fingerprint} : null; },
    enqueue: input => ({jobs: [summarizeVmApproval(enqueueVmApproval(approvals, downloadInput({...input,vmid: input.vmids[0]})),
      {includeLocalRequest: true})]}),wake: async () => {}};
  const scheduler = createResourceScheduler();
  const args = {database,getPackage: async () => structuredClone(packageRecord),getActiveSubject: async () => structuredClone(subject),
    getDownloads: () => {downloadReads++;return downloads;},getAdapter: async () => {connects++;return {
      listFields: async () => structuredClone(fields),getRecord: async () => structuredClone(record),
      updateRecord: async () => {throw new Error("unexpected update");},uploadMedia: async () => {throw new Error("unexpected upload");}};},
    getPolicy: () => {if (policyFailure) {const error = policyFailure;policyFailure = null;throw error;}return policy;},
    scheduler,dispatchWriteback: async () => {},runRoot: path.join(directory,"runs"),pythonPath};
  let runtime = createVmPmoRuntime(args);
  const body = {event: {eventId: "evt_vm",baseToken: "bas_vm",tableId: "tbl_vm",recordId: "rec_vm",
    statusFieldId: "fld_status",beforeOptionId: "opt_other",afterOptionId: "opt_initial",occurredAt: 200},
    binding: {subjectKey: "bas_vm:tbl_vm",configVersion: 4,stageId: "initial"}};
  t.after(async () => {await runtime.close();approvals.close();database.close();await rm(directory,{recursive: true,force: true});});
  return {directory,args,database,approvals,subject,record,packageRecord,scheduler,body,
    get runtime() {return runtime;},get connects() {return connects;},get downloadReads() {return downloadReads;},
    setPolicy(value) {policy = value;},failNextPolicy() {policyFailure = new Error("temporary local policy failure");},
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
  const f = await fixture(t,{alias: "切片初稿"});
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
    plan = identity | {'source':data['source'],'input_sha256':context['input_sha256'],
        'source_sha256':data['source']['sha256'],'instruction_results':results,
        'segments':[{'segment_id':'segment-1','source_id':data['source']['source_id'],'start_ms':0,'end_ms':1000}],
        'operations':[],'expected_duration_ms':1000,'engine_plan_sha256':'b'*64}
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
  f.args.pythonPath = PYTHON;
  f.args.getAdapter = () => ({
    listFields: async () => structuredClone(f.subject.metadata.fields),
    getRecord: async () => structuredClone(f.record),
    uploadMedia: async input => {
      assert.equal(input.baseToken,f.subject.baseToken);
      assert.equal(createHash("sha256").update(await readFile(input.filePath)).digest("hex"),input.sha256);
      effects.push("upload");return {file_token: "file_vm_review"};
    },
    updateRecord: async input => {
      assert.equal(input.fieldName,"成片");assert.equal(input.recordId,"rec_vm");
      assert.deepEqual(input.attachments,[{file_token: "file_vm_review"}]);
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
      assert.equal(option,"opt_complete");assert.deepEqual(f.record.fields.fld_output,[{file_token: "file_vm_review"}]);
      effects.push("completed");f.record.fields.fld_status = "完成";
    }
  };
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
  await f.restart();await f.runtime.wake();
  const replay = await f.runtime.register(f.body,ACTOR);await f.runtime.wake();
  assert.equal(replay.created,false);assert.equal(f.runtime.list()[0].runId,run.runId);
  assert.equal(f.runtime.list()[0].state,"completed");
  assert.equal((await readFile(log,"utf8")).replaceAll("\r\n","\n"),"plan\nrender\n");
  assert.deepEqual(effects,["processing","upload","attachment","completed"]);
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

test("runtime activation accepts initial-only profiles and rejects disabled package or missing runner", async t => {
  const f = await fixture(t);
  assert.equal(await f.runtime.validateActivation({subject: f.subject,packageAlias: "slicing",config: f.subject.vmWorkflow}), true);
  f.packageRecord.state = "disabled";
  await assert.rejects(f.runtime.validateActivation({subject: f.subject,packageAlias: "slicing",config: f.subject.vmWorkflow}), {code: "PACKAGE_DISABLED"});
  f.packageRecord.state = "enabled";
  await rm(path.join(f.packageRecord.workspacePath,"auto_cut_slicing","vm_pmo.py"));
  await assert.rejects(f.runtime.validateVmPackage(f.packageRecord), {code: "VM_PMO_PACKAGE_NOT_READY"});
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
