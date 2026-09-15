import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { createFeishuPackageStore } from "../server/feishu-package-config.mjs";

const alias = "Auto-cut-restore-fixture";
const actor = { type: "user", id: "fixture", name: "Fixture", avatarUrl: null };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-restore-"));
  let app;
  const store = createFeishuPackageStore({
    packages: { [alias]: { alias, projectId: "fixture-package", state: "enabled",
      workspacePath: directory, model: "fixture-model", reasoningEffort: "low", prompt: "Fixture only" } },
    listReferences: (value) => app.database.listPackageReferences(value),
  });
  app = createTaskboardServer({ dataDirectory: directory, feishuPackageStore: store,
    allowAutomaticExecution: true, codexExecutable: process.execPath });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = async (route, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const origin = { source: "feishu-base", eventId: "evt-restore", baseToken: "base-fixture",
    tableId: "table-fixture", recordId: "record-fixture", packageAlias: alias, mode: "automatic" };
  const record = await store.get(alias);
  const create = (registered = true) => app.database.createTask({
    projectId: "local", title: "Restore fixture", status: "todo", priority: "none",
    labels: ["feishu"], actor, assignee: actor, startDate: null, dueDate: null,
    description: `<!-- feishu-codex-task:v1:${Buffer.from(JSON.stringify({ version: 1, ...origin })).toString("base64url")} -->`,
    ...(registered ? { feishuOrigin: origin, packageSnapshot: {
      packageAlias: alias, packageRevision: record.revision, name: record.name,
      projectId: record.projectId, workspacePath: record.workspacePath,
      model: record.model, reasoningEffort: record.reasoningEffort, prompt: record.prompt,
      zipSourceDirectory: null, maxConcurrent: record.maxConcurrent,
    } } : {}),
  });
  const archive = async (task) => {
    const result = await request(`/api/tasks/${task.id}/archive`, "POST", { version: task.version });
    assert.equal(result.status, 200);
    return result.body.task;
  };
  return { app, store, request, create, archive };
}

test("archived tasks release package references without losing provenance or snapshots", async (t) => {
  const { app, request, create, archive } = await fixture(t);
  const task = create();
  const origin = app.database.getFeishuTaskOrigin(task.id);
  const snapshot = app.database.getFeishuTaskPackageSnapshot(task.id);
  const archived = await archive(task);
  assert.equal(archived.status, "todo");
  const listed = await request("/api/local/autocut/packages");
  assert.equal(listed.body.packages[0].referenceCount, 0);
  const removed = await request(`/api/local/autocut/packages/${alias}`, "DELETE", { revision: 1 });
  assert.equal(removed.status, 200);
  assert.deepEqual(app.database.getTask(task.id), archived);
  assert.deepEqual(app.database.getFeishuTaskOrigin(task.id), origin);
  assert.deepEqual(app.database.getFeishuTaskPackageSnapshot(task.id), snapshot);
  assert.equal(app.database.findFeishuTaskByEventId(origin.eventId).id, task.id);
  const restored = await request(`/api/tasks/${task.id}/restore`, "POST", { version: archived.version });
  assert.equal(restored.status, 409);
  assert.equal(restored.body.error.code, "PACKAGE_NOT_FOUND");
  assert.deepEqual(app.database.getTask(task.id), archived);
});

for (const state of ["missing", "disabled", "draft"]) {
  test(`restoring a registered task rejects a ${state} package without changing the task`, async (t) => {
    const { app, store, request, create, archive } = await fixture(t);
    const archived = await archive(create());
    const snapshot = app.database.getFeishuTaskPackageSnapshot(archived.id);
    const record = await store.get(alias);
    store.setInline(state === "missing" ? {} : { [alias]: { ...record, state } });
    const result = await request(`/api/tasks/${archived.id}/restore`, "POST", { version: archived.version });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, state === "missing" ? "PACKAGE_NOT_FOUND" : "PACKAGE_DISABLED");
    assert.deepEqual(app.database.getTask(archived.id), archived);
    assert.deepEqual(app.database.getFeishuTaskPackageSnapshot(archived.id), snapshot);
    assert.equal(app.database.getFeishuExecution(archived.id), null);
  });
}

test("restoring with an enabled package preserves the snapshot and does not schedule execution", async (t) => {
  const { app, request, create, archive } = await fixture(t);
  const archived = await archive(create());
  const snapshot = app.database.getFeishuTaskPackageSnapshot(archived.id);
  const result = await request(`/api/tasks/${archived.id}/restore`, "POST", { version: archived.version });
  assert.equal(result.status, 200);
  assert.equal(result.body.task.archivedAt, null);
  assert.equal(result.body.task.version, archived.version + 1);
  assert.deepEqual(app.database.getFeishuTaskPackageSnapshot(archived.id), snapshot);
  assert.equal(app.database.getFeishuExecution(archived.id), null);
  const removed = await request(`/api/local/autocut/packages/${alias}`, "DELETE", { revision: 1 });
  assert.equal(removed.status, 409);
  assert.equal(removed.body.error.code, "PACKAGE_IN_USE");
});

test("ordinary tasks with copied Feishu markers restore without acquiring trusted origin", async (t) => {
  const { app, store, request, create, archive } = await fixture(t);
  const archived = await archive(create(false));
  store.setInline({});
  const result = await request(`/api/tasks/${archived.id}/restore`, "POST", { version: archived.version });
  assert.equal(result.status, 200);
  assert.equal(app.database.getFeishuTaskOrigin(archived.id), null);
  assert.equal(app.database.getFeishuExecution(archived.id), null);
  const start = await request(`/api/tasks/${archived.id}/start-ai`, "POST", {});
  assert.equal(start.status, 409);
  assert.equal(start.body.error.code, "TASK_NOT_STARTABLE");
});

test("removing visible markers cannot bypass the registered package check on restore", async (t) => {
  const { app, store, request, create, archive } = await fixture(t);
  const task = create();
  app.database.database.prepare("UPDATE tasks SET description = '', labels = '[]' WHERE id = ?").run(task.id);
  const archived = await archive(app.database.getTask(task.id));
  await store.disable(alias, 1);
  const result = await request(`/api/tasks/${archived.id}/restore`, "POST", { version: archived.version });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "PACKAGE_DISABLED");
  assert.deepEqual(app.database.getTask(task.id), archived);
});

test("restore keeps optimistic version checks and archived-state checks", async (t) => {
  const { request, create, archive } = await fixture(t);
  const task = create();
  const active = await request(`/api/tasks/${task.id}/restore`, "POST", { version: task.version });
  assert.equal(active.body.error.code, "TASK_NOT_ARCHIVED");
  const archived = await archive(task);
  const stale = await request(`/api/tasks/${task.id}/restore`, "POST", { version: task.version });
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  assert.equal(archived.version, task.version + 1);
});

test("restore rechecks the task after a delayed request body while archive and deletion complete", { timeout: 10_000 }, async (t) => {
  const { app, store, request, create, archive } = await fixture(t);
  const task = create();
  let readingBody;
  const bodyStarted = new Promise((resolve) => { readingBody = resolve; });
  // Observe the real body reader without sleeps or replacing database operations.
  app.server.prependOnceListener("request", (incoming) => {
    const iterate = incoming[Symbol.asyncIterator].bind(incoming);
    incoming[Symbol.asyncIterator] = async function* () {
      readingBody();
      yield* iterate();
    };
  });
  const outgoing = httpRequest({
    hostname: "127.0.0.1", port: app.server.address().port,
    path: `/api/tasks/${task.id}/restore`, method: "POST",
    headers: { "content-type": "application/json" },
  });
  const response = new Promise((resolve, reject) => {
    outgoing.on("error", reject);
    outgoing.on("response", async (incoming) => {
      try {
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
      } catch (error) { reject(error); }
    });
  });
  outgoing.flushHeaders();
  try {
    await bodyStarted;
    const archived = await archive(task);
    const removed = await request(`/api/local/autocut/packages/${alias}`, "DELETE", { revision: 1 });
    assert.equal(removed.status, 200);
    assert.equal(await store.get(alias), null);
    outgoing.end(JSON.stringify({ version: archived.version }));
    const result = await response;
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "PACKAGE_NOT_FOUND");
    assert.deepEqual(app.database.getTask(task.id), archived);
  } finally {
    outgoing.destroy();
    await response.catch(() => {});
  }
});
