/**
 * Archived tasks of one package, for the "误归档可自己恢复" entry.
 *
 * Archived tasks are intentionally excluded from the board columns, so a task
 * archived by a late event disappears from view entirely. This projection
 * surfaces them behind a collapsed section instead, scoped by the same subject
 * and package identity the board uses, so restoring cannot reach another
 * subject's or another package's history.
 */
export function archivedPackageTasks(tasks, { subjectKey, packageAlias } = {}, {
  search = "",
  filters = null,
  matchSearch = null,
  matchFilters = null,
  limit = 50,
} = {}) {
  // Always the same shape: callers destructure it unconditionally.
  if (typeof subjectKey !== "string" || !subjectKey
    || typeof packageAlias !== "string" || !packageAlias) return { total: 0, visible: [] };
  const scoped = (Array.isArray(tasks) ? tasks : []).filter(
    (task) =>
      task.archivedAt != null &&
      task.feishuOrigin?.source === "feishu-base" &&
      task.feishuOrigin.subjectKey === subjectKey &&
      task.feishuOrigin.packageAlias === packageAlias,
  );
  const kept = scoped.filter(
    (task) =>
      (!matchFilters || !filters || matchFilters(task, filters)) &&
      (!matchSearch || matchSearch(task, search)),
  );
  // Newest first: the task someone just archived by accident is at the top.
  kept.sort((left, right) => {
    const byArchive = String(right.archivedAt).localeCompare(String(left.archivedAt));
    if (byArchive !== 0) return byArchive;
    return String(right.id).localeCompare(String(left.id));
  });
  return { total: kept.length, visible: kept.slice(0, Math.max(0, limit)) };
}
