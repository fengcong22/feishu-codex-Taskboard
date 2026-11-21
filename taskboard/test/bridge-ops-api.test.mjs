import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const SECRET = "bridge-ops-secret";
const WEB = { "content-type": "application/json", "x-taskboard-client": "web" };

async function fixture(reply) {
  const requests = [];
  const bridge = createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      route: incoming.url, method: incoming.method,
      client: incoming.headers["x-feishu-bridge-client"],
      secret: incoming.headers["x-feishu-bridge-secret"], body,
    });
    const { status = 200, payload } = reply(incoming.url, body);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-bridge-ops-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuPackages: { packages: {} },
    feishuWorkflowSync: async () => ({ ok: true }),
    feishuBridgeUrl: `http://127.0.0.1:${bridge.address().port}`,
    feishuBridgeSecret: SECRET,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      await app.close();
      await new Promise((resolve) => bridge.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function call(baseUrl, route, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("delivery issues are read through the authenticated Bridge route and re-sanitized", async () => {
  const data = await fixture(() => ({ payload: {
    total: 2,
    items: [
      { eventId: "evt_1", deliveryState: "dead_letter", source: "feishu", tableId: "tbl_1", recordId: "rec_1",
        recordTitle: "课程 A", errorCode: "DELIVERY_FAILED", attempts: 1, nextAttemptAt: null,
        createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_100, acknowledgedAt: null, secret: "leak" },
      { eventId: "../bad", deliveryState: "dead_letter" },
      { eventId: "evt_2", deliveryState: "succeeded" },
    ],
  } }));
  try {
    const result = await call(data.baseUrl, "/api/local/feishu/bridge/delivery-issues");
    assert.equal(result.status, 200);
    assert.equal(result.body.total, 2);
    assert.deepEqual(result.body.items, [{
      eventId: "evt_1", deliveryState: "dead_letter", source: "feishu", tableId: "tbl_1", recordId: "rec_1",
      recordTitle: "课程 A", errorCode: "DELIVERY_FAILED", attempts: 1, nextAttemptAt: null,
      createdAt: new Date(1_700_000_000_000).toISOString(), updatedAt: new Date(1_700_000_000_100).toISOString(),
      acknowledgedAt: null,
    }]);
    assert.deepEqual(data.requests, [{
      route: "/api/local/bridge/delivery-issues", method: "GET", client: "taskboard", secret: SECRET, body: "",
    }]);
    assert.doesNotMatch(JSON.stringify(result.body), /leak|bridge-ops-secret/);
  } finally {
    await data.close();
  }
});

test("dead-letter acknowledgement needs an explicit web request with valid ids", async () => {
  const data = await fixture((route, body) => ({ payload: { acknowledged: JSON.parse(body).eventIds, skipped: [] } }));
  try {
    const route = "/api/local/feishu/bridge/dead-letters/acknowledge";
    const noClient = await call(data.baseUrl, route, { method: "POST", headers: { "content-type": "application/json" }, body: { eventIds: ["evt_1"] } });
    assert.equal(noClient.status, 403);
    const crossSite = await call(data.baseUrl, route, { method: "POST", headers: { ...WEB, origin: "https://example.com" }, body: { eventIds: ["evt_1"] } });
    assert.equal(crossSite.status, 403);
    for (const body of [{ eventIds: [] }, { eventIds: ["../x"] }, { eventIds: ["evt_1"], force: true }]) {
      assert.equal((await call(data.baseUrl, route, { method: "POST", headers: WEB, body })).status, 400);
    }
    assert.equal(data.requests.length, 0);

    const accepted = await call(data.baseUrl, route, { method: "POST", headers: WEB, body: { eventIds: ["evt_1", "evt_2"] } });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, { acknowledged: ["evt_1", "evt_2"], skipped: [] });
    assert.deepEqual(data.requests.map(({ route: r, secret, body }) => ({ r, secret, body })), [{
      r: "/api/local/bridge/dead-letters/acknowledge", secret: SECRET, body: JSON.stringify({ eventIds: ["evt_1", "evt_2"] }),
    }]);
  } finally {
    await data.close();
  }
});

test("listener start forwards an empty body and passes through only a safe Bridge failure code", async () => {
  let fail = false;
  const data = await fixture(() => (fail
    ? { status: 409, payload: { error: { code: "FEISHU_CREDENTIALS_MISSING", message: "detail" } } }
    : { payload: { feishuListener: { state: "sdk_managed", lastEventAt: null, lastError: null } } }));
  try {
    const route = "/api/local/feishu/bridge/listener/start";
    assert.equal((await call(data.baseUrl, route, { method: "POST", headers: WEB, body: { appId: "x" } })).status, 400);
    assert.equal((await call(data.baseUrl, route)).status, 405);
    const started = await call(data.baseUrl, route, { method: "POST", headers: WEB, body: {} });
    assert.equal(started.status, 200);
    assert.deepEqual(started.body, { listener: { state: "sdk_managed" } });
    fail = true;
    const failed = await call(data.baseUrl, route, { method: "POST", headers: WEB, body: {} });
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error.code, "FEISHU_CREDENTIALS_MISSING");
    assert.deepEqual(data.requests.map(({ route: r, body }) => ({ r, body })), [
      { r: "/api/local/bridge/listener/start", body: "{}" },
      { r: "/api/local/bridge/listener/start", body: "{}" },
    ]);
  } finally {
    await data.close();
  }
});
