import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const SECRET = "fixture-writeback-resolve-secret";

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-writeback-resolve-api-"));
  const calls = [];
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeSecret: SECRET,
    feishuDeliveryStore: {
      resolveWritebackIntentForBridge(claim) {
        calls.push(claim);
        return {
          ...claim,
          target: {
            baseToken: "bas_delivery",
            tableId: "tbl_courses",
            recordId: "rec_001",
            actualRoot: "W:\\private-root",
          },
          operation: {
            type: "text",
            fieldId: "fld_path",
            value: "share\\课程001",
            packageZipPath: "C:\\private\\run.zip",
          },
          actualRoot: "W:\\private-root",
          coursePath: "W:\\private-root\\课程001",
          packageZipPath: "C:\\private\\run.zip",
        };
      },
    },
    // This fixture exercises only the authenticated resolver endpoint. The
    // production writeback worker is covered by feishu-writeback-app.test.mjs
    // and requires the full delivery-store contract.
    writebackWorker: {
      start() {},
      wake() {},
      async close() {},
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    calls,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function request(fixture, body, headers = {}, pathname = "/api/local/feishu/writeback/resolve") {
  const response = await fetch(`${fixture.baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "feishu-bridge",
      "x-feishu-bridge-secret": SECRET,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

test("resolves a claimed writeback intent for the authenticated Bridge without exposing local paths", async () => {
  const fixture = await createFixture();
  try {
    const claim = { operationId: "writeback-001", claimToken: "claim-001", version: 3 };
    const result = await request(fixture, claim);

    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      target: { baseToken: "bas_delivery", tableId: "tbl_courses", recordId: "rec_001" },
      operation: { type: "text", fieldId: "fld_path", value: "share\\课程001" },
    });
    assert.deepEqual(fixture.calls, [claim]);
    assert.doesNotMatch(JSON.stringify(result.body), /private-root|run\.zip|operationId|claimToken/u);
  } finally {
    await fixture.close();
  }
});

test("writeback resolver requires the Bridge secret and an exact claim body", async () => {
  const fixture = await createFixture();
  try {
    const claim = { operationId: "writeback-001", claimToken: "claim-001", version: 3 };
    const unauthenticated = await request(fixture, claim, { "x-feishu-bridge-secret": "wrong" });
    assert.equal(unauthenticated.response.status, 403);
    assert.equal(unauthenticated.body.error.code, "FEISHU_BRIDGE_AUTH_FAILED");

    const unknown = await request(fixture, { ...claim, actualRoot: "W:\\attacker" });
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.body.error.code, "UNKNOWN_FIELD");

    const missing = await request(fixture, { operationId: claim.operationId, claimToken: claim.claimToken });
    assert.equal(missing.response.status, 400);
    assert.equal(missing.body.error.code, "INVALID_FIELD");

    const query = await request(fixture, claim, {}, "/api/local/feishu/writeback/resolve?debug=true");
    assert.equal(query.response.status, 400);
    assert.equal(query.body.error.code, "UNKNOWN_QUERY_PARAMETER");
    assert.deepEqual(fixture.calls, []);
  } finally {
    await fixture.close();
  }
});
