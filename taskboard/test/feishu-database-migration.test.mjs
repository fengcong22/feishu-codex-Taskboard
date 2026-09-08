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
