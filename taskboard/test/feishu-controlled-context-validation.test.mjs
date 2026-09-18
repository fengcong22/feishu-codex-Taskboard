import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

const actor = { type: "user", id: "local-user", name: "Local user", avatarUrl: null };

function input(eventId, courseName) {
  return {
    projectId: "local",
    title: "课程交付",
    description: "",
    status: "todo",
    priority: "none",
    labels: ["feishu"],
    actor,
    assignee: actor,
    startDate: null,
    dueDate: null,
    feishuOrigin: {
      version: 1,
      source: "feishu-base",
      eventId,
      baseToken: "bas_course",
      tableId: "tbl_course",
      recordId: `rec_${eventId}`,
      controlledContext: {
        documentLinks: [],
        namingDisplayValue: "课程001",
        namingValueUnique: true,
        ...(courseName === undefined ? {} : { courseName }),
      },
    },
  };
}

test("database validates optional course names while preserving legacy controlled context", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-controlled-context-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    const legacy = database.createTask(input("evt-legacy"));
    assert.equal(Object.hasOwn(database.getFeishuTaskOrigin(legacy.id).controlledContext, "courseName"), false);

    const legacyEmpty = database.createTask(input("evt-legacy-empty", ""));
    assert.equal(Object.hasOwn(database.getFeishuTaskOrigin(legacyEmpty.id).controlledContext, "courseName"), false);

    const valid = database.createTask(input("evt-valid", "课程001"));
    assert.equal(database.getFeishuTaskOrigin(valid.id).controlledContext.courseName, "课程001");

    for (const [index, courseName] of ["课程/001", "课程 ", "课".repeat(181)].entries()) {
      assert.throws(
        () => database.createTask(input(`evt-invalid-${index}`, courseName)),
        { code: "INVALID_FEISHU_ORIGIN", status: 400 },
      );
    }
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
