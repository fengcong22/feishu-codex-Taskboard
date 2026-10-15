import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import {createTaskboardServer} from "../server/app.mjs";

const SECRET = "vm-http-test-secret";
async function fixture(t, vmPmoRuntime) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-pmo-http-"));
  const app = createTaskboardServer({dataDirectory: root, processEnv: {}, feishuBridgeSecret: SECRET, vmPmoRuntime});
  const address = await app.listen({host: "127.0.0.1", port: 0});
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
      operation:{type:"single_select",fieldId:"fld_vm",optionId:"opt_done"},
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
});

test("missing VM runtime configuration stays disabled without registering tasks",async t=>{
  const {app,request}=await fixture(t);
  assert.equal((await request("/api/meta")).body.capabilities.vmPmoInitial,false);
  const result=await request("/api/local/feishu/vm/tasks",{},bridgeHeaders);
  assert.equal(result.status,503);
  assert.equal(result.body.error.code,"VM_PMO_RUNTIME_UNAVAILABLE");
  assert.equal(app.database.database.prepare("SELECT COUNT(*) AS n FROM tasks").get().n,0);
});
