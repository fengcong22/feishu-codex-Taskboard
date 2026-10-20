import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createVmWritebackStore } from "../server/vm-writeback-store.mjs";
import { createFeishuWritebackWorker } from "../server/feishu-writeback-worker.mjs";

function intent(moment = "processing", runId = "run_vm") {
  return { idempotencyKey: `vm:${runId}:${moment}`, taskId: "task_vm", runId,
    courseBindingId: null, operation: { type: "single_select", fieldId: "fld_status",
      optionId: moment === "processing" ? "opt_processing" : "opt_completed" } };
}

const target = { baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm" };
const claimOf = (entry) => ({ operationId: entry.id, claimToken: entry.claimToken, version: entry.version });

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-writeback-"));
  const filename = path.join(directory, "state.sqlite");
  let db = new DatabaseSync(filename);
  let time = 1_700_000_000_000;
  let validation = async (input) => ({ target, operation: input.operation });
  let validationCalls = 0;
  const create = () => createVmWritebackStore({ database: db, now: () => time,
    validateIntent: async (input) => { validationCalls += 1; return validation(input); } });
  let store = create();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, get database() { return db; },
    reopen() { db.close(); db = new DatabaseSync(filename); store = create(); return store; },
    advance(ms) { time += ms; }, now: () => time,
    validateWith(callback) { validation = callback; }, validationCalls: () => validationCalls };
}

test("VM intents persist independently and deduplicate after database reopen", async (t) => {
  const f = await fixture(t);
  const first = await f.store.enqueueWritebackIntent(intent());
  assert.match(first.id, /^vm-/u);
  assert.equal(first.state, "pending");
  f.reopen();
  assert.equal((await f.store.enqueueWritebackIntent(intent())).id, first.id);
  assert.equal(f.store.listWritebackIntents({ runId: "run_vm" }).length, 1);
  assert.equal(f.database.prepare("SELECT name FROM sqlite_master WHERE name = 'feishu_writeback_outbox'").get(), undefined);
  await assert.rejects(() => f.store.enqueueWritebackIntent({ ...intent(), taskId: "other_task" }),
    { code: "WRITEBACK_REFERENCE_INVALID" });
});

test("VM enqueue refuses untrusted evidence and unsupported caller operations before persistence", async (t) => {
  const f = await fixture(t);
  f.validateWith(async () => { throw Object.assign(new Error("untrusted"), { code: "VM_WRITEBACK_UNTRUSTED" }); });
  await assert.rejects(() => f.store.enqueueWritebackIntent(intent()), { code: "VM_WRITEBACK_UNTRUSTED" });
  for (const input of [
    { ...intent(), target },
    { ...intent(), idempotencyKey: "vm:other_run:processing" },
    { ...intent(), courseBindingId: "zip-course" },
    { ...intent(), operation: { type: "text", fieldId: "fld_status", value: "done" } },
  ]) await assert.rejects(() => f.store.enqueueWritebackIntent(input), { code: "WRITEBACK_INVALID" });
  assert.equal(f.store.listWritebackIntents().length, 0);
});

test("VM outbox preserves the frozen PMO status guard through Bridge resolution", async (t) => {
  const f = await fixture(t);
  const guarded = { ...intent(), operation: { ...intent().operation,
    guard: { fieldId: "fld_status", optionIds: ["opt_ready", "opt_processing"] } } };
  const queued = await f.store.enqueueWritebackIntent(guarded);
  assert.deepEqual(queued.operation, guarded.operation);
  const claim = f.store.claimNextWritebackIntent();
  assert.deepEqual(await f.store.resolveWritebackIntentForBridge(claimOf(claim)), { target,
    operation: guarded.operation });
});

test("VM resolver requires a live claim and revalidates trusted evidence every dispatch", async (t) => {
  const f = await fixture(t);
  const queued = await f.store.enqueueWritebackIntent(intent());
  await assert.rejects(() => f.store.resolveWritebackIntentForBridge({ operationId: queued.id,
    claimToken: "unclaimed", version: 1 }), { code: "WRITEBACK_CLAIM_STALE" });
  const claimed = f.store.claimNextWritebackIntent();
  assert.equal(f.store.claimNextWritebackIntent(), null);
  assert.deepEqual(await f.store.resolveWritebackIntentForBridge(claimOf(claimed)),
    { target, operation: { type: "single_select", fieldId: "fld_status", optionId: "opt_processing" } });
  assert.equal(f.validationCalls(), 2);
  f.validateWith(async (input) => ({ target: { ...target, recordId: "other_record" }, operation: input.operation }));
  await assert.rejects(() => f.store.resolveWritebackIntentForBridge(claimOf(claimed)),
    { code: "WRITEBACK_REFERENCE_INVALID" });
  for (const claim of [{ ...claimOf(claimed), claimToken: "wrong" },
    { ...claimOf(claimed), version: claimed.version + 1 }]) {
    await assert.rejects(() => f.store.resolveWritebackIntentForBridge(claim), { code: "WRITEBACK_CLAIM_STALE" });
  }
});

test("VM expired claims recover after restart and cannot finish or renew another worker's claim", async (t) => {
  const f = await fixture(t);
  await f.store.enqueueWritebackIntent(intent());
  const first = f.store.claimNextWritebackIntent({ leaseMs: 1000 });
  f.advance(1000);
  assert.equal(f.store.renewWritebackIntentLease(first.id, first.claimToken), null);
  f.reopen();
  assert.equal(f.store.recoverExpiredWritebackIntents(), 1);
  const second = f.store.claimNextWritebackIntent();
  assert.equal(second.id, first.id);
  assert.notEqual(second.claimToken, first.claimToken);
  assert.equal(second.attemptCount, 2);
  assert.equal(f.store.markWritebackIntentSucceeded(first.id, first.claimToken), null);
  assert.equal(f.store.getWritebackIntent(second.id).state, "processing");
  assert.equal(f.store.markWritebackIntentSucceeded(second.id, second.claimToken).state, "succeeded");
  await assert.rejects(() => f.store.resolveWritebackIntentForBridge(claimOf(second)), { code: "WRITEBACK_CLAIM_STALE" });
  assert.equal((await f.store.enqueueWritebackIntent(intent())).state, "succeeded");
});

test("VM resolution rechecks lease ownership after asynchronous evidence lookup", async (t) => {
  const f = await fixture(t);
  await f.store.enqueueWritebackIntent(intent());
  const claim = f.store.claimNextWritebackIntent({ leaseMs: 1000 });
  f.validateWith(async (input) => { f.advance(1000); return { target, operation: input.operation }; });
  await assert.rejects(() => f.store.resolveWritebackIntentForBridge(claimOf(claim)), { code: "WRITEBACK_CLAIM_STALE" });
});

test("VM completed status waits while processing status is pending retry", async (t) => {
  const f = await fixture(t);
  const processing = await f.store.enqueueWritebackIntent(intent());
  const completed = await f.store.enqueueWritebackIntent(intent("completed"));
  const first = f.store.claimNextWritebackIntent();
  assert.equal(first.id, processing.id);
  const retryAt = new Date(f.now() + 5000).toISOString();
  f.store.markWritebackIntentRetryWait(first.id, first.claimToken, {
    code: "WRITEBACK_UNAVAILABLE", message: "sensitive server response", nextAttemptAt: retryAt,
  });
  assert.equal(f.store.claimNextWritebackIntent(), null);
  assert.equal(f.store.getNextWritebackAttemptAt(), retryAt);
  f.advance(5000);
  const retried = f.store.claimNextWritebackIntent();
  assert.equal(retried.id, processing.id);
  f.store.markWritebackIntentSucceeded(retried.id, retried.claimToken);
  assert.equal(f.store.claimNextWritebackIntent().id, completed.id);
  assert.doesNotMatch(JSON.stringify(f.store.listWritebackIntents()), /sensitive server response/u);
});

test("existing Bridge worker delivers VM claims and persists transient retries", async (t) => {
  const f = await fixture(t);
  const queued = await f.store.enqueueWritebackIntent(intent());
  let calls = 0;
  const worker = createFeishuWritebackWorker({ store: f.store, now: f.now, random: () => 0.5,
    dispatch: async (claim) => {
      assert.deepEqual(await f.store.resolveWritebackIntentForBridge(claim), { target, operation: intent().operation });
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("temporary"), { code: "WRITEBACK_UNAVAILABLE", status: 503 });
    } });
  t.after(() => worker.close());
  await worker.start();
  assert.equal(f.store.getWritebackIntent(queued.id).state, "retry_wait");
  f.advance(5000);
  await worker.wake();
  assert.equal(f.store.getWritebackIntent(queued.id).state, "succeeded");
  assert.equal(calls, 2);
});

test("VM changed-field conflict is terminal while unrelated pending runs can continue", async (t) => {
  const f = await fixture(t);
  const blocked = await f.store.enqueueWritebackIntent(intent());
  const good = await f.store.enqueueWritebackIntent(intent("processing", "run_other"));
  const worker = createFeishuWritebackWorker({ store: f.store, now: f.now,
    dispatch: async (claim) => {
      if (claim.operationId === blocked.id) throw Object.assign(new Error("changed"), { code: "FIELD_CHANGED", status: 409 });
      await f.store.resolveWritebackIntentForBridge(claim);
    } });
  t.after(() => worker.close());
  await worker.start();
  assert.equal(f.store.getWritebackIntent(blocked.id).state, "conflict");
  assert.equal(f.store.getWritebackIntent(good.id).state, "succeeded");
  assert.equal(f.store.getNextWritebackAttemptAt(), null);
});

test("VM repeated worker crashes exhaust a bounded recovery budget", async (t) => {
  const f = await fixture(t);
  const queued = await f.store.enqueueWritebackIntent(intent());
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const claimed = f.store.claimNextWritebackIntent({ leaseMs: 1 });
    assert.equal(claimed.attemptCount, attempt);
    f.advance(1);
    assert.equal(f.store.recoverExpiredWritebackIntents(), 1);
  }
  assert.equal(f.store.getWritebackIntent(queued.id).state, "dead_letter");
  assert.equal(f.store.claimNextWritebackIntent(), null);
  assert.equal((await f.store.enqueueWritebackIntent(intent())).state, "dead_letter");
});

test("VM writeback retry requeues only the same task/run dead letters and resets their attempt budget", async (t) => {
  const f = await fixture(t);
  const processing = await f.store.enqueueWritebackIntent(intent());
  const completed = await f.store.enqueueWritebackIntent(intent("completed"));
  f.database.prepare("UPDATE vm_writeback_outbox SET state='dead_letter',attempt_count=8,error_code='WRITEBACK_UNAVAILABLE'")
    .run();

  const retried = await f.store.retryDeadLetterWritebacks({ taskId: "task_vm", runId: "run_vm" });

  assert.deepEqual(retried.map((entry) => [entry.id, entry.moment, entry.state, entry.attemptCount, entry.errorCode]), [
    [processing.id, "processing", "pending", 0, null],
    [completed.id, "completed", "pending", 0, null],
  ]);
  assert.equal(f.validationCalls(), 4);
  assert.deepEqual([processing.id, completed.id].map(id => f.store.getWritebackIntent(id).operation),
    [processing.operation, completed.operation]);
});

test("VM writeback retry refuses partial or changed dead letters without altering the frozen intents", async (t) => {
  const f = await fixture(t);
  const processing = await f.store.enqueueWritebackIntent(intent());
  const completed = await f.store.enqueueWritebackIntent(intent("completed"));
  f.database.prepare("UPDATE vm_writeback_outbox SET state='dead_letter',attempt_count=8,error_code='WRITEBACK_UNAVAILABLE'")
    .run();
  f.database.prepare("UPDATE vm_writeback_outbox SET state='succeeded' WHERE id=?").run(completed.id);
  await assert.rejects(() => f.store.retryDeadLetterWritebacks({ taskId: "task_vm", runId: "run_vm" }),
    { code: "WRITEBACK_RETRY_NOT_ALLOWED" });
  assert.equal(f.store.getWritebackIntent(processing.id).state, "dead_letter");

  f.database.prepare("UPDATE vm_writeback_outbox SET state='dead_letter' WHERE id=?").run(completed.id);
  f.validateWith(async (input) => ({ target, operation: { ...input.operation, optionId: "changed_option" } }));
  await assert.rejects(() => f.store.retryDeadLetterWritebacks({ taskId: "task_vm", runId: "run_vm" }),
    { code: "WRITEBACK_REFERENCE_INVALID" });
  assert.equal(f.store.getWritebackIntent(processing.id).state, "dead_letter");
  assert.equal(f.store.getWritebackIntent(completed.id).state, "dead_letter");
});

test("VM late processing intent cannot follow a completed intent", async (t) => {
  const f = await fixture(t);
  await f.store.enqueueWritebackIntent(intent("completed"));
  const claimed = f.store.claimNextWritebackIntent();
  f.store.markWritebackIntentSucceeded(claimed.id, claimed.claimToken);
  await assert.rejects(() => f.store.enqueueWritebackIntent(intent()), { code: "WRITEBACK_REFERENCE_INVALID" });
  assert.equal(f.store.listWritebackIntents().length, 1);
});

test("VM worker retains the concrete failure code when the automatic retry budget is exhausted", async (t) => {
  const f = await fixture(t);
  const queued = await f.store.enqueueWritebackIntent(intent());
  f.database.prepare("UPDATE vm_writeback_outbox SET attempt_count=7 WHERE id=?").run(queued.id);
  const worker = createFeishuWritebackWorker({ store: f.store, now: f.now,
    dispatch: async () => { throw Object.assign(new Error("unavailable"), { code: "WRITEBACK_UNAVAILABLE", status: 503 }); } });
  t.after(() => worker.close());

  await worker.start();

  assert.equal(f.store.getWritebackIntent(queued.id).state, "dead_letter");
  assert.equal(f.store.getWritebackIntent(queued.id).errorCode, "WRITEBACK_UNAVAILABLE");
});
