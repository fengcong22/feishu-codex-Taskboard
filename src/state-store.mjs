import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 60_000;
const TERMINAL_STATES = new Set(["succeeded", "dead_letter"]);
const MAX_FAILURE_HISTORY = 10;

function newRecord(event, now) {
  return {
    schemaVersion: 2,
    eventId: event.eventId,
    event: structuredClone(event),
    deliveryState: "pending",
    decision: null,
    attempts: 0,
    nextAttemptAt: null,
    lease: null,
    lastError: null,
    failureHistory: [],
    outcome: null,
    createdAt: now,
    updatedAt: now,
  };
}

function legacyRecord(eventId, value, now) {
  if (value?.kind === "pending") {
    return {
      schemaVersion: 2,
      eventId,
      event: null,
      deliveryState: "dead_letter",
      decision: null,
      attempts: 0,
      nextAttemptAt: null,
      lease: null,
      lastError: { code: "LEGACY_EVENT_SNAPSHOT_MISSING", status: 0, at: now },
      failureHistory: [],
      outcome: null,
      createdAt: now,
      updatedAt: now,
    };
  }
  return {
    schemaVersion: 2,
    eventId,
    event: null,
    deliveryState: "succeeded",
    decision: value?.kind ?? null,
    attempts: 0,
    nextAttemptAt: null,
    lease: null,
    lastError: null,
    failureHistory: [],
    outcome: structuredClone(value),
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeRecord(eventId, value, now) {
  if (value?.schemaVersion === 2) return value;
  return legacyRecord(eventId, value, now);
}

function validLease(record, now) {
  return (
    record.deliveryState === "processing"
    && Number.isFinite(record.lease?.leaseUntil)
    && record.lease.leaseUntil > now
  );
}

function assertEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("event must be an object");
  }
  if (typeof event.eventId !== "string" || event.eventId.trim() === "") {
    throw new Error("event.eventId must be a non-empty string");
  }
}

function hasEventSnapshot(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  for (const field of ["eventId", "baseToken", "tableId", "recordId", "fieldName"]) {
    if (typeof event[field] !== "string" || event[field].trim() === "") return false;
  }
  if (!Object.hasOwn(event, "beforeValue") || !Object.hasOwn(event, "afterValue")) return false;
  return Boolean(event.fields && typeof event.fields === "object" && !Array.isArray(event.fields));
}

function assertLeaseOwner(record, ownerId, now) {
  const leaseUntil = record.lease?.leaseUntil;
  if (
    record.deliveryState !== "processing"
    || record.lease?.ownerId !== ownerId
    || !Number.isFinite(leaseUntil)
    || leaseUntil <= now
  ) {
    throw new Error(`Cannot update delivery record ${record.eventId}: lease is not owned by ${ownerId}`);
  }
}

function summarizeError(error, now) {
  const code = typeof error?.code === "string" && error.code
    ? error.code
    : "DELIVERY_FAILED";
  const status = Number.isInteger(error?.status) ? error.status : 0;
  const at = Number.isFinite(error?.at) ? error.at : now;
  return { code, status, at };
}

function stateObject() {
  return Object.create(null);
}

export class JsonStateStore {
  #filename;
  #writeQueue = Promise.resolve();

  constructor(filename) {
    this.#filename = filename;
  }

  async #read(now = Date.now()) {
    let data;
    try {
      data = JSON.parse(await readFile(this.#filename, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return stateObject();
      throw error;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return stateObject();
    const state = stateObject();
    for (const [key, value] of Object.entries(data)) {
      state[key] = normalizeRecord(key, value, now);
    }
    return state;
  }

  async get(eventId) {
    const state = await this.#read();
    return Object.hasOwn(state, eventId) ? structuredClone(state[eventId]) : null;
  }

  async #withFileLock(operation) {
    const lockPath = `${this.#filename}.lock`;
    await mkdir(path.dirname(this.#filename), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
          if (lockAge > LOCK_STALE_MS) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring state lock: ${lockPath}`);
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async #writeState(state) {
    const temporary = `${this.#filename}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#filename);
    await chmod(this.#filename, 0o600);
  }

  async #mutate(operation, now = Date.now()) {
    let result;
    this.#writeQueue = this.#writeQueue.catch(() => {}).then(async () => {
      result = await this.#withFileLock(async () => {
        const state = await this.#read(now);
        const value = await operation(state);
        await this.#writeState(state);
        return value;
      });
    });
    await this.#writeQueue;
    return result;
  }

  async claimEvent(event, { ownerId, now, leaseMs }) {
    assertEvent(event);
    return this.#mutate((state) => {
      let record = Object.hasOwn(state, event.eventId) ? state[event.eventId] : null;
      if (!record) {
        if (!hasEventSnapshot(event)) throw new Error("event snapshot is incomplete");
        record = newRecord(event, now);
        state[event.eventId] = record;
      } else if (
        record.deliveryState === "dead_letter"
        && record.event === null
        && record.lastError?.code === "LEGACY_EVENT_SNAPSHOT_MISSING"
      ) {
        if (!hasEventSnapshot(event)) return { kind: "terminal", record: structuredClone(record) };
        record = newRecord(event, now);
        state[event.eventId] = record;
      }

      if (TERMINAL_STATES.has(record.deliveryState)) {
        return { kind: "terminal", record: structuredClone(record) };
      }
      if (validLease(record, now)) {
        return { kind: "deferred", record: structuredClone(record) };
      }
      if (
        record.deliveryState === "retry_wait"
        && record.nextAttemptAt !== null
        && record.nextAttemptAt > now
      ) {
        return { kind: "deferred", record: structuredClone(record) };
      }

      record.deliveryState = "processing";
      record.attempts += 1;
      record.nextAttemptAt = null;
      record.lease = { ownerId, leaseUntil: now + leaseMs };
      record.updatedAt = now;
      return { kind: "claimed", record: structuredClone(record) };
    }, now);
  }

  async claimNextDue({ ownerId, now, leaseMs }) {
    return this.#mutate((state) => {
      const due = Object.values(state)
        .filter((record) => (
          (record.deliveryState === "pending" || record.deliveryState === "retry_wait")
          && hasEventSnapshot(record.event)
          && (record.nextAttemptAt === null || record.nextAttemptAt <= now)
        ))
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!due) return null;

      due.deliveryState = "processing";
      due.attempts += 1;
      due.nextAttemptAt = null;
      due.lease = { ownerId, leaseUntil: now + leaseMs };
      due.updatedAt = now;
      return structuredClone(due);
    }, now);
  }

  async complete(eventId, { ownerId, decision, outcome, now }) {
    return this.#mutate((state) => {
      const record = state[eventId];
      if (!record) throw new Error(`Cannot update unknown delivery record ${eventId}`);
      assertLeaseOwner(record, ownerId, now);
      record.deliveryState = "succeeded";
      record.decision = decision;
      record.outcome = structuredClone(outcome);
      record.nextAttemptAt = null;
      record.lease = null;
      record.updatedAt = now;
      return structuredClone(record);
    }, now);
  }

  async fail(eventId, { ownerId, error, nextAttemptAt, deadLetter, now }) {
    return this.#mutate((state) => {
      const record = state[eventId];
      if (!record) throw new Error(`Cannot update unknown delivery record ${eventId}`);
      assertLeaseOwner(record, ownerId, now);
      const summary = summarizeError(error, now);
      record.lastError = summary;
      record.failureHistory = [...record.failureHistory, summary].slice(-MAX_FAILURE_HISTORY);
      record.deliveryState = deadLetter ? "dead_letter" : "retry_wait";
      record.nextAttemptAt = deadLetter ? null : nextAttemptAt;
      record.lease = null;
      record.updatedAt = now;
      return structuredClone(record);
    }, now);
  }

  async recoverExpiredLeases({ now }) {
    return this.#mutate((state) => {
      let recovered = 0;
      for (const record of Object.values(state)) {
        if (record.deliveryState === "processing" && record.lease?.leaseUntil <= now) {
          record.deliveryState = "pending";
          record.lease = null;
          record.nextAttemptAt = null;
          record.updatedAt = now;
          recovered += 1;
        }
      }
      return recovered;
    }, now);
  }

  async getQueueStats() {
    const state = await this.#read();
    const stats = {
      pending: 0,
      processing: 0,
      retryWait: 0,
      deadLetter: 0,
    };
    for (const record of Object.values(state)) {
      if (record.deliveryState === "pending") stats.pending += 1;
      else if (record.deliveryState === "processing") stats.processing += 1;
      else if (record.deliveryState === "retry_wait") stats.retryWait += 1;
      else if (record.deliveryState === "dead_letter") stats.deadLetter += 1;
    }
    return stats;
  }
}
