import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 60_000;
const LOCK_OWNER_FILE = "owner.json";
const TERMINAL_STATES = new Set(["succeeded", "dead_letter"]);
const MAX_FAILURE_HISTORY = 10;
const EVENT_SNAPSHOT_FIELDS = Object.freeze([
  "eventId",
  "baseToken",
  "tableId",
  "recordId",
  "recordTitle",
  "action",
  "fieldId",
  "fieldName",
  "beforeValue",
  "afterValue",
  "fields",
  "fieldValuesById",
]);

function normalizeEventSnapshot(event) {
  const snapshot = {};
  for (const field of EVENT_SNAPSHOT_FIELDS) {
    if (Object.hasOwn(event, field)) snapshot[field] = structuredClone(event[field]);
  }
  return snapshot;
}

function assertClaimOptions({ ownerId, leaseMs }) {
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    throw new Error("ownerId must be a non-empty string");
  }
  if (!Number.isFinite(leaseMs) || !Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("leaseMs must be a finite positive integer");
  }
}

function assertRetrySchedule(nextAttemptAt, now) {
  if (!Number.isFinite(nextAttemptAt) || nextAttemptAt <= now) {
    throw new Error("nextAttemptAt must be a finite timestamp greater than now");
  }
}

function newRecord(event, now) {
  return {
    schemaVersion: 2,
    eventId: event.eventId,
    event: normalizeEventSnapshot(event),
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
  if (value?.schemaVersion === 2) {
    const record = structuredClone(value);
    if (record.event && typeof record.event === "object" && !Array.isArray(record.event)) {
      record.event = normalizeEventSnapshot(record.event);
    }
    return record;
  }
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

function lockOwnerPath(lockPath) {
  return path.join(lockPath, LOCK_OWNER_FILE);
}

async function readLockOwner(lockPath) {
  try {
    const value = JSON.parse(await readFile(lockOwnerPath(lockPath), "utf8"));
    if (!value || typeof value !== "object") return null;
    return value;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeLockOwner(lockPath, token) {
  const owner = {
    token,
    pid: process.pid,
    createdAt: Date.now(),
  };
  const filename = lockOwnerPath(lockPath);
  await writeFile(filename, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await chmod(filename, 0o600);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. On Windows
    // this is the only reliable distinction available to an unprivileged
    // process.
    return error.code === "EPERM";
  }
}

async function isStaleLock(lockPath) {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs <= LOCK_STALE_MS) return false;
  const owner = await readLockOwner(lockPath);
  // A live owner is never forcefully removed just because its operation has
  // been quiet for a while. This prevents a stale-checking contender from
  // deleting a lock that was refreshed or is still being released.
  if (owner && processIsAlive(owner.pid)) return false;
  return true;
}

async function releaseOwnedDirectory(lockPath, token) {
  const quarantine = `${lockPath}.release.${token}`;
  try {
    // Rename first so a new owner can never be removed by a delayed cleanup
    // from the previous owner. The canonical path is then free for a waiter.
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const owner = await readLockOwner(quarantine);
  if (owner?.token === token) {
    await rm(quarantine, { recursive: true, force: true });
    return;
  }
  // The identity changed while we were releasing. Put the moved directory
  // back only when the canonical path is still vacant; never overwrite a
  // newer owner that won the race.
  await rename(quarantine, lockPath).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}

async function reclaimStaleMarker(markerPath) {
  if (!(await isStaleLock(markerPath))) return false;
  const quarantine = `${markerPath}.stale.${randomUUID()}`;
  try {
    // Rename is an atomic identity check: two contenders cannot both move
    // the same stale marker, and neither can remove a marker created after
    // its own stale observation.
    await rename(markerPath, quarantine);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function tryTakeover(lockPath, markerPath, token) {
  try {
    await mkdir(markerPath);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    await writeLockOwner(markerPath, token);
    if (!(await isStaleLock(lockPath))) return false;

    const observedOwner = await readLockOwner(lockPath);
    const quarantine = `${lockPath}.stale.${token}`;
    try {
      await rename(lockPath, quarantine);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }

    const movedOwner = await readLockOwner(quarantine);
    const sameIdentity = observedOwner?.token
      ? movedOwner?.token === observedOwner.token
      : !movedOwner?.token;
    if (!sameIdentity) {
      // The lock identity changed between observation and takeover. Never
      // delete or overwrite the moved directory; leave it for stale cleanup.
      return false;
    }
    await rm(quarantine, { recursive: true, force: true });
    try {
      await mkdir(lockPath);
      await writeLockOwner(lockPath, token);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await releaseOwnedDirectory(markerPath, token);
  }
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
    const markerPath = `${lockPath}.takeover`;
    const token = randomUUID();
    await mkdir(path.dirname(this.#filename), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let acquired = false;
    while (true) {
      if (await reclaimStaleMarker(markerPath)) {
        // A stale marker was reclaimed. Continue below and compete for the
        // canonical lock; a fresh marker remains visible and forces a wait.
      }
      try {
        await stat(markerPath);
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring state lock: ${lockPath}`);
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      try {
        await mkdir(lockPath);
        await writeLockOwner(lockPath, token);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        if (await tryTakeover(lockPath, markerPath, token)) {
          acquired = true;
          break;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring state lock: ${lockPath}`);
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    try {
      return await operation();
    } finally {
      if (acquired) await releaseOwnedDirectory(lockPath, token);
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
    assertClaimOptions({ ownerId, leaseMs });
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
    assertClaimOptions({ ownerId, leaseMs });
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
      if (!deadLetter) assertRetrySchedule(nextAttemptAt, now);
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
