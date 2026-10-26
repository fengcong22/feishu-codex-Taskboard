import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskboardLanguageProvider } from "../i18n";
import { getVmDownloads, loginVmDownloads, type VmDownloadsSnapshot } from "../vmDownloads";
import { VmStatusMenu } from "./VmStatusMenu";

vi.mock("../vmDownloads", async (importOriginal) => ({
  ...await importOriginal<typeof import("../vmDownloads")>(),
  getVmDownloads: vi.fn(),
  loginVmDownloads: vi.fn(),
}));

const currentSnapshot: VmDownloadsSnapshot = {
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
  notifications: { available: false, enabled: true, errorCode: "VM_NOTIFY_NOT_CONFIGURED", lastSentAt: null, pendingCount: 0, failedCount: 0 },
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

  it("shows verification, expiry and notification health in the topbar menu", async () => {
    const snapshot = structuredClone(currentSnapshot);
    snapshot.session = { ...snapshot.session, status: "unavailable", account: { name: "测试用户", userId: "fixture-user" },
      expiresAt: 1_792_600_000_000, expirySource: "token", lastCheckedAt: 1_792_500_000_000,
      errorCode: "VM_API_TRANSPORT_FAILED" };
    snapshot.notifications = { available: true, enabled: true, errorCode: "VM_NOTIFY_SEND_FAILED",
      lastSentAt: 1_792_400_000_000, pendingCount: 2, failedCount: 7 };
    vi.mocked(getVmDownloads).mockResolvedValue(snapshot);

    render(<TaskboardLanguageProvider language="zh"><VmStatusMenu onOpenQueue={vi.fn()} /></TaskboardLanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "VM 状态：暂时无法验证" }));

    expect(screen.getByText("上次验证账号: 测试用户")).toBeTruthy();
    expect(screen.getByText(/凭据提示到期时间/)).toBeTruthy();
    expect(screen.getByText(/^最近后台检查：/)).toBeTruthy();
    expect(screen.getByText(/VM_API_TRANSPORT_FAILED/)).toBeTruthy();
    expect(screen.getByText(/2 条待重试/)).toBeTruthy();
    expect(screen.getByText(/7 条历史通知发送失败/)).toBeTruthy();
  });

  it("separates personal authorization from background checks and exposes failed notification delivery", async () => {
    const snapshot = structuredClone(currentSnapshot);
    snapshot.session = { ...snapshot.session, status: "connected", account: { name: "测试用户", userId: "fixture-user" },
      lastAuthorizedAt: 1_792_400_000_000, lastCheckedAt: 1_792_500_000_000 };
    snapshot.jobs = [];
    snapshot.notifications = { available: true, enabled: true, errorCode: null,
      lastFailureCode: "VM_NOTIFY_FEISHU_99991672", lastSentAt: null, pendingCount: 0, failedCount: 7 };
    vi.mocked(getVmDownloads).mockResolvedValue(snapshot);
    render(<TaskboardLanguageProvider language="zh"><VmStatusMenu onOpenQueue={vi.fn()} /></TaskboardLanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "VM 状态：已连接" }));
    expect(screen.getByText(/^上次本人登录授权：/)).toBeTruthy();
    expect(screen.getByText(/^最近后台检查：/)).toBeTruthy();
    expect(screen.getByText("发送失败，尚无成功记录")).toBeTruthy();
    expect(screen.getByText(/最近失败码: VM_NOTIFY_FEISHU_99991672/)).toBeTruthy();
    expect(screen.getByText(/队列有可继续处理的申请时才发送登录提醒/)).toBeTruthy();
    expect(screen.getByText(/服务端可能在检查时更新凭据/)).toBeTruthy();
    expect(screen.queryByText("飞书通知已配置")).toBeNull();
    expect(screen.queryByText(/这里不会自动续期/)).toBeNull();
  });

  it("does not infer a personal authorization time or successful sending from older snapshots", async () => {
    const snapshot = structuredClone(currentSnapshot);
    snapshot.session = { ...snapshot.session, status: "connected", account: { name: "测试用户", userId: "fixture-user" }, lastCheckedAt: 1_792_500_000_000 };
    snapshot.notifications = { available: true, enabled: true, errorCode: null, lastSentAt: null, pendingCount: 0, failedCount: 0 };
    vi.mocked(getVmDownloads).mockResolvedValue(snapshot);
    render(<TaskboardLanguageProvider language="zh"><VmStatusMenu onOpenQueue={vi.fn()} /></TaskboardLanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "VM 状态：已连接" }));
    expect(screen.getByText("上次本人登录授权：未记录")).toBeTruthy();
    expect(screen.getByText("已配置，尚无成功发送记录")).toBeTruthy();
  });

  it("labels notification status as awaiting a service restart for older snapshots", async () => {
    const snapshot = structuredClone(currentSnapshot);
    delete snapshot.notifications.pendingCount;
    delete snapshot.notifications.failedCount;
    snapshot.notifications.available = false;
    snapshot.notifications.errorCode = "VM_NOTIFY_SEND_FAILED";
    vi.mocked(getVmDownloads).mockResolvedValue(snapshot);
    render(<TaskboardLanguageProvider language="zh"><VmStatusMenu onOpenQueue={vi.fn()} /></TaskboardLanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "VM 状态：尚未连接" }));
    expect(screen.getByText("通知状态需本机服务重启后更新")).toBeTruthy();
    expect(screen.getByText("旧版状态码 · VM_NOTIFY_SEND_FAILED")).toBeTruthy();
    expect(screen.queryByText("飞书通知不可用")).toBeNull();
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
