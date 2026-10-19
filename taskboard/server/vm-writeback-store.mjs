import { randomUUID } from "node:crypto";
import { FEISHU_WRITEBACK_LEASE_DURATION_MS, FEISHU_WRITEBACK_MAX_LEASE_DURATION_MS }
  from "./feishu-delivery-store.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const MAX_ATTEMPTS = 8;
const READY_SQL = `q.state IN ('pending', 'retry_wait') AND NOT EXISTS (
  SELECT 1 FROM vm_writeback_outbox p WHERE p.run_id = q.run_id
  AND q.moment = 'completed' AND p.moment = 'processing'
  AND p.state IN ('pending', 'processing', 'retry_wait'))`;

function fail(code = "WRITEBACK_INVALID", status = 400) {
  return Object.assign(new Error(code), { code, status });
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value) { return typeof value === "string" && IDENTIFIER.test(value); }
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function statusGuard(value) {
  if (!exactKeys(value, ["fieldId", "optionIds"]) || !id(value.fieldId)
    || !Array.isArray(value.optionIds) || value.optionIds.length < 1 || value.optionIds.length > 16
    || !value.optionIds.every(id) || new Set(value.optionIds).size !== value.optionIds.length) throw fail();
  return { fieldId: value.fieldId, optionIds: [...value.optionIds] };
}
function operation(value) {
  if (!object(value) || Object.keys(value).some((key) => !["type", "fieldId", "optionId", "guard"].includes(key))
    || !["type", "fieldId", "optionId"].every((key) => Object.hasOwn(value, key))
    || value.type !== "single_select" || !id(value.fieldId) || !id(value.optionId)) throw fail();
  return { type: "single_select", fieldId: value.fieldId, optionId: value.optionId,
    ...(Object.hasOwn(value, "guard") ? { guard: statusGuard(value.guard) } : {}) };
}
function intent(value) {
  if (!exactKeys(value, ["idempotencyKey", "taskId", "runId", "courseBindingId", "operation"])
    || !id(value.taskId) || !id(value.runId) || value.courseBindingId !== null) throw fail();
  const moment = ["processing", "completed"].find((entry) => value.idempotencyKey === `vm:${value.runId}:${entry}`);
  if (!moment) throw fail();
  return { idempotencyKey: value.idempotencyKey, taskId: value.taskId, runId: value.runId,
    courseBindingId: null, operation: operation(value.operation) };
}
function resolution(value) {
  if (!exactKeys(value, ["target", "operation"])
    || !exactKeys(value.target, ["baseToken", "tableId", "recordId"])
    || !Object.values(value.target).every(id)) throw fail("WRITEBACK_REFERENCE_INVALID", 409);
  return { target: { baseToken: value.target.baseToken, tableId: value.target.tableId,
    recordId: value.target.recordId }, operation: operation(value.operation) };
}
function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) throw fail();
  return value;
}
function duration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > FEISHU_WRITEBACK_MAX_LEASE_DURATION_MS) throw fail();
  return value;
}
function rowValue(row) {
  if (!row) return null;
  return { id: row.id, idempotencyKey: row.idempotency_key, taskId: row.task_id, runId: row.run_id,
    courseBindingId: null, moment: row.moment, target: JSON.parse(row.target_json),
    operation: JSON.parse(row.operation_json), state: row.state, version: row.version,
    attemptCount: row.attempt_count, nextAttemptAt: row.next_attempt_at,
    claimToken: row.claim_token, leaseUntil: row.lease_until, errorCode: row.error_code,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Independent VM outbox; validates server-owned evidence before enqueue and every Bridge dispatch. */
export function createVmWritebackStore({ database, validateIntent, now = Date.now } = {}) {
  const db = database?.database ?? database;
  if (typeof db?.prepare !== "function" || typeof db?.exec !== "function"
    || typeof validateIntent !== "function") throw fail("WRITEBACK_UNAVAILABLE", 503);
  db.exec(`CREATE TABLE IF NOT EXISTS vm_writeback_outbox (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL, run_id TEXT NOT NULL, moment TEXT NOT NULL CHECK(moment IN ('processing','completed')),
    target_json TEXT NOT NULL, operation_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','processing','retry_wait','succeeded','conflict','dead_letter')),
    version INTEGER NOT NULL, attempt_count INTEGER NOT NULL,
    next_attempt_at TEXT, claim_token TEXT, lease_until TEXT, error_code TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(run_id, moment)
  ); CREATE INDEX IF NOT EXISTS vm_writeback_due ON vm_writeback_outbox(state, next_attempt_at);`);
  const time = () => new Date(now()).toISOString();
  const lookup = (key) => rowValue(db.prepare("SELECT * FROM vm_writeback_outbox WHERE id = ?").get(key));
  function transaction(callback) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); db.exec("COMMIT"); return result; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  function activeClaim(claim) {
    if (!exactKeys(claim, ["operationId", "claimToken", "version"])
      || !id(claim.operationId) || !claim.operationId.startsWith("vm-") || !id(claim.claimToken)
      || !Number.isSafeInteger(claim.version) || claim.version < 1) throw fail();
    const value = lookup(claim.operationId);
    if (!value || value.state !== "processing" || value.claimToken !== claim.claimToken
      || value.version !== claim.version || value.leaseUntil <= time()) throw fail("WRITEBACK_CLAIM_STALE", 409);
    return value;
  }
  function transition(key, token, state, { code = null, nextAttemptAt = null } = {}) {
    if (!id(key) || !id(token)) throw fail();
    const at = time();
    const changed = db.prepare(`UPDATE vm_writeback_outbox SET state = ?, version = version + 1,
      next_attempt_at = ?, claim_token = NULL, lease_until = NULL, error_code = ?, updated_at = ?
      WHERE id = ? AND state = 'processing' AND claim_token = ? AND lease_until > ?`)
      .run(state, nextAttemptAt, code, at, key, token, at);
    return changed.changes === 1 ? lookup(key) : null;
  }
  function errorCode(input) {
    return typeof input?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(input.code)
      ? input.code : "FEISHU_WRITEBACK_FAILED";
  }

  return Object.freeze({
    async enqueueWritebackIntent(value) {
      const input = intent(value);
      const trusted = resolution(await validateIntent(structuredClone(input)));
      if (JSON.stringify(trusted.operation) !== JSON.stringify(input.operation)) throw fail("WRITEBACK_REFERENCE_INVALID", 409);
      return transaction(() => {
        const previous = rowValue(db.prepare("SELECT * FROM vm_writeback_outbox WHERE idempotency_key = ?")
          .get(input.idempotencyKey));
        if (previous) {
          if (previous.taskId !== input.taskId || previous.runId !== input.runId
            || JSON.stringify(previous.operation) !== JSON.stringify(trusted.operation)
            || JSON.stringify(previous.target) !== JSON.stringify(trusted.target)) throw fail("WRITEBACK_REFERENCE_INVALID", 409);
          return previous;
        }
        const moment = input.idempotencyKey.endsWith(":completed") ? "completed" : "processing";
        if (moment === "processing" && db.prepare("SELECT id FROM vm_writeback_outbox WHERE run_id = ? AND moment = 'completed'")
          .get(input.runId)) throw fail("WRITEBACK_REFERENCE_INVALID", 409);
        const key = `vm-${randomUUID()}`;
        const at = time();
        db.prepare(`INSERT INTO vm_writeback_outbox (id, idempotency_key, task_id, run_id, moment,
          target_json, operation_json, state, version, attempt_count, next_attempt_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, 0, ?, ?, ?)`).run(key, input.idempotencyKey,
          input.taskId, input.runId, moment, JSON.stringify(trusted.target), JSON.stringify(trusted.operation), at, at, at);
        return lookup(key);
      });
    },
    async resolveWritebackIntentForBridge(claim) {
      const value = activeClaim(claim);
      const trusted = resolution(await validateIntent(intent({ idempotencyKey: value.idempotencyKey,
        taskId: value.taskId, runId: value.runId, courseBindingId: null, operation: value.operation })));
      if (JSON.stringify(trusted.target) !== JSON.stringify(value.target)
        || JSON.stringify(trusted.operation) !== JSON.stringify(value.operation)) throw fail("WRITEBACK_REFERENCE_INVALID", 409);
      activeClaim(claim);
      return trusted;
    },
    getWritebackIntent(key) { return id(key) ? lookup(key) : null; },
    listWritebackIntents({ runId } = {}) {
      if (runId !== undefined && !id(runId)) throw fail();
      return (runId === undefined ? db.prepare("SELECT * FROM vm_writeback_outbox ORDER BY created_at, id").all()
        : db.prepare("SELECT * FROM vm_writeback_outbox WHERE run_id = ? ORDER BY created_at, id").all(runId)).map(rowValue);
    },
    async retryDeadLetterWritebacks({ taskId, runId } = {}, beforeCommit = () => {}) {
      if (!id(taskId) || !id(runId) || typeof beforeCommit !== "function") throw fail();
      const entries = db.prepare(`SELECT * FROM vm_writeback_outbox WHERE run_id = ?
        ORDER BY CASE moment WHEN 'processing' THEN 0 ELSE 1 END`).all(runId).map(rowValue);
      if (entries.length !== 2 || entries.some(entry => entry.taskId !== taskId)
        || entries[0].moment !== "processing" || entries[0].state !== "dead_letter"
        || entries[1].moment !== "completed" || entries[1].state !== "dead_letter")
        throw fail("WRITEBACK_RETRY_NOT_ALLOWED", 409);
      for (const entry of entries) {
        const trusted = resolution(await validateIntent(intent({ idempotencyKey: entry.idempotencyKey,
          taskId, runId, courseBindingId: null, operation: entry.operation })));
        if (JSON.stringify(trusted.target) !== JSON.stringify(entry.target)
          || JSON.stringify(trusted.operation) !== JSON.stringify(entry.operation))
          throw fail("WRITEBACK_REFERENCE_INVALID", 409);
      }
      return transaction(() => {
        beforeCommit();
        for (const entry of entries) {
          if (JSON.stringify(lookup(entry.id)) !== JSON.stringify(entry)) throw fail("WRITEBACK_RETRY_NOT_ALLOWED", 409);
        }
        const at = time();
        for (const entry of entries.filter(entry => entry.state === "dead_letter")) {
          db.prepare(`UPDATE vm_writeback_outbox SET state = 'pending', version = version + 1,
            attempt_count = 0, next_attempt_at = ?, claim_token = NULL, lease_until = NULL,
            error_code = NULL, updated_at = ? WHERE id = ?`).run(at, at, entry.id);
        }
        return entries.map(entry => lookup(entry.id));
      });
    },
    getNextWritebackAttemptAt() {
      return db.prepare(`SELECT MIN(q.next_attempt_at) AS at FROM vm_writeback_outbox q WHERE ${READY_SQL}`).get()?.at ?? null;
    },
    getNextWritebackLeaseExpiry() {
      return db.prepare("SELECT MIN(lease_until) AS at FROM vm_writeback_outbox WHERE state = 'processing'").get()?.at ?? null;
    },
    claimNextWritebackIntent({ leaseMs = FEISHU_WRITEBACK_LEASE_DURATION_MS } = {}) {
      const lease = duration(leaseMs);
      return transaction(() => {
        const at = time();
        const candidate = db.prepare(`SELECT q.id FROM vm_writeback_outbox q WHERE ${READY_SQL}
          AND q.next_attempt_at <= ? ORDER BY q.next_attempt_at, q.created_at, q.id LIMIT 1`).get(at);
        if (!candidate) return null;
        db.prepare(`UPDATE vm_writeback_outbox SET state = 'processing', version = version + 1,
          attempt_count = attempt_count + 1, next_attempt_at = NULL, claim_token = ?, lease_until = ?,
          error_code = NULL, updated_at = ? WHERE id = ?`).run(randomUUID(),
          new Date(Date.parse(at) + lease).toISOString(), at, candidate.id);
        return lookup(candidate.id);
      });
    },
    renewWritebackIntentLease(key, token, { leaseMs = FEISHU_WRITEBACK_LEASE_DURATION_MS } = {}) {
      if (!id(key) || !id(token)) throw fail();
      const lease = duration(leaseMs);
      const at = time();
      const changed = db.prepare(`UPDATE vm_writeback_outbox SET lease_until = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND state = 'processing' AND claim_token = ? AND lease_until > ?`)
        .run(new Date(Date.parse(at) + lease).toISOString(), at, key, token, at);
      return changed.changes === 1 ? lookup(key) : null;
    },
    recoverExpiredWritebackIntents() {
      const at = time();
      return Number(db.prepare(`UPDATE vm_writeback_outbox SET state = CASE WHEN attempt_count >= ? THEN 'dead_letter' ELSE 'pending' END,
        version = version + 1, next_attempt_at = CASE WHEN attempt_count >= ? THEN NULL ELSE ? END,
        claim_token = NULL, lease_until = NULL, error_code = 'WRITEBACK_LEASE_EXPIRED', updated_at = ?
        WHERE state = 'processing' AND (lease_until IS NULL OR lease_until <= ?)`)
        .run(MAX_ATTEMPTS, MAX_ATTEMPTS, at, at, at).changes);
    },
    markWritebackIntentSucceeded(key, token) { return transition(key, token, "succeeded"); },
    markWritebackIntentRetryWait(key, token, input) {
      const nextAttemptAt = timestamp(input?.nextAttemptAt);
      if (nextAttemptAt <= time()) throw fail();
      const current = lookup(key);
      if (current && current.attemptCount >= MAX_ATTEMPTS) {
        return transition(key, token, "dead_letter", { code: errorCode(input) });
      }
      return transition(key, token, "retry_wait", { nextAttemptAt, code: errorCode(input) });
    },
    markWritebackIntentConflict(key, token, input) { return transition(key, token, "conflict", { code: errorCode(input) }); },
    markWritebackIntentDeadLetter(key, token, input) { return transition(key, token, "dead_letter", { code: errorCode(input) }); },
  });
}
