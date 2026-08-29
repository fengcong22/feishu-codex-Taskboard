import { createHash, randomUUID } from "node:crypto";

import { decideRecordChange } from "./decide-event.mjs";
import {
  calculateNextAttemptAt,
  classifyDeliveryError,
  DEFAULT_DELIVERY_POLICY,
  summarizeDeliveryError,
} from "./retry-policy.mjs";
import { logDelivery } from "./observability.mjs";
import { buildTaskPayload } from "./task-payload.mjs";
import { archiveWaitingFeishuTasks } from "./task-lifecycle.mjs";

const DEFAULT_TITLE_LOOKUP_TIMEOUT_MS = 5_000;

function withTimeout(operation, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Feishu title lookup timed out after ${timeoutMs}ms`);
      error.code = "FEISHU_TITLE_LOOKUP_TIMEOUT";
      reject(error);
    }, timeoutMs);
    Promise.resolve().then(operation).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function publicPending(record) {
  return {
    kind: "pending",
    deliveryState: record.deliveryState,
    attempts: record.attempts,
    ...(record.nextAttemptAt !== null && record.nextAttemptAt !== undefined
      ? { retryAt: record.nextAttemptAt }
      : {}),
  };
}

function publicDeadLetter(record, duplicate = false) {
  return {
    kind: "dead_letter",
    deliveryState: "dead_letter",
    attempts: record.attempts,
    errorCode: record.lastError?.code ?? "DELIVERY_FAILED",
    ...(duplicate ? { duplicate: true } : {}),
  };
}

function leaseLostError() {
  const error = new Error("delivery lease lost");
  error.code = "LEASE_LOST";
  return error;
}

function isLeaseLost(error) {
  return error?.code === "LEASE_LOST" || error?.code === "LEASE_NOT_OWNED";
}

const DECISION_SNAPSHOT_VERSION = 1;

function packageConfigFingerprint(packageConfig) {
  if (!packageConfig || typeof packageConfig !== "object") return undefined;
  const canonical = JSON.stringify({
    projectId: packageConfig.projectId ?? null,
    projectName: packageConfig.projectName ?? null,
    workspacePath: packageConfig.workspacePath ?? null,
    prompt: packageConfig.prompt ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function snapshotAction(decision) {
  if (decision?.kind === "ready" || decision?.kind === "blocked") return "create";
  if (decision?.kind === "ignored" && decision?.effect === "archive_waiting_tasks") return "archive";
  return null;
}

function optionalSnapshotString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function buildDecisionSnapshot(decision) {
  const action = snapshotAction(decision);
  if (!action || !decision?.event || !decision?.table) return null;
  const tableSource = decision.table;
  const table = {
    baseToken: optionalSnapshotString(tableSource.baseToken) ?? decision.event.baseToken,
    tableId: optionalSnapshotString(tableSource.tableId) ?? decision.event.tableId,
    subjectKey: optionalSnapshotString(decision.subjectKey ?? tableSource.subjectKey),
    name: optionalSnapshotString(tableSource.name) ?? decision.event.tableId,
    mode: optionalSnapshotString(decision.executionMode ?? tableSource.executionMode ?? tableSource.mode),
    executionMode: optionalSnapshotString(decision.executionMode ?? tableSource.executionMode ?? tableSource.mode),
    uploadMode: optionalSnapshotString(decision.uploadMode ?? tableSource.uploadMode),
    concurrencyGroup: optionalSnapshotString(decision.concurrencyGroup ?? tableSource.concurrencyGroup),
    triggerField: optionalSnapshotString(tableSource.triggerField) ?? decision.event.fieldName,
    triggerFieldId: optionalSnapshotString(tableSource.triggerFieldId),
    triggerValue: optionalSnapshotString(tableSource.triggerValue),
  };
  const configVersion = decision.configVersion ?? tableSource.configVersion;
  if (Number.isSafeInteger(configVersion) && configVersion > 0) table.configVersion = configVersion;
  const maxConcurrent = decision.maxConcurrent ?? tableSource.maxConcurrent;
  if (Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0) table.maxConcurrent = maxConcurrent;
  const resourceGroups = decision.resourceGroups ?? tableSource.resourceGroups;
  if (Array.isArray(resourceGroups)) table.resourceGroups = [...resourceGroups];

  const snapshot = {
    version: DECISION_SNAPSHOT_VERSION,
    action,
    kind: decision.kind,
    table,
  };
  for (const field of ["reason", "effect"]) {
    const value = optionalSnapshotString(decision[field]);
    if (value !== undefined) snapshot[field] = value;
  }
  const packageAlias = optionalSnapshotString(decision.packageAlias);
  const packageSource = optionalSnapshotString(decision.packageSource);
  const packageProjectId = optionalSnapshotString(decision.packageConfig?.projectId);
  const packageFingerprint = packageConfigFingerprint(decision.packageConfig);
  if (packageAlias !== undefined) snapshot.packageAlias = packageAlias;
  if (packageSource !== undefined) snapshot.packageSource = packageSource;
  if (packageProjectId !== undefined) snapshot.packageProjectId = packageProjectId;
  if (packageFingerprint !== undefined) snapshot.packageConfigFingerprint = packageFingerprint;
  return snapshot;
}

function snapshotPackageUnavailable() {
  const error = new Error("decision snapshot package is no longer available");
  error.code = "DECISION_SNAPSHOT_PACKAGE_UNAVAILABLE";
  error.status = 0;
  return error;
}

function decisionFromSnapshot(record, snapshot, runtimeConfig) {
  const table = {
    ...snapshot.table,
    // A frozen decision must never consult a later record field/default.
    packageField: null,
    packageFieldId: null,
    defaultPackageAlias: snapshot.packageAlias ?? null,
  };
  const decision = {
    kind: snapshot.kind,
    table,
    event: record.event,
    ...(snapshot.reason ? { reason: snapshot.reason } : {}),
    ...(snapshot.effect ? { effect: snapshot.effect } : {}),
    ...(snapshot.subjectKey ? { subjectKey: snapshot.subjectKey } : {}),
    ...(snapshot.table.subjectKey ? { subjectKey: snapshot.table.subjectKey } : {}),
    ...(snapshot.table.configVersion ? { configVersion: snapshot.table.configVersion } : {}),
    ...(snapshot.table.executionMode ? { executionMode: snapshot.table.executionMode } : {}),
    ...(snapshot.table.uploadMode ? { uploadMode: snapshot.table.uploadMode } : {}),
    ...(snapshot.table.concurrencyGroup ? { concurrencyGroup: snapshot.table.concurrencyGroup } : {}),
    ...(snapshot.table.maxConcurrent ? { maxConcurrent: snapshot.table.maxConcurrent } : {}),
    ...(snapshot.table.resourceGroups ? { resourceGroups: [...snapshot.table.resourceGroups] } : {}),
    ...(snapshot.packageAlias ? { packageAlias: snapshot.packageAlias } : {}),
    ...(snapshot.packageSource ? { packageSource: snapshot.packageSource } : {}),
  };
  if (snapshot.kind === "ready") {
    const packages = runtimeConfig?.packages
      && typeof runtimeConfig.packages === "object"
      && !Array.isArray(runtimeConfig.packages)
      ? runtimeConfig.packages
      : null;
    const packageConfig = packages
      && Object.hasOwn(packages, snapshot.packageAlias)
      ? packages[snapshot.packageAlias]
      : undefined;
    if (!packageConfig || packageConfig.projectId !== snapshot.packageProjectId
      || (snapshot.packageConfigFingerprint !== undefined
        && packageConfigFingerprint(packageConfig) !== snapshot.packageConfigFingerprint)) {
      throw snapshotPackageUnavailable();
    }
    decision.packageConfig = packageConfig;
  }
  return decision;
}

export function createBridge({
  config,
  packageCatalog = null,
  getPackageCatalog,
  getConfig,
  store,
  taskboard,
  resolveRecordTitle,
  titleLookupTimeoutMs = DEFAULT_TITLE_LOOKUP_TIMEOUT_MS,
  now = () => Date.now(),
  random = Math.random,
  ownerId = randomUUID(),
  logger = console,
  timers = globalThis,
}) {
  const inFlight = new Map();
  const localDecisionSnapshots = new Map();
  const delivery = config?.delivery ?? DEFAULT_DELIVERY_POLICY;
  async function withPackageCatalog(runtimeConfig) {
    let packages;
    if (typeof getPackageCatalog === "function") {
      packages = await getPackageCatalog();
    } else {
      packages = packageCatalog ?? runtimeConfig?.packages ?? config?.packages;
    }
    return {
      ...(runtimeConfig ?? {}),
      packages: packages ?? Object.create(null),
    };
  }
  // The production configuration is normalized by config.mjs and never
  // carries this test-only compatibility flag.  Without the dedicated
  // Taskboard provenance route, fail closed instead of creating an ordinary
  // task that could later be mistaken for an Auto-Cut task.
  const allowLegacyTaskCreation = config?.allowLegacyTaskCreation === true;

  function startLeaseHeartbeat(record) {
    const token = record.lease?.token;
    const intervalMs = Math.max(1, Math.floor(delivery.leaseMs / 3));
    let leaseUntil = Number.isFinite(record.lease?.leaseUntil) ? record.lease.leaseUntil : null;
    let stopped = false;
    let renewal = null;
    let lost = null;
    let renewalError = null;

    function assertActive() {
      if (lost) throw lost;
      if (renewalError) throw renewalError;
    }

    if (typeof store.renewLease !== "function" || !token) {
      return {
        assertActive,
        async ensureActive() {
          assertActive();
          if (leaseUntil !== null && leaseUntil <= now()) {
            lost = leaseLostError();
            throw lost;
          }
        },
        async stop() {},
      };
    }

    async function renew() {
      if (stopped || lost || renewalError) return;
      if (renewal) return renewal;
      renewal = Promise.resolve()
        .then(() => store.renewLease(record.eventId, {
          ownerId,
          token,
          now: now(),
          leaseMs: delivery.leaseMs,
          clock: now,
        }))
        .then((renewed) => {
          const nextLeaseUntil = renewed?.lease?.leaseUntil;
          leaseUntil = Number.isFinite(nextLeaseUntil)
            ? nextLeaseUntil
            : now() + delivery.leaseMs;
        })
        .catch((error) => {
          if (error?.code === "LEASE_NOT_OWNED" || error?.code === "LEASE_LOST") {
            lost = leaseLostError();
          } else {
            renewalError = error;
          }
        })
        .finally(() => {
          renewal = null;
        });
      return renewal;
    }

    const timer = timers.setInterval(() => renew(), intervalMs);
    return {
      assertActive,
      async ensureActive() {
        if (renewal) await renewal;
        assertActive();
        if (leaseUntil !== null && leaseUntil - now() <= intervalMs) {
          await renew();
        }
        assertActive();
        if (leaseUntil !== null && leaseUntil <= now()) {
          lost = leaseLostError();
          throw lost;
        }
      },
      async stop() {
        stopped = true;
        timers.clearInterval(timer);
        if (renewal) await renewal;
      },
    };
  }

  function logRecord(level, record, details = {}) {
    logDelivery(logger, level, {
      eventId: record.event?.eventId ?? record.eventId,
      tableId: record.event?.tableId ?? "unknown",
      recordId: record.event?.recordId ?? "unknown",
      deliveryState: details.deliveryState ?? record.deliveryState,
      attempts: details.attempts ?? record.attempts,
      errorCode: details.errorCode,
      taskIdentifier: details.taskIdentifier,
    });
  }

  async function persistDecisionSnapshot(record, decision, heartbeat) {
    const snapshot = buildDecisionSnapshot(decision);
    if (!snapshot) return null;
    await heartbeat.ensureActive();
    if (typeof store.saveDecisionSnapshot === "function") {
      const saved = await store.saveDecisionSnapshot(record.eventId, {
        ownerId,
        token: record.lease?.token,
        snapshot,
        now: now(),
        clock: now,
      });
      localDecisionSnapshots.set(record.eventId, saved.decisionSnapshot ?? snapshot);
      return saved.decisionSnapshot ?? snapshot;
    }
    // Historical in-memory test stores do not expose the durable method. Keep
    // a process-local copy so retries in that compatibility path are still
    // stable; production always uses JsonStateStore above.
    localDecisionSnapshots.set(record.eventId, snapshot);
    return snapshot;
  }

  async function resultAfterLeaseLoss(record) {
    if (typeof store.get !== "function") return publicPending(record);
    const current = await store.get(record.eventId);
    if (!current) return publicPending(record);
    if (current.deliveryState === "succeeded") {
      return { ...current.outcome, duplicate: true };
    }
    if (current.deliveryState === "dead_letter") return publicDeadLetter(current);
    return publicPending(current);
  }

  async function failClaim(record, error) {
    if (isLeaseLost(error)) return resultAfterLeaseLoss(record);
    const classification = classifyDeliveryError(error);
    const attempts = record.attempts;
    const timestamp = now();
    const deadLetter = !classification.retryable || attempts >= delivery.maxAttempts;
    const retryAt = deadLetter ? null : calculateNextAttemptAt({
      attempts,
      now: timestamp,
      initialDelayMs: delivery.initialDelayMs,
      maxDelayMs: delivery.maxDelayMs,
      random,
    });
    let stored;
    try {
      stored = await store.fail(record.eventId, {
        ownerId,
        token: record.lease?.token,
        error: summarizeDeliveryError(error, timestamp),
        nextAttemptAt: retryAt,
        deadLetter,
        now: timestamp,
        clock: now,
      });
    } catch (stateError) {
      if (isLeaseLost(stateError)) return resultAfterLeaseLoss(record);
      throw stateError;
    }
    if (deadLetter) {
      logRecord("error", stored, {
        deliveryState: "dead_letter",
        errorCode: classification.code,
      });
      return publicDeadLetter(stored);
    }
    logRecord("warn", stored, {
      deliveryState: "retry_wait",
      errorCode: classification.code,
    });
    return publicPending(stored);
  }

  async function deliverClaimedRecord(record) {
    const event = record.event;
    if (!event || typeof event !== "object") {
      const error = Object.assign(new Error("delivery event snapshot is missing"), {
        code: "EVENT_SNAPSHOT_MISSING",
        status: 0,
      });
      return failClaim(record, error);
    }

    let heartbeat = { assertActive() {}, async stop() {} };
    try {
      heartbeat = startLeaseHeartbeat(record);
      await heartbeat.ensureActive();
      const persistedSnapshot = record.decisionSnapshot
        ?? localDecisionSnapshots.get(record.eventId)
        ?? null;
      let runtimeConfig = await withPackageCatalog(config);
      let decision;
      if (persistedSnapshot) {
        // A retry must use the first side-effect decision. The current config
        // is consulted only to resolve the trusted executable package by its
        // frozen alias/project id; all subject routing and UI metadata come
        // from the persisted, non-executable snapshot.
        if (persistedSnapshot.kind === "ready") {
          runtimeConfig = await withPackageCatalog(typeof getConfig === "function"
            ? await getConfig()
            : config);
        }
        decision = decisionFromSnapshot(record, persistedSnapshot, runtimeConfig);
      } else {
        // New events read the active catalog once. A draft/disabled subject can
        // stop receiving new events without restarting the Bridge, while the
        // claimed event remains protected by its lease.
        runtimeConfig = await withPackageCatalog(typeof getConfig === "function"
          ? await getConfig()
          : config);
        decision = decideRecordChange(runtimeConfig, event);
        // Persist before any archive/find/create call. This also safely
        // migrates older v2 retry records that predate decision snapshots.
        if (snapshotAction(decision)) await persistDecisionSnapshot(record, decision, heartbeat);
      }
      if (decision.kind === "ignored") {
        if (decision.effect === "archive_waiting_tasks") {
          await archiveWaitingFeishuTasks(
            taskboard,
            { event, table: decision.table },
            { ensureActive: () => heartbeat.ensureActive() },
          );
        }
        await heartbeat.ensureActive();
        const outcome = { kind: "ignored", reason: decision.reason };
        await store.complete(record.eventId, {
          ownerId,
          token: record.lease?.token,
          decision: decision.kind,
          outcome,
          now: now(),
          clock: now,
        });
        localDecisionSnapshots.delete(record.eventId);
        logRecord("info", record, { deliveryState: "succeeded" });
        return outcome;
      }

      let taskDecision = decision;
      if (typeof resolveRecordTitle === "function" && !decision.event.recordTitle) {
        try {
          const recordTitle = await withTimeout(
            () => resolveRecordTitle(decision.event, decision.table),
            titleLookupTimeoutMs,
          );
          if (recordTitle) {
            taskDecision = {
              ...decision,
              event: { ...decision.event, recordTitle },
            };
          }
        } catch (error) {
          logRecord("warn", record, {
            errorCode: error?.code === "FEISHU_TITLE_LOOKUP_TIMEOUT"
              ? error.code
              : "FEISHU_TITLE_LOOKUP_FAILED",
          });
        }
      }

      await heartbeat.ensureActive();
      const payload = buildTaskPayload(taskDecision);
      await heartbeat.ensureActive();
      let task = typeof taskboard.findTaskByEventId === "function"
        ? await taskboard.findTaskByEventId(record.eventId, payload.projectId)
        : null;
      await heartbeat.ensureActive();
      if (!task && decision.kind === "ready") {
        await heartbeat.ensureActive();
        await taskboard.ensureProject({
          id: payload.projectId,
          name: decision.table.name,
          workspacePath: decision.packageConfig.workspacePath,
        });
        await heartbeat.ensureActive();
      }
      if (!task) {
        await heartbeat.ensureActive();
        if (typeof taskboard.createFeishuTask === "function") {
          task = await taskboard.createFeishuTask(payload);
        } else if (allowLegacyTaskCreation && typeof taskboard.createTask === "function") {
          // Kept only for historical unit fixtures.  The real Bridge cannot
          // reach this branch because validateConfig() drops the flag.
          task = await taskboard.createTask(payload);
        } else {
          const error = new Error("Taskboard Feishu provenance route is unavailable");
          error.code = "TASKBOARD_PROVENANCE_ROUTE_UNAVAILABLE";
          error.status = 503;
          throw error;
        }
      }
      await heartbeat.ensureActive();
      const outcome = {
        kind: decision.kind,
        ...(decision.reason ? { reason: decision.reason } : {}),
        taskId: task.id,
        taskIdentifier: task.identifier,
        ...(decision.packageAlias ? { packageAlias: decision.packageAlias } : {}),
      };
      await store.complete(record.eventId, {
        ownerId,
        token: record.lease?.token,
        decision: decision.kind,
        outcome,
        now: now(),
        clock: now,
      });
      localDecisionSnapshots.delete(record.eventId);
      logRecord("info", record, {
        deliveryState: "succeeded",
        taskIdentifier: task.identifier,
      });
      return outcome;
    } catch (error) {
      return failClaim(record, error);
    } finally {
      await heartbeat.stop();
    }
  }

  async function handleClaim(claim) {
    if (claim.kind === "terminal") {
      if (claim.record.deliveryState === "dead_letter") {
        return publicDeadLetter(claim.record, true);
      }
      return { ...claim.record.outcome, duplicate: true };
    }
    if (claim.kind === "deferred") return publicPending(claim.record);
    return deliverClaimedRecordWithEventLock(claim.record);
  }

  async function withEventLock(eventId, operation) {
    if (typeof store.withEventLock !== "function") return operation();
    return store.withEventLock(eventId, operation);
  }

  async function currentLeaseIsOwned(record) {
    if (typeof store.get !== "function") return true;
    const current = await store.get(record.eventId);
    return Boolean(
      current
      && current.deliveryState === "processing"
      && current.lease?.ownerId === ownerId
      && current.lease?.token === record.lease?.token
      && Number.isFinite(current.lease?.leaseUntil)
    );
  }

  async function deliverClaimedRecordWithEventLock(record) {
    try {
      return await withEventLock(record.eventId, async () => {
        if (!(await currentLeaseIsOwned(record))) return resultAfterLeaseLoss(record);
        return deliverClaimedRecord(record);
      });
    } catch (error) {
      if (error?.code === "STATE_LOCK_TIMEOUT" || error?.code === "EVENT_LOCK_TIMEOUT") {
        return failClaim(record, error);
      }
      throw error;
    }
  }

  async function processEvent(event) {
    const claim = await store.claimEvent(event, {
      ownerId,
      now: now(),
      leaseMs: delivery.leaseMs,
      clock: now,
    });
    return handleClaim(claim);
  }

  function trackDelivery(eventId, operation) {
    let tracked;
    tracked = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (inFlight.get(eventId) === tracked) inFlight.delete(eventId);
      });
    inFlight.set(eventId, tracked);
    return tracked;
  }

  return {
    handle(event) {
      const active = inFlight.get(event.eventId);
      if (active) return active.then((outcome) => ({ ...outcome, duplicate: true }));
      return trackDelivery(event.eventId, () => processEvent(event));
    },

    recover() {
      return store.recoverExpiredLeases({
        now: now(),
        clock: now,
        excludeEventIds: new Set(inFlight.keys()),
      });
    },

    async processDue() {
      const record = await store.claimNextDue({
        ownerId,
        now: now(),
        leaseMs: delivery.leaseMs,
        clock: now,
        excludeEventIds: new Set(inFlight.keys()),
      });
      if (!record) return null;
      return trackDelivery(record.eventId, async () => {
        if (!(await currentLeaseIsOwned(record))) return resultAfterLeaseLoss(record);
        return deliverClaimedRecordWithEventLock(record);
      });
    },

    getQueueStats() {
      return store.getQueueStats();
    },
  };
}
