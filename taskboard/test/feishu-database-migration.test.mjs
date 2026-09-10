import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

test("migrates legacy Feishu schemas before creating their dependent indexes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-migration-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE feishu_task_origins (
      task_id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO feishu_task_origins VALUES (
      'task-1',
      '{"subjectKey":"subject-1","configVersion":2,"stageId":"initial","eventId":"event-1","baseToken":"base-1","tableId":"table-1","recordId":"record-1","statusFieldId":"status-1"}',
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z'
    );
    INSERT INTO feishu_task_origins VALUES (
      'task-2',
      '{"subjectKey":"subject-1","configVersion":2,"stageId":"final_review","eventId":"event-1","baseToken":"base-1","tableId":"table-1","recordId":"record-2","statusFieldId":"status-1"}',
      '2026-09-01T00:00:01.000Z',
      '2026-09-01T00:00:01.000Z'
    );

    CREATE TABLE feishu_subject_versions (
      subject_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(subject_key, version)
    );
    INSERT INTO feishu_subject_versions VALUES (
      'subject-1',
      2,
      '{"lifecycle":"enabled"}',
      '2026-09-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const database = new TaskboardDatabase(filename);
  try {
    const origin = database.database.prepare(`
        SELECT subject_key, config_version, stage_id, event_id, base_token, table_id, record_id, status_field_id
        FROM feishu_task_origins
        WHERE task_id = 'task-1'
      `).get();
    assert.deepEqual(
      { ...origin },
      {
        subject_key: "subject-1",
        config_version: 2,
        stage_id: "initial",
        event_id: "event-1",
        base_token: "base-1",
        table_id: "table-1",
        record_id: "record-1",
        status_field_id: "status-1",
      },
    );
    assert.equal(
      database.database.prepare(`
        SELECT lifecycle FROM feishu_subject_versions
        WHERE subject_key = 'subject-1' AND version = 2
      `).get().lifecycle,
      "enabled",
    );
    assert.ok(
      database.database.prepare(`
        SELECT 1 FROM sqlite_schema
        WHERE type = 'index' AND name = 'feishu_task_origins_binding'
      `).get(),
    );
    assert.deepEqual(
      database.database.prepare(
        "PRAGMA index_info(feishu_task_origins_event_id_unique)",
      ).all().map((column) => column.name),
      ["registration_event_id"],
    );
    assert.equal(
      database.database.prepare(
        "SELECT COUNT(*) AS count FROM feishu_task_origins WHERE event_id = 'event-1'",
      ).get().count,
      2,
    );
    assert.equal(
      database.database.prepare(`
        SELECT COUNT(*) AS count FROM feishu_task_origins
        WHERE registration_event_id = 'event-1'
      `).get().count,
      1,
    );
    assert.ok(
      database.database.prepare(`
        SELECT 1 FROM sqlite_schema
        WHERE type = 'index' AND name = 'feishu_subject_versions_interval'
      `).get(),
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical duplicate event migration returns the task that owns the idempotency key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-event-owner-"));
  const filename = path.join(directory, "taskboard.sqlite");
  let database = new TaskboardDatabase(filename);
  const actor = { type: "user", id: "local-user", name: "Local user", avatarUrl: null };
  const createTask = (eventId, recordId) => database.createTask({
    projectId: "local",
    title: recordId,
    description: "fixture",
    status: "todo",
    priority: "none",
    labels: ["feishu"],
    actor,
    assignee: actor,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    feishuOrigin: {
      version: 1,
      source: "feishu-base",
      eventId,
      baseToken: "base-1",
      tableId: "table-1",
      recordId,
      triggerField: "status",
      triggerValue: "ready",
      mode: "manual",
    },
  });
  try {
    const first = createTask("event-a", "record-a");
    const second = createTask("event-b", "record-b");
    database.close();

    const ownerId = [first.id, second.id].sort()[0];
    const otherId = ownerId === first.id ? second.id : first.id;
    const raw = new DatabaseSync(filename);
    raw.exec("DROP INDEX feishu_task_origins_event_id_unique");
    raw.prepare(`
      UPDATE feishu_task_origins
      SET event_id = 'event-shared', registration_event_id = NULL,
          metadata_json = json_set(metadata_json, '$.eventId', 'event-shared')
    `).run();
    raw.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(
      "2026-09-01T00:00:02.000Z",
      ownerId,
    );
    raw.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(
      "2026-09-01T00:00:01.000Z",
      otherId,
    );
    raw.close();

    database = new TaskboardDatabase(filename);
    assert.equal(
      database.database.prepare(`
        SELECT task_id FROM feishu_task_origins
        WHERE registration_event_id = 'event-shared'
      `).get().task_id,
      ownerId,
    );
    assert.equal(database.findFeishuTaskByEventId("event-shared").id, ownerId);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("older Taskboard inserts reserve the global Feishu event id", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-legacy-writer-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  const actor = { type: "user", id: "local-user", name: "Local user", avatarUrl: null };
  const createOrdinaryTask = (title) => database.createTask({
    projectId: "local",
    title,
    description: "fixture",
    status: "todo",
    priority: "none",
    labels: [],
    actor,
    assignee: actor,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
  let legacy;
  try {
    const first = createOrdinaryTask("first legacy writer task");
    const second = createOrdinaryTask("second legacy writer task");
    const eventId = "event-from-legacy-writer";
    const metadata = {
      version: 1,
      source: "feishu-base",
      eventId,
      baseToken: "base-legacy",
      tableId: "table-legacy",
      recordId: "record-legacy",
      triggerField: "status",
      triggerValue: "ready",
      mode: "manual",
    };
    const timestamp = "2026-09-01T00:00:00.000Z";
    legacy = new DatabaseSync(filename);
    legacy.exec("PRAGMA foreign_keys = ON");
    const insertOrigin = legacy.prepare(`
      INSERT INTO feishu_task_origins (
        task_id, metadata_json, subject_key, config_version, stage_id, event_id,
        base_token, table_id, record_id, status_field_id, before_option_id, after_option_id,
        event_occurred_at, stage_snapshot_json, controlled_context_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insert = (taskId) => insertOrigin.run(
      taskId,
      JSON.stringify(metadata),
      null,
      null,
      null,
      eventId,
      metadata.baseToken,
      metadata.tableId,
      metadata.recordId,
      null,
      null,
      null,
      null,
      null,
      null,
      timestamp,
      timestamp,
    );

    insert(first.id);
    assert.equal(
      legacy.prepare(`
        SELECT registration_event_id FROM feishu_task_origins WHERE task_id = ?
      `).get(first.id).registration_event_id,
      eventId,
    );
    assert.throws(
      () => insert(second.id),
      /UNIQUE constraint failed: feishu_task_origins\.registration_event_id/,
    );
    assert.equal(
      legacy.prepare("SELECT COUNT(*) AS count FROM feishu_task_origins WHERE event_id = ?")
        .get(eventId).count,
      1,
    );
  } finally {
    legacy?.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered Feishu tasks retain their event reservation after deletion attempts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-delete-guard-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  const actor = { type: "user", id: "local-user", name: "Local user", avatarUrl: null };
  try {
    const eventId = "event-delete-guard";
    const task = database.createTask({
      projectId: "local",
      title: "registered task",
      description: "fixture",
      status: "todo",
      priority: "none",
      labels: ["feishu"],
      actor,
      assignee: actor,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
      feishuOrigin: {
        version: 1,
        source: "feishu-base",
        eventId,
        baseToken: "base-delete",
        tableId: "table-delete",
        recordId: "record-delete",
        triggerField: "status",
        triggerValue: "ready",
        mode: "manual",
      },
    });
    const archived = database.archiveTask(task.id, task.version, null, null, actor);

    assert.throws(
      () => database.deleteArchivedTask(task.id, archived.version),
      (error) => error?.status === 409 && error?.code === "FEISHU_TASK_DELETE_UNAVAILABLE",
    );
    assert.equal(database.findFeishuTaskByEventId(eventId).id, task.id);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("event id migration excludes older writers until the reservation switch commits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-migration-race-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const actor = { type: "user", id: "local-user", name: "Local user", avatarUrl: null };
  let setup = new TaskboardDatabase(filename);
  const createOrdinaryTask = (title) => setup.createTask({
    projectId: "local",
    title,
    description: "fixture",
    status: "todo",
    priority: "none",
    labels: [],
    actor,
    assignee: actor,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
  const first = createOrdinaryTask("migration race first");
  const second = createOrdinaryTask("migration race second");
  setup.close();
  setup = null;

  const downgrade = new DatabaseSync(filename);
  downgrade.exec(`
    DROP INDEX feishu_task_origins_event_id_unique;
    DROP TRIGGER feishu_task_origins_reserve_legacy_event_id;
    CREATE UNIQUE INDEX feishu_task_origins_event
      ON feishu_task_origins(base_token, table_id, record_id, status_field_id, stage_id, event_id)
      WHERE event_id IS NOT NULL AND stage_id IS NOT NULL;
  `);
  downgrade.close();

  const legacy = new DatabaseSync(filename);
  legacy.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
  const insertOrigin = legacy.prepare(`
    INSERT INTO feishu_task_origins (
      task_id, metadata_json, subject_key, config_version, stage_id, event_id,
      base_token, table_id, record_id, status_field_id, before_option_id, after_option_id,
      event_occurred_at, stage_snapshot_json, controlled_context_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const eventId = "event-migration-race";
  const insertLegacyOrigin = (taskId, recordId) => {
    const metadata = {
      version: 1,
      source: "feishu-base",
      eventId,
      baseToken: "base-race",
      tableId: "table-race",
      recordId,
      triggerField: "status",
      triggerFieldId: "field-race",
      triggerValue: "ready",
      stageId: "initial",
      mode: "manual",
    };
    return insertOrigin.run(
      taskId,
      JSON.stringify(metadata),
      "base-race:table-race",
      1,
      "initial",
      eventId,
      metadata.baseToken,
      metadata.tableId,
      recordId,
      metadata.triggerFieldId,
      "option-before",
      "option-ready",
      1_788_192_000_000,
      null,
      null,
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
  };
  insertLegacyOrigin(first.id, "record-a");

  const originalExec = DatabaseSync.prototype.exec;
  let migrationConnection = null;
  let interleavedAttempted = false;
  let interleavedError = null;
  let migrated = null;
  DatabaseSync.prototype.exec = function hookedExec(sql) {
    const statement = String(sql);
    if (
      !migrationConnection
      && statement.includes("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL")
    ) {
      migrationConnection = this;
    }
    const dropLegacyIndex = "DROP INDEX IF EXISTS feishu_task_origins_event;";
    if (
      this === migrationConnection
      && !interleavedAttempted
      && statement.includes(dropLegacyIndex)
    ) {
      originalExec.call(this, dropLegacyIndex);
      interleavedAttempted = true;
      try {
        insertLegacyOrigin(second.id, "record-b");
      } catch (error) {
        interleavedError = error;
      }
      return originalExec.call(this, statement.replace(dropLegacyIndex, ""));
    }
    return originalExec.call(this, sql);
  };

  try {
    try {
      migrated = new TaskboardDatabase(filename);
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    assert.equal(interleavedAttempted, true);
    if (interleavedError) {
      assert.match(interleavedError.message, /database is locked/);
      assert.throws(
        () => insertLegacyOrigin(second.id, "record-b"),
        /UNIQUE constraint failed: feishu_task_origins\.registration_event_id/,
      );
    }
    const counts = migrated.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN registration_event_id = ? THEN 1 ELSE 0 END) AS reserved
      FROM feishu_task_origins
      WHERE event_id = ?
    `).get(eventId, eventId);
    assert.deepEqual({ ...counts }, { total: 1, reserved: 1 });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    migrated?.close();
    setup?.close();
    legacy.close();
    await rm(directory, { recursive: true, force: true });
  }
});
