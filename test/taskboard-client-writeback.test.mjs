import assert from "node:assert/strict";
import test from "node:test";

import { TaskboardClient, TaskboardError } from "../src/taskboard-client.mjs";

const claim = { operationId: "writeback-001", claimToken: "claim-001", version: 3 };
const resolvedIntent = {
  target: { baseToken: "bas_delivery", tableId: "tbl_courses", recordId: "rec_001" },
  operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_auto_cutting" },
};

test("resolves a frozen writeback intent through the authenticated Taskboard route", async () => {
  const calls = [];
  const client = new TaskboardClient("http://127.0.0.1:47823", {
    bridgeSecret: "fixture-bridge-secret",
    fetchImplementation: async (url, init) => {
      calls.push({ url, init });
      return Response.json(resolvedIntent);
    },
  });

  assert.deepEqual(await client.resolveFeishuWritebackIntent(claim), resolvedIntent);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:47823/api/local/feishu/writeback/resolve");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-taskboard-client"], "feishu-bridge");
  assert.equal(calls[0].init.headers["x-feishu-bridge-secret"], "fixture-bridge-secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), claim);
});

test("writeback intent resolver fails closed without a secret or with a response that exposes local paths", async () => {
  const missingSecret = new TaskboardClient("http://127.0.0.1:47823", {
    fetchImplementation: async () => assert.fail("a request must not be sent without the Bridge secret"),
  });
  await assert.rejects(
    () => missingSecret.resolveFeishuWritebackIntent(claim),
    (error) => error instanceof TaskboardError
      && error.code === "FEISHU_BRIDGE_SECRET_NOT_CONFIGURED"
      && error.status === 503,
  );

  const unsafeResponse = new TaskboardClient("http://127.0.0.1:47823", {
    bridgeSecret: "fixture-bridge-secret",
    fetchImplementation: async () => Response.json({
      ...resolvedIntent,
      coursePath: "W:\\private-root\\课程001",
    }),
  });
  await assert.rejects(
    () => unsafeResponse.resolveFeishuWritebackIntent(claim),
    (error) => error instanceof TaskboardError
      && error.code === "TASKBOARD_INVALID_RESPONSE"
      && error.status === 502,
  );
});
