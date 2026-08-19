import assert from "node:assert/strict";
import test from "node:test";

import { logDelivery, safeReference } from "../src/observability.mjs";

test("creates deterministic short references without exposing the source value", () => {
  const source = "evt_123";
  const reference = safeReference(source);
  assert.equal(reference, safeReference(source));
  assert.match(reference, /^[0-9a-f]{12}$/);
  assert.doesNotMatch(reference, /evt_123/);
});

test("structured delivery logs contain only hashed references and safe metadata", () => {
  const lines = [];
  const logger = { warn: (line) => lines.push(line) };
  const appSecret = "fake-app-secret-do-not-log";
  const workspacePath = "D:\\trusted\\private-workspace";

  logDelivery(logger, "warn", {
    eventId: "evt_public-reference",
    tableId: "tbl_public-reference",
    recordId: "rec_public-reference",
    deliveryState: "retry_wait",
    attempts: 2,
    errorCode: "TASKBOARD_UNAVAILABLE",
    appSecret,
    workspacePath,
  });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(entry).sort(), [
    "attempts",
    "component",
    "deliveryState",
    "errorCode",
    "event",
    "record",
    "table",
  ].sort());
  assert.equal(entry.component, "bridge-delivery");
  assert.equal(entry.deliveryState, "retry_wait");
  assert.equal(entry.attempts, 2);
  assert.equal(entry.errorCode, "TASKBOARD_UNAVAILABLE");
  assert.equal(entry.event, safeReference("evt_public-reference"));
  assert.equal(entry.table, safeReference("tbl_public-reference"));
  assert.equal(entry.record, safeReference("rec_public-reference"));
  assert.doesNotMatch(lines[0], /fake-app-secret-do-not-log|private-workspace/);
});

test("does not include arbitrary task identifiers when they are absent", () => {
  const lines = [];
  logDelivery({ info: (line) => lines.push(line) }, "info", {
    eventId: "evt_1",
    tableId: "tbl_1",
    recordId: "rec_1",
    deliveryState: "succeeded",
    attempts: 1,
  });
  assert.deepEqual(JSON.parse(lines[0]), {
    component: "bridge-delivery",
    event: safeReference("evt_1"),
    table: safeReference("tbl_1"),
    record: safeReference("rec_1"),
    deliveryState: "succeeded",
    attempts: 1,
  });
});
