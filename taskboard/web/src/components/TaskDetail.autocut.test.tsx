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
      if (/^\/api\/local\/tasks\/[^/]+\/vm-pmo-(plan-validation-retry|render-retry|approval-retry|manual-revision)$/.test(pathname)) {
        vmRun = { ...vmRun!, state: "ready", errorCode: null, canRetryValidatedPlan: false,
          canRetryFailedRender: false, canRetryApproval: false, canRetryManualRevision: false };
        return json({ run: vmRun }, 202);
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

  it("shows the saved-plan revalidation button only when the server allows it", async () => {
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "needs_attention", errorCode: "PLAN_INVALID",
      approvalStatus: "ready", planAttempt: 1, retryLimit: 3, retryHistory: [], canRetryPlan: false,
      canRetryValidatedPlan: true, updatedAt: CREATED_AT };
    render(view(props(TASK)));
    const button = await screen.findByRole("button", { name: "重新校验已保存的规划" });
    expect(screen.queryByRole("button", { name: "重试语音识别与规划" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("vm-pmo-plan-validation-retry"))).toBe(false);

    fireEvent.click(button);

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/vm-pmo-plan-validation-retry") && init?.method === "POST")).toBe(true));
    const [, request] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/vm-pmo-plan-validation-retry"))!;
    expect(JSON.parse(request.body)).toEqual({ version: TASK.version });
    await waitFor(() => expect(screen.queryByRole("button", { name: "重新校验已保存的规划" })).toBeNull());
  });

  it("resumes a failed render only from its own button and only once per click", async () => {
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "needs_attention",
      errorCode: "VM_PMO_START_EVIDENCE_FAILED", approvalStatus: "ready", planAttempt: 1, retryLimit: 3,
      retryHistory: [], canRetryPlan: false, canRetryFailedRender: true, updatedAt: CREATED_AT };
    render(view(props(TASK)));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("vm-pmo-render-retry"))).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "用原规划重新渲染" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/vm-pmo-render-retry") && init?.method === "POST")).toBe(true));
    const [, request] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/vm-pmo-render-retry"))!;
    expect(JSON.parse(request.body)).toEqual({ version: TASK.version });
  });

  it("reruns a timed-out step only when the server says it produced nothing", async () => {
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "needs_attention",
      errorCode: "VM_PMO_RUN_TIMEOUT", approvalStatus: "ready", planAttempt: 1, retryLimit: 3,
      retryHistory: [], canRetryPlan: false, canRetryFailedRender: false,
      canRetryStepTimeout: true, updatedAt: CREATED_AT };
    render(view(props(TASK)));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("vm-pmo-step-timeout-retry"))).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "重新执行超时的步骤" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/vm-pmo-step-timeout-retry") && init?.method === "POST")).toBe(true));
    const [, request] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/vm-pmo-step-timeout-retry"))!;
    expect(JSON.parse(request.body)).toEqual({ version: TASK.version });
  });

  it("hides the timeout retry when the server does not allow it", async () => {
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "needs_attention",
      errorCode: "VM_PMO_RUN_TIMEOUT", approvalStatus: "ready", planAttempt: 1, retryLimit: 3,
      retryHistory: [], canRetryPlan: false, canRetryStepTimeout: false, updatedAt: CREATED_AT };
    render(view(props(TASK)));
    await waitFor(() => expect(screen.queryByRole("button", { name: "重新执行超时的步骤" })).toBeNull());
  });

  it("requeues approval only when the server says the applicant change can be retried", async () => {
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "blocked", errorCode: "VM_APPLICANT_CHANGED",
      approvalStatus: "reserved", planAttempt: 1, retryLimit: 3, retryHistory: [], canRetryPlan: false,
      canRetryApproval: true, updatedAt: CREATED_AT };
    render(view(props(TASK)));
    expect(screen.queryByRole("button", { name: "提交人工修改方案" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "重新排队审批" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/vm-pmo-approval-retry") && init?.method === "POST")).toBe(true));
    const [, request] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/vm-pmo-approval-retry"))!;
    expect(JSON.parse(request.body)).toEqual({ version: TASK.version });
  });

  it("submits a manual revision bound to the source video only after both consents", async () => {
    const sourceSha256 = "a".repeat(64);
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "blocked", errorCode: "UNSUPPORTED_INSTRUCTION",
      approvalStatus: "ready", planAttempt: 1, retryLimit: 3, retryHistory: [], canRetryPlan: false,
      canRetryManualRevision: true, sourceSha256, sourceDurationMs: 10_000, updatedAt: CREATED_AT };
    render(view(props(TASK)));
    fireEvent.click(await screen.findByRole("button", { name: "提交人工修改方案" }));

    const submit = screen.getByRole("button", { name: "确认提交" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("修改说明"), { target: { value: "删掉开头的口误" } });
    fireEvent.change(screen.getByLabelText("保留开始（毫秒）"), { target: { value: "1500" } });
    fireEvent.change(screen.getByLabelText("保留结束（毫秒）"), { target: { value: "9000" } });
    fireEvent.click(submit);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("vm-pmo-manual-revision"))).toBe(false);

    fireEvent.click(screen.getByLabelText("允许本次使用原视频"));
    fireEvent.click(screen.getByLabelText("允许本次写入新的本机规划文件"));
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).endsWith("/vm-pmo-manual-revision") && init?.method === "POST")).toBe(true));
    const [, request] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/vm-pmo-manual-revision"))!;
    expect(JSON.parse(request.body)).toEqual({ version: TASK.version,
      runConsent: { allowSourceVideo: true, allowLocalPlanning: true },
      manualRevision: { sourceSha256, note: "删掉开头的口误", clips: [{ startMs: 1500, endMs: 9000 }] } });
  });

  it("keeps an out-of-range manual revision local and never sends it", async () => {
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "blocked", errorCode: "UNSUPPORTED_INSTRUCTION",
      approvalStatus: "ready", planAttempt: 1, retryLimit: 3, retryHistory: [], canRetryPlan: false,
      canRetryManualRevision: true, sourceSha256: "b".repeat(64), sourceDurationMs: 5_000, updatedAt: CREATED_AT };
    render(view(props(TASK)));
    fireEvent.click(await screen.findByRole("button", { name: "提交人工修改方案" }));
    fireEvent.change(screen.getByLabelText("修改说明"), { target: { value: "保留后半段" } });
    fireEvent.change(screen.getByLabelText("保留开始（毫秒）"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("保留结束（毫秒）"), { target: { value: "8000" } });
    fireEvent.click(screen.getByLabelText("允许本次使用原视频"));
    fireEvent.click(screen.getByLabelText("允许本次写入新的本机规划文件"));
    fireEvent.click(screen.getByRole("button", { name: "确认提交" }));

    expect(await screen.findByText("请填写修改说明，并给出落在原视频时长内的整数毫秒区间。")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("vm-pmo-manual-revision"))).toBe(false);
  });

  it("explains a failed VM download and where an approved manual source belongs", async () => {
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "blocked", errorCode: "VM_DOWNLOAD_FAILED",
      approvalStatus: "needs_attention", planAttempt: 1, retryLimit: 3, retryHistory: [], canRetryPlan: false,
      materialSource: null, downloadFailure: { reason: "VM_SOURCE_TIMEOUT", approved: true, manualSourceState: null,
        message: "VM 视频下载出错（VM_SOURCE_TIMEOUT）。审批已通过，可以人工从 VM 下载视频。",
        manualSourceFile: "人工素材/5dd7753a4723ba416403cbad.mp4" }, updatedAt: CREATED_AT };
    render(view(props(TASK)));
    const region = await screen.findByLabelText("VM 视频下载失败");
    expect(region.textContent).toMatch(/审批已通过/u);
    expect(region.textContent).toContain("人工素材/5dd7753a4723ba416403cbad.mp4");
    expect(region.textContent).toMatch(/VM_SOURCE_TIMEOUT/u);
  });

  it("marks a run that continued from an operator-supplied source", async () => {
    vmRun = { runId: "vm-run-1", taskId: TASK.id, state: "planning", errorCode: null, approvalStatus: "needs_attention",
      planAttempt: 1, retryLimit: 3, retryHistory: [], canRetryPlan: false, materialSource: "manual", updatedAt: CREATED_AT };
    render(view(props(TASK)));
    expect(await screen.findByText("素材来源：人工提供")).toBeTruthy();
    expect(screen.queryByLabelText("VM 视频下载失败")).toBeNull();
  });
});
