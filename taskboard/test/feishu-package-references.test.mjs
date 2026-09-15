import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

const alias = "Auto-cut-reference-test";
const actor = { type: "user", id: "tester", name: "Tester", avatarUrl: null };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-references-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  t.after(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = database.createProject({ id: "package-test", name: "Package test", workspacePath: null });
  let nextTask = 0;
  function createTask({ status = "todo", packageAlias = alias } = {}) {
    nextTask += 1;
    return database.createTask({
      id: `task-${nextTask}`, projectId: project.id, title: `Task ${nextTask}`,
      description: "", status, priority: "none", labels: ["feishu"], actor, assignee: actor,
      startDate: null, dueDate: null,
      feishuOrigin: {
        source: "feishu-base", eventId: `event-${nextTask}`, baseToken: "base-test",
        tableId: "table-test", recordId: `record-${nextTask}`, packageAlias,
      },
    });
  }
  function archive(task) {
    const current = database.getTask(task.id);
    return database.archiveTask(task.id, current.version, null, null, actor);
  }
  function createRun(task, { status = "running", bindIssue = true } = {}) {
    const thread = database.createAiChatThread({
      title: "Run fixture", model: "fixture", reasoningEffort: "low", sandbox: "workspace-write",
      origin: {
        projectId: project.id, projectName: project.name, workspacePath: directory,
        issueId: bindIssue ? task.id : null,
      },
    });
    return database.createAiChatRun({ threadId: thread.id, status });
  }
  function createAutoCutRun(task, runId) {
    return database.createFeishuAutoCutRun({
      taskId: task.id, runId, subjectKey: "base-test:table-test", configVersion: 1,
      stageId: "initial", eventId: `event-${task.id}`, resultPath: path.join(directory, `${runId}.json`),
    });
  }
  function createSubject({ lifecycle = "enabled", packageAlias = alias } = {}) {
    const timestamp = new Date().toISOString();
    const subjectKey = "base-test:table-test";
    database.database.prepare(`
      INSERT INTO feishu_bases (base_token, base_name, created_at, updated_at)
      VALUES ('base-test', 'Test Base', ?, ?)
    `).run(timestamp, timestamp);
    database.database.prepare(`
      INSERT INTO feishu_subjects (
        subject_key, base_token, table_id, table_name, project_id, lifecycle,
        config_version, config_json, metadata_json, created_at, updated_at
      ) VALUES (?, 'base-test', 'table-test', 'Test Subject', ?, ?, 1, ?, '{}', ?, ?)
    `).run(subjectKey, project.id, lifecycle, JSON.stringify({ packageRoute: { packageAlias } }), timestamp, timestamp);
    return subjectKey;
  }
  function createVersion(subjectKey, {
    version = 1, lifecycle = "enabled", closedAt = null, packageAlias = alias, branchMap,
  } = {}) {
    database.database.prepare(`
      INSERT INTO feishu_subject_versions (
        subject_key, version, snapshot_json, lifecycle, enabled_at, closed_at, created_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(subjectKey, version, JSON.stringify({ packageRoute: { packageAlias, branchMap } }),
      lifecycle, closedAt, new Date().toISOString());
  }
  return { database, createTask, archive, createRun, createAutoCutRun, createSubject, createVersion };
}

test("archived unfinished tasks release package references without deleting event history", async (t) => {
  const { database, createTask, archive } = await fixture(t);
  const task = createTask();
  assert.equal(database.listPackageReferences(alias).length, 1);
  archive(task);
  assert.deepEqual(database.listPackageReferences(alias), []);
  assert.equal(database.findFeishuTaskByEventId("event-1").id, task.id);
  assert.equal(database.getFeishuTaskOrigin(task.id).packageAlias, alias);
});

test("only unarchived nonterminal task states reserve a package without execution", async (t) => {
  const { database, createTask } = await fixture(t);
  const expected = [];
  for (const status of ["backlog", "todo", "queued", "in_progress", "in_review", "blocked", "done", "canceled"]) {
    const task = createTask({ status });
    if (!["done", "canceled"].includes(status)) expected.push(task.id);
  }
  assert.deepEqual(database.listPackageReferences(alias).map((entry) => entry.taskId).sort(), expected.sort());
});

for (const state of ["delayed", "queued", "running"]) {
  test(`${state} executions reserve their own package alias after task archival`, async (t) => {
    const { database, createTask, archive } = await fixture(t);
    const task = createTask({ status: "done", packageAlias: "Auto-cut-other" });
    const execution = database.createFeishuExecution({
      taskId: task.id, packageAlias: alias, packageRevision: 1, readyAt: 0, mode: "manual", trigger: "manual",
    });
    if (state !== "delayed") database.setFeishuExecutionState(task.id, execution.version, state);
    archive(task);
    assert.deepEqual(database.listPackageReferences(alias).map((entry) => entry.taskId), [task.id]);
    assert.deepEqual(database.listPackageReferences("Auto-cut-other"), []);
    database.clearFeishuExecution(task.id);
    assert.deepEqual(database.listPackageReferences(alias), []);
  });
}

test("startup claims reserve an archived package even if the task was marked complete", async (t) => {
  const { database, createTask, archive } = await fixture(t);
  const task = createTask();
  const claimed = database.claimTaskForAiStart(task.id, task.version, actor);
  // A task status can change independently while its start claim is still being settled.
  database.database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  archive(task);
  assert.deepEqual(database.listPackageReferences(alias).map((entry) => entry.taskId), [task.id]);
  database.deleteTaskAiStartClaim(task.id, claimed.claimToken);
  assert.deepEqual(database.listPackageReferences(alias), []);
});

test("running AI turns reserve their original task package after claim and thread binding are cleared", async (t) => {
  const { database, createTask, archive, createRun } = await fixture(t);
  const task = createTask({ status: "canceled" });
  const run = createRun(task);
  archive(task);
  assert.equal(database.getTask(task.id).threadId, null);
  assert.deepEqual(database.listPackageReferences(alias).map((entry) => entry.taskId), [task.id]);
  database.updateAiChatRun(run.id, { status: "completed", finishedAt: new Date().toISOString() });
  assert.deepEqual(database.listPackageReferences(alias), []);
});

test("Auto-Cut run binding protects active turns without relying on the current thread origin", async (t) => {
  const { database, createTask, archive, createRun, createAutoCutRun } = await fixture(t);
  const task = createTask({ status: "done" });
  const run = createRun(task, { bindIssue: false });
  createAutoCutRun(task, run.id);
  archive(task);
  assert.deepEqual(database.listPackageReferences(alias).map((entry) => entry.taskId), [task.id]);
  database.updateAiChatRun(run.id, { status: "failed", finishedAt: new Date().toISOString() });
  assert.deepEqual(database.listPackageReferences(alias), []);
});

test("multiple execution records for one task count as one reference", async (t) => {
  const { database, createTask, archive, createRun, createAutoCutRun } = await fixture(t);
  const task = createTask();
  database.claimTaskForAiStart(task.id, task.version, actor);
  database.createFeishuExecution({
    taskId: task.id, packageAlias: alias, packageRevision: 1, readyAt: 0, mode: "manual", trigger: "manual",
  });
  const run = createRun(task);
  createAutoCutRun(task, run.id);
  archive(task);
  assert.deepEqual(database.listPackageReferences(alias).map((entry) => entry.taskId), [task.id]);
});

test("historical Auto-Cut states and terminal AI turns do not reserve archived packages", async (t) => {
  const { database, createTask, archive, createRun, createAutoCutRun } = await fixture(t);
  for (const state of ["preparing", "prepared", "running", "reported", "blocked", "completed"]) {
    const task = createTask();
    const run = createRun(task, { status: "interrupted" });
    createAutoCutRun(task, run.id);
    database.updateFeishuAutoCutRun(run.id, { state });
    archive(task);
  }
  assert.deepEqual(database.listPackageReferences(alias), []);
});

test("a new draft does not release a still-active enabled subject version", async (t) => {
  const { database, createSubject, createVersion } = await fixture(t);
  const subjectKey = createSubject({ lifecycle: "draft", packageAlias: "Auto-cut-next" });
  createVersion(subjectKey);
  createVersion(subjectKey, { version: 2, lifecycle: "draft", packageAlias: "Auto-cut-next" });
  assert.deepEqual(database.listPackageReferences(alias).map((entry) => entry.subjectKey), [subjectKey]);
  assert.equal(database.listPackageReferences(alias)[0].lifecycle, "enabled");
  assert.deepEqual(database.listPackageReferences("Auto-cut-next"), []);
});

test("current and versioned subject routes count once and include branch aliases", async (t) => {
  const { database, createSubject, createVersion } = await fixture(t);
  const subjectKey = createSubject();
  createVersion(subjectKey);
  createVersion(subjectKey, { version: 2, packageAlias: null, branchMap: { history: alias } });
  assert.deepEqual(database.listPackageReferences(alias).map((entry) => entry.subjectKey), [subjectKey]);
});

test("active version branch routing still reserves packages when the current subject is a draft", async (t) => {
  const { database, createSubject, createVersion } = await fixture(t);
  const subjectKey = createSubject({ lifecycle: "draft", packageAlias: "Auto-cut-next" });
  createVersion(subjectKey, { packageAlias: null, branchMap: { history: alias } });
  assert.deepEqual(database.listPackageReferences(alias).map((entry) => entry.subjectKey), [subjectKey]);
});

test("closed and disabled versions do not reserve packages", async (t) => {
  const { database, createSubject, createVersion } = await fixture(t);
  const subjectKey = createSubject({ lifecycle: "disabled" });
  createVersion(subjectKey, { closedAt: 2 });
  createVersion(subjectKey, { version: 2, lifecycle: "disabled" });
  createVersion(subjectKey, { version: 3, lifecycle: "draft" });
  assert.deepEqual(database.listPackageReferences(alias), []);
});

for (const table of ["feishu_subjects", "feishu_bases"]) {
  test(`removed ${table} do not reserve packages through current or active version routes`, async (t) => {
    const { database, createSubject, createVersion } = await fixture(t);
    const subjectKey = createSubject();
    createVersion(subjectKey);
    database.database.prepare(`UPDATE ${table} SET removed_at = ?`).run(new Date().toISOString());
    assert.deepEqual(database.listPackageReferences(alias), []);
  });
}
