import type { Task } from "../types";
import { useTaskboardI18n } from "../i18n";
import { ArchiveIcon, DeleteIcon } from "./SemanticIcons";

export function PackageWorkflowCardActions({
  task,
  onArchiveTask,
  onDeleteTask,
}: {
  task: Task;
  onArchiveTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
}) {
  const { text } = useTaskboardI18n();
  return (
    <div className="package-workflow-card-actions">
      <button
        type="button"
        aria-label={text("归档任务", "Archive task")}
        title={text("归档任务", "Archive task")}
        onClick={(event) => {
          event.stopPropagation();
          onArchiveTask(task);
        }}
      >
        <ArchiveIcon />
      </button>
      <button
        type="button"
        className="is-danger"
        aria-label={text("删除任务", "Delete task")}
        title={text("删除任务", "Delete task")}
        onClick={(event) => {
          event.stopPropagation();
          onDeleteTask(task);
        }}
      >
        <DeleteIcon />
      </button>
    </div>
  );
}
