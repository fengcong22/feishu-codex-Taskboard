import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { useTaskboardI18n } from "../i18n";
import {
  getVmDownloadRefreshInterval, getVmDownloads, loginVmDownloads, vmSessionTimeLeft,
  VM_DOWNLOAD_REFRESH_CHANGE_EVENT, VM_DOWNLOAD_REFRESH_INTERVAL_KEY, VM_DOWNLOAD_REFRESH_INTERVALS,
  type VmDownloadSession, type VmDownloadsSnapshot,
} from "../vmDownloads";
import { LinearIcon } from "./LinearIcon";
import { RefreshIcon } from "./SemanticIcons";

type Props = { onOpenQueue: () => void };

const SESSION_LABELS: Record<VmDownloadSession["status"], [string, string]> = {
  disconnected: ["尚未连接", "Not connected"],
  connecting: ["等待登录完成", "Waiting for sign-in"],
  connected: ["已连接", "Connected"],
  auth_required: ["需要重新连接", "Reconnect required"],
  unavailable: ["暂时无法验证", "Temporarily unavailable"],
};

function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,95}$/u.test(value) ? value : null;
}

function activeJobs(snapshot: VmDownloadsSnapshot): number {
  return snapshot.jobs.filter((job) => !["ready", "rejected", "canceled"].includes(job.status)).length;
}

export function VmStatusMenu({ onOpenQueue }: Props) {
  const { text, locale } = useTaskboardI18n();
  const [snapshot, setSnapshot] = useState<VmDownloadsSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(getVmDownloadRefreshInterval);
  const root = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(false);
  const reading = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!mounted.current || (reading.current && !reading.current.signal.aborted)) return;
    const controller = new AbortController();
    reading.current = controller;
    setLoading(true);
    try {
      const next = await getVmDownloads(controller.signal);
      if (mounted.current && !controller.signal.aborted) {
        setSnapshot(next);
        setError(null);
        if (next.session.status !== "connecting") { setLoginUrl(null); setPopupBlocked(false); }
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        const code = failure instanceof ApiError ? safeCode(failure.code) : null;
        setError(code ? `${text("VM 状态暂不可用", "VM status is unavailable")} (${code})` : text("VM 状态暂不可用", "VM status is unavailable"));
      }
    } finally {
      if (reading.current === controller) {
        reading.current = null;
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      }
    }
  }, [text]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
      reading.current?.abort();
      reading.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    if (refreshInterval === 0) return;
    const timer = window.setInterval(() => void refresh(), refreshInterval);
    return () => window.clearInterval(timer);
  }, [refresh, refreshInterval]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function connect() {
    if (connecting) return;
    let popup: Window | null = null;
    try { popup = window.open("about:blank", "_blank"); if (popup) popup.opener = null; } catch { popup = null; }
    setConnecting(true);
    setError(null);
    try {
      const result = await loginVmDownloads();
      const url = new URL(result.loginUrl);
      if (url.origin !== "https://shadow.yangcong345.com" || url.username || url.password) throw new Error("Invalid login URL");
      setLoginUrl(url.href);
      setPopupBlocked(!popup || popup.closed);
      if (popup && !popup.closed) {
        try { popup.location.replace(url.href); } catch { popup.close(); setPopupBlocked(true); }
      }
      setSnapshot((current) => current ? { ...current, session: result.session } : current);
    } catch (failure) {
      popup?.close();
      const code = failure instanceof ApiError ? safeCode(failure.code) : null;
      setError(code ? `${text("无法启动 Shadow 登录", "Could not start Shadow sign-in")} (${code})` : text("无法启动 Shadow 登录", "Could not start Shadow sign-in"));
    } finally {
      setConnecting(false);
      await refresh();
    }
  }

  function changeRefreshInterval(value: string) {
    const interval = Number(value);
    if (!VM_DOWNLOAD_REFRESH_INTERVALS.has(interval)) return;
    setRefreshInterval(interval);
    try { window.localStorage.setItem(VM_DOWNLOAD_REFRESH_INTERVAL_KEY, String(interval)); } catch { /* Keep the selection for this session. */ }
    window.dispatchEvent(new Event(VM_DOWNLOAD_REFRESH_CHANGE_EVENT));
  }

  const sessionStatus = snapshot?.session.status ?? "unavailable";
  const sessionLabel = SESSION_LABELS[sessionStatus];
  const attentionCount = snapshot?.jobs.filter((job) => job.status === "needs_attention").length ?? 0;
  const queueCount = snapshot ? activeJobs(snapshot) : 0;
  const accessibleStatus = snapshot ? sessionLabel[0] : text("正在读取", "Loading");
  const sessionErrorCode = safeCode(snapshot?.session.errorCode);
  const notificationErrorCode = safeCode(snapshot?.notifications.errorCode);
  const pendingNotificationCount = snapshot?.notifications.pendingCount ?? 0;
  const failedNotificationCount = snapshot?.notifications.failedCount ?? 0;
  const lastFailureCode = safeCode(snapshot?.notifications.lastFailureCode);
  const notificationCountsKnown = Number.isSafeInteger(snapshot?.notifications.pendingCount)
    && Number.isSafeInteger(snapshot?.notifications.failedCount);
  const notificationStatus = snapshot
    ? !notificationCountsKnown ? text("通知状态需本机服务重启后更新", "Notification status updates after restarting the local service")
      : !snapshot.notifications.enabled ? text("飞书提醒已关闭", "Feishu alerts are off")
      : !snapshot.notifications.available ? text("飞书通知不可用", "Feishu notifications unavailable")
        : pendingNotificationCount > 0
          ? text(`${pendingNotificationCount} 条待重试`, `${pendingNotificationCount} pending retry`)
          : snapshot.notifications.lastSentAt !== null
            ? text("有成功发送记录", "Successful sending recorded")
            : failedNotificationCount > 0
              ? text("发送失败，尚无成功记录", "Sending failed; no successful sends recorded")
              : text("已配置，尚无成功发送记录", "Configured; no successful sends recorded")
    : null;
  function date(value: number) {
    return new Date(value).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
  }
  const timeLeft = snapshot ? vmSessionTimeLeft(snapshot.session, Date.now(), text) : null;
  // The header button only shows the countdown when it matters: within the last two hours.
  const expiringSoon = snapshot?.session.expirySource === "token" && snapshot.session.expiresAt !== null
    && snapshot.session.expiresAt - Date.now() < 2 * 60 * 60_000;

  return <div className="header-vm-status" ref={root}>
    <button
      className={`button secondary header-vm-status-trigger${sessionStatus === "auth_required" || attentionCount ? " has-attention" : ""}`}
      type="button"
      aria-label={text(`VM 状态：${accessibleStatus}`, `VM status: ${SESSION_LABELS[sessionStatus][1]}`)}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => { setOpen((current) => !current); if (!open) void refresh(); }}
      title={text("VM 账号与下载队列", "VM account and download queue")}
    >
      <LinearIcon name="statusStarted" />
      <span>VM</span>
      <span className="header-vm-status-state">{attentionCount ? text(`需处理 ${attentionCount}`, `${attentionCount} needs attention`) : text(sessionLabel[0], sessionLabel[1])}</span>
      {!attentionCount && sessionStatus === "connected" && expiringSoon && <span className="header-vm-status-expiry">{timeLeft}</span>}
    </button>
    {open && <div className="header-project-menu header-vm-status-menu" role="menu" aria-label={text("VM 状态菜单", "VM status menu")}>
      <div className="header-vm-status-summary" role="status">
        <strong>{text(sessionLabel[0], sessionLabel[1])}{snapshot?.session.account ? ` · ${snapshot.session.account.name}` : ""}</strong>
        {sessionStatus === "connected" && timeLeft && <span>{timeLeft}</span>}
        {snapshot?.session.credentialSaved && sessionStatus === "connected" && <small>{text("已在本机加密保存，重启后自动恢复", "Saved encrypted on this computer and restored after restart")}</small>}
        {sessionStatus === "auth_required" && <small>{text("登录失效时会自动打开登录页面，在浏览器里确认即可；没看到就点下面的按钮。", "When sign-in expires the sign-in page opens automatically. Confirm it in the browser, or use the button below.")}</small>}
        {snapshot && (queueCount > 0 || attentionCount > 0) && <small>{text(`${queueCount} 个下载任务${attentionCount ? ` · ${attentionCount} 项需要处理` : ""}`, `${queueCount} queued${attentionCount ? ` · ${attentionCount} need attention` : ""}`)}</small>}
        {snapshot?.worker?.errorCode && <small className="header-vm-status-error">{text("下载队列出错，请打开 VM 队列查看", "The download queue failed; open the VM queue")}</small>}
      </div>
      {error && <p role="alert" className="header-vm-status-error">{error}</p>}
      {loginUrl && <p className="header-vm-status-login">{popupBlocked ? text("登录窗口未打开：", "Sign-in window did not open: ") : text("请在登录窗口完成授权。", "Complete authorization in the sign-in window.")} {popupBlocked && <a href={loginUrl} target="_blank" rel="noopener noreferrer">{text("打开登录页面", "Open sign-in page")}</a>}</p>}
      <div className="header-vm-status-actions">
        <button type="button" role="menuitem" disabled={connecting} onClick={() => void connect()}>
          <LinearIcon name="link" />{connecting ? text("正在连接…", "Connecting…") : sessionStatus === "connected" ? text("重新连接账号", "Reconnect account") : text("连接 Shadow 账号", "Connect Shadow account")}
        </button>
        <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenQueue(); }}>
          <LinearIcon name="panel" />{text("打开完整 VM 队列", "Open full VM queue")}
        </button>
      </div>
      <details className="header-vm-status-details">
        <summary>{text("详细信息", "Details")}</summary>
        {snapshot?.session.expirySource === "token" && snapshot.session.expiresAt !== null && <small>{text(`到期时间：${date(snapshot.session.expiresAt)}（以服务端验证为准）`, `Expires: ${date(snapshot.session.expiresAt)} (server check is authoritative)`)}</small>}
        {snapshot?.session.account && <small>{text(`上次本人登录：${snapshot.session.lastAuthorizedAt == null ? "未记录" : date(snapshot.session.lastAuthorizedAt)}`,
          `Last personal sign-in: ${snapshot.session.lastAuthorizedAt == null ? "Not recorded" : date(snapshot.session.lastAuthorizedAt)}`)}</small>}
        {snapshot?.session.lastCheckedAt !== null && snapshot?.session.lastCheckedAt !== undefined && <small>{text(`最近后台检查：${date(snapshot.session.lastCheckedAt)}`, `Last background check: ${date(snapshot.session.lastCheckedAt)}`)}</small>}
        {sessionErrorCode && <small className="header-vm-status-error">{text("账号验证提示", "Account check")}: {sessionErrorCode}</small>}
        {snapshot?.worker?.errorCode && <small className="header-vm-status-error">{text("队列处理异常", "Queue worker error")} · {safeCode(snapshot.worker.errorCode) ?? "VM_ERROR"}</small>}
        {snapshot && <div className="header-vm-status-notifications" role="status">
          <strong>{text("飞书通知", "Feishu notifications")}</strong>
          <small>{notificationStatus}{notificationCountsKnown && pendingNotificationCount > 0 && notificationErrorCode ? ` · ${notificationErrorCode}` : ""}</small>
          {!notificationCountsKnown && notificationErrorCode && <small>{text("旧版状态码", "Legacy status code")} · {notificationErrorCode}</small>}
          {notificationCountsKnown && failedNotificationCount > 0 && <small>{text(`${failedNotificationCount} 条历史通知发送失败`, `${failedNotificationCount} historical notifications failed`)}</small>}
          {notificationCountsKnown && failedNotificationCount > 0 && lastFailureCode && <small className="header-vm-status-error">{text("最近失败码", "Latest failure code")}: {lastFailureCode}</small>}
          {snapshot.notifications.lastSentAt !== null && <small>{text(`最近发送：${date(snapshot.notifications.lastSentAt)}`, `Last sent: ${date(snapshot.notifications.lastSentAt)}`)}</small>}
          {notificationCountsKnown && !pendingNotificationCount && !snapshot.notifications.available && notificationErrorCode && <small className="header-vm-status-error">{notificationErrorCode}</small>}
        </div>}
        <button type="button" className="header-vm-status-detail-button" disabled={loading} onClick={() => void refresh()}>
          <RefreshIcon color="currentColor" />{text("刷新下载状态", "Refresh download status")}
        </button>
        <label className="header-vm-status-refresh">
          <span>{text("自动刷新", "Auto-refresh")}</span>
          <select value={refreshInterval} onChange={(event) => changeRefreshInterval(event.target.value)}>
            <option value={0}>{text("关闭", "Off")}</option>
            <option value={15_000}>{text("15 秒", "15 seconds")}</option>
            <option value={30_000}>{text("30 秒", "30 seconds")}</option>
            <option value={60_000}>{text("1 分钟", "1 minute")}</option>
            <option value={300_000}>{text("5 分钟", "5 minutes")}</option>
          </select>
        </label>
      </details>
    </div>}
  </div>;
}
