import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTaskboardServer } from "../server/index.mjs";

const route = "/api/local/settings/automatic-execution";
async function fixture(t, initial = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automatic-setting-"));
  let app;
  async function start(value = initial) {
    app = createTaskboardServer({ dataDirectory: directory, allowAutomaticExecution: value, codexExecutable: process.execPath });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    return `http://127.0.0.1:${address.port}`;
  }
  const baseUrl = await start();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { baseUrl, get app() { return app; }, async restart(value) { await app.close(); return start(value); } };
}
async function save(baseUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(baseUrl + route, { method: "PUT", headers: { "content-type": "application/json", "x-taskboard-client": "web", ...headers } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("local automatic execution settings save immediately, reject stale writes and survive restart", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await fetch(f.baseUrl + route).then(r => r.json()), { setting: { enabled: false, version: 1 } });
  const saved = await save(f.baseUrl, { enabled: true, expectedVersion: 1 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.setting, { enabled: true, version: 2 });
  assert.equal((await fetch(f.baseUrl + "/api/meta").then(r => r.json())).capabilities.automaticExecution, true);
  const stale = await save(f.baseUrl, { enabled: false, expectedVersion: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  const disabled = await save(f.baseUrl, { enabled: false, expectedVersion: 2 });
  assert.equal(disabled.status, 200);
  const restartedUrl = await f.restart(true);
  assert.deepEqual(await fetch(restartedUrl + route).then(r => r.json()), { setting: { enabled: false, version: 3 } });
  assert.equal((await fetch(restartedUrl + "/api/meta").then(r => r.json())).capabilities.automaticExecution, false);
});

test("existing environment policy supplies only the unsaved setting default", async (t) => {
  const f = await fixture(t, true);
  assert.deepEqual(await fetch(f.baseUrl + route).then(r => r.json()), { setting: { enabled: true, version: 1 } });
  assert.equal((await save(f.baseUrl, { enabled: false, expectedVersion: 1 })).status, 200);
  assert.equal((await fetch(f.baseUrl + "/api/meta").then(r => r.json())).capabilities.automaticExecution, false);
});

test("automatic execution settings reject invalid bodies, nonlocal origins and missing web intent", async (t) => {
  const f = await fixture(t);
  for (const body of [{ enabled: "true", expectedVersion: 1 }, { enabled: true }, { enabled: true, expectedVersion: 0 }, { enabled: true, expectedVersion: 1, workspacePath: "untrusted" }]) {
    assert.equal((await save(f.baseUrl, body)).status, 400);
  }
  for (const headers of [{ "x-taskboard-client": "feishu-bridge" }, { "x-taskboard-client": "" }, { origin: "http://192.168.1.2" }, { host: "192.168.1.2" }, { origin: "null" }, { "content-type": "text/plain" }]) {
    const response = await save(f.baseUrl, { enabled: true, expectedVersion: 1 }, headers);
    assert.ok([403, 415].includes(response.status), JSON.stringify({ headers, response }));
  }
  assert.equal((await fetch(f.baseUrl + route).then(r => r.json())).setting.enabled, false);
});

test("corrupt stored automatic settings fail closed instead of inheriting enabled environment", async (t) => {
  const f = await fixture(t, true);
  f.app.database.database.prepare("INSERT INTO taskboard_settings (key,value_json,version,updated_at) VALUES ('automatic-execution','{}',1,'fixture')").run();
  assert.equal((await fetch(f.baseUrl + "/api/meta").then(r => r.json())).capabilities.automaticExecution, false);
  assert.equal((await fetch(f.baseUrl + route)).status, 503);
  assert.equal((await save(f.baseUrl, { enabled: true, expectedVersion: 1 })).status, 503);
});
