import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonStateStore } from "../src/state-store.mjs";

test("persists event outcomes across store instances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-bridge-state-"));
  const filename = path.join(directory, "state.json");
  const first = new JsonStateStore(filename);
  assert.equal(await first.get("evt_1"), null);
  await first.put("evt_1", { kind: "ready", taskId: "task_1" });
  const second = new JsonStateStore(filename);
  assert.deepEqual(await second.get("evt_1"), { kind: "ready", taskId: "task_1" });
});

test("does not overwrite an existing event outcome", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-bridge-state-"));
  const store = new JsonStateStore(path.join(directory, "state.json"));
  await store.put("evt_1", { taskId: "first" });
  await store.put("evt_1", { taskId: "second" });
  assert.deepEqual(await store.get("evt_1"), { taskId: "first" });
});

test("replaces a pending outcome with the completed task outcome", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-bridge-state-"));
  const store = new JsonStateStore(path.join(directory, "state.json"));
  await store.put("evt_1", { kind: "pending" });
  await store.replace("evt_1", { kind: "ready", taskId: "task_1" });
  assert.deepEqual(await store.get("evt_1"), { kind: "ready", taskId: "task_1" });
});

test("preserves writes made concurrently by separate store instances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-bridge-state-"));
  const filename = path.join(directory, "state.json");
  const first = new JsonStateStore(filename);
  const second = new JsonStateStore(filename);
  await Promise.all([
    first.put("evt_a", { taskId: "task_a" }),
    second.put("evt_b", { taskId: "task_b" }),
  ]);
  const final = new JsonStateStore(filename);
  assert.deepEqual(await final.get("evt_a"), { taskId: "task_a" });
  assert.deepEqual(await final.get("evt_b"), { taskId: "task_b" });
});

test("treats prototype-looking event ids as ordinary own keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-bridge-state-"));
  const store = new JsonStateStore(path.join(directory, "state.json"));
  for (const eventId of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const outcome = { eventId };
    await store.put(eventId, outcome);
    assert.deepEqual(await store.get(eventId), outcome);
  }
});
