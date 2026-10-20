import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-database-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  return {
    database,
    directory,
    filename,
    async close() {
      this.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("thread summaries retain the latest result while currentRun remains active-only", async () => {
  const fixture = await createFixture();
  try {
    const { database } = fixture;
    for (const id of ["edit", "other", "empty"]) {
      database.createAiChatThread({
        id, title: id, origin: { projectId: "local", projectName: "Example", workspacePath: "/tmp/example" },
        model: "local-autocut", reasoningEffort: "none", sandbox: "workspace-write",
      });
    }
    function check(expected, active = null) {
      for (const summary of [database.getAiChatThread("edit"), database.listAiChatThreads().find((item) => item.id === "edit")]) {
        assert.deepEqual(summary.latestRun, expected);
        assert.deepEqual(summary.currentRun, active);
      }
      assert.equal(database.getAiChatThread("empty").latestRun, null);
    }
    check(null);
    database.createAiChatRun({ id: "unrelated", threadId: "other", status: "failed", startedAt: "2026-10-15T00:00:00Z" });
    for (const [index, status] of ["failed", "completed", "interrupted"].entries()) {
      const id = `attempt-${index}`;
      const running = database.createAiChatRun({ id, threadId: "edit", startedAt: `2026-10-14T09:0${index}:00Z` });
      check(running, running);
      const terminal = database.updateAiChatRun(id, { status, finishedAt: `2026-10-14T09:0${index}:30Z` });
      check(terminal);
    }
    // Historical insertion order must not replace a more recent attempt.
    database.createAiChatRun({ id: "late-import", threadId: "edit", status: "failed", startedAt: "2026-10-13T00:00:00Z" });
    check(database.getAiChatRun("attempt-2"));
    const tied = database.createAiChatRun({ id: "z-attempt", threadId: "edit", status: "completed", startedAt: "2026-10-14T09:02:00Z" });
    check(tied);
  } finally {
    await fixture.close();
  }
});

test("AI chat persistence stores threads, runs, and visible events without hidden prompt fields", async () => {
  const fixture = await createFixture();
  try {
    const thread = fixture.database.createAiChatThread({
      id: "thread-1",
      title: "New conversation",
      status: "idle",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
        issueId: "task-1",
        issueIdentifier: "LOCAL-1",
      },
      codexThreadId: null,
      model: "gpt-real",
      reasoningEffort: "high",
      sandbox: "workspace-write",
    });
    assert.equal(thread.origin.issueIdentifier, "LOCAL-1");
    assert.equal(thread.currentRun, null);

    const run = fixture.database.createAiChatRun({
      id: "run-1",
      threadId: thread.id,
      status: "running",
    });
    fixture.database.insertAiChatEvent({
      id: "event-1",
      threadId: thread.id,
      runId: run.id,
      type: "agent_message",
      role: "assistant",
      content: "Visible answer",
      data: { status: "completed" },
    });
    fixture.database.updateAiChatThread(thread.id, {
      status: "running",
      codexThreadId: "codex-thread-1",
    });

    assert.equal(fixture.database.getAiChatThread(thread.id).currentRun.id, run.id);
    assert.equal(fixture.database.listAiChatThreads()[0].codexThreadId, "codex-thread-1");
    assert.deepEqual(fixture.database.listAiChatEvents(thread.id).map((event) => event.content), [
      "Visible answer",
    ]);
    assert.equal(fixture.database.listAiChatRuns(thread.id)[0].status, "running");

    for (const table of ["ai_chat_threads", "ai_chat_runs", "ai_chat_events"]) {
      const columns = fixture.database.database.prepare(`PRAGMA table_info(${table})`).all();
      assert.equal(
        columns.some((column) => /prompt|raw/i.test(column.name)),
        false,
        `${table} must not persist hidden prompts or raw Codex JSONL`,
      );
    }
  } finally {
    await fixture.close();
  }
});

test("opening the database interrupts abandoned runs and preserves resumable Codex thread ids", async () => {
  const fixture = await createFixture();
  fixture.database.createAiChatThread({
    id: "thread-1",
    title: "New conversation",
    status: "running",
    origin: {
      projectId: "local",
      projectName: "Local",
      workspacePath: "/tmp/project",
    },
    codexThreadId: "codex-thread-1",
    model: "gpt-real",
    reasoningEffort: "medium",
    sandbox: "read-only",
  });
  fixture.database.createAiChatRun({
    id: "run-1",
    threadId: "thread-1",
    status: "running",
  });
  fixture.database.close();

  const reopened = new TaskboardDatabase(fixture.filename);
  fixture.database = reopened;
  try {
    assert.equal(reopened.getAiChatRun("run-1").status, "interrupted");
    assert.equal(reopened.getAiChatRun("run-1").finishedAt === null, false);
    assert.equal(reopened.getAiChatThread("thread-1").codexThreadId, "codex-thread-1");
    assert.equal(reopened.getAiChatThread("thread-1").status, "idle");
    assert.equal(reopened.getAiChatThread("thread-1").currentRun, null);
  } finally {
    await fixture.close();
  }
});

test("deleting a newly-created running AI chat run restores the thread to idle", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createAiChatThread({
      id: "thread-1",
      title: "New conversation",
      status: "idle",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
      },
      codexThreadId: null,
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    fixture.database.createAiChatRun({
      id: "run-1",
      threadId: "thread-1",
      status: "running",
    });

    fixture.database.deleteAiChatRun("run-1");

    assert.equal(fixture.database.getAiChatRun("run-1"), null);
    assert.equal(fixture.database.getAiChatThread("thread-1").status, "idle");
    assert.equal(fixture.database.getAiChatThread("thread-1").currentRun, null);
  } finally {
    await fixture.close();
  }
});

test("deleting an AI chat thread removes its runs and visible events", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createAiChatThread({
      id: "thread-1",
      title: "New conversation",
      status: "idle",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
      },
      codexThreadId: null,
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    fixture.database.createAiChatRun({
      id: "run-1",
      threadId: "thread-1",
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    fixture.database.insertAiChatEvent({
      id: "event-1",
      threadId: "thread-1",
      runId: "run-1",
      type: "agent_message",
      role: "assistant",
      content: "Visible answer",
    });

    fixture.database.deleteAiChatThread("thread-1");

    assert.equal(fixture.database.getAiChatThread("thread-1"), null);
    assert.equal(fixture.database.getAiChatRun("run-1"), null);
    assert.equal(
      fixture.database.database.prepare("SELECT COUNT(*) AS count FROM ai_chat_events").get().count,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("AI chat events with the same timestamp retain SQLite insertion order", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createAiChatThread({
      id: "thread-1",
      title: "New conversation",
      origin: {
        projectId: "local",
        projectName: "Local",
        workspacePath: "/tmp/project",
      },
      model: "gpt-real",
      reasoningEffort: "medium",
      sandbox: "read-only",
    });
    const createdAt = "2026-07-27T12:00:00.000Z";
    fixture.database.insertAiChatEvent({
      id: "z-first",
      threadId: "thread-1",
      type: "agent_message",
      role: "assistant",
      content: "first",
      createdAt,
    });
    fixture.database.insertAiChatEvent({
      id: "a-second",
      threadId: "thread-1",
      type: "agent_message",
      role: "assistant",
      content: "second",
      createdAt,
    });

    assert.deepEqual(
      fixture.database.listAiChatEvents("thread-1").map((event) => event.id),
      ["z-first", "a-second"],
    );
  } finally {
    await fixture.close();
  }
});
