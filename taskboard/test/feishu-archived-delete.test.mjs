import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TaskboardDatabase } from "../server/database.mjs";

const actor = { type: "user", id: "local-user", name: "Local user", avatarUrl: null };
function input(eventId = "delete-event") {
  return {
    projectId: "local", title: "Private task title", description: "Private task body",
    status: "todo", priority: "none", labels: ["feishu"], actor, assignee: actor,
    startDate: null, dueDate: null,
    feishuOrigin: { version: 1, source: "feishu-base", eventId, baseToken: "base-delete",
      tableId: "table-delete", recordId: "record-delete", triggerField: "status", triggerValue: "ready", mode: "manual" },
  };
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-delete-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  return { directory, filename, database };
}

test("archived Feishu deletion keeps only event fingerprints and blocks recreation after restart", async () => {
  const f = await fixture();
  let db = f.database;
  try {
    const task = db.createTask(input());
    const archived = db.archiveTask(task.id, task.version, null, null, actor);
    db.deleteArchivedTask(task.id, archived.version);
    assert.equal(db.getTask(task.id), null);
    assert.equal(db.findFeishuTaskByEventId("delete-event"), null);
    const rows = db.database.prepare("SELECT * FROM feishu_task_deletions").all();
    assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /Private task|record-delete|table-delete/);
    db.close(); db = new TaskboardDatabase(f.filename);
    assert.throws(() => db.createTask(input()), { status: 410, code: "FEISHU_TASK_DELETED" });
    const changed = input(); changed.feishuOrigin.recordId = "other-record";
    assert.throws(() => db.createTask(changed), { status: 409, code: "FEISHU_EVENT_BINDING_CONFLICT" });
    assert.ok(db.createTask(input("new-event")).id);
    // A writer that still uses the old origin INSERT shape must also be blocked.
    const ordinary = input("unused"); delete ordinary.feishuOrigin;
    const other = db.createTask(ordinary);
    assert.throws(() => db.database.prepare(`INSERT INTO feishu_task_origins
      (task_id,metadata_json,event_id,created_at,updated_at) VALUES (?,?,?,?,?)`)
      .run(other.id, JSON.stringify(input().feishuOrigin), "delete-event", "now", "now"), /FEISHU_TASK_DELETED/);
  } finally { db.close(); await rm(f.directory, { recursive: true, force: true }); }
});

for (const activity of ["claim", "scheduler", "thread"]) {
  test(`archived Feishu deletion refuses an active ${activity}`, async () => {
    const f = await fixture(); const db = f.database;
    try {
      const task = db.createTask(input());
      if (activity === "claim") db.claimTaskForAiStart(task.id, task.version, actor);
      if (activity === "scheduler") db.database.prepare(`INSERT INTO feishu_task_executions
        (task_id,state,mode,ready_at,package_alias,package_revision,trigger,created_at,updated_at)
        VALUES (?,'delayed','automatic',?,'test',1,'automatic','now','now')`).run(task.id, Date.now());
      if (activity === "thread") {
        const thread = db.createAiChatThread({ title: "run", origin: {projectId: "local", projectName: "local", workspacePath: f.directory, issueId: task.id}, model: "local-autocut", reasoningEffort: "none", sandbox: "workspace-write" });
        db.createAiChatRun({ threadId: thread.id });
      }
      const current = db.getTask(task.id);
      const archived = db.archiveTask(task.id, current.version, null, null, actor);
      assert.throws(() => db.deleteArchivedTask(task.id, archived.version), { code: "TASK_EXECUTION_ACTIVE" });
      assert.ok(db.getTask(task.id));
      assert.equal(db.database.prepare("SELECT count(*) n FROM feishu_task_deletions").get().n, 0);
    } finally { db.close(); await rm(f.directory, { recursive: true, force: true }); }
  });
}

test("deletion failure rolls back the event reservation and all task changes", async () => {
  const f = await fixture(); const db = f.database;
  try {
    const task = db.createTask(input());
    const archived = db.archiveTask(task.id, task.version, null, null, actor);
    db.database.exec("CREATE TRIGGER reject_test_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'fixture delete failure'); END;");
    assert.throws(() => db.deleteArchivedTask(task.id, archived.version), /fixture delete failure/);
    assert.ok(db.getTask(task.id));
    assert.equal(db.database.prepare("SELECT count(*) n FROM feishu_task_deletions").get().n, 0);
  } finally { db.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("invalid stored Feishu origin fails closed without deleting the event reservation", async () => {
  const f = await fixture(); const db = f.database;
  try {
    const task = db.createTask(input());
    const archived = db.archiveTask(task.id, task.version, null, null, actor);
    db.database.prepare("UPDATE feishu_task_origins SET metadata_json = '{}' WHERE task_id = ?").run(task.id);
    assert.throws(() => db.deleteArchivedTask(task.id, archived.version), { code: "FEISHU_DELETE_ORIGIN_INVALID" });
    assert.ok(db.getTask(task.id));
    assert.ok(db.database.prepare("SELECT 1 FROM feishu_task_origins WHERE task_id = ?").get(task.id));
    assert.equal(db.database.prepare("SELECT count(*) n FROM feishu_task_deletions").get().n, 0);
  } finally { db.close(); await rm(f.directory, { recursive: true, force: true }); }
});

for (const order of ["owner-first", "duplicate-first"]) {
  test(`historical duplicate deletion preserves the canonical event identity (${order})`, async () => {
    const f = await fixture(); let db = f.database;
    try {
      const first = db.createTask(input("first-event"));
      const secondInput = input("second-event"); secondInput.feishuOrigin.recordId = "historical-other-record";
      const second = db.createTask(secondInput);
      // Recreate the supported pre-unique-index schema, then run the real migration.
      db.database.exec(`DROP INDEX feishu_task_origins_event_id_unique;
        UPDATE feishu_task_origins SET event_id = 'shared-event', registration_event_id = NULL,
          metadata_json = json_set(metadata_json, '$.eventId', 'shared-event');`);
      db.close(); db = new TaskboardDatabase(f.filename);
      const owner = db.findFeishuTaskByEventId("shared-event");
      const duplicateId = owner.id === first.id ? second.id : first.id;
      const canonicalOrigin = db.getFeishuTaskOrigin(owner.id);
      const taskIds = order === "owner-first" ? [owner.id, duplicateId] : [duplicateId, owner.id];
      for (const taskId of taskIds) {
        const current = db.getTask(taskId);
        const archived = db.archiveTask(taskId, current.version, null, null, actor);
        db.deleteArchivedTask(taskId, archived.version);
        db.close(); db = new TaskboardDatabase(f.filename);
        if (db.getTask(owner.id)) {
          assert.doesNotThrow(() => db.assertFeishuEventNotDeleted(canonicalOrigin));
          assert.equal(db.findFeishuTaskByEventId("shared-event").id, owner.id);
        } else {
          assert.throws(() => db.assertFeishuEventNotDeleted(canonicalOrigin), { code: "FEISHU_TASK_DELETED", status: 410 });
        }
      }
      assert.equal(db.database.prepare("SELECT count(*) n FROM feishu_task_deletions").get().n, 1);
    } finally { db.close(); await rm(f.directory, { recursive: true, force: true }); }
  });
}
