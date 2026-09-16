import { ApiError } from "./database.mjs";

const MAX_LAUNCH_RETRIES = 3;
const MAX_PUMP_RETRIES = 3;
const INITIAL_LAUNCH_RETRY_DELAY_MS = 1_000;

/**
 * Durable coordinator for Feishu Auto-Cut executions.
 *
 * The coordinator owns the small amount of orchestration between the visible
 * task status and the in-process resource scheduler.  The database is the
 * source of truth for delayed/queued records; an entry in `entries` is only a
 * wake-up handle and is rebuilt by recover() after a restart.
 */
export function createFeishuExecutionCoordinator({
  database,
  packageStore,
  scheduler,
  startClaimedTask,
  resolveCurrentMetadata,
  onTaskUpdated = null,
  allowAutomaticExecution = true,
  now = () => Date.now(),
  timers = globalThis,
} = {}) {
  if (
    !database
    || !packageStore
    || !scheduler
    || typeof startClaimedTask !== "function"
    || typeof resolveCurrentMetadata !== "function"
  ) {
    throw new TypeError(
      "database, packageStore, scheduler, startClaimedTask, and resolveCurrentMetadata are required",
    );
  }

  const entries = new Map();
  const backgroundLaunches = new Set();
  let closed = false;

  function clock() {
    const value = typeof now === "function" ? now() : now;
    return value instanceof Date ? value.getTime() : Number(value);
  }

  function packageAliasFor(metadata, execution) {
    return metadata?.packageAlias ?? execution?.packageAlias ?? null;
  }

  function executionModeForMetadata(metadata) {
    return metadata?.executionMode === "automatic" || metadata?.mode === "automatic"
      ? "automatic"
      : "manual";
  }

  function automaticExecutionAllowed() {
    try {
      return (typeof allowAutomaticExecution === "function"
        ? allowAutomaticExecution()
        : allowAutomaticExecution) === true;
    } catch {
      return false;
    }
  }

  function eligibleMetadata(entry, task) {
    const metadata = resolveCurrentMetadata(task, {
      trigger: entry.trigger,
      fallbackMetadata: entry.metadata,
    });
    if (!metadata) return null;
    if (entry.trigger === "automatic" && (
      !automaticExecutionAllowed()
      || Object.hasOwn(metadata, "deliverySource")
      || executionModeForMetadata(metadata) !== "automatic"
    )) {
      return null;
    }
    return metadata;
  }

  async function packageFor(alias) {
    if (!alias) return null;
    if (typeof packageStore.get === "function") return packageStore.get(alias);
    if (typeof packageStore.read === "function") {
      const catalog = await packageStore.read();
      return catalog?.[alias] ?? null;
    }
    return null;
  }

  function executionResult(taskId) {
    return {
      task: database.getTask(taskId),
      execution: database.getFeishuExecution(taskId),
    };
  }

  function updateExecution(taskId, state, patch = {}) {
    const current = database.getFeishuExecution(taskId);
    if (!current || current.state === state && Object.keys(patch).length === 0) return current;
    return database.setFeishuExecutionState(taskId, current.version, state, patch);
  }

  function updateTaskStatus(taskId, status) {
    const task = database.getTask(taskId);
    if (!task || task.status === status) return task;
    if (typeof database.transitionFeishuTaskExecution === "function") {
      const updated = database.transitionFeishuTaskExecution(taskId, task.version, status);
      onTaskUpdated?.(updated);
      return updated;
    }
    if (typeof database.setTaskStatus === "function") {
      const updated = database.setTaskStatus(taskId, status);
      onTaskUpdated?.(updated);
      return updated;
    }
    return task;
  }

  function revokeReservation(entry, lease = null) {
    if (lease) scheduler.release(lease);
    cancel(entry.task.id);
    const task = database.getTask(entry.task.id);
    if (task?.status === "queued") updateTaskStatus(task.id, "todo");
    return executionResult(entry.task.id);
  }

  function reservationIsCurrent(entry) {
    return !closed
      && entries.get(entry.task.id) === entry
      && Boolean(database.getFeishuExecution(entry.task.id));
  }

  function armPumpTimer(entry, delay) {
    if (closed || entries.get(entry.task.id) !== entry) return false;
    if (entry.timer !== null) timers.clearTimeout(entry.timer);
    entry.timer = timers.setTimeout(async () => {
      entry.timer = null;
      try {
        await pumpWithRetry(entry);
      } catch {}
    }, delay);
    return true;
  }

  function retryDelay(retryCount) {
    return Math.min(
      INITIAL_LAUNCH_RETRY_DELAY_MS * (2 ** (retryCount - 1)),
      30_000,
    );
  }

  function expediteRetry(entry, current = database.getFeishuExecution(entry.task.id)) {
    if (!current) return;
    if ((entry.pumpRetries ?? 0) < 1 && (entry.launchRetries ?? 0) < 1) return;
    if (Number(current.readyAt) <= clock()) return;
    updateExecution(entry.task.id, current.state, { readyAt: clock() });
    if (entry.timer !== null) timers.clearTimeout(entry.timer);
    entry.timer = null;
  }

  function schedulePumpRetry(entry, error) {
    if (closed || entries.get(entry.task.id) !== entry || entry.timer !== null) return false;
    if (entry.trigger === "automatic" && (
      error?.code === "AUTOMATIC_EXECUTION_DISABLED" || !automaticExecutionAllowed()
    )) {
      revokeReservation(entry);
      return false;
    }
    if ((entry.pumpRetries ?? 0) >= MAX_PUMP_RETRIES) {
      try { database.clearFeishuExecution(entry.task.id); } catch {}
      entries.delete(entry.task.id);
      return false;
    }
    const pumpRetries = (entry.pumpRetries ?? 0) + 1;
    const readyAt = clock() + retryDelay(pumpRetries);
    try {
      updateExecution(entry.task.id, "delayed", {
        readyAt,
        pumpRetries,
        lastError: error?.code ?? "EXECUTION_FAILED",
      });
      const currentTask = database.getTask(entry.task.id);
      if (currentTask?.status === "queued") updateTaskStatus(entry.task.id, "todo");
    } catch {}
    entry.pumpRetries = pumpRetries;
    entry.scheduling = true;
    return armPumpTimer(entry, readyAt - clock());
  }

  async function pumpWithRetry(entry) {
    entry.pumpAttempted = false;
    try {
      const result = await pump(entry);
      if (entry.pumpAttempted && entries.get(entry.task.id) === entry) {
        entry.pumpRetries = 0;
        const current = database.getFeishuExecution(entry.task.id);
        if (current && current.pumpRetries !== 0) {
          updateExecution(entry.task.id, current.state, { pumpRetries: 0 });
        }
      }
      return result;
    } catch (error) {
      schedulePumpRetry(entry, error);
      throw error;
    }
  }

  async function launch(entry, lease) {
    try {
      if (!reservationIsCurrent(entry)) {
        scheduler.release(lease);
        return executionResult(entry.task.id);
      }
      entry.launching = true;
      entry.leasePending = false;
      const currentTask = database.getTask(entry.task.id) ?? entry.task;
      let currentMetadata = eligibleMetadata(entry, currentTask);
      if (!currentMetadata) return revokeReservation(entry, lease);
      entry.metadata = currentMetadata;
      const alias = packageAliasFor(currentMetadata, database.getFeishuExecution(entry.task.id));
      const packageConfig = await packageFor(alias);
      if (!reservationIsCurrent(entry)) {
        scheduler.release(lease);
        return executionResult(entry.task.id);
      }
      if (entry.trigger === "automatic" && !automaticExecutionAllowed()) return revokeReservation(entry, lease);
      if (!packageConfig || (packageConfig.state && packageConfig.state !== "enabled")) {
        scheduler.release(lease);
        entry.launching = false;
        const current = database.getFeishuExecution(entry.task.id);
        if (current && current.state !== "queued") updateExecution(entry.task.id, "queued");
        if (currentTask.status !== "queued") updateTaskStatus(currentTask.id, "queued");
        armPumpTimer(entry, 1_000);
        return executionResult(entry.task.id);
      }
      const latestTask = database.getTask(entry.task.id) ?? currentTask;
      currentMetadata = eligibleMetadata(entry, latestTask);
      if (!currentMetadata) return revokeReservation(entry, lease);
      entry.task = latestTask;
      entry.metadata = currentMetadata;
      const result = await startClaimedTask(
        latestTask,
        currentMetadata,
        lease,
        entry.trigger,
        entry.actor,
        entry.autoCutRunConsent,
      );
      if (entries.get(entry.task.id) !== entry) return result ?? executionResult(entry.task.id);
      const current = database.getFeishuExecution(entry.task.id);
      if (current) {
        const patch = {
          leaseId: lease.leaseId ?? null,
          pumpRetries: 0,
          launchRetries: 0,
        };
        if (current.state !== "running"
          || current.pumpRetries !== 0
          || current.launchRetries !== 0
          || current.leaseId !== patch.leaseId) {
          updateExecution(entry.task.id, "running", patch);
        }
      }
      entries.delete(entry.task.id);
      return result ?? executionResult(entry.task.id);
    } catch (error) {
      // Cancellation can happen during any awaited preparation. A late
      // rejection belongs only to that old reservation, never a newer one.
      if (closed || entries.get(entry.task.id) !== entry) {
        scheduler.release(lease);
        throw error;
      }
      if (error?.code === "TASK_NOT_STARTABLE" || (entry.trigger === "automatic" && (
        error?.code === "AUTOMATIC_EXECUTION_DISABLED" || !automaticExecutionAllowed()
      ))) {
        revokeReservation(entry, lease);
        throw error;
      }
      scheduler.release(lease);
      if (error?.feishuAutoCutPreparationBlocked === true) {
        try { database.clearFeishuExecution(entry.task.id); } catch {}
        entries.delete(entry.task.id);
        throw error;
      }
      try {
        const current = database.getTask(entry.task.id);
        if (current && (current.status === "queued" || (current.status === "in_progress" && !current.threadId))) {
          updateTaskStatus(entry.task.id, "todo");
        }
      } catch {}
      if (!closed && (entry.launchRetries ?? 0) < MAX_LAUNCH_RETRIES) {
        const launchRetries = (entry.launchRetries ?? 0) + 1;
        const readyAt = clock() + retryDelay(launchRetries);
        entry.launchRetries = launchRetries;
        try {
          updateExecution(entry.task.id, "delayed", {
            readyAt,
            launchRetries,
            lastError: error?.code ?? "EXECUTION_FAILED",
          });
        } catch {}
        entry.launching = false;
        entry.leasePending = false;
        entry.scheduling = true;
        armPumpTimer(entry, readyAt - clock());
      } else {
        if (!closed) database.clearFeishuExecution(entry.task.id);
        entries.delete(entry.task.id);
      }
      throw error;
    }
  }

  async function pump(entry) {
    if (closed || entries.get(entry.task.id) !== entry) return executionResult(entry.task.id);
    const current = database.getFeishuExecution(entry.task.id);
    if (!current || current.state === "running") return executionResult(entry.task.id);
    if (entry.trigger === "automatic" && !automaticExecutionAllowed()) return revokeReservation(entry);
    if (entry.pumping || entry.leasePending || entry.launching) {
      return executionResult(entry.task.id);
    }
    const task = database.getTask(entry.task.id);
    if (!task || task.archivedAt !== null || !["todo", "queued"].includes(task.status)) {
      cancel(entry.task.id);
      return executionResult(entry.task.id);
    }
    const remaining = Number(current.readyAt) - clock();
    if (remaining > 0) {
      armPumpTimer(entry, remaining);
      return executionResult(entry.task.id);
    }
    const currentMetadata = eligibleMetadata(entry, task);
    if (!currentMetadata) return revokeReservation(entry);
    entry.task = task;
    entry.metadata = currentMetadata;

    if (entry.timer !== null) {
      timers.clearTimeout(entry.timer);
      entry.timer = null;
    }

    const alias = packageAliasFor(entry.metadata, current);
    entry.pumping = true;
    let packageConfig;
    try {
      packageConfig = await packageFor(alias);
      if (!reservationIsCurrent(entry)) {
        entry.pumping = false;
        return executionResult(entry.task.id);
      }
      const latestTask = database.getTask(entry.task.id) ?? task;
      const latestMetadata = eligibleMetadata(entry, latestTask);
      if (!latestMetadata || packageAliasFor(latestMetadata, current) !== alias) {
        entry.pumping = false;
        return revokeReservation(entry);
      }
      entry.task = latestTask;
      entry.metadata = latestMetadata;
    } catch (error) {
      entry.pumping = false;
      throw error;
    }
    if (!packageConfig || (packageConfig.state && packageConfig.state !== "enabled")) {
      // Keep the record durable and visible as 待处理.  A later recovery or
      // package update can call recover() to retry it.
      entry.pumping = false;
      return executionResult(entry.task.id);
    }
    const request = {
      requestId: entry.task.id,
      concurrencyGroup: `autocut:${alias}`,
      maxConcurrent: typeof entry.metadata?.stageId === "string"
        ? 1
        : Number.isSafeInteger(packageConfig.maxConcurrent) && packageConfig.maxConcurrent > 0
          ? packageConfig.maxConcurrent
          : 1,
      fixedMaxConcurrent: typeof entry.metadata?.stageId === "string",
      resourceGroups: Array.isArray(entry.metadata.resourceGroups) ? entry.metadata.resourceGroups : [],
      queuePolicy: "per-group",
    };
    let leasePromise;
    entry.pumpAttempted = true;
    entry.leasePending = true;
    entry.pumping = false;
    try {
      leasePromise = scheduler.request(request);
    } catch (error) {
      entry.leasePending = false;
      throw error;
    }
    const pending = scheduler.snapshot?.().pending?.some((item) => item.requestId === request.requestId);
    if (pending) {
      updateExecution(entry.task.id, "queued");
      updateTaskStatus(entry.task.id, "queued");
      const background = leasePromise
        .then((lease) => launch(entry, lease))
        .catch(() => {})
        .finally(() => { entry.leasePending = false; });
      backgroundLaunches.add(background);
      void background.finally(() => backgroundLaunches.delete(background)).catch(() => {});
      return executionResult(entry.task.id);
    }
    const lease = await leasePromise;
    return launch(entry, lease);
  }

  async function schedule(
    task,
    metadata,
    trigger = "manual",
    { actor = null, autoCutRunConsent = null } = {},
  ) {
    if (closed) throw new Error("Execution coordinator is closed");
    if (trigger === "automatic" && !automaticExecutionAllowed()) {
      throw new ApiError(409, "AUTOMATIC_EXECUTION_DISABLED", "Automatic Codex execution is disabled by the local policy");
    }
    if (!task?.id) throw new TypeError("task.id is required");
    const entryCandidate = { task, metadata, trigger };
    const currentTask = database.getTask(task.id) ?? task;
    const currentMetadata = eligibleMetadata(entryCandidate, currentTask);
    if (!currentMetadata) {
      cancel(task.id);
      throw new ApiError(409, "TASK_NOT_STARTABLE", "Task execution eligibility is no longer valid");
    }
    task = currentTask;
    metadata = currentMetadata;
    const existing = entries.get(task.id);
    if (existing) {
      // A drop can be delivered more than once before React has committed its
      // loading state. The first reservation is already durable, so a repeat
      // with the same trigger is an idempotent read rather than a conflict.
      if (existing.trigger === trigger) {
        expediteRetry(existing);
        return pumpWithRetry(existing);
      }
      if (trigger !== "automatic") {
        const activeExecution = database.getFeishuExecution(task.id);
        if (
          existing.launching
          || activeExecution?.state === "running"
          || activeExecution?.state === "queued"
        ) {
          throw new ApiError(409, "TASK_START_IN_PROGRESS", "Task execution is already scheduled");
        }
      }
      if (trigger !== "automatic") {
        const current = database.getFeishuExecution(task.id);
        if (current && Number(current.readyAt) > clock()) {
          updateExecution(task.id, current.state, { readyAt: clock(), trigger });
          existing.task = database.getTask(task.id) ?? task;
          existing.metadata = metadata;
          existing.trigger = trigger;
          existing.actor = actor;
          existing.autoCutRunConsent = autoCutRunConsent;
          existing.scheduling = true;
          if (existing.timer !== null) timers.clearTimeout(existing.timer);
          existing.timer = null;
          return pumpWithRetry(existing);
        }
      }
      return executionResult(task.id);
    }
    const persisted = database.getFeishuExecution(task.id);
    if (persisted?.trigger === trigger) {
      // The in-memory entry may already have been removed after launch while
      // the durable execution remains running. Reuse that reservation too.
      if (persisted.state === "running") return executionResult(task.id);
      const entry = {
        task: database.getTask(task.id) ?? task,
        metadata,
        trigger,
        actor,
        autoCutRunConsent,
        pumpRetries: persisted.pumpRetries ?? 0,
        launchRetries: persisted.launchRetries ?? 0,
        scheduling: true,
        timer: null,
      };
      entries.set(task.id, entry);
      expediteRetry(entry, persisted);
      return pumpWithRetry(entry);
    }
    const mode = metadata?.executionMode === "automatic" || metadata?.mode === "automatic"
      ? "automatic"
      : "manual";
    const readyAt = trigger === "automatic" ? clock() + 5_000 : clock();
    const snapshot = typeof database.getFeishuTaskPackageSnapshot === "function"
      ? database.getFeishuTaskPackageSnapshot(task.id)
      : null;
    database.createFeishuExecution({
      taskId: task.id,
      mode,
      readyAt,
      packageAlias: metadata?.packageAlias ?? null,
      packageRevision: metadata?.packageRevision ?? snapshot?.packageRevision ?? 1,
      trigger,
    });
    const entry = {
      task: database.getTask(task.id) ?? task,
      metadata,
      trigger,
      actor,
      autoCutRunConsent,
      scheduling: true,
      timer: null,
    };
    entries.set(task.id, entry);
    return pumpWithRetry(entry);
  }

  function cancel(taskId) {
    const entry = entries.get(taskId);
    if (entry && entry.timer !== null) timers.clearTimeout(entry.timer);
    entries.delete(taskId);
    if (typeof scheduler.cancel === "function") scheduler.cancel(taskId);
    const execution = database.getFeishuExecution(taskId);
    if (execution && execution.state !== "running") database.clearFeishuExecution(taskId);
    return Boolean(entry || execution);
  }

  function cancelPendingAutomatic() {
    const pending = new Map(database.listPendingFeishuExecutions()
      .filter((execution) => execution.trigger === "automatic")
      .map((execution) => [execution.taskId, execution]));
    for (const entry of entries.values()) {
      if (entry.trigger === "automatic" && !pending.has(entry.task.id)) {
        const execution = database.getFeishuExecution(entry.task.id);
        if (!execution || execution.state !== "running") pending.set(entry.task.id, execution);
      }
    }
    for (const taskId of pending.keys()) {
      cancel(taskId);
      if (database.getTask(taskId)?.status === "queued") updateTaskStatus(taskId, "todo");
    }
    return pending.size;
  }

  async function recover() {
    if (closed) return [];
    const restored = [];
    let firstError = null;
    for (const execution of database.listPendingFeishuExecutions()) {
      if (entries.has(execution.taskId)) continue;
      const task = database.getTask(execution.taskId);
      if (!task || task.archivedAt !== null) continue;
      const metadata = typeof database.getFeishuTaskOrigin === "function"
        ? database.getFeishuTaskOrigin(execution.taskId) ?? { packageAlias: execution.packageAlias }
        : { packageAlias: execution.packageAlias };
      const entry = {
        task,
        metadata,
        trigger: execution.trigger ?? "manual",
        actor: null,
        pumpRetries: execution.pumpRetries ?? 0,
        launchRetries: execution.launchRetries ?? 0,
        timer: null,
      };
      entries.set(task.id, entry);
      try {
        restored.push(await pumpWithRetry(entry));
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
    return restored;
  }

  async function wake(packageAlias = null) {
    for (const entry of entries.values()) {
      const alias = packageAliasFor(entry.metadata, database.getFeishuExecution(entry.task.id));
      if (packageAlias && alias !== packageAlias) continue;
      let currentMetadata = null;
      try {
        const currentTask = database.getTask(entry.task.id);
        if (currentTask) currentMetadata = eligibleMetadata(entry, currentTask);
      } catch {}
      if (currentMetadata) expediteRetry(entry);
      const config = await packageFor(alias);
      if (config?.maxConcurrent && typeof scheduler.setConcurrencyLimit === "function") {
        scheduler.setConcurrencyLimit(
          `autocut:${alias}`,
          typeof entry.metadata?.stageId === "string" ? 1 : config.maxConcurrent,
        );
      }
      if (entry.leasePending) continue;
      void pumpWithRetry(entry).catch(() => {});
    }
  }

  async function close() {
    closed = true;
    for (const entry of entries.values()) {
      if (entry.timer !== null) timers.clearTimeout(entry.timer);
      if (typeof scheduler.cancel === "function") {
        try { scheduler.cancel(entry.task.id); } catch {}
      }
    }
    entries.clear();
    if (backgroundLaunches.size > 0) await Promise.allSettled([...backgroundLaunches]);
  }

  return { schedule, cancel, cancelPendingAutomatic, recover, wake, close };
}
