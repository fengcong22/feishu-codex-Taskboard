import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoCutRunSummary } from "./AutoCutRunSummary";

describe("AutoCutRunSummary", () => {
  afterEach(() => cleanup());

  it("shows the blocking reason and sends an explicit retry for a blocked task", async () => {
    const onRetry = vi.fn();
    const task = { id: "task-1", version: 4, status: "blocked" };
    const attempt = {
      runId: "run-1",
      attempt: 1,
      stageId: "initial",
      state: "blocked",
      manifestSha256: "a".repeat(64),
      errorCode: "docx_anchor_missing",
      errorMessage: "未找到录屏目录",
    };
    render(<AutoCutRunSummary task={task} attempts={[attempt]} retrying={false} onRetry={onRetry} />);

    expect(screen.getByText("docx_anchor_missing")).toBeTruthy();
    expect(screen.getByText("run-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试 Auto-Cut" }));
    expect(onRetry).toHaveBeenCalledWith("task-1", 4);
  });

  it("does not expose private source paths or report credentials", () => {
    render(
      <AutoCutRunSummary
        task={{ id: "task-1", version: 4, status: "in_progress" }}
        attempts={[{ runId: "run-2", attempt: 2, stageId: "first_review", state: "prepared", manifestSha256: "b".repeat(64) }]}
        retrying={false}
        onRetry={vi.fn()}
      />,
    );
    expect(document.body.textContent).not.toMatch(/C:\\|tmp|token|secret|feishu\.cn/i);
  });
  it("explains the recorded failure and opens the matching attempt log", () => {
    const onOpenLog = vi.fn();
    const onCopy = vi.fn();
    render(<AutoCutRunSummary
      task={{ id: "task-1", version: 8, status: "blocked" }}
      attempts={[
        { runId: "old-run", attempt: 1, stageId: "initial", state: "blocked", threadId: "old-thread", errorCode: "autocut_result_missing" },
        { runId: "latest-run", attempt: 2, stageId: "initial", state: "blocked", threadId: "latest-thread", executionKind: "local", errorCode: "autocut_failed", failedPhase: "document_fetch", lastPhase: "package_publish" },
      ]}
      retrying={false} onRetry={vi.fn()} onOpenLog={onOpenLog} onCopy={onCopy}
    />);
    const rows = screen.getAllByRole("listitem").filter((row) => row.classList.contains("autocut-run-row"));
    const latest = within(rows[1]);
    expect(latest.getByText("读取文档阶段失败，具体原因尚未记录。")).toBeTruthy();
    expect(latest.getByText(/PMO.*文档链接字段/)).toBeTruthy();
    expect(latest.getByText(/飞书 CLI.*登录.*文档.*权限/)).toBeTruthy();
    expect(latest.getByText("失败阶段：读取文档")).toBeTruthy();
    expect(rows[1].querySelector("details")?.open).toBe(true);
    expect(rows[0].querySelector("details")?.open).toBe(false);
    fireEvent.click(latest.getByRole("button", { name: "查看本次日志" }));
    expect(onOpenLog).toHaveBeenCalledWith("latest-thread");
    fireEvent.click(latest.getByRole("button", { name: "复制排查信息" }));
    expect(onCopy).toHaveBeenCalledWith(expect.stringContaining("运行 ID：latest-run"), "已复制排查信息");
  });

  it("explains identity failures without assuming they are document content errors", () => {
    render(<AutoCutRunSummary
      task={{ id: "task-1", version: 8, status: "blocked" }}
      attempts={[{ runId: "run-1", attempt: 1, stageId: "initial", state: "blocked", errorCode: "AUTOCUT_LARK_IDENTITY_UNAVAILABLE", failedPhase: "environment_check" }]}
      retrying={false} onRetry={vi.fn()}
    />);
    expect(screen.getByText("无法读取有效的飞书登录身份。")).toBeTruthy();
    expect(screen.getByText(/运行 Taskboard 的 Windows 账户/)).toBeTruthy();
    expect(screen.getByText(/重新授权.*重试/)).toBeTruthy();
  });

  it("identifies source audio integrity failures without suggesting service credentials or a blind retry", () => {
    const onCopy = vi.fn();
    render(<AutoCutRunSummary
      task={{ id: "task-1", version: 8, status: "blocked" }}
      attempts={[{ runId: "run-1", attempt: 1, stageId: "initial", state: "blocked", errorCode: "source_pair_asr_integrity", failedPhase: "source_asr" }]}
      retrying={false} onRetry={vi.fn()} onCopy={onCopy}
    />);
    expect(screen.getByText("source_pair_asr_integrity")).toBeTruthy();
    expect(screen.getByText("源音频或语音对齐数据未通过完整性校验，剪辑已停止。")).toBeTruthy();
    expect(screen.getByText(/剪辑包工作区.*音频时间戳/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/额度|服务网络|具体原因尚未记录/);
    expect(screen.getByText(/修复素材或剪辑包后再重试/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制排查信息" }));
    expect(onCopy).toHaveBeenCalledWith(expect.stringContaining("source_pair_asr_integrity"), "已复制排查信息");
  });

  it("distinguishes a last recorded phase from a confirmed failure and hides raw diagnostics", () => {
    const onCopy = vi.fn();
    render(<AutoCutRunSummary
      task={{ id: "task-1", version: 8, status: "blocked" }}
      attempts={[{ runId: "run-1", attempt: 1, stageId: "initial", state: "blocked", errorCode: "secret-token-123", errorMessage: "C:\\private\\auth token=secret-token-123", lastPhase: "preflight" }]}
      retrying={false} onRetry={vi.fn()} onCopy={onCopy}
    />);
    expect(screen.getByText("最后记录阶段：运行预检（未确认失败位置）")).toBeTruthy();
    expect(screen.getByText("本次运行受阻，现有记录不足以确定具体原因。")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/private|secret-token-123/);
    expect(screen.queryByRole("button", { name: "查看本次日志" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制排查信息" }));
    expect(onCopy.mock.calls[0][0]).not.toMatch(/private|secret-token-123/);
  });

  it("treats missing result receipts as an outcome, not a fabricated root cause", () => {
    render(<AutoCutRunSummary
      task={{ id: "task-1", version: 8, status: "blocked" }}
      attempts={[{ runId: "run-1", attempt: 1, stageId: "initial", state: "blocked", errorCode: "autocut_result_missing", executionKind: "codex" }]}
      retrying={false} onRetry={vi.fn()}
    />);
    expect(screen.getByText("剪辑包没有提交本次运行的结果回执，尚不能确定具体失败原因。")).toBeTruthy();
    expect(screen.getByText("失败阶段：未记录")).toBeTruthy();
    expect(screen.getByText(/Codex 执行/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/沙箱初始化失败|登录已过期/);
  });
});
