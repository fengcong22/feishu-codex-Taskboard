import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readVmPmoAiTranscript } from "../server/vm-pmo-ai-transcript.mjs";

async function runRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-ai-transcript-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function session(root, name, { events = [], report = null, outcome = null } = {}) {
  const directory = path.join(root, "ai-sessions", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  if (report !== null) await writeFile(path.join(directory, "report.txt"), report);
  if (outcome !== null) await writeFile(path.join(directory, "outcome.json"), JSON.stringify(outcome));
  return directory;
}

test("AI transcript lists sessions in order with messages, commands and the final report", async (t) => {
  const root = await runRoot(t);
  await session(root, "attempt-2-session-1", { report: "second" });
  await session(root, "attempt-1-session-2", { report: "first-b" });
  await session(root, "attempt-1-session-1", {
    events: [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.started", item: { id: "i0", type: "command_execution", command: "ignored while running" } },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "先读取准则" } },
      { type: "item.completed", item: { id: "i2", type: "reasoning", text: "意见指的是 4:22 那处" } },
      { type: "item.completed", item: { id: "i3", type: "command_execution", command: "python -m auto_cut_slicing evidence",
        aggregated_output: "x".repeat(5000), exit_code: 1, status: "failed" } },
      { type: "item.completed", item: { id: "i4", type: "file_change", changes: [{ path: "edit-intent.json", kind: "add" }] } },
      { type: "item.completed", item: { id: "i5", type: "agent_message", text: "" } },
      { type: "item.completed", item: { id: "i6", type: "unknown_kind" } },
      { type: "turn.completed" },
    ],
    report: "  已生成意图\n",
    outcome: { outcome: "completed", model: "gpt-test", resumed_from: null,
      started_at: "2026-11-20T01:00:00.000Z", finished_at: "2026-11-20T01:05:00.000Z" },
  });
  await writeFile(path.join(root, "ai-sessions", "notes.txt"), "not a session");
  const sessions = await readVmPmoAiTranscript(root);
  assert.deepEqual(sessions.map((row) => row.name), ["attempt-1-session-1", "attempt-1-session-2", "attempt-2-session-1"]);
  const first = sessions[0];
  assert.equal(first.attempt, "attempt-1");
  assert.equal(first.session, 1);
  assert.equal(first.outcome, "completed");
  assert.equal(first.model, "gpt-test");
  assert.equal(first.resumed, false);
  assert.equal(first.report, "已生成意图");
  assert.equal(first.eventsMissing, false);
  assert.deepEqual(first.steps.map((row) => row.kind), ["message", "reasoning", "command", "file_change"]);
  assert.equal(first.steps[2].exitCode, 1);
  assert.ok(first.steps[2].output.length < 2100);
  assert.ok(first.steps[2].output.endsWith("…"));
  assert.deepEqual(first.steps[3].files, ["edit-intent.json"]);
  assert.equal(sessions[1].outcome, null);
});

test("AI transcript is empty without a session directory and ignores linked or malformed files", async (t) => {
  const root = await runRoot(t);
  assert.deepEqual(await readVmPmoAiTranscript(root), []);
  assert.deepEqual(await readVmPmoAiTranscript("relative/path"), []);
  const directory = await session(root, "attempt-1-session-1");
  await writeFile(path.join(directory, "events.jsonl"), "{not json\n" + JSON.stringify({ type: "item.completed",
    item: { type: "agent_message", text: "仍然显示" } }) + "\n");
  await writeFile(path.join(directory, "outcome.json"), "[1]");
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "secret");
  await rm(path.join(directory, "report.txt"), { force: true });
  let linked = true;
  try { await symlink(outside, path.join(directory, "report.txt")); } catch { linked = false; }
  const [row] = await readVmPmoAiTranscript(root);
  assert.deepEqual(row.steps, [{ kind: "message", text: "仍然显示" }]);
  assert.equal(row.outcome, null);
  assert.equal(row.report, null, linked ? "a linked report is not followed" : "no report");
});
