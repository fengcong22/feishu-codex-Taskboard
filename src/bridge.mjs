import { randomUUID } from "node:crypto";

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

export function createBridge({
  config,
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
  const delivery = config?.delivery ?? DEFAULT_DELIVERY_POLICY;

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
      const decision = decideRecordChange(config, event);
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
          id: decision.packageConfig.projectId,
          name: decision.packageConfig.projectName,
          workspacePath: decision.packageConfig.workspacePath,
        });
        await heartbeat.ensureActive();
      }
      if (!task) {
        await heartbeat.ensureActive();
        task = await taskboard.createTask(payload);
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
