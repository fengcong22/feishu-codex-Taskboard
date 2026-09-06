import { parseFeishuTaskMetadata } from "./task-payload.mjs";

function sameTriggerField(metadata, table) {
  if (metadata.triggerFieldId && table.triggerFieldId) {
    return metadata.triggerFieldId === table.triggerFieldId;
  }
  return metadata.triggerField === table.triggerField;
}

export function matchesWaitingFeishuTask(task, { event, table }) {
  if (!task || task.archivedAt !== null || task.status !== "todo") return false;
  const metadata = parseFeishuTaskMetadata(task.description);
  return Boolean(metadata
    && typeof event.baseToken === "string" && event.baseToken.trim() !== ""
    && typeof metadata.baseToken === "string" && metadata.baseToken.trim() !== ""
    && metadata.baseToken === event.baseToken
    && metadata.tableId === event.tableId
    && metadata.recordId === event.recordId
    && metadata.triggerValue === table.triggerValue
    && sameTriggerField(metadata, table));
}

export function selectWaitingFeishuTasks(tasks, scope) {
  return Array.isArray(tasks)
    ? tasks.filter((task) => matchesWaitingFeishuTask(task, scope))
    : [];
}

async function fencedCall(ensureActive, operation) {
  await ensureActive();
  let result;
  let failure = null;
  try {
    result = await operation();
  } catch (error) {
    failure = error;
  }
  try {
    await ensureActive();
  } catch (error) {
    if (!failure) throw error;
  }
  if (failure) throw failure;
  return result;
}

function isNotFound(error) {
  return error?.code === "TASK_NOT_FOUND" || error?.status === 404;
}

function isVersionConflict(error) {
  return error?.code === "VERSION_CONFLICT" || error?.status === 409;
}

async function readTask(taskboard, taskId, ensureActive) {
  try {
    return await fencedCall(ensureActive, () => taskboard.getTask(taskId));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function archiveWaitingFeishuTasks(
  taskboard,
  scope,
  { ensureActive = async () => {} } = {},
) {
  const tasks = await fencedCall(
    ensureActive,
    () => taskboard.listTasks({ archived: "false" }),
  );
  const candidates = selectWaitingFeishuTasks(tasks, scope);
  let archivedCount = 0;

  for (const candidate of candidates) {
    let current = await readTask(taskboard, candidate.id, ensureActive);
    if (!current || !matchesWaitingFeishuTask(current, scope)) continue;

    try {
      await fencedCall(ensureActive, () => taskboard.archiveTask(current));
      archivedCount += 1;
      continue;
    } catch (error) {
      if (isNotFound(error)) continue;
      if (!isVersionConflict(error)) throw error;
    }

    current = await readTask(taskboard, candidate.id, ensureActive);
    if (!current || !matchesWaitingFeishuTask(current, scope)) continue;
    try {
      await fencedCall(ensureActive, () => taskboard.archiveTask(current));
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    archivedCount += 1;
  }

  return { archivedCount };
}

function trustedStageOrigin(task) {
  if (task?.feishuOrigin && typeof task.feishuOrigin === "object") return task.feishuOrigin;
  const metadata = parseFeishuTaskMetadata(task?.description);
  return metadata && typeof metadata === "object" ? metadata : null;
}

function matchesStageWaitingTask(task, scope) {
  if (!task || task.archivedAt !== null || task.status !== "todo") return false;
  const origin = trustedStageOrigin(task);
  if (!origin) return false;
  const event = scope?.event ?? {};
  return origin.baseToken === event.baseToken
    && origin.tableId === event.tableId
    && origin.recordId === event.recordId
    && (origin.statusFieldId === scope.statusFieldId || origin.triggerFieldId === scope.statusFieldId)
    && (origin.stageId === undefined || origin.stageId === scope.stageId || scope.stageId === undefined);
}

/** Archive only waiting tasks bound to one immutable phased stage identity. */
export async function archiveWaitingFeishuStageTasks(
  taskboard,
  scope,
  { ensureActive = async () => {} } = {},
) {
  const list = typeof taskboard.listFeishuTasks === "function"
    ? () => taskboard.listFeishuTasks({
      baseToken: scope.event.baseToken,
      tableId: scope.event.tableId,
      recordId: scope.event.recordId,
      statusFieldId: scope.statusFieldId,
      stageId: scope.stageId,
      archived: "false",
    })
    : () => taskboard.listTasks({ archived: "false" });
  const tasks = await fencedCall(ensureActive, list);
  let archivedCount = 0;
  for (const candidate of Array.isArray(tasks) ? tasks : []) {
    if (!matchesStageWaitingTask(candidate, scope)) continue;
    let current = candidate;
    if (typeof taskboard.getTask === "function") {
      current = await readTask(taskboard, candidate.id, ensureActive);
    }
    if (!matchesStageWaitingTask(current, scope)) continue;
    const archive = typeof taskboard.archiveFeishuTask === "function"
      ? () => taskboard.archiveFeishuTask(current)
      : () => taskboard.archiveTask(current);
    try {
      await fencedCall(ensureActive, archive);
      archivedCount += 1;
    } catch (error) {
      if (isNotFound(error)) continue;
      if (isVersionConflict(error)) {
        const refreshed = await readTask(taskboard, candidate.id, ensureActive);
        if (!matchesStageWaitingTask(refreshed, scope)) continue;
        await fencedCall(ensureActive, () => (
          typeof taskboard.archiveFeishuTask === "function"
            ? taskboard.archiveFeishuTask(refreshed)
            : taskboard.archiveTask(refreshed)
        ));
        archivedCount += 1;
        continue;
      }
      throw error;
    }
  }
  return { archivedCount };
}
