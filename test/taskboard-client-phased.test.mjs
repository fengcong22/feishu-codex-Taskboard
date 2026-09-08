import assert from "node:assert/strict";
import test from "node:test";

import { TaskboardClient } from "../src/taskboard-client.mjs";

test("registers a phased task through the dedicated authenticated route", async () => {
  const calls = [];
  const client = new TaskboardClient("http://127.0.0.1:47823", {
    bridgeSecret: "secret",
    fetchImplementation: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ task: { id: "task-1", identifier: "FEI-1" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const payload = {
    event: { eventId: "evt-1", baseToken: "bas", tableId: "tbl", recordId: "rec", statusFieldId: "fld", beforeOptionId: "old", afterOptionId: "new" },
    binding: { subjectKey: "bas:tbl", configVersion: 7, stageId: "initial" },
    controlledContext: { documentLinks: [], namingDisplayValue: "", namingValueUnique: false },
  };
  const task = await client.registerFeishuStageTask(payload);
  assert.deepEqual(task, { id: "task-1", identifier: "FEI-1" });
  assert.equal(calls[0].url, "http://127.0.0.1:47823/api/local/feishu/tasks");
  assert.equal(calls[0].init.headers["x-taskboard-client"], "feishu-bridge");
  assert.equal(calls[0].init.headers["x-feishu-bridge-secret"], "secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
});
