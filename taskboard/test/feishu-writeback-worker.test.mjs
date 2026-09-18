import assert from "node:assert/strict";
import { test } from "node:test";

import { createFeishuWritebackWorker } from "../server/feishu-writeback-worker.mjs";

function intent(overrides = {}) {
  return {
    id: "writeback-001",
    claimToken: "claim-001",
    version: 2,
    attemptCount: 1,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("dispatches one claimed intent and marks it succeeded only after Bridge confirmation", async () => {
  let claimed = false;
  const calls = [];
  const worker = createFeishuWritebackWorker({
    store: {
      recoverExpiredWritebackIntents() { return 0; },
      claimNextWritebackIntent() {
        if (claimed) return null;
        claimed = true;
        return intent();
      },
      markWritebackIntentSucceeded(id, claimToken) {
        calls.push(["succeeded", id, claimToken]);
        return { id, state: "succeeded" };
      },
      getNextWritebackAttemptAt() { return null; },
      getNextWritebackLeaseExpiry() { return null; },
    },
    dispatch: async (claim) => {
      calls.push(["dispatch", claim]);
      return { outcome: "updated" };
    },
  });

  try {
    await worker.start();
    assert.deepEqual(calls, [
      ["dispatch", { operationId: "writeback-001", claimToken: "claim-001", version: 2 }],
      ["succeeded", "writeback-001", "claim-001"],
    ]);
  } finally {
    await worker.close();
  }
});

test("records a Bridge field conflict as terminal without retrying the same intent", async () => {
  let claimed = false;
  const conflicts = [];
  const worker = createFeishuWritebackWorker({
    store: {
      recoverExpiredWritebackIntents() { return 0; },
      claimNextWritebackIntent() {
        if (claimed) return null;
        claimed = true;
        return intent();
      },
      markWritebackIntentConflict(id, claimToken, error) {
        conflicts.push({ id, claimToken, error });
        return { id, state: "conflict" };
      },
      getNextWritebackAttemptAt() { return null; },
      getNextWritebackLeaseExpiry() { return null; },
    },
    dispatch: async () => {
      const error = new Error("The configured field changed");
      error.code = "FIELD_CHANGED";
      error.status = 409;
      throw error;
    },
  });

  try {
    await worker.start();
    assert.deepEqual(conflicts, [{
      id: "writeback-001",
      claimToken: "claim-001",
      error: { code: "FIELD_CHANGED", message: "The configured field changed" },
    }]);
  } finally {
    await worker.close();
  }
});

test("retries a transient Bridge outage with a bounded delayed retry", async () => {
  let claimed = false;
  const retries = [];
  const timers = [];
  const worker = createFeishuWritebackWorker({
    store: {
      recoverExpiredWritebackIntents() { return 0; },
      claimNextWritebackIntent() {
        if (claimed) return null;
        claimed = true;
        return intent({ attemptCount: 2 });
      },
      markWritebackIntentRetryWait(id, claimToken, error) {
        retries.push({ id, claimToken, error });
        return { id, state: "retry_wait", nextAttemptAt: error.nextAttemptAt };
      },
      getNextWritebackAttemptAt() { return retries[0]?.error.nextAttemptAt ?? null; },
      getNextWritebackLeaseExpiry() { return null; },
    },
    dispatch: async () => {
      const error = new Error("Bridge is temporarily unavailable");
      error.code = "FEISHU_WRITEBACK_FAILED";
      error.status = 503;
      throw error;
    },
    now: () => 1_800_000_000_000,
    random: () => 0.5,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });

  try {
    await worker.start();
    assert.deepEqual(retries, [{
      id: "writeback-001",
      claimToken: "claim-001",
      error: {
        code: "FEISHU_WRITEBACK_FAILED",
        message: "Bridge is temporarily unavailable",
        nextAttemptAt: "2027-01-15T08:00:10.000Z",
      },
    }]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 10_000);
  } finally {
    await worker.close();
  }
});
