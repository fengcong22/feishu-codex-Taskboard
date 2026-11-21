import { useEffect, useMemo, useRef, useState } from "react";

import "./VmOverviewDashboard.css";
import { getVmOverview } from "../api";
import { BridgeOpsPanel } from "./BridgeOpsPanel";
import { useTaskboardI18n } from "../i18n";
import type { LinkHealth, Task, VmOverview, VmOverviewTask } from "../types";

type Props = {
  projectId: string | null;
  tasks: Task[];
  onOpenTask: (task: Task) => void;
};

const REFRESH_MS = 15_000;

/** Human labels for the failure codes a person can actually act on. */
const REASONS: Record<string, [string, string]> = {
  VM_DOWNLOAD_FAILED: ["素材下载失败，需人工放素材", "Material download failed"],
  WORD_ALIGNMENT_UNRESOLVED: ["语音词对齐不确定，可重做规划", "Word alignment unresolved"],
  PLAN_INVALID: ["已保存的规划校验未通过", "Saved plan failed validation"],
  VM_PMO_START_EVIDENCE_FAILED: ["渲染未启动，可用原规划重渲", "Render never started"],
  UNSUPPORTED_INSTRUCTION: ["修改意见无法自动执行，需人工方案", "Instruction needs a manual plan"],
  VM_APPLICANT_CHANGED: ["申请人已变更，需重新排队", "Applicant changed"],
  VM_PMO_RECORD_CHANGED: ["飞书记录已变化，需确认后重试", "Feishu record changed"],
  AI_INTENT_SCOPE_VIOLATION: ["AI 规划越权，需人工检查", "AI intent overstepped its scope"],
  AI_INTENT_TIMEOUT: ["AI 规划超时，可重跑", "AI planning timed out"],
  AI_INTENT_MISSING: ["AI 未产出剪辑意图，可重跑", "AI produced no intent"],
  AI_INTENT_FAILED: ["AI 会话失败，可重跑", "AI session failed"],
  AI_PROVIDER_FAILED: ["AI 服务拒绝请求（余额、额度或鉴权），处理后重跑", "AI provider refused the request"],
  VM_PMO_AI_SESSION_CHANGED: ["AI 模型已切换，与冻结模型不一致", "AI model differs from the frozen one"],
  VM_PMO_REVIEW_SOURCE_INVALID: ["审核轮原片链路不完整", "Review source chain is incomplete"],
  VM_REVIEW_IMAGES_UNSUPPORTED: ["审核意见带截图，当前版本不支持", "Review images are unsupported"],
  VM_TASK_BINDING_CONFLICT: ["任务与审批绑定冲突", "Task binding conflict"],
  VM_WRITEBACK_DEAD_LETTER: ["进度回写失败，可重试回写", "Progress writeback failed"],
  VM_ARCHIVE_CONFLICT: ["成片归档冲突，同名异 SHA", "Archive conflict: same name, different SHA"],
  VM_ARCHIVE_DEAD_LETTER: ["成片归档失败", "Final archive failed"],
  VM_PMO_STATE_INVALID: ["运行状态记录损坏", "Run state is unreadable"],
  VM_AUTH_REQUIRED: ["VM 登录失效，需重新连接", "VM sign-in required"],
};

const COLUMNS: Array<[VmOverviewTask["column"], string, string]> = [
  ["todo", "待登记", "Ready"],
  ["materials", "等素材", "Materials"],
  ["queued", "排队等槽", "Queued"],
  ["editing", "剪辑中", "Editing"],
  ["feishu_delivery", "回写飞书", "Feishu delivery"],
  ["awaiting_feishu_review", "等飞书审核", "Awaiting review"],
  ["nas_upload", "上传 NAS", "NAS upload"],
  ["completed", "已完成", "Completed"],
  ["needs_attention", "需要处理", "Needs attention"],
];

function reasonLabel(code: string, text: (zh: string, en: string) => string) {
  const known = REASONS[code];
  return known ? text(known[0], known[1]) : code;
}

function duration(value: number | null | undefined, text: (zh: string, en: string) => string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const minutes = Math.round(value / 60_000);
  if (minutes < 1) return text("不足 1 分钟", "< 1 min");
  if (minutes < 60) return text(`${minutes} 分钟`, `${minutes} min`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return text(`${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`, `${hours} h ${minutes % 60} min`);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return text(`${days} 天${rest ? ` ${rest} 小时` : ""}`, `${days} d${rest ? ` ${rest} h` : ""}`);
}

type HealthRow = { key: string; label: string; detail: string; value: string; tone: "ok" | "warn" | "bad" | "idle" };

const LISTENER_LABELS: Record<string, [string, string]> = {
  sdk_managed: ["长连接已接管", "Long connection managed"],
  starting: ["正在启动", "Starting"],
  disabled: ["监听器未启用，飞书事件不会进来", "Listener disabled, Feishu events are not received"],
  error: ["连接出错", "Connection error"],
  stopping: ["正在停止", "Stopping"],
  stopped: ["长连接已停止", "Listener stopped"],
};

/** The Bridge row answers "is Feishu still reaching us, and how far behind". */
function bridgeRow(health: LinkHealth, text: (zh: string, en: string) => string): HealthRow {
  const { bridge } = health;
  const listener = bridge.listener;
  const queued = (bridge.queue?.pending ?? 0) + (bridge.queue?.retryWait ?? 0);
  const dead = bridge.queue?.deadLetter ?? 0;
  const detail = (() => {
    if (bridge.state === "unconfigured") return text("未配置 Bridge 地址", "No Bridge address is configured");
    if (bridge.state === "down") return text("连不上 Bridge 进程", "The Bridge process is unreachable");
    if (bridge.state === "error") return text("Bridge 健康检查失败", "The Bridge health check failed");
    if (bridge.state === "unknown") return text("尚未采样", "Not sampled yet");
    if (bridge.stale) return text("采样已过期，状态未知", "The sample is stale, so the state is unknown");
    const parts: string[] = [];
    if (listener) {
      const label = LISTENER_LABELS[listener.state ?? ""];
      parts.push(label ? text(label[0], label[1]) : (listener.state ?? text("状态未知", "Unknown state")));
      parts.push(listener.lastEventAt
        ? text(`最后事件 ${duration(Date.now() - Date.parse(listener.lastEventAt), text)}前`,
          `last event ${duration(Date.now() - Date.parse(listener.lastEventAt), text)} ago`)
        : text("暂无事件", "no events yet"));
    }
    return parts.join(" · ");
  })();
  // A disabled listener must not hide behind the dead-letter count: it means no
  // new Feishu event reaches the flow at all, which is the more urgent fact.
  const listenerOff = listener?.state === "disabled";
  const value = bridge.state !== "up" || bridge.stale
    ? "—"
    : listenerOff ? text("未接收事件", "Not receiving")
    : dead > 0 ? text(`${dead} 条死信`, `${dead} dead`) : text(`${queued} 条待处理`, `${queued} queued`);
  return {
    key: "bridge",
    label: text("飞书 Bridge", "Feishu Bridge"),
    detail: listener?.lastError ? `${detail} · ${listener.lastError}` : detail,
    value,
    tone: bridge.state === "up" && !bridge.stale
      ? (dead > 0 || listenerOff || listener?.state === "error" ? "bad" : "ok")
      : bridge.state === "unknown" ? "idle" : "bad",
  };
}

/** The VM row answers "can the next round download its material". */
function vmRow(health: LinkHealth, text: (zh: string, en: string) => string): HealthRow {
  const session = health.vmSession;
  if (!session) {
    return {
      key: "vm", label: text("VM 登录", "VM sign-in"),
      detail: text("尚未打开过 VM 队列，状态未知", "The VM queue has not been opened yet"),
      value: "—", tone: "idle",
    };
  }
  const states: Record<string, { value: string; tone: HealthRow["tone"] }> = {
    connected: { value: text("已连接", "Connected"), tone: "ok" },
    connecting: { value: text("等待登录", "Signing in"), tone: "warn" },
    disconnected: { value: text("未连接", "Not connected"), tone: "warn" },
    auth_required: { value: text("需要重连", "Reconnect"), tone: "bad" },
    unavailable: { value: text("暂时无法验证", "Cannot verify"), tone: "warn" },
  };
  const state = states[session.status ?? ""] ?? { value: text("状态未知", "Unknown"), tone: "idle" as const };
  const left = session.expiresAt === null
    ? null
    : Math.max(0, session.expiresAt - Date.now());
  const detail = [
    session.accountName ?? text("未识别账号", "No account"),
    left === null ? null : text(`登录还剩 ${duration(left, text)}`, `${duration(left, text)} left`),
    session.status === "auth_required" ? session.errorCode : null,
  ].filter(Boolean).join(" · ");
  return { key: "vm", label: text("VM 登录", "VM sign-in"), detail, value: state.value, tone: state.tone };
}

/** The automation row answers "will anything start by itself". */
function automationRow(health: LinkHealth, text: (zh: string, en: string) => string): HealthRow {
  const automation = health.automaticExecution;
  if (!automation) {
    return {
      key: "automation", label: text("本机自动剪辑", "Automatic editing"),
      detail: text("状态未知", "Unknown"), value: "—", tone: "idle",
    };
  }
  return {
    key: "automation",
    label: text("本机自动剪辑", "Automatic editing"),
    detail: automation.enabled
      ? text("新任务会自动开始，待启动的恢复也会执行", "New tasks start by themselves, and pending recoveries run")
      : text("关闭：新任务不会自动开始，待启动的恢复也不会执行", "Off: nothing starts by itself and pending recoveries wait"),
    value: automation.enabled ? text("已开启", "On") : text("已关闭", "Off"),
    tone: automation.enabled ? "ok" : "warn",
  };
}

export function VmOverviewDashboard({ projectId, tasks, onOpenTask }: Props) {
  const { text } = useTaskboardI18n();
  const [overview, setOverview] = useState<VmOverview | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const loadedProject = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    // A Bridge action asks for a fresh read; only a project switch clears the view.
    if (loadedProject.current !== projectId) {
      loadedProject.current = projectId;
      setOverview(null);
      setError(false);
    }

    async function load() {
      try {
        const next = await getVmOverview(projectId, controller.signal);
        if (disposed) return;
        setOverview(next);
        setError(false);
      } catch (failure) {
        if (disposed || (failure instanceof Error && failure.name === "AbortError")) return;
        setError(true);
      }
      if (!disposed) timer = setTimeout(load, REFRESH_MS);
    }

    void load();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, reload]);

  const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);

  function open(taskId: string) {
    const task = taskById.get(taskId);
    if (task) onOpenTask(task);
  }

  if (error && overview === null) {
    return (
      <div className="vm-overview" role="status">
        <div className="vm-overview-empty">{text("暂时无法读取剪辑流水线数据。", "The editing pipeline is unavailable right now.")}</div>
      </div>
    );
  }

  if (overview === null) {
    return (
      <div className="vm-overview" role="status" aria-live="polite">
        <div className="vm-overview-empty">{text("正在读取剪辑流水线…", "Loading the editing pipeline…")}</div>
      </div>
    );
  }

  const { kpis, slot } = overview;
  const kpiCards = [
    {
      key: "editing",
      label: text("剪辑中", "Editing"),
      value: String(kpis.editing),
      note: slot?.maxConcurrent
        ? text(`槽位 ${slot.activeCount ?? 0}/${slot.maxConcurrent}`, `Slot ${slot.activeCount ?? 0}/${slot.maxConcurrent}`)
        : text(`${kpis.activeRuns} 个运行中`, `${kpis.activeRuns} active runs`),
      tone: "editing",
    },
    {
      key: "approval",
      label: text("等 VM 审批", "Awaiting approval"),
      value: String(kpis.waitingApproval),
      note: kpis.oldestApprovalWaitMs === null
        ? text("当前没有等待", "Nothing is waiting")
        : text(`最久已等 ${duration(kpis.oldestApprovalWaitMs, text)}`, `Oldest ${duration(kpis.oldestApprovalWaitMs, text)}`),
      tone: "waiting",
    },
    {
      key: "attention",
      label: text("需要处理", "Needs attention"),
      value: String(kpis.needsAttention),
      note: text(`${overview.writebackDeadLetters} 条回写失败`, `${overview.writebackDeadLetters} writeback failures`),
      tone: kpis.needsAttention > 0 ? "blocked" : "calm",
    },
    {
      key: "delivered",
      label: text("近 7 天交付", "Delivered in 7 days"),
      value: String(kpis.deliveredLast7Days),
      note: text(`${kpis.publishedLast7Days} 个已发布 NAS`, `${kpis.publishedLast7Days} published to NAS`),
      tone: "delivered",
    },
    {
      key: "first-pass",
      label: text("一次通过率", "First-pass rate"),
      value: kpis.firstPassRate === null ? "—" : `${kpis.firstPassRate}%`,
      note: kpis.firstPassRate === null
        ? text("近 7 天没有交付", "No deliveries in 7 days")
        : text("无返修、无阻断的轮次", "Rounds with no retry or block"),
      tone: "quality",
    },
  ];

  const funnelTotal = Math.max(1, overview.funnel.reduce((total, item) => total + item.count, 0));

  return (
    <div className="vm-overview">
      <div className="vm-overview-kpis">
        {kpiCards.map(card => (
          <article className={`vm-kpi tone-${card.tone}`} key={card.key}>
            <span className="vm-kpi-label">{card.label}</span>
            <strong className="vm-kpi-value">{card.value}</strong>
            <span className="vm-kpi-note">{card.note}</span>
          </article>
        ))}
      </div>

      <section className="vm-overview-panel vm-overview-attention">
        <header>
          <span>{text("需要你处理", "Needs your attention")}</span>
          <b>{overview.attention.length}</b>
        </header>
        <div className="vm-overview-rows">
          {overview.attention.length ? overview.attention.map(item => (
            <button
              type="button"
              className="vm-attention-row"
              onClick={() => open(item.taskId)}
              key={item.taskId}
              title={item.errorCode ?? undefined}
            >
              <span className="vm-attention-copy">
                <strong>{item.title}</strong>
                <small>{reasonLabel(item.reasonCode ?? item.errorCode ?? "", text)}</small>
              </span>
              <span className="vm-attention-meta">
                {item.reviewRound > 0 && (
                  <em>{text(`第 ${item.reviewRound} 轮`, `Round ${item.reviewRound}`)}</em>
                )}
                {item.materialSource === "manual" && <em>{text("人工素材", "Manual source")}</em>}
                <time>{duration(item.stuckMs ?? null, text)}</time>
              </span>
            </button>
          )) : (
            <div className="vm-overview-empty">
              {text("流水线运行正常，没有卡住的任务。", "Nothing is stuck; the pipeline is clear.")}
            </div>
          )}
        </div>
      </section>

      <section className="vm-overview-panel vm-overview-funnel">
        <header><span>{text("产线漏斗", "Pipeline funnel")}</span></header>
        <div className="vm-funnel">
          {COLUMNS.map(([id, zh, en]) => {
            const count = overview.funnel.find(item => item.id === id)?.count ?? 0;
            return (
              <div
                className={`vm-funnel-segment${count ? "" : " is-empty"}${id === "needs_attention" && count ? " is-alert" : ""}`}
                key={id}
                style={{ flexGrow: count || 0 }}
              >
                <span className="vm-funnel-label">{text(zh, en)}</span>
                <strong>{count}</strong>
                <i style={{ width: `${(count / funnelTotal) * 100}%` }} aria-hidden="true" />
              </div>
            );
          })}
        </div>
        {slot?.pendingCount ? (
          <div className="vm-funnel-note">
            {text(
              `${slot.pendingCount} 个任务在等剪辑槽位（上限 ${slot.maxConcurrent ?? "?"}）`,
              `${slot.pendingCount} queued for an editing slot (limit ${slot.maxConcurrent ?? "?"})`,
            )}
          </div>
        ) : null}
      </section>

      <section className="vm-overview-panel vm-overview-failures">
        <header><span>{text("失败原因", "Failure reasons")}</span></header>
        <div className="vm-overview-rows">
          {overview.failures.length ? overview.failures.map(item => (
            <button
              type="button"
              className="vm-failure-row"
              onClick={() => open(item.taskIds[0])}
              key={item.errorCode}
            >
              <span className="vm-failure-copy">
                <strong>{reasonLabel(item.errorCode, text)}</strong>
                <small>{item.errorCode}</small>
              </span>
              <b>{item.count}</b>
            </button>
          )) : (
            <div className="vm-overview-empty">{text("当前没有被记录到的失败。", "No recorded failures right now.")}</div>
          )}
        </div>
      </section>

      <section className="vm-overview-panel vm-overview-quality">
        <header><span>{text("质量与耗时", "Quality and durations")}</span></header>
        <div className="vm-quality-body">
          <div className="vm-rounds">
            <span className="vm-quality-label">{text("每条记录的审核轮次", "Review rounds per record")}</span>
            {([
              ["one", text("1 轮", "1 round")],
              ["two", text("2 轮", "2 rounds")],
              ["threeOrMore", text("3 轮以上", "3+ rounds")],
            ] as const).map(([key, label]) => (
              <div className="vm-round-row" key={key}>
                <span>{label}</span>
                <i style={{ width: `${(overview.rounds[key] / Math.max(1, overview.rounds.one + overview.rounds.two + overview.rounds.threeOrMore)) * 100}%` }} aria-hidden="true" />
                <b>{overview.rounds[key]}</b>
              </div>
            ))}
          </div>
          <div className="vm-durations">
            <span className="vm-quality-label">{text("中位 / P90 耗时", "Median / P90 duration")}</span>
            {([
              ["plan", text("规划", "Planning")],
              ["render", text("渲染", "Rendering")],
              ["delivery", text("上传回写", "Upload")],
            ] as const).map(([key, label]) => {
              const entry = overview.durations[key];
              return (
                <div className="vm-duration-row" key={key}>
                  <span>{label}</span>
                  <b>{entry.samples ? `${duration(entry.median, text)} / ${duration(entry.p90, text)}` : text("样本不足", "Not enough data")}</b>
                  <small>{text(`${entry.samples} 个样本`, `${entry.samples} samples`)}</small>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {overview.linkHealth && (
        <section className="vm-overview-panel vm-overview-health">
          <header><span>{text("链路健康", "Link health")}</span></header>
          <div className="vm-health-body">
            {[
              bridgeRow(overview.linkHealth, text),
              vmRow(overview.linkHealth, text),
              automationRow(overview.linkHealth, text),
            ].map(row => (
              <div className={`vm-health-row tone-${row.tone}`} key={row.key}>
                <span className="vm-health-dot" aria-hidden="true" />
                <span className="vm-health-copy">
                  <strong>{row.label}</strong>
                  <small>{row.detail}</small>
                </span>
                <b>{row.value}</b>
              </div>
            ))}
            <BridgeOpsPanel health={overview.linkHealth} text={text} onChanged={() => setReload(value => value + 1)} />
          </div>
        </section>
      )}

      <div className="vm-overview-footer">
        <span>{text(`更新于 ${new Date(overview.generatedAt).toLocaleTimeString()}`, `Updated ${new Date(overview.generatedAt).toLocaleTimeString()}`)}</span>
        {overview.archiveFailures > 0 && (
          <span className="is-alert">{text(`${overview.archiveFailures} 个归档失败`, `${overview.archiveFailures} archive failures`)}</span>
        )}
      </div>
    </div>
  );
}
