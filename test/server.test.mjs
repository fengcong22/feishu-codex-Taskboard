import assert from "node:assert/strict";
import test from "node:test";

import { createFeishuBaseMetadataReader } from "../src/feishu-base-metadata.mjs";
import { createBridgeServer } from "../src/server.mjs";

async function start(handler, getHealth) {
  const app = createBridgeServer({
    host: "127.0.0.1",
    port: 0,
    configSummary: { tables: 1, packages: 1 },
    handleEvent: handler,
    getHealth,
  });
  const address = await app.listen();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: app.close,
  };
}

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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: "evt_1",
      baseToken: "bas_demo",
      tableId: "tbl_a",
      recordId: "rec_1",
      fieldName: "视频整体进度",
      beforeValue: "素材齐全",
      afterValue: "待剪辑",
      fields: { 自动剪辑项目包: "Auto-cut-copyA" },
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(received.eventId, "evt_1");
});

test("rejects incomplete simulated events", async (t) => {
  const app = await start(assert.fail);
  t.after(app.close);
  const response = await fetch(`${app.url}/api/simulate/record-changed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
    headers: { "content-type": "application/json" },
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
    headers: { "content-type": "application/json" },
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
    headers: { "content-type": "application/json" },
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
    headers: { "content-type": "application/json" },
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
    headers: { "content-type": "application/json" },
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
