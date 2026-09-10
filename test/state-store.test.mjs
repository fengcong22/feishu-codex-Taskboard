import assert from "node:assert/strict";
import { link, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonStateStore } from "../src/state-store.mjs";
import { withStateLock } from "../src/state-lock.mjs";

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
  const original = { ...event(), deliverySource: "simulation" };
  const result = await store.claimEvent(original, { ownerId: "one", now: 100, leaseMs: 1_000 });
  assert.equal(result.kind, "claimed");
  assert.equal(result.record.schemaVersion, 2);
  assert.equal(result.record.deliveryState, "processing");
  assert.equal(result.record.attempts, 1);
  assert.equal(result.record.lease.ownerId, "one");
  assert.equal(result.record.lease.leaseUntil, 1_100);
  assert.match(result.record.lease.token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.record.event, original);
  original.fields.changed = "caller mutation";
  assert.deepEqual((await store.get(original.eventId)).event.fields, {});
});

test("persists explicit provenance for current Feishu and simulated deliveries", async () => {
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  const real = await store.claimEvent(event("evt_real_provenance"), {
    ownerId: "real-worker", now: 100, leaseMs: 1_000,
  });
  const simulated = await store.claimEvent({
    ...event("evt_simulated_provenance"),
    deliverySource: "simulation",
  }, {
    ownerId: "simulation-worker", now: 100, leaseMs: 1_000,
  });
  assert.deepEqual(real.record.deliveryProvenance, { version: 1, source: "feishu" });
  assert.deepEqual(simulated.record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(Object.hasOwn(real.record.event, "deliverySource"), false);
  assert.equal(simulated.record.event.deliverySource, "simulation");
});

test("rejects an unrecognized delivery source instead of upgrading it to Feishu", async () => {
  const store = new JsonStateStore(await stateFilename());
  await assert.rejects(
    store.claimEvent({
      ...event("evt_unknown_provenance"),
      deliverySource: "legacy_unknown",
    }, {
      ownerId: "unknown-worker",
      now: 100,
      leaseMs: 1_000,
    }),
    /event\.deliverySource is invalid/,
  );
  assert.equal(await store.get("evt_unknown_provenance"), null);
});

test("fails closed on an unrecognized persisted delivery source", async () => {
  const eventId = "evt_persisted_unknown_provenance";
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    [eventId]: {
      schemaVersion: 2,
      eventId,
      event: {
        ...event(eventId),
        deliverySource: "future-source",
      },
      deliveryProvenance: { version: 1, source: "feishu" },
      deliveryState: "pending",
      decision: null,
      decisionSnapshot: null,
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));

  const store = new JsonStateStore(filename);
  const record = await store.get(eventId);
  assert.equal(record.deliveryState, "dead_letter");
  assert.equal(record.lastError.code, "EVENT_RECORD_INVALID");
  assert.deepEqual(record.deliveryProvenance, { version: 1, source: "simulation" });

  const claimed = await store.claimNextDue({ ownerId: "worker", now: 100, leaseMs: 10 });
  assert.equal(claimed, null);
});

test("keeps the conservative source when stored provenance and event disagree", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_mismatched_provenance: {
      schemaVersion: 2,
      eventId: "evt_mismatched_provenance",
      event: {
        ...event("evt_mismatched_provenance"),
        deliverySource: "simulation",
      },
      deliveryProvenance: { version: 1, source: "feishu" },
      deliveryState: "pending",
      decision: null,
      decisionSnapshot: null,
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const record = await (new JsonStateStore(filename)).get("evt_mismatched_provenance");
  assert.deepEqual(record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(record.event.deliverySource, "simulation");
});

test("downgrades pre-provenance nonterminal snapshots to an ambiguous manual-only source", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_ambiguous_provenance: {
      schemaVersion: 2,
      eventId: "evt_ambiguous_provenance",
      event: event("evt_ambiguous_provenance"),
      deliveryState: "retry_wait",
      decision: null,
      decisionSnapshot: null,
      attempts: 1,
      nextAttemptAt: 100,
      lease: null,
      lastError: { code: "TASKBOARD_UNAVAILABLE", status: 503, at: 1 },
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 1,
    },
  }));
  const store = new JsonStateStore(filename);
  const record = await store.get("evt_ambiguous_provenance");
  assert.deepEqual(record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(record.event.deliverySource, "simulation");

  const claimed = await store.claimNextDue({ ownerId: "worker", now: 100, leaseMs: 10 });
  assert.equal(claimed.event.deliverySource, "simulation");
  assert.deepEqual(claimed.deliveryProvenance, { version: 1, source: "simulation" });
  assert.deepEqual(
    JSON.parse(await readFile(filename, "utf8")).evt_ambiguous_provenance.deliveryProvenance,
    { version: 1, source: "simulation" },
  );
});

test("preserves conservative provenance when rehydrating ambiguous snapshots", async () => {
  for (const [deliveryState, lease] of [
    ["pending", null],
    ["processing", { ownerId: "expired-worker", token: "expired-token", leaseUntil: 1 }],
  ]) {
    const eventId = `evt_ambiguous_rehydrate_${deliveryState}`;
    const filename = await stateFilename();
    await writeFile(filename, JSON.stringify({
      [eventId]: {
        schemaVersion: 2,
        eventId,
        event: { eventId },
        deliveryState,
        decision: null,
        decisionSnapshot: null,
        attempts: 1,
        nextAttemptAt: null,
        lease,
        lastError: null,
        failureHistory: [],
        outcome: null,
        createdAt: 0,
        updatedAt: 0,
      },
    }));

    const store = new JsonStateStore(filename);
    if (deliveryState === "pending") {
      const invalid = await store.get(eventId);
      assert.equal(invalid.deliveryState, "dead_letter");
      assert.equal(invalid.lastError.code, "EVENT_SNAPSHOT_MISSING");
    }
    const replay = await store.claimEvent(event(eventId), {
      ownerId: "replay-worker",
      now: 100,
      leaseMs: 1_000,
    });
    assert.equal(replay.kind, "claimed", deliveryState);
    assert.deepEqual(replay.record.deliveryProvenance, {
      version: 1,
      source: "simulation",
    }, deliveryState);
    assert.equal(replay.record.event.deliverySource, "simulation", deliveryState);
  }
});

test("a simulated replay cannot retain Feishu provenance while rehydrating", async () => {
  const eventId = "evt_feishu_snapshot_simulated_replay";
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    [eventId]: {
      schemaVersion: 2,
      eventId,
      event: null,
      deliveryProvenance: { version: 1, source: "feishu" },
      deliveryState: "dead_letter",
      decision: null,
      decisionSnapshot: null,
      attempts: 1,
      nextAttemptAt: null,
      lease: null,
      lastError: { code: "EVENT_SNAPSHOT_MISSING", status: 0, at: 0 },
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));

  const replay = await (new JsonStateStore(filename)).claimEvent({
    ...event(eventId),
    deliverySource: "simulation",
  }, {
    ownerId: "simulation-worker",
    now: 100,
    leaseMs: 1_000,
  });
  assert.equal(replay.kind, "claimed");
  assert.deepEqual(replay.record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(replay.record.event.deliverySource, "simulation");
});

test("a simulated replay downgrades an expired complete Feishu claim", async () => {
  const eventId = "evt_expired_feishu_simulated_replay";
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  const original = await store.claimEvent(event(eventId), {
    ownerId: "feishu-worker",
    now: 0,
    leaseMs: 10,
  });
  assert.deepEqual(original.record.deliveryProvenance, { version: 1, source: "feishu" });

  const replay = await store.claimEvent({
    ...event(eventId),
    deliverySource: "simulation",
  }, {
    ownerId: "simulation-worker",
    now: 10,
    leaseMs: 1_000,
  });

  assert.equal(replay.kind, "claimed");
  assert.deepEqual(replay.record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(replay.record.event.deliverySource, "simulation");
});

test("a deferred simulated replay downgrades Feishu retry provenance before it is due", async () => {
  const eventId = "evt_deferred_retry_simulated_replay";
  const store = new JsonStateStore(await stateFilename());
  const original = await store.claimEvent(event(eventId), {
    ownerId: "feishu-worker",
    now: 0,
    leaseMs: 100,
  });
  await store.fail(eventId, {
    ownerId: "feishu-worker",
    token: original.record.lease.token,
    error: { code: "TASKBOARD_UNAVAILABLE" },
    nextAttemptAt: 1_000,
    deadLetter: false,
    now: 1,
  });

  const replay = await store.claimEvent({
    ...event(eventId),
    deliverySource: "simulation",
  }, {
    ownerId: "simulation-worker",
    now: 100,
    leaseMs: 100,
  });

  assert.equal(replay.kind, "deferred");
  assert.deepEqual(replay.record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(replay.record.event.deliverySource, "simulation");
  const persisted = await store.get(eventId);
  assert.deepEqual(persisted.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(persisted.event.deliverySource, "simulation");

  const due = await store.claimNextDue({
    ownerId: "retry-worker",
    now: 1_000,
    leaseMs: 100,
  });
  assert.deepEqual(due.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(due.event.deliverySource, "simulation");
});

test("a deferred simulated replay downgrades Feishu provenance under an active lease", async () => {
  const eventId = "evt_active_lease_simulated_replay";
  const store = new JsonStateStore(await stateFilename());
  const original = await store.claimEvent(event(eventId), {
    ownerId: "feishu-worker",
    now: 0,
    leaseMs: 1_000,
  });

  const replay = await store.claimEvent({
    ...event(eventId),
    deliverySource: "simulation",
  }, {
    ownerId: "simulation-worker",
    now: 100,
    leaseMs: 100,
  });

  assert.equal(replay.kind, "deferred");
  assert.deepEqual(replay.record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(replay.record.event.deliverySource, "simulation");
  assert.deepEqual(replay.record.lease, original.record.lease);
  assert.equal(replay.record.attempts, original.record.attempts);

  const persisted = await store.get(eventId);
  assert.deepEqual(persisted.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(persisted.event.deliverySource, "simulation");
  assert.deepEqual(persisted.lease, original.record.lease);
  assert.equal(persisted.attempts, original.record.attempts);
});

test("a simulated replay does not rewrite a succeeded Feishu record", async () => {
  const eventId = "evt_succeeded_feishu_simulated_replay";
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event(eventId), {
    ownerId: "feishu-worker",
    now: 0,
    leaseMs: 100,
  });
  await store.complete(eventId, {
    ownerId: "feishu-worker",
    token: claim.record.lease.token,
    decision: "ready",
    outcome: { kind: "ready", taskId: "task_1", taskIdentifier: "AUTO-1" },
    now: 1,
  });
  const beforeReplay = await store.get(eventId);

  const replay = await store.claimEvent({
    ...event(eventId),
    deliverySource: "simulation",
  }, {
    ownerId: "simulation-worker",
    now: 2,
    leaseMs: 100,
  });

  assert.equal(replay.kind, "terminal");
  assert.deepEqual(replay.record, beforeReplay);
  assert.deepEqual(await store.get(eventId), beforeReplay);
});

test("rehydration preserves simulation provenance from the frozen decision event", async () => {
  const eventId = "evt_frozen_simulation_rehydrate";
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    [eventId]: {
      schemaVersion: 2,
      eventId,
      event: null,
      deliveryProvenance: { version: 1, source: "feishu" },
      deliveryState: "dead_letter",
      decision: null,
      decisionSnapshot: {
        version: 1,
        action: "register",
        kind: "register",
        subjectKey: "bas_demo:tbl_demo",
        configVersion: 1,
        stageId: "initial",
        event: {
          ...event(eventId),
          deliverySource: "simulation",
        },
      },
      attempts: 1,
      nextAttemptAt: null,
      lease: null,
      lastError: { code: "EVENT_SNAPSHOT_MISSING", status: 0, at: 0 },
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));

  const replay = await (new JsonStateStore(filename)).claimEvent(event(eventId), {
    ownerId: "replay-worker",
    now: 100,
    leaseMs: 1_000,
  });

  assert.equal(replay.kind, "claimed");
  assert.deepEqual(replay.record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(replay.record.event.deliverySource, "simulation");
});

test("due recovery preserves simulation provenance from the frozen decision event", async () => {
  const eventId = "evt_due_frozen_simulation";
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event(eventId), {
    ownerId: "first-worker",
    now: 0,
    leaseMs: 100,
  });
  await store.saveDecisionSnapshot(eventId, {
    ownerId: "first-worker",
    token: claim.record.lease.token,
    snapshot: {
      version: 1,
      action: "register",
      kind: "register",
      subjectKey: "bas_demo:tbl_demo",
      configVersion: 1,
      stageId: "initial",
      event: {
        ...event(eventId),
        deliverySource: "simulation",
      },
    },
    now: 1,
  });
  await store.fail(eventId, {
    ownerId: "first-worker",
    token: claim.record.lease.token,
    error: { code: "TASKBOARD_UNAVAILABLE" },
    nextAttemptAt: 100,
    deadLetter: false,
    now: 2,
  });

  const normalized = await store.get(eventId);
  assert.deepEqual(normalized.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(normalized.event.deliverySource, "simulation");

  const recovered = await store.claimNextDue({
    ownerId: "recovery-worker",
    now: 100,
    leaseMs: 1_000,
  });

  assert.deepEqual(recovered.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(recovered.event.deliverySource, "simulation");
});

test("fails closed on an unknown delivery source in the frozen decision event", async () => {
  const eventId = "evt_frozen_unknown_provenance";
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    [eventId]: {
      schemaVersion: 2,
      eventId,
      event: event(eventId),
      deliveryProvenance: { version: 1, source: "feishu" },
      deliveryState: "pending",
      decision: null,
      decisionSnapshot: {
        version: 1,
        action: "register",
        kind: "register",
        subjectKey: "bas_demo:tbl_demo",
        configVersion: 1,
        stageId: "initial",
        event: {
          ...event(eventId),
          deliverySource: "future-source",
        },
      },
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));

  const record = await (new JsonStateStore(filename)).get(eventId);
  assert.equal(record.deliveryState, "dead_letter");
  assert.equal(record.lastError.code, "DECISION_SNAPSHOT_INVALID");
  assert.deepEqual(record.deliveryProvenance, { version: 1, source: "simulation" });
});

test("does not upgrade a simulated malformed snapshot during rehydration", async () => {
  const eventId = "evt_simulated_malformed_rehydrate";
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    [eventId]: {
      schemaVersion: 2,
      eventId,
      event: {
        ...event(eventId),
        deliverySource: "simulation",
      },
      deliveryProvenance: { version: 1, source: "feishu" },
      deliveryState: "pending",
      decision: null,
      decisionSnapshot: null,
      attempts: -1,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));

  const store = new JsonStateStore(filename);
  const invalid = await store.get(eventId);
  assert.equal(invalid.deliveryState, "dead_letter");
  assert.equal(invalid.lastError.code, "EVENT_RECORD_INVALID");
  assert.deepEqual(invalid.deliveryProvenance, { version: 1, source: "simulation" });

  const replay = await store.claimEvent(event(eventId), {
    ownerId: "replay-worker",
    now: 100,
    leaseMs: 1_000,
  });
  assert.equal(replay.kind, "terminal");
  assert.deepEqual(replay.record.deliveryProvenance, { version: 1, source: "simulation" });
});

test("persists one fenced decision snapshot without executable or local-path data", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event("evt_decision_snapshot"), {
    ownerId: "one",
    now: 0,
    leaseMs: 100,
  });
  const snapshot = {
    version: 1,
    action: "create",
    kind: "ready",
    table: {
      baseToken: "bas_demo",
      tableId: "tbl_demo",
      subjectKey: "bas_demo:tbl_demo",
      name: "语文项目",
      mode: "manual",
      executionMode: "manual",
      triggerField: "视频整体进度",
      triggerFieldId: "fld_progress",
      triggerValue: "待剪辑",
      configVersion: 3,
      uploadMode: "manual",
      concurrencyGroup: "语文",
      maxConcurrent: 2,
      resourceGroups: ["cpu"],
    },
    packageAlias: "Auto-cut-copyA",
    packageSource: "record-field",
    packageProjectId: "auto-cut-copy-a",
  };
  const saved = await store.saveDecisionSnapshot("evt_decision_snapshot", {
    ownerId: "one",
    token: claim.record.lease.token,
    snapshot,
    now: 1,
  });
  assert.deepEqual(saved.decisionSnapshot, snapshot);
  const persisted = await store.get("evt_decision_snapshot");
  assert.deepEqual(persisted.decisionSnapshot, snapshot);
  assert.doesNotMatch(JSON.stringify(persisted.decisionSnapshot), /workspacePath|prompt|command|credential|secret/i);

  await assert.rejects(
    () => store.saveDecisionSnapshot("evt_decision_snapshot", {
      ownerId: "one",
      token: claim.record.lease.token,
      snapshot: { ...snapshot, packageAlias: "Auto-cut-copyB" },
      now: 2,
    }),
    (error) => error?.code === "DECISION_SNAPSHOT_CONFLICT",
  );
});

test("rejects decision snapshots containing unsupported executable fields", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event("evt_unsafe_decision_snapshot"), {
    ownerId: "one",
    now: 0,
    leaseMs: 100,
  });
  await assert.rejects(
    () => store.saveDecisionSnapshot("evt_unsafe_decision_snapshot", {
      ownerId: "one",
      token: claim.record.lease.token,
      snapshot: {
        version: 1,
        action: "create",
        kind: "ready",
        workspacePath: "C:\\secret\\workspace",
      },
      now: 1,
    }),
    (error) => error?.code === "DECISION_SNAPSHOT_INVALID",
  );
  assert.equal((await store.get("evt_unsafe_decision_snapshot")).decisionSnapshot, null);
});

test("refreshes the lease clock after waiting for the state lock", async () => {
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  let logicalNow = 0;
  const claim = await store.claimEvent(event(), {
    ownerId: "one",
    now: logicalNow,
    clock: () => logicalNow,
    leaseMs: 10,
  });
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const locked = new Promise((resolve) => { entered = resolve; });
  const holder = withStateLock(filename, async () => {
    entered();
    await gate;
  });
  await locked;
  const renewal = store.renewLease("evt_state", {
    ownerId: "one",
    token: claim.record.lease.token,
    now: 5,
    clock: () => logicalNow,
    leaseMs: 10,
  });
  logicalNow = 20;
  release();
  await holder;
  const renewed = await renewal;
  assert.equal(renewed.lease.leaseUntil, 30);
  assert.equal(renewed.updatedAt, 20);
});

test("does not complete a lease after the lock wait crosses its deadline", async () => {
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  let logicalNow = 0;
  const claim = await store.claimEvent(event(), {
    ownerId: "one",
    now: logicalNow,
    clock: () => logicalNow,
    leaseMs: 10,
  });
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const locked = new Promise((resolve) => { entered = resolve; });
  const holder = withStateLock(filename, async () => {
    entered();
    await gate;
  });
  await locked;
  const completion = store.complete("evt_state", {
    ownerId: "one",
    token: claim.record.lease.token,
    decision: "ignored",
    outcome: { kind: "ignored" },
    now: 5,
    clock: () => logicalNow,
  });
  logicalNow = 20;
  release();
  await holder;
  await assert.rejects(completion, (error) => error?.code === "LEASE_NOT_OWNED");
  assert.equal((await store.get("evt_state")).deliveryState, "processing");
});

test("moves a retry deadline forward when the state lock wait crosses it", async () => {
  const filename = await stateFilename();
  const store = new JsonStateStore(filename);
  let logicalNow = 0;
  const claim = await store.claimEvent(event(), {
    ownerId: "one",
    now: logicalNow,
    clock: () => logicalNow,
    leaseMs: 100,
  });
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const locked = new Promise((resolve) => { entered = resolve; });
  const holder = withStateLock(filename, async () => {
    entered();
    await gate;
  });
  await locked;
  const failure = store.fail("evt_state", {
    ownerId: "one",
    token: claim.record.lease.token,
    error: { code: "TASKBOARD_UNAVAILABLE" },
    nextAttemptAt: 5,
    deadLetter: false,
    now: 0,
    clock: () => logicalNow,
  });
  logicalNow = 10;
  release();
  await holder;
  const result = await failure;
  assert.equal(result.deliveryState, "retry_wait");
  assert.ok(result.nextAttemptAt > logicalNow);
});

test("rejects empty owners and non-positive or non-finite lease durations", async () => {
  const store = new JsonStateStore(await stateFilename());
  const invalidOwners = ["", "   ", null, 42];
  for (const ownerId of invalidOwners) {
    await assert.rejects(
      () => store.claimEvent(event(`evt_owner_${String(ownerId)}`), { ownerId, now: 0, leaseMs: 10 }),
      /ownerId must be a non-empty string/,
    );
    await assert.rejects(
      () => store.claimNextDue({ ownerId, now: 0, leaseMs: 10 }),
      /ownerId must be a non-empty string/,
    );
  }
  for (const leaseMs of [0, -1, 1.5, Infinity, NaN, "10"]) {
    await assert.rejects(
      () => store.claimEvent(event(`evt_lease_${String(leaseMs)}`), { ownerId: "one", now: 0, leaseMs }),
      /leaseMs must be a finite positive integer/,
    );
    await assert.rejects(
      () => store.claimNextDue({ ownerId: "one", now: 0, leaseMs }),
      /leaseMs must be a finite positive integer/,
    );
  }
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
  const claim = await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 10 });
  await store.fail("evt_state", { ownerId: "one", token: claim.record.lease.token, error: { code: "TASKBOARD_UNAVAILABLE", status: 0, at: 1 }, nextAttemptAt: 100, deadLetter: false, now: 1 });
  assert.equal(await store.claimNextDue({ ownerId: "two", now: 99, leaseMs: 10 }), null);
  const claimed = await store.claimNextDue({ ownerId: "two", now: 100, leaseMs: 10 });
  assert.equal(claimed.eventId, "evt_state");
  assert.equal(claimed.attempts, 2);
});

test("requires retry failures to schedule strictly after the failure time", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 100 });
  for (const nextAttemptAt of [0, -1, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => store.fail("evt_state", {
        ownerId: "one",
        token: claim.record.lease.token,
        error: { code: "TASKBOARD_UNAVAILABLE" },
        nextAttemptAt,
        deadLetter: false,
        now: 1,
      }),
      /nextAttemptAt must be a finite timestamp greater than now/,
    );
  }
  assert.equal((await store.get("evt_state")).deliveryState, "processing");
});

test("uses a real current time when retry failure omits now", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event("evt_missing_now"), {
    ownerId: "one",
    now: Date.now(),
    leaseMs: 10_000,
  });
  await assert.rejects(
    () => store.fail("evt_missing_now", {
      ownerId: "one",
      token: claim.record.lease.token,
      error: { code: "TASKBOARD_UNAVAILABLE" },
      nextAttemptAt: 0,
      deadLetter: false,
    }),
    /nextAttemptAt must be a finite timestamp greater than now/,
  );
  assert.equal((await store.get("evt_missing_now")).deliveryState, "processing");
});

test("rejects hard-linked state paths for read operations", async (t) => {
  const filename = await stateFilename();
  const alias = `${filename}.hardlink`;
  await writeFile(filename, "{}\n");
  try {
    await link(filename, alias);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`hard-link creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const store = new JsonStateStore(alias);
  await assert.rejects(
    () => store.get("evt_missing"),
    (error) => error?.code === "STATE_LOCK_TARGET_UNSUPPORTED",
  );
  await assert.rejects(
    () => store.getQueueStats(),
    (error) => error?.code === "STATE_LOCK_TARGET_UNSUPPORTED",
  );
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

test("renews an owned lease before recovery and rejects a different lease token", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 10 });
  const leaseToken = claim.record.lease.token;
  const renewed = await store.renewLease("evt_state", {
    ownerId: "one",
    token: leaseToken,
    now: 5,
    leaseMs: 10,
  });
  assert.equal(renewed.lease.leaseUntil, 15);
  assert.equal(await store.recoverExpiredLeases({ now: 11 }), 0);
  await assert.rejects(
    () => store.renewLease("evt_state", {
      ownerId: "one",
      token: "stale-token",
      now: 12,
      leaseMs: 10,
    }),
    /lease is not owned by one/,
  );
});

test("renews an expired but not-yet-reclaimed lease when its fencing token still matches", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event("evt_expired_heartbeat"), {
    ownerId: "one",
    now: 0,
    leaseMs: 10,
  });
  const renewed = await store.renewLease("evt_expired_heartbeat", {
    ownerId: "one",
    token: claim.record.lease.token,
    now: 25,
    leaseMs: 10,
  });
  assert.equal(renewed.lease.leaseUntil, 35);
  assert.equal(await store.recoverExpiredLeases({ now: 30 }), 0);
});

test("fences stale completion and failure after a lease is reclaimed", async () => {
  const store = new JsonStateStore(await stateFilename());
  const first = await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 10 });
  await store.recoverExpiredLeases({ now: 10 });
  const second = await store.claimNextDue({ ownerId: "two", now: 10, leaseMs: 100 });
  await assert.rejects(
    () => store.complete("evt_state", {
      ownerId: "one",
      token: first.record.lease.token,
      decision: "ready",
      outcome: { kind: "ready", taskId: "task_1", taskIdentifier: "AUTO-1" },
      now: 11,
    }),
    /lease is not owned by one/,
  );
  await assert.rejects(
    () => store.fail("evt_state", {
      ownerId: "one",
      token: first.record.lease.token,
      error: { code: "TASKBOARD_UNAVAILABLE" },
      nextAttemptAt: 20,
      deadLetter: false,
      now: 11,
    }),
    /lease is not owned by one/,
  );
  await assert.rejects(
    () => store.renewLease("evt_state", {
      ownerId: "one",
      token: first.record.lease.token,
      now: 11,
      leaseMs: 10,
    }),
    /lease is not owned by one/,
  );
  assert.equal((await store.get("evt_state")).lease.ownerId, "two");
  assert.notEqual(second.lease.token, first.record.lease.token);
});

test("requires the fencing token for a current lease", async () => {
  const store = new JsonStateStore(await stateFilename());
  await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 100 });
  await assert.rejects(
    () => store.complete("evt_state", {
      ownerId: "one",
      decision: "ready",
      outcome: { kind: "ready", taskId: "task_1", taskIdentifier: "AUTO-1" },
      now: 1,
    }),
    /lease is not owned by one/,
  );
});

test("complete and fail reject a different owner or an expired lease", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 10 });
  await assert.rejects(() => store.complete("evt_state", { ownerId: "two", token: claim.record.lease.token, decision: "ready", outcome: {}, now: 1 }), /lease is not owned by two/);
  await assert.rejects(() => store.fail("evt_state", { ownerId: "one", token: claim.record.lease.token, error: { code: "TASKBOARD_UNAVAILABLE" }, nextAttemptAt: 20, deadLetter: false, now: 10 }), /lease is not owned by one/);
  assert.equal((await store.get("evt_state")).deliveryState, "processing");
});

test("completes a claimed event without changing its captured event", async () => {
  const store = new JsonStateStore(await stateFilename());
  const captured = event();
  const claim = await store.claimEvent(captured, { ownerId: "one", now: 0, leaseMs: 100 });
  const result = await store.complete("evt_state", {
    ownerId: "one",
    token: claim.record.lease.token,
    decision: "ready",
    outcome: { kind: "ready", taskId: "task_1", taskIdentifier: "AUTO-1" },
    now: 1,
  });
  assert.equal(result.deliveryState, "succeeded");
  assert.equal(result.decision, "ready");
  assert.deepEqual(result.outcome, {
    kind: "ready",
    taskId: "task_1",
    taskIdentifier: "AUTO-1",
  });
  assert.equal(result.lease, null);
  assert.deepEqual(result.event, captured);
});

test("complete rejects malformed outcomes without recording success", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 100 });
  await assert.rejects(
    () => store.complete("evt_state", {
      ownerId: "one",
      token: claim.record.lease.token,
      decision: "ready",
      outcome: { kind: "ready", taskId: "task_1" },
      now: 1,
    }),
    /outcome must match decision and contain valid task identifiers/,
  );
  assert.equal((await store.get("evt_state")).deliveryState, "processing");
});

test("complete rejects a result that has only a task identifier", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 100 });
  await assert.rejects(
    () => store.complete("evt_state", {
      ownerId: "one",
      token: claim.record.lease.token,
      decision: "ready",
      outcome: { kind: "ready", taskIdentifier: "AUTO-1" },
      now: 1,
    }),
    /outcome must match decision and contain valid task identifiers/,
  );
});

test("persists only the normalized event snapshot fields", async () => {
  const store = new JsonStateStore(await stateFilename());
  const incoming = {
    ...event(),
    recordTitle: "标题",
    action: "record_edited",
    fieldId: "fld_progress",
    fieldValuesById: { fld_package: "demo" },
    workspacePath: "C:\\should-never-be-persisted",
    command: "del *",
    prompt: "untrusted prompt",
    nestedSecret: { token: "secret" },
  };
  await store.claimEvent(incoming, { ownerId: "one", now: 0, leaseMs: 100 });
  const saved = (await store.get(incoming.eventId)).event;
  assert.deepEqual(saved, {
    eventId: incoming.eventId,
    baseToken: incoming.baseToken,
    tableId: incoming.tableId,
    recordId: incoming.recordId,
    recordTitle: incoming.recordTitle,
    action: incoming.action,
    fieldId: incoming.fieldId,
    fieldName: incoming.fieldName,
    beforeValue: incoming.beforeValue,
    afterValue: incoming.afterValue,
    fields: incoming.fields,
    fieldValuesById: incoming.fieldValuesById,
  });
  for (const forbidden of ["workspacePath", "command", "prompt", "nestedSecret"]) {
    assert.equal(Object.hasOwn(saved, forbidden), false);
  }
});

test("records retry failures and caps safe failure history", async () => {
  const store = new JsonStateStore(await stateFilename());
  let claim = await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 100 });
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    await store.fail("evt_state", { ownerId: "one", token: claim.record.lease.token, error: { code: `TEMP_${attempt}`, status: 503, message: "do not persist this" }, nextAttemptAt: attempt * 10, deadLetter: false, now: attempt });
    if (attempt < 12) {
      const next = await store.claimNextDue({ ownerId: "one", now: attempt * 10, leaseMs: 100 });
      claim = { record: next };
    }
  }
  const record = await store.get("evt_state");
  assert.equal(record.deliveryState, "retry_wait");
  assert.equal(record.failureHistory.length, 10);
  assert.equal(record.failureHistory[0].code, "DELIVERY_FAILED");
  assert.equal("message" in record.lastError, false);
  assert.equal(record.lastError.code, "DELIVERY_FAILED");
});

test("moves a failed delivery to dead letter without a due time", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 100 });
  const result = await store.fail("evt_state", { ownerId: "one", token: claim.record.lease.token, error: { code: "DELIVERY_FAILED", status: 400, at: 2 }, nextAttemptAt: 100, deadLetter: true, now: 2 });
  assert.equal(result.deliveryState, "dead_letter");
  assert.equal(result.nextAttemptAt, null);
  assert.equal(await store.claimNextDue({ ownerId: "two", now: 100, leaseMs: 10 }), null);
});

test("reports queue statistics for non-terminal delivery states", async () => {
  const store = new JsonStateStore(await stateFilename());
  await store.claimEvent(event("evt_processing"), { ownerId: "one", now: 0, leaseMs: 100 });
  const retryClaim = await store.claimEvent(event("evt_retry"), { ownerId: "one", now: 0, leaseMs: 100 });
  await store.fail("evt_retry", { ownerId: "one", token: retryClaim.record.lease.token, error: { code: "TASKBOARD_UNAVAILABLE" }, nextAttemptAt: 100, deadLetter: false, now: 1 });
  const doneClaim = await store.claimEvent(event("evt_done"), { ownerId: "one", now: 0, leaseMs: 100 });
  await store.complete("evt_done", { ownerId: "one", token: doneClaim.record.lease.token, decision: "ignored", outcome: { kind: "ignored" }, now: 1 });
  const deadClaim = await store.claimEvent(event("evt_dead"), { ownerId: "one", now: 0, leaseMs: 100 });
  await store.fail("evt_dead", { ownerId: "one", token: deadClaim.record.lease.token, error: { code: "DELIVERY_FAILED" }, deadLetter: true, now: 1 });
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
  assert.deepEqual(replay.record.event, { ...event("evt_old"), deliverySource: "simulation" });
});

test("migrates legacy terminal outcomes as succeeded records", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_ready: {
      kind: "ready",
      taskId: "task_1",
      taskIdentifier: "AUTO-1",
      secret: "do-not-return",
    },
  }));
  const store = new JsonStateStore(filename);
  const result = await store.claimEvent(event("evt_ready"), { ownerId: "one", now: 100, leaseMs: 10 });
  assert.equal(result.kind, "terminal");
  assert.equal(result.record.deliveryState, "succeeded");
  assert.deepEqual(result.record.outcome, {
    kind: "ready",
    taskId: "task_1",
    taskIdentifier: "AUTO-1",
  });
});

test("keeps pre-v2 terminal outcomes deduplicated when task identifiers were not stored", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_ready_old: { kind: "ready", taskId: "task_1" },
    evt_blocked_old: { kind: "blocked", reason: "missing_package_alias", taskId: "task_2" },
  }));
  const store = new JsonStateStore(filename);
  for (const eventId of ["evt_ready_old", "evt_blocked_old"]) {
    const replay = await store.claimEvent(event(eventId), {
      ownerId: "worker",
      now: 100,
      leaseMs: 10,
    });
    assert.equal(replay.kind, "terminal");
    assert.equal(replay.record.deliveryState, "succeeded");
    assert.equal(replay.record.outcome.taskId.startsWith("task_"), true);
  }
});

test("keeps the exact historical legacy ready outcome deduplicated", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_baseline_ready: { kind: "ready", taskId: "task_1" },
  }));
  const store = new JsonStateStore(filename);
  const replay = await store.claimEvent(event("evt_baseline_ready"), {
    ownerId: "worker",
    now: 100,
    leaseMs: 10,
  });
  assert.equal(replay.kind, "terminal");
  assert.equal(replay.record.deliveryState, "succeeded");
  assert.deepEqual(replay.record.outcome, { kind: "ready", taskId: "task_1" });
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

test("recovers malformed processing leases without leaving a stuck queue", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_invalid_lease: {
      schemaVersion: 2,
      eventId: "evt_invalid_lease",
      event: event("evt_invalid_lease"),
      deliveryState: "processing",
      decision: null,
      attempts: 1,
      nextAttemptAt: null,
      lease: { ownerId: "worker" },
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  assert.equal(await store.recoverExpiredLeases({ now: 100 }), 1);
  assert.equal((await store.get("evt_invalid_lease")).deliveryState, "pending");
  assert.equal((await store.get("evt_invalid_lease")).lease, null);
  assert.equal((await store.getQueueStats()).pending, 1);
});

test("recovers a processing record with a future expiry but invalid owner", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_invalid_owner: {
      schemaVersion: 2,
      eventId: "evt_invalid_owner",
      event: event("evt_invalid_owner"),
      deliveryState: "processing",
      decision: null,
      attempts: 1,
      nextAttemptAt: null,
      lease: { ownerId: "   ", leaseUntil: Number.MAX_SAFE_INTEGER },
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  assert.equal(await store.recoverExpiredLeases({ now: 100 }), 1);
  assert.equal((await store.get("evt_invalid_owner")).deliveryState, "pending");
});

test("rehydrates a v2 missing-snapshot dead letter after lease recovery", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_recover_snapshot: {
      schemaVersion: 2,
      eventId: "evt_recover_snapshot",
      event: null,
      deliveryProvenance: { version: 1, source: "simulation" },
      deliveryState: "processing",
      decision: null,
      attempts: 1,
      nextAttemptAt: null,
      lease: { ownerId: "worker", leaseUntil: 1 },
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  assert.equal(await store.recoverExpiredLeases({ now: 100 }), 1);
  const recovered = await store.get("evt_recover_snapshot");
  assert.equal(recovered.deliveryState, "dead_letter");
  assert.equal(recovered.lastError.code, "PROCESSING_EVENT_SNAPSHOT_MISSING");
  const replay = await store.claimEvent(event("evt_recover_snapshot"), {
    ownerId: "worker", now: 100, leaseMs: 10,
  });
  assert.equal(replay.kind, "claimed");
  assert.deepEqual(replay.record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.deepEqual(replay.record.event, {
    ...event("evt_recover_snapshot"),
    deliverySource: "simulation",
  });
});

test("rehydrates a partial processing snapshot after lease recovery", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_partial_snapshot: {
      schemaVersion: 2,
      eventId: "evt_partial_snapshot",
      event: { eventId: "evt_partial_snapshot" },
      deliveryState: "processing",
      decision: null,
      attempts: 1,
      nextAttemptAt: null,
      lease: { ownerId: "worker", leaseUntil: 1 },
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  assert.equal(await store.recoverExpiredLeases({ now: 100 }), 1);
  const replay = await store.claimEvent(event("evt_partial_snapshot"), {
    ownerId: "worker",
    now: 100,
    leaseMs: 10,
  });
  assert.equal(replay.kind, "claimed");
  assert.deepEqual(replay.record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.deepEqual(replay.record.event, {
    ...event("evt_partial_snapshot"),
    deliverySource: "simulation",
  });
});

test("fails closed on invalid record values instead of treating them as succeeded", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({ evt_invalid: null }));
  const store = new JsonStateStore(filename);
  await assert.rejects(() => store.get("evt_invalid"), /STATE_FILE_INVALID/);
});

test("fails closed on unknown legacy outcomes", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({ evt_unknown: { kind: "surprise" } }));
  const store = new JsonStateStore(filename);
  await assert.rejects(() => store.get("evt_unknown"), /STATE_FILE_INVALID/);
});

test("does not replay an invalid v2 succeeded outcome", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_invalid_outcome: {
      schemaVersion: 2,
      eventId: "evt_invalid_outcome",
      event: event("evt_invalid_outcome"),
      deliveryState: "succeeded",
      decision: "ready",
      attempts: 1,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: { kind: "surprise", secret: "do-not-return" },
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  const replay = await store.claimEvent(event("evt_invalid_outcome"), {
    ownerId: "worker", now: 100, leaseMs: 10,
  });
  assert.equal(replay.kind, "terminal");
  assert.equal(replay.record.deliveryState, "dead_letter");
  assert.equal(replay.record.lastError.code, "EVENT_RECORD_INVALID");
  assert.equal(JSON.stringify(replay.record).includes("do-not-return"), false);
});

test("keeps early v2 successes deduplicated when only taskId was persisted", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_early_v2: {
      schemaVersion: 2,
      eventId: "evt_early_v2",
      event: event("evt_early_v2"),
      deliveryState: "succeeded",
      decision: "ready",
      attempts: 1,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: { kind: "ready", taskId: "task_early" },
      createdAt: 0,
      updatedAt: 1,
    },
  }));
  const store = new JsonStateStore(filename);
  const replay = await store.claimEvent(event("evt_early_v2"), {
    ownerId: "worker",
    now: 100,
    leaseMs: 10,
  });
  assert.equal(replay.kind, "terminal");
  assert.equal(replay.record.deliveryState, "succeeded");
  assert.deepEqual(replay.record.outcome, { kind: "ready", taskId: "task_early" });
});

test("keeps historical successes deduplicated when only taskIdentifier was persisted", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_identifier_only: { kind: "ready", taskIdentifier: "AUTO-HISTORICAL" },
  }));
  const store = new JsonStateStore(filename);
  const replay = await store.claimEvent(event("evt_identifier_only"), {
    ownerId: "worker",
    now: 100,
    leaseMs: 10,
  });
  assert.equal(replay.kind, "terminal");
  assert.deepEqual(replay.record.outcome, {
    kind: "ready",
    taskIdentifier: "AUTO-HISTORICAL",
  });
});

test("sanitizes error codes supplied directly to the state store", async () => {
  const store = new JsonStateStore(await stateFilename());
  const claim = await store.claimEvent(event(), { ownerId: "worker", now: 0, leaseMs: 100 });
  const record = await store.fail("evt_state", {
    ownerId: "worker",
    token: claim.record.lease.token,
    error: { code: "BAD\\nsecret", status: 503 },
    nextAttemptAt: 101,
    deadLetter: false,
    now: 1,
  });
  assert.equal(record.lastError.code, "DELIVERY_FAILED");
});

test("dead-letters records whose outer key and event snapshot id disagree", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_outer: {
      schemaVersion: 2,
      eventId: "evt_inner",
      event: event("evt_inner"),
      deliveryState: "pending",
      decision: null,
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  const record = await store.get("evt_outer");
  assert.equal(record.eventId, "evt_outer");
  assert.equal(record.deliveryState, "dead_letter");
  assert.equal(record.lastError.code, "EVENT_RECORD_ID_MISMATCH");
  assert.equal(await store.claimNextDue({ ownerId: "worker", now: 100, leaseMs: 10 }), null);
});

test("fails closed when the durable state file is not an object map", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify([]));
  const store = new JsonStateStore(filename);
  await assert.rejects(
    () => store.claimEvent(event("evt_corrupt"), { ownerId: "worker", now: 0, leaseMs: 10 }),
    /STATE_FILE_INVALID/,
  );
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), []);
});

test("does not follow a pre-created predictable temporary hard link during state replacement", async () => {
  const filename = await stateFilename();
  const victim = `${filename}.victim`;
  const predictableTemporary = `${filename}.${process.pid}.tmp`;
  const originalVictim = "keep this file unchanged\n";
  await writeFile(victim, originalVictim, { mode: 0o600 });
  await link(victim, predictableTemporary);

  const store = new JsonStateStore(filename);
  const result = await store.claimEvent(event("evt_temp_link"), {
    ownerId: "worker",
    now: 0,
    leaseMs: 100,
  });

  assert.equal(result.kind, "claimed");
  assert.equal(await readFile(victim, "utf8"), originalVictim);
  assert.equal(await readFile(predictableTemporary, "utf8"), originalVictim);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")).evt_temp_link.event, event("evt_temp_link"));
});

test("does not rehydrate a legacy pending record from an incomplete event", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({ evt_old: { kind: "pending" } }));
  const store = new JsonStateStore(filename);
  const result = await store.claimEvent({ eventId: "evt_old" }, { ownerId: "one", now: 100, leaseMs: 10 });
  assert.equal(result.kind, "terminal");
  assert.equal(result.record.deliveryState, "dead_letter");
  assert.equal(result.record.lastError.code, "LEGACY_EVENT_SNAPSHOT_MISSING");
});

test("does not claim a v2 pending record that has no event snapshot", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_malformed: {
      schemaVersion: 2,
      eventId: "evt_malformed",
      deliveryState: "pending",
      attempts: 0,
      nextAttemptAt: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  assert.equal(await store.claimNextDue({ ownerId: "one", now: 100, leaseMs: 10 }), null);
  const record = await store.get("evt_malformed");
  assert.equal(record.deliveryState, "dead_letter");
  assert.equal(record.lastError.code, "EVENT_SNAPSHOT_MISSING");
});

test("moves a retry record with a missing event snapshot to rehydratable dead letter", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_retry_missing: {
      schemaVersion: 2,
      eventId: "evt_retry_missing",
      deliveryState: "retry_wait",
      attempts: 2,
      nextAttemptAt: 100,
      lease: null,
      lastError: { code: "TASKBOARD_UNAVAILABLE", status: 503, at: 1 },
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 1,
    },
  }));
  const store = new JsonStateStore(filename);
  const record = await store.get("evt_retry_missing");
  assert.equal(record.deliveryState, "dead_letter");
  assert.equal(record.lastError.code, "EVENT_SNAPSHOT_MISSING");
  const replay = await store.claimEvent(event("evt_retry_missing"), {
    ownerId: "worker",
    now: 100,
    leaseMs: 10,
  });
  assert.equal(replay.kind, "claimed");
  assert.deepEqual(replay.record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.equal(replay.record.event.deliverySource, "simulation");
});

test("normalizes a partial pending snapshot to rehydratable dead letter", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_pending_partial: {
      schemaVersion: 2,
      eventId: "evt_pending_partial",
      event: { eventId: "evt_pending_partial" },
      deliveryState: "pending",
      decision: null,
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  await store.recoverExpiredLeases({ now: 100 });
  const record = await store.get("evt_pending_partial");
  assert.equal(record.deliveryState, "dead_letter");
  assert.equal(record.lastError.code, "EVENT_SNAPSHOT_MISSING");
  assert.deepEqual(await store.getQueueStats(), {
    pending: 0,
    processing: 0,
    retryWait: 0,
    deadLetter: 1,
  });
});

test("normalizes a due retry with a partial snapshot to rehydratable dead letter", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_retry_partial: {
      schemaVersion: 2,
      eventId: "evt_retry_partial",
      event: { eventId: "evt_retry_partial" },
      deliveryState: "retry_wait",
      decision: null,
      attempts: 2,
      nextAttemptAt: 100,
      lease: null,
      lastError: { code: "TASKBOARD_UNAVAILABLE", status: 503, at: 1 },
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 1,
    },
  }));
  const store = new JsonStateStore(filename);
  await store.recoverExpiredLeases({ now: 100 });
  const record = await store.get("evt_retry_partial");
  assert.equal(record.deliveryState, "dead_letter");
  assert.equal(record.lastError.code, "EVENT_SNAPSHOT_MISSING");
  assert.equal(await store.claimNextDue({ ownerId: "worker", now: 100, leaseMs: 10 }), null);
});

test("rehydrates a v2 record with a missing event property from a complete replay", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_missing_event: {
      schemaVersion: 2,
      eventId: "evt_missing_event",
      deliveryState: "pending",
      attempts: 0,
      nextAttemptAt: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  const result = await store.claimEvent(event("evt_missing_event"), {
    ownerId: "worker",
    now: 100,
    leaseMs: 10,
  });
  assert.equal(result.kind, "claimed");
  assert.deepEqual(result.record.event, {
    ...event("evt_missing_event"),
    deliverySource: "simulation",
  });
});

test("rehydrates an incomplete v2 record when the replay includes a complete snapshot", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_malformed: {
      schemaVersion: 2,
      eventId: "evt_malformed",
      event: { eventId: "evt_malformed" },
      deliveryState: "pending",
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  const result = await store.claimEvent(event("evt_malformed"), {
    ownerId: "worker",
    now: 100,
    leaseMs: 10,
  });
  assert.equal(result.kind, "claimed");
  assert.deepEqual(result.record.deliveryProvenance, { version: 1, source: "simulation" });
  assert.deepEqual(result.record.event, {
    ...event("evt_malformed"),
    deliverySource: "simulation",
  });
});

test("normalizes legacy v2 snapshots before a due record is persisted again", async () => {
  const filename = await stateFilename();
  await writeFile(filename, JSON.stringify({
    evt_extra: {
      schemaVersion: 2,
      eventId: "evt_extra",
      event: {
        ...event("evt_extra"),
        command: "should-not-survive",
      },
      deliveryState: "pending",
      decision: null,
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: null,
      failureHistory: [],
      outcome: null,
      createdAt: 0,
      updatedAt: 0,
    },
  }));
  const store = new JsonStateStore(filename);
  const claimed = await store.claimNextDue({ ownerId: "one", now: 100, leaseMs: 10 });
  assert.equal(claimed.event.command, undefined);
  assert.equal((await store.get("evt_extra")).event.command, undefined);
});
