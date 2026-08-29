import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeServer } from "../src/server.mjs";

const OPERATOR_WRITE_HEADERS = {
  "content-type": "application/json",
  "x-feishu-bridge-client": "local-operator",
};

async function start(workflowStore) {
  const app = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    configSummary: { tables: [], packages: [] },
    handleEvent: async () => ({ kind: "ignored" }),
    workflowStore,
  });
  const address = await app.listen();
  return { app, url: `http://127.0.0.1:${address.port}` };
}

test("exports the redacted workflow configuration through the loopback API", async (t) => {
  const configuration = {
    schemaVersion: 1,
    configVersion: 4,
    bases: [{ baseToken: "bas_demo", subjects: [{ subjectKey: "bas_demo:tbl_a" }] }],
  };
  const app = await start({ exportShareable: async () => configuration });
  t.after(app.app.close);

  const response = await fetch(`${app.url}/api/feishu/workflow/share/export`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configuration });
});

test("supports dry-run and committed workflow imports without leaking errors", async (t) => {
  const calls = [];
  const app = await start({
    importShareable: async (configuration, options) => {
      calls.push({ configuration, options });
      return options.dryRun
        ? {
          configuration: { valid: true },
          diagnostics: [{
            code: "UPLOAD_TARGET_PATH_UNBOUND",
            severity: "warning",
            path: "bases.bas_demo.subjects.tbl_demo.upload.targetPath",
            message: "Upload target path must be bound on this machine",
          }],
          diagnosticsOk: true,
        }
        : {
          configuration: { valid: true, imported: 1 },
          diagnostics: [],
          diagnosticsOk: true,
        };
    },
  });
  t.after(app.app.close);
  const configuration = { schemaVersion: 1, configVersion: 1, bases: [] };

  const dryRun = await fetch(`${app.url}/api/feishu/workflow/share/import`, {
    method: "POST",
    headers: OPERATOR_WRITE_HEADERS,
    body: JSON.stringify({ configuration, dryRun: true }),
  });
  assert.equal(dryRun.status, 200);
  assert.deepEqual(await dryRun.json(), {
    configuration: { valid: true },
    diagnostics: [{
      code: "UPLOAD_TARGET_PATH_UNBOUND",
      severity: "warning",
      path: "bases.bas_demo.subjects.tbl_demo.upload.targetPath",
      message: "Upload target path must be bound on this machine",
    }],
    diagnosticsOk: true,
    dryRun: true,
  });

  const committed = await fetch(`${app.url}/api/feishu/workflow/share/import`, {
    method: "POST",
    headers: OPERATOR_WRITE_HEADERS,
    body: JSON.stringify({ configuration, dryRun: false }),
  });
  assert.equal(committed.status, 200);
  assert.deepEqual(await committed.json(), {
    configuration: { valid: true, imported: 1 },
    diagnostics: [],
    diagnosticsOk: true,
    dryRun: false,
  });
  assert.deepEqual(calls.map((call) => call.options), [{ dryRun: true }, { dryRun: false }]);
});

test("rejects malformed workflow share requests", async (t) => {
  const app = await start({
    exportShareable: async () => ({}),
    importShareable: async () => assert.fail("malformed input must not reach the store"),
  });
  t.after(app.app.close);
  const response = await fetch(`${app.url}/api/feishu/workflow/share/import`, {
    method: "POST",
    headers: OPERATOR_WRITE_HEADERS,
    body: JSON.stringify({ configuration: "not-an-object" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: { code: "INVALID_FIELD", message: "Invalid workflow share import" },
  });
});

test("requires the local operator JSON header for workflow share imports", async (t) => {
  let calls = 0;
  const app = await start({
    importShareable: async () => {
      calls += 1;
      return {};
    },
  });
  t.after(app.app.close);
  const body = JSON.stringify({ configuration: { schemaVersion: 1, bases: [] }, dryRun: true });

  const missingClient = await fetch(`${app.url}/api/feishu/workflow/share/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const formCompatible = await fetch(`${app.url}/api/feishu/workflow/share/import`, {
    method: "POST",
    headers: { "x-feishu-bridge-client": "local-operator", "content-type": "text/plain" },
    body,
  });
  const crossSite = await fetch(`${app.url}/api/feishu/workflow/share/import`, {
    method: "POST",
    headers: { ...OPERATOR_WRITE_HEADERS, origin: "https://attacker.example" },
    body,
  });

  assert.equal(missingClient.status, 403);
  assert.equal(formCompatible.status, 415);
  assert.equal(crossSite.status, 403);
  assert.equal(calls, 0);
});

test("preserves a controlled unavailable status for share import diagnostics", async (t) => {
  const app = await start({
    importShareable: async () => {
      const error = new Error("credentials and workspace path must not be exposed");
      error.code = "FEISHU_METADATA_UNAVAILABLE";
      error.status = 503;
      throw error;
    },
  });
  t.after(app.app.close);

  const response = await fetch(`${app.url}/api/feishu/workflow/share/import`, {
    method: "POST",
    headers: OPERATOR_WRITE_HEADERS,
    body: JSON.stringify({ configuration: { schemaVersion: 1, bases: [] }, dryRun: true }),
  });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.deepEqual(payload, {
    error: { code: "FEISHU_METADATA_UNAVAILABLE", message: "Bridge request failed" },
  });
  assert.doesNotMatch(JSON.stringify(payload), /credentials|workspace path/i);
});

test("requires and forwards the workflow sync expected version", async (t) => {
  const calls = [];
  const app = await start({
    syncSubject: async (subject, options) => {
      calls.push({ subject, options });
      return { ...subject, lifecycle: options.lifecycle };
    },
  });
  t.after(app.app.close);
  const subject = {
    subjectKey: "bas_demo:tbl_demo",
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    configVersion: 3,
  };
  const missing = await fetch(`${app.url}/api/feishu/workflow/sync`, {
    method: "POST",
    headers: { ...OPERATOR_WRITE_HEADERS, "x-feishu-bridge-client": "taskboard" },
    body: JSON.stringify({ lifecycle: "enabled", subject }),
  });
  assert.equal(missing.status, 400);
  assert.equal(calls.length, 0);

  const valid = await fetch(`${app.url}/api/feishu/workflow/sync`, {
    method: "POST",
    headers: { ...OPERATOR_WRITE_HEADERS, "x-feishu-bridge-client": "taskboard" },
    body: JSON.stringify({ lifecycle: "enabled", expectedVersion: 2, subject }),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(calls, [{ subject, options: { lifecycle: "enabled", expectedVersion: 2 } }]);
});
