import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TaskboardLanguageProvider } from "../i18n";
import type { ActorIdentity, FeishuAutoCutRun, Task, VmPmoRunSummary } from "../types";
import { TaskDetail } from "./TaskDetail";

// Editor internals are unrelated to execution state. Keep TaskDetail, the
// Auto-Cut summary and all HTTP request serialization real.
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
  let retryTask: Task;
  let vmRun: VmPmoRunSummary | null;
  let rerunGate: Promise<Response> | null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runs = [attempt()];
    runReads = 0;
    vmRun = null;
    rerunGate = null;
    retryTask = { ...TASK, version: 3 };
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input), "http://localhost/").pathname;
      if (/^\/api\/local\/tasks\/[^/]+\/autocut-runs$/.test(pathname)) {
        runReads += 1;
        return json({ runs });
      }
      if (/^\/api\/local\/tasks\/[^/]+\/autocut-retry$/.test(pathname)) {
        runs = [attempt({ state: "blocked" }), attempt({ runId: "run-2", attempt: 2 })];
        return json({ task: retryTask }, 202);
      }
      if (/^\/api\/local\/tasks\/[^/]+\/autocut-rerun-current$/.test(pathname)) {
        if (rerunGate) return rerunGate;
        runs = [...runs, attempt({ runId: "run-2", attempt: 2, configVersion: 2 })];
        const taskId = new URL(String(input), "http://localhost/").pathname.split("/")[4];
        return json({ task: { ...TASK, id: taskId, version: 3, status: "in_progress",
          feishuOrigin: { ...TASK.feishuOrigin, configVersion: 2 } } }, 202);
      }
      if (/^\/api\/local\/tasks\/[^/]+\/vm-pmo-run$/.test(pathname)) {
        if (init?.method === "POST") {
          vmRun = { ...vmRun!, state: "ready", canRetryPlan: false };
          return json({ run: vmRun }, 202);
        }
        return json({ run: vmRun });
      }
      if (/^\/api\/local\/tasks\/[^/]+\/vm-pmo-writeback-retry$/.test(pathname)) {
        vmRun = { ...vmRun!, canRetryWriteback: false,
          writeback: { processing: { state: "pending", errorCode: null, attemptCount: 0 },
            completed: { state: "pending", errorCode: null, attemptCount: 0 } } };
        return json({ run: vmRun }, 202);
      }
      if (/^\/api\/tasks\/[^/]+\/(comments|activities|attachments)$/.test(pathname)) {
        return json({ [pathname.split("/").at(-1)!]: [] });
      }
      if (/^\/api\/local\/tasks\/[^/]+\/artifacts$/.test(pathname)) return json({ artifacts: [] });
      if (/^\/api\/local\/tasks\/[^/]+\/upload$/.test(pathname)) return json({ uploads: [] });
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
    expect(screen.getByRole("button", { name: "按当前配置重新执行" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试 Auto-Cut" })).toBeNull();
  });

  it("passes the displayed single-run consent through the real detail retry handler and API", async () => {
    const blockedTask = { ...TASK, status: "blocked" as const, version: 2 };
    runs = [attempt({ state: "blocked", errorCode: "AUTOCUT_LARK_IDENTITY_UNAVAILABLE" })];
    render(view(props(blockedTask)));
    const retryButton = await screen.findByRole("button", { name: "按当前配置重新执行" });
    const retryRequests = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/autocut-rerun-current"));
    expect(retryRequests()).toHaveLength(0);
    expect(document.getElementById(retryButton.getAttribute("aria-describedby")!)?.textContent)
      .toMatch(/本次.*视频原音.*语音识别.*本机输出目录/);

    fireEvent.click(retryButton);

    await waitFor(() => expect(retryRequests()).toHaveLength(1));
    const [, request] = retryRequests()[0];
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body)).toEqual({
      version: 2,
      runConsent: { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true },
    });
    expect(await screen.findByText("run-2")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试 Auto-Cut" })).toBeNull());
  });

  it("reruns on the same card only after a click and refreshes both attempts", async () => {
    runs = [attempt({ state: "blocked", errorCode: "docx_anchor_missing" })];
    const detailProps = props({ ...TASK, status: "blocked", version: 2 });
    render(view(detailProps));
    const button = await screen.findByRole("button", { name: "按当前配置重新执行" });
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent)
      .toMatch(/当前.*配置.*原任务.*视频原音.*语音识别.*本机输出目录/);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/autocut-rerun-current"))).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByText("run-2")).toBeTruthy();
    expect(detailProps.onOpenTask).not.toHaveBeenCalled();
    const [, request] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/autocut-rerun-current"))!;
    expect(JSON.parse(request.body)).toEqual({ version: 2,
      runConsent: { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true } });
    expect(screen.getByText("run-1")).toBeTruthy();
    expect(screen.getByText("docx_anchor_missing")).toBeTruthy();
  });

  it("clears a pending rerun state when the detail switches to another card", async () => {
    let releaseRerun!: (response: Response) => void;
    rerunGate = new Promise<Response>(resolve => { releaseRerun = resolve; });
    runs = [attempt({ state: "blocked", errorCode: "docx_anchor_missing" })];
    const rendered = render(view(props({ ...TASK, status: "blocked", version: 2 })));
    fireEvent.click(await screen.findByRole("button", { name: "按当前配置重新执行" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) =>
      String(url).endsWith("/autocut-rerun-current"))).toBe(true));

    const nextTask = { ...TASK, id: "task-2", identifier: "FEI-2", status: "blocked" as const,
      feishuOrigin: { ...TASK.feishuOrigin!, recordId: "record-2", eventId: "event-2" } };
    rendered.rerender(view(props(nextTask)));

    expect(await screen.findByRole("button", { name: "按当前配置重新执行" })).toBeTruthy();
    expect(screen.queryByText("重新执行中…")).toBeNull();
    releaseRerun(json({ task: { ...TASK, status: "in_progress", version: 3 } }, 202));
    await waitFor(() => expect(screen.getByRole("button", { name: "按当前配置重新执行" })).toBeTruthy());
    expect(screen.queryByText("重新执行中…")).toBeNull();
  });

  it("requires per-retry ASR and local-plan consent before retrying the same VM run", async () => {
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "blocked", errorCode: "WORD_ALIGNMENT_UNRESOLVED",
      approvalStatus: "ready", planAttempt: 1, retryLimit: 3, retryHistory: [], canRetryPlan: true,
      canRetryWriteback: false, writeback: { processing: null, completed: null },
      updatedAt: CREATED_AT };
    const rendered = render(view(props(TASK)));
    fireEvent.click(await screen.findByRole("button", { name: "重试语音识别与规划" }));

    const confirm = screen.getByRole("button", { name: "确认重试" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("允许本次重试重新识别原视频音轨"));
    fireEvent.click(screen.getByLabelText("允许本次重试写入新的本机规划文件"));
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/vm-pmo-run") && init?.method === "POST")).toBe(true));
    const [, request] = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith("/vm-pmo-run") && init?.method === "POST")!;
    expect(JSON.parse(request.body)).toEqual({ version: TASK.version,
      runConsent: { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true } });
    await waitFor(() => expect(rendered.container.querySelector(".vm-pmo-run-state")?.textContent).toBe("等待重新规划"));
  });

  it("retries only the VM run's dead-letter Feishu progress writebacks", async () => {
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "completed", errorCode: null,
      approvalStatus: "ready", planAttempt: 1, retryLimit: 3, retryHistory: [], canRetryPlan: false,
      canRetryWriteback: true,
      writeback: { processing: { state: "dead_letter", errorCode: "WRITEBACK_UNAVAILABLE", attemptCount: 8 },
        completed: { state: "dead_letter", errorCode: "WRITEBACK_UNAVAILABLE", attemptCount: 8 } },
      updatedAt: CREATED_AT };
    const task = { ...TASK, status: "in_review" as const };
    render(view(props(task)));
    expect(await screen.findAllByText("WRITEBACK_UNAVAILABLE")).toHaveLength(2);
    fireEvent.click(await screen.findByRole("button", { name: "重试进度回写" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/vm-pmo-writeback-retry") && init?.method === "POST")).toBe(true));
    const [, request] = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith("/vm-pmo-writeback-retry") && init?.method === "POST")!;
    expect(JSON.parse(request.body)).toEqual({ version: task.version });
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试进度回写" })).toBeNull());
  });
});
