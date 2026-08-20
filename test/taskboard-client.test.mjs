import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { TaskboardClient, TaskboardError } from "../src/taskboard-client.mjs";

function invalidResponse(error) {
  return error instanceof TaskboardError
    && error.code === "TASKBOARD_INVALID_RESPONSE"
    && error.status === 502;
}

async function fixture(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("creates a project and a task with exact JSON bodies", async (t) => {
  const calls = [];
  const app = await fixture(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null });
    response.writeHead(request.url === "/api/projects" ? 201 : 201, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/api/projects"
      ? { project: { id: "auto-a" } }
      : { task: { id: "task_1", identifier: "AUTO-1" } }));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  await client.ensureProject({ id: "auto-a", name: "Auto A", workspacePath: "D:\\AutoA" });
  const task = await client.createTask({ projectId: "auto-a", title: "待剪辑" });
  assert.equal(task.identifier, "AUTO-1");
  assert.deepEqual(calls, [
    { method: "POST", url: "/api/projects", body: { id: "auto-a", name: "Auto A", workspacePath: "D:\\AutoA" } },
    { method: "POST", url: "/api/tasks", body: { projectId: "auto-a", title: "待剪辑" } },
  ]);
});

test("treats PROJECT_EXISTS as a successful ensure", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "PROJECT_EXISTS", message: "exists" } }));
  });
  t.after(app.close);
  await new TaskboardClient(app.url).ensureProject({ id: "auto-a", name: "Auto A", workspacePath: "D:\\AutoA" });
});

test("does not swallow PROJECT_EXISTS from a non-conflict response", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "PROJECT_EXISTS", message: "temporarily unavailable" } }));
  });
  t.after(app.close);
  await assert.rejects(
    () => new TaskboardClient(app.url).ensureProject({ id: "auto-a", name: "Auto A", workspacePath: "D:\\AutoA" }),
    (error) => error instanceof TaskboardError
      && error.code === "PROJECT_EXISTS"
      && error.status === 503,
  );
});

test("rejects successful project responses without a non-empty matching id", async (t) => {
  const responses = [
    { project: { id: " " } },
    { project: { id: "other-project" } },
  ];
  const app = await fixture((_request, response) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify(responses.shift()));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  await assert.rejects(
    () => client.ensureProject({ id: " ", name: "Invalid", workspacePath: "D:\\Invalid" }),
    invalidResponse,
  );
  await assert.rejects(
    () => client.ensureProject({ id: "auto-a", name: "Auto A", workspacePath: "D:\\AutoA" }),
    invalidResponse,
  );
});

test("surfaces structured Taskboard errors", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "INVALID_FIELD", message: "bad" } }));
  });
  t.after(app.close);
  await assert.rejects(
    () => new TaskboardClient(app.url).createTask({}),
    (error) => error instanceof TaskboardError && error.code === "INVALID_FIELD",
  );
});

test("maps unknown downstream error codes to a safe Taskboard code", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: { code: "fake-app-secret-do-not-log", message: "temporarily unavailable" },
    }));
  });
  t.after(app.close);
  await assert.rejects(
    () => new TaskboardClient(app.url).createTask({}),
    (error) => error instanceof TaskboardError
      && error.code === "TASKBOARD_REQUEST_FAILED"
      && error.status === 503,
  );
});

test("rejects successful task responses without non-empty ids", async (t) => {
  const responses = [
    { task: { identifier: "AUTO-1" } },
    { task: { id: "task_1", identifier: " " } },
  ];
  const app = await fixture((_request, response) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify(responses.shift()));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  await assert.rejects(() => client.createTask({}), invalidResponse);
  await assert.rejects(() => client.createTask({}), invalidResponse);
});

test("finds an existing Feishu task by its server-owned event metadata", async (t) => {
  const encoded = Buffer.from(JSON.stringify({ source: "feishu-base", eventId: "evt_1" }), "utf8")
    .toString("base64url");
  const calls = [];
  const app = await fixture((request, response) => {
    calls.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ tasks: [
      { id: "task_other", description: "unrelated" },
      { id: "task_existing", identifier: "AUTO-7", description: `<!-- feishu-codex-task:v1:${encoded} -->` },
    ] }));
  });
  t.after(app.close);
  const task = await new TaskboardClient(app.url).findTaskByEventId("evt_1", "auto-a");
  assert.equal(task.identifier, "AUTO-7");
  assert.deepEqual(calls, [{ method: "GET", url: "/api/tasks?projectId=auto-a&archived=all" }]);
});

test("rejects a metadata-matching task without valid ids", async (t) => {
  const encoded = Buffer.from(JSON.stringify({ source: "feishu-base", eventId: "evt_1" }), "utf8")
    .toString("base64url");
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      tasks: [{ id: "task_existing", identifier: " ", description: `<!-- feishu-codex-task:v1:${encoded} -->` }],
    }));
  });
  t.after(app.close);
  await assert.rejects(
    () => new TaskboardClient(app.url).findTaskByEventId("evt_1", "auto-a"),
    invalidResponse,
  );
});

test("rejects a malformed successful task list response instead of treating it as empty", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({}));
  });
  t.after(app.close);
  await assert.rejects(
    () => new TaskboardClient(app.url).listTasks({ projectId: "auto-a" }),
    invalidResponse,
  );
});

test("reads a task and archives it with the current version", async (t) => {
  const calls = [];
  const app = await fixture(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      task: {
        id: "task_1",
        identifier: "AUTO-1",
        version: request.url.endsWith("/archive") ? 5 : 4,
        status: request.url.endsWith("/archive") ? "todo" : "todo",
        archivedAt: request.url.endsWith("/archive") ? "2026-08-20T00:00:00.000Z" : null,
      },
    }));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  const current = await client.getTask("task_1");
  const archived = await client.archiveTask(current);
  assert.equal(current.version, 4);
  assert.equal(archived.version, 5);
  assert.deepEqual(calls, [
    { method: "GET", url: "/api/tasks/task_1", body: null },
    { method: "POST", url: "/api/tasks/task_1/archive", body: { version: 4 } },
  ]);
});

test("rejects malformed task reads and archive inputs", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ task: { id: "task_1" } }));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  await assert.rejects(() => client.getTask("task_1"), invalidResponse);
  await assert.rejects(() => client.getTask(" "), invalidResponse);
  await assert.rejects(() => client.archiveTask({ id: "task_1", version: 4 }), invalidResponse);
});

test("rejects successful task snapshots without an archivedAt value", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      task: { id: "task_1", identifier: "AUTO-1", version: 4, status: "todo" },
    }));
  });
  t.after(app.close);
  await assert.rejects(() => new TaskboardClient(app.url).getTask("task_1"), invalidResponse);
});

test("rejects an archive response that does not confirm archival", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      task: { id: "task_1", identifier: "AUTO-1", version: 5, status: "todo", archivedAt: null },
    }));
  });
  t.after(app.close);
  await assert.rejects(
    () => new TaskboardClient(app.url).archiveTask({ id: "task_1", identifier: "AUTO-1", version: 4 }),
    invalidResponse,
  );
});

test("rejects an archive response that changes the task out of todo", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      task: { id: "task_1", identifier: "AUTO-1", version: 5, status: "in_progress", archivedAt: "now" },
    }));
  });
  t.after(app.close);
  await assert.rejects(
    () => new TaskboardClient(app.url).archiveTask({ id: "task_1", identifier: "AUTO-1", version: 4 }),
    invalidResponse,
  );
});

test("rejects unsafe versions and task identities that do not match the request", async (t) => {
  const responses = [
    { task: { id: "task_1", identifier: "AUTO-1", version: 0, status: "todo", archivedAt: null } },
    { task: { id: "task_1", identifier: "AUTO-1", version: Number.MAX_SAFE_INTEGER + 1, status: "todo", archivedAt: null } },
    { task: { id: "task_other", identifier: "AUTO-2", version: 4, status: "todo", archivedAt: null } },
    { task: { id: "task_other", identifier: "AUTO-2", version: 5, status: "todo", archivedAt: "now" } },
  ];
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responses.shift()));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  await assert.rejects(() => client.getTask("task_1"), invalidResponse);
  await assert.rejects(() => client.getTask("task_1"), invalidResponse);
  await assert.rejects(() => client.getTask("task_1"), invalidResponse);
  await assert.rejects(
    () => client.archiveTask({ id: "task_1", identifier: "AUTO-1", version: 4 }),
    invalidResponse,
  );
});

test("preserves task-not-found and version-conflict error codes", async (t) => {
  const responses = [
    { status: 404, body: { error: { code: "TASK_NOT_FOUND", message: "missing" } } },
    { status: 409, body: { error: { code: "VERSION_CONFLICT", message: "stale" } } },
  ];
  const app = await fixture((_request, response) => {
    const next = responses.shift();
    response.writeHead(next.status, { "content-type": "application/json" });
    response.end(JSON.stringify(next.body));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  await assert.rejects(
    () => client.getTask("task_missing"),
    (error) => error instanceof TaskboardError && error.code === "TASK_NOT_FOUND" && error.status === 404,
  );
  await assert.rejects(
    () => client.archiveTask({ id: "task_1", identifier: "AUTO-1", version: 4 }),
    (error) => error instanceof TaskboardError && error.code === "VERSION_CONFLICT" && error.status === 409,
  );
});
