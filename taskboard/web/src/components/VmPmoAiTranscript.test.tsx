import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskboardLanguageProvider } from "../i18n";
import type { VmPmoAiSession } from "../types";
import { VmPmoAiTranscript } from "./VmPmoAiTranscript";

const SESSION: VmPmoAiSession = {
  name: "attempt-1-session-1", attempt: "attempt-1", session: 1, outcome: "completed", model: "gpt-test",
  resumed: true, startedAt: "2026-11-20T01:00:00.000Z", finishedAt: "2026-11-20T01:05:00.000Z",
  report: "已生成意图，校验通过。", eventsMissing: false, truncated: false,
  steps: [
    { kind: "message", text: "先读取剪辑准则" },
    { kind: "command", command: "python -m auto_cut_slicing evidence", exitCode: 1, output: "找不到匹配" },
    { kind: "file_change", files: ["edit-intent.json"] },
  ],
};

describe("VmPmoAiTranscript", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ runId: "run-1", sessions: [SESSION] }),
      { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads the transcript only when opened and shows messages, commands and the report", async () => {
    const rendered = render(
      <TaskboardLanguageProvider language="zh"><VmPmoAiTranscript taskId="task-1" refreshKey="run-1:blocked" /></TaskboardLanguageProvider>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const outer = rendered.container.querySelector("details.vm-pmo-ai-transcript") as HTMLDetailsElement;
    outer.open = true;
    fireEvent(outer, new Event("toggle"));
    await waitFor(() => expect(screen.getByText("先读取剪辑准则")).toBeTruthy());
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/local/tasks/task-1/vm-pmo-ai-transcript");
    expect(screen.getByText("第 1 次规划 · 会话 1")).toBeTruthy();
    expect(screen.getByText("接续上一轮对话")).toBeTruthy();
    expect(screen.getByText("退出码 1")).toBeTruthy();
    expect(screen.getByText("找不到匹配")).toBeTruthy();
    expect(screen.getByText("edit-intent.json")).toBeTruthy();
    expect(screen.getByText("已生成意图，校验通过。")).toBeTruthy();
  });
});
