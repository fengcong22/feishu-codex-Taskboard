import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTaskboardServer } from "../server/index.mjs";
import { ApiError } from "../server/database.mjs";

const SUBJECT = "bas_profile_http:tbl_subject";
const SUBJECT_ROUTE = `/api/local/feishu/workflow/subjects/${encodeURIComponent(SUBJECT)}`;
const profileRoute = (alias) => `/api/local/feishu/subjects/${encodeURIComponent(SUBJECT)}/package-workflow-drafts/${alias}`;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-profile-http-"));
  const workspacePath = path.join(directory, "example-package");
  await mkdir(workspacePath);
  const syncs = [];
  let rejectSync = false;
  const app = createTaskboardServer({
    dataDirectory: path.join(directory, "data"),
    codexExecutable: process.execPath,
    feishuPackages: { packages: {
      "Auto-cut-A": { projectId: "example-a", workspacePath, prompt: "offline fixture" },
      "Auto-cut-B": { projectId: "example-b", workspacePath, prompt: "offline fixture" },
    } },
    feishuWorkflowSync: async (subject) => {
      if (rejectSync) throw new ApiError(503, "FEISHU_BRIDGE_UNAVAILABLE", "Offline fixture unavailable");
      syncs.push(structuredClone(subject));
      return { ok: true };
    },
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  async function request(route, options = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers: { "content-type": "application/json", ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const body = await response.text();
    return { status: response.status, body: body ? JSON.parse(body) : null };
  }
  const created = await request("/api/local/feishu/workflow/catalog", { method: "POST", body: {
    baseToken: "bas_profile_http", baseName: "独立测试", tables: [{ tableId: "tbl_subject", tableName: "测试学科", fields: [
      { fieldId: "fld_title", fieldName: "课程名称", type: 1, uiType: "Text", options: [] },
      { fieldId: "fld_status", fieldName: "状态", type: 3, uiType: "SingleSelect", options: [{ id: "opt_ready", name: "待剪辑" }] },
    ] }],
  } });
  assert.equal(created.status, 201);
  return { app, request, syncs, baseUrl, setRejectSync(value) { rejectSync = value; } };
}

test("HTTP package profiles keep active A while saving B, then atomically enable B with global history", async (t) => {
  const f = await fixture(t);
  const discovered = (await f.request(SUBJECT_ROUTE)).body.subject;
  assert.equal(discovered.packageRoute.packageAlias, null);
  const unconfigured = await f.request(`${SUBJECT_ROUTE}/enable`, { method: "POST", body: { expectedVersion: discovered.configVersion } });
  assert.equal(unconfigured.status, 409);
  assert.equal(unconfigured.body.error.code, "PACKAGE_ALIAS_REQUIRED");
  assert.equal(f.syncs.length, 0);
  const configured = await f.request(SUBJECT_ROUTE, { method: "PATCH", body: {
    expectedVersion: discovered.configVersion,
    packageRoute: { ...discovered.packageRoute, packageAlias: "Auto-cut-A" },
  } });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const initial = configured.body.subject;
  const enabledA = await f.request(`${SUBJECT_ROUTE}/enable`, { method: "POST", body: { expectedVersion: initial.configVersion } });
  assert.equal(enabledA.status, 200, JSON.stringify(enabledA.body));
  const activeA = enabledA.body.subject;
  assert.equal(activeA.activePackageAlias, "Auto-cut-A");
  const readA = await f.request(profileRoute("Auto-cut-A"));
  const readB = await f.request(profileRoute("Auto-cut-B"));
  assert.equal(readA.status, 200);
  assert.equal(readB.status, 200);
  const configB = { ...readA.body.config, packageRoute: { ...readA.body.config.packageRoute, packageAlias: "Auto-cut-B" } };
  const savedB = await f.request(profileRoute("Auto-cut-B"), { method: "PUT", body: { expectedRevision: readB.body.revision, config: configB } });
  assert.equal(savedB.status, 200);
  const afterSave = (await f.request(SUBJECT_ROUTE)).body.subject;
  assert.deepEqual({ ...afterSave, preferredPackageAlias: activeA.preferredPackageAlias }, activeA);
  assert.equal(afterSave.preferredPackageAlias, "Auto-cut-B");
  assert.equal(f.syncs.length, 1);
  assert.deepEqual((await f.request(profileRoute("Auto-cut-A"))).body, readA.body);
  const activation = { expectedVersion: activeA.configVersion, expectedRevision: savedB.body.revision };
  for (const stale of [
    { ...activation, expectedRevision: readB.body.revision },
    { ...activation, expectedVersion: initial.configVersion },
  ]) {
    const result = await f.request(`${profileRoute("Auto-cut-B")}/enable`, { method: "POST", body: stale });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "VERSION_CONFLICT");
    assert.deepEqual((await f.request(SUBJECT_ROUTE)).body.subject, afterSave);
  }
  f.setRejectSync(true);
  const rejected = await f.request(`${profileRoute("Auto-cut-B")}/enable`, { method: "POST", body: activation });
  assert.ok(rejected.status >= 400);
  assert.deepEqual((await f.request(SUBJECT_ROUTE)).body.subject, afterSave);
  assert.deepEqual((await f.request(profileRoute("Auto-cut-B"))).body, savedB.body);
  f.setRejectSync(false);
  const activated = await f.request(`${profileRoute("Auto-cut-B")}/enable`, { method: "POST", body: activation });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.subject.activePackageAlias, "Auto-cut-B");
  assert.equal(activated.body.subject.activeConfigVersion, activeA.configVersion + 1);
  assert.equal(activated.body.subject.configVersion, activeA.configVersion + 1);
  assert.equal(f.syncs.length, 2);
  assert.equal(f.syncs[1].packageRoute.packageAlias, "Auto-cut-B");
  const versions = f.app.database.database.prepare("SELECT version, snapshot_json, closed_at FROM feishu_subject_versions WHERE subject_key = ? ORDER BY version").all(SUBJECT);
  const oldActive = versions.find((row) => row.version === activeA.configVersion);
  assert.equal(JSON.parse(oldActive.snapshot_json).packageRoute.packageAlias, "Auto-cut-A");
  assert.ok(oldActive.closed_at);
  assert.equal(versions.at(-1).closed_at, null);
  assert.equal(f.app.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
});

test("profile activation HTTP boundary rejects query, unknown fields, origin, host and unsupported method", async (t) => {
  const f = await fixture(t);
  const route = `${profileRoute("Auto-cut-A")}/enable`;
  const before = (await f.request(SUBJECT_ROUTE)).body.subject;
  for (const [target, options, status, code] of [
    [`${route}?token=fixture-private`, { method: "POST", body: {} }, 400, "UNKNOWN_QUERY_PARAMETER"],
    [route, { method: "POST", headers: { origin: "https://untrusted.example" }, body: {} }, 403, "INVALID_ORIGIN"],
    [route, { method: "POST", body: { expectedRevision: 0, expectedVersion: before.configVersion, token: "fixture-private" } }, 400, "UNKNOWN_FIELD"],
    [route, {}, 405, "METHOD_NOT_ALLOWED"],
  ]) {
    const result = await f.request(target, options);
    assert.equal(result.status, status);
    assert.equal(result.body.error.code, code);
    assert.doesNotMatch(JSON.stringify(result.body), /fixture-private/);
  }
  const invalidHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.baseUrl}${route}`, { method: "POST", headers: { host: "untrusted.example", "content-type": "application/json" } }, async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch (error) { reject(error); }
    });
    request.once("error", reject);
    request.end("{}");
  });
  assert.equal(invalidHost.status, 403);
  assert.equal(invalidHost.body.error.code, "INVALID_HOST");
  assert.deepEqual((await f.request(SUBJECT_ROUTE)).body.subject, before);
  assert.equal(f.syncs.length, 0);
});
