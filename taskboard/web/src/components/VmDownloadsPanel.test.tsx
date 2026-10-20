import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskboardLanguageProvider } from "../i18n";
import { VmDownloadsPanel } from "./VmDownloadsPanel";
import { LocalSettingsDialog } from "./LocalSettingsDialog";

const VM1 = "507f1f77bcf86cd799439011";
const VM2 = "507f1f77bcf86cd799439012";
const ROOT = "/api/local/vm-downloads";

function snapshot() {
  return {
    session: {
      status: "disconnected", account: null as { name: string; userId: string } | null,
      expiresAt: null as number | null, expirySource: "unknown", lastCheckedAt: null,
      errorCode: null as string | null, automaticRefreshSupported: false, crossDeviceAuthorizationSupported: false,
    },
    settings: { outputRoot: "E:\\Downloads", department: "动画组", reason: "课程制作", notificationsEnabled: true },
    jobs: [] as ReturnType<typeof job>[],
    hiddenAttentionJobs: [] as ReturnType<typeof job>[],
    notifications: { available: true, enabled: true, errorCode: null as string | null, lastSentAt: null },
    worker: { running: false, errorCode: null as string | null },
  };
}

function job(id: string, status: string, errorCode?: string, vmid = VM1,
  recovery?: { kind: "private_address" | "unknown_outcome" | "resource_claim" }, diagnosticCode?: string) {
  return {
    protocol: "vm_approval_workflow", schema_version: 1, id, vmid, status,
    submission_attempts: 1, attempts: 0, next_attempt_at: null,
    application_id: `application-${id}`, instance_code: `approval-${id}`,
    created_at: 1_792_000_000_000, updated_at: 1_792_000_060_000,
    approval_wait_started_at: 1_792_000_000_000, approval_deadline_at: 1_792_604_800_000,
    media_wait_started_at: null, media_deadline_at: null,
    output_root: "E:\\Downloads", department: "动画组", reason: "课程制作",
    ...(errorCode ? { error: { code: errorCode, ...(diagnosticCode ? { diagnostic_code: diagnosticCode } : {}) } } : {}),
    ...(recovery ? { recovery } : {}),
    ...(status === "ready" ? { acquisition: { path: "E:\\Downloads\\source.mp4", receipt_path: "E:\\Downloads\\receipt.json", sha256: "a".repeat(64), bytes: 512, duration_ms: 1000, width: 1280, height: 720, vmid_binding: "vm_api_verified" } } : {}),
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let current: ReturnType<typeof snapshot>;
let writes: { path: string; method: string; body: Record<string, unknown>; headers: Headers }[];
let readFailure = false;
let writeFailure = false;
let fetchMock: ReturnType<typeof vi.fn>;

function mount() {
  return render(<TaskboardLanguageProvider language="zh"><VmDownloadsPanel /></TaskboardLanguageProvider>);
}

async function openManualRequest() {
  await screen.findByText("尚未连接");
  fireEvent.click(screen.getByText("手动批量下载（补救入口）"));
  await screen.findByRole("textbox", { name: "VMID" });
}

beforeEach(() => {
  current = snapshot(); writes = []; readFailure = false; writeFailure = false;
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    if (path === "/api/local/settings/automatic-execution") return response({ setting: { enabled: false, version: 1 } });
    if (method === "GET" && path === ROOT) {
      if (readFailure) return response({ error: { code: "VM_SERVICE_UNAVAILABLE", message: "private url https://secret.invalid" } }, 503);
      return response(current);
    }
    writes.push({ path, method, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    if (writeFailure) return response({ error: { code: "VM_APPROVAL_JOB_BUSY", message: "private failure" } }, 409);
    if (path === `${ROOT}/login`) {
      current.session.status = "connecting";
      return response({ loginUrl: "https://shadow.yangcong345.com/#/?fromWebUrl=fixture", session: current.session });
    }
    if (path === `${ROOT}/logout`) { current.session = snapshot().session; return response({ session: current.session }); }
    if (path === `${ROOT}/settings`) { current.settings = { ...current.settings, ...writes.at(-1)!.body }; return response({ settings: current.settings }); }
    if (path === `${ROOT}/jobs`) { current.jobs = [job("queued-job", "queued")]; return response({ jobs: current.jobs }); }
    if (path === `${ROOT}/jobs/cleanup`) {
      const ids = writes.at(-1)!.body.jobIds as string[];
      const hidden = current.jobs.filter((candidate) => ids.includes(candidate.id));
      current.jobs = current.jobs.filter((candidate) => !ids.includes(candidate.id));
      current.hiddenAttentionJobs = [...current.hiddenAttentionJobs, ...hidden.filter((candidate) => candidate.status === "needs_attention")];
      return response({ clearedCount: ids.length });
    }
    if (path.endsWith("/restore")) {
      const id = path.split("/").at(-2);
      const restored = current.hiddenAttentionJobs.find((candidate) => candidate.id === id)!;
      current.hiddenAttentionJobs = current.hiddenAttentionJobs.filter((candidate) => candidate.id !== id);
      current.jobs.push(restored);
      return response({ job: restored });
    }
    if (path.endsWith("/recover")) {
      const id = path.split("/").at(-2);
      const recovered = current.jobs.find((candidate) => candidate.id === id)!;
      recovered.status = "waiting_media"; delete recovered.error;
      return response({ job: recovered });
    }
    if (path.endsWith("/extend")) { current.jobs[0] = job("expired", "waiting_approval"); return response({ job: current.jobs[0] }); }
    if (path.endsWith("/resume")) { current.jobs[1] = job("failed", "queued", undefined, VM2); return response({ job: current.jobs[1] }); }
    throw new Error(`Unexpected fixture route: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("VM downloads panel", () => {
  it("keeps VM account and queue controls out of local settings", async () => {
    render(<TaskboardLanguageProvider language="zh"><LocalSettingsDialog revision={0} onSettingsChange={() => {}} onClose={() => {}} /></TaskboardLanguageProvider>);
    expect(screen.queryByRole("region", { name: "VM 账号与队列" })).toBeNull();
    expect(screen.queryByRole("button", { name: "VM 账号与队列" })).toBeNull();
    const automaticSwitch = screen.getByRole("switch", { name: "自动执行" });
    expect(automaticSwitch.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText(/适用于本机所有学科/)).toBeNull();
  });

  it("keeps account and queue controls available while manual downloads stay collapsed", async () => {
    current.jobs = [job("pending", "waiting_approval")];
    mount();
    await screen.findByText("等待审批");
    expect(screen.getByRole("button", { name: "连接 Shadow 账号" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "下载队列" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "VMID" })).toBeNull();
    expect(screen.queryByRole("button", { name: "加入下载队列" })).toBeNull();
    await openManualRequest();
    fireEvent.change(screen.getByRole("textbox", { name: "VMID" }), { target: { value: VM1 } });
    fireEvent.click(screen.getByRole("button", { name: "加入下载队列" }));
    await screen.findByText("排队中");
    expect(writes[0]).toMatchObject({ method: "POST", path: `${ROOT}/jobs`, body: {
      vmids: [VM1], department: "动画组", reason: "课程制作", outputRoot: "E:\\Downloads",
    } });
  });

  it("connects through SSO and exposes a safe fallback when the popup is blocked", async () => {
    mount();
    await screen.findByText("尚未连接");
    expect(screen.queryByRole("textbox", { name: /token|凭据/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "连接 Shadow 账号" }));
    const fallback = await screen.findByRole("link", { name: "打开登录页面" });
    expect(fallback.getAttribute("href")).toBe("https://shadow.yangcong345.com/#/?fromWebUrl=fixture");
    expect(fallback.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(/浏览器未打开登录窗口/)).toBeTruthy();
    expect(screen.getByText("等待登录完成")).toBeTruthy();
    expect(writes[0]).toMatchObject({ path: `${ROOT}/login`, method: "POST", body: {} });
    expect(writes[0].headers.get("X-Taskboard-Client")).toBe("web");
    expect(writes[0].headers.get("Content-Type")).toBe("application/json");
  });

  it("does not open a login URL outside the configured Shadow origin", async () => {
    mount(); await screen.findByText("尚未连接");
    fetchMock.mockImplementationOnce(async () => response({ loginUrl: "https://untrusted.invalid/", session: { ...current.session, status: "connecting" } }));
    fireEvent.click(screen.getByRole("button", { name: "连接 Shadow 账号" }));
    expect((await screen.findByRole("alert")).textContent).toContain("操作未完成");
    expect(screen.queryByRole("link", { name: "打开登录页面" })).toBeNull();
    expect(document.body.textContent).not.toContain("untrusted.invalid");
  });

  it("uses token expiry metadata only when the server actually supplies it", async () => {
    current.session = { ...current.session, status: "connected", account: { name: "测试用户", userId: "fixture-user" }, expiresAt: 1_792_600_000_000, expirySource: "token" };
    mount(); await screen.findByText("测试用户");
    expect(screen.getByText(/凭据提示到期时间/)).toBeTruthy();
    expect(screen.queryByText(/有效期未知/)).toBeNull();
  });

  it("reflects the verified account without fabricating an expiry and disconnects it", async () => {
    current.session = { ...current.session, status: "connected", account: { name: "测试用户", userId: "fixture-user" } };
    mount();
    await screen.findByText("测试用户");
    expect(screen.getByText(/有效期未知/)).toBeTruthy();
    expect(screen.getByText(/暂不支持自动续期/)).toBeTruthy();
    expect(screen.getByText(/跨设备直接授权/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "断开账号" }));
    await screen.findByText("尚未连接");
    expect(writes[0].path).toBe(`${ROOT}/logout`);
  });

  it("shows a reconnect alert only after the server confirms expired authorization", async () => {
    current.session = { ...current.session, status: "auth_required", account: { name: "测试用户", userId: "fixture-user" } };
    mount();
    const alert = await screen.findByRole("alert", { name: "Shadow 登录已失效" });
    expect(alert.textContent).toContain("下载队列已暂停");
    fireEvent.click(screen.getByRole("button", { name: "从提示重新连接" }));
    await screen.findByText("等待登录完成");
    expect(writes[0]).toMatchObject({ path: `${ROOT}/login`, method: "POST" });

    cleanup();
    current.session = { ...current.session, status: "unavailable" };
    mount();
    await screen.findByText("暂时无法验证账号");
    expect(screen.queryByRole("alert", { name: "Shadow 登录已失效" })).toBeNull();
  });

  it("validates the entire batch before submitting normalized VMIDs and saved local fields", async () => {
    mount();
    await openManualRequest();
    await screen.findByDisplayValue("E:\\Downloads");
    const vmids = screen.getByRole("textbox", { name: "VMID" });
    fireEvent.change(vmids, { target: { value: `${VM1}\ninvalid` } });
    fireEvent.click(screen.getByRole("button", { name: "加入下载队列" }));
    expect((await screen.findByRole("alert")).textContent).toContain("24 位");
    expect(writes).toHaveLength(0);
    fireEvent.change(vmids, { target: { value: `${VM1}\n${VM2.toUpperCase()}，${VM1}` } });
    fireEvent.change(screen.getByRole("textbox", { name: "申请原因" }), { target: { value: "  示例项目  " } });
    fireEvent.change(screen.getByRole("textbox", { name: "本机输出目录" }), { target: { value: "E:\\Review" } });
    fireEvent.click(screen.getByRole("button", { name: "加入下载队列" }));
    await screen.findByText("排队中");
    expect(writes[0]).toMatchObject({ path: `${ROOT}/jobs`, method: "POST", body: {
      vmids: [VM1, VM2], department: "动画组", reason: "示例项目", outputRoot: "E:\\Review",
    } });
    expect((vmids as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText(/2 个 VMID/)).toBeTruthy();
  });

  it("rejects more than 50 VMIDs and relative output paths without sending requests", async () => {
    mount(); await openManualRequest(); await screen.findByDisplayValue("E:\\Downloads");
    fireEvent.change(screen.getByRole("textbox", { name: "VMID" }), { target: { value: Array.from({ length: 51 }, (_, index) => index.toString(16).padStart(24, "0")).join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: "加入下载队列" }));
    expect((await screen.findByRole("alert")).textContent).toContain("50");
    fireEvent.change(screen.getByRole("textbox", { name: "VMID" }), { target: { value: VM1 } });
    fireEvent.change(screen.getByRole("textbox", { name: "本机输出目录" }), { target: { value: "relative/downloads" } });
    fireEvent.click(screen.getByRole("button", { name: "加入下载队列" }));
    expect((await screen.findByRole("alert")).textContent).toContain("绝对目录");
    expect(writes).toHaveLength(0);
  });

  it("saves preferences and explains unavailable Feishu notifications", async () => {
    current.notifications = { available: false, enabled: true, errorCode: "VM_NOTIFY_UNAVAILABLE", lastSentAt: null };
    mount(); await openManualRequest(); await screen.findByDisplayValue("E:\\Downloads");
    expect(screen.getByText(/飞书通知不可用/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "申请部门" }), { target: { value: "  课程组 " } });
    fireEvent.click(screen.getByRole("checkbox", { name: "飞书异常提醒" }));
    fireEvent.click(screen.getByRole("button", { name: "保存下载设置" }));
    await screen.findByText("下载设置已保存。");
    expect(writes[0]).toMatchObject({ method: "PUT", path: `${ROOT}/settings`, body: {
      department: "课程组", reason: "课程制作", outputRoot: "E:\\Downloads", notificationsEnabled: false,
    } });
  });

  it("shows approval, media, ready and rejected states without retrying terminal jobs", async () => {
    current.jobs = [job("pending", "waiting_approval"), job("ready", "ready", undefined, VM2),
      job("rejected", "rejected", "VM_APPROVAL_REJECTED", "507f1f77bcf86cd799439013"),
      job("media", "waiting_media", undefined, "507f1f77bcf86cd799439014")];
    mount();
    await screen.findByText("等待审批");
    expect(screen.getByText("等待素材制作")).toBeTruthy();
    expect(screen.getByText("已下载")).toBeTruthy();
    expect(screen.getByText("已驳回")).toBeTruthy();
    expect(screen.getByText("E:\\Downloads\\source.mp4")).toBeTruthy();
    expect(screen.getByText("application-pending")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试任务" })).toBeNull();
    expect(screen.queryByRole("button", { name: "延长等待 7 天" })).toBeNull();
  });

  it("selects individual settled jobs, selects all clearable rows, and leaves active rows protected", async () => {
    current.jobs = [job("ready-1", "ready", undefined, VM1), job("rejected-1", "rejected", undefined, VM2),
      job("canceled-1", "canceled", undefined, "507f1f77bcf86cd799439015"),
      job("queued-1", "queued", undefined, "507f1f77bcf86cd799439013"), job("attention-1", "needs_attention", "VM_API_TIMEOUT", "507f1f77bcf86cd799439014")];
    mount();
    await screen.findByText("已下载");

    const ready = screen.getByRole("checkbox", { name: `选择清理 ${VM1}，记录 ready-1` }) as HTMLInputElement;
    const rejected = screen.getByRole("checkbox", { name: `选择清理 ${VM2}，记录 rejected-1` }) as HTMLInputElement;
    const canceled = screen.getByRole("checkbox", { name: "选择清理 507f1f77bcf86cd799439015，记录 canceled-1" }) as HTMLInputElement;
    const queued = screen.getByRole("checkbox", { name: "选择清理 507f1f77bcf86cd799439013，记录 queued-1" }) as HTMLInputElement;
    const attention = screen.getByRole("checkbox", { name: "选择清理 507f1f77bcf86cd799439014，记录 attention-1" }) as HTMLInputElement;
    expect(queued.disabled).toBe(true);
    expect(attention.disabled).toBe(true);

    fireEvent.click(ready);
    fireEvent.click(rejected);
    expect(screen.getByRole("button", { name: "清理所选（2）" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "全选可清理项" }));
    expect(ready.checked).toBe(true);
    expect(rejected.checked).toBe(true);
    expect(canceled.checked).toBe(true);

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "清理所选（3）" }));
    await waitFor(() => expect(writes.some(({ path }) => path === `${ROOT}/jobs/cleanup`)).toBe(true));
    expect(writes.at(-1)).toMatchObject({ method: "POST", path: `${ROOT}/jobs/cleanup`, body: { jobIds: ["ready-1", "rejected-1", "canceled-1"] } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("VM_API_TIMEOUT")).toBeTruthy();
    expect(screen.queryByText("已驳回")).toBeNull();
    expect(screen.queryByText("已下载")).toBeNull();
  });

  it("hides a needs-attention row from the active queue and lets the user restore it", async () => {
    current.jobs = [job("attention-1", "needs_attention", "VM_API_TIMEOUT")];
    mount();
    await screen.findByText("VM_API_TIMEOUT");

    fireEvent.click(screen.getByRole("button", { name: "隐藏此需处理项" }));
    await screen.findByText("已隐藏的需处理项（1）");
    expect(screen.queryByRole("button", { name: "隐藏此需处理项" })).toBeNull();
    expect(screen.getByRole("button", { name: "恢复到下载队列" })).toBeTruthy();
    expect(writes[0]).toMatchObject({ method: "POST", path: `${ROOT}/jobs/cleanup`, body: { jobIds: ["attention-1"] } });

    fireEvent.click(screen.getByRole("button", { name: "恢复到下载队列" }));
    expect(await screen.findByRole("button", { name: "隐藏此需处理项" })).toBeTruthy();
    expect(screen.getByText("VM_API_TIMEOUT")).toBeTruthy();
    expect(writes[1]).toMatchObject({ method: "POST", path: `${ROOT}/jobs/attention-1/restore`, body: {} });
  });

  it("extends expired waits and retries failed work while auth jobs require reconnecting", async () => {
    current.jobs = [job("expired", "needs_attention", "VM_APPROVAL_WAIT_EXPIRED"),
      job("failed", "dead_letter", "VM_API_TIMEOUT", VM2),
      job("auth", "auth_required", "VM_AUTH_REQUIRED", "507f1f77bcf86cd799439013")];
    mount(); await screen.findByText("VM_APPROVAL_WAIT_EXPIRED");
    expect(screen.getByText(/使用原账号重新连接后自动恢复/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "延长等待 7 天" }));
    await screen.findByText("等待审批");
    fireEvent.click(screen.getByRole("button", { name: "重试任务" }));
    await screen.findByText("排队中");
    expect(writes.map(({ path }) => path)).toEqual([`${ROOT}/jobs/expired/extend`, `${ROOT}/jobs/failed/resume`]);
  });

  it("offers recovery for a blocked private endpoint and an unknown result only with operator confirmation", async () => {
    current.jobs = [job("blocked", "needs_attention", "VM_SOURCE_ADDRESS_NOT_ALLOWED", VM1, { kind: "private_address" }),
      job("unknown", "needs_attention", "VM_DOWNLOAD_OUTCOME_UNKNOWN", VM2)];
    mount(); await screen.findByText("VM_SOURCE_ADDRESS_NOT_ALLOWED");
    const recovery = screen.getByRole("button", { name: "更新白名单后使用原审批重试" });
    expect(screen.getAllByRole("button", { name: "更新白名单后使用原审批重试" })).toHaveLength(1);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(recovery);
    expect(writes).toHaveLength(0);
    await waitFor(() => expect((screen.getByRole("button", { name: "更新白名单后使用原审批重试" }) as HTMLButtonElement).disabled).toBe(false));
    confirm.mockReturnValue(true);
    fireEvent.click(recovery);
    await screen.findByText("等待素材制作");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: `${ROOT}/jobs/blocked/recover`, body: { confirmRepeatableResource: true } });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("offers a separate recovery action for an already-approved resource claim", async () => {
    current.jobs = [job("claimed", "needs_attention", "VM_RESOURCE_ALREADY_CLAIMED", VM1, { kind: "resource_claim" })];
    mount(); await screen.findByText("VM_RESOURCE_ALREADY_CLAIMED");
    expect(screen.getByText(/另一条申请已占用相同素材/)).toBeTruthy();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "确认并用当前审批重试" }));
    await screen.findByText("等待素材制作");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: `${ROOT}/jobs/claimed/recover`, body: { confirmRepeatableResource: true } });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("shows unknown-outcome recovery only when the service grants that capability", async () => {
    current.jobs = [
      job("current", "needs_attention", "VM_DOWNLOAD_OUTCOME_UNKNOWN", VM1, { kind: "unknown_outcome" }, "VM_SOURCE_CONNECTION_RESET"),
      job("unknown-hidden", "needs_attention", "VM_DOWNLOAD_OUTCOME_UNKNOWN", VM2),
    ];
    mount();
    await screen.findAllByText("VM_DOWNLOAD_OUTCOME_UNKNOWN");
    expect(screen.getByText("VM_SOURCE_CONNECTION_RESET")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "确认可重复获取并使用原审批重试" })).toHaveLength(1);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "确认可重复获取并使用原审批重试" }));
    await screen.findByText("等待素材制作");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: `${ROOT}/jobs/current/recover`, body: { confirmRepeatableResource: true } });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("preserves jobs and unsaved edits through refresh errors and keeps action errors visible", async () => {
    current.jobs = [job("pending", "waiting_approval")];
    mount(); await openManualRequest(); await screen.findByText("等待审批");
    fireEvent.change(screen.getByRole("textbox", { name: "申请原因" }), { target: { value: "保留修改" } });
    readFailure = true;
    fireEvent.click(screen.getByRole("button", { name: "刷新下载状态" }));
    expect((await screen.findByRole("alert")).textContent).toContain("无法读取下载状态");
    expect(screen.getByText("等待审批")).toBeTruthy();
    expect(screen.getByDisplayValue("保留修改")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret.invalid");
    readFailure = false; writeFailure = true;
    fireEvent.click(screen.getByRole("button", { name: "保存下载设置" }));
    await screen.findByText(/VM_APPROVAL_JOB_BUSY/);
    fireEvent.click(screen.getByRole("button", { name: "刷新下载状态" }));
    await waitFor(() => expect(screen.queryByText(/无法读取下载状态/)).toBeNull());
    expect(screen.getByText(/VM_APPROVAL_JOB_BUSY/)).toBeTruthy();
    expect(screen.getByDisplayValue("保留修改")).toBeTruthy();
    expect(document.body.textContent).not.toContain("private failure");
  });

  it("keeps the loaded queue usable when the service returns a malformed success response", async () => {
    current.jobs = [job("pending", "waiting_approval")];
    mount(); await screen.findByText("等待审批");
    fetchMock.mockImplementationOnce(async () => response({}));
    fireEvent.click(screen.getByRole("button", { name: "刷新下载状态" }));
    expect((await screen.findByRole("alert")).textContent).toContain("VM_DOWNLOAD_RESPONSE_INVALID");
    expect(screen.getByText("等待审批")).toBeTruthy();
  });

  it("keeps worker failures visible across refreshes until the service reports recovery", async () => {
    current.jobs = [job("pending", "waiting_approval")];
    current.worker.errorCode = "VM_APPROVAL_STORE_FAILED";
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("下载队列处理异常");
    expect(screen.getByRole("alert").textContent).toContain("VM_APPROVAL_STORE_FAILED");
    expect(screen.getByText("等待审批")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新下载状态" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "刷新下载状态" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("alert").textContent).toContain("VM_APPROVAL_STORE_FAILED");
    current.worker.errorCode = null;
    fireEvent.click(screen.getByRole("button", { name: "刷新下载状态" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("等待审批")).toBeTruthy();
  });

  it("polls for completed background login and stops requests after unmount", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem("taskboard.vm-status-refresh.v1", "15000");
    const view = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("尚未连接")).toBeTruthy();
    current.session = { ...current.session, status: "connected", account: { name: "回调用户", userId: "fixture-user" } };
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText("回调用户")).toBeTruthy();
    view.unmount();
    const requestCount = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock.mock.calls).toHaveLength(requestCount);
  });

  it("bounds a hanging read and aborts an in-flight read when closed", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const view = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("alert").textContent).toContain("VM_DOWNLOAD_REQUEST_TIMEOUT");
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    view.unmount();
    for (const call of fetchMock.mock.calls) expect((call[1] as RequestInit).signal?.aborted).toBe(true);
  });
});
