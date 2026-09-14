# Feishu Bridge Reliability and Compensation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Feishu-to-Taskboard delivery recover safely from temporary Taskboard failures and Bridge restarts, while exposing honest queue and listener health without changing the existing business-routing or loopback security rules.

**Architecture:** Persist a versioned delivery record for every normalized event, atomically lease it before processing, and retry only classified temporary delivery failures through a single compensation worker. Retain the official Feishu SDK's built-in reconnect behavior rather than adding a competing reconnect loop; expose its lifecycle as `sdk_managed` because this SDK version has no public connection-event or dispose API.

**Tech Stack:** Node.js >= 22.13 ESM, built-in `node:test`, JSON state file with atomic rename and an OS-managed local IPC lock, PowerShell 5-compatible operational scripts, `@larksuiteoapi/node-sdk@1.36.x`.

## Global Constraints

- Keep Bridge and Taskboard loopback-only (`127.0.0.1`); do not add LAN/public listeners.
- Continue to create only manual Taskboard work items; do not start Codex, write back to Feishu, or handle video files.
- Keep the current per-table transition rule and alias whitelist unchanged; a Feishu cell must never provide a path, command, Codex argument, or prompt.
- Preserve at-least-once processing with Taskboard metadata lookup before creation; do not claim exactly-once delivery.
- Persist no app secret, local workspace path, configured prompt, or arbitrary event payload beyond the existing normalized event snapshot.
- Temporary Taskboard/network errors retry with a bounded backoff; deterministic decision errors become terminal outcomes; unexpected permanent delivery errors become `dead_letter`.
- Existing state files must be migrated safely: legacy terminal outcomes stay terminal; legacy `{ kind: "pending" }` entries become `dead_letter` because they lack an event snapshot.
- Do not add a custom WebSocket reconnect loop or depend on undocumented SDK private fields/log text. The installed official SDK already owns reconnection.
- Any behavior-changing code change must include automated tests, README updates, and `AGENTS.md` updates before review.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/retry-policy.mjs` | Pure defaults, retryable-error classification, exponential backoff, and safe error summaries. |
| `src/state-store.mjs` | Versioned delivery records, legacy migration, atomic claim/lease transitions, due-record selection, and queue statistics. |
| `src/state-lock.mjs` | OS-managed per-state-file local IPC lock; process termination releases the lock without stale-directory takeover. |
| `src/bridge.mjs` | One delivery path shared by new events and recovered events; translates errors into durable delivery states. |
| `src/compensation-worker.mjs` | One serial poller that recovers expired leases and drains due records without overlapping ticks. |
| `src/feishu-ws.mjs` | Existing normalization queue plus explicit SDK auto-reconnect option and truthful listener activity health. |
| `src/index.mjs` | Wiring for store, Bridge, worker, listener health, startup recovery, and orderly shutdown. |
| `src/config.mjs` / `config/bridge.example.json` | Validated, local-only delivery policy with safe defaults. |
| `src/server.mjs` / `scripts/check-local.ps1` | HTTP status semantics and sanitized health output. |
| `test/*.test.mjs` | Deterministic tests for retry policy, atomic state transitions, Bridge recovery, worker lifecycle, listener semantics, health, scripts, and docs. |
| `README.md` / `AGENTS.md` | Accurate operational contract, including SDK-managed reconnect and recovery verification. |

## State and Public Result Contract

The persisted v2 record uses millisecond Unix timestamps for deterministic comparisons:

```js
{
  schemaVersion: 2,
  eventId: "evt_123",
  event: { /* normalized, server-owned event shape */ },
  deliveryState: "pending" | "processing" | "retry_wait" | "succeeded" | "dead_letter",
  decision: null | "ready" | "blocked" | "ignored",
  attempts: 0,
  nextAttemptAt: null,
  lease: null | { ownerId: "bridge-instance-id", token: "fencing-token", leaseUntil: 0 },
  lastError: null | { code: "TASKBOARD_UNAVAILABLE", status: 0, at: 0 },
  failureHistory: [],
  outcome: null | { kind: "ready" | "blocked" | "ignored", taskId?: "...", taskIdentifier?: "..." },
  createdAt: 0,
  updatedAt: 0
}
```

`deliveryState` controls recovery; `decision` preserves the business result. A `blocked` decision that was successfully delivered is therefore `deliveryState: "succeeded"`, while a Taskboard outage during creation of the blocked card is `retry_wait`.

New or due work is returned by Bridge as one of:

```js
{ kind: "ready" | "blocked" | "ignored", ...outcome }
{ kind: "pending", deliveryState: "processing" | "retry_wait", attempts, retryAt? }
{ kind: "dead_letter", deliveryState: "dead_letter", attempts, errorCode }
```

Terminal replay keeps the existing compatibility contract by returning its original outcome plus `duplicate: true`. A second Bridge process that sees a valid lease returns the non-terminal `pending/processing` result rather than creating another task.

### Task 1: Add a Validated Delivery Policy and Pure Retry Utilities

**Files:**

- Create: `src/retry-policy.mjs`
- Create: `test/retry-policy.test.mjs`
- Modify: `src/config.mjs`
- Modify: `test/config.test.mjs`
- Modify: `config/bridge.example.json`

**Interfaces:**

- Produces `DEFAULT_DELIVERY_POLICY`, `validateDeliveryPolicy(input)`, `classifyDeliveryError(error)`, `calculateNextAttemptAt(options)`, and `summarizeDeliveryError(error, now)`.
- `validateConfig()` returns a `delivery` property with exactly `maxAttempts`, `initialDelayMs`, `maxDelayMs`, `leaseMs`, and `pollIntervalMs`.
- Later tasks pass `config.delivery` directly into `createBridge()` and `createCompensationWorker()`.

- [ ] **Step 1: Write the failing retry-policy tests.**

Create `test/retry-policy.test.mjs` with deterministic time/random inputs. Cover unavailable/429/5xx as retryable, Taskboard 400 and an ordinary `Error` as non-retryable, 5s → 15s → 45s backoff, maximum delay, fixed zero jitter at `random: () => 0.5`, and summaries that never include a raw multiline message.

```js
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

test("uses capped 5s, 15s, 45s retry delays without jitter when random is neutral", () => {
  const common = { now: 1_000, initialDelayMs: 5_000, maxDelayMs: 20_000, random: () => 0.5 };
  assert.equal(calculateNextAttemptAt({ ...common, attempts: 1 }), 6_000);
  assert.equal(calculateNextAttemptAt({ ...common, attempts: 2 }), 16_000);
  assert.equal(calculateNextAttemptAt({ ...common, attempts: 3 }), 21_000);
});

test("summarizes errors without preserving raw line breaks", () => {
  const summary = summarizeDeliveryError(Object.assign(new Error("first\\nsecond"), {
    code: "TASKBOARD_UNAVAILABLE",
    status: 0,
  }), 99);
  assert.deepEqual(summary, { code: "TASKBOARD_UNAVAILABLE", status: 0, at: 99 });
});
```

- [ ] **Step 2: Run the focused test to confirm the module is absent.**

Run: `node --test test/retry-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/retry-policy.mjs`.

- [ ] **Step 3: Implement the retry-policy module with fixed, bounded behavior.**

Create `src/retry-policy.mjs`. Keep jitter internal rather than configurable: it prevents retry storms without allowing a local config value to disable safety accidentally.

```js
export const DEFAULT_DELIVERY_POLICY = Object.freeze({
  maxAttempts: 8,
  initialDelayMs: 5_000,
  maxDelayMs: 300_000,
  leaseMs: 30_000,
  pollIntervalMs: 1_000,
});

export function classifyDeliveryError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 0;
  const code = typeof error?.code === "string" && error.code ? error.code : "DELIVERY_FAILED";
  return {
    code,
    status,
    retryable: code === "TASKBOARD_UNAVAILABLE" || status === 429 || status >= 500,
  };
}

export function calculateNextAttemptAt({ attempts, now, initialDelayMs, maxDelayMs, random = Math.random }) {
  const baseDelay = Math.min(initialDelayMs * (3 ** Math.max(0, attempts - 1)), maxDelayMs);
  const jittered = Math.round(baseDelay * (1 + ((random() * 2 - 1) * 0.2)));
  return now + Math.max(0, jittered);
}

export function summarizeDeliveryError(error, at) {
  const { code, status } = classifyDeliveryError(error);
  return { code, status, at };
}
```

- [ ] **Step 4: Add delivery-policy validation without breaking existing local configs.**

In `src/config.mjs`, add a positive-integer helper and a `deliveryPolicy()` normalizer. Merge absent `input.delivery` onto `DEFAULT_DELIVERY_POLICY`; reject non-objects, non-positive values, `maxAttempts < 1`, `maxDelayMs < initialDelayMs`, and poll intervals below 100 ms. Return only the five known properties.

```js
function positiveInteger(value, name, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function deliveryPolicy(value) {
  const source = value === undefined ? {} : plainObject(value, "delivery");
  const result = {
    maxAttempts: positiveInteger(source.maxAttempts ?? DEFAULT_DELIVERY_POLICY.maxAttempts, "delivery.maxAttempts"),
    initialDelayMs: positiveInteger(source.initialDelayMs ?? DEFAULT_DELIVERY_POLICY.initialDelayMs, "delivery.initialDelayMs"),
    maxDelayMs: positiveInteger(source.maxDelayMs ?? DEFAULT_DELIVERY_POLICY.maxDelayMs, "delivery.maxDelayMs"),
    leaseMs: positiveInteger(source.leaseMs ?? DEFAULT_DELIVERY_POLICY.leaseMs, "delivery.leaseMs"),
    pollIntervalMs: positiveInteger(source.pollIntervalMs ?? DEFAULT_DELIVERY_POLICY.pollIntervalMs, "delivery.pollIntervalMs", 100),
  };
  if (result.maxDelayMs < result.initialDelayMs) {
    throw new Error("delivery.maxDelayMs must be >= delivery.initialDelayMs");
  }
  return result;
}
```

Import `DEFAULT_DELIVERY_POLICY` at the top of the config module, add `delivery: deliveryPolicy(input.delivery)` to its returned object, and put the following non-secret example immediately after `stateFile` in `config/bridge.example.json`:

```json
"delivery": {
  "maxAttempts": 8,
  "initialDelayMs": 5000,
  "maxDelayMs": 300000,
  "leaseMs": 30000,
  "pollIntervalMs": 1000
},
```

Extend `test/config.test.mjs` to assert default values when `delivery` is omitted, a valid override, a too-small poll interval, and inverted delays.

- [ ] **Step 5: Run the focused tests.**

Run: `node --test test/retry-policy.test.mjs test/config.test.mjs`

Expected: PASS with all retry-policy and configuration tests green.

- [ ] **Step 6: Commit the self-contained policy change.**

```powershell
git add src/retry-policy.mjs test/retry-policy.test.mjs src/config.mjs test/config.test.mjs config/bridge.example.json
git commit -m "feat: add bridge delivery retry policy"
```

### Task 2: Replace the Flat Outcome Store with Versioned Atomic Delivery Records

**Files:**

- Modify: `src/state-store.mjs`
- Modify: `test/state-store.test.mjs`

**Interfaces:**

- Consumes `config.delivery.leaseMs` and normalized events from Bridge.
- Produces:

```js
store.claimEvent(event, { ownerId, now, leaseMs })
// => { kind: "claimed", record } | { kind: "terminal", record } | { kind: "deferred", record }

store.claimNextDue({ ownerId, now, leaseMs, excludeEventIds? })
// => record | null

store.complete(eventId, { ownerId, token, decision, outcome, now })
store.fail(eventId, { ownerId, token, error, nextAttemptAt, deadLetter, now })
store.renewLease(eventId, { ownerId, token, now, leaseMs })
store.recoverExpiredLeases({ now, excludeEventIds? })
store.getQueueStats()
```

- Each claim carries a random fencing token; `complete()`, `fail()` and `renewLease()` require the matching owner and token, and terminal writes reject expired leases instead of overwriting another worker's record.

- [ ] **Step 1: Write the failing state-transition tests.**

Extend `test/state-store.test.mjs` with a fixed `event()` helper and temporary files. Add tests for atomic cross-instance claiming, future `retry_wait` deferral, lease recovery, owner protection, statistics, and legacy migration.

```js
const event = (eventId = "evt_state") => ({
  eventId,
  baseToken: "bas_demo",
  tableId: "tbl_demo",
  recordId: "rec_demo",
  fieldName: "视频整体进度",
  beforeValue: "素材齐全",
  afterValue: "待剪辑",
  fields: {},
});

test("only one store instance can claim the same event", async () => {
  const [left, right] = [new JsonStateStore(filename), new JsonStateStore(filename)];
  const [first, second] = await Promise.all([
    left.claimEvent(event(), { ownerId: "left", now: 100, leaseMs: 1_000 }),
    right.claimEvent(event(), { ownerId: "right", now: 100, leaseMs: 1_000 }),
  ]);
  assert.deepEqual([first.kind, second.kind].sort(), ["claimed", "deferred"]);
});

test("does not claim retry work before its due time", async () => {
  const store = new JsonStateStore(filename);
  await store.claimEvent(event(), { ownerId: "one", now: 0, leaseMs: 10 });
  await store.fail("evt_state", {
    ownerId: "one",
    error: { code: "TASKBOARD_UNAVAILABLE", status: 0, at: 1 },
    nextAttemptAt: 100,
    deadLetter: false,
    now: 1,
  });
  assert.equal(await store.claimNextDue({ ownerId: "two", now: 99, leaseMs: 10 }), null);
  assert.equal((await store.claimNextDue({ ownerId: "two", now: 100, leaseMs: 10 })).eventId, "evt_state");
});
```

Add a legacy JSON fixture directly in the test: `{ "evt_old": { "kind": "pending" } }`. Assert it becomes `dead_letter` with `lastError.code === "LEGACY_EVENT_SNAPSHOT_MISSING"`, has no automatic due entry, and is rehydrated only when `claimEvent(event("evt_old"), ...)` provides a complete event snapshot.

- [ ] **Step 2: Run the focused state-store tests to confirm the new API is missing.**

Run: `node --test test/state-store.test.mjs`

Expected: FAIL because `claimEvent` and the other v2 transition methods do not exist.

- [ ] **Step 3: Implement record normalization and a single locked mutation primitive.**

Use an OS-managed local IPC lock keyed by the canonical absolute state-file path, plus the existing atomic temporary-file rename and `0600` file mode. Process termination must release the lock without PID-based stale takeover. The configured state path must be a stable regular file path: reject the state file itself when it is a symbolic link or hard-link/multi-link alias, and do not replace the configured path while the service is running. The lock covers only processes on the same Windows/Linux host. Replace `#write(eventId, outcome, overwrite)` with a `#mutate(operation)` helper that reads, normalizes, mutates, and writes the entire map while holding the file lock.

Use these exact helpers and record construction rules:

```js
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
      schemaVersion: 2, eventId, event: null, deliveryState: "dead_letter",
      decision: null, attempts: 0, nextAttemptAt: null, lease: null,
      lastError: { code: "LEGACY_EVENT_SNAPSHOT_MISSING", status: 0, at: now },
      failureHistory: [], outcome: null, createdAt: now, updatedAt: now,
    };
  }
  return {
    schemaVersion: 2, eventId, event: null, deliveryState: "succeeded",
    decision: value?.kind ?? null, attempts: 0, nextAttemptAt: null, lease: null,
    lastError: null, failureHistory: [], outcome: structuredClone(value),
    createdAt: now, updatedAt: now,
  };
}

function validLease(record, now) {
  return record.deliveryState === "processing" && record.lease?.leaseUntil > now;
}
```

Never accept caller-provided record state. The only event data persisted is a cloned normalized event supplied to `claimEvent`.

- [ ] **Step 4: Implement the claim, terminal, failure, recovery, and summary transitions.**

Inside `claimEvent`, create a new record if absent; rehydrate only a legacy missing-snapshot dead letter when the same `eventId` arrives with an event snapshot; return `terminal` for all other terminal records; return `deferred` for an active lease or future retry; otherwise set `processing`, increment `attempts`, set `{ ownerId, leaseUntil: now + leaseMs }`, and return `claimed`.

`claimNextDue` must use the same `#mutate` call, select the oldest due `pending`/`retry_wait` record that has an event snapshot, then apply the same lease/increment logic. `recoverExpiredLeases` changes only expired `processing` records back to `pending` and clears their lease. `complete` writes `succeeded`, decision, outcome, and a null lease. `fail` writes either `retry_wait` with a future `nextAttemptAt` or `dead_letter` with no next attempt, appends at most ten summaries, clears the lease, and leaves the captured event unchanged.

Use an owner check shared by `complete` and `fail`:

```js
function assertLeaseOwner(record, ownerId, now) {
  if (record.deliveryState !== "processing" || record.lease?.ownerId !== ownerId || record.lease.leaseUntil <= now) {
    throw new Error(`Cannot update delivery record ${record.eventId}: lease is not owned by ${ownerId}`);
  }
}
```

`getQueueStats()` returns exactly:

```js
{ pending: 0, processing: 0, retryWait: 0, deadLetter: 0 }
```

Do not retain the old `put`/`replace` API in Bridge. It is acceptable to keep simple `get(eventId)` only for diagnostic tests if it returns a normalized v2 record.

- [ ] **Step 5: Run the complete state-store test file.**

Run: `node --test test/state-store.test.mjs`

Expected: PASS, including the existing atomic-write tests updated to v2 records and the new cross-instance lease tests.

- [ ] **Step 6: Commit the persistent state machine.**

```powershell
git add src/state-store.mjs test/state-store.test.mjs
git commit -m "feat: persist bridge delivery state machine"
```

### Task 3: Route New and Recovered Events Through One Durable Bridge Path

**Files:**

- Modify: `src/bridge.mjs`
- Create: `src/observability.mjs`
- Modify: `test/bridge.test.mjs`
- Create: `test/observability.test.mjs`

**Interfaces:**

- Consumes v2 `JsonStateStore`, `config.delivery`, `retry-policy` helpers, `TaskboardClient`, and optional title resolution.
- Produces `createBridge({...})` with `{ handle(event), recover(), processDue(), getQueueStats() }`.
- For compatibility with unit fixtures and older callers, `createBridge` uses `config.delivery ?? DEFAULT_DELIVERY_POLICY` when the caller omits the new policy.
- `processDue()` returns `null` when no due record exists; otherwise returns the same public result as `handle()`.

- [ ] **Step 1: Write failing Bridge tests for retry, dead letter, recovery, and cross-instance safety.**

Replace the current test named `leaves a pending marker when Taskboard is unavailable` with tests that use a mutable `now` and a policy `{ maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 10, pollIntervalMs: 100 }`.

At the top of the test file, define the helpers used by the examples so the failure paths are explicit and deterministic:

```js
const policy = { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, leaseMs: 10, pollIntervalMs: 100 };
const unavailable = () => Object.assign(new Error("offline"), {
  code: "TASKBOARD_UNAVAILABLE",
  status: 0,
});
const retryEvent = { ...event, eventId: "evt_retry" };
```

`event` is the existing valid fixture in `test/bridge.test.mjs`; do not add a path, prompt, or arbitrary payload to this fixture. Use a separate `store = memoryStore()` for each test that needs isolated state.

```js
test("defers a temporary Taskboard failure then creates exactly one task when due", async () => {
  let now = 0;
  let available = false;
  const store = memoryStore();
  const bridge = createBridge({
    config: { ...config, delivery: policy },
    store,
    now: () => now,
    random: () => 0.5,
    taskboard: {
      findTaskByEventId: async () => null,
      ensureProject: async () => { if (!available) throw unavailable(); },
      createTask: async () => ({ id: "task_1", identifier: "AUTO-1" }),
    },
  });
  assert.deepEqual(await bridge.handle(retryEvent), {
    kind: "pending", deliveryState: "retry_wait", attempts: 1, retryAt: 5,
  });
  now = 5;
  available = true;
  assert.equal((await bridge.processDue()).taskIdentifier, "AUTO-1");
  assert.equal((await bridge.processDue()), null);
});
```

Also test that an ignored event is immediately `succeeded` and never due again; a blocked decision retries only when its Taskboard creation fails; eight/controlled maximum failures become `dead_letter`; an existing task found on retry is completed without `createTask`; a replay of a succeeded event has `duplicate: true`; and two Bridge instances sharing the same file do not call `createTask` twice.

Create `test/observability.test.mjs` that asserts event/table/record references are deterministic hashes and that structured logs do not contain a passed fake app secret or a configured workspace path.

- [ ] **Step 2: Run the focused tests and confirm they fail against the old Bridge API.**

Run: `node --test test/bridge.test.mjs test/observability.test.mjs`

Expected: FAIL because `processDue`, retry output, and safe structured logging are not implemented.

- [ ] **Step 3: Add safe, structured delivery logging.**

Create `src/observability.mjs` with no config access and no raw event logging:

```js
import { createHash } from "node:crypto";

export function safeReference(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 12);
}

export function logDelivery(logger, level, { eventId, tableId, recordId, deliveryState, attempts, errorCode, taskIdentifier }) {
  logger[level]?.(JSON.stringify({
    component: "bridge-delivery",
    event: safeReference(eventId),
    table: safeReference(tableId),
    record: safeReference(recordId),
    deliveryState,
    attempts,
    ...(errorCode ? { errorCode } : {}),
    ...(taskIdentifier ? { taskIdentifier } : {}),
  }));
}
```

Only log known metadata and error codes. Do not put `lastError.message`, prompt, workspace path, app ID, secret, or full payload into logs.

- [ ] **Step 4: Refactor `createBridge` around claims and a shared processor.**

Give `createBridge` the following signature and defaults:

```js
export function createBridge({
  config, store, taskboard, resolveRecordTitle,
  titleLookupTimeoutMs = 5_000,
  now = () => Date.now(),
  random = Math.random,
  ownerId = randomUUID(),
  logger = console,
})
```

Keep the existing per-process `inFlight` map only to make same-process duplicate calls await the same result. Replace `store.get/put/replace` flow with:

```js
async function handleClaim(claim) {
  if (claim.kind === "terminal") {
    if (claim.record.deliveryState === "dead_letter") {
      return {
        kind: "dead_letter",
        deliveryState: "dead_letter",
        attempts: claim.record.attempts,
        errorCode: claim.record.lastError?.code ?? "DELIVERY_FAILED",
        duplicate: true,
      };
    }
    return { ...claim.record.outcome, duplicate: true };
  }
  if (claim.kind === "deferred") {
    return {
      kind: "pending",
      deliveryState: claim.record.deliveryState,
      attempts: claim.record.attempts,
      ...(claim.record.nextAttemptAt ? { retryAt: claim.record.nextAttemptAt } : {}),
    };
  }
  return deliverClaimedRecord(claim.record);
}
```

`deliverClaimedRecord(record)` must use `record.event`, call the existing `decideRecordChange`, preserve title lookup's current non-fatal fallback behavior, call `findTaskByEventId` before `ensureProject/createTask`, and call `store.complete()` for ready/blocked/ignored outcomes. Build the outcome in the existing shape so current callers still receive `kind`, `reason`, `taskId`, `taskIdentifier`, and `packageAlias` where applicable.

Wrap only the delivery sequence in a `try/catch`. On catch:

```js
const classification = classifyDeliveryError(error);
const attempts = record.attempts;
const deadLetter = !classification.retryable || attempts >= config.delivery.maxAttempts;
const retryAt = deadLetter ? null : calculateNextAttemptAt({
  attempts,
  now: now(),
  initialDelayMs: config.delivery.initialDelayMs,
  maxDelayMs: config.delivery.maxDelayMs,
  random,
});
const stored = await store.fail(record.eventId, {
  ownerId,
  error: summarizeDeliveryError(error, now()),
  nextAttemptAt: retryAt,
  deadLetter,
  now: now(),
});
```

Return a durable result instead of rethrowing: `pending/retry_wait` with attempts and retry time, or `dead_letter` with `errorCode`. This is crucial: a Taskboard outage must not make the Feishu callback fail after the event has been saved for retry.

Implement `recover()` as `store.recoverExpiredLeases({ now: now() })`, `processDue()` as `store.claimNextDue(...)` plus `deliverClaimedRecord`, and `getQueueStats()` as a direct store delegation.

- [ ] **Step 5: Run Bridge and observability tests.**

Run: `node --test test/bridge.test.mjs test/observability.test.mjs`

Expected: PASS. Confirm the legacy title resolver tests still pass because title lookup remains a best-effort enhancement, not a delivery retry condition.

- [ ] **Step 6: Commit the durable Bridge behavior.**

```powershell
git add src/bridge.mjs src/observability.mjs test/bridge.test.mjs test/observability.test.mjs
git commit -m "feat: retry durable bridge deliveries"
```

### Task 4: Add a Single-Worker Compensation Scheduler and Startup Recovery

**Files:**

- Create: `src/compensation-worker.mjs`
- Create: `test/compensation-worker.test.mjs`
- Modify: `src/index.mjs`

**Interfaces:**

- Consumes Bridge `{ recover, processDue }` and `config.delivery.pollIntervalMs`.
- Produces `createCompensationWorker({ bridge, pollIntervalMs, logger, timers })` with `{ start, stop, runOnce }`.
- `start()` begins one immediate sweep then schedules later sweeps; `stop()` clears the future timer and waits for the active sweep.

- [ ] **Step 1: Write failing worker tests with fake timers and Bridge.**

Create `test/compensation-worker.test.mjs`. Use a fake Bridge whose `processDue()` returns two outcomes then `null`; use injected `timers` so no real delay is required. Test the immediate sweep, serial draining, no overlap when a tick fires during a pending run, and stop cancellation.

Use this minimal timer double for all worker tests:

```js
function fakeTimers() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setTimeout(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) { callbacks.delete(id); },
    async fireNext() {
      const [id, callback] = callbacks.entries().next().value ?? [];
      if (id === undefined) return;
      callbacks.delete(id);
      await callback();
    },
  };
}
```

```js
test("drains due records serially and never overlaps sweeps", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const worker = createCompensationWorker({
    bridge: {
      recover: async () => calls.push("recover"),
      processDue: async () => { calls.push("due"); await gate; return null; },
    },
    pollIntervalMs: 100,
    timers: fakeTimers,
    logger: { error: assert.fail },
  });
  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.strictEqual(first, second);
  release();
  await first;
  assert.deepEqual(calls, ["recover", "due"]);
});
```

When testing `start()`, call `await Promise.resolve()` (or await the returned `runOnce()` directly) after `start()` so the immediate asynchronous sweep has a chance to begin before asserting calls. The production `start()` remains fire-and-forget because HTTP readiness must not wait on historical retries.

- [ ] **Step 2: Run the new test to verify it fails before implementation.**

Run: `node --test test/compensation-worker.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/compensation-worker.mjs`.

- [ ] **Step 3: Implement the non-overlapping worker.**

Create `src/compensation-worker.mjs` using a chained `setTimeout`, not `setInterval`, so a slow Taskboard call never overlaps the next sweep.

```js
export function createCompensationWorker({ bridge, pollIntervalMs, logger = console, timers = globalThis }) {
  let timer = null;
  let active = null;
  let stopped = false;

  function runOnce() {
    if (active) return active;
    active = (async () => {
      await bridge.recover();
      while (await bridge.processDue()) {}
    })().catch((error) => {
      logger.error?.(`Bridge compensation sweep failed: ${error.message}`);
    }).finally(() => { active = null; });
    return active;
  }

  function schedule() {
    if (stopped) return;
    timer = timers.setTimeout(async () => {
      await runOnce();
      schedule();
    }, pollIntervalMs);
  }

  return {
    start() { stopped = false; void runOnce(); schedule(); },
    async stop() { stopped = true; if (timer) timers.clearTimeout(timer); timer = null; await active; },
    runOnce,
  };
}
```

In the implementation, keep the error message out of production structured delivery logs; this worker-level message is only an operational failure signal and must not include event content.

- [ ] **Step 4: Wire recovery and the worker into `src/index.mjs`.**

Create one `JsonStateStore` variable, pass it into Bridge, create the worker with `config.delivery.pollIntervalMs`, and call `worker.start()` only after the HTTP server is listening. In `close()`, set `closing`, await `worker.stop()`, then stop/drain the listener, then close the HTTP server. Do not block initial HTTP readiness on a failed historical retry; the worker owns recovery failure reporting.

```js
const store = new JsonStateStore(config.stateFile);
const bridge = createBridge({ config, store, taskboard: new TaskboardClient(config.taskboardUrl), ... });
const compensationWorker = createCompensationWorker({
  bridge,
  pollIntervalMs: config.delivery.pollIntervalMs,
  logger: console,
});

const address = await app.listen();
compensationWorker.start();
```

- [ ] **Step 5: Run worker and core integration tests.**

Run: `node --test test/compensation-worker.test.mjs test/bridge.test.mjs test/state-store.test.mjs`

Expected: PASS, including restart-style recovery from an expired `processing` lease.

- [ ] **Step 6: Commit the worker lifecycle.**

```powershell
git add src/compensation-worker.mjs test/compensation-worker.test.mjs src/index.mjs
git commit -m "feat: run bridge compensation worker"
```

### Task 5: Use SDK-Managed Reconnect and Expose Truthful Listener Activity

**Files:**

- Modify: `src/feishu-ws.mjs`
- Modify: `test/feishu-ws.test.mjs`
- Modify: `src/index.mjs`

**Interfaces:**

- `createFeishuWsListener()` continues to own table filtering, normalization, and serial event handling.
- It now exposes `health`, an object shaped as `{ state, lastEventAt, lastError }`.
- It sets the SDK constructor option `autoReconnect: true` explicitly and creates exactly one SDK client for the listener lifetime.

- [ ] **Step 1: Add failing tests for SDK-managed state semantics.**

Extend the fake SDK in `test/feishu-ws.test.mjs` to record constructor options. Add tests that assert `autoReconnect: true`, start transitions from `starting` to `sdk_managed` rather than `connected`, an accepted event updates `health.lastEventAt`, callback failures populate a safe code/time, and `stop()` works when a fake client provides `stop` but does not fail when the SDK exposes no public stop method.

```js
test("starts one SDK-managed reconnecting client without claiming socket confirmation", async () => {
  const sdk = fakeSdk();
  const listener = createFeishuWsListener({ appId: "id", appSecret: "secret", tables: [table], sdk, handleEvent: async () => {} });
  await listener.start();
  assert.equal(listener.wsClient.options.autoReconnect, true);
  assert.equal(listener.health.state, "sdk_managed");
  assert.equal(listener.health.lastEventAt, null);
});
```

- [ ] **Step 2: Run the listener tests to verify current state behavior fails.**

Run: `node --test test/feishu-ws.test.mjs`

Expected: FAIL because the old listener reports `connected` and has no `health` property.

- [ ] **Step 3: Implement activity health without private SDK coupling.**

Retain `stopClient`, but make it return a boolean indicating whether a public `stop`, `close`, or `disconnect` method actually existed. In the listener:

```js
let state = "idle";
let lastEventAt = null;
let lastError = null;

const wsClient = new sdkModule.WSClient({
  appId: normalizedAppId,
  appSecret: normalizedSecret,
  autoReconnect: true,
});

get health() {
  return { state, lastEventAt, lastError };
}
```

Set `state = "starting"` before `wsClient.start()`. Once its returned promise resolves, set `state = "sdk_managed"`; this means the SDK owns its reconnect lifecycle, not that a physical connection has been externally confirmed. Immediately before queueing at least one normalized event, set `lastEventAt = Date.now()`. When the callback's processing promise rejects, set `lastError = { code: error.code ?? "FEISHU_EVENT_HANDLER_FAILED", at: Date.now() }`, keep the serial queue alive, and retain `sdk_managed` rather than treating a Taskboard retry outcome as a listener failure.

On `stop()`, drain first. If `stopClient` reports true, set `stopped`; otherwise leave the state as `sdk_managed` and let the Node process exit after signal handling. Do not inspect `wsConfig`, parse SDK logs, create a second client, or add reconnect timers.

- [ ] **Step 4: Include listener health in `src/index.mjs`.**

Replace the string-only health provider with:

```js
getHealth: async () => ({
  ok: true,
  feishuListener: feishuListener?.health ?? {
    state: "disabled",
    lastEventAt: null,
    lastError: null,
  },
  queue: await bridge.getQueueStats(),
})
```

When the listener is disabled, do not load the SDK and retain this `disabled` object. When SDK construction/start fails synchronously, close the HTTP app as today and allow startup to fail without printing credentials.

- [ ] **Step 5: Run focused listener and index-adjacent tests.**

Run: `node --test test/feishu-ws.test.mjs test/server.test.mjs`

Expected: listener tests pass with one client and truthful `sdk_managed` state; server tests will be updated in the next task for the new health shape.

- [ ] **Step 6: Commit the SDK-managed reconnect integration.**

```powershell
git add src/feishu-ws.mjs test/feishu-ws.test.mjs src/index.mjs
git commit -m "feat: expose sdk-managed Feishu listener health"
```

### Task 6: Publish Queue Health and Update the Operating Contract

**Files:**

- Modify: `src/server.mjs`
- Modify: `test/server.test.mjs`
- Modify: `scripts/check-local.ps1`
- Modify: `test/operations-hardening.test.mjs`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**

- `/health` returns a listener object and `{ pending, processing, retryWait, deadLetter }` queue object.
- Simulated delivery returns 202 after a durable retry/dead-letter result, rather than 502 after an already-persisted failure.
- `check-local.ps1 -RequireFeishu` verifies the listener is SDK-managed and has no startup/error state; it explicitly says this SDK cannot supply a public physical-socket confirmation and directs operators to a test-table event for final proof.

- [ ] **Step 1: Write failing HTTP and script-contract tests.**

Update `test/server.test.mjs` so the configured health provider returns:

```js
{
  ok: true,
  feishuListener: { state: "sdk_managed", lastEventAt: 10, lastError: null },
  queue: { pending: 1, processing: 0, retryWait: 2, deadLetter: 3 },
}
```

Assert that `/health` returns it unchanged. Add a simulated handler returning `{ kind: "pending", deliveryState: "retry_wait", attempts: 1, retryAt: 100 }` and assert HTTP 202.

Update `test/operations-hardening.test.mjs` assertions to require queue status handling and object-style `feishuListener.state`, and replace the old README assertion that says there is no automatic reconnect/compensation with assertions for bounded retry, dead-letter visibility, and SDK-managed reconnect.

- [ ] **Step 2: Run the focused server and operations tests to verify they fail.**

Run: `node --test test/server.test.mjs test/operations-hardening.test.mjs`

Expected: FAIL because the current server returns 200/201-only result types and operational documentation says these capabilities are unsupported.

- [ ] **Step 3: Update server status mapping without changing route exposure.**

In `src/server.mjs`, retain all routes and loopback behavior. Change the simulated-event status calculation to:

```js
const status = outcome.duplicate ? 200
  : outcome.kind === "ready" || outcome.kind === "blocked" ? 201
    : outcome.kind === "pending" || outcome.kind === "dead_letter" ? 202
      : 200;
```

`dead_letter` is 202 because the event has been durably accepted and recorded for human attention; it is not a transport failure that should cause Feishu redelivery.

- [ ] **Step 4: Update `check-local.ps1` for object listener health and sanitized queue output.**

Replace the current string cast with an object-aware read:

```powershell
$listenerState = if ($bridge.feishuListener -and $bridge.feishuListener.state) {
  [string]$bridge.feishuListener.state
} elseif ($bridge.feishuListener) {
  [string]$bridge.feishuListener
} else {
  'unknown'
}
$queue = $bridge.queue
if ($RequireFeishu -and $listenerState -notin @('sdk_managed')) {
  throw "Feishu listener is not SDK-managed (state: $listenerState)."
}
```

Print only numeric queue counters and state names. When `-RequireFeishu` succeeds, print: `Feishu listener: sdk_managed (the installed SDK does not expose a public socket-confirmed state; verify by a test-table event).` Do not print `lastError.message`, raw event data, Base tokens, or anything from `.env.local`.

- [ ] **Step 5: Update the README and AGENTS operational language.**

In `README.md`:

- Add durable retry, restart recovery, dead-letter visibility, and SDK-managed reconnect to the supported-capabilities table.
- Change the health-check description to mention queue counters and `sdk_managed` listener state.
- Replace the current “does not provide SDK reconnect/backoff or timed compensation” boundary with the precise remaining limitations: no public socket-confirmed listener status, no manual dead-letter retry endpoint yet, no HA, no Feishu writeback, no automatic Codex, and no video processing.
- Add the outage acceptance procedure: stop Taskboard, send a matching simulation, observe retry queue, restore Taskboard, verify exactly one task.

In `AGENTS.md`:

- Change the pending invariant to durable retries, lease recovery, and dead-letter preservation.
- Clarify that `-RequireFeishu` verifies SDK-managed listener startup; an actual test-table event is required to prove end-to-end subscription delivery because the SDK has no public connection callback.
- Retain the existing warning not to delete state files to fix duplicates.

- [ ] **Step 6: Run operational tests and PowerShell syntax checks.**

Run: `node --test test/server.test.mjs test/operations-hardening.test.mjs test/startup-scripts.test.mjs`

Expected: PASS, including Windows PowerShell 5 parser checks and secret-safety checks.

- [ ] **Step 7: Commit the health and documentation contract.**

```powershell
git add src/server.mjs test/server.test.mjs scripts/check-local.ps1 test/operations-hardening.test.mjs README.md AGENTS.md
git commit -m "docs: document bridge recovery operations"
```

### Task 7: Full Regression, Local Recovery Exercise, and Review-Ready Evidence

**Files:**

- Modify only if the preceding checks reveal a real requirement gap: the exact implementation/test/doc file responsible for that gap.
- Do not create a new state file, add secrets, or commit `.runtime/`, `.env.local`, or `config/bridge.local.json`.

**Interfaces:**

- Consumes all completed tasks.
- Produces verification evidence only; no new feature surface.

- [ ] **Step 1: Run the complete automated suite.**

Run: `npm test`

Expected: PASS with all original tests plus retry-policy, compensation-worker, observability, state migration, queue-health, and SDK-managed listener tests.

- [ ] **Step 2: Perform the local recovery exercise using only the existing simulation route.**

Run from `D:\codex\codex-feishu`:

```powershell
.\scripts\stop-local.ps1
.\scripts\start-local.ps1
.\scripts\check-local.ps1
```

With Taskboard deliberately unavailable, submit the existing deterministic simulated event once and verify the Bridge returns 202 with `deliveryState: retry_wait`. Restore Taskboard, wait for the configured retry window, then confirm exactly one Taskboard task is present and the queue count decreases. Replay the same simulated event and confirm the result is duplicate/no second task. Do not alter a production Feishu record for this check.

- [ ] **Step 3: Verify real listener configuration only when credentials and a test table are available.**

Run:

```powershell
.\scripts\stop-local.ps1
.\scripts\start-local.ps1 -EnableFeishu
.\scripts\check-local.ps1 -RequireFeishu
```

Then change only a designated test-table record into the configured trigger value once. Confirm a single task appears and record the sanitized health output. This verifies the SDK-managed long connection in practice; do not treat `sdk_managed` alone as a physical-socket proof.

- [ ] **Step 4: Review the final diff and status before requesting code review.**

Run:

```powershell
git diff --check HEAD~6..HEAD
git status --short
git log --oneline -6
```

Expected: no whitespace errors; only intended source, tests, config example, README, AGENTS, and design/plan documents are tracked; no local credentials or runtime state appear.

- [ ] **Step 5: Request review with concrete evidence.**

Provide the reviewer with: the result of `npm test`, the local recovery exercise outcome, the exact health object shape, the legacy-pending migration rule, and the SDK limitation that prevents claiming a public `connected` state. Ask reviewers to focus on duplicate-task windows, lease-owner checks, retry classification, and secret leakage.
