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
}) {
  const inFlight = new Map();
  const delivery = config?.delivery ?? DEFAULT_DELIVERY_POLICY;

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

  async function failClaim(record, error) {
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
    const stored = await store.fail(record.eventId, {
      ownerId,
      error: summarizeDeliveryError(error, timestamp),
      nextAttemptAt: retryAt,
      deadLetter,
      now: timestamp,
    });
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

    try {
      const decision = decideRecordChange(config, event);
      if (decision.kind === "ignored") {
        const outcome = { kind: "ignored", reason: decision.reason };
        await store.complete(record.eventId, {
          ownerId,
          decision: decision.kind,
          outcome,
          now: now(),
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

      const payload = buildTaskPayload(taskDecision);
      let task = typeof taskboard.findTaskByEventId === "function"
        ? await taskboard.findTaskByEventId(record.eventId, payload.projectId)
        : null;
      if (!task && decision.kind === "ready") {
        await taskboard.ensureProject({
          id: decision.packageConfig.projectId,
          name: decision.packageConfig.projectName,
          workspacePath: decision.packageConfig.workspacePath,
        });
      }
      if (!task) task = await taskboard.createTask(payload);
      const outcome = {
        kind: decision.kind,
        ...(decision.reason ? { reason: decision.reason } : {}),
        taskId: task.id,
        taskIdentifier: task.identifier,
        ...(decision.packageAlias ? { packageAlias: decision.packageAlias } : {}),
      };
      await store.complete(record.eventId, {
        ownerId,
        decision: decision.kind,
        outcome,
        now: now(),
      });
      logRecord("info", record, {
        deliveryState: "succeeded",
        taskIdentifier: task.identifier,
      });
      return outcome;
    } catch (error) {
      return failClaim(record, error);
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
    return deliverClaimedRecord(claim.record);
  }

  async function processEvent(event) {
    const claim = await store.claimEvent(event, {
      ownerId,
      now: now(),
      leaseMs: delivery.leaseMs,
    });
    return handleClaim(claim);
  }

  return {
    handle(event) {
      const active = inFlight.get(event.eventId);
      if (active) return active.then((outcome) => ({ ...outcome, duplicate: true }));
      const operation = processEvent(event).finally(() => inFlight.delete(event.eventId));
      inFlight.set(event.eventId, operation);
      return operation;
    },

    recover() {
      return store.recoverExpiredLeases({ now: now() });
    },

    async processDue() {
      const record = await store.claimNextDue({
        ownerId,
        now: now(),
        leaseMs: delivery.leaseMs,
      });
      if (!record) return null;
      return deliverClaimedRecord(record);
    },

    getQueueStats() {
      return store.getQueueStats();
    },
  };
}
