import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { useTaskboardI18n } from "../i18n";
import {
  cleanupVmDownloads, enqueueVmDownloads, extendVmDownload, getVmDownloads, loginVmDownloads, logoutVmDownloads,
  recoverVmDownload, resumeVmDownload, saveVmDownloadSettings,
  type VmDownloadJob, type VmDownloadSettings, type VmDownloadsSnapshot,
} from "../vmDownloads";

const EMPTY_SETTINGS: VmDownloadSettings = { outputRoot: "", department: "", reason: "", notificationsEnabled: true };
const WAIT_EXPIRED = new Set(["VM_APPROVAL_WAIT_EXPIRED", "VM_MEDIA_WAIT_EXPIRED"]);
const CLEARABLE_STATUSES = new Set(["ready", "rejected", "canceled"]);
const STATUS_LABELS: Record<string, [string, string]> = {
  queued: ["排队中", "Queued"], submitting: ["正在提交申请", "Submitting application"],
  reconciling: ["正在确认申请", "Confirming application"], waiting_approval: ["等待审批", "Awaiting approval"],
  waiting_media: ["等待素材制作", "Awaiting media"], acquiring: ["正在下载", "Downloading"],
  ready: ["已下载", "Downloaded"], rejected: ["已驳回", "Rejected"], canceled: ["已取消", "Canceled"],
  needs_attention: ["需要处理", "Needs attention"], auth_required: ["需要重新连接", "Reconnect required"],
  retry_wait: ["等待自动重试", "Retry scheduled"], dead_letter: ["重试已暂停", "Retries paused"],
};
const SESSION_LABELS = {
  disconnected: ["尚未连接", "Disconnected"], connecting: ["等待登录完成", "Waiting for login"],
  connected: ["已连接", "Connected"], auth_required: ["登录已失效", "Sign-in required"],
  unavailable: ["暂时无法验证账号", "Account check unavailable"],
} as const;

function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,95}$/u.test(value) ? value : null;
}

export function VmDownloadsPanel() {
  const { text, locale } = useTaskboardI18n();
  const [snapshot, setSnapshot] = useState<VmDownloadsSnapshot | null>(null);
  const [draft, setDraft] = useState(EMPTY_SETTINGS);
  const [vmidsText, setVmidsText] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(() => new Set());
  const mounted = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const writing = useRef<AbortController | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const dirty = useRef(false);
  const vmidsRevision = useRef(0);
  const requestVersion = useRef(0);

  const errorText = useCallback((prefix: string, failure: unknown) => {
    const code = failure instanceof ApiError ? safeCode(failure.code) : null;
    return code ? `${prefix} (${code})` : prefix;
  }, []);

  const refresh = useCallback(async () => {
    if (reading.current || writing.current || !mounted.current) return;
    const controller = new AbortController();
    reading.current = controller;
    const version = requestVersion.current;
    setLoading(true);
    try {
      const next = await getVmDownloads(controller.signal);
      if (!mounted.current || controller.signal.aborted || version !== requestVersion.current) return;
      setSnapshot(next);
      const clearableIds = new Set(next.jobs.filter((job) => CLEARABLE_STATUSES.has(job.status)).map((job) => job.id));
      setSelectedJobIds((current) => new Set([...current].filter((id) => clearableIds.has(id))));
      if (!dirty.current) setDraft(next.settings);
      if (next.session.status !== "connecting") { setLoginUrl(null); setPopupBlocked(false); }
      setReadError(null);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && version === requestVersion.current) {
        setReadError(errorText(text("无法读取下载状态，稍后会自动重试。", "Could not read download status. Retrying shortly."), failure));
      }
    } finally {
      if (reading.current === controller) reading.current = null;
      if (mounted.current && version === requestVersion.current) setLoading(false);
    }
  }, [errorText, text]);

  const clearableJobs = snapshot?.jobs.filter((job) => CLEARABLE_STATUSES.has(job.status)) ?? [];
  const selectedClearableIds = clearableJobs.filter((job) => selectedJobIds.has(job.id)).map((job) => job.id);
  const allClearableSelected = clearableJobs.length > 0 && selectedClearableIds.length === clearableJobs.length;
  const someClearableSelected = selectedClearableIds.length > 0 && !allClearableSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someClearableSelected;
  }, [someClearableSelected]);

  function selectJob(id: string, checked: boolean) {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  function selectAllClearable(checked: boolean) {
    const ids = clearableJobs.map((job) => job.id);
    setSelectedJobIds((current) => {
      const next = new Set(current);
      for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
      return next;
    });
  }

  function clearSelected() {
    const ids = selectedClearableIds;
    if (!ids.length) return;
    const confirmed = window.confirm(text(
      `确定从下载队列隐藏 ${ids.length} 条已结束记录吗？审批记录、去重信息和下载文件会保留。`,
      `Hide ${ids.length} settled records from the download queue? Approval history, deduplication records, and downloaded files will be retained.`,
    ));
    if (!confirmed) return;
    void action(async (signal) => {
      const result = await cleanupVmDownloads(ids, signal);
      setSelectedJobIds((current) => new Set([...current].filter((id) => !ids.includes(id))));
      setNotice(text(`已清理 ${result.clearedCount} 条记录；审批记录和下载文件仍保留。`, `${result.clearedCount} records cleared from the queue. Approval history and downloaded files remain.`));
    });
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      ++requestVersion.current;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      reading.current?.abort(); reading.current = null;
      writing.current?.abort(); writing.current = null;
    };
  }, [refresh]);

  function edit<K extends keyof VmDownloadSettings>(field: K, value: VmDownloadSettings[K]) {
    dirty.current = true;
    setDraft((previous) => ({ ...previous, [field]: value }));
    setNotice(null);
  }

  function validatedSettings(): VmDownloadSettings | null {
    const next = { ...draft, department: draft.department.trim(), reason: draft.reason.trim(), outputRoot: draft.outputRoot.trim() };
    if (!next.department || next.department.length > 100 || !next.reason || next.reason.length > 500
      || /[\u0000-\u001f\u007f]/u.test(next.department + next.reason)) {
      setActionError(text("请填写申请部门（最多 100 字）和申请原因（最多 500 字）。", "Enter a department (up to 100 characters) and reason (up to 500 characters)."));
      return null;
    }
    if (!/^(?:[a-z]:[\\/]|\/|\\\\)/iu.test(next.outputRoot) || next.outputRoot.length > 4096 || /[\u0000-\u001f\u007f]/u.test(next.outputRoot)) {
      setActionError(text("请填写本机输出的绝对目录，例如 E:\\Downloads。", "Enter an absolute local output directory, such as E:\\Downloads."));
      return null;
    }
    return next;
  }

  async function action(operation: (signal: AbortSignal) => Promise<void>) {
    if (writing.current || !mounted.current) return;
    const controller = new AbortController();
    writing.current = controller;
    ++requestVersion.current;
    reading.current?.abort(); reading.current = null;
    setLoading(false); setBusy(true); setActionError(null); setNotice(null);
    try {
      await operation(controller.signal);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        setActionError(errorText(text("操作未完成，请重试。", "The operation did not complete. Try again."), failure));
      }
    } finally {
      if (writing.current === controller) writing.current = null;
      if (mounted.current && !controller.signal.aborted) { setBusy(false); await refresh(); }
    }
  }

  function connect() {
    if (writing.current) return;
    let popup: Window | null = null;
    try { popup = window.open("about:blank", "_blank"); if (popup) popup.opener = null; } catch { popup = null; }
    void action(async (signal) => {
      try {
        const result = await loginVmDownloads(signal);
        if (signal.aborted || !mounted.current) { popup?.close(); return; }
        const url = new URL(result.loginUrl);
        if (url.origin !== "https://shadow.yangcong345.com" || url.username || url.password) throw new Error("Invalid login URL");
        setLoginUrl(url.href);
        setPopupBlocked(!popup || popup.closed);
        if (popup && !popup.closed) {
          try { popup.location.replace(url.href); } catch { popup.close(); setPopupBlocked(true); }
        }
        setSnapshot((current) => current ? { ...current, session: result.session } : current);
      } catch (failure) { popup?.close(); throw failure; }
    });
  }

  function enqueue() {
    const vmids = [...new Set(vmidsText.trim().split(/[\s,;，；]+/u).filter(Boolean).map((id) => id.toLowerCase()))];
    if (!vmids.length || vmids.some((id) => !/^[a-f0-9]{24}$/u.test(id))) {
      setActionError(text("每个 VMID 必须是 24 位十六进制字符，请检查全部输入。", "Each VMID must contain 24 hexadecimal characters. Check all entries."));
      return;
    }
    if (vmids.length > 50) { setActionError(text("每批最多 50 个 VMID。", "A batch can contain at most 50 VMIDs.")); return; }
    const settings = validatedSettings();
    if (!settings) return;
    const revision = vmidsRevision.current;
    void action(async (signal) => {
      await enqueueVmDownloads({ vmids, department: settings.department, reason: settings.reason, outputRoot: settings.outputRoot }, signal);
      if (!signal.aborted && mounted.current) {
        if (revision === vmidsRevision.current) setVmidsText("");
        setNotice(text(`已接收 ${vmids.length} 个 VMID；重复请求会返回已有任务。`, `Received ${vmids.length} VMIDs; duplicate requests reuse existing jobs.`));
      }
    });
  }

  function saveSettings() {
    const settings = validatedSettings();
    if (!settings) return;
    void action(async (signal) => {
      await saveVmDownloadSettings(settings, signal);
      if (!signal.aborted && mounted.current) {
        // Inputs are disabled while saving, so this response cannot replace newer edits.
        dirty.current = false; setDraft(settings);
        setNotice(text("下载设置已保存。", "Download settings saved."));
      }
    });
  }

  function date(value?: number | null) {
    return typeof value === "number" && Number.isFinite(value)
      ? new Date(value).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "—";
  }

  function renderJob(job: VmDownloadJob) {
    const label = STATUS_LABELS[job.status] ?? ["状态待确认", "Unknown status"];
    const code = safeCode(job.error?.code);
    const extendable = job.status === "needs_attention" && code !== null && WAIT_EXPIRED.has(code);
    const privateAddressBlocked = job.status === "needs_attention" && code === "VM_SOURCE_ADDRESS_NOT_ALLOWED"
      && job.recovery?.kind === "private_address";
    const unknownOutcome = job.status === "needs_attention" && code === "VM_DOWNLOAD_OUTCOME_UNKNOWN"
      && job.recovery?.kind === "unknown_outcome";
    const claimedResource = job.status === "needs_attention" && code === "VM_RESOURCE_ALREADY_CLAIMED"
      && job.recovery?.kind === "resource_claim";
    return <li key={job.id} className="vm-downloads-job">
      <div className="vm-downloads-job-heading">
        <label className="vm-downloads-job-select">
          <input type="checkbox" checked={selectedJobIds.has(job.id)} disabled={busy || !CLEARABLE_STATUSES.has(job.status)}
            aria-label={text(`选择清理 ${job.vmid}，记录 ${job.id}`, `Select ${job.vmid}, record ${job.id}, for cleanup`)}
            onChange={(event) => selectJob(job.id, event.target.checked)} />
        </label>
        <code>{job.vmid}</code><span className={`vm-downloads-badge vm-downloads-state-${job.status}`}>{text(label[0], label[1])}</span>
      </div>
      <dl>
        {job.application_id && <><dt>{text("申请编号", "Application")}</dt><dd>{job.application_id}</dd></>}
        {job.instance_code && <><dt>{text("审批编号", "Approval")}</dt><dd>{job.instance_code}</dd></>}
        <dt>{text("申请", "Request")}</dt><dd>{job.department} · {job.reason}</dd>
        <dt>{text("输出目录", "Output directory")}</dt><dd>{job.output_root}</dd>
        <dt>{text("创建时间", "Created")}</dt><dd>{date(job.created_at)}</dd>
        {job.approval_deadline_at && <><dt>{text("审批等待截止", "Approval deadline")}</dt><dd>{date(job.approval_deadline_at)}</dd></>}
        {job.media_deadline_at && <><dt>{text("制作等待截止", "Media deadline")}</dt><dd>{date(job.media_deadline_at)}</dd></>}
        {job.next_attempt_at && <><dt>{text("下次检查", "Next check")}</dt><dd>{date(job.next_attempt_at)}</dd></>}
        {job.acquisition?.path && <><dt>{text("下载文件", "Downloaded file")}</dt><dd>{job.acquisition.path}</dd></>}
      </dl>
      {code && <p className="vm-downloads-job-error"><code>{code}</code></p>}
      {job.status === "auth_required" && <p>{text("使用原账号重新连接后自动恢复，不会重新申请。", "Reconnect with the original account to resume without submitting a new application.")}</p>}
      {extendable && <p>{text("已暂停等待。延长后继续检查原申请。", "Waiting is paused. Extending continues to check the original application.")}</p>}
      {privateAddressBlocked && <p>{text("域名解析到未放行的私网地址，下载请求没有发出。更新本机精确白名单后，可继续使用原审批。", "The hostname resolved to an unapproved private address, so no download request was sent. Update the exact local allowlist to continue with the existing approval.")}</p>}
      {unknownOutcome && <p>{text("上次传输中断，无法确认 VM 是否完整交付。你已确认该素材支持重复获取；继续后会检查本机没有完整视频或回执，再沿用这条已批准申请重新获取，不会重新提交审批。", "The previous transfer stopped before completion, so Taskboard cannot confirm delivery. You confirmed this material can be fetched again. Continuing checks that no complete video or receipt exists locally, then reuses this approved application without submitting another one.")}</p>}
      {claimedResource && <p>{text("Taskboard 检测到另一条申请已占用相同素材。若当前申请是独立通过的审批，可确认后沿用当前审批重试；不会重新提交审批。", "Taskboard detected another application for the same material. If this request has its own approval, confirm to retry with that approval; no new application will be submitted.")}</p>}
      {unknownOutcome && job.error?.diagnostic_code && <p className="vm-downloads-job-error">{text("传输诊断", "Transfer diagnostic")}: <code>{job.error.diagnostic_code}</code></p>}
      {(extendable || privateAddressBlocked || unknownOutcome || claimedResource || job.status === "dead_letter") && <div className="vm-downloads-actions">
        {extendable && <button className="button secondary" type="button" disabled={busy} onClick={() => void action(async (signal) => { await extendVmDownload(job.id, signal); })}>{text("延长等待 7 天", "Extend wait by 7 days")}</button>}
        {(privateAddressBlocked || unknownOutcome) && <button className="button secondary" type="button" disabled={busy} onClick={() => void action(async (signal) => {
          const confirmed = window.confirm(unknownOutcome ? text(
            "请确认 VM 允许这份素材在该审批下重复获取。Taskboard 会检查本机完整视频和回执均不存在，再沿用原审批重新获取；不会提交新审批。",
            "Confirm the VM allows this material to be fetched again under the approved application. Taskboard checks that no complete video or receipt exists locally, then reuses the original approval without submitting another one.",
          ) : text(
            "请确认已配置该素材域名的精确私网白名单。Taskboard 会沿用原审批重新检查资源；不会提交新审批。",
            "Confirm the exact private-address allowlist for this material host is configured. Taskboard will recheck the existing approved resource without submitting another application.",
          ));
          if (confirmed) await recoverVmDownload(job.id, signal);
        })}>{text(unknownOutcome ? "确认可重复获取并使用原审批重试" : "更新白名单后使用原审批重试", unknownOutcome ? "Confirm repeatable fetch and retry with existing approval" : "Update allowlist and retry with existing approval")}</button>}
        {claimedResource && <button className="button secondary" type="button" disabled={busy} onClick={() => void action(async (signal) => {
          const confirmed = window.confirm(text(
            "请确认当前 VM 申请是独立通过的审批，并允许对这份素材重复获取。Taskboard 会沿用当前审批，不会重新提交申请。",
            "Confirm this VM request has its own approval and the material may be fetched again. Taskboard will reuse this approval without submitting another application.",
          ));
          if (confirmed) await recoverVmDownload(job.id, signal);
        })}>{text("确认并用当前审批重试", "Confirm and retry with this approval")}</button>}
        {job.status === "dead_letter" && <button className="button secondary" type="button" disabled={busy} onClick={() => void action(async (signal) => { await resumeVmDownload(job.id, signal); })}>{text("重试任务", "Retry job")}</button>}
      </div>}
    </li>;
  }

  const session = snapshot?.session;
  const sessionLabel = session ? SESSION_LABELS[session.status] ?? SESSION_LABELS.unavailable : null;
  return <section className="vm-downloads-panel" aria-labelledby="vm-downloads-heading">
    <header className="vm-downloads-heading"><div><h3 id="vm-downloads-heading">{text("VM 账号与队列", "VM account and queue")}</h3><p>{text("管理 auto-cut-slicing 包使用的 Shadow 账号和 VM 下载队列。关闭本页后，队列仍会在本机后台继续。", "Manage the Shadow account and VM download queue used by auto-cut-slicing. The local queue continues after you leave this page.")}</p><p>{text("VMID、申请部门和申请原因在当前学科的“基础与执行”配置中设置；这里负责账号连接和下载队列。", "Set the VMID field, department, and reason under this subject's Basics and execution settings. Manage the account connection and download queue here.")}</p></div>
      <button type="button" className="button secondary" disabled={loading || busy} onClick={() => void refresh()}>{text("刷新下载状态", "Refresh downloads")}</button></header>
    {readError && <p role="alert" className="vm-downloads-error">{readError}</p>}
    {safeCode(snapshot?.worker?.errorCode) && <p role="alert" className="vm-downloads-error">{text("下载队列处理异常，请检查本机服务；已有申请仍保留。", "The download worker encountered an error. Check the local service; existing applications are retained.")} ({safeCode(snapshot?.worker?.errorCode)})</p>}
    {session?.status === "auth_required" && <section role="alert" aria-label={text("Shadow 登录已失效", "Shadow sign-in expired")} className="vm-downloads-auth-alert">
      <div><strong>{text("Shadow 登录已失效，下载队列已暂停。", "Shadow sign-in expired. The download queue is paused.")}</strong>
        <p>{text("重新连接原账号后会继续处理；已提交的审批和下载记录会保留。", "Reconnect the original account to resume processing. Existing approvals and download records are retained.")}</p></div>
      <button type="button" className="button secondary" disabled={busy} onClick={connect}>{text("从提示重新连接", "Reconnect from alert")}</button>
    </section>}
    {loading && !snapshot && <p role="status">{text("正在读取下载队列…", "Loading downloads…")}</p>}
    {session && <section className="vm-downloads-session" aria-label={text("Shadow 账号", "Shadow account")}>
      <div className="vm-downloads-session-heading"><strong>{text(sessionLabel![0], sessionLabel![1])}</strong>{session.account && <span>{session.account.name}</span>}</div>
      {session.account && <p>{text("账号", "Account")}: {session.account.userId}</p>}
      <p>{session.expirySource === "token" && session.expiresAt
        ? text(`凭据提示到期时间：${date(session.expiresAt)}；账号是否可用以服务端验证为准。`, `Credential expiry hint: ${date(session.expiresAt)}; server verification determines account availability.`)
        : text("有效期未知；账号是否可用以服务端验证为准。", "Expiry unknown; server verification determines account availability.")}</p>
      {session.lastCheckedAt && <p>{text("上次验证", "Last checked")}: {date(session.lastCheckedAt)}</p>}
      {safeCode(session.errorCode) && <p className="vm-downloads-error">{text("账号验证提示", "Account check")}: {safeCode(session.errorCode)}</p>}
      <div className="vm-downloads-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={connect}>{session.status === "connected" ? text("重新连接账号", "Reconnect account") : text("连接 Shadow 账号", "Connect Shadow account")}</button>
        {session.status !== "disconnected" && <button type="button" className="button secondary" disabled={busy} onClick={() => void action(async (signal) => { await logoutVmDownloads(signal); setLoginUrl(null); })}>{text("断开账号", "Disconnect account")}</button>}
      </div>
      {loginUrl && <p className="vm-downloads-login">{popupBlocked ? text("浏览器未打开登录窗口，请点击链接继续。", "The browser did not open a login window. Use this link to continue.") : text("请在登录窗口完成验证，面板会自动更新。", "Complete sign-in in the login window. This panel will update automatically.")} <a href={loginUrl} target="_blank" rel="noopener noreferrer">{text("打开登录页面", "Open sign-in page")}</a></p>}
      <p className="vm-downloads-help">{text("暂不支持自动续期或手机/电脑飞书跨设备直接授权。Taskboard 重启后需重新连接账号。", "Automatic renewal and cross-device authorization from Feishu are not supported. Reconnect after restarting Taskboard.")}</p>
    </section>}
    {snapshot && <>
      <details className="vm-downloads-manual" open={manualOpen} onToggle={(event) => setManualOpen(event.currentTarget.open)}>
        <summary>{text("手动批量下载（补救入口）", "Manual batch download (fallback)")}</summary>
        {manualOpen && <>
          <p className="vm-downloads-help">{text("用于临时下载或问题处理。这里的申请默认值独立于各学科、剪辑包的流程草稿。", "Use this for ad hoc downloads or troubleshooting. These request defaults are independent of subject and package workflow drafts.")}</p>
          <fieldset className="vm-downloads-form" disabled={busy}>
            <legend>{text("新建下载申请", "New download request")}</legend>
            <label className="vm-downloads-wide">VMID<textarea rows={3} value={vmidsText} aria-describedby="vm-downloads-vmid-help" placeholder={text("每行一个 VMID", "One VMID per line")} onChange={(event) => { ++vmidsRevision.current; setVmidsText(event.target.value); setNotice(null); }} /></label>
            <p id="vm-downloads-vmid-help" className="vm-downloads-help vm-downloads-wide">{text("每批最多 50 个，支持换行或逗号分隔；每个 VMID 独立申请。", "Up to 50 per batch, separated by lines or commas. Each VMID gets its own application.")}</p>
            <label>{text("申请部门", "Department")}<input value={draft.department} maxLength={100} onChange={(event) => edit("department", event.target.value)} /></label>
            <label>{text("申请原因", "Reason")}<input value={draft.reason} maxLength={500} onChange={(event) => edit("reason", event.target.value)} /></label>
            <label className="vm-downloads-wide">{text("本机输出目录", "Local output directory")}<input value={draft.outputRoot} maxLength={4096} placeholder="E:\\Downloads" onChange={(event) => edit("outputRoot", event.target.value)} /></label>
            <label className="vm-downloads-checkbox vm-downloads-wide"><input type="checkbox" checked={draft.notificationsEnabled} onChange={(event) => edit("notificationsEnabled", event.target.checked)} />{text("飞书异常提醒", "Feishu exception notifications")}</label>
            <p className="vm-downloads-help vm-downloads-wide">{!snapshot.notifications.enabled
              ? text("飞书通知已关闭。", "Feishu notifications are off.")
              : snapshot.notifications.available ? text("飞书通知可用，异常将提醒当前登录用户。", "Feishu notifications are available for the signed-in user.")
                : text("飞书通知不可用，请检查账号连接及本机飞书应用权限。", "Feishu notifications are unavailable. Check the account and local Feishu app permissions.")}
              {safeCode(snapshot.notifications.errorCode) && <> ({safeCode(snapshot.notifications.errorCode)})</>}</p>
            <div className="vm-downloads-actions vm-downloads-wide"><button className="button" type="button" onClick={enqueue}>{text("加入下载队列", "Add to download queue")}</button><button className="button secondary" type="button" onClick={saveSettings}>{text("保存下载设置", "Save download settings")}</button></div>
          </fieldset>
          {session?.status !== "connected" && <p className="vm-downloads-help">{text("可先加入队列；连接账号后才会开始处理。", "You can queue requests now; processing starts after connecting your account.")}</p>}
        </>}
      </details>
      <div aria-live="polite">{busy && <p role="status">{text("正在处理…", "Working…")}</p>}{notice && <p role="status">{notice}</p>}</div>
      {actionError && <p role="alert" className="vm-downloads-error">{actionError}</p>}
      <section className="vm-downloads-queue" aria-label={text("下载队列", "Download queue")}>
        <div className="vm-downloads-queue-heading">
          <h4>{text("下载队列", "Download queue")} <span>{snapshot.jobs.length}</span></h4>
          {clearableJobs.length > 0 && <div className="vm-downloads-queue-tools">
            <label className="vm-downloads-select-all"><input ref={selectAllRef} type="checkbox" checked={allClearableSelected}
              disabled={busy} aria-label={text("全选可清理项", "Select all clearable jobs")}
              onChange={(event) => selectAllClearable(event.target.checked)} />{text("全选可清理项", "Select all clearable")}</label>
            <button className="button secondary" type="button" disabled={busy || selectedClearableIds.length === 0} onClick={clearSelected}>
              {text(`清理所选（${selectedClearableIds.length}）`, `Clear selected (${selectedClearableIds.length})`)}
            </button>
          </div>}
        </div>
        {snapshot.jobs.length ? <ul>{snapshot.jobs.map(renderJob)}</ul> : <p className="vm-downloads-help">{text("暂无下载任务。", "No download jobs yet.")}</p>}
      </section>
    </>}
  </section>;
}
