import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateNextAttemptAt,
  classifyDeliveryError,
  summarizeDeliveryError,
} from "../src/retry-policy.mjs";
import { TaskboardError } from "../src/taskboard-client.mjs";

test("classifies temporary Taskboard failures", () => {
  assert.equal(classifyDeliveryError(new TaskboardError("offline", {
    code: "TASKBOARD_UNAVAILABLE",
  })).retryable, true);
  assert.equal(classifyDeliveryError(new TaskboardError("busy", { status: 429 })).retryable, true);
  assert.equal(classifyDeliveryError(new TaskboardError("bad gateway", { status: 502 })).retryable, true);
  assert.equal(classifyDeliveryError(new TaskboardError("invalid task", { status: 400 })).retryable, false);
});

test("classifies ordinary errors as non-retryable delivery failures", () => {
  assert.deepEqual(classifyDeliveryError(new Error("unexpected")), {
    code: "DELIVERY_FAILED",
    status: 0,
    retryable: false,
  });
});

test("uses capped 5s, 15s, 45s retry delays without jitter when random is neutral", () => {
  const common = { now: 1_000, initialDelayMs: 5_000, maxDelayMs: 20_000, random: () => 0.5 };
  assert.equal(calculateNextAttemptAt({ ...common, attempts: 1 }), 6_000);
  assert.equal(calculateNextAttemptAt({ ...common, attempts: 2 }), 16_000);
  assert.equal(calculateNextAttemptAt({ ...common, attempts: 3 }), 21_000);
});

test("caps retry delay before applying jitter", () => {
  assert.equal(calculateNextAttemptAt({
    attempts: 8,
    now: 1_000,
    initialDelayMs: 5_000,
    maxDelayMs: 20_000,
    random: () => 0.5,
  }), 21_000);
});

test("summarizes errors without preserving raw line breaks", () => {
  const summary = summarizeDeliveryError(Object.assign(new Error("first\nsecond"), {
    code: "TASKBOARD_UNAVAILABLE",
    status: 0,
  }), 99);
  assert.deepEqual(summary, { code: "TASKBOARD_UNAVAILABLE", status: 0, at: 99 });
  assert.equal("message" in summary, false);
});
