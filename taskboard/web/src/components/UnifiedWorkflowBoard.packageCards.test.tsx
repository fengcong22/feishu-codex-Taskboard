import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UnifiedWorkflowBoard } from "./UnifiedWorkflowBoard";
import { TaskboardLanguageProvider } from "../i18n";
import type { ArtifactUploadListItem, Task } from "../types";
import type { TaskCardPresentation, TaskConversationItem } from "../taskConversations";

const subjectKey = "base:table";
const flowTime = new Date(2026, 9, 20, 9, 7).toISOString();

function makeTask(id: string, title: string): Task {
  return {
    id,
    identifier: id,
    projectId: "project",
    title,
    description: "",
    status: "done",
    priority: "none",
    labels: [],
    sortOrder: 0,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [],
    previewImage: null,
    activityKey: "",
    activityUpdatedAt: flowTime,
    creatorType: "user",
    creatorId: "user",
    creatorName: "User",
    creatorAvatarUrl: null,
    assignee: { type: "user", id: "user", name: "User", avatarUrl: null },
    workflowId: null,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    source: "local",
    externalOrigin: null,
    externalKey: null,
    externalUrl: null,
    archivedAt: null,
    relations: { parent: null, subIssues: [], blocks: [], blockedBy: [], related: [] },
    version: 1,
    createdAt: flowTime,
    updatedAt: flowTime,
    feishuOrigin: {
      source: "feishu-base",
      version: 1,
      eventId: `event-${id}`,
      baseToken: "base-token",
      tableId: "table-id",
      recordId: id,
      subjectKey,
      packageAlias: "auto-cut-lite",
    },
  };
}

const uploadedTask = makeTask("uploaded-task", "Published draft");
const editingTask = makeTask("editing-task", "Draft awaiting upload");
const conversation: TaskConversationItem = {
  key: "autocut:uploaded-task",
  projectId: "project",
  kind: "local-ai",
  title: "剪辑运行记录",
  source: "autocut",
  nativeThreadId: null,
  threadBinding: null,
  legacyLocalThreadId: null,
  aiThreadId: "thread-1",
  updatedAt: flowTime,
  currentRun: null,
  latestRun: null,
  latestTodo: null,
};
const presentations: Record<string, TaskCardPresentation> = {
  [uploadedTask.id]: {
    conversations: [conversation],
    processing: { running: false, completed: null, total: null, startedAt: null },
    unread: false,
  },
};
const uploadItems = [{
  upload: {
    id: "upload-1",
    taskId: uploadedTask.id,
    artifactId: "artifact-1",
    subjectKey,
    targetId: null,
    filename: "draft.zip",
    sha256: "abc",
    status: "uploaded",
    attemptCount: 1,
    errorCode: null,
    errorMessage: null,
    createdAt: flowTime,
    startedAt: flowTime,
    completedAt: flowTime,
    updatedAt: flowTime,
  },
  task: uploadedTask,
}] as unknown as ArtifactUploadListItem[];

afterEach(cleanup);

it("shows ZIP cleanup only after upload and places the conversation and flow time on the card", () => {
  const onArchiveTask = vi.fn();
  const onDeleteTask = vi.fn();
  render(
    <TaskboardLanguageProvider language="zh">
      <UnifiedWorkflowBoard
        projectId="project"
        subjectKey={subjectKey}
        viewId="all"
        tasks={[uploadedTask, editingTask]}
        uploadItems={uploadItems}
        artifactSummaries={[]}
        presentations={presentations}
        now={Date.now()}
        loading={false}
        uploadLoading={false}
        uploadError={null}
        hasActiveFilters={false}
        availableLabels={[]}
        currentUser={{ type: "user", id: "user", name: "User", avatarUrl: null }}
        showCover={false}
        showBody={false}
        onCreateLabel={async () => {}}
        draggedTaskId={null}
        draggedTaskHeight={0}
        movingTaskId={null}
        settlingTaskId={null}
        contextMenuTaskId={null}
        dropTarget={null}
        onOpenTask={() => {}}
        onUpdate={async (task) => task}
        onComplete={async () => {}}
        onArchiveTask={onArchiveTask}
        onDeleteTask={onDeleteTask}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onDragEnter={() => {}}
        onDrop={() => {}}
        onOpenConversation={() => {}}
      />
    </TaskboardLanguageProvider>,
  );

  const uploaded = screen.getByRole("region", { name: "已上传" });
  const publishedCard = within(uploaded).getByText("Published draft").closest(".task-card");
  if (!(publishedCard instanceof HTMLElement)) throw new Error("Expected the uploaded task card");
  expect(within(publishedCard).getByRole("button", { name: "归档任务" })).toBeTruthy();
  expect(within(publishedCard).getByRole("button", { name: "删除任务" })).toBeTruthy();
  expect(within(publishedCard).getByText("2026/10/20 09:07")).toBeTruthy();
  const conversationButton = within(publishedCard).getByRole("button", { name: "打开对话 剪辑运行记录" });
  expect(conversationButton.closest(".card-topline")).toBeTruthy();
  expect(conversationButton.closest(".card-properties")).toBeNull();

  fireEvent.click(within(publishedCard).getByRole("button", { name: "归档任务" }));
  fireEvent.click(within(publishedCard).getByRole("button", { name: "删除任务" }));
  expect(onArchiveTask).toHaveBeenCalledExactlyOnceWith(uploadedTask);
  expect(onDeleteTask).toHaveBeenCalledExactlyOnceWith(uploadedTask);

  const editing = screen.getByRole("region", { name: "已完成剪辑" });
  expect(within(editing).queryByRole("button", { name: "归档任务" })).toBeNull();
  expect(within(editing).queryByRole("button", { name: "删除任务" })).toBeNull();
});
