import assert from "node:assert/strict";
import test from "node:test";

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
