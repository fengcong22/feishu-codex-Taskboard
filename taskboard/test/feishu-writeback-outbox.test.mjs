import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { createFeishuDeliveryStore } from "../server/feishu-delivery-store.mjs";

const initialTimestamp = "2026-09-17T08:00:00.000Z";
const actor = { type: "user", id: "tester", name: "Tester", avatarUrl: null };

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-writeback-outbox-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));

  let currentTimestamp = initialTimestamp;
  const ids = ["binding-001", "writeback-001", "writeback-002", "writeback-003"];
  const claims = ["claim-001", "claim-002", "claim-003", "claim-004"];
  const store = createFeishuDeliveryStore({
    database,
    now: () => currentTimestamp,
    idFactory: () => ids.shift(),
    claimTokenFactory: () => claims.shift(),
  });

  const project = database.createProject({ id: "delivery-project", name: "Delivery", workspacePath: null });
  const task = database.createTask({
    id: "task-001",
    projectId: project.id,
    title: "Delivery task",
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    actor,
    assignee: actor,
    startDate: null,
    dueDate: null,
    feishuOrigin: {
      source: "feishu-base",
      eventId: "event-001",
      baseToken: "bas_delivery",
      tableId: "tbl_courses",
      recordId: "rec_001",
      subjectKey: "bas_delivery:tbl_courses",
      configVersion: 4,
      stageId: "initial",
      controlledContext: {
        documentLinks: [],
        namingDisplayValue: "课程001",
        namingValueUnique: true,
        courseName: "课程001",
      },
    },
  });
  const run = database.createFeishuAutoCutRun({
    runId: "run-001",
    taskId: task.id,
    subjectKey: "bas_delivery:tbl_courses",
    configVersion: 4,
    stageId: "initial",
    eventId: "event-001",
    resultPath: "C:\\private\\run-001\\result.json",
  });
  const binding = store.ensureCourseBinding({
    identity: { baseToken: "bas_delivery", tableId: "tbl_courses", recordId: "rec_001" },
    subjectVersion: 4,
    namingValue: "课程001",
    resolvedPaths: {
      actualRoot: "W:\\【--剪映草稿--】",
      coursePath: "W:\\【--剪映草稿--】\\课程001",
      displayPath: "学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
      pathKind: "network",
      canonicalLocationKey: "\\\\nas.example\\学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
    },
    trustedEventId: "event-001",
  });

  return {
    database,
    store,
    task,
    run,
    binding,
    setTime(value) { currentTimestamp = value; },
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function intentInput(fixture, overrides = {}) {
  return {
    idempotencyKey: "run-001:processing-status",
    taskId: fixture.task.id,
    runId: fixture.run.runId,
    courseBindingId: fixture.binding.bindingId,
    operation: {
      type: "single_select",
      fieldId: "fld_status",
      optionId: "opt_auto_cutting",
    },
    ...overrides,
  };
}

test("persists one immutable writeback intent for an idempotency key", async () => {
  const fixture = await createFixture();
  try {
    const first = fixture.store.enqueueWritebackIntent(intentInput(fixture));
    const duplicate = fixture.store.enqueueWritebackIntent(intentInput(fixture, {
      operation: { optionId: "opt_auto_cutting", fieldId: "fld_status", type: "single_select" },
    }));

    assert.deepEqual(first, {
      id: "writeback-001",
      idempotencyKey: "run-001:processing-status",
      taskId: fixture.task.id,
      runId: "run-001",
      courseBindingId: "binding-001",
      operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_auto_cutting" },
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: initialTimestamp,
      errorCode: null,
      errorMessage: null,
      version: 1,
      claimToken: null,
      leaseUntil: null,
      createdAt: initialTimestamp,
      startedAt: null,
      completedAt: null,
      updatedAt: initialTimestamp,
    });
    assert.deepEqual(duplicate, first);
    assert.equal(
      fixture.database.database.prepare("SELECT COUNT(*) AS count FROM feishu_writeback_outbox").get().count,
      1,
    );
    assert.throws(
      () => fixture.store.enqueueWritebackIntent(intentInput(fixture, {
        operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_completed" },
      })),
      { code: "WRITEBACK_IDEMPOTENCY_CONFLICT" },
    );
  } finally {
    await fixture.close();
  }
});

test("claims a due intent, renews its lease, and fences stale completion", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.enqueueWritebackIntent(intentInput(fixture));
    const claimed = fixture.store.claimNextWritebackIntent({ leaseMs: 60_000 });
    assert.deepEqual(
      { id: claimed.id, state: claimed.state, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount },
      { id: "writeback-001", state: "processing", claimToken: "claim-001", attemptCount: 1 },
    );
    assert.equal(claimed.leaseUntil, "2026-09-17T08:01:00.000Z");
    assert.equal(claimed.version, 2);

    assert.throws(
      () => fixture.store.resolveWritebackIntentForBridge({
        operationId: claimed.id,
        claimToken: claimed.claimToken,
        version: 1,
      }),
      { code: "WRITEBACK_CLAIM_STALE" },
    );
    assert.deepEqual(
      fixture.store.resolveWritebackIntentForBridge({
        operationId: claimed.id,
        claimToken: claimed.claimToken,
        version: claimed.version,
      }),
      {
        operationId: claimed.id,
        claimToken: claimed.claimToken,
        version: claimed.version,
        target: { baseToken: "bas_delivery", tableId: "tbl_courses", recordId: "rec_001" },
        operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_auto_cutting" },
      },
    );

    fixture.setTime("2026-09-17T08:00:30.000Z");
    const renewed = fixture.store.renewWritebackIntentLease(claimed.id, claimed.claimToken, { leaseMs: 60_000 });
    assert.equal(renewed.leaseUntil, "2026-09-17T08:01:30.000Z");
    assert.equal(fixture.store.markWritebackIntentSucceeded(claimed.id, "stale-claim"), null);

    const succeeded = fixture.store.markWritebackIntentSucceeded(claimed.id, claimed.claimToken);
    assert.equal(succeeded.state, "succeeded");
    assert.equal(succeeded.claimToken, null);
    assert.equal(succeeded.completedAt, "2026-09-17T08:00:30.000Z");
  } finally {
    await fixture.close();
  }
});

test("recovers expired leases into retry_wait and preserves terminal conflict and dead-letter outcomes", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.enqueueWritebackIntent(intentInput(fixture));
    const firstClaim = fixture.store.claimNextWritebackIntent({ leaseMs: 60_000 });
    fixture.setTime("2026-09-17T08:01:01.000Z");

    assert.equal(fixture.store.recoverExpiredWritebackIntents(), 1);
    assert.equal(fixture.store.getWritebackIntent(firstClaim.id).state, "retry_wait");
    const recovered = fixture.store.claimNextWritebackIntent({ leaseMs: 60_000 });
    assert.equal(recovered.attemptCount, 2);
    const conflict = fixture.store.markWritebackIntentConflict(recovered.id, recovered.claimToken, {
      code: "FIELD_OPTION_CHANGED",
      message: "The configured single-select option no longer exists",
    });
    assert.equal(conflict.state, "conflict");

    fixture.store.enqueueWritebackIntent(intentInput(fixture, {
      idempotencyKey: "run-001:course-path",
      operation: {
        type: "text",
        fieldId: "fld_course_path",
        value: "学科实拍素材临时传输\\【--剪映草稿--】\\课程001",
      },
    }));
    const secondClaim = fixture.store.claimNextWritebackIntent({ leaseMs: 60_000 });
    const retry = fixture.store.markWritebackIntentRetryWait(secondClaim.id, secondClaim.claimToken, {
      code: "NETWORK_TRANSIENT",
      message: "The Feishu request can be retried",
      nextAttemptAt: "2026-09-17T08:10:00.000Z",
    });
    assert.equal(retry.state, "retry_wait");
    assert.equal(fixture.store.claimNextWritebackIntent({ leaseMs: 60_000 }), null);

    fixture.setTime("2026-09-17T08:10:00.000Z");
    const finalClaim = fixture.store.claimNextWritebackIntent({ leaseMs: 60_000 });
    const deadLetter = fixture.store.markWritebackIntentDeadLetter(finalClaim.id, finalClaim.claimToken, {
      code: "WRITEBACK_RETRIES_EXHAUSTED",
      message: "Retry budget exhausted",
    });
    assert.equal(deadLetter.state, "dead_letter");
    assert.equal(fixture.store.claimNextWritebackIntent({ leaseMs: 60_000 }), null);
  } finally {
    await fixture.close();
  }
});

test("rejects intents whose run, task, and course binding are not one trusted Feishu record", async () => {
  const fixture = await createFixture();
  try {
    assert.throws(
      () => fixture.store.enqueueWritebackIntent(intentInput(fixture, { taskId: "task-other" })),
      { code: "WRITEBACK_REFERENCE_INVALID" },
    );
  } finally {
    await fixture.close();
  }
});

test("allows a processing single-select writeback without a course directory binding", async () => {
  const fixture = await createFixture();
  try {
    const intent = fixture.store.enqueueWritebackIntent(intentInput(fixture, {
      idempotencyKey: "run-001:processing-without-course-directory",
      courseBindingId: null,
    }));
    assert.equal(intent.courseBindingId, null);
    assert.equal(intent.operation.type, "single_select");
  } finally {
    await fixture.close();
  }
});

test("reports the next due writeback and active lease expiry for worker scheduling", async () => {
  const fixture = await createFixture();
  try {
    fixture.store.enqueueWritebackIntent(intentInput(fixture));
    fixture.store.enqueueWritebackIntent(intentInput(fixture, {
      idempotencyKey: "run-001:delayed-stage-uploaded",
      operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_uploaded" },
    }));
    const firstClaim = fixture.store.claimNextWritebackIntent({ leaseMs: 60_000 });
    fixture.store.markWritebackIntentRetryWait(firstClaim.id, firstClaim.claimToken, {
      code: "BRIDGE_UNAVAILABLE",
      message: "Bridge is temporarily unavailable",
      nextAttemptAt: "2026-09-17T08:10:00.000Z",
    });

    const secondClaim = fixture.store.claimNextWritebackIntent({ leaseMs: 90_000 });
    assert.equal(fixture.store.getNextWritebackAttemptAt(), "2026-09-17T08:10:00.000Z");
    assert.equal(fixture.store.getNextWritebackLeaseExpiry(), "2026-09-17T08:01:30.000Z");

    fixture.store.markWritebackIntentSucceeded(secondClaim.id, secondClaim.claimToken);
    assert.equal(fixture.store.getNextWritebackLeaseExpiry(), null);
  } finally {
    await fixture.close();
  }
});

test("records a production processing fact and its configured writebacks atomically", async () => {
  const fixture = await createFixture();
  try {
    const result = fixture.store.recordProcessingWritebackIntents({
      taskId: fixture.task.id,
      runId: fixture.run.runId,
      stageId: "initial",
      assignments: [
        { fieldId: "fld_status", optionId: "opt_auto_cutting" },
        { fieldId: "fld_progress", optionId: "opt_processing" },
      ],
    });

    assert.deepEqual(
      fixture.store.listDeliveryFacts(fixture.run.runId).map((fact) => ({ kind: fact.kind, snapshot: fact.snapshot })),
      [{ kind: "processing", snapshot: { stageId: "initial" } }],
    );
    assert.deepEqual(
      result.intents.map((intent) => ({
        idempotencyKey: intent.idempotencyKey,
        courseBindingId: intent.courseBindingId,
        operation: intent.operation,
      })),
      [
        {
          idempotencyKey: "run-001:processing:0",
          courseBindingId: null,
          operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_auto_cutting" },
        },
        {
          idempotencyKey: "run-001:processing:1",
          courseBindingId: null,
          operation: { type: "single_select", fieldId: "fld_progress", optionId: "opt_processing" },
        },
      ],
    );
  } finally {
    await fixture.close();
  }
});

test("rejects simulated Feishu tasks so a simulation can never write back", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.database.prepare(`
      UPDATE feishu_task_origins
      SET metadata_json = ?
      WHERE task_id = ?
    `).run(JSON.stringify({
      source: "feishu-base",
      deliverySource: "simulation",
      eventId: "event-001",
      baseToken: "bas_delivery",
      tableId: "tbl_courses",
      recordId: "rec_001",
    }), fixture.task.id);
    assert.throws(
      () => fixture.store.enqueueWritebackIntent(intentInput(fixture)),
      { code: "WRITEBACK_SIMULATION_FORBIDDEN" },
    );
  } finally {
    await fixture.close();
  }
});
