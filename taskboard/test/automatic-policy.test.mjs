import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveAutomaticExecution } from "../server/app.mjs";

test("automatic execution policy is opt-in and accepts explicit environment values", (t) => {
  const previousPolicy = process.env.CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION;
  delete process.env.CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION;
  t.after(() => {
    if (previousPolicy === undefined) delete process.env.CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION;
    else process.env.CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION = previousPolicy;
  });
  assert.equal(resolveAutomaticExecution(undefined), false);
  assert.equal(resolveAutomaticExecution(""), false);
  assert.equal(resolveAutomaticExecution("0"), false);
  assert.equal(resolveAutomaticExecution("1"), true);
  assert.equal(resolveAutomaticExecution("true"), true);
  assert.equal(resolveAutomaticExecution("yes"), true);
  assert.equal(resolveAutomaticExecution("on"), true);
  assert.equal(resolveAutomaticExecution("unexpected"), false);
  assert.equal(resolveAutomaticExecution(true), true);
  assert.equal(resolveAutomaticExecution(false), false);
});
