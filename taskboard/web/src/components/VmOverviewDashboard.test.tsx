import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskboardLanguageProvider } from "../i18n";
import { VmOverviewDashboard } from "./VmOverviewDashboard";
import type { Task, VmOverview, VmOverviewTask } from "../types";

const PROJECT = "feishu_project";

function task(id: string, title: string): Task {
  return {
    id, identifier: `ISS-${id}`, projectId: PROJECT, title, description: "", status: "todo",
    priority: "high", labels: ["feishu"], sortOrder: 0, createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z", activityUpdatedAt: "2026-11-01T00:00:00.000Z",
    startDate: null, dueDate: null, recurrence: null, archivedAt: null,
    assignee: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
    creator: { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
    version: 1,
  } as unknown as Task;
}

function attentionTask(overrides: Partial<VmOverviewTask> = {}): VmOverviewTask {
  return {
    taskId: "task_blocked", projectId: PROJECT, title: "VM rec_001 剪辑", subjectKey: "bas:tbl",
    packageAlias: "vm-a", baseToken: "bas", tableId: "tbl", recordId: "rec_001", stage: "initial",
    reviewRound: 0, taskStatus: "todo", archived: false, createdAt: "2026-11-17T00:00:00.000Z",
    runId: "run_1", state: "blocked", column: "needs_attention", errorCode: "WORD_ALIGNMENT_UNRESOLVED",
    reasonCode: "WORD_ALIGNMENT_UNRESOLVED", approvalStatus: "ready", waitingForSlot: false,
    planAttempt: 1, retried: false, plannedAt: "2026-11-17T01:00:00.000Z", runnerStartedAt: null,
    completedAt: null, updatedAt: "2026-11-18T00:00:00.000Z", delivered: false, deliveredAt: null,
    writeback: { processing: null, completed: null }, archive: null, materialSource: null, stuckMs: 3_600_000,
    ...overrides,
  };
}

function overview(overrides: Partial<VmOverview> = {}): VmOverview {
  return {
    projectId: PROJECT, generatedAt: "2026-11-18T08:00:00.000Z",
    slot: { activeCount: 1, pendingCount: 2, maxConcurrent: 1, groupName: "editing" },
    kpis: {
      editing: 1, waitingApproval: 0, oldestApprovalWaitMs: null, needsAttention: 1,
      deliveredLast7Days: 3, publishedLast7Days: 1, firstPassRate: 67, activeRuns: 4,
    },
    attention: [attentionTask()],
    funnel: [
      { id: "todo", count: 0 }, { id: "materials", count: 1 }, { id: "queued", count: 2 },
      { id: "editing", count: 1 }, { id: "feishu_delivery", count: 0 },
      { id: "awaiting_feishu_review", count: 1 }, { id: "nas_upload", count: 0 },
      { id: "completed", count: 3 }, { id: "needs_attention", count: 1 },
    ],
    failures: [{ errorCode: "WORD_ALIGNMENT_UNRESOLVED", count: 1, taskIds: ["task_blocked"] }],
    rounds: { one: 4, two: 1, threeOrMore: 0 },
    durations: {
      plan: { median: 120_000, p90: 300_000, samples: 5 },
      render: { median: null, p90: null, samples: 0 },
      delivery: { median: 60_000, p90: 90_000, samples: 3 },
    },
    writebackDeadLetters: 0, archiveFailures: 0,
    ...overrides,
  };
}

let body: VmOverview;
let failRead = false;
let requests: string[];

beforeEach(() => {
  body = overview();
  failRead = false;
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    if (failRead) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDashboard(onOpenTask = vi.fn()) {
  render(
    <TaskboardLanguageProvider language="zh">
      <VmOverviewDashboard
        projectId={PROJECT}
        tasks={[task("task_blocked", "VM rec_001 剪辑")]}
        onOpenTask={onOpenTask}
      />
    </TaskboardLanguageProvider>,
  );
  return onOpenTask;
}

describe("VmOverviewDashboard", () => {
  it("shows the pipeline KPIs and scopes the request to this project", async () => {
    renderDashboard();
    // "剪辑中" is both a KPI label and a funnel segment, so wait on either.
    await waitFor(() => expect(screen.getAllByText("剪辑中").length).toBeGreaterThan(0));
    expect(screen.getByText("67%")).toBeTruthy();
    expect(screen.getByText("槽位 1/1")).toBeTruthy();
    expect(screen.getByText("1 个已发布 NAS")).toBeTruthy();
    expect(requests[0]).toContain("projectId=feishu_project");
  });

  it("names the reason a task is stuck and opens it on click", async () => {
    const onOpen = renderDashboard();
    const panel = (await screen.findByText("需要你处理")).closest("section")!;
    const row = within(panel).getByText("语音词对齐不确定，可重做规划");
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "task_blocked" }));
  });

  it("shows an empty state instead of a blank panel when nothing is stuck", async () => {
    body = overview({ attention: [], kpis: { ...overview().kpis, needsAttention: 0, deliveredLast7Days: 0, firstPassRate: null } });
    renderDashboard();
    expect(await screen.findByText("流水线运行正常，没有卡住的任务。")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("reports unavailable data rather than pretending the pipeline is healthy", async () => {
    failRead = true;
    renderDashboard();
    expect(await screen.findByText("暂时无法读取剪辑流水线数据。")).toBeTruthy();
  });

  it("falls back to the raw code when a failure has no known label", async () => {
    body = overview({
      attention: [attentionTask({ reasonCode: "VM_SOMETHING_NEW", errorCode: "VM_SOMETHING_NEW" })],
    });
    renderDashboard();
    await waitFor(() => expect(screen.getAllByText("VM_SOMETHING_NEW").length).toBeGreaterThan(0));
  });
});
