import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createFeishuExecutionCoordinator } from "../server/feishu-execution-coordinator.mjs";
import { createResourceScheduler } from "../server/resource-scheduler.mjs";

const actor = { type: "user", id: "tester", name: "Tester", avatarUrl: null };
const packageAlias = "Auto-cut-trigger-test";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-execution-trigger-"));
  const databasePath = path.join(directory, "taskboard.sqlite");
  let database = new TaskboardDatabase(databasePath);
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const project = database.createProject({ id: "trigger-test", name: "Trigger test", workspacePath: null });
  const task = database.createTask({
    projectId: project.id, title: "Fixture lesson", description: "", status: "todo", priority: "none",
    labels: ["feishu"], actor, assignee: actor, startDate: null, dueDate: null,
    feishuOrigin: {
      source: "feishu-base", eventId: "event-test", baseToken: "base-test", tableId: "table-test",
      recordId: "record-test", packageAlias,
    },
  });
  return {
    get database() { return database; }, task,
    reopen() { database.close(); database = new TaskboardDatabase(databasePath); return database; },
  };
}

for (const trigger of ["manual", "move", "retry"]) {
  test(`execution trigger can persist a ${trigger} takeover but cannot be promoted to automatic`, async (t) => {
    const fixtureData = await fixture(t);
    const { database, task } = fixtureData;
    const automatic = database.createFeishuExecution({
      taskId: task.id, mode: "automatic", trigger: "automatic", readyAt: 6_000, packageAlias, packageRevision: 1,
    });
    const updated = database.setFeishuExecutionState(task.id, automatic.version, "delayed", { trigger, readyAt: 1_000 });
    assert.equal(updated.trigger, trigger);
    assert.equal(updated.readyAt, 1_000);
    assert.throws(
      () => database.setFeishuExecutionState(task.id, automatic.version, "delayed", { trigger }),
      { code: "EXECUTION_VERSION_CONFLICT" },
    );
    for (const invalid of ["automatic", "shell", "", null]) {
      assert.throws(
        () => database.setFeishuExecutionState(task.id, updated.version, "delayed", { trigger: invalid }),
        { code: "INVALID_FIELD" },
      );
    }
    const reopened = fixtureData.reopen();
    assert.equal(reopened.getFeishuExecution(task.id).trigger, trigger);
    assert.equal(reopened.getFeishuExecution(task.id).version, updated.version);
  });
}

test("a real database preserves a manually expedited queue through disabling and restart", async (t) => {
  const fixtureData = await fixture(t);
  let enabled = true;
  let scheduler = createResourceScheduler();
  const starts = [];
  const metadata = {
    packageAlias, executionMode: "automatic", packageRevision: 1,
    stageId: "initial", resourceGroups: [],
  };
  const timers = { setTimeout() { return 1; }, clearTimeout() {} };
  function createCoordinator() {
    const database = fixtureData.database;
    return createFeishuExecutionCoordinator({
      database, scheduler, now: () => 1_000, timers,
      allowAutomaticExecution: () => enabled,
      packageStore: { async get() { return { maxConcurrent: 1 }; } },
      resolveCurrentMetadata: () => metadata,
      async startClaimedTask(task, _metadata, lease, trigger) {
        starts.push(trigger);
        database.transitionFeishuTaskExecution(task.id, task.version, "in_progress");
        return { task: database.getTask(task.id), lease };
      },
    });
  }
  let coordinator = createCoordinator();
  t.after(() => coordinator.close());
  const request = { requestId: "resource-holder", concurrencyGroup: `autocut:${packageAlias}`, maxConcurrent: 1 };
  await scheduler.request(request);
  await coordinator.schedule(fixtureData.database.getTask(fixtureData.task.id), metadata, "automatic");
  await coordinator.schedule(fixtureData.database.getTask(fixtureData.task.id), metadata, "manual", { actor });
  assert.equal(fixtureData.database.getFeishuExecution(fixtureData.task.id).trigger, "manual");
  assert.equal(fixtureData.database.getTask(fixtureData.task.id).status, "queued");
  enabled = false;
  assert.equal(coordinator.cancelPendingAutomatic(), 0);
  await coordinator.close();
  fixtureData.reopen();
  scheduler = createResourceScheduler();
  const heldLease = await scheduler.request(request);
  coordinator = createCoordinator();
  await coordinator.recover();
  assert.equal(coordinator.cancelPendingAutomatic(), 0);
  assert.equal(fixtureData.database.getFeishuExecution(fixtureData.task.id).state, "queued");
  scheduler.release(heldLease);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ["manual"]);
  assert.equal(fixtureData.database.getFeishuExecution(fixtureData.task.id).state, "running");
});
