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

function fullFeishuMetadata(overrides = {}) {
  return {
    version: 1,
    source: "feishu-base",
    eventId: "evt_bridge",
    baseToken: "bas_bridge",
    tableId: "tbl_bridge",
    recordId: "rec_bridge",
    triggerField: "进度",
    triggerFieldId: "fld_progress",
    triggerValue: "待剪辑",
    mode: "automatic",
    subjectKey: "bas_bridge:tbl_bridge",
    configVersion: 9,
    executionMode: "automatic",
    uploadMode: "automatic",
    concurrencyGroup: "primary-editor",
    maxConcurrent: 3,
    resourceGroups: ["jianying-desktop", "gpu"],
    packageAlias: "Auto-cut-copyA",
    packageSource: "table-default",
    ...overrides,
  };
}

function feishuCreatePayload(metadata) {
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return {
    projectId: "auto-a",
    title: "待剪辑",
    description: `<!-- feishu-codex-task:v1:${encoded} -->`,
    status: "todo",
    priority: "high",
    labels: ["feishu"],
  };
}

function feishuCreateResponse(feishuOrigin, suffix = "trusted") {
  return { task: {
    id: `task_${suffix}`,
    identifier: `AUTO-${suffix}`,
    version: 1,
    status: "todo",
    archivedAt: null,
    feishuOrigin,
  } };
}

for (const method of ["createFeishuTask", "registerFeishuStageTask"]) {
  test(`${method} preserves the deleted-event HTTP status and safe error code`, async (t) => {
    const app = await fixture((_request, response) => {
      response.writeHead(410, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "FEISHU_TASK_DELETED", message: "Task was permanently deleted" } }));
    });
    t.after(app.close);
    const client = new TaskboardClient(app.url, { bridgeSecret: "fixture-bridge-secret" });

    await assert.rejects(
      () => client[method](feishuCreatePayload(fullFeishuMetadata())),
      (error) => error instanceof TaskboardError
        && error.status === 410
        && error.code === "FEISHU_TASK_DELETED",
    );
  });
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

test("creates Feishu tasks through the Bridge-only provenance route", async (t) => {
  const calls = [];
  const metadata = fullFeishuMetadata();
  const payload = feishuCreatePayload(metadata);
  const bridgeSecret = "fixture-feishu-bridge-secret-2026";
  const app = await fixture(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method,
      url: request.url,
      client: request.headers["x-taskboard-client"],
      secret: request.headers["x-feishu-bridge-secret"],
      body: body ? JSON.parse(body) : null,
    });
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify(feishuCreateResponse(metadata, "feishu")));
  });
  t.after(app.close);
  const task = await new TaskboardClient(app.url, { bridgeSecret }).createFeishuTask(payload);
  assert.equal(task.id, "task_feishu");
  assert.deepEqual(calls, [{
    method: "POST",
    url: "/api/local/feishu/tasks",
    client: "feishu-bridge",
    secret: bridgeSecret,
    body: payload,
  }]);
});

test("rejects successful Feishu creates whose provenance differs from the request marker", async (t) => {
  const metadata = fullFeishuMetadata();
  const payload = feishuCreatePayload(metadata);
  let responseOrigin = metadata;
  let responseNumber = 0;
  const app = await fixture((_request, response) => {
    responseNumber += 1;
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify(feishuCreateResponse(responseOrigin, responseNumber)));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  const mismatches = [
    ["eventId", "evt_other"],
    ["baseToken", "bas_other"],
    ["tableId", "tbl_other"],
    ["recordId", "rec_other"],
    ["triggerField", "其他进度"],
    ["triggerFieldId", "fld_other"],
    ["triggerValue", "已剪辑"],
    ["deliverySource", "simulation"],
    ["mode", "manual"],
    ["subjectKey", "bas_other:tbl_other"],
    ["configVersion", 10],
    ["executionMode", "manual"],
    ["uploadMode", "manual"],
    ["packageAlias", "Auto-cut-copyB"],
    ["packageSource", "record-field"],
    ["concurrencyGroup", "secondary-editor"],
    ["maxConcurrent", 2],
    ["resourceGroups", ["gpu"]],
  ];

  for (const [field, value] of mismatches) {
    await t.test(field, async () => {
      responseOrigin = fullFeishuMetadata({ [field]: value });
      await assert.rejects(() => client.createFeishuTask(payload), invalidResponse);
    });
  }

  await t.test("missing snapshot field", async () => {
    responseOrigin = fullFeishuMetadata();
    delete responseOrigin.executionMode;
    await assert.rejects(() => client.createFeishuTask(payload), invalidResponse);
  });
});

test("rejects a Feishu create response without server-owned provenance", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ task: { id: "task_untrusted", identifier: "AUTO-3" } }));
  });
  t.after(app.close);
  const metadata = {
    version: 1,
    source: "feishu-base",
    eventId: "evt_untrusted_response",
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    recordId: "rec_demo",
    triggerField: "进度",
    triggerValue: "待剪辑",
    mode: "manual",
    packageAlias: "Auto-cut-copyA",
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  await assert.rejects(
    () => new TaskboardClient(app.url).createFeishuTask({
      projectId: "auto-a",
      title: "待剪辑",
      description: `<!-- feishu-codex-task:v1:${encoded} -->`,
      status: "todo",
      priority: "high",
      labels: ["feishu"],
    }),
    (error) => error?.code === "TASKBOARD_INVALID_RESPONSE",
  );
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
  const calls = [];
  const app = await fixture((request, response) => {
    calls.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ task: {
      id: "task_existing",
      identifier: "AUTO-7",
      version: 4,
      status: "todo",
      archivedAt: null,
      feishuOrigin: {
        version: 1,
        source: "feishu-base",
        eventId: "evt_1",
        baseToken: "bas_demo",
        tableId: "tbl_demo",
        recordId: "rec_demo",
      },
    } }));
  });
  t.after(app.close);
  const task = await new TaskboardClient(app.url).findTaskByEventId("evt_1", "auto-a");
  assert.equal(task.identifier, "AUTO-7");
  assert.deepEqual(calls, [{ method: "GET", url: "/api/local/feishu/tasks?eventId=evt_1&projectId=auto-a&archived=all" }]);
});

test("sends the Bridge provenance header for Feishu queries", async (t) => {
  const calls = [];
  const app = await fixture((request, response) => {
    calls.push({
      method: request.method,
      url: request.url,
      client: request.headers["x-taskboard-client"],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ task: null }));
  });
  t.after(app.close);
  assert.equal(await new TaskboardClient(app.url).findTaskByEventId("evt_header", "auto-a"), null);
  assert.deepEqual(calls, [{
    method: "GET",
    url: "/api/local/feishu/tasks?eventId=evt_header&projectId=auto-a&archived=all",
    client: "feishu-bridge",
  }]);
});

test("lists waiting Feishu tasks through a server-owned provenance query", async (t) => {
  const calls = [];
  const app = await fixture((request, response) => {
    calls.push({
      method: request.method,
      url: request.url,
      client: request.headers["x-taskboard-client"],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ tasks: [] }));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  const tasks = await client.listFeishuWaitingTasks({
    projectId: "auto-a",
    baseToken: "bas_demo",
    tableId: "tbl_demo",
    recordId: "rec_demo",
    triggerFieldId: "fld_progress",
    triggerValue: "待剪辑",
  });
  assert.deepEqual(tasks, []);
  assert.deepEqual(calls, [{
    method: "GET",
    url: "/api/local/feishu/tasks?projectId=auto-a&baseToken=bas_demo&tableId=tbl_demo&recordId=rec_demo&triggerFieldId=fld_progress&triggerValue=%E5%BE%85%E5%89%AA%E8%BE%91&status=todo&archived=false",
    client: "feishu-bridge",
  }]);
});

test("archives Feishu tasks through the provenance-only archive route", async (t) => {
  const calls = [];
  const app = await fixture(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method,
      url: request.url,
      client: request.headers["x-taskboard-client"],
      body: body ? JSON.parse(body) : null,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ task: {
      id: "task_1",
      identifier: "AUTO-1",
      version: 5,
      status: "todo",
      archivedAt: "2026-08-20T00:00:00.000Z",
      feishuOrigin: {
        version: 1,
        source: "feishu-base",
        eventId: "evt_1",
        baseToken: "bas_demo",
        tableId: "tbl_demo",
        recordId: "rec_demo",
      },
    } }));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  const archived = await client.archiveFeishuTask({
    id: "task_1",
    identifier: "AUTO-1",
    version: 4,
    status: "todo",
    archivedAt: null,
  });
  assert.equal(archived.archivedAt, "2026-08-20T00:00:00.000Z");
  assert.deepEqual(calls, [{
    method: "POST",
    url: "/api/local/feishu/tasks/task_1/archive",
    client: "feishu-bridge",
    body: { version: 4 },
  }]);
});

test("rejects a provenance query response without server-owned origin", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ task: {
      id: "task_existing",
      identifier: "AUTO-7",
      version: 4,
      status: "todo",
      archivedAt: null,
    } }));
  });
  t.after(app.close);
  await assert.rejects(
    () => new TaskboardClient(app.url).findTaskByEventId("evt_1", "auto-a"),
    invalidResponse,
  );
});

test("rejects malformed Feishu query and archive inputs", async (t) => {
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ tasks: [] }));
  });
  t.after(app.close);
  const client = new TaskboardClient(app.url);
  await assert.rejects(
    () => client.findTaskByEventId(" ", "auto-a"),
    invalidResponse,
  );
  await assert.rejects(
    () => client.listFeishuWaitingTasks({ baseToken: "bas_demo", tableId: "tbl_demo", recordId: "rec_demo", triggerValue: "待剪辑" }),
    invalidResponse,
  );
  await assert.rejects(
    () => client.archiveFeishuTask({ id: "task_1", identifier: "AUTO-1", version: 4 }),
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
    { status: 409, body: { error: { code: "TASK_NOT_WAITING", message: "already started" } } },
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
  await assert.rejects(
    () => client.archiveTask({ id: "task_1", identifier: "AUTO-1", version: 4 }),
    (error) => error instanceof TaskboardError && error.code === "TASK_NOT_WAITING" && error.status === 409,
  );
});
