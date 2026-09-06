import { randomUUID } from "node:crypto";

import { decideRecordChange } from "./decide-event.mjs";
import {
  calculateNextAttemptAt,
  classifyDeliveryError,
  DEFAULT_DELIVERY_POLICY,
  summarizeDeliveryError,
} from "./retry-policy.mjs";
import { logDelivery } from "./observability.mjs";
import { buildTaskPayload, buildTrustedTaskPayload } from "./task-payload.mjs";
import { archiveWaitingFeishuTasks, archiveWaitingFeishuStageTasks } from "./task-lifecycle.mjs";
import { readControlledRecordContext } from "./feishu-record-reader.mjs";

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

function isPhasedSubject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.statusField && value.stages);
}

function eventSubjectKey(event) {
  return event?.subjectKey ?? (
    typeof event?.baseToken === "string" && typeof event?.tableId === "string"
      ? `${event.baseToken}:${event.tableId}` : null
  );
}

function findConfiguredSubject(config, event) {
  const candidates = [];
  if (isPhasedSubject(config)) candidates.push(config);
  for (const table of config?.tables ?? []) if (isPhasedSubject(table)) candidates.push(table);
  for (const base of config?.workflow?.bases ?? []) {
    for (const subject of base.subjects ?? []) {
      if (subject.lifecycle === "enabled" || subject.activeSnapshot) {
        candidates.push(subject.lifecycle === "enabled" ? subject : subject.activeSnapshot);
      }
    }
  }
  const key = eventSubjectKey(event);
  return candidates.find((subject) => (
    (!key || !subject.subjectKey || subject.subjectKey === key)
    && (!event.baseToken || !subject.baseToken || subject.baseToken === event.baseToken)
    && (!event.tableId || !subject.tableId || subject.tableId === event.tableId)
  )) ?? null;
}

function phasedSnapshot(decision, context) {
  const subject = decision.subject ?? decision.table;
  const safeSubject = subject && typeof subject === "object" ? structuredClone(subject) : null;
  if (safeSubject) {
    if (safeSubject.packageConfig) delete safeSubject.packageConfig;
    if (safeSubject.stages) {
      for (const stage of Object.values(safeSubject.stages)) {
        if (stage && typeof stage === "object") delete stage.artifactTargetPath;
      }
    }
    if (safeSubject.upload) {
      delete safeSubject.upload.targetPath;
      delete safeSubject.upload.artifactSourcePath;
    }
  }
  return {
    version: 1,
    action: decision.kind,
    kind: decision.kind,
    subjectKey: decision.subjectKey ?? subject?.subjectKey,
    configVersion: decision.configVersion ?? subject?.configVersion,
    stageId: decision.stageId ?? null,
    previousStageId: decision.previousStageId ?? null,
    event: structuredClone(decision.event),
    subject: safeSubject,
    reason: decision.reason ?? null,
    reasonCode: decision.reasonCode ?? null,
    controlledContext: context ? structuredClone(context) : null,
  };
}

export function createBridge({
  config,
  workflowStore = null,
  workflowRuntime = null,
  getSubjectVersion = null,
  resolveSubjectVersionAt = null,
  readControlledContext = null,
  controlledContextReader = null,
  bridgeSecret = process.env.CODEX_FEISHU_BRIDGE_SECRET ?? null,
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

  async function resolvePhasedSubject(event) {
    const subjectKey = eventSubjectKey(event);
    if (typeof getSubjectVersion === "function" && subjectKey
      && Number.isSafeInteger(event.configVersion) && event.configVersion > 0) {
      try {
        const exact = await getSubjectVersion(subjectKey, event.configVersion);
        if (exact) return exact;
      } catch {
        return null;
      }
    }
    const resolver = resolveSubjectVersionAt
      ?? workflowStore?.resolveSubjectVersionAt?.bind(workflowStore)
      ?? workflowRuntime?.resolveSubjectVersionAt?.bind(workflowRuntime);
    if (resolver && subjectKey) {
      try {
        const resolved = await resolver(subjectKey, event.eventOccurredAtPresent ? event.eventOccurredAt : undefined);
        if (resolved) return resolved;
      } catch {
        return null;
      }
    }
    let runtimeConfig = workflowRuntime?.config ?? config;
    if (typeof workflowRuntime?.getConfig === "function") {
      try {
        runtimeConfig = await workflowRuntime.getConfig();
      } catch {
        runtimeConfig = workflowRuntime?.config ?? config;
      }
    }
    const direct = findConfiguredSubject(runtimeConfig, event);
    if (direct && isPhasedSubject(direct)) return direct;
    return null;
  }

  async function readContext(subject, event) {
    const identity = {
      subjectKey: subject.subjectKey ?? eventSubjectKey(event),
      configVersion: subject.configVersion,
      baseToken: event.baseToken,
      tableId: event.tableId,
      recordId: event.recordId,
    };
    try {
      if (typeof readControlledContext === "function") {
        return await readControlledContext(subject, identity);
      }
      if (controlledContextReader) {
        return await readControlledRecordContext(controlledContextReader, subject, identity);
      }
    } catch (error) {
      // Source cardinality and naming failures belong to a blocked Taskboard
      // attempt.  Keep a bounded empty snapshot instead of guessing or
      // dropping the trusted stage registration.
      logDelivery(logger, "warn", {
        eventId: event.eventId,
        tableId: event.tableId,
        recordId: event.recordId,
        errorCode: "CONTROLLED_CONTEXT_READ_FAILED",
      });
    }
    return { documentLinks: [], namingDisplayValue: "", namingValueUnique: false };
  }

  async function savePhasedSnapshot(record, decision, context, heartbeat) {
    const snapshot = phasedSnapshot(decision, context);
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
    localDecisionSnapshots.set(record.eventId, snapshot);
    return snapshot;
  }

  async function completeWithoutTask(record, decision, outcome, heartbeat) {
    await heartbeat.ensureActive();
    try {
      await store.complete(record.eventId, {
        ownerId,
        token: record.lease?.token,
        decision,
        outcome,
        requireTaskIdentifier: false,
        now: now(),
        clock: now,
      });
    } catch (error) {
      // Stores predating the optional requireTaskIdentifier flag may reject a
      // task-less blocked result.  Keep the delivery retryable rather than
      // fabricating a Taskboard task identity.
      if (error?.message?.includes("valid task identifiers")) throw error;
      throw error;
    }
  }

  async function deliverPhasedRecord(record, heartbeat, subject, persistedSnapshot = null) {
    let decision = persistedSnapshot
      ? decisionFromPhasedSnapshot(record, persistedSnapshot)
      : decideRecordChange(subject, record.event);
    if (!decision) {
      const error = new Error("phased decision snapshot is invalid");
      error.code = "DECISION_SNAPSHOT_INVALID";
      throw error;
    }

    if (decision.kind === "ignored" || decision.kind === "archive_waiting") {
      if (decision.kind === "archive_waiting") {
        await archiveWaitingFeishuStageTasks(taskboard, {
          event: record.event,
          stageId: decision.stageId,
          statusFieldId: subject.statusField?.fieldId ?? record.event.statusFieldId,
        }, { ensureActive: () => heartbeat.ensureActive() });
      }
      const outcome = {
        kind: "ignored",
        reason: decision.reason ?? (decision.kind === "archive_waiting" ? "left_trigger" : "ignored"),
      };
      await store.complete(record.eventId, {
        ownerId,
        token: record.lease?.token,
        decision: "ignored",
        outcome,
        now: now(),
        clock: now,
      });
      return outcome;
    }

    if (decision.kind === "blocked"
      && ["MISSING_STATUS_EDGE", "MISSING_ACTIVE_CONFIG_VERSION"].includes(decision.reasonCode)) {
      await savePhasedSnapshot(record, decision, null, heartbeat);
      const outcome = { kind: "blocked", reason: decision.reason ?? decision.reasonCode };
      // A malformed status edge must never become a Taskboard task.  Persist
      // the result when the store supports task-less blocked outcomes.
      if (typeof store.complete === "function") {
        try {
          await store.complete(record.eventId, {
            ownerId,
            token: record.lease?.token,
            decision: "blocked",
            outcome,
            requireTaskIdentifier: false,
            now: now(),
            clock: now,
          });
        } catch (error) {
          if (!error?.message?.includes("valid task identifiers")) throw error;
          return failClaim(record, Object.assign(new Error("blocked status edge"), { code: decision.reasonCode, status: 0 }));
        }
      }
      return { ...outcome, reasonCode: decision.reasonCode };
    }

    let context = decision.controlledContext;
    if (!context) context = await readContext(subject, record.event);
    if (!persistedSnapshot) await savePhasedSnapshot(record, decision, context, heartbeat);

    if (decision.archiveWaiting) {
      await archiveWaitingFeishuStageTasks(taskboard, {
        event: record.event,
        stageId: decision.previousStageId,
        statusFieldId: subject.statusField?.fieldId ?? record.event.statusFieldId,
      }, { ensureActive: () => heartbeat.ensureActive() });
    }

    await heartbeat.ensureActive();
    const payload = buildTrustedTaskPayload({ ...decision, event: record.event }, context);
    await heartbeat.ensureActive();
    let task = null;
    if (typeof taskboard.findTaskByBinding === "function") {
      task = await taskboard.findTaskByBinding(payload.binding);
    }
    if (!task) {
      const register = taskboard.registerFeishuStageTask
        ?? taskboard.createFeishuTask;
      if (typeof register !== "function") {
        const error = new Error("Taskboard Feishu provenance route is unavailable");
        error.code = "TASKBOARD_PROVENANCE_ROUTE_UNAVAILABLE";
        error.status = 503;
        throw error;
      }
      task = await register.call(taskboard, payload, { bridgeSecret });
    }
    await heartbeat.ensureActive();
    const outcome = {
      kind: "register",
      taskId: task.id,
      taskIdentifier: task.identifier,
      stageId: decision.stageId,
      subjectKey: decision.subjectKey,
      configVersion: decision.configVersion,
      ...(decision.packageAlias ? { packageAlias: decision.packageAlias } : {}),
    };
    await store.complete(record.eventId, {
      ownerId,
      token: record.lease?.token,
      decision: "register",
      outcome,
      now: now(),
      clock: now,
    });
    return outcome;
  }

  function decisionFromPhasedSnapshot(record, snapshot) {
    const subject = snapshot.subject;
    if (!isPhasedSubject(subject)) return null;
    const base = {
      kind: snapshot.kind,
      subject,
      table: subject,
      event: record.event ?? snapshot.event,
      subjectKey: snapshot.subjectKey ?? subject.subjectKey,
      configVersion: snapshot.configVersion ?? subject.configVersion,
      stageId: snapshot.stageId ?? null,
      previousStageId: snapshot.previousStageId ?? null,
      reason: snapshot.reason ?? undefined,
      reasonCode: snapshot.reasonCode ?? undefined,
      stage: snapshot.stageId ? subject.stages?.[snapshot.stageId] : undefined,
      controlledContext: snapshot.controlledContext ?? null,
    };
    if (subject.packageRoute?.packageAlias) base.packageAlias = subject.packageRoute.packageAlias;
    base.executionMode = subject.execution?.mode ?? "manual";
    base.uploadMode = subject.upload?.enqueueMode ?? subject.execution?.enqueueMode ?? "manual";
    base.archiveWaiting = Boolean(snapshot.previousStageId);
    return base;
  }

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
      const persistedPhased = record.decisionSnapshot?.subject
        && isPhasedSubject(record.decisionSnapshot.subject)
        ? record.decisionSnapshot
        : null;
      const phasedSubject = persistedPhased?.subject ?? await resolvePhasedSubject(event);
      const phasedEvent = Boolean(
        event.statusFieldId
        || Object.hasOwn(event, "beforeOptionId")
        || Object.hasOwn(event, "afterOptionId"),
      );
      if (phasedSubject && isPhasedSubject(phasedSubject)) {
        return await deliverPhasedRecord(record, heartbeat, phasedSubject, persistedPhased);
      }
      if (!phasedSubject && phasedEvent && !persistedPhased) {
        const outcome = { kind: "blocked", reason: "missing_active_config_version", reasonCode: "MISSING_ACTIVE_CONFIG_VERSION" };
        try {
          await store.complete(record.eventId, {
            ownerId,
            token: record.lease?.token,
            decision: "blocked",
            outcome,
            requireTaskIdentifier: false,
            now: now(),
            clock: now,
          });
        } catch (error) {
          if (error?.message?.includes("valid task identifiers")) return failClaim(record, Object.assign(new Error("active subject version missing"), { code: "MISSING_ACTIVE_CONFIG_VERSION" }));
          throw error;
        }
        return outcome;
      }
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
