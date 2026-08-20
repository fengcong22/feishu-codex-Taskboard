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
