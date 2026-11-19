import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PackageWorkflowWorkspace } from "./PackageWorkflowWorkspace";
import * as api from "../api";
import type { PackageBoardResponse, Task } from "../types";
import { TaskboardLanguageProvider } from "../i18n";

vi.mock("../api", () => ({
  listFeishuPackages: vi.fn(),
  getPackageWorkflowBoard: vi.fn(),
  savePackageWorkflowBoard: vi.fn(),
}));
vi.mock("./TaskCard", () => ({
  TaskCard: ({
    task,
    onEdit,
    onComplete,
    actions,
    showWorkflowTimestamp,
  }: {
    task: Task;
    onEdit: (t: Task) => void;
    onComplete?: unknown;
    actions?: import("react").ReactNode;
    showWorkflowTimestamp?: boolean;
  }) => (
    <article className="task-card">
      <button onClick={() => onEdit(task)}>
        {task.title}
        {onComplete ? " manual acceptance" : ""}
      </button>
      {showWorkflowTimestamp && <time>{task.createdAt}</time>}
      {actions}
    </article>
  ),
}));
const subjectKey = "base:table";
const template = { id: "vm_pmo_review_video", version: 1 } as const;
const tasks = [
  {
    id: "vm-task",
    title: "VM video",
    status: "in_review",
    archivedAt: null,
    createdAt: "2026-10-19T00:00:00Z",
    feishuOrigin: {
      source: "feishu-base",
      subjectKey,
      packageAlias: "slicing",
      recordId: "record",
    },
    feishuPackageSnapshot: { workflowTemplate: template },
  },
  {
    id: "zip-task",
    title: "ZIP draft",
    status: "todo",
    archivedAt: null,
    feishuOrigin: { source: "feishu-base", subjectKey, packageAlias: "lite" },
    feishuPackageSnapshot: {
      workflowTemplate: { id: "document_draft_zip", version: 1 },
    },
  },
] as Task[];
function response(alias = "slicing"): PackageBoardResponse {
  return {
    settings: {
      subjectKey,
      packageAlias: alias,
      workflowTemplate:
        alias === "slicing"
          ? template
          : { id: "document_draft_zip", version: 1 },
      revision: 1,
      views: [
        {
          id: "all",
          name: "全部流程",
          isSystem: true,
          stageIds:
            alias === "slicing"
              ? [
                  "awaiting_feishu_review",
                  "nas_upload",
                  "completed",
                  "needs_attention",
                ]
              : ["todo"],
        },
      ],
      activeViewId: "all",
      defaultViewId: "all",
      stageDisplays: [],
    },
    status: {
      subjectKey,
      packageAlias: alias,
      tasks: [
        {
          taskId: "vm-task",
          runId: "run-vm",
          state: "completed",
          approvalStatus: "ready",
          errorCode: null,
          updatedAt: "2026-10-19T00:00:00Z",
          writeback: {
            completed: { state: "succeeded", errorCode: null, attemptCount: 0 },
            processing: null,
          },
        },
      ],
    },
  };
}
type MountActions = {
  onArchiveTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  onRestoreTask?: (task: Task) => void;
  historicalTasks?: Task[];
};

function mount(actions: MountActions = { onArchiveTask: vi.fn(), onDeleteTask: vi.fn() }) {
  return render(
    <TaskboardLanguageProvider language="zh">
      <PackageWorkflowWorkspace
        projectId="project"
        subjectKey={subjectKey}
        activePackageAlias="slicing"
        tasks={tasks}
        refreshKey={0}
        presentations={{}}
        now={Date.now()}
        availableLabels={[]}
        currentUser={{
          type: "user",
          id: "user",
          name: "User",
          avatarUrl: null,
        }}
        showCover={false}
        showBody={false}
        onOpenTask={vi.fn()}
        {...actions}
        onUpdate={vi.fn()}
        onCreateLabel={vi.fn()}
        onOpenConversation={vi.fn()}
        renderZipBoard={({ tasks: zipTasks }) => (
          <div aria-label="ZIP board">
            {zipTasks.map((t) => (
              <p key={t.id}>{t.title}</p>
            ))}
          </div>
        )}
      />
    </TaskboardLanguageProvider>,
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(api.listFeishuPackages).mockResolvedValue([
    { alias: "slicing", name: "Slicing", state: "enabled", workflowTemplate: template },
    {
      alias: "lite",
      name: "Lite",
      workflowTemplate: { id: "document_draft_zip", version: 1 },
    },
  ] as Awaited<ReturnType<typeof api.listFeishuPackages>>);
  vi.mocked(api.getPackageWorkflowBoard).mockImplementation(
    async (_key, alias) => response(alias),
  );
});
afterEach(cleanup);

it("offers archive and delete for NAS-completed cards and forwards the exact task", async () => {
  const board = response();
  board.status.tasks[0].archive = { state: "published", sourceRunId: "run-vm", errorCode: null };
  vi.mocked(api.getPackageWorkflowBoard).mockResolvedValue(board);
  const actions = { onArchiveTask: vi.fn(), onDeleteTask: vi.fn() };
  mount(actions);
  const completed = await screen.findByRole("region", { name: "已完成" });
  const archiveButton = within(completed).getByRole("button", { name: "归档任务" });
  expect(archiveButton.closest(".task-card")).toBeTruthy();
  fireEvent.click(archiveButton);
  expect(actions.onArchiveTask).toHaveBeenCalledExactlyOnceWith(tasks[0]);
  expect(actions.onDeleteTask).not.toHaveBeenCalled();
  fireEvent.click(within(completed).getByRole("button", { name: "删除任务" }));
  expect(actions.onDeleteTask).toHaveBeenCalledExactlyOnceWith(tasks[0]);
});

it("marks VM package cards with their workflow arrival timestamp", async () => {
  mount();
  await screen.findByText("VM video");
  expect(screen.getByText(tasks[0].createdAt)).toBeTruthy();
});

it("offers cleanup on a card whose run stopped before the completed column", async () => {
  // A card that stops at "awaiting Feishu review" is not in the completed
  // column, and permanent deletion requires an archived task. Without a
  // cleanup entry here it could be neither archived nor deleted.
  // Default fixture: completed run, writeback succeeded, no archive job yet —
  // which is exactly the "awaiting Feishu review" column.
  vi.mocked(api.getPackageWorkflowBoard).mockResolvedValue(response());
  const actions = { onArchiveTask: vi.fn(), onDeleteTask: vi.fn() };
  mount(actions);
  const review = await screen.findByRole("region", { name: "等待飞书审核" });
  expect(within(review).getByText("VM video")).toBeTruthy();

  const archiveButton = within(review).getByRole("button", { name: "归档任务" });
  fireEvent.click(archiveButton);
  expect(actions.onArchiveTask).toHaveBeenCalledExactlyOnceWith(tasks[0]);

  fireEvent.click(within(review).getByRole("button", { name: "删除任务" }));
  expect(actions.onDeleteTask).toHaveBeenCalledExactlyOnceWith(tasks[0]);
});

it("offers cleanup on a card stopped in the needs-attention column", async () => {
  const board = response();
  board.status.tasks[0].state = "needs_attention";
  board.status.tasks[0].errorCode = "VM_PMO_RUN_TIMEOUT";
  vi.mocked(api.getPackageWorkflowBoard).mockResolvedValue(board);
  mount({ onArchiveTask: vi.fn(), onDeleteTask: vi.fn() });
  const attention = await screen.findByRole("region", { name: "需要处理" });
  expect(within(attention).getByRole("button", { name: "归档任务" })).toBeTruthy();
  expect(within(attention).getByRole("button", { name: "删除任务" })).toBeTruthy();
});

it("shows awaiting Feishu review without a manual acceptance action and isolates package switching", async () => {
  mount();
  const review = await screen.findByRole("region", { name: "等待飞书审核" });
  expect(within(review).getByText("VM video")).toBeTruthy();
  expect(screen.queryByText(/manual acceptance/)).toBeNull();
  expect(screen.queryByText("ZIP draft")).toBeNull();
  fireEvent.change(screen.getByLabelText("剪辑包流程"), {
    target: { value: "lite" },
  });
  expect(await screen.findByText("ZIP draft")).toBeTruthy();
  expect(screen.queryByText("VM video")).toBeNull();
});

it("ignores an old package response arriving after selection changes", async () => {
  let resolveOld!: (value: PackageBoardResponse) => void;
  vi.mocked(api.getPackageWorkflowBoard).mockImplementation((_key, alias) =>
    alias === "slicing"
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve(response(alias)),
  );
  mount();
  await screen.findByRole("option", { name: "Slicing" });
  await waitFor(() => expect(resolveOld).toBeTruthy());
  fireEvent.change(screen.getByLabelText("剪辑包流程"), {
    target: { value: "lite" },
  });
  await screen.findByText("ZIP draft");
  resolveOld(response());
  await waitFor(() =>
    expect(screen.getByLabelText("剪辑包流程")).toHaveProperty("value", "lite"),
  );
  expect(screen.queryByText("VM video")).toBeNull();
});

it("saves labels and custom views only in the selected package settings", async () => {
  vi.mocked(api.savePackageWorkflowBoard).mockImplementation(
    async (settings) => ({ settings: { ...settings, revision: 2 } }),
  );
  mount();
  await screen.findByText("VM video");
  fireEvent.click(screen.getByRole("button", { name: "配置流程视图" }));
  fireEvent.change(screen.getByLabelText("等待飞书审核列名"), {
    target: { value: "待飞书反馈" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存视图配置" }));
  await waitFor(() =>
    expect(api.savePackageWorkflowBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectKey,
        packageAlias: "slicing",
        stageDisplays: expect.arrayContaining([
          expect.objectContaining({
            stageId: "awaiting_feishu_review",
            zhName: "待飞书反馈",
          }),
        ]),
      }),
    ),
  );
  expect(
    await screen.findByRole("region", { name: "待飞书反馈" }),
  ).toBeTruthy();
});

it("keeps a wrongly archived task recoverable behind a collapsed section", async () => {
  const archivedTask = {
    id: "archived-task",
    identifier: "VM-7",
    title: "误归档的第七轮",
    status: "todo",
    archivedAt: "2026-11-18T02:00:00Z",
    feishuOrigin: { source: "feishu-base", subjectKey, packageAlias: "slicing", recordId: "record-7" },
    feishuPackageSnapshot: { workflowTemplate: template },
  } as Task;
  const onRestoreTask = vi.fn();
  mount({
    onArchiveTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onRestoreTask,
    historicalTasks: [archivedTask],
  });
  const toggle = await screen.findByRole("button", { name: "已归档 (1)" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  // Collapsed by default: the board itself stays about live work.
  expect(screen.queryByText(/误归档的第七轮/)).toBeNull();

  fireEvent.click(toggle);
  const restore = await screen.findByRole("button", { name: "恢复" });
  fireEvent.click(restore);
  expect(onRestoreTask).toHaveBeenCalledExactlyOnceWith(archivedTask);
});

it("does not list archived tasks belonging to another package", async () => {
  const otherPackage = {
    id: "other-archived",
    identifier: "VM-8",
    title: "别的包的历史",
    status: "todo",
    archivedAt: "2026-11-18T02:00:00Z",
    feishuOrigin: { source: "feishu-base", subjectKey, packageAlias: "lite", recordId: "record-8" },
    feishuPackageSnapshot: { workflowTemplate: { id: "document_draft_zip", version: 1 } },
  } as Task;
  mount({
    onArchiveTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onRestoreTask: vi.fn(),
    historicalTasks: [otherPackage],
  });
  await screen.findByText("VM video");
  // Restoring must never reach another package's history, so there is no entry.
  expect(screen.queryByRole("button", { name: /已归档/ })).toBeNull();
  expect(screen.queryByText(/别的包的历史/)).toBeNull();
});

it("explains a disabled package instead of letting a restore fail after the click", async () => {
  vi.mocked(api.listFeishuPackages).mockResolvedValue([
    { alias: "slicing", name: "Slicing", state: "disabled", workflowTemplate: template },
  ] as Awaited<ReturnType<typeof api.listFeishuPackages>>);
  const archivedTask = {
    id: "archived-task",
    identifier: "VM-7",
    title: "误归档的第七轮",
    status: "todo",
    archivedAt: "2026-11-18T02:00:00Z",
    feishuOrigin: { source: "feishu-base", subjectKey, packageAlias: "slicing", recordId: "record-7" },
    feishuPackageSnapshot: { workflowTemplate: template },
  } as Task;
  const onRestoreTask = vi.fn();
  mount({
    onArchiveTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onRestoreTask,
    historicalTasks: [archivedTask],
  });
  fireEvent.click(await screen.findByRole("button", { name: "已归档 (1)" }));
  const restore = await screen.findByRole("button", { name: "恢复" });
  expect((restore as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/该剪辑包当前未启用，恢复会被拒绝/)).toBeTruthy();
  fireEvent.click(restore);
  expect(onRestoreTask).not.toHaveBeenCalled();
});
