import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTaskboardServer } from "../server/index.mjs";
import { listenTaskboardOnFetchSafePort } from "../../test/fetch-safe-listen.mjs";

const route = "/api/local/vm-downloads";
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-api-"));
  let app;
  async function start() {
    app = createTaskboardServer({ dataDirectory: directory, codexExecutable: process.execPath, processEnv: {} });
    const address = await listenTaskboardOnFetchSafePort(app);
    return `http://127.0.0.1:${address.port}`;
  }
  const baseUrl = await start();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { baseUrl, directory, async restart() { await app.close(); return start(); } };
}
async function call(baseUrl, suffix = "", { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(baseUrl + route + suffix, { method, headers: { "content-type": "application/json", "x-taskboard-client": "web", ...headers } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) })); response.on("error", reject);
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
test("local downloads API saves settings and persistent batch jobs without granting task execution", async (t) => {
  const f = await fixture(t);
  const initial = await call(f.baseUrl);
  assert.equal(initial.status, 200); assert.equal(initial.body.session.status, "disconnected");
  assert.deepEqual(initial.body.jobs, []);
  const fields = { department: "动画组", reason: "切片剪辑", outputRoot: f.directory };
  assert.equal((await call(f.baseUrl, "/settings", { method: "PUT", body: { ...fields, notificationsEnabled: false } })).status, 200);
  const job = await call(f.baseUrl, "/jobs", { method: "POST", body: { ...fields, vmids: ["678465c3d94605d24bb9361a"] } });
  assert.equal(job.status, 201); assert.equal(job.body.jobs.length, 1); assert.equal(job.body.jobs[0].status, "queued");
  assert.equal(job.body.jobs[0].output_root, f.directory);
  const restarted = await call(await f.restart());
  assert.equal(restarted.body.jobs.length, 1); assert.equal(restarted.body.settings.notificationsEnabled, false);
});
test("VM local routes reject nonlocal Host/Origin, query, missing web intent and untrusted source fields", async (t) => {
  const f = await fixture(t);
  const body = { vmids: ["678465c3d94605d24bb9361a"], department: "动画组", reason: "切片剪辑", outputRoot: f.directory };
  for (const headers of [{ origin: "https://evil.test" }, { origin: "null" }, { host: "evil.test" }, { "x-taskboard-client": "" }, { "content-type": "text/plain" }, { origin: "app://-" }]) {
    assert.ok([403, 415].includes((await call(f.baseUrl, "/jobs", { method: "POST", body, headers })).status));
  }
  assert.equal((await call(f.baseUrl, "?token=bad")).status, 400);
  assert.equal((await call(f.baseUrl, "/jobs", { method: "POST", body: { ...body, private_endpoints: [] } })).status, 400);
  assert.equal((await call(f.baseUrl, "/logout", { method: "POST", body: { token: "bad" } })).status, 400);
  assert.equal((await call(f.baseUrl)).body.jobs.length, 0);
});

test("VM acquisition recovery accepts only the explicit repeatable-resource confirmation payload", async (t) => {
  const f = await fixture(t);
  assert.equal((await call(f.baseUrl, "/jobs/missing/recover", { method: "POST", body: { confirmRepeatableResource: false } })).status, 400);
  assert.equal((await call(f.baseUrl, "/jobs/missing/recover", { method: "POST", body: { confirmRepeatableResource: true, privateEndpoints: [] } })).status, 400);
  const missing = await call(f.baseUrl, "/jobs/missing/recover", { method: "POST", body: { confirmRepeatableResource: true } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "VM_APPROVAL_JOB_NOT_FOUND");
});

test("VM queue cleanup validates a bounded id list and rejects unsettled jobs", async (t) => {
  const f = await fixture(t);
  const fields = { department: "动画组", reason: "切片剪辑", outputRoot: f.directory };
  const queued = await call(f.baseUrl, "/jobs", { method: "POST", body: { ...fields, vmids: ["678465c3d94605d24bb9361a"] } });
  const id = queued.body.jobs[0].id;

  const invalid = await call(f.baseUrl, "/jobs/cleanup", { method: "POST", body: { jobIds: [id], force: true } });
  assert.equal(invalid.status, 400);
  const malformed = await call(f.baseUrl, "/jobs/cleanup", { method: "POST", body: { jobIds: ["../queue"] } });
  assert.equal(malformed.status, 400);
  const active = await call(f.baseUrl, "/jobs/cleanup", { method: "POST", body: { jobIds: [id] } });
  assert.equal(active.status, 409);
  assert.equal(active.body.error.code, "VM_APPROVAL_QUEUE_ITEM_NOT_CLEARABLE");
  assert.equal((await call(f.baseUrl)).body.jobs[0].id, id);
});
