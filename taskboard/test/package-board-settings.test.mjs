import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createFeishuWorkflowStore } from "../server/feishu-workflow-store.mjs";

const SUBJECT = "bas_board:tbl_chemistry";
const OTHER_SUBJECT = "bas_board:tbl_physics";
const VM = { id: "vm_pmo_review_video", version: 1 };
const ZIP = { id: "document_draft_zip", version: 1 };
const VM_STAGES = ["todo", "materials", "queued", "editing", "feishu_delivery", "awaiting_feishu_review", "nas_upload", "completed", "needs_attention"];
const ZIP_STAGES = ["todo", "queued", "in_progress", "blocked", "in_review", "completed_editing", "upload_queue", "uploading", "uploaded"];
const scope = (packageAlias = "vm-a", subjectKey = SUBJECT) => ({ subjectKey, packageAlias });
const route = (packageAlias = "vm-a", subjectKey = SUBJECT) => `/api/local/feishu/package-board?${new URLSearchParams(scope(packageAlias, subjectKey))}`;

async function discover(database) {
  const workflowStore = createFeishuWorkflowStore({ database });
  await workflowStore.upsertBasePreview({
    baseToken: "bas_board", baseName: "Offline board", metadataRefreshedAt: Date.now(),
    tables: ["tbl_chemistry", "tbl_physics"].map(tableId => ({ tableId, tableName: tableId, fields: [] })),
  });
  return workflowStore;
}

function editable(settings) {
  const { subjectKey, packageAlias, revision, views, activeViewId, defaultViewId, stageDisplays } = structuredClone(settings);
  return { subjectKey, packageAlias, revision, views, activeViewId, defaultViewId, stageDisplays };
}

function historyTask(database, { packageAlias, workflowTemplate = VM, subjectKey = SUBJECT, status = "done", archived = false, deliverySource } = {}) {
  const actor = { type: "user", id: "offline", name: "Offline", avatarUrl: null };
  const [baseToken, tableId] = subjectKey.split(":");
  const projectId = database.database.prepare("SELECT project_id FROM feishu_subjects WHERE subject_key = ?").get(subjectKey).project_id;
  const task = database.createTask({
    projectId, title: "Historical offline task", description: "", status, priority: "none", labels: [], actor, assignee: actor,
    startDate: null, dueDate: null, recurrence: null, developmentContext: null,
    feishuOrigin: {
      source: "feishu-base", eventId: `evt_${randomUUID()}`, baseToken, tableId, subjectKey,
      recordId: `rec_${randomUUID()}`, packageAlias, stageId: "initial", executionMode: "manual",
      ...(deliverySource ? { deliverySource } : {}),
      stageSnapshot: { workflowTemplate, ...(workflowTemplate.id === VM.id ? { vmWorkflow: { fields: { outputAttachmentFieldId: "fld_output" } } } : {}) },
    },
    packageSnapshot: { packageAlias, packageRevision: 1, workflowTemplate },
  });
  return archived ? database.archiveTask(task.id, task.version, null, null, actor) : task;
}

async function storeFixture(t) {
  const { createPackageBoardSettings } = await import("../server/package-board-settings.mjs");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-board-"));
  const filename = path.join(directory, "board.sqlite");
  const packages = new Map([
    ["vm-a", { alias: "vm-a", state: "disabled", workflowTemplate: VM }],
    ["vm-b", { alias: "vm-b", state: "draft", workflowTemplate: VM }],
    ["zip-a", { alias: "zip-a", state: "enabled" }],
  ]);
  let database;
  let store;
  function open() {
    database = new TaskboardDatabase(filename);
    store = createPackageBoardSettings({ database, packageStore: { get: async alias => packages.get(alias) ?? null } });
  }
  open();
  await discover(database);
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get database() { return database; }, get store() { return store; }, packages,
    reopen() { database.close(); open(); },
  };
}

test("package board defaults use the registered template without touching subject views or active configuration", async t => {
  const f = await storeFixture(t);
  const legacy = f.database.getUnifiedWorkflowViews(SUBJECT);
  const subject = f.database.database.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(SUBJECT);
  const vm = await f.store.getSettings(scope());
  const zip = await f.store.getSettings(scope("zip-a"));
  assert.deepEqual(vm.workflowTemplate, VM);
  assert.equal(vm.revision, 1);
  assert.deepEqual(vm.views, [{ id: "all", name: "全部流程", stageIds: VM_STAGES, isSystem: true }]);
  assert.deepEqual(zip.views[0].stageIds, ZIP_STAGES);
  assert.deepEqual(vm.stageDisplays.map(display => display.stageId), VM_STAGES);
  assert.ok(vm.stageDisplays.every(display => display.zhName === null && display.enDescription === null));
  assert.equal(vm.activeViewId, "all");
  assert.equal(vm.defaultViewId, "all");
  assert.deepEqual(f.database.getUnifiedWorkflowViews(SUBJECT), legacy);
  assert.deepEqual(f.database.database.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(SUBJECT), subject);
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
});

test("views and stage labels persist independently for packages and subjects and reject stale revisions", async t => {
  const f = await storeFixture(t);
  const initial = await f.store.getSettings(scope());
  const otherPackage = await f.store.getSettings(scope("vm-b"));
  const otherSubject = await f.store.getSettings(scope("vm-a", OTHER_SUBJECT));
  const body = editable(initial);
  body.views.push({ id: "review", name: "审核交付", stageIds: ["feishu_delivery", "awaiting_feishu_review"], isSystem: false });
  body.activeViewId = "review";
  body.defaultViewId = "review";
  body.stageDisplays.find(display => display.stageId === "editing").zhName = "本包剪辑";
  const saved = await f.store.saveSettings(body);
  assert.equal(saved.revision, 2);
  assert.equal(saved.activeViewId, "review");
  assert.equal(saved.stageDisplays.find(display => display.stageId === "editing").zhName, "本包剪辑");
  await assert.rejects(f.store.saveSettings(body), error => error.status === 409 && error.code === "VERSION_CONFLICT" && error.details.actualRevision === 2);
  assert.deepEqual(await f.store.getSettings(scope("vm-b")), otherPackage);
  assert.deepEqual(await f.store.getSettings(scope("vm-a", OTHER_SUBJECT)), otherSubject);
  f.reopen();
  assert.deepEqual(await f.store.getSettings(scope()), saved);
});

test("full-state settings validation protects the system view and rejects cross-template stages without partial writes", async t => {
  const f = await storeFixture(t);
  const initial = await f.store.getSettings(scope());
  const cases = [
    body => { body.views[0].stageIds.pop(); },
    body => { body.views[0].name = "changed"; },
    body => { body.views = []; },
    body => { body.views.push({ id: "zip", name: "ZIP", stageIds: ["uploaded"], isSystem: false }); },
    body => { body.views.push({ id: "empty", name: "空", stageIds: [], isSystem: false }); },
    body => { body.views.push({ id: "same", name: "全部流程", stageIds: ["todo"], isSystem: false }); },
    body => { body.views.push({ id: "all", name: "重复", stageIds: ["todo"], isSystem: false }); },
    body => { body.views.push({ id: "custom", name: "自定义", stageIds: ["todo", "todo"], isSystem: false }); },
    body => { body.activeViewId = "missing"; },
    body => { body.defaultViewId = "missing"; },
    body => { body.stageDisplays[0].stageId = "uploaded"; },
    body => { body.stageDisplays.pop(); },
    body => { body.stageDisplays[0].zhName = "<script>"; },
    body => { body.stageDisplays[0].enDescription = "unsafe\u0000text"; },
    body => { body.workflowTemplate = { id: "document_draft_zip", version: 1 }; },
  ];
  for (const mutate of cases) {
    const body = editable(initial);
    mutate(body);
    await assert.rejects(f.store.saveSettings(body), error => error.status === 400);
    assert.deepEqual(await f.store.getSettings(scope()), initial);
  }
});

test("invalid or unregistered scopes do not initialize settings and malformed persisted state fails closed", async t => {
  const f = await storeFixture(t);
  for (const bad of [scope("missing"), scope("vm-a", "bas_board:missing"), scope("../vm-a"), scope("vm-a", "a:b:c"), scope("vm-a", "a/b:tbl"), scope("vm-a", "")]) {
    await assert.rejects(f.store.getSettings(bad), error => [400, 404].includes(error.status));
  }
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM feishu_package_board_settings").get().count, 0);
  await f.store.getSettings(scope());
  f.database.database.prepare("UPDATE feishu_package_board_settings SET settings_json = ?").run('{"views":[]}');
  await assert.rejects(f.store.getSettings(scope()), error => error.status === 500 && error.code === "PACKAGE_BOARD_SETTINGS_INVALID");
});

test("read-only package catalogs require an own registered alias rather than inherited object properties", async t => {
  const f = await storeFixture(t);
  const { createPackageBoardSettings } = await import("../server/package-board-settings.mjs");
  const store = createPackageBoardSettings({ database: f.database, packageStore: { read: async () => ({ "vm-a": { workflowTemplate: VM } }) } });
  await assert.rejects(store.getSettings(scope("toString")), error => error.status === 404 && error.code === "PACKAGE_NOT_FOUND");
  assert.deepEqual((await store.getSettings(scope())).workflowTemplate, VM);
});

test("removed terminal and archived package aliases recover their own template from trusted task snapshots", async t => {
  const f = await storeFixture(t);
  for (const workflowTemplate of [VM, ZIP]) {
    for (const state of ["done", "canceled", "archived"]) {
      const packageAlias = `removed-${workflowTemplate.id}-${state}`;
      const task = historyTask(f.database, { packageAlias, workflowTemplate, status: state === "archived" ? "todo" : state, archived: state === "archived" });
      const before = f.database.getTask(task.id);
      const settings = await f.store.getSettings(scope(packageAlias));
      assert.deepEqual(settings.workflowTemplate, workflowTemplate);
      assert.deepEqual(settings.views[0].stageIds, workflowTemplate.id === VM.id ? VM_STAGES : ZIP_STAGES);
      const patch = editable(settings);
      patch.stageDisplays[0].zhName = "历史流程";
      const saved = await f.store.saveSettings(patch);
      assert.equal(saved.stageDisplays[0].zhName, "历史流程");
      assert.deepEqual(f.database.getTask(task.id), before);
      assert.equal(f.packages.has(packageAlias), false);
    }
  }
});

test("removed package settings retain presentation preferences even after all associated task history is gone", async t => {
  const f = await storeFixture(t);
  const initial = await f.store.getSettings(scope());
  const patch = editable(initial);
  patch.stageDisplays[0].enName = "Historical ready";
  const saved = await f.store.saveSettings(patch);
  f.packages.delete("vm-a");
  f.reopen();
  assert.deepEqual(await f.store.getSettings(scope()), saved);
  const next = editable(saved);
  next.stageDisplays[0].enName = "Renamed history";
  assert.equal((await f.store.saveSettings(next)).stageDisplays[0].enName, "Renamed history");
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
});

test("historical scope resolution rejects ambiguous templates and confines evidence to one subject and alias", async t => {
  const f = await storeFixture(t);
  historyTask(f.database, { packageAlias: "ambiguous", workflowTemplate: VM });
  historyTask(f.database, { packageAlias: "ambiguous", workflowTemplate: ZIP });
  await assert.rejects(f.store.getSettings(scope("ambiguous")), error => error.status === 409 && error.code === "PACKAGE_BOARD_TEMPLATE_AMBIGUOUS");
  historyTask(f.database, { packageAlias: "isolated", workflowTemplate: VM });
  historyTask(f.database, { packageAlias: "isolated", workflowTemplate: ZIP, subjectKey: OTHER_SUBJECT });
  assert.deepEqual((await f.store.getSettings(scope("isolated"))).workflowTemplate, VM);
  assert.deepEqual((await f.store.getSettings(scope("isolated", OTHER_SUBJECT))).workflowTemplate, ZIP);
  await f.store.getSettings(scope("vm-a"));
  f.packages.delete("vm-a");
  historyTask(f.database, { packageAlias: "vm-a", workflowTemplate: ZIP });
  await assert.rejects(f.store.getSettings(scope()), error => error.status === 409 && error.code === "PACKAGE_BOARD_TEMPLATE_AMBIGUOUS");
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM feishu_package_board_settings WHERE package_alias = 'ambiguous'").get().count, 0);
});

test("historical scope resolution refuses simulation, unpaired snapshots and mismatched trusted identities", async t => {
  const f = await storeFixture(t);
  historyTask(f.database, { packageAlias: "simulated", deliverySource: "simulation" });
  await assert.rejects(f.store.getSettings(scope("simulated")), error => error.status === 404);
  const unpaired = historyTask(f.database, { packageAlias: "unpaired" });
  f.database.database.prepare("DELETE FROM feishu_task_origins WHERE task_id = ?").run(unpaired.id);
  await assert.rejects(f.store.getSettings(scope("unpaired")), error => error.status === 404);
  const mismatch = historyTask(f.database, { packageAlias: "mismatched" });
  f.database.database.prepare("UPDATE feishu_task_package_snapshots SET snapshot_json = ? WHERE task_id = ?")
    .run(JSON.stringify({ packageAlias: "other-alias", packageRevision: 1, workflowTemplate: VM }), mismatch.id);
  await assert.rejects(f.store.getSettings(scope("mismatched")), error => error.status === 409 && error.code === "PACKAGE_BOARD_HISTORY_INVALID");
  const malformed = historyTask(f.database, { packageAlias: "malformed" });
  f.database.database.prepare("UPDATE feishu_task_package_snapshots SET snapshot_json = ? WHERE task_id = ?").run("{}", malformed.id);
  await assert.rejects(f.store.getSettings(scope("malformed")), error => error.status === 409 && error.code === "PACKAGE_BOARD_HISTORY_INVALID");
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS count FROM feishu_package_board_settings").get().count, 0);
});

async function httpFixture(t, { readHistory = false } = {}) {
  const { createTaskboardServer } = await import("../server/app.mjs");
  const { readVmPackageBoard } = await import("../server/vm-package-board.mjs");
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-board-http-"));
  const runtimeCalls = [];
  const runtime = {
    ready: async () => ({ available: true }), start: async () => { runtimeCalls.push("start"); }, close: async () => {},
    validateActivation: async () => { runtimeCalls.push("activation"); throw new Error("Unexpected activation"); },
    register: async () => { runtimeCalls.push("registration"); throw new Error("Unexpected registration"); },
    getPackageBoard: async ({ subjectKey, packageAlias }) => readHistory
      ? readVmPackageBoard({ database: app.database, subjectKey, packageAlias })
      : { subjectKey, packageAlias, tasks: [{ taskId: "task-vm", runId: "run-vm", stage: "awaiting_feishu_review" }] },
  };
  const app = createTaskboardServer({
    dataDirectory: path.join(directory, "data"), codexExecutable: process.execPath, processEnv: {}, vmPmoRuntime: runtime,
    feishuPackages: { packages: {
      "vm-a": { projectId: "vm-a", state: "disabled", workspacePath: directory, workflowTemplate: VM },
      "zip-a": { projectId: "zip-a", state: "disabled", workspacePath: directory },
    } },
  });
  await discover(app.database);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { app, runtimeCalls, async request(target, options = {}) {
    const response = await fetch(`${baseUrl}${target}`, { ...options, headers: { "content-type": "application/json", ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    return { status: response.status, body: await response.json() };
  } };
}

test("local package board HTTP route returns status and saves only its scoped display settings", async t => {
  const f = await httpFixture(t);
  const before = f.app.database.database.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(SUBJECT);
  const first = await f.request(route());
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.status, { ...scope(), tasks: [{ taskId: "task-vm", runId: "run-vm", stage: "awaiting_feishu_review" }] });
  const body = editable(first.body.settings);
  body.stageDisplays[0].enName = "Ready";
  const result = await f.request("/api/local/feishu/package-board", { method: "PATCH", body });
  assert.equal(result.status, 200);
  assert.equal(result.body.settings.revision, 2);
  assert.equal((await f.request("/api/local/feishu/package-board", { method: "PATCH", body })).status, 409);
  assert.deepEqual((await f.request(route("zip-a"))).body.status, { ...scope("zip-a"), tasks: [] });
  assert.deepEqual(f.app.database.database.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(SUBJECT), before);
  assert.equal(f.app.database.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
});

test("HTTP boards retain removed package histories without starting or activating runtime work", async t => {
  const f = await httpFixture(t, { readHistory: true });
  const tasks = [
    historyTask(f.app.database, { packageAlias: "vm-a", status: "done" }),
    historyTask(f.app.database, { packageAlias: "vm-a", status: "canceled" }),
    historyTask(f.app.database, { packageAlias: "vm-a", status: "todo", archived: true }),
  ];
  const zip = historyTask(f.app.database, { packageAlias: "zip-a", workflowTemplate: ZIP });
  for (const alias of ["vm-a", "zip-a"]) {
    const removed = await f.request(`/api/local/autocut/packages/${alias}`, { method: "DELETE", body: { expectedRevision: 1 } });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
  }
  const beforeTasks = [...tasks, zip].map(task => f.app.database.getTask(task.id));
  const beforeSubjects = f.app.database.database.prepare("SELECT * FROM feishu_subjects ORDER BY subject_key").all();
  const beforeCalls = [...f.runtimeCalls];
  const result = await f.request(route());
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.settings.workflowTemplate, VM);
  assert.deepEqual(result.body.status.tasks.map(task => task.taskId).sort(), tasks.map(task => task.id).sort());
  const patch = editable(result.body.settings);
  patch.stageDisplays[0].zhName = "已移除包历史";
  assert.equal((await f.request("/api/local/feishu/package-board", { method: "PATCH", body: patch })).status, 200);
  assert.equal((await f.request(route("zip-a"))).status, 200);
  assert.deepEqual([...tasks, zip].map(task => f.app.database.getTask(task.id)), beforeTasks);
  assert.deepEqual(f.app.database.database.prepare("SELECT * FROM feishu_subjects ORDER BY subject_key").all(), beforeSubjects);
  assert.deepEqual(f.runtimeCalls, beforeCalls);
});

test("package board HTTP scope and loopback safeguards reject malformed input without exposing supplied secrets", async t => {
  const f = await httpFixture(t);
  const cases = [
    ["/api/local/feishu/package-board", {}, 400],
    [`${route()}&packageAlias=zip-a`, {}, 400],
    [`${route()}&secret=fixture-private`, {}, 400],
    [route("missing"), {}, 404],
    [route("vm-a", "a:b:c"), {}, 400],
    [route(), { headers: { origin: "https://untrusted.example" } }, 403],
    [route(), { method: "DELETE" }, 405],
    [route(), { method: "PATCH", body: {} }, 400],
  ];
  for (const [target, options, status] of cases) {
    const result = await f.request(target, options);
    assert.equal(result.status, status, JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result.body), /fixture-private|workspacePath|prompt/);
  }
});
