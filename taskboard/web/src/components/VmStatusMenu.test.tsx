import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskboardLanguageProvider } from "../i18n";
import { getVmDownloads, loginVmDownloads } from "../vmDownloads";
import { VmStatusMenu } from "./VmStatusMenu";

vi.mock("../vmDownloads", async (importOriginal) => ({
  ...await importOriginal<typeof import("../vmDownloads")>(),
  getVmDownloads: vi.fn(),
  loginVmDownloads: vi.fn(),
}));

const currentSnapshot = {
  session: {
    status: "disconnected" as const, account: null, expiresAt: null,
    expirySource: "unknown" as const, lastCheckedAt: null, errorCode: null,
    automaticRefreshSupported: false as const, crossDeviceAuthorizationSupported: false as const,
  },
  settings: { outputRoot: "E:\\Downloads", department: "动画组", reason: "课程制作", notificationsEnabled: true },
  jobs: [
    { id: "attention", vmid: "507f1f77bcf86cd799439011", status: "needs_attention", submission_attempts: 1, attempts: 0, next_attempt_at: null, created_at: 1, updated_at: 1, output_root: "E:\\Downloads", department: "动画组", reason: "课程制作" },
    { id: "pending", vmid: "507f1f77bcf86cd799439012", status: "waiting_approval", submission_attempts: 1, attempts: 0, next_attempt_at: null, created_at: 1, updated_at: 1, output_root: "E:\\Downloads", department: "动画组", reason: "课程制作" },
  ],
  hiddenAttentionJobs: [],
  notifications: { available: false, enabled: true, errorCode: "VM_NOTIFY_NOT_CONFIGURED", lastSentAt: null },
  worker: { running: false, errorCode: null },
};

describe("VM status menu", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(getVmDownloads).mockResolvedValue(structuredClone(currentSnapshot));
    vi.mocked(loginVmDownloads).mockResolvedValue({
      loginUrl: "https://shadow.yangcong345.com/#/login",
      session: { ...currentSnapshot.session, status: "connecting" },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows connection and queue counts and refreshes the snapshot on demand", async () => {
    render(<TaskboardLanguageProvider language="zh"><VmStatusMenu onOpenQueue={vi.fn()} /></TaskboardLanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "VM 状态：尚未连接" }));
    expect(screen.getByText("2 个队列任务 · 1 项需要处理")).toBeTruthy();
    const refreshButton = screen.getByRole("menuitem", { name: "刷新下载状态" });
    await act(async () => {});
    await waitFor(() => expect((refreshButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refreshButton);
    expect(getVmDownloads).toHaveBeenCalledTimes(3);
  });

  it("retries the initial status read when StrictMode aborts its first mount request", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(getVmDownloads).mockImplementation((signal) => new Promise((resolve, reject) => {
      signals.push(signal!);
      if (signals.length > 1) {
        resolve(structuredClone(currentSnapshot));
        return;
      }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));

    render(<StrictMode><TaskboardLanguageProvider language="zh"><VmStatusMenu onOpenQueue={vi.fn()} /></TaskboardLanguageProvider></StrictMode>);

    expect(await screen.findByRole("button", { name: "VM 状态：尚未连接" })).toBeTruthy();
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
  });

  it("persists the automatic refresh interval and polls using the selected cadence", async () => {
    vi.useFakeTimers();
    render(<TaskboardLanguageProvider language="zh"><VmStatusMenu onOpenQueue={vi.fn()} /></TaskboardLanguageProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    vi.mocked(getVmDownloads).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "VM 状态：尚未连接" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(getVmDownloads).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("combobox", { name: "自动刷新" }), { target: { value: "60000" } });
    expect(window.localStorage.getItem("taskboard.vm-status-refresh.v1")).toBe("60000");
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(getVmDownloads).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getVmDownloads).toHaveBeenCalledTimes(2);
  });

  it("starts Shadow SSO from the topbar and opens the full queue", async () => {
    const popup = { opener: window, closed: false, location: { replace: vi.fn() }, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const onOpenQueue = vi.fn();
    render(<TaskboardLanguageProvider language="zh"><VmStatusMenu onOpenQueue={onOpenQueue} /></TaskboardLanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "VM 状态：尚未连接" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "连接 Shadow 账号" }));
    expect(loginVmDownloads).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith("https://shadow.yangcong345.com/#/login"));
    fireEvent.click(screen.getByRole("menuitem", { name: "打开完整 VM 队列" }));
    expect(onOpenQueue).toHaveBeenCalledTimes(1);
  });
});
