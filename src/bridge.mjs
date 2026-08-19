import { decideRecordChange } from "./decide-event.mjs";
import { buildTaskPayload } from "./task-payload.mjs";

const DEFAULT_TITLE_LOOKUP_TIMEOUT_MS = 5000;

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

export function createBridge({
  config,
  store,
  taskboard,
  resolveRecordTitle,
  titleLookupTimeoutMs = DEFAULT_TITLE_LOOKUP_TIMEOUT_MS,
  logger = console,
}) {
  const inFlight = new Map();

  async function rememberOutcome(eventId, outcome) {
    if (typeof store.replace === "function") await store.replace(eventId, outcome);
    else await store.put(eventId, outcome);
    return outcome;
  }

  async function processEvent(event) {
    const previous = await store.get(event.eventId);
    if (previous && previous.kind !== "pending") return { ...previous, duplicate: true };

    const decision = decideRecordChange(config, event);
    if (decision.kind === "ignored") {
      const outcome = { kind: "ignored", reason: decision.reason };
      return rememberOutcome(event.eventId, outcome);
    }

    if (!previous) await store.put(event.eventId, { kind: "pending" });
    let taskDecision = decision;
    if (typeof resolveRecordTitle === "function" && !decision.event.recordTitle) {
      try {
        const recordTitle = await withTimeout(
          () => resolveRecordTitle(decision.event, decision.table),
          titleLookupTimeoutMs,
        );
        if (recordTitle) taskDecision = { ...decision, event: { ...decision.event, recordTitle } };
      } catch (error) {
        logger.warn?.(`Feishu title lookup failed for ${event.recordId}: ${error.message}`);
      }
    }
    const payload = buildTaskPayload(taskDecision);
    let task = typeof taskboard.findTaskByEventId === "function"
      ? await taskboard.findTaskByEventId(event.eventId, payload.projectId)
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
    return rememberOutcome(event.eventId, outcome);
  }

  return {
    handle(event) {
      const active = inFlight.get(event.eventId);
      if (active) return active.then((outcome) => ({ ...outcome, duplicate: true }));
      const operation = processEvent(event).finally(() => inFlight.delete(event.eventId));
      inFlight.set(event.eventId, operation);
      return operation;
    },
  };
}
