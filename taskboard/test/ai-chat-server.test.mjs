import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { createFeishuWorkflowStore } from "../server/feishu-workflow-store.mjs";

async function createServerFixture(host = "127.0.0.1", { packageWorkspace = null, subjectPackage = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-server-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  if (subjectPackage) packageWorkspace = path.join(directory, "subject-package");
  if (packageWorkspace) await mkdir(packageWorkspace, { recursive: true });
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  await writeFile(codexExecutable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
appendFileSync(fileURLToPath(new URL("./codex-calls.jsonl", import.meta.url)), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "debug") {
  process.stdout.write('{"models":[{"slug":"gpt-real","display_name":"GPT Real","description":"","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}],"service_tiers":[]}]}');
} else if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8"); let buffer="";
  process.stdin.on("data", chunk => { buffer += chunk; let i;
    while ((i=buffer.indexOf("\\n"))>=0) { const line=buffer.slice(0,i); buffer=buffer.slice(i+1);
      if (!line.trim()) continue; const message=JSON.parse(line);
      if (message.id===1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id===2) process.stdout.write('{"id":2,"result":{"data":[{"skills":[{"name":"real-skill","enabled":true,"scope":"repo","interface":null}]}]}}\\n');
    }
  });
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write('{"type":"thread.started","thread_id":"session-1"}\\n');
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\\n');
    process.stdout.write('{"type":"turn.completed"}\\n');
  });
}
`);
  await chmod(codexExecutable, 0o755);
  const codexStatePath = path.join(directory, "codex-state.json");
  await writeFile(codexStatePath, JSON.stringify({
    "local-projects": { local: { rootPaths: [workspace] } },
  }));
  const feishuPackagesPath = path.join(directory, "feishu-packages.json");
  if (packageWorkspace) await writeFile(feishuPackagesPath, JSON.stringify({
    packages: {
      [subjectPackage ? "Auto-cut-A" : "Auto-cut-forged"]: {
        projectId: "auto-cut-forged",
        workspacePath: packageWorkspace,
        prompt: "fixture Auto-Cut prompt",
      },
    },
  }));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable,
    codexStatePath,
    feishuPackagesPath,
    feishuBridgeSecret: "fixture-ai-workspace-secret",
    skillPath: "/fixture/manage-taskboard/SKILL.md",
  });
  const address = await app.listen({ host, port: 0 });
  const workflowStore = createFeishuWorkflowStore({ database: app.database });
  const subject = subjectPackage ? (await workflowStore.upsertBasePreview({
    baseToken: "bas_ai_subject",
    baseName: "Example Base",
    tables: [{ tableId: "tbl_ai_subject", tableName: "Example subject", fields: [] }],
  })).subjects[0] : null;
  return {
    app,
    subject,
    workflowStore,
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory,
    workspace,
    packageWorkspace: packageWorkspace ? await realpath(packageWorkspace) : null,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("ordinary tasks cannot use a forged Feishu marker to select an Auto-Cut workspace", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-forged-origin-"));
  const packageWorkspace = path.join(directory, "autocut-workspace");
  const fixture = await createServerFixture("127.0.0.1", { packageWorkspace });
  try {
    const metadata = {
      version: 1,
      source: "feishu-base",
      eventId: "forged-event",
      baseToken: "bas-forged",
      tableId: "tbl-forged",
      recordId: "rec-forged",
      packageAlias: "Auto-cut-forged",
    };
    const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "普通任务伪造来源",
        description: `<!-- feishu-codex-task:v1:${encoded} -->`,
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    assert.equal(task.response.status, 201);
    assert.equal(task.body.task.feishuOrigin, undefined);

    const thread = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", issueId: task.body.task.id },
    });
    assert.equal(thread.response.status, 201);
    assert.equal(thread.body.thread.origin.workspacePath, fixture.workspace);
    assert.notEqual(thread.body.thread.origin.workspacePath, fixture.packageWorkspace);
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Feishu project catalog and manual chat use the configured alias with a different package project ID", async () => {
  const fixture = await createServerFixture("127.0.0.1", { subjectPackage: true });
  try {
    const projectId = fixture.subject.projectId;
    assert.notEqual(projectId, "auto-cut-forged");
    assert.equal(fixture.app.database.getProject(projectId).workspacePath, null);
    const catalog = await request(fixture.baseUrl, `/api/local/ai/catalog?projectId=${projectId}`);
    assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST", body: { projectId, sandbox: "read-only" },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.thread.origin.workspacePath, fixture.packageWorkspace);
    assert.equal(created.body.thread.origin.issueId, undefined);
    const threadId = created.body.thread.id;
    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST", body: { message: "fixture read-only check" },
    });
    assert.equal(turn.response.status, 202, JSON.stringify(turn.body));
    let snapshot;
    for (let index = 0; index < 100; index += 1) {
      snapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
      if (snapshot.body.runs[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(snapshot.body.events.some((event) => event.content === "ok"), true);
    const calls = (await readFile(path.join(fixture.directory, "codex-calls.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.args[0] !== "exec").every((call) => call.cwd === fixture.packageWorkspace), true);
    const execution = calls.find((call) => call.args[0] === "exec");
    assert.equal(execution.args[execution.args.indexOf("-C") + 1], fixture.packageWorkspace);
    assert.equal(calls.some((call) => call.args.includes("--skip-git-repo-check")), false);
    assert.equal(calls.some((call) => call.args.includes("--add-dir")), false);
    assert.deepEqual(fixture.app.database.listTaskAiStarts(), []);
  } finally {
    await fixture.close();
  }
});

for (const state of ["disabled", "draft", "missing"]) {
  test(`Feishu project chat blocks a ${state} configured package without workspace fallback`, async () => {
    const fixture = await createServerFixture("127.0.0.1", { subjectPackage: true });
    try {
      const projectId = fixture.subject.projectId;
      fixture.app.database.database.prepare("UPDATE projects SET workspace_path = ? WHERE id = ?")
        .run(fixture.workspace, projectId);
      const registryPath = path.join(fixture.directory, "feishu-packages.json");
      const catalog = JSON.parse(await readFile(registryPath, "utf8"));
      if (state === "missing") delete catalog.packages["Auto-cut-A"];
      else catalog.packages["Auto-cut-A"].state = state;
      await writeFile(registryPath, JSON.stringify(catalog));
      const result = await request(fixture.baseUrl, `/api/local/ai/catalog?projectId=${projectId}`);
      assert.equal(result.response.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.error.code, state === "missing" ? "PACKAGE_NOT_FOUND" : "PACKAGE_DISABLED");
      const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
        method: "POST", body: { projectId },
      });
      assert.equal(created.response.status, 409);
      assert.deepEqual(fixture.app.database.listAiChatThreads(), []);
    } finally {
      await fixture.close();
    }
  });
}

test("ordinary tasks inside a Feishu project cannot inherit its package workspace", async () => {
  const fixture = await createServerFixture("127.0.0.1", { subjectPackage: true });
  try {
    const projectId = fixture.subject.projectId;
    const marker = Buffer.from(JSON.stringify({ version: 1, source: "feishu-base", packageAlias: "Auto-cut-A" })).toString("base64url");
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST", body: { projectId, title: "Ordinary task", description: `<!-- feishu-codex-task:v1:${marker} -->`, labels: ["feishu"] },
    });
    assert.equal(task.response.status, 201);
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST", body: { projectId, issueId: task.body.task.id },
    });
    assert.equal(created.response.status, 409);
    assert.equal(created.body.error.code, "PROJECT_WORKSPACE_UNAVAILABLE");
  } finally {
    await fixture.close();
  }
});

test("Feishu project chat prefers its subject alias over a package with the same project ID", async () => {
  const fixture = await createServerFixture("127.0.0.1", { subjectPackage: true });
  try {
    const registryPath = path.join(fixture.directory, "feishu-packages.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.packages["Auto-cut-other"] = {
      projectId: fixture.subject.projectId, workspacePath: fixture.workspace, prompt: "wrong workspace",
    };
    await writeFile(registryPath, JSON.stringify(registry));
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST", body: { projectId: fixture.subject.projectId },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.thread.origin.workspacePath, fixture.packageWorkspace);
  } finally {
    await fixture.close();
  }
});

test("Feishu project composer uses the same subject workspace", async () => {
  const fixture = await createServerFixture("127.0.0.1", { subjectPackage: true });
  try {
    const result = await request(fixture.baseUrl,
      `/api/local/ai/composer/candidates?projectId=${fixture.subject.projectId}&trigger=%2F&query=&surface=ai-chat`);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.ok(result.body.candidates.some((candidate) => candidate.command === "/new"));
  } finally {
    await fixture.close();
  }
});

test("registered Feishu task chat keeps its frozen workspace when the subject is rebound", async () => {
  const fixture = await createServerFixture("127.0.0.1", { subjectPackage: true });
  try {
    const subject = fixture.subject;
    const metadata = {
      version: 1, source: "feishu-base", eventId: "evt-ai-workspace", recordId: "rec-ai-workspace",
      baseToken: subject.baseToken, tableId: subject.tableId, subjectKey: subject.subjectKey,
      triggerField: "status", triggerValue: "ready", mode: "manual", packageAlias: "Auto-cut-A",
    };
    const encoded = Buffer.from(JSON.stringify(metadata)).toString("base64url");
    const registered = await request(fixture.baseUrl, "/api/local/feishu/tasks", {
      method: "POST",
      headers: { "x-taskboard-client": "feishu-bridge", "x-feishu-bridge-secret": "fixture-ai-workspace-secret" },
      body: { projectId: subject.projectId, title: "Frozen package", description: `<!-- feishu-codex-task:v1:${encoded} -->`,
        status: "todo", priority: "high", labels: ["feishu"] },
    });
    assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
    const registryPath = path.join(fixture.directory, "feishu-packages.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.packages["Auto-cut-A"].workspacePath = fixture.workspace;
    registry.packages["Auto-cut-B"] = { projectId: "package-b", workspacePath: fixture.workspace, prompt: "new package" };
    await writeFile(registryPath, JSON.stringify(registry));
    fixture.app.database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
      .run(JSON.stringify({ ...subject, packageRoute: { ...subject.packageRoute, packageAlias: "Auto-cut-B" } }), subject.subjectKey);
    const projectThread = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST", body: { projectId: subject.projectId },
    });
    assert.equal(projectThread.response.status, 201);
    assert.equal(projectThread.body.thread.origin.workspacePath, fixture.workspace);
    const taskThread = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST", body: { projectId: subject.projectId, issueId: registered.body.task.id },
    });
    assert.equal(taskThread.response.status, 201, JSON.stringify(taskThread.body));
    assert.equal(taskThread.body.thread.origin.workspacePath, fixture.packageWorkspace);
  } finally {
    await fixture.close();
  }
});

for (const change of ["disabled", "directory-missing", "workspace-changed"]) {
  test(`Feishu project turns revalidate a package that became ${change}`, async () => {
    const fixture = await createServerFixture("127.0.0.1", { subjectPackage: true });
    try {
      const projectId = fixture.subject.projectId;
      const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
        method: "POST", body: { projectId },
      });
      assert.equal(created.response.status, 201);
      const threadId = created.body.thread.id;
      const registryPath = path.join(fixture.directory, "feishu-packages.json");
      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      if (change === "disabled") registry.packages["Auto-cut-A"].state = "disabled";
      else registry.packages["Auto-cut-A"].workspacePath = change === "directory-missing"
        ? path.join(fixture.directory, "missing") : fixture.workspace;
      await writeFile(registryPath, JSON.stringify(registry));
      const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
        method: "POST", body: { message: "must not run" },
      });
      assert.equal(turn.response.status, 409);
      assert.equal(turn.body.error.code, {
        disabled: "PACKAGE_DISABLED", "directory-missing": "PACKAGE_WORKSPACE_UNAVAILABLE",
        "workspace-changed": "PROJECT_WORKSPACE_CHANGED",
      }[change]);
      assert.deepEqual(fixture.app.database.listAiChatRuns(threadId), []);
      if (change === "workspace-changed") {
        const fresh = await request(fixture.baseUrl, "/api/local/ai/threads", {
          method: "POST", body: { projectId },
        });
        assert.equal(fresh.response.status, 201);
        assert.equal(fresh.body.thread.origin.workspacePath, fixture.workspace);
      }
    } finally {
      await fixture.close();
    }
  });
}

test("removed Feishu subjects no longer supply a package workspace", async () => {
  const fixture = await createServerFixture("127.0.0.1", { subjectPackage: true });
  try {
    await fixture.workflowStore.removeSubject(fixture.subject.subjectKey);
    const result = await request(fixture.baseUrl, `/api/local/ai/catalog?projectId=${fixture.subject.projectId}`);
    assert.equal(result.response.status, 404);
    assert.equal(result.body.error.code, "SUBJECT_NOT_FOUND");
  } finally {
    await fixture.close();
  }
});

for (const packageRoute of [null, { routeMode: "field", packageAlias: "Auto-cut-A" }, { routeMode: "fixed", packageAlias: "" }]) {
  test(`Feishu project chat rejects an unavailable fixed route: ${JSON.stringify(packageRoute)}`, async () => {
    const fixture = await createServerFixture("127.0.0.1", { subjectPackage: true });
    try {
      const config = { ...fixture.subject, packageRoute };
      fixture.app.database.database.prepare("UPDATE feishu_subjects SET config_json = ? WHERE subject_key = ?")
        .run(JSON.stringify(config), fixture.subject.subjectKey);
      const result = await request(fixture.baseUrl, `/api/local/ai/catalog?projectId=${fixture.subject.projectId}`);
      assert.equal(result.response.status, 409);
      assert.equal(result.body.error.code, "PACKAGE_ROUTE_UNAVAILABLE");
    } finally {
      await fixture.close();
    }
  });
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("loopback AI API freezes server-owned origin and rejects injected execution fields", async () => {
  const fixture = await createServerFixture();
  try {
    const meta = await request(fixture.baseUrl, "/api/meta");
    assert.equal(meta.body.capabilities.localAiChat, true);
    const catalog = await request(fixture.baseUrl, "/api/local/ai/catalog?projectId=local");
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.models[0].slug, "gpt-real");
    assert.equal(catalog.body.skills[0].id, "real-skill");

    const injected = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", workspacePath: "/tmp/evil", argv: ["--dangerously-bypass-approvals-and-sandbox"] },
    });
    assert.equal(injected.response.status, 400);
    assert.equal(injected.body.error.code, "UNKNOWN_FIELD");

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "gpt-real",
        reasoningEffort: "high",
        sandbox: "read-only",
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.thread.origin.workspacePath, fixture.workspace);
    const threadId = created.body.thread.id;

    const invalidSkill = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello \uFFFC", skillIds: ["invented-skill"] },
    });
    assert.equal(invalidSkill.response.status, 400);
    assert.equal(invalidSkill.body.error.code, "INVALID_SKILL");

    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello \uFFFC", skillIds: ["real-skill"] },
    });
    assert.equal(turn.response.status, 202);
    assert.equal(turn.body.run.threadId, threadId);

    let snapshot;
    for (let index = 0; index < 100; index += 1) {
      snapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
      if (snapshot.body.runs[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(snapshot.body.thread.codexThreadId, "session-1");
    assert.equal(snapshot.body.events.some((event) => event.content === "ok"), true);
  } finally {
    await fixture.close();
  }
});

test("non-local AI threads reject projects without an available workspace", async () => {
  const fixture = await createServerFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: {
        id: "missing-workspace",
        name: "Missing workspace",
        workspacePath: path.join(fixture.directory, "missing-workspace"),
      },
    });
    assert.equal(project.response.status, 201);

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "missing-workspace" },
    });
    assert.equal(created.response.status, 409);
    assert.equal(created.body.error.code, "PROJECT_WORKSPACE_UNAVAILABLE");
  } finally {
    await fixture.close();
  }
});

test("non-local AI turns reject a workspace that became unavailable", async () => {
  const fixture = await createServerFixture();
  try {
    const workspaceLink = path.join(fixture.directory, "project-workspace");
    await mkdir(workspaceLink);
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: {
        id: "disconnected-workspace",
        name: "Disconnected workspace",
        workspacePath: workspaceLink,
      },
    });
    assert.equal(project.response.status, 201);

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "disconnected-workspace" },
    });
    assert.equal(created.response.status, 201);
    const threadId = created.body.thread.id;
    await rm(workspaceLink, { recursive: true });

    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(turn.response.status, 409);
    assert.equal(turn.body.error.code, "PROJECT_WORKSPACE_UNAVAILABLE");

    const snapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
    assert.deepEqual(snapshot.body.runs, []);
  } finally {
    await fixture.close();
  }
});

test("the local AI project falls back to the Taskboard workspace", async () => {
  const fixture = await createServerFixture();
  try {
    await writeFile(
      path.join(fixture.directory, "codex-state.json"),
      JSON.stringify({ "local-projects": {} }),
    );

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.thread.origin.workspacePath, path.resolve(import.meta.dirname, ".."));
  } finally {
    await fixture.close();
  }
});

test("danger-full-access requires confirmation on every turn and thread settings are validated", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "gpt-real",
        reasoningEffort: "low",
        sandbox: "danger-full-access",
      },
    });
    assert.equal(created.response.status, 201);
    const threadId = created.body.thread.id;
    const denied = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(denied.response.status, 400);
    assert.equal(denied.body.error.code, "DANGER_CONFIRMATION_REQUIRED");
    const allowed = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello", dangerFullAccessConfirmed: true },
    });
    assert.equal(allowed.response.status, 202);

    const invalidModel = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH",
      body: { model: "invented-model", reasoningEffort: "high" },
    });
    assert.equal(invalidModel.response.status, 400);
    assert.equal(invalidModel.body.error.code, "INVALID_MODEL");
  } finally {
    await fixture.close();
  }
});

test("thread management, interrupt and query contracts stay narrow", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", title: "Original" },
    });
    const threadId = created.body.thread.id;

    const list = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(list.response.status, 200);
    assert.equal(list.body.threads.some((thread) => thread.id === threadId), true);

    const unknownQuery = await request(fixture.baseUrl, "/api/local/ai/threads?projectId=local");
    assert.equal(unknownQuery.response.status, 400);
    assert.equal(unknownQuery.body.error.code, "UNKNOWN_QUERY_PARAMETER");

    const updated = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH",
      body: { title: "Renamed", sandbox: "workspace-write" },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.thread.title, "Renamed");

    const interruptedMissing = await request(fixture.baseUrl, "/api/local/ai/runs/missing/interrupt", {
      method: "POST",
    });
    assert.equal(interruptedMissing.response.status, 404);

    const removed = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "DELETE",
    });
    assert.equal(removed.response.status, 204);
    const missing = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
    assert.equal(missing.response.status, 404);
  } finally {
    await fixture.close();
  }
});

test("the AI server cannot opt into a non-loopback bind", async () => {
  const fixture = await createServerFixture();
  try {
    await assert.rejects(
      fixture.app.listen({ host: "0.0.0.0", port: 0 }),
      /CODEX_TASKBOARD_HOST must be 127\.0\.0\.1/,
    );
  } finally {
    await fixture.close();
  }
});

test("AI SSE is live-only and thread snapshots remain the durable source", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local" },
    });
    const threadId = created.body.thread.id;
    const controller = new AbortController();
    const response = await fetch(`${fixture.baseUrl}/api/local/ai/threads/${threadId}/events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let connected = "";
    while (!connected.includes("event: ai.event")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      connected += new TextDecoder().decode(chunk.value);
    }
    assert.match(connected, /connected/);
    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(turn.response.status, 202);
    let streamed = "";
    while (!streamed.includes("ai.event")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      streamed += new TextDecoder().decode(chunk.value);
    }
    assert.match(streamed, /event: ai\.(event|run)/);
    controller.abort();
  } finally {
    await fixture.close();
  }
});

test("server close stops accepting requests before AI shutdown completes", async () => {
  const fixture = await createServerFixture();
  let appClosed = false;
  try {
    let releaseAiClose;
    const aiCloseGate = new Promise((resolve) => {
      releaseAiClose = resolve;
    });
    fixture.app.aiChat.close = () => aiCloseGate;

    const closing = fixture.app.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const acceptedDuringClose = await fetch(`${fixture.baseUrl}/health`)
      .then(() => true, () => false);
    releaseAiClose();
    await closing;
    appClosed = true;

    assert.equal(acceptedDuringClose, false);
  } finally {
    if (appClosed) {
      await rm(fixture.directory, { recursive: true, force: true });
    } else {
      await fixture.close();
    }
  }
});
