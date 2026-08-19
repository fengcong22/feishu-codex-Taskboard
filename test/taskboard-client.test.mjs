import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { TaskboardClient, TaskboardError } from "../src/taskboard-client.mjs";

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
