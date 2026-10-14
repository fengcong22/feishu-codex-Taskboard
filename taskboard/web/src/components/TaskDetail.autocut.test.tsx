import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TaskboardLanguageProvider } from "../i18n";
import type { ActorIdentity, FeishuAutoCutRun, Task } from "../types";
import { TaskDetail } from "./TaskDetail";

// Keep the task detail, run diagnostics and HTTP reads real;
// editor internals are unrelated to execution-state refreshes.
vi.mock("./InlineMediaComposer", async (importOriginal) => ({
  ...await importOriginal<typeof import("./InlineMediaComposer")>(),
  InlineMediaComposer: () => null,
}));
vi.mock("./DescriptionDocument", () => ({ DescriptionDocument: () => null }));

const CREATED_AT = "2026-10-14T09:00:00.000Z";
const USER: ActorIdentity = { type: "user", id: "user-1", name: "Tester", avatarUrl: null };
const TASK: Task = {
  id: "task-1", identifier: "FEI-1", projectId: "project-1", title: "Auto-Cut test",
  description: "", status: "in_progress", priority: "none", labels: ["feishu"],
  sortOrder: 0, threadId: "thread-1", threadBinding: null, legacyLocalThreadId: null,
  conversationRefs: [], participants: [], previewImage: null, activityKey: "activity-1",
  activityUpdatedAt: CREATED_AT, creatorType: "user", creatorId: USER.id,
  creatorName: USER.name, creatorAvatarUrl: null, assignee: USER, workflowId: null,
  developmentContext: null, startDate: null, dueDate: null, recurrence: null,
  source: "local", externalUrl: null, archivedAt: null,
  relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
  version: 1, createdAt: CREATED_AT, updatedAt: CREATED_AT,
  feishuOrigin: {
    version: 1, source: "feishu-base", eventId: "event-1", baseToken: "base-1",
    tableId: "table-1", recordId: "record-1", subjectKey: "base-1:table-1",
    configVersion: 1, stageId: "initial", executionMode: "automatic",
  },
};

function attempt(overrides: Partial<FeishuAutoCutRun> = {}): FeishuAutoCutRun {
  return {
    runId: "run-1", taskId: TASK.id, attempt: 1, subjectKey: "base-1:table-1",
    configVersion: 1, stageId: "initial", eventId: "event-1", manifestSha256: null,
    state: "running", errorCode: null, errorMessage: null,
    createdAt: CREATED_AT, updatedAt: CREATED_AT, ...overrides,
  };
}

function props(task: Task): ComponentProps<typeof TaskDetail> {
  return {
    task, tasks: [task], referenceTasks: [task], currentUser: USER, availableLabels: [],
    developmentScan: { workspacePath: null, contexts: [] }, developmentScanLoading: false,
    commentsRevision: 0, attachmentsRevision: 0,
    onCreateLabel: vi.fn(), onDeleteLabel: vi.fn(), onUpdate: vi.fn(),
    onOpenTask: vi.fn(), onAddRelation: vi.fn(), onRemoveRelation: vi.fn(),
    onOpenThread: vi.fn(), onOpenLegacyLocalThread: vi.fn(), onOpenInThread: vi.fn(),
    onStartCodex: vi.fn(), onCopy: vi.fn(), openingThread: false, startingCodex: false,
    onError: vi.fn(),
  };
}

function view(value: ComponentProps<typeof TaskDetail>) {
  return <TaskboardLanguageProvider language="zh"><TaskDetail {...value} /></TaskboardLanguageProvider>;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("TaskDetail Auto-Cut execution", () => {
  let runs: FeishuAutoCutRun[];
  let runReads: number;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runs = [attempt()];
    runReads = 0;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input), "http://localhost/").pathname;
      if (pathname === `/api/local/tasks/${TASK.id}/autocut-runs`) {
        runReads += 1;
        return json({ runs });
      }
      if (pathname === `/api/tasks/${TASK.id}/comments`) return json({ comments: [] });
      if (pathname === `/api/tasks/${TASK.id}/activities`) return json({ activities: [] });
      if (pathname === `/api/tasks/${TASK.id}/attachments`) return json({ attachments: [] });
      if (pathname === `/api/local/tasks/${TASK.id}/artifacts`) return json({ artifacts: [] });
      if (pathname === `/api/local/tasks/${TASK.id}/upload`) return json({ uploads: [] });
      throw new Error(`Unexpected ${init?.method ?? "GET"} ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("refreshes blocked run details when the same task changes without an attachment event", async () => {
    const initialProps = props(TASK);
    const rendered = render(view(initialProps));
    await screen.findByText("run-1");
    expect(runReads).toBe(1);
    expect(screen.queryByText("AUTOCUT_LARK_IDENTITY_UNAVAILABLE")).toBeNull();

    runs = [attempt({ state: "blocked", errorCode: "AUTOCUT_LARK_IDENTITY_UNAVAILABLE" })];
    rendered.rerender(view({
      ...initialProps,
      task: { ...TASK, status: "blocked", version: 2 },
    }));

    await waitFor(() => expect(runReads).toBe(2));
    expect(await screen.findByText("AUTOCUT_LARK_IDENTITY_UNAVAILABLE")).toBeTruthy();
    expect(screen.getByText("无法读取有效的飞书登录身份。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试 Auto-Cut" })).toBeTruthy();
  });

});
