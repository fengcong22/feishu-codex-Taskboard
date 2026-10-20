import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {createTaskboardServer} from "../server/app.mjs";
import {listenTaskboardOnFetchSafePort} from "../../test/fetch-safe-listen.mjs";

const SECRET = "vm-http-test-secret";
async function fixture(t, vmPmoRuntime) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-pmo-http-"));
  const app = createTaskboardServer({dataDirectory: root, processEnv: {}, feishuBridgeSecret: SECRET, vmPmoRuntime});
  const address = await listenTaskboardOnFetchSafePort(app);
  t.after(async () => {await app.close(); await rm(root, {recursive:true,force:true});});
  const request = async (route, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method: body === undefined ? "GET" : "POST", headers: {"content-type":"application/json",...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: response.status, body: await response.json()};
  };
  return {app,request};
}
const bridgeHeaders = {"x-taskboard-client":"feishu-bridge","x-feishu-bridge-secret":SECRET};

test("VM registration uses the authenticated dedicated route and awaits VM writeback resolution", async t => {
  const calls = [];
  const runtime = {
    ready: async () => ({available:true}), start: async () => {}, close: async () => {},
    register: async body => {calls.push(body); return {created:true,task:{id:"task_vm"}};},
    resolveWriteback: async claim => {calls.push(claim); return {
      target:{baseToken:"bas_vm",tableId:"tbl_vm",recordId:"rec_vm"},
      operation:{type:"single_select",fieldId:"fld_vm",optionId:"opt_done",
        guard:{fieldId:"fld_stage",optionIds:["opt_active","opt_done"]}},
    };},
  };
  const {request} = await fixture(t,runtime);
  assert.equal((await request("/api/meta")).body.capabilities.vmPmoInitial,true);
  assert.equal((await request("/api/local/feishu/vm/tasks", {})).status,403);
  assert.equal(calls.length,0);
  assert.equal((await request("/api/local/feishu/vm/tasks?ignored=1",{},bridgeHeaders)).status,400);
  const body={event:{eventId:"evt_vm"},binding:{stageId:"initial"}};
  const registered=await request("/api/local/feishu/vm/tasks",body,bridgeHeaders);
  assert.equal(registered.status,201);
  assert.deepEqual(calls[0],body);
  const claim={operationId:"vm-test",claimToken:"claim",version:1};
  const resolved=await request("/api/local/feishu/writeback/resolve",claim,bridgeHeaders);
  assert.equal(resolved.status,200);
  assert.equal(resolved.body.operation.optionId,"opt_done");
  assert.deepEqual(resolved.body.operation.guard,{fieldId:"fld_stage",optionIds:["opt_active","opt_done"]});
});

test("VM final archive uses an authenticated dedicated route", async t => {
  const calls = [];
  const runtime = {
    ready: async () => ({available:true}), start: async () => {}, close: async () => {},
    enqueueFinalArchive: async body => {calls.push(body);return {created:true,job:{id:"archive_job"}};},
  };
  const {request} = await fixture(t,runtime);
  const body = {event:{eventId:"evt_archive",baseToken:"bas_vm",tableId:"tbl_vm",recordId:"rec_vm",
    statusFieldId:"fld_status",beforeOptionIds:["opt_done"],afterOptionIds:["opt_archive"]},
    binding:{subjectKey:"bas_vm:tbl_vm",configVersion:4}};
  assert.equal((await request("/api/local/feishu/vm/final-archive",body)).status,403);
  assert.equal(calls.length,0);
  assert.equal((await request("/api/local/feishu/vm/final-archive?ignored=1",body,bridgeHeaders)).status,400);
  assert.equal(calls.length,0);
  const result = await request("/api/local/feishu/vm/final-archive",body,bridgeHeaders);
  assert.equal(result.status,201);
  assert.deepEqual(result.body,{job:{id:"archive_job"}});
  assert.deepEqual(calls,[body]);
});

test("VM plan retry is loopback-local and requires the task version plus explicit one-run consent",async t=>{
  const calls=[];
  const runtime={ready:async()=>({available:true}),start:async()=>{},close:async()=>{},
    getTaskRun:async taskId=>({runId:"run_vm",taskId,state:"blocked",canRetryPlan:true}),
    retryPlanning:async (taskId,body)=>{calls.push({taskId,body});return {runId:"run_vm",taskId,state:"ready"};}};
  const {app,request}=await fixture(t,runtime);
  app.database.createProject({id:"project-1",name:"VM retry test",workspacePath:process.cwd()});
  const task=app.database.createTask({title:"VM retry test",projectId:"project-1",status:"todo",labels:["feishu"],priority:"high",
    description:"",actor:{type:"user",id:"test",name:"Test",avatarUrl:null},
    assignee:{type:"user",id:"test",name:"Test",avatarUrl:null},developmentContext:null,
    startDate:null,dueDate:null,recurrence:null,
    feishuOrigin:{version:1,source:"feishu-base",eventId:"evt_vm",baseToken:"bas_vm",tableId:"tbl_vm",
      recordId:"rec_vm",subjectKey:"bas_vm:tbl_vm",configVersion:1,stageId:"initial",executionMode:"manual"},
    packageSnapshot:{packageAlias:"slicing",packageRevision:1,
      workflowTemplate:{id:"vm_pmo_review_video",version:1}}});
  const route=`/api/local/tasks/${task.id}/vm-pmo-run`;
  assert.deepEqual((await request(route)).body.run,{runId:"run_vm",taskId:task.id,state:"blocked",canRetryPlan:true});
  assert.equal((await request(route,{version:task.version})).status,400);
  assert.equal((await request(route,{version:task.version,runConsent:{allowVideoAudioAsr:true,
    allowConfiguredLocalOutput:true}})).status,202);
  assert.deepEqual(calls,[{taskId:task.id,body:{version:task.version,
    runConsent:{allowVideoAudioAsr:true,allowConfiguredLocalOutput:true}}}]);
  assert.equal((await request(route,{version:task.version+1,runConsent:{allowVideoAudioAsr:true,
    allowConfiguredLocalOutput:true}})).status,409);
  assert.equal(calls.length,1);
});

test("VM writeback retry requires a current VM task version and delegates only eligible runs",async t=>{
  const calls=[];
  const runtime={ready:async()=>({available:true}),start:async()=>{},close:async()=>{},
    getTaskRun:async taskId=>({runId:"run_vm",taskId,state:"completed",canRetryWriteback:true}),
    retryWriteback:async (taskId,body)=>{calls.push({taskId,body});return {runId:"run_vm",taskId,state:"completed"};}};
  const {app,request}=await fixture(t,runtime);
  app.database.createProject({id:"project-writeback",name:"VM writeback retry",workspacePath:process.cwd()});
  const task=app.database.createTask({title:"VM writeback retry",projectId:"project-writeback",status:"in_review",labels:["feishu"],priority:"high",
    description:"",actor:{type:"user",id:"test",name:"Test",avatarUrl:null},
    assignee:{type:"user",id:"test",name:"Test",avatarUrl:null},developmentContext:null,
    startDate:null,dueDate:null,recurrence:null,
    feishuOrigin:{version:1,source:"feishu-base",eventId:"evt_vm",baseToken:"bas_vm",tableId:"tbl_vm",
      recordId:"rec_vm",subjectKey:"bas_vm:tbl_vm",configVersion:1,stageId:"initial",executionMode:"manual"},
    packageSnapshot:{packageAlias:"slicing",packageRevision:1,
      workflowTemplate:{id:"vm_pmo_review_video",version:1}}});
  const route=`/api/local/tasks/${task.id}/vm-pmo-writeback-retry`;
  assert.equal((await request(`${route}?ignored=1`,{version:task.version})).status,400);
  assert.equal((await request(route,{version:task.version+1})).status,409);
  assert.equal(calls.length,0);
  const result=await request(route,{version:task.version});
  assert.equal(result.status,202);
  assert.deepEqual(calls,[{taskId:task.id,body:{version:task.version}}]);
});

test("missing VM runtime configuration stays disabled without registering tasks",async t=>{
  const {app,request}=await fixture(t);
  assert.equal((await request("/api/meta")).body.capabilities.vmPmoInitial,false);
  const result=await request("/api/local/feishu/vm/tasks",{},bridgeHeaders);
  assert.equal(result.status,503);
  assert.equal(result.body.error.code,"VM_PMO_RUNTIME_UNAVAILABLE");
  assert.equal(app.database.database.prepare("SELECT COUNT(*) AS n FROM tasks").get().n,0);
});
