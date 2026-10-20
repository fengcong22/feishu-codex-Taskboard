import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  getPackageWorkflowBoard,
  listFeishuPackages,
  savePackageWorkflowBoard,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type {
  ActorIdentity,
  FeishuPackageSummary,
  PackageBoardEvidence,
  PackageBoardResponse,
  PackageBoardSettings,
  PackageBoardStage,
  Task,
  TaskDraft,
} from "../types";
import type {
  TaskCardPresentation,
  TaskConversationItem,
} from "../taskConversations";
import { TaskCard } from "./TaskCard";
import { PackageWorkflowControls } from "./PackageWorkflowControls";
import { ArchiveIcon, DeleteIcon } from "./SemanticIcons";
import {
  matchesTaskFilters,
  matchesTaskSearch,
  type TaskFilters,
} from "../taskFilters";
// @ts-expect-error Pure projection is covered by node:test.
import { packageBoardChoices, projectVmPackageBoard, scopedPackageTasks, VM_PACKAGE_COLUMNS } from "../packageWorkflowBoard.mjs";

type Choice = {
  alias: string;
  name: string;
  historical: boolean;
  workflowTemplate: { id: string; version: number } | null;
};
type Item = {
  task: Task;
  evidence: PackageBoardEvidence | null;
  stage: PackageBoardStage;
  roundCount: number;
};
export type PackageBoardScope = {
  subjectKey: string;
  packageAlias: string;
  stageIds: PackageBoardStage[];
};
type Props = {
  enabled?: boolean;
  projectId: string;
  subjectKey: string;
  activePackageAlias?: string | null;
  tasks: Task[];
  historicalTasks?: Task[];
  refreshKey: number;
  search?: string;
  filters?: TaskFilters;
  presentations: Record<string, TaskCardPresentation>;
  now: number;
  availableLabels: string[];
  currentUser: ActorIdentity;
  showCover: boolean;
  showBody: boolean;
  onOpenTask: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onCreateLabel: (label: string) => Promise<void>;
  onOpenConversation: (conversation: TaskConversationItem) => void;
  onArchiveTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  onScopeChange?: (scope: PackageBoardScope | null) => void;
  renderZipBoard: (scope: {
    tasks: Task[];
    settings: PackageBoardSettings | null;
    packageAlias: string | null;
  }) => ReactNode;
};
const ZIP_COLUMNS = [
  ["todo", "待处理", "Ready"],
  ["queued", "排队中", "Queued"],
  ["in_progress", "处理中", "Processing"],
  ["blocked", "需要处理", "Needs attention"],
  ["in_review", "待验收", "Review"],
  ["completed_editing", "已完成剪辑", "Editing complete"],
  ["upload_queue", "上传队列", "Upload queue"],
  ["uploading", "上传中", "Uploading"],
  ["uploaded", "已上传", "Uploaded"],
].map(([id, zh, en]) => ({ id: id as PackageBoardStage, zh, en }));
const EMPTY_PRESENTATION: TaskCardPresentation = {
  conversations: [],
  unread: false,
  processing: { running: false, completed: null, total: null, startedAt: null },
};
const selectionKey = (subjectKey: string) =>
  `taskboard.package-board-selection.v1.${encodeURIComponent(subjectKey)}`;
function readSelection(subjectKey: string) {
  try {
    return localStorage.getItem(selectionKey(subjectKey));
  } catch {
    return null;
  }
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function PackageWorkflowWorkspace({ enabled = true, ...props }: Props) {
  const { text, language } = useTaskboardI18n();
  const [packages, setPackages] = useState<FeishuPackageSummary[]>([]);
  const [selected, setSelected] = useState<{
    subjectKey: string;
    alias: string | null;
  }>(() => ({
    subjectKey: props.subjectKey,
    alias: readSelection(props.subjectKey) ?? props.activePackageAlias ?? null,
  }));
  const [board, setBoard] = useState<PackageBoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const choices = useMemo(
    () =>
      packageBoardChoices(
        packages,
        [...props.tasks, ...(props.historicalTasks ?? [])],
        props.activePackageAlias,
      ) as Choice[],
    [packages, props.tasks, props.historicalTasks, props.activePackageAlias],
  );
  const selectedAlias =
    selected.subjectKey === props.subjectKey &&
    choices.some((choice) => choice.alias === selected.alias)
      ? selected.alias
      : (choices.find(
          (choice) =>
            choice.alias ===
            (readSelection(props.subjectKey) ?? props.activePackageAlias),
        )?.alias ??
        choices[0]?.alias ??
        null);
  const choice = choices.find((item) => item.alias === selectedAlias);
  const scopeKey = JSON.stringify([props.subjectKey, selectedAlias]);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const currentBoard =
    board?.settings.subjectKey === props.subjectKey &&
    board.settings.packageAlias === selectedAlias
      ? board
      : null;
  const activeView = currentBoard?.settings.views.find(
    (view) => view.id === currentBoard.settings.activeViewId,
  );
  const stageIds = activeView?.stageIds ?? [];
  const isVm = choice?.workflowTemplate?.id === "vm_pmo_review_video";
  const columns = isVm
    ? (VM_PACKAGE_COLUMNS as typeof ZIP_COLUMNS)
    : ZIP_COLUMNS;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void listFeishuPackages(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPackages(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, [enabled, props.refreshKey]);
  useEffect(() => {
    props.onScopeChange?.(
      enabled && selectedAlias
        ? {
            subjectKey: props.subjectKey,
            packageAlias: selectedAlias,
            stageIds,
          }
        : null,
    );
    // Scope is derived from immutable identifiers, not the poll response identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    props.subjectKey,
    selectedAlias,
    stageIds.join(","),
    props.onScopeChange,
  ]);
  useEffect(() => {
    setShowHistory(false);
    setError(null);
    setLoading(Boolean(enabled && selectedAlias));
    if (!enabled || !selectedAlias) return;
    let disposed = false;
    let controller: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout>;
    let entering = true;
    const captured = scopeKey;
    async function refresh() {
      controller = new AbortController();
      try {
        const value = await getPackageWorkflowBoard(
          props.subjectKey,
          selectedAlias!,
          controller.signal,
        );
        if (disposed || currentScope.current !== captured) return;
        const useDefault = entering;
        entering = false;
        setBoard((previous) => {
          const sameScope =
            previous?.settings.subjectKey === value.settings.subjectKey &&
            previous.settings.packageAlias === value.settings.packageAlias;
          if (sameScope && previous.settings.revision > value.settings.revision)
            return { ...value, settings: previous.settings };
          const activeViewId = useDefault
            ? value.settings.defaultViewId
            : sameScope &&
                previous.settings.revision === value.settings.revision
              ? previous.settings.activeViewId
              : value.settings.activeViewId;
          return { ...value, settings: { ...value.settings, activeViewId } };
        });
        setError(null);
      } catch (error) {
        if (!disposed && currentScope.current === captured)
          setError(errorText(error));
      } finally {
        if (!disposed && currentScope.current === captured) {
          setLoading(false);
          timeout = setTimeout(() => void refresh(), 5000);
        }
      }
    }
    void refresh();
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timeout);
    };
  }, [enabled, scopeKey, reload]);
  async function save(settings: PackageBoardSettings) {
    const captured = scopeKey;
    const result = await savePackageWorkflowBoard(settings);
    if (currentScope.current !== captured) return;
    setBoard((previous) =>
      previous ? { ...previous, settings: result.settings } : previous,
    );
  }
  if (!enabled)
    return props.renderZipBoard({
      tasks: props.tasks,
      settings: null,
      packageAlias: null,
    });
  const scopedTasks = selectedAlias
    ? (scopedPackageTasks(props.tasks, {
        subjectKey: props.subjectKey,
        packageAlias: selectedAlias,
      }) as Task[])
    : [];
  const projection = projectVmPackageBoard(props.tasks, currentBoard?.status, {
    subjectKey: props.subjectKey,
    packageAlias: selectedAlias,
  }) as { groups: Record<string, Item[]>; history: Item[] };
  const matches = (item: Item) =>
    (!props.filters || matchesTaskFilters(item.task, props.filters)) &&
    matchesTaskSearch(item.task, props.search ?? "", language);
  for (const stage of Object.keys(projection.groups))
    projection.groups[stage] = projection.groups[stage].filter(matches);
  projection.history = projection.history.filter(matches);
  function columnName(id: PackageBoardStage) {
    const defaults = columns.find((column) => column.id === id);
    const override = currentBoard?.settings.stageDisplays.find(
      (display) => display.stageId === id,
    );
    return text(
      override?.zhName ?? defaults?.zh ?? id,
      override?.enName ?? defaults?.en ?? id,
    );
  }
  return (
    <section
      className="package-workflow-workspace"
      aria-label={text("剪辑包独立流程", "Package workflow")}
    >
      <div className="package-workflow-toolbar">
        <label>
          {text("剪辑包流程", "Package workflow")}
          <select
            aria-label={text("剪辑包流程", "Package workflow")}
            value={selectedAlias ?? ""}
            onChange={(event) => {
              const alias = event.target.value;
              setSelected({ subjectKey: props.subjectKey, alias });
              try {
                localStorage.setItem(selectionKey(props.subjectKey), alias);
              } catch {
                /* browser storage optional */
              }
            }}
          >
            {choices.map((item) => (
              <option key={item.alias} value={item.alias}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <span className="package-workflow-automatic-note">
          {text("当前生效包：", "Active package: ")}
          {choices.find((item) => item.alias === props.activePackageAlias)?.name ?? props.activePackageAlias ?? text("未启用", "None")}
          {choice?.historical ? text(" · 正在查看历史包", " · Viewing historical package") : ""}
        </span>
        {currentBoard && (
          <PackageWorkflowControls
            key={scopeKey}
            settings={currentBoard.settings}
            columns={columns}
            onSave={save}
          />
        )}
        {isVm && (
          <span className="package-workflow-automatic-note">
            {text(
              "飞书字段自动驱动 · NAS 交付后完成",
              "Driven by Feishu · complete after NAS delivery",
            )}
          </span>
        )}
      </div>
      {error && (
        <div role="alert" className="package-workflow-error">
          {error}
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            {text("重新加载", "Reload")}
          </button>
        </div>
      )}
      {loading && !currentBoard ? (
        <p aria-busy="true">
          {text("正在加载本包流程…", "Loading package workflow…")}
        </p>
      ) : !currentBoard ? null : !isVm ? (
        props.renderZipBoard({
          tasks: scopedTasks,
          settings: currentBoard.settings,
          packageAlias: selectedAlias,
        })
      ) : (
        <section
          className="unified-workflow-board"
          aria-label={text("MP4 自动流程看板", "MP4 automatic workflow board")}
        >
          {Object.entries(projection.groups).some(
            ([stage, items]) =>
              !stageIds.includes(stage as PackageBoardStage) &&
              items.length > 0,
          ) && (
            <p className="package-workflow-hidden-summary">
              {text(
                "其他流程列还有任务，可切换“全部流程”查看。",
                "More tasks are in hidden stages. Select All stages to view them.",
              )}
            </p>
          )}
          <div className="unified-workflow-board-scroll">
            <div
              className="unified-workflow-board-grid"
              style={
                { "--unified-stage-count": stageIds.length } as CSSProperties
              }
            >
              {stageIds.map((stage) => (
                <section
                  key={stage}
                  role="region"
                  aria-label={columnName(stage)}
                  className="unified-workflow-column"
                >
                  <header className="unified-workflow-column-header">
                    <h2>{columnName(stage)}</h2>
                    <span>{projection.groups[stage]?.length ?? 0}</span>
                  </header>
                  <div className="unified-workflow-column-list">
                    {(projection.groups[stage] ?? []).map((item) => {
                      const presentation =
                        props.presentations[item.task.id] ?? EMPTY_PRESENTATION;
                      return (
                        <div
                          className="unified-workflow-item"
                          key={item.task.id}
                        >
                          <TaskCard
                            task={item.task}
                            presentation={presentation}
                            now={props.now}
                            isDragging={false}
                            dragShift={0}
                            isMoving={false}
                            isSettling={false}
                            isContextMenuOpen={false}
                            dragEnabled={false}
                            availableLabels={props.availableLabels}
                            currentUser={props.currentUser}
                            showCover={props.showCover}
                            showBody={props.showBody}
                            onCreateLabel={props.onCreateLabel}
                            onEdit={props.onOpenTask}
                            onUpdate={props.onUpdate}
                            onContextMenu={() => {}}
                            onDragStart={() => {}}
                            onDragEnd={() => {}}
                            onOpenConversation={props.onOpenConversation}
                            actions={stage === "completed" ? (
                              <div className="package-workflow-card-actions">
                                <button
                                  type="button"
                                  aria-label={text("归档任务", "Archive task")}
                                  title={text("归档任务", "Archive task")}
                                  onClick={() => props.onArchiveTask(item.task)}
                                >
                                  <ArchiveIcon />
                                </button>
                                <button
                                  type="button"
                                  className="is-danger"
                                  aria-label={text("删除任务", "Delete task")}
                                  title={text("删除任务", "Delete task")}
                                  onClick={() => props.onDeleteTask(item.task)}
                                >
                                  <DeleteIcon />
                                </button>
                              </div>
                            ) : null}
                          />
                          <div className="package-workflow-card-evidence">
                            {item.evidence?.approvalStatus &&
                            ["materials", "needs_attention"].includes(stage) ? (
                              <span>
                                {text("审批／下载状态", "Approval / download")}:{" "}
                                {approvalName(
                                  item.evidence.approvalStatus,
                                  text,
                                )}
                              </span>
                            ) : null}
                            {item.roundCount > 1 && (
                              <span>
                                {text(
                                  `累计 ${item.roundCount} 轮交付任务`,
                                  `${item.roundCount} delivery rounds`,
                                )}
                              </span>
                            )}
                            {(item.evidence?.archive?.errorCode ??
                              item.evidence?.errorCode ??
                              item.evidence?.writeback?.completed
                                ?.errorCode) && (
                              <code>
                                {item.evidence?.archive?.errorCode ??
                                  item.evidence?.errorCode ??
                                  item.evidence?.writeback?.completed
                                    ?.errorCode}
                              </code>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
          {projection.history.length > 0 && (
            <div className="package-workflow-history">
              <button
                type="button"
                aria-expanded={showHistory}
                onClick={() => setShowHistory((value) => !value)}
              >
                {text(
                  `历史轮次 (${projection.history.length})`,
                  `Previous rounds (${projection.history.length})`,
                )}
              </button>
              {showHistory &&
                projection.history.map((item) => (
                  <button
                    key={item.task.id}
                    type="button"
                    onClick={() => props.onOpenTask(item.task)}
                  >
                    {item.task.identifier} · {item.task.title}
                  </button>
                ))}
            </div>
          )}
        </section>
      )}
    </section>
  );
}

function approvalName(value: string, text: (zh: string, en: string) => string) {
  const names: Record<string, [string, string]> = {
    reserved: ["准备申请", "Preparing request"],
    submitting: ["正在申请", "Submitting request"],
    reconciling: ["核对申请状态", "Checking request"],
    waiting_approval: ["等待审批", "Awaiting approval"],
    waiting_media: ["等待下载资源", "Awaiting download resource"],
    acquiring: ["正在下载", "Downloading"],
    auth_required: ["需要重新连接账号", "Reconnect account"],
    needs_attention: ["需要处理", "Needs attention"],
    dead_letter: ["申请重试已用尽", "Request retries exhausted"],
    retry_wait: ["等待重试", "Waiting to retry"],
    pending: ["等待申请", "Pending request"],
    queued: ["等待申请", "Pending request"],
    submitted: ["等待审批", "Awaiting approval"],
    pending_approval: ["等待审批", "Awaiting approval"],
    approved: ["已批准，准备下载", "Approved, preparing download"],
    downloading: ["正在下载", "Downloading"],
    ready: ["素材已就绪", "Materials ready"],
    rejected: ["审批拒绝", "Rejected"],
    canceled: ["审批已撤回", "Canceled"],
  };
  return names[value] ? text(...names[value]) : value;
}
