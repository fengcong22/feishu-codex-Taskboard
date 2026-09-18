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

test("registers a final-directory operation through the authenticated non-task route", async () => {
  const calls = [];
  const client = new TaskboardClient("http://127.0.0.1:47823", {
    bridgeSecret: "secret",
    fetchImplementation: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ operation: {
        id: "directory-op-1",
        eventId: "evt-1",
        kind: "ensure_final_directory",
        state: "succeeded",
        subjectKey: "bas:tbl",
        configVersion: 7,
        courseBindingId: "binding-1",
        createdAt: "2026-09-17T00:00:00.000Z",
        updatedAt: "2026-09-17T00:00:00.000Z",
      } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const payload = {
    event: {
      eventId: "evt-1", baseToken: "bas", tableId: "tbl", recordId: "rec", fieldId: "fld_final",
      beforeOptionId: "old", afterOptionId: "final",
    },
    binding: { subjectKey: "bas:tbl", configVersion: 7 },
    controlledContext: { documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true, courseName: "课程001" },
  };
  const operation = await client.ensureFinalDirectory(payload);
  assert.equal(operation.id, "directory-op-1");
  assert.equal(calls[0].url, "http://127.0.0.1:47823/api/local/feishu/directory-operations");
  assert.equal(calls[0].init.headers["x-taskboard-client"], "feishu-bridge");
  assert.equal(calls[0].init.headers["x-feishu-bridge-secret"], "secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
});
