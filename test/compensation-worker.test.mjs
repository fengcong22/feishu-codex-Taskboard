import assert from "node:assert/strict";
import test from "node:test";

import { createCompensationWorker } from "../src/compensation-worker.mjs";

function fakeTimers() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setTimeout(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) { callbacks.delete(id); },
    async fireNext() {
      const [id, callback] = callbacks.entries().next().value ?? [];
      if (id === undefined) return;
      callbacks.delete(id);
      await callback();
    },
  };
}

test("drains due records serially and never overlaps sweeps", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const worker = createCompensationWorker({
    bridge: {
      recover: async () => calls.push("recover"),
      processDue: async () => { calls.push("due"); await gate; return null; },
    },
    pollIntervalMs: 100,
    timers: fakeTimers(),
    logger: { error: assert.fail },
  });
  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.strictEqual(first, second);
  release();
  await first;
  assert.deepEqual(calls, ["recover", "due"]);
});

test("start performs an immediate sweep and schedules the next one", async () => {
  const timers = fakeTimers();
  const calls = [];
  const worker = createCompensationWorker({
    bridge: {
      recover: async () => calls.push("recover"),
      processDue: async () => {
        calls.push("due");
        return calls.filter((call) => call === "due").length < 2 ? { kind: "pending" } : null;
      },
    },
    pollIntervalMs: 100,
    timers,
    logger: { error: assert.fail },
  });

  worker.start();
  await worker.runOnce();
  assert.deepEqual(calls, ["recover", "due", "due"]);
  assert.equal(timers.callbacks.size, 1);

  await timers.fireNext();
  assert.deepEqual(calls, ["recover", "due", "due", "recover", "due"]);
  assert.equal(timers.callbacks.size, 1);
  await worker.stop();
  assert.equal(timers.callbacks.size, 0);
});

test("start is idempotent while the worker is running", async () => {
  const timers = fakeTimers();
  const worker = createCompensationWorker({
    bridge: {
      recover: async () => {},
      processDue: async () => null,
    },
    pollIntervalMs: 100,
    timers,
    logger: { error: assert.fail },
  });

  worker.start();
  await worker.runOnce();
  worker.start();
  assert.equal(timers.callbacks.size, 1);
  await worker.stop();
});

test("does not overlap a scheduled tick with an active sweep", async () => {
  const timers = fakeTimers();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const worker = createCompensationWorker({
    bridge: {
      recover: async () => {},
      processDue: async () => {
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        if (calls === 1) await gate;
        active -= 1;
        return null;
      },
    },
    pollIntervalMs: 100,
    timers,
    logger: { error: assert.fail },
  });

  worker.start();
  await Promise.resolve();
  const timerPromise = timers.fireNext();
  assert.equal(maximum, 1);
  release();
  await worker.runOnce();
  await timerPromise;
  assert.equal(maximum, 1);
  await worker.stop();
});

test("stop cancels future sweeps and waits for the active sweep", async () => {
  const timers = fakeTimers();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let completed = false;
  const worker = createCompensationWorker({
    bridge: {
      recover: async () => {},
      processDue: async () => { await gate; completed = true; return null; },
    },
    pollIntervalMs: 100,
    timers,
    logger: { error: assert.fail },
  });

  const active = worker.runOnce();
  const stopped = worker.stop();
  let stopSettled = false;
  void stopped.then(() => { stopSettled = true; });
  await Promise.resolve();
  assert.equal(stopSettled, false);
  release();
  await active;
  await stopped;
  assert.equal(completed, true);
  assert.equal(timers.callbacks.size, 0);
});

test("reports sweep failures without stopping future scheduling", async () => {
  const timers = fakeTimers();
  const errors = [];
  let calls = 0;
  const worker = createCompensationWorker({
    bridge: {
      recover: async () => { calls += 1; throw new Error("offline\nsecret"); },
      processDue: assert.fail,
    },
    pollIntervalMs: 100,
    timers,
    logger: { error: (message) => errors.push(message) },
  });

  worker.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(errors, ["Bridge compensation sweep failed"]);
  assert.doesNotMatch(errors[0], /secret/);
  assert.equal(timers.callbacks.size, 1);
  await worker.stop();
});
