import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonStateStore } from "../src/state-store.mjs";

const event = (eventId = "evt_state") => ({
  eventId, baseToken: "bas_demo", tableId: "tbl_demo", recordId: "rec_demo",
  fieldName: "视频整体进度", beforeValue: "素材齐全", afterValue: "待剪辑", fields: {},
});

async function stateFilename() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "feishu-bridge-state-"));
  return path.join(directory, "state.json");
}

test("claims an event into a versioned processing record", async () => {
  const store = new JsonStateStore(await stateFilename());
  const original = event();
  const result = await store.claimEvent(original, { ownerId: "one", now: 100, leaseMs: 1_000 });
  assert.equal(result.kind, "claimed");
  assert.equal(result.record.schemaVersion, 2);
  assert.equal(result.record.deliveryState, "processing");
  assert.equal(result.record.attempts, 1);
  assert.deepEqual(result.record.lease, { ownerId: "one", leaseUntil: 1_100 });
  assert.deepEqual(result.record.event, original);
  original.fields.changed = "caller mutation";
  assert.deepEqual((await store.get(original.eventId)).event.fields, {});
});

test("only one store instance can claim the same event", async () => {
  const filename = await stateFilename();
  const [left, right] = [new JsonStateStore(filename), new JsonStateStore(filename)];
  const [first, second] = await Promise.all([
    left.claimEvent(event(), { ownerId: "left", now: 100, leaseMs: 1_000 }),
    right.claimEvent(event(), { ownerId: "right", now: 100, leaseMs: 1_000 }),
  ]);
  assert.deepEqual([first.kind, second.kind].sort(), ["claimed", "deferred"]);
});

test("preserves concurrent atomic claims for separate events", async () => {
  const filename = await stateFilename();
  const first = new JsonStateStore(filename);
  const second = new JsonStateStore(filename);
  await Promise.all([
    first.claimEvent(event("evt_a"), { ownerId: "one", now: 1, leaseMs: 100 }),
    second.claimEvent(event("evt_b"), { ownerId: "two", now: 1, leaseMs: 100 }),
  ]);
  const final = new JsonStateStore(filename);
  assert.equal((await final.get("evt_a")).deliveryState, "processing");
  assert.equal((await final.get("evt_b")).deliveryState, "processing");
});

test("treats prototype-looking event ids as ordinary own keys", async () => {
  const store = new JsonStateStore(await stateFilename());
  for (const eventId of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const result = await store.claimEvent(event(eventId), { ownerId: eventId, now: 1, leaseMs: 100 });
    assert.equal(result.kind, "claimed");
    assert.equal((await store.get(eventId)).event.eventId, eventId);
  }
});

test("does not claim retry work before its due time", async () => {
  const store = new JsonStateStore(await stateFilename());
  await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 10 });
  await store.fail("evt_state", { ownerId: "one", error: { code: "TASKBOARD_UNAVAILABLE", status: 0, at: 1 }, nextAttemptAt: 100, deadLetter: false, now: 1 });
  assert.equal(await store.claimNextDue({ ownerId: "two", now: 99, leaseMs: 10 }), null);
  const claimed = await store.claimNextDue({ ownerId: "two", now: 100, leaseMs: 10 });
  assert.equal(claimed.eventId, "evt_state");
  assert.equal(claimed.attempts, 2);
});

test("recovers expired processing leases and leaves active leases untouched", async () => {
  const store = new JsonStateStore(await stateFilename());
  await store.claimEvent(event("evt_expired"), { ownerId: "one", now: 0, leaseMs: 10 });
  await store.claimEvent(event("evt_active"), { ownerId: "one", now: 0, leaseMs: 100 });
  assert.equal(await store.recoverExpiredLeases({ now: 10 }), 1);
  assert.equal((await store.get("evt_expired")).deliveryState, "pending");
  assert.equal((await store.get("evt_expired")).lease, null);
  assert.equal((await store.get("evt_active")).deliveryState, "processing");
});

test("complete and fail reject a different owner or an expired lease", async () => {
  const store = new JsonStateStore(await stateFilename());
  await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 10 });
  await assert.rejects(() => store.complete("evt_state", { ownerId: "two", decision: "ready", outcome: {}, now: 1 }), /lease is not owned by two/);
  await assert.rejects(() => store.fail("evt_state", { ownerId: "one", error: { code: "TASKBOARD_UNAVAILABLE" }, nextAttemptAt: 20, deadLetter: false, now: 10 }), /lease is not owned by one/);
  assert.equal((await store.get("evt_state")).deliveryState, "processing");
});

test("completes a claimed event without changing its captured event", async () => {
  const store = new JsonStateStore(await stateFilename());
  const captured = event();
  await store.claimEvent(captured, { ownerId: "one", now: 0, leaseMs: 100 });
  const result = await store.complete("evt_state", { ownerId: "one", decision: "ready", outcome: { kind: "ready", taskId: "task_1" }, now: 1 });
  assert.equal(result.deliveryState, "succeeded");
  assert.equal(result.decision, "ready");
  assert.deepEqual(result.outcome, { kind: "ready", taskId: "task_1" });
  assert.equal(result.lease, null);
  assert.deepEqual(result.event, captured);
});

test("records retry failures and caps safe failure history", async () => {
  const store = new JsonStateStore(await stateFilename());
  await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 100 });
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    await store.fail("evt_state", { ownerId: "one", error: { code: `TEMP_${attempt}`, status: 503, message: "do not persist this" }, nextAttemptAt: attempt * 10, deadLetter: false, now: attempt });
    if (attempt < 12) await store.claimNextDue({ ownerId: "one", now: attempt * 10, leaseMs: 100 });
  }
  const record = await store.get("evt_state");
  assert.equal(record.deliveryState, "retry_wait");
  assert.equal(record.failureHistory.length, 10);
  assert.equal(record.failureHistory[0].code, "TEMP_3");
  assert.equal("message" in record.lastError, false);
  assert.equal(record.lastError.code, "TEMP_12");
});

test("moves a failed delivery to dead letter without a due time", async () => {
  const store = new JsonStateStore(await stateFilename());
  await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 100 });
  const result = await store.fail("evt_state", { ownerId: "one", error: { code: "DELIVERY_FAILED", status: 400, at: 2 }, nextAttemptAt: 100, deadLetter: true, now: 2 });
  assert.equal(result.deliveryState, "dead_letter");
  assert.equal(result.nextAttemptAt, null);
  assert.equal(await store.claimNextDue({ ownerId: "two", now: 100, leaseMs: 10 }), null);
});

test("reports queue statistics for non-terminal delivery states", async () => {
  const store = new JsonStateStore(await stateFilename());
  await store.claimEvent(event("evt_processing"), { ownerId: "one", now: 0, leaseMs: 100 });
  await store.claimEvent(event("evt_retry"), { ownerId: "one", now: 0, leaseMs: 100 });
  await store.fail("evt_retry", { ownerId: "one", error: { code: "TASKBOARD_UNAVAILABLE" }, nextAttemptAt: 100, deadLetter: false, now: 1 });
  await store.claimEvent(event("evt_done"), { ownerId: "one", now: 0, leaseMs: 100 });
  await store.complete("evt_done", { ownerId: "one", decision: "ignored", outcome: { kind: "ignored" }, now: 1 });
  await store.claimEvent(event("evt_dead"), { ownerId: "one", now: 0, leaseMs: 100 });
  await store.fail("evt_dead", { ownerId: "one", error: { code: "DELIVERY_FAILED" }, deadLetter: true, now: 1 });
  assert.deepEqual(await store.getQueueStats(), { pending: 0, processing: 1, retryWait: 1, deadLetter: 1 });
});

test("migrates legacy pending records to dead letter and rehydrates on replay", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({ evt_old: { kind: "pending" } }));
  const store = new JsonStateStore(filename);
  const migrated = await store.get("evt_old");
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.deliveryState, "dead_letter");
  assert.equal(migrated.lastError.code, "LEGACY_EVENT_SNAPSHOT_MISSING");
  assert.equal(migrated.event, null);
  assert.equal(await store.claimNextDue({ ownerId: "one", now: 100, leaseMs: 10 }), null);
  const replay = await store.claimEvent(event("evt_old"), { ownerId: "one", now: 100, leaseMs: 10 });
  assert.equal(replay.kind, "claimed");
  assert.deepEqual(replay.record.event, event("evt_old"));
});

test("migrates legacy terminal outcomes as succeeded records", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({ evt_ready: { kind: "ready", taskId: "task_1" } }));
  const store = new JsonStateStore(filename);
  const result = await store.claimEvent(event("evt_ready"), { ownerId: "one", now: 100, leaseMs: 10 });
  assert.equal(result.kind, "terminal");
  assert.equal(result.record.deliveryState, "succeeded");
  assert.deepEqual(result.record.outcome, { kind: "ready", taskId: "task_1" });
});

test("rejects updates when a processing lease has no finite expiry", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_malformed: {
      schemaVersion: 2,
      eventId: "evt_malformed",
      event: event("evt_malformed"),
      deliveryState: "processing",
      decision: null,
      attempts: 1,
      nextAttemptAt: null,
      lease: { ownerId: "one" },
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  await assert.rejects(
    () => store.complete("evt_malformed", { ownerId: "one", decision: "ready", outcome: {}, now: 1 }),
    /lease is not owned by one/,
  );
});
