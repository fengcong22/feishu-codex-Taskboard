import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { createFeishuBaseMetadataReader } from "../src/feishu-base-metadata.mjs";
import { createBridgeServer, resolveSimulationEnabled } from "../src/server.mjs";
import { TaskboardClient } from "../src/taskboard-client.mjs";

const TASKBOARD_WRITE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-feishu-bridge-client": "taskboard",
};
const SIMULATION_WRITE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-feishu-bridge-client": "local-operator",
};
const BRIDGE_SECRET = "server-test-bridge-secret";

async function postWithRawHeaders(url, headers, body) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function start(handler, getHealth, baseMetadataReader, workflowStore, options = {}) {
  const app = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    configSummary: { tables: 1, packages: 1 },
    handleEvent: handler,
    getHealth,
    baseMetadataReader,
    workflowStore,
    simulationEnabled: options.simulationEnabled ?? true,
    ...(Object.hasOwn(options, "bridgeSecret")
      ? { bridgeSecret: options.bridgeSecret }
      : {}),
  });
  const address = await app.listen();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: app.close,
  };
}

test("previews a Feishu Base through the injected read-only metadata reader", async (t) => {
  let received;
  const app = await start(assert.fail, undefined, {
    preview: async (url) => {
      received = url;
      return {
        baseToken: "bas_demo",
        baseName: "课程库",
        tables: [],
      };
    },
  });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/feishu/base-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.feishu.cn/base/bas_demo" }),
  });
  assert.equal(response.status, 200);
  assert.equal(received, "https://example.feishu.cn/base/bas_demo");
  assert.deepEqual(await response.json(), {
    baseToken: "bas_demo",
    baseName: "课程库",
    tables: [],
  });
});

test("passes a Wiki Base link to the injected read-only metadata reader", async (t) => {
  let received;
  const app = await start(assert.fail, undefined, {
    preview: async (url) => {
      received = url;
      return { baseToken: "bas_demo", baseName: "课程库", tables: [] };
    },
  });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/feishu/base-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://example.feishu.cn/wiki/wik_demo?table=tbl_chinese",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(received, "https://example.feishu.cn/wiki/wik_demo?table=tbl_chinese");
  assert.equal((await response.json()).baseToken, "bas_demo");
});

test("rejects an invalid Base preview request without echoing the URL", async (t) => {
  const app = await start(assert.fail, undefined, { preview: assert.fail });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/feishu/base-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.feishu.cn/docx/docx_secret" }),
  });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.equal(text.includes("docx_secret"), false);
  assert.deepEqual(JSON.parse(text), {
    error: { code: "INVALID_BASE_LINK", message: "Invalid Base link" },
  });
});

test("returns a controlled client error when a Wiki node is not a Base", async (t) => {
  const error = Object.assign(new Error("private Wiki node details"), {
    code: "FEISHU_WIKI_NOT_BASE",
    status: 400,
  });
  const app = await start(assert.fail, undefined, {
    preview: async () => { throw error; },
  });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/feishu/base-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.feishu.cn/wiki/wik_doc" }),
  });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.equal(text.includes("private Wiki node details"), false);
  assert.deepEqual(JSON.parse(text), {
    error: { code: "FEISHU_WIKI_NOT_BASE", message: "Bridge request failed" },
  });
});

test("sanitizes Base metadata SDK failures", async (t) => {
  const error = Object.assign(new Error("secret app token"), {
    code: "FEISHU_METADATA_READ_FAILED",
  });
  const app = await start(assert.fail, undefined, {
    preview: async () => { throw error; },
  });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/feishu/base-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.feishu.cn/base/bas_demo" }),
  });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.equal(text.includes("secret app token"), false);
  assert.deepEqual(JSON.parse(text), {
    error: { code: "FEISHU_METADATA_READ_FAILED", message: "Bridge request failed" },
  });
});

test("preserves the safe code for a missing selected Base table", async (t) => {
  const error = Object.assign(new Error("private table token"), {
    code: "FEISHU_TABLE_NOT_FOUND",
  });
  const app = await start(assert.fail, undefined, {
    preview: async () => { throw error; },
  });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/feishu/base-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.feishu.cn/base/bas_demo?table=tbl_missing" }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: { code: "FEISHU_TABLE_NOT_FOUND", message: "Bridge request failed" },
  });
});

test("syncs an enabled workflow subject through the loopback Bridge store", async (t) => {
  let received;
  const app = await start(assert.fail, undefined, undefined, {
    syncSubject: async (subject, options) => {
      received = { subject, options };
      return { ...subject, lifecycle: options.lifecycle };
    },
  }, { bridgeSecret: BRIDGE_SECRET });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/feishu/workflow/sync`, {
    method: "POST",
    headers: {
      ...TASKBOARD_WRITE_HEADERS,
      "x-feishu-bridge-secret": BRIDGE_SECRET,
      origin: "http://127.0.0.1:47823",
    },
    body: JSON.stringify({
      lifecycle: "enabled",
      expectedVersion: 1,
      subject: { subjectKey: "bas_sync:tbl_sync", tableId: "tbl_sync" },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(received.options.lifecycle, "enabled");
  assert.equal(received.options.expectedVersion, 1);
  assert.equal((await response.json()).subject.lifecycle, "enabled");
});

test("rejects non-loopback Host and Origin values before workflow sync", async (t) => {
  let calls = 0;
  const app = await start(assert.fail, undefined, undefined, {
    syncSubject: async (subject) => {
      calls += 1;
      return subject;
    },
  });
  t.after(app.close);
  const body = JSON.stringify({
    lifecycle: "enabled",
    subject: { subjectKey: "bas_sync:tbl_sync", tableId: "tbl_sync" },
  });

  const invalidHost = await postWithRawHeaders(
    `${app.url}/api/feishu/workflow/sync`,
    { ...TASKBOARD_WRITE_HEADERS, host: "attacker.example" },
    body,
  );
  const crossSiteOrigin = await fetch(`${app.url}/api/feishu/workflow/sync`, {
    method: "POST",
    headers: {
      ...TASKBOARD_WRITE_HEADERS,
      "content-type": "text/plain",
      origin: "https://attacker.example",
    },
    body,
  });

  assert.equal(invalidHost.status, 403);
  assert.equal(crossSiteOrigin.status, 403);
  assert.equal(calls, 0);
});

test("requires JSON and the Taskboard client header for workflow sync", async (t) => {
  let calls = 0;
  const app = await start(assert.fail, undefined, undefined, {
    syncSubject: async (subject) => {
      calls += 1;
      return subject;
    },
  });
  t.after(app.close);
  const body = JSON.stringify({
    lifecycle: "enabled",
    subject: { subjectKey: "bas_sync:tbl_sync", tableId: "tbl_sync" },
  });

  const nonJson = await fetch(`${app.url}/api/feishu/workflow/sync`, {
    method: "POST",
    headers: { "x-feishu-bridge-client": "taskboard" },
    body,
  });
  const missingClient = await fetch(`${app.url}/api/feishu/workflow/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const wrongClient = await fetch(`${app.url}/api/feishu/workflow/sync`, {
    method: "POST",
    headers: SIMULATION_WRITE_HEADERS,
    body,
  });

  assert.equal(nonJson.status, 415);
  assert.equal(missingClient.status, 403);
  assert.equal(wrongClient.status, 403);
  assert.equal(calls, 0);
});

test("serves health and configuration summary", async (t) => {
  const app = await start(assert.fail);
  t.after(app.close);
  const health = await (await fetch(`${app.url}/health`)).json();
  const summary = await (await fetch(`${app.url}/api/config-summary`)).json();
  assert.deepEqual(health, { ok: true });
  assert.deepEqual(summary, { tables: 1, packages: 1 });
});

test("serves real Feishu Base metadata only to the authenticated Taskboard", async (t) => {
  const metadataReader = createFeishuBaseMetadataReader({
    client: {
      bitable: {
        v1: {
          app: {
            get: async () => ({
              code: 0,
              data: { app: { app_token: "bas_demo", name: "课程 Base" } },
            }),
          },
          appTable: {
            list: async () => ({
              code: 0,
              data: { items: [{ table_id: "tbl_math", name: "数学" }] },
            }),
          },
          appTableField: {
            list: async () => ({
              code: 0,
              data: {
                items: [{
                  field_id: "fld_status",
                  field_name: "制作进度",
                  type: 3,
                  ui_type: "SingleSelect",
                  property: { options: [{ id: "opt_ready", name: "待剪辑" }] },
                }],
              },
            }),
          },
        },
      },
    },
  });
  const app = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    bridgeSecret: "bridge-secret",
    metadataReader,
  });
  const address = await app.listen();
  t.after(app.close);
  const url = `http://127.0.0.1:${address.port}/api/feishu/base-preview`;
  const body = JSON.stringify({
    url: "https://example.feishu.cn/base/bas_demo?table=tbl_math",
  });

  const denied = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(denied.status, 403);

  const allowed = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-feishu-bridge-client": "taskboard",
      "x-feishu-bridge-secret": "bridge-secret",
    },
    body,
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), {
    baseToken: "bas_demo",
    baseName: "课程 Base",
    tables: [{
      tableId: "tbl_math",
      tableName: "数学",
      fields: [{
        fieldId: "fld_status",
        fieldName: "制作进度",
        type: 3,
        uiType: "SingleSelect",
        options: [{ id: "opt_ready", name: "待剪辑" }],
      }],
    }],
  });
});

test("includes listener and queue health objects unchanged", async (t) => {
  const expected = {
    ok: true,
    feishuListener: { state: "sdk_managed", lastEventAt: 10, lastError: null },
    queue: { pending: 1, processing: 0, retryWait: 2, deadLetter: 3 },
  };
  const app = await start(assert.fail, () => expected);
  t.after(app.close);
  const health = await (await fetch(`${app.url}/health`)).json();
  assert.deepEqual(health, expected);
});

test("validates and handles a simulated event", async (t) => {
  let received;
  const app = await start(async (event) => {
    received = event;
    return { kind: "ready", taskIdentifier: "AUTO-1" };
  });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: { ...SIMULATION_WRITE_HEADERS, origin: "http://localhost:47823" },
    body: JSON.stringify({
      eventId: "evt_1",
      baseToken: "bas_demo",
      tableId: "tbl_a",
      recordId: "rec_1",
      fieldName: "视频整体进度",
      beforeValue: "素材齐全",
      afterValue: "待剪辑",
      fields: { 自动剪辑项目包: "Auto-cut-copyA" },
      deliverySource: "feishu",
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(received.eventId, "evt_1");
  assert.equal(received.deliverySource, "simulation");
});

test("disables simulation whenever the real listener or automatic execution is enabled", async (t) => {
  assert.equal(resolveSimulationEnabled({ listenerEnabled: false, automaticExecutionEnabled: false }), true);
  assert.equal(resolveSimulationEnabled({ listenerEnabled: true, automaticExecutionEnabled: false }), false);
  assert.equal(resolveSimulationEnabled({ listenerEnabled: false, automaticExecutionEnabled: true }), false);
  assert.equal(resolveSimulationEnabled({ listenerEnabled: "false", automaticExecutionEnabled: false }), false);

  let calls = 0;
  const app = await start(async () => {
    calls += 1;
    return { kind: "ignored" };
  }, undefined, undefined, undefined, { simulationEnabled: false });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: SIMULATION_WRITE_HEADERS,
    body: JSON.stringify({
      eventId: "evt_disabled",
      baseToken: "bas_demo",
      tableId: "tbl_a",
      recordId: "rec_1",
      fieldName: "视频整体进度",
      beforeValue: "素材齐全",
      afterValue: "待剪辑",
      fields: {},
    }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "SIMULATION_DISABLED");
  assert.equal(calls, 0);
});

test("simulation reevaluates the live Taskboard switch for each request and preserves nonproduction provenance", async (t) => {
  let automaticExecutionEnabled = true;
  let listenerEnabled = false;
  const received = [];
  let policyReads = 0;
  const taskboard = new TaskboardClient("http://127.0.0.1:47823", {
    fetchImplementation: async (url) => {
      assert.equal(url, "http://127.0.0.1:47823/api/meta");
      policyReads += 1;
      return Response.json({ capabilities: { automaticExecution: automaticExecutionEnabled } });
    },
  });
  const app = await start(async (event) => {
    received.push(event);
    return { kind: "ready", taskIdentifier: "AUTO-SIM" };
  }, undefined, undefined, undefined, {
    simulationEnabled: async () => listenerEnabled === false
      && (await taskboard.getAutomaticExecutionEnabled()) === false,
  });
  t.after(app.close);
  const post = () => fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST", headers: SIMULATION_WRITE_HEADERS,
    body: JSON.stringify({ eventId: "evt_dynamic", baseToken: "bas_demo", tableId: "tbl_a",
      recordId: "rec_1", fieldName: "进度", fields: {}, deliverySource: "feishu" }),
  });
  assert.equal((await post()).status, 403);
  automaticExecutionEnabled = false;
  assert.equal((await post()).status, 201);
  assert.equal(received.length, 1);
  assert.equal(received[0].deliverySource, "simulation");
  automaticExecutionEnabled = true;
  assert.equal((await post()).status, 403);
  automaticExecutionEnabled = false;
  listenerEnabled = true;
  assert.equal((await post()).status, 403);
  assert.equal(received.length, 1);
  assert.equal(policyReads, 3);
});

test("simulation fails closed with a safe error when the live policy cannot be read", async (t) => {
  let failRequest = true;
  const taskboard = new TaskboardClient("http://127.0.0.1:47823", {
    fetchImplementation: async () => {
      if (failRequest) throw new Error("private upstream error");
      return Response.json({ capabilities: { automaticExecution: "false" } });
    },
  });
  const app = await start(assert.fail, undefined, undefined, undefined, {
    simulationEnabled: async () => (await taskboard.getAutomaticExecutionEnabled()) === false,
  });
  t.after(app.close);
  for (failRequest of [true, false]) {
    const response = await fetch(`${app.url}/api/simulate/record-changed`, {
      method: "POST", headers: SIMULATION_WRITE_HEADERS, body: "{}",
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { code: "SIMULATION_POLICY_UNAVAILABLE", message: "Cannot verify the current automatic execution setting" },
    });
  }
});

test("rejects non-loopback Host and Origin values before simulation", async (t) => {
  let calls = 0;
  const app = await start(async () => {
    calls += 1;
    return { kind: "ignored" };
  });
  t.after(app.close);
  const body = JSON.stringify({
    eventId: "evt_cross_site",
    baseToken: "bas_demo",
    tableId: "tbl_a",
    recordId: "rec_1",
    fieldName: "视频整体进度",
    beforeValue: "素材齐全",
    afterValue: "待剪辑",
    fields: {},
  });

  const invalidHost = await postWithRawHeaders(
    `${app.url}/api/simulate/record-changed`,
    { ...SIMULATION_WRITE_HEADERS, host: "attacker.example" },
    body,
  );
  const crossSiteOrigin = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: {
      ...SIMULATION_WRITE_HEADERS,
      "content-type": "text/plain",
      origin: "https://attacker.example",
    },
    body,
  });

  assert.equal(invalidHost.status, 403);
  assert.equal(crossSiteOrigin.status, 403);
  assert.equal(calls, 0);
});

test("requires JSON and the local operator header for simulation", async (t) => {
  let calls = 0;
  const app = await start(async () => {
    calls += 1;
    return { kind: "ignored" };
  });
  t.after(app.close);
  const body = JSON.stringify({
    eventId: "evt_local_gate",
    baseToken: "bas_demo",
    tableId: "tbl_a",
    recordId: "rec_1",
    fieldName: "视频整体进度",
    beforeValue: "素材齐全",
    afterValue: "待剪辑",
    fields: {},
  });

  const nonJson = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: { "x-feishu-bridge-client": "local-operator" },
    body,
  });
  const missingClient = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const wrongClient = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: TASKBOARD_WRITE_HEADERS,
    body,
  });

  assert.equal(nonJson.status, 415);
  assert.equal(missingClient.status, 403);
  assert.equal(wrongClient.status, 403);
  assert.equal(calls, 0);
});

test("rejects incomplete simulated events", async (t) => {
  const app = await start(assert.fail);
  t.after(app.close);
  const response = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: SIMULATION_WRITE_HEADERS,
    body: JSON.stringify({ eventId: "evt_1" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_EVENT");
});

test("does not echo malformed JSON content in validation errors", async (t) => {
  const app = await start(assert.fail);
  t.after(app.close);
  const response = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: SIMULATION_WRITE_HEADERS,
    body: '{"value":secret-token-not-for-client}',
  });
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.equal(text.includes("secret-token-not-for-client"), false);
  assert.deepEqual(JSON.parse(text), {
    error: { code: "INVALID_EVENT", message: "Invalid simulated event" },
  });
});

test("returns 202 when a simulated event is durably pending retry", async (t) => {
  const app = await start(async () => ({
    kind: "pending",
    deliveryState: "retry_wait",
    attempts: 1,
    retryAt: 100,
  }));
  t.after(app.close);
  const response = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: SIMULATION_WRITE_HEADERS,
    body: JSON.stringify({
      eventId: "evt_retry",
      baseToken: "bas_demo",
      tableId: "tbl_a",
      recordId: "rec_1",
      fieldName: "视频整体进度",
      beforeValue: "素材齐全",
      afterValue: "待剪辑",
      fields: { 自动剪辑项目包: "Auto-cut-copyA" },
    }),
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).deliveryState, "retry_wait");
});

test("returns 202 when a simulated event is durably dead-lettered", async (t) => {
  const app = await start(async () => ({
    kind: "dead_letter",
    deliveryState: "dead_letter",
    attempts: 8,
    errorCode: "TASKBOARD_UNAVAILABLE",
  }));
  t.after(app.close);
  const response = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: SIMULATION_WRITE_HEADERS,
    body: JSON.stringify({
      eventId: "evt_dead_letter",
      baseToken: "bas_demo",
      tableId: "tbl_a",
      recordId: "rec_1",
      fieldName: "视频整体进度",
      beforeValue: "素材齐全",
      afterValue: "待剪辑",
      fields: { 自动剪辑项目包: "Auto-cut-copyA" },
    }),
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).deliveryState, "dead_letter");
});

test("returns 202 when a persisted dead letter is replayed", async (t) => {
  const app = await start(async () => ({
    kind: "dead_letter",
    deliveryState: "dead_letter",
    attempts: 8,
    errorCode: "TASKBOARD_UNAVAILABLE",
    duplicate: true,
  }));
  t.after(app.close);
  const response = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: SIMULATION_WRITE_HEADERS,
    body: JSON.stringify({
      eventId: "evt_dead_letter_replay",
      baseToken: "bas_demo",
      tableId: "tbl_a",
      recordId: "rec_1",
      fieldName: "视频整体进度",
      beforeValue: "素材齐全",
      afterValue: "待剪辑",
      fields: { 自动剪辑项目包: "Auto-cut-copyA" },
    }),
  });
  assert.equal(response.status, 202);
});

test("sanitizes unexpected simulation failures", async (t) => {
  const app = await start(async () => {
    throw Object.assign(new Error("secret-token\nnot-for-client"), {
      code: "fake-app-secret-do-not-log",
    });
  });
  t.after(app.close);
  const response = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: SIMULATION_WRITE_HEADERS,
    body: JSON.stringify({
      eventId: "evt_failure",
      baseToken: "bas_demo",
      tableId: "tbl_a",
      recordId: "rec_1",
      fieldName: "视频整体进度",
      beforeValue: "素材齐全",
      afterValue: "待剪辑",
      fields: { 自动剪辑项目包: "Auto-cut-copyA" },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.deepEqual(body, {
    error: { code: "BRIDGE_FAILURE", message: "Bridge request failed" },
  });
});
