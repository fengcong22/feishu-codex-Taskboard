import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createFeishuDeliveryStore } from "../server/feishu-delivery-store.mjs";

const timestamp = "2026-09-17T08:00:00.000Z";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-course-binding-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  const store = createFeishuDeliveryStore({
    database,
    now: () => timestamp,
    idFactory: () => "binding-001",
  });
  return { directory, filename, database, store };
}

function bindingInput(overrides = {}) {
  return {
    identity: { baseToken: "bas_delivery", tableId: "tbl_courses", recordId: "rec_001" },
    subjectVersion: 4,
    namingValue: "课程001",
    resolvedPaths: {
      actualRoot: "W:\\【--剪映草稿--】",
      coursePath: "W:\\【--剪映草稿--】\\课程001",
      displayPath: "学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
      pathKind: "network",
      canonicalLocationKey: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
    },
    trustedEventId: "event-001",
    ...overrides,
  };
}

test("migrates the course binding table for an existing Taskboard database", async () => {
  const { directory, filename, database } = await fixture();
  try {
    database.database.exec("DROP TABLE feishu_course_bindings");
    database.close();
    const reopened = new TaskboardDatabase(filename);
    try {
      const columns = reopened.database.prepare("PRAGMA table_info(feishu_course_bindings)").all()
        .map((column) => column.name);
      assert.deepEqual(columns, [
        "id",
        "base_token",
        "table_id",
        "record_id",
        "first_config_version",
        "course_name",
        "actual_root",
        "course_path",
        "display_path",
        "canonical_location_key",
        "path_kind",
        "first_event_id",
        "created_at",
        "updated_at",
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists one immutable course binding and restores it after restart", async () => {
  const { directory, filename, database, store } = await fixture();
  try {
    const binding = store.ensureCourseBinding(bindingInput());
    assert.deepEqual(binding, {
      bindingId: "binding-001",
      baseToken: "bas_delivery",
      tableId: "tbl_courses",
      recordId: "rec_001",
      firstConfigVersion: 4,
      courseName: "课程001",
      actualRoot: "W:\\【--剪映草稿--】",
      coursePath: "W:\\【--剪映草稿--】\\课程001",
      displayPath: "学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
      canonicalLocationKey: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
      pathKind: "network",
      firstEventId: "event-001",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    database.close();

    const reopened = new TaskboardDatabase(filename);
    try {
      const restored = createFeishuDeliveryStore({ database: reopened }).getCourseBinding(bindingInput().identity);
      assert.deepEqual(restored, binding);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reuses the first binding for the same Feishu record after the course field changes", async () => {
  const { directory, database, store } = await fixture();
  try {
    const first = store.ensureCourseBinding(bindingInput());
    const reused = store.ensureCourseBinding(bindingInput({
      subjectVersion: 5,
      namingValue: "课程001-改名后",
      resolvedPaths: {
        actualRoot: "W:\\【--剪映草稿--】",
        coursePath: "W:\\【--剪映草稿--】\\课程001-改名后",
        displayPath: "学科实拍素材临时传输\\【--剪映草稿--】\\课程001-改名后",
        pathKind: "network",
        canonicalLocationKey: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】\\课程001-改名后",
      },
      trustedEventId: "event-002",
    }));

    assert.deepEqual(reused, first);
    assert.equal(
      database.database.prepare("SELECT COUNT(*) AS count FROM feishu_course_bindings").get().count,
      1,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a second record that resolves to an already bound canonical course path", async () => {
  const { directory, database, store } = await fixture();
  try {
    store.ensureCourseBinding(bindingInput());
    assert.throws(
      () => store.ensureCourseBinding(bindingInput({
        identity: { baseToken: "bas_delivery", tableId: "tbl_courses", recordId: "rec_002" },
        resolvedPaths: {
          actualRoot: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】",
          coursePath: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
          displayPath: "学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
          pathKind: "unc",
          canonicalLocationKey: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
        },
        trustedEventId: "event-002",
      })),
      { code: "COURSE_PATH_CONFLICT" },
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("detects canonical path collisions when a legacy binding table lacks the unique path constraint", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE feishu_course_bindings (
      id TEXT PRIMARY KEY,
      base_token TEXT NOT NULL,
      table_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      first_config_version INTEGER NOT NULL,
      course_name TEXT NOT NULL,
      actual_root TEXT NOT NULL,
      course_path TEXT NOT NULL,
      display_path TEXT NOT NULL,
      canonical_location_key TEXT NOT NULL,
      path_kind TEXT NOT NULL,
      first_event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(base_token, table_id, record_id)
    );
  `);
  const store = createFeishuDeliveryStore({
    database,
    now: () => timestamp,
    idFactory: (() => {
      let count = 0;
      return () => `binding-legacy-${++count}`;
    })(),
  });

  try {
    store.ensureCourseBinding(bindingInput());
    assert.throws(
      () => store.ensureCourseBinding(bindingInput({
        identity: { baseToken: "bas_delivery", tableId: "tbl_courses", recordId: "rec_legacy_002" },
        trustedEventId: "event-legacy-002",
      })),
      { code: "COURSE_PATH_CONFLICT" },
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM feishu_course_bindings").get().count,
      1,
    );
  } finally {
    database.close();
  }
});
