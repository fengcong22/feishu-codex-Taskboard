import assert from "node:assert/strict";
import test from "node:test";
import { TaskboardClient } from "../src/taskboard-client.mjs";

function registration() {
  return {
    event: { eventId: "evt_vm", baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm",
      statusFieldId: "fld_status", beforeOptionId: "opt_wait", afterOptionId: "opt_ready", occurredAt: 1000 },
    binding: { subjectKey: "bas_vm:tbl_vm", configVersion: 2, stageId: "initial" },
  };
}

function task() {
  return { id: "task_vm", identifier: "VM-1", version: 1, status: "todo", archivedAt: null,
    feishuOrigin: { version: 1, source: "feishu-base", eventId: "evt_vm", baseToken: "bas_vm",
      tableId: "tbl_vm", recordId: "rec_vm", statusFieldId: "fld_status", stageId: "initial",
      subjectKey: "bas_vm:tbl_vm", configVersion: 2 } };
}

test("VM registration sends the narrow payload only to the authenticated VM route", async () => {
  const requests = [];
  const client = new TaskboardClient("http://127.0.0.1:5178", {
    bridgeSecret: "test-bridge-secret",
    fetchImplementation: async (url, options) => {
      requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      return Response.json({ task: task() });
    },
  });
  assert.equal((await client.registerFeishuVmTask(registration())).id, "task_vm");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:5178/api/local/feishu/vm/tasks");
  assert.equal(requests[0].headers["x-feishu-bridge-secret"], "test-bridge-secret");
  assert.equal(requests[0].headers["x-taskboard-client"], "feishu-bridge");
  assert.deepEqual(requests[0].body, registration());
});

test("VM registration accepts an explicit review stage on the same authenticated route", async () => {
  const payload = registration();
  payload.binding.stageId = "review";
  const returned = task();
  returned.feishuOrigin.stageId = "review";
  const client = new TaskboardClient("http://127.0.0.1:5178", {
    bridgeSecret: "test-bridge-secret",
    fetchImplementation: async () => Response.json({ task: returned }),
  });
  assert.equal((await client.registerFeishuVmTask(payload)).feishuOrigin.stageId, "review");
});

test("VM registration rejects missing credentials before a network request", async () => {
  let requests = 0;
  const client = new TaskboardClient("http://127.0.0.1:5178", { bridgeSecret: null,
    fetchImplementation: async () => { requests += 1; return Response.json({ task: task() }); } });
  await assert.rejects(() => client.registerFeishuVmTask(registration()), { code: "FEISHU_BRIDGE_SECRET_NOT_CONFIGURED" });
  assert.equal(requests, 0);
});

test("VM registration rejects mixed or widened payloads before a network request", async () => {
  let requests = 0;
  const client = new TaskboardClient("http://127.0.0.1:5178", { bridgeSecret: "test-secret",
    fetchImplementation: async () => { requests += 1; return Response.json({ task: task() }); } });
  for (const changed of [
    { ...registration(), controlledContext: {} },
    { ...registration(), binding: { ...registration().binding, stageId: "finalArchive" } },
    { ...registration(), event: { ...registration().event, deliverySource: "simulation" } },
    { ...registration(), event: { ...registration().event, command: "ignored" } },
    { ...registration(), event: { ...registration().event, occurredAt: -1 } },
    { ...registration(), binding: { ...registration().binding, subjectKey: "other:table" } },
  ]) await assert.rejects(() => client.registerFeishuVmTask(changed), { code: "TASKBOARD_INVALID_RESPONSE" });
  assert.equal(requests, 0);
});

test("VM registration rejects malformed success and mismatched provenance", async () => {
  let returned;
  const client = new TaskboardClient("http://127.0.0.1:5178", { bridgeSecret: "test-secret",
    fetchImplementation: async () => Response.json(returned) });
  for (returned of [null, {}, { task: { id: "task_vm", identifier: "VM-1" } },
    ...["eventId", "baseToken", "tableId", "recordId", "statusFieldId", "stageId", "subjectKey", "configVersion"]
      .map((key) => ({ task: { ...task(), feishuOrigin: { ...task().feishuOrigin, [key]: "wrong" } } })),
  ]) await assert.rejects(() => client.registerFeishuVmTask(registration()), { code: "TASKBOARD_INVALID_RESPONSE" });
});

test("VM final archive sends only a status edge to the authenticated archive route", async () => {
  const payload = { event: { eventId: "evt_archive", baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm",
    statusFieldId: "fld_archive", beforeOptionIds: ["opt_keep"], afterOptionIds: ["opt_archive", "opt_keep"], occurredAt: 1000 },
  binding: { subjectKey: "bas_vm:tbl_vm", configVersion: 2 } };
  const requests = [];
  const client = new TaskboardClient("http://127.0.0.1:5178", { bridgeSecret: "test-secret",
    fetchImplementation: async (url, options) => {
      requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      return Response.json({ job: { id: "archive_job", eventId: "evt_archive", state: "pending",
        subjectKey: "bas_vm:tbl_vm", configVersion: 2 } }, { status: 202 });
    } });
  assert.equal((await client.archiveFeishuVmFinalVideo(payload)).id, "archive_job");
  assert.equal(requests[0].url, "http://127.0.0.1:5178/api/local/feishu/vm/final-archive");
  assert.equal(requests[0].headers["x-feishu-bridge-secret"], "test-secret");
  assert.deepEqual(requests[0].body, payload);
  assert.equal(Object.hasOwn(requests[0].body.event, "path"), false);
});
