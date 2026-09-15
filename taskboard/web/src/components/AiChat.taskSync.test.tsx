import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskboardStorage } from "../storage";
import { taskCardPresentation } from "../taskConversations";
import type { ActorIdentity, AiChatThread, AiChatThreadSnapshot, Task } from "../types";
import { AiChat, type AiChatOpenThreadRequest } from "./AiChat";
import { TaskCard } from "./TaskCard";

const api = vi.hoisted(() => ({
  listThreads: vi.fn(),
  getThread: vi.fn(),
  subscribeThread: vi.fn(),
  getCatalog: vi.fn(),
  createThread: vi.fn(),
  startTurn: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  listAiChatThreads: api.listThreads,
  getAiChatThread: api.getThread,
  subscribeAiChatThread: api.subscribeThread,
  getAiChatCatalog: api.getCatalog,
  createAiChatThread: api.createThread,
  startAiChatTurn: api.startTurn,
}));

const STARTED_AT = "2026-09-15T03:00:00.000Z";
const NOW = Date.parse(STARTED_AT) + 5_000;
const TASK_THREAD_ID = "task-execution-thread";
const EMPTY_IDS: string[] = [];
const USER: ActorIdentity = { type: "user", id: "user-1", name: "Tester", avatarUrl: null };
const TASK: Task = {
  id: "task-1",
  identifier: "LOCAL-1",
  projectId: "project-1",
  title: "Render the example video",
  description: "",
  status: "in_progress",
  priority: "none",
  labels: [],
  sortOrder: 0,
  threadId: TASK_THREAD_ID,
  threadBinding: null,
  legacyLocalThreadId: null,
  conversationRefs: [],
  participants: [],
  previewImage: null,
  activityKey: "activity-1",
  activityUpdatedAt: STARTED_AT,
  creatorType: "user",
  creatorId: USER.id,
  creatorName: USER.name,
  creatorAvatarUrl: null,
  assignee: USER,
  workflowId: null,
  developmentContext: null,
  startDate: null,
  dueDate: null,
  recurrence: null,
  source: "local",
  externalUrl: null,
  archivedAt: null,
  relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
  version: 1,
  createdAt: STARTED_AT,
  updatedAt: STARTED_AT,
};

function thread(id = TASK_THREAD_ID, overrides: Partial<AiChatThread> = {}): AiChatThread {
  return {
    id,
    title: id === TASK_THREAD_ID ? "Task execution" : "My existing conversation",
    status: "idle",
    origin: {
      projectId: TASK.projectId,
      projectName: "Example project",
      workspacePath: "D:/example-project",
      ...(id === TASK_THREAD_ID ? { issueId: TASK.id, issueIdentifier: TASK.identifier } : {}),
    },
    codexThreadId: `native-${id}`,
    model: "test-model",
    reasoningEffort: "medium",
    sandbox: "workspace-write",
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    currentRun: null,
    latestTodo: null,
    ...overrides,
  };
}

function runningThread(): AiChatThread {
  return thread(TASK_THREAD_ID, {
    status: "running",
    updatedAt: new Date(NOW).toISOString(),
    currentRun: { id: "run-1", threadId: TASK_THREAD_ID, status: "running", startedAt: STARTED_AT },
    latestTodo: { completed: 1, total: 3, eventId: "progress-1", updatedAt: new Date(NOW).toISOString() },
  });
}

function snapshot(value: AiChatThread): AiChatThreadSnapshot {
  return { thread: value, events: [], runs: value.currentRun ? [value.currentRun] : [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type Hint = (type: "ai.event" | "ai.run") => void;
const subscribers = new Map<string, Set<Hint>>();
const snapshots = new Map<string, AiChatThreadSnapshot>();

function Harness({
  taskThreadIds = EMPTY_IDS,
  now = NOW,
  available = true,
  observeThreads,
}: {
  taskThreadIds?: string[];
  now?: number;
  available?: boolean;
  observeThreads?: (threads: AiChatThread[]) => void;
}) {
  const [threads, setThreads] = useState<AiChatThread[]>([]);
  const [openThreadRequest, setOpenThreadRequest] = useState<AiChatOpenThreadRequest | null>(null);
  const onThreadsChange = useCallback((next: AiChatThread[]) => {
    setThreads(next);
    observeThreads?.(next);
  }, [observeThreads]);
  return (
    <>
      <AiChat
        available={available}
        projectId={TASK.projectId}
        issueId={null}
        codexProjectIdentity={null}
        taskThreadIds={taskThreadIds}
        onThreadsChange={onThreadsChange}
        openThreadRequest={openThreadRequest}
        onOpenThreadRequestHandled={() => setOpenThreadRequest(null)}
      />
      <TaskCard
        task={TASK}
        presentation={taskCardPresentation(TASK, threads, false)}
        now={now}
        isDragging={false}
        dragShift={0}
        isMoving={false}
        isSettling={false}
        isContextMenuOpen={false}
        availableLabels={[]}
        currentUser={USER}
        showCover={false}
        showBody={false}
        onCreateLabel={async () => {}}
        onEdit={() => {}}
        onUpdate={async () => TASK}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onOpenConversation={(conversation) => {
          if (conversation.aiThreadId) setOpenThreadRequest({ threadId: conversation.aiThreadId, requestId: 1 });
        }}
      />
    </>
  );
}

async function settle() {
  await act(async () => { await Promise.resolve(); });
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

async function emitRunHint(threadId: string) {
  const callbacks = subscribers.get(threadId);
  expect(callbacks?.size ?? 0, `Expected a live subscription for ${threadId}`).toBeGreaterThan(0);
  await act(async () => {
    for (const callback of callbacks!) callback("ai.run");
  });
}

describe("AiChat task execution synchronization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetAllMocks();
    subscribers.clear();
    snapshots.clear();
    for (const key of ["taskboard.aiChat.lastThreadId", "taskboard.aiChat.panelView", "taskboard.aiChat.panelGeometry"]) {
      taskboardStorage.removeItem(key);
    }
    api.listThreads.mockResolvedValue([]);
    api.getCatalog.mockResolvedValue({ models: [], skills: [], sandboxes: ["workspace-write"] });
    api.getThread.mockImplementation(async (id: string) => {
      const value = snapshots.get(id);
      if (!value) throw new Error(`No snapshot fixture for ${id}`);
      return value;
    });
    api.subscribeThread.mockImplementation((id: string, callback: Hint) => {
      const callbacks = subscribers.get(id) ?? new Set<Hint>();
      callbacks.add(callback);
      subscribers.set(id, callbacks);
      return vi.fn(() => callbacks.delete(callback));
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("discovers a task thread created after its binding arrives without remounting or opening chat", async () => {
    const view = render(<Harness />);
    await settle();
    expect(api.listThreads).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Waiting for Codex...")).toBeTruthy();

    view.rerender(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();
    expect(api.listThreads).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Waiting for Codex...")).toBeTruthy();

    const running = runningThread();
    snapshots.set(running.id, snapshot(running));
    api.listThreads.mockResolvedValue([running]);
    await advance(2_000);

    expect(screen.getByText("Processing for 5s...")).toBeTruthy();
    expect(screen.getByLabelText("Processing progress 1/3")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Codex AI chat" })).toBeNull();
    expect(taskboardStorage.getItem("taskboard.aiChat.lastThreadId")).toBeNull();
    view.rerender(<Harness taskThreadIds={[TASK_THREAD_ID]} now={NOW + 1_000} />);
    expect(screen.getByText("Processing for 6s...")).toBeTruthy();

    const callsAfterDiscovery = api.listThreads.mock.calls.length;
    await advance(6_000);
    expect(api.listThreads).toHaveBeenCalledTimes(callsAfterDiscovery);
  });

  it("subscribes to an initially idle task thread and renders its later running snapshot", async () => {
    const selected = thread("personal-thread");
    const idle = thread();
    snapshots.set(selected.id, snapshot(selected));
    snapshots.set(idle.id, snapshot(idle));
    api.listThreads.mockResolvedValue([selected, idle]);
    render(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();
    expect(screen.getByText("Paused · open the conversation")).toBeTruthy();

    snapshots.set(TASK_THREAD_ID, snapshot(runningThread()));
    await emitRunHint(TASK_THREAD_ID);

    expect(screen.getByText("Processing for 5s...")).toBeTruthy();
    expect(screen.getByLabelText("Processing progress 1/3")).toBeTruthy();
    expect(taskboardStorage.getItem("taskboard.aiChat.lastThreadId")).toBe(selected.id);
    expect(screen.queryByRole("region", { name: "Codex AI chat" })).toBeNull();
  });

  it("preserves the selected conversation and draft while discovering an idle task thread", async () => {
    const selected = thread("personal-thread");
    snapshots.set(selected.id, snapshot(selected));
    api.listThreads.mockResolvedValue([selected]);
    const view = render(<Harness />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open AI chat" }));
    const panel = screen.getByRole("region", { name: "Codex AI chat" });
    const editor = within(panel).getByRole("textbox", { name: "Message to Codex" });
    editor.textContent = "Keep my unsent draft";
    fireEvent.input(editor);

    api.listThreads.mockResolvedValue([thread(), selected]);
    view.rerender(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();

    expect(screen.getByText("Paused · open the conversation")).toBeTruthy();
    expect(within(panel).getByText(selected.title)).toBeTruthy();
    expect(editor.textContent).toBe("Keep my unsent draft");
    expect(taskboardStorage.getItem("taskboard.aiChat.lastThreadId")).toBe(selected.id);
    snapshots.set(TASK_THREAD_ID, snapshot(runningThread()));
    await emitRunHint(TASK_THREAD_ID);
    expect(screen.getByText("Processing for 5s...")).toBeTruthy();
    expect(within(panel).getByText(selected.title)).toBeTruthy();
    expect(editor.textContent).toBe("Keep my unsent draft");
  });

  it("retries missing and failed discovery every two seconds without overlapping requests", async () => {
    const pending = deferred<AiChatThread[]>();
    const view = render(<Harness />);
    await settle();
    api.listThreads.mockReturnValueOnce(pending.promise);
    view.rerender(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();
    expect(api.listThreads).toHaveBeenCalledTimes(2);
    await advance(6_000);
    expect(api.listThreads).toHaveBeenCalledTimes(2);

    await act(async () => pending.reject(new Error("Temporary discovery outage")));
    await advance(1_999);
    expect(api.listThreads).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(api.listThreads).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Waiting for Codex...")).toBeTruthy();
    expect(screen.queryByText("Temporary discovery outage")).toBeNull();

    snapshots.set(TASK_THREAD_ID, snapshot(runningThread()));
    api.listThreads.mockResolvedValue([runningThread()]);
    await advance(2_000);
    expect(screen.getByText("Processing for 5s...")).toBeTruthy();
    expect(api.listThreads).toHaveBeenCalledTimes(4);
  });

  it.each(["scope removal", "unmount", "unavailable"] as const)(
    "aborts pending discovery and ignores a late response after %s",
    async (cleanupKind) => {
      const pending = deferred<AiChatThread[]>();
      const observeThreads = vi.fn();
      const view = render(<Harness observeThreads={observeThreads} />);
      await settle();
      api.listThreads.mockReturnValueOnce(pending.promise);
      view.rerender(<Harness taskThreadIds={[TASK_THREAD_ID]} observeThreads={observeThreads} />);
      await settle();
      expect(api.listThreads).toHaveBeenCalledTimes(2);
      const signal = api.listThreads.mock.calls.at(-1)?.[0] as AbortSignal;
      expect(signal).toBeInstanceOf(AbortSignal);

      if (cleanupKind === "unmount") view.unmount();
      else view.rerender(<Harness available={cleanupKind !== "unavailable"} observeThreads={observeThreads} />);
      expect(signal.aborted).toBe(true);
      const notificationsAfterCleanup = observeThreads.mock.calls.length;
      await act(async () => pending.resolve([runningThread()]));
      await advance(6_000);

      expect(api.listThreads).toHaveBeenCalledTimes(2);
      expect(observeThreads).toHaveBeenCalledTimes(notificationsAfterCleanup);
      expect(subscribers.get(TASK_THREAD_ID)?.size ?? 0).toBe(0);
      expect(screen.queryByText("Processing for 5s...")).toBeNull();
    },
  );

  it("cancels the retry timer when active task bindings are removed", async () => {
    const view = render(<Harness />);
    await settle();
    view.rerender(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();
    expect(api.listThreads).toHaveBeenCalledTimes(2);
    view.rerender(<Harness />);
    await advance(6_000);
    expect(api.listThreads).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "older idle"] as const)(
    "keeps a discovered running thread when the delayed initial list is %s",
    async (initialResult) => {
      const initial = deferred<AiChatThread[]>();
      api.listThreads.mockReturnValueOnce(initial.promise).mockResolvedValue([thread()]);
      const observeThreads = vi.fn();
      render(<Harness taskThreadIds={[TASK_THREAD_ID]} observeThreads={observeThreads} />);
      await settle();
      expect(screen.getByText("Paused · open the conversation")).toBeTruthy();
      snapshots.set(TASK_THREAD_ID, snapshot(runningThread()));
      await emitRunHint(TASK_THREAD_ID);
      expect(screen.getByText("Processing for 5s...")).toBeTruthy();

      await act(async () => initial.resolve(initialResult === "missing" ? [] : [thread()]));

      expect(screen.getByText("Processing for 5s...")).toBeTruthy();
      expect(screen.getByLabelText("Processing progress 1/3")).toBeTruthy();
      const observed = observeThreads.mock.calls.at(-1)?.[0] as AiChatThread[];
      expect(observed.find((value) => value.id === TASK_THREAD_ID)?.status).toBe("running");
    },
  );

  it("keeps a discovered conversation opened by the user when an older initial list returns", async () => {
    const initial = deferred<AiChatThread[]>();
    api.listThreads.mockReturnValueOnce(initial.promise).mockResolvedValue([runningThread()]);
    snapshots.set(TASK_THREAD_ID, snapshot(runningThread()));
    render(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open conversation Task execution" }));
    await settle();
    const panel = screen.getByRole("region", { name: "Codex AI chat" });
    const editor = within(panel).getByRole("textbox", { name: "Message to Codex" });
    editor.textContent = "Keep this task draft";
    fireEvent.input(editor);

    await act(async () => initial.resolve([]));

    expect(taskboardStorage.getItem("taskboard.aiChat.lastThreadId")).toBe(TASK_THREAD_ID);
    expect(within(panel).getByText("Task execution")).toBeTruthy();
    expect(editor.textContent).toBe("Keep this task draft");
  });

  it.each([
    ["completed", "Auto-Cut completed"],
    ["failed", "Auto-Cut failed"],
    ["interrupted", "Auto-Cut interrupted"],
  ] as const)("shows a truthful read-only summary for a local %s run with no events", async (status, label) => {
    const local = thread(TASK_THREAD_ID, { model: "local-autocut", codexThreadId: null });
    snapshots.set(local.id, {
      thread: local,
      events: [],
      runs: [{ id: "local-run", threadId: local.id, status, startedAt: STARTED_AT, finishedAt: new Date(NOW).toISOString(),
        ...(status === "failed" ? { error: "Auto-Cut preflight timed out" } : {}) }],
    });
    api.listThreads.mockResolvedValue([local]);
    render(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open AI chat" }));
    const panel = screen.getByRole("region", { name: "Auto-Cut execution" });
    expect(within(panel).getByText(label)).toBeTruthy();
    expect(within(panel).queryByText("Codex is working")).toBeNull();
    expect(within(panel).queryByRole("textbox", { name: "Message to Codex" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Send message" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Stop generating" })).toBeNull();
    expect(within(panel).queryByText("local-autocut")).toBeNull();
    if (status === "failed") expect(within(panel).getByText("Auto-Cut preflight timed out")).toBeTruthy();
  });

  it("refreshes the selected running local execution when its terminal event is missed", async () => {
    const running = { ...runningThread(), model: "local-autocut", codexThreadId: null };
    snapshots.set(running.id, snapshot(running));
    api.listThreads.mockResolvedValue([running]);
    render(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open AI chat" }));
    expect(screen.getByText("Auto-Cut is working")).toBeTruthy();
    const completedRun = { ...running.currentRun!, status: "completed" as const, finishedAt: new Date(NOW + 1_000).toISOString() };
    snapshots.set(running.id, {
      thread: { ...running, status: "idle", currentRun: null },
      events: [],
      runs: [completedRun],
    });
    await advance(2_000);
    expect(screen.getByText("Auto-Cut completed")).toBeTruthy();
    expect(screen.queryByText("Auto-Cut is working")).toBeNull();
    const requestsAfterCompletion = api.getThread.mock.calls.length;
    await advance(6_000);
    expect(api.getThread).toHaveBeenCalledTimes(requestsAfterCompletion);
  });

  it("renders controlled Auto-Cut phase events without presenting reasoning", async () => {
    const local = thread(TASK_THREAD_ID, { model: "local-autocut", codexThreadId: null });
    snapshots.set(local.id, {
      thread: local,
      runs: [{ id: "local-run", threadId: local.id, status: "completed" }],
      events: [{
        id: "phase-1", runId: "local-run", type: "autocut_progress", role: "activity",
        content: "素材下载已完成", data: { phase: "download", status: "complete" },
      }],
    });
    api.listThreads.mockResolvedValue([local]);
    render(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open AI chat" }));
    const timeline = screen.getByRole("list", { name: "Auto-Cut progress" });
    expect(within(timeline).getByText("素材下载已完成")).toBeTruthy();
    expect(screen.queryByText(/Thought|Thinking/)).toBeNull();
    expect(screen.getByText("Auto-Cut completed")).toBeTruthy();
  });

  it("ignores a late running snapshot after switching to a completed local execution", async () => {
    const first = { ...runningThread(), model: "local-autocut", codexThreadId: null };
    const second = thread("completed-local", { model: "local-autocut", codexThreadId: null, title: "Completed edit" });
    snapshots.set(first.id, snapshot(first));
    snapshots.set(second.id, { thread: second, events: [], runs: [{ id: "done-run", threadId: second.id, status: "completed" }] });
    api.listThreads.mockResolvedValue([first, second]);
    render(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open AI chat" }));
    const pending = deferred<AiChatThreadSnapshot>();
    const nextSelection = deferred<AiChatThreadSnapshot>();
    api.getThread.mockImplementationOnce(() => pending.promise).mockImplementationOnce(() => nextSelection.promise);
    await advance(6_000);
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    fireEvent.click(screen.getByRole("button", { name: /^Completed edit/ }));
    await settle();
    await act(async () => pending.resolve(snapshot(first)));
    await act(async () => nextSelection.resolve(snapshots.get(second.id)!));
    expect(screen.getByText("Auto-Cut completed")).toBeTruthy();
    expect(screen.queryByText("Auto-Cut is working")).toBeNull();
  });

  it("does not inherit the synthetic Auto-Cut model when opening a new Codex chat", async () => {
    const local = thread(TASK_THREAD_ID, { model: "local-autocut", codexThreadId: null });
    snapshots.set(local.id, { thread: local, events: [], runs: [{ id: "done-run", threadId: local.id, status: "completed" }] });
    api.listThreads.mockResolvedValue([local]);
    render(<Harness taskThreadIds={[TASK_THREAD_ID]} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open AI chat" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await settle();
    expect(screen.queryByText("local-autocut")).toBeNull();
    const created = thread("new-conversation");
    api.createThread.mockResolvedValue(created);
    api.startTurn.mockResolvedValue({ id: "new-run", threadId: created.id, status: "running" });
    const editor = screen.getByRole("textbox", { name: "Message to Codex" });
    editor.textContent = "Explain the result";
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await settle();
    expect(api.createThread).toHaveBeenCalledOnce();
    expect(api.createThread.mock.calls[0][0].model).not.toBe("local-autocut");
  });
});
