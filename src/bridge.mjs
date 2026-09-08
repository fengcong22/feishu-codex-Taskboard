import { createHash, randomUUID } from "node:crypto";

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

function isPhasedSubject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && value.statusField && value.stages);
}

function eventSubjectKey(event) {
  return event?.subjectKey ?? (
    typeof event?.baseToken === "string" && typeof event?.tableId === "string"
      ? `${event.baseToken}:${event.tableId}`
      : null
  );
}

function findConfiguredSubject(config, event) {
  const candidates = [];
  if (isPhasedSubject(config)) candidates.push(config);
  for (const table of config?.tables ?? []) {
    if (isPhasedSubject(table)) candidates.push(table);
  }
  for (const base of config?.workflow?.bases ?? []) {
    for (const subject of base.subjects ?? []) {
      if (subject.lifecycle === "enabled" && isPhasedSubject(subject)) candidates.push(subject);
      else if (subject.lifecycle === "draft" && isPhasedSubject(subject.activeSnapshot)) {
        candidates.push(subject.activeSnapshot);
      }
    }
  }
  const key = eventSubjectKey(event);
  return candidates.find((subject) => (
    (!key || !subject.subjectKey || subject.subjectKey === key)
    && (!event?.baseToken || !subject.baseToken || subject.baseToken === event.baseToken)
    && (!event?.tableId || !subject.tableId || subject.tableId === event.tableId)
  )) ?? null;
}

function portablePhasedSubject(value) {
  if (!value || typeof value !== "object") return null;
  const subject = structuredClone(value);
  delete subject.packageConfig;
  for (const stage of Object.values(subject.stages ?? {})) {
    if (stage && typeof stage === "object") delete stage.artifactTargetPath;
  }
  if (subject.upload && typeof subject.upload === "object") {
    subject.upload.artifactSourcePath = null;
    subject.upload.targetPath = null;
  }
  return subject;
}

function buildPhasedDecisionSnapshot(decision, controlledContext) {
  const subject = decision.subject ?? decision.table;
  return {
    version: DECISION_SNAPSHOT_VERSION,
    action: decision.kind,
    kind: decision.kind,
    subjectKey: decision.subjectKey ?? subject?.subjectKey,
    configVersion: decision.configVersion ?? subject?.configVersion,
    stageId: decision.stageId ?? null,
    previousStageId: decision.previousStageId ?? null,
    event: structuredClone(decision.event),
    subject: portablePhasedSubject(subject),
    reason: decision.reason ?? null,
    reasonCode: decision.reasonCode ?? null,
    controlledContext: controlledContext ? structuredClone(controlledContext) : null,
  };
}

function decisionFromPhasedSnapshot(record, snapshot) {
  const subject = snapshot?.subject;
  if (!isPhasedSubject(subject)) return null;
  return {
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
    packageAlias: subject.packageRoute?.packageAlias ?? subject.defaultPackageAlias ?? null,
    executionMode: subject.execution?.mode ?? "manual",
    uploadMode: subject.upload?.enqueueMode ?? subject.execution?.enqueueMode ?? "manual",
    archiveWaiting: Boolean(snapshot.previousStageId),
  };
}

export function createBridge({
  config,
  packageCatalog = null,
  getPackageCatalog,
  getConfig,
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

  async function persistPhasedSnapshot(record, decision, controlledContext, heartbeat) {
    const snapshot = buildPhasedDecisionSnapshot(decision, controlledContext);
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

  async function resolvePhasedSubject(event, runtimeConfig) {
    const key = eventSubjectKey(event);
    if (typeof getSubjectVersion === "function" && key
      && Number.isSafeInteger(event.configVersion) && event.configVersion > 0) {
      const exact = await getSubjectVersion(key, event.configVersion);
      if (exact) return exact;
    }
    const resolver = resolveSubjectVersionAt
      ?? workflowStore?.resolveSubjectVersionAt?.bind(workflowStore)
      ?? workflowRuntime?.resolveSubjectVersionAt?.bind(workflowRuntime);
    if (typeof resolver === "function" && key) {
      const historical = await resolver(
        key,
        event.eventOccurredAtPresent ? event.eventOccurredAt : undefined,
      );
      if (historical) return historical;
    }
    return findConfiguredSubject(runtimeConfig, event);
  }

  async function readPhasedContext(subject, event) {
    const identity = {
      subjectKey: subject.subjectKey ?? eventSubjectKey(event),
      configVersion: subject.configVersion,
      baseToken: event.baseToken,
      tableId: event.tableId,
      recordId: event.recordId,
    };
    if (typeof readControlledContext === "function") {
      return readControlledContext(subject, identity);
    }
    if (controlledContextReader) {
      return readControlledRecordContext(controlledContextReader, subject, identity);
    }
    return { documentLinks: [], namingDisplayValue: "", namingValueUnique: false };
  }

  async function completePhased(record, decision, outcome, heartbeat, { requireTaskIdentifier = true } = {}) {
    await heartbeat.ensureActive();
    await store.complete(record.eventId, {
      ownerId,
      token: record.lease?.token,
      decision,
      outcome,
      requireTaskIdentifier,
      now: now(),
      clock: now,
    });
    localDecisionSnapshots.delete(record.eventId);
    return outcome;
  }

  async function deliverPhasedRecord(record, subject, heartbeat, persistedSnapshot = null) {
    const decision = persistedSnapshot
      ? decisionFromPhasedSnapshot(record, persistedSnapshot)
      : decideRecordChange(subject, record.event);
    if (!decision) {
      const error = new Error("phased decision snapshot is invalid");
      error.code = "DECISION_SNAPSHOT_INVALID";
      throw error;
    }

    if (decision.kind === "archive_waiting") {
      await archiveWaitingFeishuStageTasks(taskboard, {
        event: record.event,
        stageId: decision.stageId,
        statusFieldId: subject.statusField?.fieldId ?? record.event.statusFieldId,
      }, { ensureActive: () => heartbeat.ensureActive() });
      return completePhased(record, "ignored", {
        kind: "ignored",
        reason: decision.reason ?? "left_trigger",
      }, heartbeat, { requireTaskIdentifier: false });
    }
    if (decision.kind === "ignored") {
      // A move from an enabled stage into a disabled stage still archives the
      // old waiting task, but does not register the disabled target.
      const previous = Object.entries(subject.stages ?? {}).find(([, stage]) => (
        stage?.trigger?.optionId === record.event.beforeOptionId
      ));
      if (previous) {
        await archiveWaitingFeishuStageTasks(taskboard, {
          event: record.event,
          stageId: previous[0],
          statusFieldId: subject.statusField?.fieldId ?? record.event.statusFieldId,
        }, { ensureActive: () => heartbeat.ensureActive() });
      }
      return completePhased(record, "ignored", {
        kind: "ignored",
        reason: decision.reason,
      }, heartbeat, { requireTaskIdentifier: false });
    }
    if (decision.kind === "blocked") {
      if (!persistedSnapshot) await persistPhasedSnapshot(record, decision, null, heartbeat);
      return completePhased(record, "blocked", {
        kind: "blocked",
        reason: decision.reason,
        ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}),
      }, heartbeat, { requireTaskIdentifier: false });
    }

    const context = decision.controlledContext ?? await readPhasedContext(subject, record.event);
    if (!persistedSnapshot) await persistPhasedSnapshot(record, decision, context, heartbeat);
    if (decision.archiveWaiting) {
      await archiveWaitingFeishuStageTasks(taskboard, {
        event: record.event,
        stageId: decision.previousStageId,
        statusFieldId: subject.statusField?.fieldId ?? record.event.statusFieldId,
      }, { ensureActive: () => heartbeat.ensureActive() });
    }

    const payload = buildTrustedTaskPayload({ ...decision, event: record.event }, context);
    let task = typeof taskboard.findTaskByBinding === "function"
      ? await taskboard.findTaskByBinding(payload.binding)
      : null;
    await heartbeat.ensureActive();
    if (!task) {
      const register = taskboard.registerFeishuStageTask ?? taskboard.createFeishuTask;
      if (typeof register !== "function") {
        const error = new Error("Taskboard Feishu stage registration route is unavailable");
        error.code = "TASKBOARD_PROVENANCE_ROUTE_UNAVAILABLE";
        error.status = 503;
        throw error;
      }
      task = await register.call(taskboard, payload, { bridgeSecret });
    }
    return completePhased(record, "register", {
      kind: "register",
      taskId: task.id,
      taskIdentifier: task.identifier,
      stageId: decision.stageId,
      subjectKey: decision.subjectKey,
      configVersion: decision.configVersion,
      ...(decision.packageAlias ? { packageAlias: decision.packageAlias } : {}),
    }, heartbeat);
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
      const persistedPhased = persistedSnapshot?.subject && isPhasedSubject(persistedSnapshot.subject)
        ? persistedSnapshot
        : null;
      if (!persistedPhased) {
        runtimeConfig = await withPackageCatalog(typeof getConfig === "function"
          ? await getConfig()
          : workflowRuntime?.getConfig ? await workflowRuntime.getConfig() : config);
      }
      const phasedSubject = persistedPhased?.subject
        ?? await resolvePhasedSubject(event, runtimeConfig);
      if (isPhasedSubject(phasedSubject)) {
        return await deliverPhasedRecord(record, phasedSubject, heartbeat, persistedPhased);
      }
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
